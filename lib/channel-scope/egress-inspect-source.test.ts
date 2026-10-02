/**
 * CS5 (CS4 note 1): legacy automatic org_channels writers must not create source='manual' rows.
 * - gateway/audience.ts lazy ext-shared inspect
 * - stuck-watch/audience-ledger.ts party → channel sync
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEMO_ORG } from "@/lib/demo-data";
import { getOrgChannel, upsertOrgChannel, upsertOrgParty } from "@/lib/data/directory";
import { parseConversationContext, resolveAudience } from "@/lib/gateway/audience";
import { supplementInvokeBodyFromLedger } from "@/lib/stuck-watch/audience-ledger";
import {
  __resetChannelScopeDemoStore,
  __setDemoChannelScopeMeta,
  getChannelScopeChannel,
  upsertOrgChannelFromAutomaticPath,
} from "@/lib/channel-scope/data";
import { evaluateConnectEgressGate } from "@/lib/channel-scope/egress-gate";
import { isChannelInScope, resolveEffectiveChannelScope } from "@/lib/channel-scope/resolve";

const ORG = DEMO_ORG.id;
const saved = { scope: process.env.P1_CHANNEL_SCOPE_ENABLED, bot: process.env.SLACK_BOT_TOKEN };
const savedFetch = globalThis.fetch;
let seq = 0;
let extShared: Record<string, boolean> = {};

const chan = () => `C0EI${Date.now().toString(36).toUpperCase()}${(seq += 1)}`;

function ctxFor(channelId: string) {
  return parseConversationContext(
    {
      tool: "slack.post",
      purpose: "comm.reply",
      jobId: `job_ei_${seq}`,
      conversation: { surface: "slack", orgId: ORG, slackChannelId: channelId },
    } as never,
    ORG
  );
}

beforeEach(() => {
  __resetChannelScopeDemoStore();
  extShared = {};
  process.env.SLACK_BOT_TOKEN = "xoxb-ei-test";
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (url.startsWith("https://slack.com/api/conversations.info")) {
      const id = new URL(url).searchParams.get("channel") || "";
      if (!(id in extShared)) return new Response(JSON.stringify({ ok: false, error: "channel_not_found" }));
      return new Response(JSON.stringify({ ok: true, channel: { id, is_ext_shared: extShared[id] } }));
    }
    return new Response(JSON.stringify({ ok: true }));
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = savedFetch;
});

afterAll(() => {
  if (saved.scope === undefined) delete process.env.P1_CHANNEL_SCOPE_ENABLED;
  else process.env.P1_CHANNEL_SCOPE_ENABLED = saved.scope;
  if (saved.bot === undefined) delete process.env.SLACK_BOT_TOKEN;
  else process.env.SLACK_BOT_TOKEN = saved.bot;
});

describe("gateway/audience lazy inspect", () => {
  test("flag OFF: legacy write (row created, provenance column untouched → manual default)", async () => {
    delete process.env.P1_CHANNEL_SCOPE_ENABLED;
    const c = chan();
    extShared[c] = true;
    const resolved = await resolveAudience(ctxFor(c));
    expect(resolved.effectiveAudience).toBe("external");
    const row = await getChannelScopeChannel(ORG, "slack", c);
    expect(row?.classification).toBe("shared_external");
    expect(row?.source).toBe("manual");
    expect((await evaluateConnectEgressGate({ orgId: ORG, employeeId: "emp_comm", slackChannelId: c })).reason).toBe("flag_off");
  });

  test("flag ON: NEW Connect row is source=egress_inspect and the CS4 send gate applies", async () => {
    process.env.P1_CHANNEL_SCOPE_ENABLED = "1";
    const c = chan();
    extShared[c] = true;
    const resolved = await resolveAudience(ctxFor(c));
    expect(resolved.effectiveAudience).toBe("external");
    const row = await getChannelScopeChannel(ORG, "slack", c);
    expect(row?.classification).toBe("shared_external");
    expect(row?.mixed).toBe(true);
    expect(row?.source).toBe("egress_inspect");
    expect(row?.humanConfirmedAt ?? null).toBe(null);
    const gate = await evaluateConnectEgressGate({ orgId: ORG, employeeId: "emp_comm", slackChannelId: c });
    expect(gate.required).toBe(true);
    expect(gate.reason).toBe("connect_unconfirmed");
    expect(gate.source).toBe("egress_inspect");
  });

  test("flag ON: EXISTING manual row keeps source=manual (only classification gets stricter, as before)", async () => {
    process.env.P1_CHANNEL_SCOPE_ENABLED = "1";
    const c = chan();
    await upsertOrgChannel({ orgId: ORG, surface: "slack", externalId: c, classification: "unknown", skipInspect: true });
    extShared[c] = true;
    await resolveAudience(ctxFor(c));
    const row = await getChannelScopeChannel(ORG, "slack", c);
    expect(row?.classification).toBe("shared_external");
    expect(row?.source).toBe("manual");
    expect((await evaluateConnectEgressGate({ orgId: ORG, employeeId: "emp_comm", slackChannelId: c })).reason).toBe("manual_row");
  });

  test("flag ON: EXISTING auto_join row keeps its source and human confirmation", async () => {
    process.env.P1_CHANNEL_SCOPE_ENABLED = "1";
    const c = chan();
    await upsertOrgChannel({ orgId: ORG, surface: "slack", externalId: c, classification: "shared_external", mixed: true, skipInspect: true });
    __setDemoChannelScopeMeta(ORG, "slack", c, { source: "auto_join", humanConfirmedAt: "2026-10-01T00:00:00.000Z" });
    extShared[c] = true;
    await resolveAudience(ctxFor(c));
    const row = await getChannelScopeChannel(ORG, "slack", c);
    expect(row?.source).toBe("auto_join");
    expect(row?.humanConfirmedAt).toBe("2026-10-01T00:00:00.000Z");
  });

  test("not ext-shared / Slack unreachable ⇒ no row is created (unchanged)", async () => {
    process.env.P1_CHANNEL_SCOPE_ENABLED = "1";
    const a = chan();
    extShared[a] = false;
    const b = chan();
    await resolveAudience(ctxFor(a));
    await resolveAudience(ctxFor(b));
    expect(await getOrgChannel(ORG, "slack", a)).toBe(null);
    expect(await getOrgChannel(ORG, "slack", b)).toBe(null);
  });
});

describe("stuck-watch/audience-ledger party → channel sync", () => {
  async function supplement(c: string) {
    await upsertOrgParty({ orgId: ORG, kind: "slack_channel", identifier: c, audience: "internal" });
    await supplementInvokeBodyFromLedger(ORG, {
      tool: "comm.reply",
      purpose: "comm.internal",
      jobId: `job_ei_sync_${seq}`,
      conversation: { surface: "slack", slackChannelId: c },
    });
  }

  test("flag OFF: legacy (manual default)", async () => {
    delete process.env.P1_CHANNEL_SCOPE_ENABLED;
    const c = chan();
    await supplement(c);
    const row = await getChannelScopeChannel(ORG, "slack", c);
    expect(row?.classification).toBe("internal");
    expect(row?.source).toBe("manual");
  });

  test("flag ON: NEW row is source=egress_inspect and does not count as human-registered", async () => {
    process.env.P1_CHANNEL_SCOPE_ENABLED = "1";
    const c = chan();
    await supplement(c);
    const row = await getChannelScopeChannel(ORG, "slack", c);
    expect(row?.classification).toBe("internal");
    expect(row?.source).toBe("egress_inspect");
    const decision = isChannelInScope({
      scope: resolveEffectiveChannelScope({ flags: { enabled: true, connectEnabled: false } }),
      surface: "slack",
      externalId: c,
      channel: row,
    });
    // registered_only: an automatic row is not "registered" until a human confirms it — no widening.
    expect(decision.inScope).toBe(false);
  });

  test("flag ON: EXISTING manual row keeps source=manual", async () => {
    process.env.P1_CHANNEL_SCOPE_ENABLED = "1";
    const c = chan();
    await upsertOrgChannel({ orgId: ORG, surface: "slack", externalId: c, classification: "unknown", skipInspect: true });
    await supplement(c);
    const row = await getChannelScopeChannel(ORG, "slack", c);
    expect(row?.classification).toBe("internal");
    expect(row?.source).toBe("manual");
  });

  test("Connect row is never turned internal (legacy guard preserved)", async () => {
    process.env.P1_CHANNEL_SCOPE_ENABLED = "1";
    const c = chan();
    await upsertOrgChannel({ orgId: ORG, surface: "slack", externalId: c, classification: "shared_external", mixed: true, skipInspect: true });
    await expect(
      upsertOrgChannelFromAutomaticPath({ orgId: ORG, surface: "slack", externalId: c, classification: "internal", mixed: false, skipInspect: true })
    ).rejects.toThrow("connect_cannot_be_internal");
    expect((await getChannelScopeChannel(ORG, "slack", c))?.classification).toBe("shared_external");
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runGatewayInvoke } from "@/lib/gateway/invoke";
import { DEMO_ORG } from "@/lib/demo-data";
import { listAuditEvents } from "@/lib/data";
import { upsertOrgChannel } from "@/lib/data/directory";
import {
  __resetChannelScopeDemoStore,
  __setDemoChannelScopeMeta,
  markChannelHumanConfirmed,
  setEmployeeChannelScopeOverride,
  upsertAutoClassifiedChannel,
} from "./data";
import { evaluateConnectEgressGate, isUnconfirmedAutoConnect } from "./egress-gate";
import { defaultChannelScopePolicy } from "./validate";

const ORG = DEMO_ORG.id;
const EMP = "emp_comm";
const saved = process.env.P1_CHANNEL_SCOPE_ENABLED;
let n = 0;
const chan = () => `C0GATE${Date.now().toString(36).toUpperCase()}${(n += 1)}`;

async function autoConnect(): Promise<string> {
  const c = chan();
  await upsertAutoClassifiedChannel({
    orgId: ORG,
    externalId: c,
    auto: { classification: "shared_external", mixed: true, externalTeamIds: ["T0PEER"] },
    source: "auto_join",
  });
  return c;
}

function postPublic(channel: string, tool = "slack.post", extra: Record<string, unknown> = {}) {
  return runGatewayInvoke({
    employeeId: EMP,
    credentialId: "cred_comm",
    body: {
      tool,
      purpose: "comm.internal",
      jobId: `job_cs4_${Date.now()}_${(n += 1)}`,
      conversation: { surface: "slack", orgId: ORG, slackChannelId: channel },
      args: { assetRef: "kb/public-faq", slackChannelId: channel, ...extra },
    },
  });
}

beforeEach(() => {
  process.env.P1_CHANNEL_SCOPE_ENABLED = "1";
  __resetChannelScopeDemoStore();
});
afterEach(() => {
  if (saved === undefined) delete process.env.P1_CHANNEL_SCOPE_ENABLED;
  else process.env.P1_CHANNEL_SCOPE_ENABLED = saved;
});

describe("evaluateConnectEgressGate", () => {
  test("flag OFF ⇒ never required, no lookup", async () => {
    const c = await autoConnect();
    delete process.env.P1_CHANNEL_SCOPE_ENABLED;
    expect(await evaluateConnectEgressGate({ orgId: ORG, employeeId: EMP, slackChannelId: c })).toEqual({ required: false, reason: "flag_off" });
  });

  test("reasons", async () => {
    const gate = (id: string | null) => evaluateConnectEgressGate({ orgId: ORG, employeeId: EMP, slackChannelId: id });
    expect((await gate(null)).reason).toBe("not_a_channel");
    expect((await gate("D0DM12345")).reason).toBe("not_a_channel");
    expect((await gate(chan())).reason).toBe("not_in_ledger");

    const internal = chan();
    await upsertAutoClassifiedChannel({ orgId: ORG, externalId: internal, auto: { classification: "internal", mixed: false, externalTeamIds: [] }, source: "auto_join" });
    expect((await gate(internal)).reason).toBe("not_connect");

    const manual = chan();
    await upsertOrgChannel({ orgId: ORG, surface: "slack", externalId: manual, classification: "shared_external", mixed: true, skipInspect: true });
    expect((await gate(manual)).reason).toBe("manual_row");

    const c = await autoConnect();
    expect(await gate(c)).toMatchObject({ required: true, reason: "connect_unconfirmed", externalTeamIds: ["T0PEER"], source: "auto_join" });
    expect(await markChannelHumanConfirmed({ orgId: ORG, externalId: c })).toBe(true);
    expect(await gate(c)).toMatchObject({ required: false, reason: "human_confirmed" });
  });

  test("connect.egress=matrix (employee override) leaves it to the matrix", async () => {
    const c = await autoConnect();
    await setEmployeeChannelScopeOverride(ORG, EMP, {
      ...defaultChannelScopePolicy(),
      mode: "all_joined",
      connect: { ...defaultChannelScopePolicy().connect, egress: "matrix" },
    });
    expect((await evaluateConnectEgressGate({ orgId: ORG, employeeId: EMP, slackChannelId: c })).reason).toBe("egress_matrix");
  });

  test("isUnconfirmedAutoConnect", () => {
    expect(isUnconfirmedAutoConnect({ externalId: "C0X", classification: "shared_external", mixed: true, source: "reconcile" })).toBe(true);
    expect(isUnconfirmedAutoConnect({ externalId: "C0X", classification: "internal", mixed: true, source: "egress_inspect" })).toBe(true);
    expect(isUnconfirmedAutoConnect({ externalId: "C0X", classification: "shared_external", mixed: true })).toBe(false);
    expect(isUnconfirmedAutoConnect(null)).toBe(false);
  });
});

describe("Gateway invoke: auto-joined Connect until confirmed", () => {
  test("baseline: manual Connect row + public asset is allowed by the matrix", async () => {
    const manual = chan();
    await upsertOrgChannel({ orgId: ORG, surface: "slack", externalId: manual, classification: "shared_external", mixed: true, skipInspect: true });
    const r = await postPublic(manual);
    expect(r.body.code).not.toBe("needs_approval");
    expect(r.body.ok).toBe(true);
  });

  test("slack.post / comm.reply on an unconfirmed auto-joined Connect channel ⇒ needs_approval + audit", async () => {
    const c = await autoConnect();
    for (const tool of ["slack.post", "comm.reply"]) {
      const r = await postPublic(c, tool);
      expect(r.body).toMatchObject({ code: "needs_approval", needs_approval: true });
      expect((r.body.channelScopeConnectGate as { reason?: string })?.reason).toBe("connect_unconfirmed");
    }
    const audits = await listAuditEvents(ORG, 30);
    expect(audits.some((a) => a.action === "channel_scope.connect_egress_gated")).toBe(true);
  });

  test("file attachment send is gated the same way", async () => {
    const c = await autoConnect();
    const r = await postPublic(c, "slack.post", { fileUrl: "https://example.com/a.pdf", filename: "a.pdf" });
    expect(r.body.code).toBe("needs_approval");
  });

  test("after a human confirms, the matrix decides again", async () => {
    const c = await autoConnect();
    await markChannelHumanConfirmed({ orgId: ORG, externalId: c });
    const r = await postPublic(c);
    expect(r.body.code).not.toBe("needs_approval");
    expect(r.body.ok).toBe(true);
  });

  test("deny still wins (gate only adds approval)", async () => {
    const c = await autoConnect();
    const r = await runGatewayInvoke({
      employeeId: EMP,
      credentialId: "cred_comm",
      body: {
        tool: "comm.reply",
        purpose: "comm.internal",
        jobId: `job_cs4_deny_${Date.now()}`,
        conversation: { surface: "slack", orgId: ORG, slackChannelId: c },
        args: { slackChannelId: c, text: "社外混在への返信" },
      },
    });
    expect(r.body.code).toBe("egress_denied");
  });

  test("flag OFF ⇒ no gate (legacy matrix result)", async () => {
    const c = await autoConnect();
    delete process.env.P1_CHANNEL_SCOPE_ENABLED;
    const r = await postPublic(c);
    expect(r.body.code).not.toBe("needs_approval");
  });

  test("demo meta: egress_inspect source without confirmation is gated too", async () => {
    const c = chan();
    await upsertOrgChannel({ orgId: ORG, surface: "slack", externalId: c, classification: "shared_external", mixed: true, skipInspect: true });
    __setDemoChannelScopeMeta(ORG, "slack", c, { source: "egress_inspect", humanConfirmedAt: null });
    expect((await postPublic(c)).body.code).toBe("needs_approval");
  });
});

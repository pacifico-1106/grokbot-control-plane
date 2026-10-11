/**
 * 木村 2026-10-09 B (triage #1④ / ともり T1・T2): COMM_SEND_INTERNAL_DEFAULT_ENABLED
 * (default OFF). comm.send with no explicit class defaults to internal + summary
 * ONLY when Staffpass itself verified the destination as internal:
 *   - the channel ledger (org_channels) of the CREDENTIAL's org has it as
 *     internal and not mixed (an internal channel, or an internal DM route D…),
 *   - and the resolved audience is internal (no external / unknown party).
 * Everything else keeps confidential + source. Pinned (never weakened): the AI
 * cannot lower the class; a sensitive topic still forces approval;
 * employee always_human still forces approval.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { setOrgApprovalKindRoutesPolicy } from "@/lib/approval-kind-routes/data";
import type { OrgApprovalKindRoutesPolicy } from "@/lib/approval-kind-routes/types";
import { upsertConversationAdapter } from "@/lib/data/conversation-adapters";
import { upsertOrgChannel, upsertOrgParty } from "@/lib/data/directory";
import { getOrgInternalAudienceRule, setOrgInternalAudienceRule } from "@/lib/data/internal-audience-rule";
import { DEMO_ORG, getRuntimeEmployees } from "@/lib/demo-data";
import { runGatewayInvoke } from "@/lib/gateway/invoke";
import type { Employee, GatewayInvokeRequest } from "@/lib/types";

const FLAG = "COMM_SEND_INTERNAL_DEFAULT_ENABLED";
const TOPIC_FLAG = "P1_TOPIC_GATED_POSTING_ENABLED";
const OTHER_ORG = "org_comm_send_default_other";
const originalFetch = globalThis.fetch;
const savedEnv: Record<string, string | undefined> = {};
const restorers: Array<() => void> = [];
let posts: Array<Record<string, unknown>> = [];
let seq = 0;

function policy(orgId: string, topics: string[]): OrgApprovalKindRoutesPolicy {
  return {
    version: 1,
    policyId: `pol_${orgId}`,
    policyName: "test",
    routes: [],
    topicGate: { enabled: true, sensitiveTopics: topics, mainBoardChannelIds: [] },
    updatedAt: new Date().toISOString(),
    updatedBy: "test",
  };
}

function setEmployee(patch: Partial<Employee>) {
  const emp = getRuntimeEmployees().find((item) => item.id === "emp_comm")!;
  const previous = { ...emp };
  Object.assign(emp, patch);
  restorers.push(() => Object.assign(emp, previous));
}

const cid = (prefix: string) => {
  seq += 1;
  return `${prefix}${Date.now().toString(36).toUpperCase().slice(-5)}${seq}`.slice(0, 12);
};

beforeEach(async () => {
  for (const key of [FLAG, TOPIC_FLAG, "SLACK_BOT_TOKEN", "SLACK_CONVERSATION_BOT_TOKEN"]) savedEnv[key] = process.env[key];
  delete process.env.SLACK_BOT_TOKEN;
  delete process.env.SLACK_CONVERSATION_BOT_TOKEN;
  process.env[FLAG] = "true";
  process.env[TOPIC_FLAG] = "true";
  await setOrgApprovalKindRoutesPolicy(DEMO_ORG.id, policy(DEMO_ORG.id, ["支払", "金額"]));
  await upsertConversationAdapter({ orgId: DEMO_ORG.id, surface: "slack", enabled: true, secrets: { botToken: "xoxb-commsend-test" } });
  posts = [];
  globalThis.fetch = (async (input, init) => {
    if (String(input).includes("chat.postMessage")) {
      const payload = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
      posts.push(payload);
      return Response.json({ ok: true, channel: String(payload.channel || ""), ts: `1787912000.0000${posts.length}` });
    }
    return Response.json({ ok: true });
  }) as typeof fetch;
});

afterEach(async () => {
  while (restorers.length) restorers.pop()!();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  globalThis.fetch = originalFetch;
  await upsertConversationAdapter({ orgId: DEMO_ORG.id, surface: "slack", enabled: false, secrets: {} }).catch(() => undefined);
});

const invoke = (body: GatewayInvokeRequest) => runGatewayInvoke({ employeeId: "emp_comm", credentialId: "cred_comm", body });
function send(channel: string, text: string, extra: Partial<GatewayInvokeRequest> = {}, conv: Record<string, unknown> = {}): GatewayInvokeRequest {
  return {
    tool: "comm.send",
    purpose: "comm.internal",
    jobId: `job_commsend_${channel}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    conversation: { surface: "slack", orgId: DEMO_ORG.id, slackChannelId: channel, ...conv },
    args: { slackChannelId: channel, text },
    ...extra,
  } as GatewayInvokeRequest;
}
const egressOf = (body: Record<string, unknown>) => (body.egress ?? {}) as Record<string, unknown>;

describe("flag ON: verified internal destinations default to internal + summary", () => {
  test("ledger-internal channel (C_INTERNAL): posted without approval, class internal / summary", async () => {
    const r = await invoke(send("C_INTERNAL", "社内向けのお知らせです"));
    expect(r.httpStatus).toBe(200);
    expect(r.body.needs_approval).not.toBe(true);
    expect(posts.length).toBe(1);
  });

  test("internal DM route (D… classified internal in this org's ledger): posted without approval", async () => {
    const dm = cid("D0DM");
    await upsertOrgChannel({ orgId: DEMO_ORG.id, surface: "slack", externalId: dm, classification: "internal", mixed: false, skipInspect: true });
    const r = await invoke(send(dm, "社内向けのお知らせです"));
    expect(r.httpStatus).toBe(200);
    expect(posts.length).toBe(1);
  });
});

describe("flag ON: not verified by the channel ledger → unchanged (confidential)", () => {
  test("internal only via the party ledger (org_parties slack_channel), no channel-ledger row → approval", async () => {
    const ch = cid("C0PTY");
    await upsertOrgParty({ orgId: DEMO_ORG.id, kind: "slack_channel", identifier: ch, audience: "internal" });
    const r = await invoke(send(ch, "社内向けのお知らせです"));
    expect(r.httpStatus).toBe(402);
    expect(egressOf(r.body).informationClass).toBe("confidential");
    expect(posts.length).toBe(0);
  });

  test("ledger-internal channel but an external speaker → not posted", async () => {
    const speaker = cid("U0EXT");
    await upsertOrgParty({ orgId: DEMO_ORG.id, kind: "slack_user", identifier: speaker, audience: "external" });
    const r = await invoke(send("C_INTERNAL", "社内向けのお知らせです", {}, { speakerId: speaker }));
    expect(r.httpStatus).not.toBe(200);
    expect(posts.length).toBe(0);
  });

  test("mixed / shared_external channel (C_SHARED) → not posted", async () => {
    const r = await invoke(send("C_SHARED", "社内向けのお知らせです"));
    expect(r.httpStatus).not.toBe(200);
    expect(posts.length).toBe(0);
  });

  test("BOLA: a channel that is internal only in ANOTHER org's ledger (conversation.orgId points there) → still approval here", async () => {
    const ch = cid("C0OTH");
    await upsertOrgChannel({ orgId: OTHER_ORG, surface: "slack", externalId: ch, classification: "internal", mixed: false, skipInspect: true });
    const r = await invoke(send(ch, "社内向けのお知らせです", {}, { orgId: OTHER_ORG }));
    expect(r.httpStatus).not.toBe(200);
    expect(posts.length).toBe(0);
  });
});

describe("木村 #297 answer 1: only the channel ledger counts — party / team rule stay confidential", () => {
  test("team rule (speaker's Slack team in slackTeamIds) + party-ledger internal channel → refused 403 egress_denied (never internal)", async () => {
    const before = await getOrgInternalAudienceRule(DEMO_ORG.id);
    await setOrgInternalAudienceRule(DEMO_ORG.id, { slackTeamIds: ["T0TEAMRULE297"] }, "test");
    restorers.push(() => { void setOrgInternalAudienceRule(DEMO_ORG.id, { slackTeamIds: before.slackTeamIds }, "test"); });
    const ch = cid("C0TRL");
    await upsertOrgParty({ orgId: DEMO_ORG.id, kind: "slack_channel", identifier: ch, audience: "internal" });
    const r = await invoke(send(ch, "社内向けのお知らせです", {}, { speakerId: cid("U0TRL"), speakerTeamId: "T0TEAMRULE297" }));
    // Pinned (木村 review of #297): refused before approval — 403 egress_denied,
    // audience external, class confidential. Never relaxed to internal.
    expect(r.httpStatus).toBe(403);
    expect(r.body).toMatchObject({ code: "egress_denied", error: "external_confidential_denied", needs_approval: false });
    expect(egressOf(r.body)).toMatchObject({ decision: "deny", audience: "external", informationClass: "confidential" });
    expect(posts.length).toBe(0);
  });

  test("team rule ONLY (speaker's team in slackTeamIds, no channel / party ledger row) → 403 egress_denied, same with flag OFF", async () => {
    const before = await getOrgInternalAudienceRule(DEMO_ORG.id);
    await setOrgInternalAudienceRule(DEMO_ORG.id, { slackTeamIds: ["T0TEAMRULE297"] }, "test");
    restorers.push(() => { void setOrgInternalAudienceRule(DEMO_ORG.id, { slackTeamIds: before.slackTeamIds }, "test"); });
    const ch = cid("C0TRO");
    const conv = { speakerId: cid("U0TRO"), speakerTeamId: "T0TEAMRULE297" };
    const r = await invoke(send(ch, "社内向けのお知らせです", {}, conv));
    expect(r.httpStatus).toBe(403);
    expect(r.body).toMatchObject({ code: "egress_denied", error: "external_confidential_denied", needs_approval: false });
    expect(egressOf(r.body)).toMatchObject({ decision: "deny", informationClass: "confidential" });
    expect(egressOf(r.body).informationClass).not.toBe("internal");
    delete process.env[FLAG];
    const off = await invoke(send(ch, "社内向けのお知らせです", {}, conv));
    expect(off.httpStatus).toBe(403);
    expect(egressOf(off.body)).toMatchObject({ decision: "deny", informationClass: "confidential" });
    expect(posts.length).toBe(0);
  });

  test("party-ledger internal slack_user as the only destination (no channel-ledger row) → confidential, approval", async () => {
    const user = cid("U0PTU");
    await upsertOrgParty({ orgId: DEMO_ORG.id, kind: "slack_user", identifier: user, audience: "internal" });
    const ch = cid("D0PTU");
    const r = await invoke(send(ch, "社内向けのお知らせです", {}, { speakerId: user }));
    expect(r.httpStatus).not.toBe(200);
    expect(egressOf(r.body).informationClass).toBe("confidential");
    expect(posts.length).toBe(0);
  });
});

describe("pinned: never weakened (flag ON)", () => {
  test("a sensitive topic still forces approval on a verified internal channel", async () => {
    const r = await invoke(send("C_INTERNAL", "来週の支払について共有します"));
    expect(r.httpStatus).toBe(402);
    expect(r.body.needs_approval).toBe(true);
    expect(posts.length).toBe(0);
  });

  test("the AI can still RAISE the class (confidential) → approval; it can never lower it on an unverified destination", async () => {
    const raised = await invoke(send("C_INTERNAL", "社内向けのお知らせです", { informationClass: "confidential" }));
    expect(raised.httpStatus).toBe(402);
    expect(egressOf(raised.body).informationClass).toBe("confidential");
    const ch = cid("C0PTY");
    await upsertOrgParty({ orgId: DEMO_ORG.id, kind: "slack_channel", identifier: ch, audience: "internal" });
    for (const cls of ["public", "internal"] as const) {
      const r = await invoke(send(ch, "社内向けのお知らせです", { informationClass: cls }));
      expect(r.httpStatus).toBe(402);
      expect(egressOf(r.body).informationClass).toBe("confidential");
    }
    expect(posts.length).toBe(0);
  });

  test("employee always_human still forces approval", async () => {
    setEmployee({ approvalPolicy: "always_human" });
    const r = await invoke(send("C_INTERNAL", "社内向けのお知らせです"));
    expect(r.httpStatus).toBe(402);
    expect(posts.length).toBe(0);
  });
});

describe("flag OFF: unchanged", () => {
  test("comm.send to a ledger-internal channel → approval (confidential), nothing posted", async () => {
    delete process.env[FLAG];
    const r = await invoke(send("C_INTERNAL", "社内向けのお知らせです"));
    expect(r.httpStatus).toBe(402);
    expect(egressOf(r.body).informationClass).toBe("confidential");
    expect(posts.length).toBe(0);
  });
});

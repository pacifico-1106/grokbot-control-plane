/**
 * comm.delete through the gateway (and its MCP / approval paths).
 *
 * An employee may delete ONLY its own posts that Staffpass recorded (same org,
 * same employee). Slack uses the token that made the post (user token for a
 * posting_as=user post, bot token otherwise). LINE / Telegram → not_supported.
 * Every attempt is audited with ids / hashes only. Idempotent.
 *
 * Demo mode, dummy ids, Slack fetch mocked, no network.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ResolvedEmployeeCredential } from "@/lib/auth/employee-credential";
import { fulfillApprovedInvoke, parseFulfillment } from "@/lib/approvals/fulfill";
import { getApprovalById, resolveApproval } from "@/lib/data";
import { upsertConversationAdapter } from "@/lib/data/conversation-adapters";
import { bindEmployeeSlackIdentity, revokeEmployeeSlackIdentity } from "@/lib/data/slack-identities";
import { DEMO_ORG, getRuntimeAudit, getRuntimeEmployees, pushRuntimeAuditEvent } from "@/lib/demo-data";
import { postConversationMessage } from "@/lib/gateway/adapters/slack";
import { runGatewayInvoke } from "@/lib/gateway/invoke";
import type { Employee, GatewayInvokeRequest } from "@/lib/types";

const BOT = "xoxb-comm-delete-test";
const USER = "xoxp-comm-delete-test";
const originalFetch = globalThis.fetch;
const restorers: Array<() => void> = [];

type Call = { method: string; auth: string; payload: Record<string, unknown> };
let calls: Call[] = [];
let deleteResponse: (payload: Record<string, unknown>) => Record<string, unknown> = () => ({ ok: true });
let postCounter = 0;

function patchEmployee(patch: Partial<Employee>) {
  const emp = getRuntimeEmployees().find((item) => item.id === "emp_comm")!;
  const previous = { ...emp };
  Object.assign(emp, patch);
  restorers.push(() => {
    for (const key of Object.keys(emp)) delete (emp as unknown as Record<string, unknown>)[key];
    Object.assign(emp, previous);
  });
}


/** Link a dummy Slack user token for emp_comm (allowedAccounts must list the Slack user). */
async function linkUserToken() {
  patchEmployee({ allowedAccounts: [{ service: "slack", accountId: "U0EMPCOMM1" }] as Employee["allowedAccounts"] });
  await bindEmployeeSlackIdentity({ employeeId: "emp_comm", orgId: DEMO_ORG.id, slackUserId: "U0EMPCOMM1", userToken: USER });
}

async function mockSlack(opts: { userPostError?: string } = {}) {
  delete process.env.SLACK_BOT_TOKEN;
  delete process.env.SLACK_CONVERSATION_BOT_TOKEN;
  await upsertConversationAdapter({ orgId: DEMO_ORG.id, surface: "slack", enabled: true, secrets: { botToken: BOT } });
  calls = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const method = url.split("/api/")[1] || url;
    const headers = new Headers(init?.headers);
    const auth = headers.get("authorization") || "";
    const payload = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
    calls.push({ method, auth, payload });
    if (method === "chat.postMessage") {
      if (opts.userPostError && auth === `Bearer ${USER}`) return Response.json({ ok: false, error: opts.userPostError });
      postCounter += 1;
      return Response.json({ ok: true, channel: String(payload.channel || "C_INTERNAL"), ts: `1787911900.${String(postCounter).padStart(6, "0")}` });
    }
    if (method === "conversations.open") return Response.json({ ok: true, channel: { id: "D0OPENED01" } });
    if (method === "chat.delete") return Response.json(deleteResponse(payload));
    return Response.json({ ok: true });
  }) as typeof fetch;
}

const deletes = () => calls.filter((c) => c.method === "chat.delete");
const jid = (s: string) => `job_cdel_${s}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
const invoke = (body: GatewayInvokeRequest) =>
  runGatewayInvoke({ employeeId: "emp_comm", credentialId: "cred_comm", body });

/** Real auto comm.reply post (records the post). Returns channel + ts. */
async function seedOwnPost(text = "重複してしまった返信です。") {
  const r = await invoke({
    tool: "comm.reply",
    purpose: "comm.internal",
    jobId: jid("seed"),
    conversation: { surface: "slack", orgId: DEMO_ORG.id, slackChannelId: "C_INTERNAL", threadId: "1787911797.502889" },
    args: { slackChannelId: "C_INTERNAL", text, threadId: "1787911797.502889" },
  });
  expect(r.httpStatus).toBe(200);
  const delivery = (r.body.result as { conversationDelivery?: { channel?: string; ts?: string } }).conversationDelivery!;
  expect(delivery.ts).toBeTruthy();
  return { channel: String(delivery.channel), ts: String(delivery.ts), text };
}

function deleteBody(target: Record<string, unknown>, extra: Partial<GatewayInvokeRequest> = {}): GatewayInvokeRequest {
  return { tool: "comm.delete", purpose: "comm.internal", jobId: jid("del"), args: target, ...extra };
}

function auditsFor(action: string) {
  return getRuntimeAudit().filter((e) => e.action === action);
}

function setMaxAge(hours: string) {
  process.env.COMM_DELETE_MAX_AGE_HOURS = hours;
  restorers.push(() => { delete process.env.COMM_DELETE_MAX_AGE_HOURS; });
}

/** A post record audit row (dummy ids) created `hoursAgo` hours ago. */
function seedRecord(opts: { ts: string; hoursAgo: number; employeeId?: string; orgId?: string; channel?: string; postedVia?: "user" | "bot" }) {
  return pushRuntimeAuditEvent({
    orgId: opts.orgId ?? DEMO_ORG.id, employeeId: opts.employeeId ?? "emp_comm", credentialId: "cred_comm", action: "tool.invoke",
    purpose: "comm.internal", summary: "seed", createdAt: new Date(Date.now() - opts.hoursAgo * 3600_000).toISOString(),
    metadata: { postRecord: { v: 1, surface: "slack", channel: opts.channel ?? "C_INTERNAL", messageId: opts.ts, postedVia: opts.postedVia ?? "bot" } },
  });
}

let uniq = 0;
const fakeTs = () => `1787800000.${String(++uniq).padStart(6, "0")}`;

beforeEach(() => {
  process.env.COMM_DELETE_ENABLED = "true";
  deleteResponse = () => ({ ok: true });
});

afterEach(async () => {
  while (restorers.length) restorers.pop()!();
  globalThis.fetch = originalFetch;
  delete process.env.COMM_DELETE_ENABLED;
  await upsertConversationAdapter({ orgId: DEMO_ORG.id, surface: "slack", enabled: false, secrets: {} }).catch(() => undefined);
  await revokeEmployeeSlackIdentity({ employeeId: "emp_comm", orgId: DEMO_ORG.id }).catch(() => undefined);
});

describe("posts are recorded with the token that made them", () => {
  test("auto comm.reply records a post record (ids + postedVia, no body)", async () => {
    await mockSlack();
    const { channel, ts, text } = await seedOwnPost("記録テスト用の本文です。");
    const row = getRuntimeAudit().find(
      (e) => (e.metadata as { postRecord?: { messageId?: string } }).postRecord?.messageId === ts
    );
    expect(row).toBeTruthy();
    expect(row!.employeeId).toBe("emp_comm");
    expect(row!.orgId).toBe(DEMO_ORG.id);
    expect((row!.metadata as { postRecord: unknown }).postRecord).toEqual({ v: 1, surface: "slack", channel, messageId: ts, postedVia: "bot" });
    expect(JSON.stringify(row!.metadata)).not.toContain(text);
  });

  test("postConversationMessage reports postedVia: user token → user; app-DM bot fallback → bot", async () => {
    await mockSlack({ userPostError: "channel_not_found" });
    patchEmployee({ postingAs: "user" });
    await linkUserToken();
    const viaUserFallback = await postConversationMessage({
      orgId: DEMO_ORG.id, employeeId: "emp_comm", postingAs: "user", channel: "D0APPDM001", text: "x", slackUserId: "U0HUMAN001",
    });
    expect(viaUserFallback.ok).toBe(true);
    expect((viaUserFallback as { postedVia?: string }).postedVia).toBe("bot");

    await mockSlack();
    const viaUser = await postConversationMessage({ orgId: DEMO_ORG.id, employeeId: "emp_comm", postingAs: "user", channel: "C_INTERNAL", text: "x" });
    expect((viaUser as { postedVia?: string }).postedVia).toBe("user");
    const viaBot = await postConversationMessage({ orgId: DEMO_ORG.id, employeeId: "emp_comm", postingAs: "bot", channel: "C_INTERNAL", text: "x" });
    expect((viaBot as { postedVia?: string }).postedVia).toBe("bot");
  });
});

describe("flag OFF (default)", () => {
  test("comm.delete → 403 comm_delete_disabled, no Slack call, audited", async () => {
    await mockSlack();
    const { channel, ts } = await seedOwnPost();
    delete process.env.COMM_DELETE_ENABLED;
    const before = auditsFor("comm.delete.refused").length;
    const r = await invoke(deleteBody({ surface: "slack", channel, ts }));
    expect(r.httpStatus).toBe(403);
    expect(r.body.code).toBe("comm_delete_disabled");
    expect(deletes().length).toBe(0);
    expect(auditsFor("comm.delete.refused").length).toBe(before + 1);
  });

  test("posting is unchanged with the flag OFF (comm.reply still auto-posts once)", async () => {
    delete process.env.COMM_DELETE_ENABLED;
    await mockSlack();
    await seedOwnPost();
    expect(calls.filter((c) => c.method === "chat.postMessage").length).toBe(1);
  });
});

describe("own post: Slack chat.delete with the token that posted it", () => {
  test("bot-posted → chat.delete with the bot token; 200 deleted; audit ids only", async () => {
    await mockSlack();
    const { channel, ts, text } = await seedOwnPost("消したい本文です。");
    const r = await invoke(deleteBody({ surface: "slack", channel, ts }));
    expect(r.httpStatus).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.status).toBe("deleted");
    expect(r.body.deletedVia).toBe("bot");
    expect(r.body.target).toEqual({ surface: "slack", channel, messageId: ts });
    expect(deletes().length).toBe(1);
    expect(deletes()[0].auth).toBe(`Bearer ${BOT}`);
    expect(deletes()[0].payload).toEqual({ channel, ts });
    const audit = auditsFor("comm.delete.succeeded").find((e) => (e.metadata as { messageId?: string }).messageId === ts);
    expect(audit).toBeTruthy();
    expect(audit!.employeeId).toBe("emp_comm");
    const meta = audit!.metadata as Record<string, unknown>;
    expect(meta.channel).toBe(channel);
    expect(typeof meta.targetHash).toBe("string");
    expect(String(meta.targetHash)).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(audit)).not.toContain(text);
  });

  test("posting_as=user post → chat.delete with the employee's user token", async () => {
    await mockSlack();
    patchEmployee({ postingAs: "user" });
    await linkUserToken();
    const { channel, ts } = await seedOwnPost();
    const r = await invoke(deleteBody({ channel, ts }));
    expect(r.httpStatus).toBe(200);
    expect(r.body.deletedVia).toBe("user");
    expect(deletes().length).toBe(1);
    expect(deletes()[0].auth).toBe(`Bearer ${USER}`);
  });

  test("token follows the RECORD, not the current setting (bot post, employee now posting_as=user)", async () => {
    await mockSlack();
    const { channel, ts } = await seedOwnPost();
    patchEmployee({ postingAs: "user" });
    await linkUserToken();
    const r = await invoke(deleteBody({ channel, ts }));
    expect(r.httpStatus).toBe(200);
    expect(deletes()[0].auth).toBe(`Bearer ${BOT}`);
  });

  test("user-posted record but the user link is gone → 409 slack_identity_unbound, never falls back to the bot", async () => {
    await mockSlack();
    const ts = fakeTs();
    pushRuntimeAuditEvent({
      orgId: DEMO_ORG.id, employeeId: "emp_comm", credentialId: "cred_comm", action: "tool.invoke", purpose: "comm.internal",
      summary: "seed", metadata: { postRecord: { v: 1, surface: "slack", channel: "C_INTERNAL", messageId: ts, postedVia: "user" } },
    });
    const r = await invoke(deleteBody({ channel: "C_INTERNAL", ts }));
    expect(r.httpStatus).toBe(409);
    expect(r.body.code).toBe("slack_identity_unbound");
    expect(deletes().length).toBe(0);
    expect(auditsFor("comm.delete.failed").some((e) => (e.metadata as { messageId?: string }).messageId === ts)).toBe(true);
  });
});

describe("authorization: only own recorded posts (no IDOR, no cross-org)", () => {
  async function expectNotFound(target: Record<string, unknown>) {
    const r = await invoke(deleteBody(target));
    expect(r.httpStatus).toBe(404);
    expect(r.body.code).toBe("post_not_found_or_not_owned");
    expect(deletes().length).toBe(0);
    return r;
  }

  test("unknown ts → 404, no Slack call, audited", async () => {
    await mockSlack();
    const before = auditsFor("comm.delete.refused").length;
    await expectNotFound({ channel: "C_INTERNAL", ts: fakeTs() });
    expect(auditsFor("comm.delete.refused").length).toBe(before + 1);
  });

  test("another employee's recorded post (same org) → same 404 as unknown", async () => {
    await mockSlack();
    const ts = fakeTs();
    pushRuntimeAuditEvent({
      orgId: DEMO_ORG.id, employeeId: "emp_ops", credentialId: "cred_ops", action: "tool.invoke", purpose: "ops",
      summary: "seed", metadata: { postRecord: { v: 1, surface: "slack", channel: "C_INTERNAL", messageId: ts, postedVia: "bot" } },
    });
    const other = await expectNotFound({ channel: "C_INTERNAL", ts });
    const unknown = await invoke(deleteBody({ channel: "C_INTERNAL", ts: fakeTs() }));
    expect(other.body.message).toBe(unknown.body.message);
  });

  test("same employee id + same channel/ts but recorded in another org → 404", async () => {
    await mockSlack();
    const ts = fakeTs();
    pushRuntimeAuditEvent({
      orgId: "org_someone_else", employeeId: "emp_comm", credentialId: "cred_comm", action: "tool.invoke", purpose: "comm.internal",
      summary: "seed", metadata: { postRecord: { v: 1, surface: "slack", channel: "C_INTERNAL", messageId: ts, postedVia: "bot" } },
    });
    await expectNotFound({ channel: "C_INTERNAL", ts });
  });

  test("own record for a different channel → 404 (channel and ts must both match)", async () => {
    await mockSlack();
    const { ts } = await seedOwnPost();
    await expectNotFound({ channel: "C0OTHER001", ts });
  });

  test("an audit row without a post record (e.g. wake / denied invoke carrying channel + ts) never counts", async () => {
    await mockSlack();
    const ts = fakeTs();
    pushRuntimeAuditEvent({
      orgId: DEMO_ORG.id, employeeId: "emp_comm", credentialId: "cred_comm", action: "tool.invoke", purpose: "comm.internal",
      summary: "seed", metadata: { channel: "C_INTERNAL", ts, slackChannelId: "C_INTERNAL" },
    });
    await expectNotFound({ channel: "C_INTERNAL", ts });
  });

  test("someone else's record older than the window → the same 404 (age is never checked before ownership)", async () => {
    await mockSlack();
    setMaxAge("1");
    const ts = fakeTs();
    seedRecord({ employeeId: "emp_ops", ts, hoursAgo: 2 });
    const other = await expectNotFound({ channel: "C_INTERNAL", ts });
    const unknown = await invoke(deleteBody({ channel: "C_INTERNAL", ts: fakeTs() }));
    expect(other.body.message).toBe(unknown.body.message);
    expect(other.body.maxAgeHours).toBeUndefined();
  });

  test("the target in conversation{} is ignored: only args are the target (no egress / wake confusion)", async () => {
    await mockSlack();
    const r = await invoke({
      tool: "comm.delete", purpose: "comm.internal", jobId: jid("conv"),
      conversation: { surface: "slack", orgId: DEMO_ORG.id, slackChannelId: "C_INTERNAL", ts: fakeTs() },
      args: {},
    });
    expect(r.httpStatus).toBe(400);
    expect(r.body.code).toBe("invalid_delete_target");
    expect(deletes().length).toBe(0);
  });
});

describe("too_old: only after ownership is confirmed (no existence probing)", () => {
  async function expectNotFound(target: Record<string, unknown>) {
    const r = await invoke(deleteBody(target));
    expect(r.httpStatus).toBe(404);
    expect(r.body.code).toBe("post_not_found_or_not_owned");
    expect(r.body.maxAgeHours).toBeUndefined();
    expect(deletes().length).toBe(0);
    return r;
  }

  test("own record older than COMM_DELETE_MAX_AGE_HOURS → 403 too_old (no Slack call), audited with the record id", async () => {
    await mockSlack();
    setMaxAge("1");
    const ts = fakeTs();
    const seeded = seedRecord({ ts, hoursAgo: 2 });
    const r = await invoke(deleteBody({ channel: "C_INTERNAL", ts }));
    expect(r.httpStatus).toBe(403);
    expect(r.body.ok).toBe(false);
    expect(r.body.code).toBe("too_old");
    expect(r.body.status).toBe("refused");
    expect(r.body.maxAgeHours).toBe(1);
    expect(r.body.target).toEqual({ surface: "slack", channel: "C_INTERNAL", messageId: ts });
    expect(deletes().length).toBe(0);
    const audit = auditsFor("comm.delete.refused").find((e) => (e.metadata as { messageId?: string }).messageId === ts);
    expect((audit?.metadata as { code?: string }).code).toBe("too_old");
    expect((audit?.metadata as { recordAuditId?: string }).recordAuditId).toBe(seeded.id);
  });

  test("default window is 72h: own record 73h old → too_old; 71h old → deleted", async () => {
    await mockSlack();
    const oldTs = fakeTs();
    seedRecord({ ts: oldTs, hoursAgo: 73 });
    const old = await invoke(deleteBody({ channel: "C_INTERNAL", ts: oldTs }));
    expect(old.body.code).toBe("too_old");
    expect(old.body.maxAgeHours).toBe(72);
    const freshTs = fakeTs();
    seedRecord({ ts: freshTs, hoursAgo: 71 });
    const fresh = await invoke(deleteBody({ channel: "C_INTERNAL", ts: freshTs }));
    expect(fresh.body.status).toBe("deleted");
  });

  test("old record of the same employee id in another org → 404, not too_old", async () => {
    await mockSlack();
    setMaxAge("1");
    const ts = fakeTs();
    seedRecord({ ts, hoursAgo: 2, orgId: "org_someone_else" });
    await expectNotFound({ channel: "C_INTERNAL", ts });
  });

  test("own old record for a different channel → 404, not too_old", async () => {
    await mockSlack();
    setMaxAge("1");
    const ts = fakeTs();
    seedRecord({ ts, hoursAgo: 2, channel: "C0OTHER001" });
    await expectNotFound({ channel: "C_INTERNAL", ts });
  });

  test("old legacy slack.posted whose approval belongs to someone else → 404, not too_old", async () => {
    await mockSlack();
    setMaxAge("1");
    const ts = fakeTs();
    pushRuntimeAuditEvent({
      orgId: DEMO_ORG.id, employeeId: "emp_comm", credentialId: "cred_comm", action: "slack.posted", purpose: "comm.internal",
      summary: "legacy", createdAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
      metadata: { tool: "comm.reply", approvalId: "apr_does_not_exist", channel: "C_INTERNAL", ts, phase: "approval.fulfill" },
    });
    await expectNotFound({ channel: "C_INTERNAL", ts });
  });

  test("an old audit row without a post record never yields too_old", async () => {
    await mockSlack();
    setMaxAge("1");
    const ts = fakeTs();
    pushRuntimeAuditEvent({
      orgId: DEMO_ORG.id, employeeId: "emp_comm", credentialId: "cred_comm", action: "tool.invoke", purpose: "comm.internal",
      summary: "seed", createdAt: new Date(Date.now() - 2 * 3600_000).toISOString(), metadata: { channel: "C_INTERNAL", ts },
    });
    await expectNotFound({ channel: "C_INTERNAL", ts });
  });

  test("own record beyond the 30-day record lookback → 404 (lookup stays bounded)", async () => {
    await mockSlack();
    const ts = fakeTs();
    seedRecord({ ts, hoursAgo: 24 * 31 });
    await expectNotFound({ channel: "C_INTERNAL", ts });
  });

  test("own post already deleted, now past the window → 200 already_deleted (repeat stays idempotent)", async () => {
    await mockSlack();
    const { channel, ts } = await seedOwnPost();
    const first = await invoke(deleteBody({ channel, ts }));
    expect(first.body.status).toBe("deleted");
    for (const row of getRuntimeAudit()) {
      const m = row.metadata as { postRecord?: { messageId?: string }; deleteRecord?: { messageId?: string } };
      if (m.postRecord?.messageId === ts || m.deleteRecord?.messageId === ts) row.createdAt = new Date(Date.now() - 2 * 3600_000).toISOString();
    }
    setMaxAge("1");
    const again = await invoke(deleteBody({ channel, ts }));
    expect(again.httpStatus).toBe(200);
    expect(again.body.status).toBe("already_deleted");
    expect(deletes().length).toBe(1);
  });

  test("approval path: own old record → too_old before any approval card", async () => {
    await mockSlack();
    setMaxAge("1");
    patchEmployee({ approvalPolicy: "always_human" });
    const ts = fakeTs();
    seedRecord({ ts, hoursAgo: 2 });
    const r = await invoke(deleteBody({ channel: "C_INTERNAL", ts }));
    expect(r.httpStatus).toBe(403);
    expect(r.body.code).toBe("too_old");
    expect(r.body.approvalId).toBeUndefined();
  });

  test("approved delete whose record ages out before fulfill → too_old, nothing deleted", async () => {
    await mockSlack();
    patchEmployee({ approvalPolicy: "always_human" });
    const ts = fakeTs();
    const seeded = seedRecord({ ts, hoursAgo: 0.5 });
    const queued = await invoke(deleteBody({ channel: "C_INTERNAL", ts }));
    expect(queued.httpStatus).toBe(402);
    const approved = await resolveApproval(String(queued.body.approvalId), "approved", "ando@example.com", DEMO_ORG.id);
    seeded.createdAt = new Date(Date.now() - 2 * 3600_000).toISOString();
    setMaxAge("1");
    const f = await fulfillApprovedInvoke(approved!);
    expect(f?.ok).toBe(false);
    expect(f?.error).toBe("too_old");
    expect(deletes().length).toBe(0);
  });
});

describe("idempotency", () => {
  test("second delete of the same post → 200 already_deleted, no second Slack call", async () => {
    await mockSlack();
    const { channel, ts } = await seedOwnPost();
    const first = await invoke(deleteBody({ channel, ts }));
    expect(first.body.status).toBe("deleted");
    const second = await invoke(deleteBody({ channel, ts }));
    expect(second.httpStatus).toBe(200);
    expect(second.body.ok).toBe(true);
    expect(second.body.status).toBe("already_deleted");
    expect(second.body.code).toBe("already_deleted");
    expect(deletes().length).toBe(1);
    expect(auditsFor("comm.delete.already_deleted").some((e) => (e.metadata as { messageId?: string }).messageId === ts)).toBe(true);
  });

  test("Slack message_not_found (deleted by someone else) → 200 already_deleted", async () => {
    await mockSlack();
    const { channel, ts } = await seedOwnPost();
    deleteResponse = () => ({ ok: false, error: "message_not_found" });
    const r = await invoke(deleteBody({ channel, ts }));
    expect(r.httpStatus).toBe(200);
    expect(r.body.status).toBe("already_deleted");
    deleteResponse = () => ({ ok: true });
    const again = await invoke(deleteBody({ channel, ts }));
    expect(again.body.status).toBe("already_deleted");
    expect(deletes().length).toBe(1);
  });

  test("Slack cant_delete_message → 502 failed with the provider code, audited", async () => {
    await mockSlack();
    const { channel, ts } = await seedOwnPost();
    deleteResponse = () => ({ ok: false, error: "cant_delete_message" });
    const r = await invoke(deleteBody({ channel, ts }));
    expect(r.httpStatus).toBe(502);
    expect(r.body.code).toBe("cant_delete_message");
    expect(auditsFor("comm.delete.failed").some((e) => (e.metadata as { messageId?: string }).messageId === ts)).toBe(true);
  });
});

describe("LINE / Telegram: not_supported with a reason (no provider call)", () => {
  test("LINE → 422 not_supported (provider_has_no_delete_api)", async () => {
    await mockSlack();
    const r = await invoke(deleteBody({ surface: "line", channel: "U0LINEUSER", messageId: "325708" }));
    expect(r.httpStatus).toBe(422);
    expect(r.body.code).toBe("not_supported");
    expect(r.body.reason).toBe("provider_has_no_delete_api");
    expect(calls.length).toBe(0);
    expect(auditsFor("comm.delete.refused").some((e) => (e.metadata as { surface?: string }).surface === "line")).toBe(true);
  });
  test("Telegram → 422 not_supported (no_gateway_post_path)", async () => {
    await mockSlack();
    const r = await invoke(deleteBody({ surface: "telegram", channel: "-100123456", messageId: "42" }));
    expect(r.httpStatus).toBe(422);
    expect(r.body.code).toBe("not_supported");
    expect(r.body.reason).toBe("no_gateway_post_path");
    expect(calls.length).toBe(0);
  });
});

describe("per-tool settings and approval (risk_based, low risk)", () => {
  test("deny → 403 tool_denied_by_tool_setting, audited, no Slack call", async () => {
    await mockSlack();
    const { channel, ts } = await seedOwnPost();
    patchEmployee({ toolApprovalDefaults: { "comm.delete": "deny" } as Employee["toolApprovalDefaults"] });
    const r = await invoke(deleteBody({ channel, ts }));
    expect(r.httpStatus).toBe(403);
    expect(r.body.code).toBe("tool_denied_by_tool_setting");
    expect(deletes().length).toBe(0);
  });

  test("invalid target → 400 invalid_delete_target", async () => {
    await mockSlack();
    const r = await invoke(deleteBody({ channel: "C_INTERNAL", ts: "not-a-ts" }));
    expect(r.httpStatus).toBe(400);
    expect(r.body.code).toBe("invalid_delete_target");
  });

  test("always_human employee → 402 needs_approval (risk low); approve → deleted once; re-invoke replays", async () => {
    await mockSlack();
    const { channel, ts } = await seedOwnPost();
    patchEmployee({ approvalPolicy: "always_human" });
    const body = deleteBody({ surface: "slack", channel, ts });
    const queued = await invoke(body);
    expect(queued.httpStatus).toBe(402);
    expect(queued.body.needs_approval).toBe(true);
    expect(queued.body.risk).toBe("low");
    expect(deletes().length).toBe(0);
    const approvalId = String(queued.body.approvalId);
    const approved = await resolveApproval(approvalId, "approved", "ando@example.com", DEMO_ORG.id);
    const f = await fulfillApprovedInvoke(approved!);
    expect(f?.ok).toBe(true);
    expect(deletes().length).toBe(1);
    expect(deletes()[0].payload).toEqual({ channel, ts });
    const stored = parseFulfillment((await getApprovalById(approvalId, DEMO_ORG.id))?.metadata);
    expect(stored?.ok).toBe(true);
    const replay = await invoke({ ...body, approvalId });
    expect(replay.httpStatus).toBe(200);
    expect(replay.body.ok).toBe(true);
    expect(deletes().length).toBe(1);
  });

  test("approval is never created for someone else's post (ownership checked before the card)", async () => {
    await mockSlack();
    patchEmployee({ approvalPolicy: "always_human" });
    const r = await invoke(deleteBody({ channel: "C_INTERNAL", ts: fakeTs() }));
    expect(r.httpStatus).toBe(404);
    expect(r.body.approvalId).toBeUndefined();
  });

  test("explicit always_human on comm.delete → 402 needs_approval", async () => {
    await mockSlack();
    const { channel, ts } = await seedOwnPost();
    patchEmployee({ toolApprovalDefaults: { "comm.delete": "always_human" } as Employee["toolApprovalDefaults"] });
    const r = await invoke(deleteBody({ channel, ts }));
    expect(r.httpStatus).toBe(402);
    expect(r.body.risk).toBe("low");
    expect(deletes().length).toBe(0);
  });

  test("approved delete re-checks ownership at fulfill: flag turned OFF after approval → not deleted", async () => {
    await mockSlack();
    const { channel, ts } = await seedOwnPost();
    patchEmployee({ approvalPolicy: "always_human" });
    const queued = await invoke(deleteBody({ channel, ts }));
    const approved = await resolveApproval(String(queued.body.approvalId), "approved", "ando@example.com", DEMO_ORG.id);
    delete process.env.COMM_DELETE_ENABLED;
    const f = await fulfillApprovedInvoke(approved!);
    expect(f?.ok).toBe(false);
    expect(f?.error).toBe("comm_delete_disabled");
    expect(deletes().length).toBe(0);
  });
});

describe("approved delete: a refused run may run again once the cause is fixed", () => {
  test("flag OFF at fulfill → refused (no delete); flag ON again → same approval deletes once", async () => {
    await mockSlack();
    const { channel, ts } = await seedOwnPost();
    patchEmployee({ approvalPolicy: "always_human" });
    const queued = await invoke(deleteBody({ channel, ts }));
    const approved = await resolveApproval(String(queued.body.approvalId), "approved", "ando@example.com", DEMO_ORG.id);
    delete process.env.COMM_DELETE_ENABLED;
    const first = await fulfillApprovedInvoke(approved!);
    expect(first?.error).toBe("comm_delete_disabled");
    process.env.COMM_DELETE_ENABLED = "true";
    const second = await fulfillApprovedInvoke(approved!);
    expect(second?.ok).toBe(true);
    expect(second?.commDelete?.status).toBe("deleted");
    const third = await fulfillApprovedInvoke(approved!);
    expect(third?.ok).toBe(true);
    expect(deletes().length).toBe(1);
  });
});

describe("approved conversation posts are recorded too", () => {
  test("fulfilled comm.reply (approval) writes a post record; it can then be deleted with its token", async () => {
    await mockSlack();
    patchEmployee({ toolApprovalDefaults: { "comm.reply": "always_human" } as Employee["toolApprovalDefaults"] });
    const queued = await invoke({
      tool: "comm.reply", purpose: "comm.internal", jobId: jid("appr"),
      conversation: { surface: "slack", orgId: DEMO_ORG.id, slackChannelId: "C_INTERNAL", threadId: "1787911797.502889" },
      args: { slackChannelId: "C_INTERNAL", text: "承認後に投稿される返信", threadId: "1787911797.502889" },
    });
    expect(queued.httpStatus).toBe(402);
    const approved = await resolveApproval(String(queued.body.approvalId), "approved", "ando@example.com", DEMO_ORG.id);
    const f = await fulfillApprovedInvoke(approved!);
    expect(f?.ok).toBe(true);
    const ts = String(f?.ts);
    const posted = auditsFor("slack.posted").find((e) => (e.metadata as { ts?: string }).ts === ts);
    expect((posted?.metadata as { postRecord?: unknown }).postRecord).toEqual({ v: 1, surface: "slack", channel: "C_INTERNAL", messageId: ts, postedVia: "bot" });
    const r = await invoke(deleteBody({ channel: "C_INTERNAL", ts }));
    expect(r.httpStatus).toBe(200);
    expect(r.body.status).toBe("deleted");
  });

  test("legacy approved post (slack.posted without a post record) uses the approval's posting identity", async () => {
    await mockSlack();
    patchEmployee({ toolApprovalDefaults: { "comm.reply": "always_human" } as Employee["toolApprovalDefaults"] });
    const queued = await invoke({
      tool: "comm.reply", purpose: "comm.internal", jobId: jid("legacy"),
      conversation: { surface: "slack", orgId: DEMO_ORG.id, slackChannelId: "C_INTERNAL", threadId: "1787911797.502889" },
      args: { slackChannelId: "C_INTERNAL", text: "旧形式の記録", threadId: "1787911797.502889" },
    });
    const approvalId = String(queued.body.approvalId);
    const approved = await resolveApproval(approvalId, "approved", "ando@example.com", DEMO_ORG.id);
    const f = await fulfillApprovedInvoke(approved!);
    expect(f?.ok).toBe(true);
    const ts = String(f?.ts);
    // Simulate a row written before this PR: drop the post record. The legacy
    // path must then prove ownership through the approval (same org + employee,
    // fulfillment ok with the same channel + ts) and read postingAs from it.
    const row = auditsFor("slack.posted").find((e) => (e.metadata as { ts?: string }).ts === ts)!;
    delete (row.metadata as Record<string, unknown>).postRecord;
    const r = await invoke(deleteBody({ channel: "C_INTERNAL", ts }));
    expect(r.httpStatus).toBe(200);
    expect(r.body.deletedVia).toBe("bot");
    expect(deletes()[0].auth).toBe(`Bearer ${BOT}`);
  });

  test("legacy slack.posted whose approval did not post that ts → 404", async () => {
    await mockSlack();
    patchEmployee({ toolApprovalDefaults: { "comm.reply": "always_human" } as Employee["toolApprovalDefaults"] });
    const queued = await invoke({
      tool: "comm.reply", purpose: "comm.internal", jobId: jid("legacy2"),
      conversation: { surface: "slack", orgId: DEMO_ORG.id, slackChannelId: "C_INTERNAL", threadId: "1787911797.502889" },
      args: { slackChannelId: "C_INTERNAL", text: "旧形式の記録（別 ts）", threadId: "1787911797.502889" },
    });
    const approvalId = String(queued.body.approvalId);
    await resolveApproval(approvalId, "approved", "ando@example.com", DEMO_ORG.id);
    const ts = fakeTs();
    pushRuntimeAuditEvent({
      orgId: DEMO_ORG.id, employeeId: "emp_comm", credentialId: "cred_comm", action: "slack.posted", purpose: "comm.internal",
      summary: "legacy", metadata: { tool: "comm.reply", approvalId, channel: "C_INTERNAL", ts, phase: "approval.fulfill" },
    });
    const r = await invoke(deleteBody({ channel: "C_INTERNAL", ts }));
    expect(r.httpStatus).toBe(404);
    expect(deletes().length).toBe(0);
  });

  test("legacy slack.posted pointing at another employee's approval → 404", async () => {
    await mockSlack();
    const ts = fakeTs();
    pushRuntimeAuditEvent({
      orgId: DEMO_ORG.id, employeeId: "emp_comm", credentialId: "cred_comm", action: "slack.posted", purpose: "comm.internal",
      summary: "legacy", metadata: { tool: "comm.reply", approvalId: "apr_does_not_exist", channel: "C_INTERNAL", ts, phase: "approval.fulfill" },
    });
    const r = await invoke(deleteBody({ channel: "C_INTERNAL", ts }));
    expect(r.httpStatus).toBe(404);
    expect(deletes().length).toBe(0);
  });
});

describe("MCP staffpass_invoke", () => {
  test("comm.delete through MCP behaves like the gateway", async () => {
    const { callStaffpassMcpTool } = await import("@/lib/mcp/tools");
    await mockSlack();
    const { channel, ts } = await seedOwnPost();
    const now = new Date().toISOString();
    const cred: ResolvedEmployeeCredential = {
      employeeId: "emp_comm", orgId: DEMO_ORG.id, credentialId: "cred_comm", generation: 1,
      fingerprint: "fixture-hash", secretPrefix: "gb_emp_fixture",
      binding: {
        status: "linked", employeeId: "emp_comm", orgId: DEMO_ORG.id, credentialGeneration: 1,
        grokBotAgentId: "agent_test", grokBotWorkspaceId: null, credentialFingerprint: null,
        lastSuccessAt: null, lastError: null, wakeWebhookUrl: null, hasWakeWebhook: false,
        createdAt: now, updatedAt: now,
      },
    };
    const out = await callStaffpassMcpTool(
      "staffpass_invoke",
      { tool: "comm.delete", purpose: "comm.internal", jobId: jid("mcp"), payload: { surface: "slack", channel, ts } },
      cred
    );
    const data = out.structuredContent as Record<string, unknown>;
    expect(data.ok).toBe(true);
    expect(data.status).toBe("deleted");
    expect(deletes().length).toBe(1);
  });
});

/**
 * Route-level tests for /api/webhooks/line/[ref] (LINE approval gaps 2026-10-03).
 *
 * G3  unknown ref → 404 (LINE 検証 must fail for a wrong URL); signature order
 * G1/G4 link code (flag LINE_APPROVER_LINK_ENABLED) — 1:1 only, single use
 * G2  presser gate: missing userId / missing employee fail closed; binding match flag
 * G5  workflow 修正依頼 answered explicitly (flag LINE_WORKFLOW_REVISION_REPLY)
 * G7  resolve follow-up rides in the Reply (flag LINE_RESOLVE_FOLLOWUP_REPLY)
 *
 * All LINE API traffic is captured by a local fetch stub (no network).
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createHmac } from "node:crypto";

const SECRET = "line-channel-secret-fixture";
const REF = "abcdef123456";
const ORG = "org_demo"; // DEMO_ORG.id (real demo voter-binding store, member mem_1)
const DEST = "U00000000000000000000000000000001";
const APPROVER = "U00000000000000000000000000000002";

type Channel = Record<string, unknown> & { id: string; orgId: string };
let channel: Channel | null;
let approval: Record<string, unknown> | null;
let employee: Record<string, unknown> | null;
let delivery: Record<string, unknown> | null;
let workflowInstance: unknown;
let boundMemberId: string | null;
let resolveCalls: Array<{ id: string; decision: string; actor: string }>;
let audits: Array<Record<string, unknown>>;
let sideEffectHook: ((approval: Record<string, unknown>) => Promise<void>) | null;

mock.module("@/lib/data", () => ({
  getNotificationChannelByWebhookRef: async (_p: string, ref: string) => (ref === REF ? channel : null),
  getApprovalByTelegramRef: async () => approval,
  getNotificationDelivery: async () => delivery,
  getEmployee: async () => employee,
  getMemberById: async (id: string) =>
    id === "mem_1" ? { id: "mem_1", orgId: ORG, userId: "auth-user-1", status: "active" } : null,
  findAwaitingRevisionApproval: async () => null,
  updateApprovalTelegramState: async () => approval,
  resolveApproval: async (id: string, decision: string, actor: string) => {
    resolveCalls.push({ id, decision, actor });
    return approval ? { ...approval, status: decision } : null;
  },
  appendAuditEvent: async (event: Record<string, unknown>) => { audits.push(event); },
}));
mock.module("@/lib/approvals/workflow-integration", () => ({
  resolveApprovalWithWorkflow: async (id: string, decision: string, actor: string) => {
    resolveCalls.push({ id, decision, actor });
    return { ok: true, workflowComplete: true, approval: { ...approval, status: decision } };
  },
}));
mock.module("@/lib/approval-workflow/resolve", () => ({
  initializeWorkflowForApproval: async () => ({ instance: workflowInstance }),
}));
mock.module("@/lib/approval-workflow", () => ({
  getMemberIdFromVoterBinding: async () => boundMemberId,
}));
mock.module("@/lib/approvals/fulfill", () => ({ fulfillIfApproved: async () => {} }));
mock.module("@/lib/approvals/resolve-side-effects", () => ({
  runApprovalResolveSideEffects: async ({ approval: a }: { approval: Record<string, unknown> }) => {
    if (sideEffectHook) await sideEffectHook(a);
  },
}));

const { POST } = await import("./[ref]/route");
const { issueLineLinkCode, resetDemoLineLinkCodes } = await import("@/lib/line/link-code");
const { getVoterBinding, resetDemoVoterBindings } = await import("@/lib/approval-workflow/voter-binding");
const { resolveLineApprovalMessage } = await import("@/lib/notify/line");

type LineCall = { path: string; body: Record<string, unknown> };
let lineCalls: LineCall[];
let originalFetch: typeof fetch;
const FLAGS = ["LINE_APPROVER_LINK_ENABLED", "LINE_APPROVER_BINDING_MATCH", "LINE_WORKFLOW_REVISION_REPLY", "LINE_RESOLVE_FOLLOWUP_REPLY"];

beforeEach(() => {
  channel = {
    id: "chn-line-1", orgId: ORG, provider: "line", label: "LINE", enabled: true, isDefault: true,
    config: { destinationId: DEST, allowedUserIds: [] }, webhookRef: REF, hasCredentials: true,
    webhookPath: `/api/webhooks/line/${REF}`, createdAt: "", updatedAt: "",
    secrets: { channelAccessToken: "token", channelSecret: SECRET },
  };
  approval = { id: "apr-1", orgId: ORG, employeeId: "emp-1", status: "pending", title: "テスト承認", metadata: {} };
  employee = { id: "emp-1", orgId: ORG, approverUserIds: [] };
  delivery = { externalMessageId: null, context: {} };
  workflowInstance = null;
  boundMemberId = null;
  resolveCalls = [];
  audits = [];
  sideEffectHook = null;
  lineCalls = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    lineCalls.push({ path: new URL(String(url)).pathname, body: JSON.parse(String(init?.body || "{}")) });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  for (const flag of FLAGS) delete process.env[flag];
  resetDemoLineLinkCodes();
  resetDemoVoterBindings();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const flag of FLAGS) delete process.env[flag];
});

function sign(body: string, secret = SECRET) {
  return createHmac("sha256", secret).update(body).digest("base64");
}
async function post(events: unknown[], opts: { ref?: string; signature?: string } = {}) {
  const body = JSON.stringify({ destination: "bot", events });
  const req = new Request(`https://example.test/api/webhooks/line/${opts.ref ?? REF}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-line-signature": opts.signature ?? sign(body) },
    body,
  });
  return POST(req, { params: Promise.resolve({ ref: opts.ref ?? REF }) });
}
const repliedTexts = () =>
  lineCalls.filter((c) => c.path === "/v2/bot/message/reply")
    .flatMap((c) => (c.body.messages as Array<{ text: string }>).map((m) => m.text));
const pushes = () => lineCalls.filter((c) => c.path === "/v2/bot/message/push");
const textEvent = (text: string, source: Record<string, unknown> = { type: "user", userId: APPROVER }) => ({
  type: "message", replyToken: "rt-1", webhookEventId: "ev-1", source, message: { type: "text", text },
});
const postbackEvent = (data: string, source: Record<string, unknown> = { type: "user", userId: DEST }) => ({
  type: "postback", replyToken: "rt-2", webhookEventId: "ev-2", source, postback: { data },
});

describe("G3: webhook URL verification", () => {
  test("unknown ref → 404 without touching the body", async () => {
    const res = await post([], { ref: "wrong-ref" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, error: "not_found" });
    expect(lineCalls).toHaveLength(0);
  });

  test("known ref + bad signature → 401", async () => {
    expect((await post([], { signature: sign("other") })).status).toBe(401);
  });

  test("known ref + valid signature + empty events (LINE 検証) → 200", async () => {
    const res = await post([]);
    expect(res.status).toBe(200);
  });
});

describe("G1/G4: link code", () => {
  test("flag OFF: a code from an unregistered sender is ignored (no reply, no binding)", async () => {
    const issued = await issueLineLinkCode({ orgId: ORG, channelId: "chn-line-1", memberId: "mem_1", issuedByUserId: null });
    if (!issued.ok) throw new Error("issue");
    await post([textEvent(issued.display)]);
    expect(lineCalls).toHaveLength(0);
    expect(await getVoterBinding(ORG, "line", "chn-line-1", APPROVER)).toBeNull();
  });

  test("flag ON: a valid code in 1:1 creates a verified binding and replies", async () => {
    process.env.LINE_APPROVER_LINK_ENABLED = "true";
    const issued = await issueLineLinkCode({ orgId: ORG, channelId: "chn-line-1", memberId: "mem_1", issuedByUserId: null });
    if (!issued.ok) throw new Error("issue");
    const res = await post([textEvent(issued.display.toLowerCase())]);
    expect(res.status).toBe(200);
    const binding = await getVoterBinding(ORG, "line", "chn-line-1", APPROVER);
    expect(binding?.status).toBe("active");
    expect(binding?.memberId).toBe("mem_1");
    expect(repliedTexts().join("\n")).toContain("確認しました");
    expect(audits.some((a) => (a.metadata as Record<string, unknown>)?.event === "line_approver_linked")).toBe(true);
    // Replay of the same code fails.
    lineCalls = [];
    await post([textEvent(issued.display, { type: "user", userId: "U00000000000000000000000000000099" })]);
    expect(repliedTexts().join("\n")).toContain("無効");
    expect(await getVoterBinding(ORG, "line", "chn-line-1", "U00000000000000000000000000000099")).toBeNull();
  });

  test("flag ON: a code issued for another channel is rejected", async () => {
    process.env.LINE_APPROVER_LINK_ENABLED = "true";
    const issued = await issueLineLinkCode({ orgId: ORG, channelId: "chn-other", memberId: "mem_1", issuedByUserId: null });
    if (!issued.ok) throw new Error("issue");
    await post([textEvent(issued.display)]);
    expect(await getVoterBinding(ORG, "line", "chn-line-1", APPROVER)).toBeNull();
    expect(repliedTexts().join("\n")).toContain("無効");
  });

  test("flag ON: codes in a group are not redeemed", async () => {
    process.env.LINE_APPROVER_LINK_ENABLED = "true";
    const issued = await issueLineLinkCode({ orgId: ORG, channelId: "chn-line-1", memberId: "mem_1", issuedByUserId: null });
    if (!issued.ok) throw new Error("issue");
    await post([textEvent(issued.display, { type: "group", groupId: "C123", userId: APPROVER })]);
    expect(await getVoterBinding(ORG, "line", "chn-line-1", APPROVER)).toBeNull();
    expect(repliedTexts().join("\n")).toContain("1:1");
  });
});

describe("G2: presser gate", () => {
  test("postback without a LINE userId is refused (no line:unknown actor)", async () => {
    channel!.config = { destinationId: "C-group", allowedUserIds: [] };
    await post([postbackEvent("a:ref12345", { type: "group", groupId: "C-group" })]);
    expect(resolveCalls).toHaveLength(0);
    expect(repliedTexts().join("\n")).toContain("確認できない");
  });

  test("approval employee that cannot be loaded → refused (fail-closed)", async () => {
    employee = null;
    await post([postbackEvent("a:ref12345")]);
    expect(resolveCalls).toHaveLength(0);
    expect(repliedTexts()).toContain("この操作は許可されていません。");
  });

  test("Staffpass UUID in approverUserIds: refused with flag OFF, allowed via verified binding with flag ON", async () => {
    employee = { id: "emp-1", orgId: ORG, approverUserIds: ["auth-user-1"] };
    boundMemberId = "mem_1";
    await post([postbackEvent("a:ref12345")]);
    expect(resolveCalls).toHaveLength(0);

    process.env.LINE_APPROVER_BINDING_MATCH = "true";
    await post([postbackEvent("a:ref12345")]);
    expect(resolveCalls).toEqual([{ id: "apr-1", decision: "approved", actor: `line:${DEST}` }]);
  });

  test("raw LINE userId still works exactly as before", async () => {
    employee = { id: "emp-1", orgId: ORG, approverUserIds: [DEST] };
    await post([postbackEvent("r:ref12345")]);
    expect(resolveCalls).toEqual([{ id: "apr-1", decision: "rejected", actor: `line:${DEST}` }]);
    expect(repliedTexts()).toContain("却下しました。");
  });
});

describe("G5: 修正依頼 under a multi-approver workflow", () => {
  test("flag OFF: silently ignored (today's behavior)", async () => {
    workflowInstance = { id: "wf-1" };
    await post([postbackEvent("e:ref12345")]);
    expect(lineCalls).toHaveLength(0);
  });

  test("flag ON: answered explicitly, no state change", async () => {
    process.env.LINE_WORKFLOW_REVISION_REPLY = "true";
    workflowInstance = { id: "wf-1" };
    await post([postbackEvent("e:ref12345")]);
    expect(resolveCalls).toHaveLength(0);
    expect(repliedTexts().join("\n")).toContain("合議");
  });
});

describe("G7: resolve follow-up in the same Reply", () => {
  beforeEach(() => {
    sideEffectHook = async (a) => {
      // Real LINE follow-up path; delivery lookup is satisfied via a stubbed record.
      await resolveLineApprovalMessage(a as never, "approved", `line:${DEST}`, channel as never);
    };
  });

  test("flag OFF: follow-up is a Push + separate Reply", async () => {
    const { recordNotificationDelivery } = await import("@/lib/data/notification-channels");
    await recordNotificationDelivery({ approval: approval as never, channelId: "chn-line-1", provider: "line" });
    await post([postbackEvent("a:ref12345")]);
    expect(pushes()).toHaveLength(1);
    expect(repliedTexts()).toEqual(["承認しました。"]);
  });

  test("flag ON: one Reply carries ack + follow-up, no Push", async () => {
    process.env.LINE_RESOLVE_FOLLOWUP_REPLY = "true";
    const { recordNotificationDelivery } = await import("@/lib/data/notification-channels");
    await recordNotificationDelivery({ approval: approval as never, channelId: "chn-line-1", provider: "line" });
    await post([postbackEvent("a:ref12345")]);
    expect(pushes()).toHaveLength(0);
    const texts = repliedTexts();
    expect(texts[0]).toBe("承認しました。");
    expect(texts[1]).toContain("✅ 承認済み");
  });
});

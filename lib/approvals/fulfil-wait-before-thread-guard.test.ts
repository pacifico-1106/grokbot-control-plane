/**
 * #290 × #286 (木村, merge of 90c141e): at fulfil, the provider rate-limit wait
 * check (rateLimitWaitStop) runs BEFORE the thread single-flight lease
 * (beginThreadSend). A re-run inside the wait takes no lease and calls no
 * provider. Demo mode, dummy ids / tokens.
 */
import { afterAll, beforeAll, expect, mock, test } from "bun:test";

const actualGuard = await import("@/lib/thread-guard/guard");
let beginCalls = 0;
mock.module("@/lib/thread-guard/guard", () => ({
  ...actualGuard,
  beginThreadSend: (...args: Parameters<typeof actualGuard.beginThreadSend>) => {
    beginCalls += 1;
    return actualGuard.beginThreadSend(...args);
  },
}));

const { DEMO_ORG } = await import("@/lib/demo-data");
const { runGatewayInvoke } = await import("@/lib/gateway/invoke");
const { fulfillIfApproved, fulfillApprovedInvoke } = await import("@/lib/approvals/fulfill");
const { getApprovalById, resolveApproval } = await import("@/lib/data");
const { upsertConversationAdapter } = await import("@/lib/data/conversation-adapters");
const { upsertOrgChannel } = await import("@/lib/data/directory");

const DM = "D0WAITFIRST290";
const originalFetch = globalThis.fetch;
let slackCalls = 0;
let ratelimited = true;
const ENV = ["THREAD_SINGLE_FLIGHT_ENABLED"];
const backup = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));

beforeAll(async () => {
  await upsertOrgChannel({ orgId: DEMO_ORG.id, surface: "slack", externalId: DM, classification: "internal", mixed: false, skipInspect: true });
  await upsertConversationAdapter({ orgId: DEMO_ORG.id, surface: "slack", enabled: true, secrets: { botToken: "xoxb-wait-first-test" } });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("chat.postMessage")) {
      slackCalls += 1;
      if (ratelimited) return Response.json({ ok: false, error: "ratelimited" }, { status: 429, headers: { "Retry-After": "30" } });
      const payload = JSON.parse(String(init?.body || "{}"));
      return Response.json({ ok: true, channel: payload.channel, ts: "1791107001.000001" });
    }
    if (url.includes("conversations.info")) return Response.json({ ok: true, channel: { is_ext_shared: false } });
    return Response.json({ ok: false, error: "unexpected_fetch" });
  }) as typeof fetch;
});
afterAll(async () => {
  globalThis.fetch = originalFetch;
  for (const k of ENV) {
    if (backup[k] === undefined) delete process.env[k];
    else process.env[k] = backup[k];
  }
  await upsertConversationAdapter({ orgId: DEMO_ORG.id, surface: "slack", enabled: false, secrets: {} }).catch(() => undefined);
});

test("re-run inside the provider wait: stops on provider_rate_limited before any thread lease (beginThreadSend not called)", async () => {
  const jobId = `job_wf290_${Math.random().toString(36).slice(2, 8)}`;
  const queued = await runGatewayInvoke({
    employeeId: "emp_comm",
    credentialId: "cred_comm",
    body: {
      tool: "comm.send",
      purpose: "comm.internal",
      jobId,
      conversation: { surface: "slack", slackChannelId: DM, speakerId: "U_YAMADA" },
      args: { text: "来週の全社会議は会議室Bに変更になりました。" },
    } as never,
  });
  expect(queued.httpStatus).toBe(402);
  const approvalId = String(queued.body.approvalId);
  const approved = await resolveApproval(approvalId, "approved", "slack:U_APPROVER", DEMO_ORG.id);
  const first = await fulfillIfApproved(approved!, "approved");
  expect(first?.error).toBe("provider_rate_limited");
  expect(slackCalls).toBe(1);

  process.env.THREAD_SINGLE_FLIGHT_ENABLED = "true";
  ratelimited = false;
  beginCalls = 0;
  const current = await getApprovalById(approvalId, DEMO_ORG.id);
  const again = await fulfillApprovedInvoke(current!);
  expect(again?.ok).toBe(false);
  expect(again?.error).toBe("provider_rate_limited");
  expect(beginCalls).toBe(0);
  expect(slackCalls).toBe(1);
});

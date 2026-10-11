/**
 * #290 follow-up (木村 2026-10-09): Grok reads the tool-result body, not the
 * HTTP status. Through the employee MCP (staffpass_invoke) a provider rate
 * limit must come back as a NORMAL tool result:
 *  - JSON-RPC `result` (never `error`), HTTP 200 (not only a 429)
 *  - result.isError = true
 *  - content / structuredContent: code "provider_rate_limited", retryAfterSeconds
 *  - a Japanese nextStep: wait N seconds, then re-run with the same jobId
 *    without changing the content
 * The gateway HTTP path keeps 429. Demo mode, dummy token, fetch mocked.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";

const { DEMO_ORG } = await import("@/lib/demo-data");
const { rotateCredential } = await import("@/lib/data");
const { fingerprintSecret } = await import("@/lib/bindings");
const { upsertConversationAdapter } = await import("@/lib/data/conversation-adapters");
const { upsertOrgChannel } = await import("@/lib/data/directory");
const { runGatewayInvoke } = await import("@/lib/gateway/invoke");
const employeeRoute = await import("@/app/api/mcp/route");

const EMP_TOKEN = "gb_emp_rate_limit_tool_result_0123456789abcdef";
const DM = "D0RLMCPRESULT";
const originalFetch = globalThis.fetch;
let slackCalls = 0;

beforeAll(async () => {
  await rotateCredential("emp_comm", DEMO_ORG.id, fingerprintSecret(EMP_TOKEN));
  await upsertOrgChannel({ orgId: DEMO_ORG.id, surface: "slack", externalId: DM, classification: "internal", mixed: false, skipInspect: true });
  await upsertConversationAdapter({ orgId: DEMO_ORG.id, surface: "slack", enabled: true, secrets: { botToken: "xoxb-rl-mcp-test" } });
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await upsertConversationAdapter({ orgId: DEMO_ORG.id, surface: "slack", enabled: false, secrets: {} }).catch(() => undefined);
});

function slackRateLimited(retryAfter = "42") {
  slackCalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("chat.postMessage")) {
      slackCalls += 1;
      return Response.json({ ok: false, error: "ratelimited" }, { status: 429, headers: { "Retry-After": retryAfter } });
    }
    if (url.includes("conversations.info")) return Response.json({ ok: true, channel: { is_ext_shared: false } });
    return Response.json({ ok: true });
  }) as typeof fetch;
}

const jid = () => `job_rl_mcp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
const TEXT = "来週の全社会議は会議室Bに変更になりました。資料は前日までに共有フォルダへアップロードをお願いします。";

async function callInvokeOverMcp(jobId: string) {
  const res = await employeeRoute.POST(
    new Request("https://staffpass.test/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${EMP_TOKEN}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 11,
        method: "tools/call",
        params: {
          name: "staffpass_invoke",
          arguments: {
            tool: "comm.reply",
            purpose: "comm.internal",
            jobId,
            payload: { conversation: { surface: "slack", slackChannelId: DM, speakerId: "U_YAMADA" }, text: TEXT },
          },
        },
      }),
    })
  );
  return { res, json: (await res.json()) as Record<string, unknown> };
}

describe("staffpass_invoke: provider rate limit is a normal tool result", () => {
  test("HTTP 200, JSON-RPC result (no error), isError true, code + retryAfterSeconds + Japanese nextStep in content", async () => {
    slackRateLimited("42");
    const jobId = jid();
    const { res, json } = await callInvokeOverMcp(jobId);
    expect(slackCalls).toBe(1);
    expect(res.status).toBe(200);
    expect(json.error).toBeUndefined();
    const result = json.result as { isError?: boolean; content?: Array<{ type: string; text: string }>; structuredContent?: Record<string, unknown> };
    expect(result).toBeTruthy();
    expect(result.isError).toBe(true);
    const text = result.content?.[0]?.text ?? "";
    const parsed = JSON.parse(text) as Record<string, unknown>;
    for (const body of [parsed, result.structuredContent!]) {
      expect(body.code).toBe("provider_rate_limited");
      expect(body.retryAfterSeconds).toBe(42);
      const nextStep = String(body.nextStep);
      expect(nextStep).toContain("42秒");
      expect(nextStep).toContain("同じ jobId");
      expect(nextStep).toContain("内容を変えず");
      expect(nextStep).toMatch(/[ぁ-んァ-ン]/);
    }
  });

  test("the gateway HTTP path stays 429 (same body)", async () => {
    slackRateLimited("42");
    const r = await runGatewayInvoke({
      employeeId: "emp_comm",
      credentialId: "cred_comm",
      body: {
        tool: "comm.reply",
        purpose: "comm.internal",
        jobId: jid(),
        conversation: { surface: "slack", orgId: DEMO_ORG.id, slackChannelId: DM, speakerId: "U_YAMADA" },
        args: { text: TEXT },
      } as never,
    });
    expect(r.httpStatus).toBe(429);
    expect(r.body.code).toBe("provider_rate_limited");
    expect(String(r.body.nextStep)).toContain("42秒");
  });
});

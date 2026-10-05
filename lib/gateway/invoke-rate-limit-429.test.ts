/**
 * 429 = not sent (木村 #278 answers 3, 2026-10-05; reverses the 10/4 call).
 * A provider rate-limit answer (Slack ratelimited / rate_limited, X HTTP 429,
 * both with a JSON body) is a confirmed "not posted":
 *  - the AI gets code provider_rate_limited, retryable, the clamped wait
 *    (retryAfterSeconds from Retry-After / x-rate-limit-reset) and a nextStep
 *    that names the wait — with or without the duplicate guard flags
 *  - v2 releases the ledger claim (the retry is not a duplicate)
 *  - an approved post that was rate-limited stays re-runnable, and a re-run
 *    before the wait is over stops without calling the provider
 *  - a rate-limit body on a 5xx stays unknown (post_outcome_unknown)
 * No automatic retry loop. Demo mode, dummy ids / tokens, fetch recorded.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { DEMO_ORG } from "@/lib/demo-data";
import { runGatewayInvoke } from "@/lib/gateway/invoke";
import { fulfillApprovedInvoke, fulfillIfApproved } from "@/lib/approvals/fulfill";
import { getApprovalById, listAuditEvents, resolveApproval } from "@/lib/data";
import { upsertConversationAdapter } from "@/lib/data/conversation-adapters";
import { upsertOrgChannel } from "@/lib/data/directory";
import { demoCommReplySendsForTests, resetDemoCommReplySends } from "@/lib/data/comm-reply-sends";
import type { GatewayInvokeRequest } from "@/lib/types";

const DM = "D0RATELIMIT429";
const TEXT = "来週の全社会議は会議室Bに変更になりました。資料は前日までに共有フォルダへアップロードをお願いします。";

const originalFetch = globalThis.fetch;
let posts: Array<{ channel?: string; text?: string }> = [];
let slackCalls = 0;
let xCalls = 0;
let tweets = 0;
type Mode = "ok" | "ratelimited" | "rate_limited" | "ratelimited_5xx";
let slackMode: Mode = "ok";
let retryAfter = "30";
let xMode: "ok" | "429" = "ok";
function recordFetch() {
  posts = [];
  slackCalls = 0;
  xCalls = 0;
  tweets = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("chat.postMessage")) {
      slackCalls += 1;
      if (slackMode === "ratelimited" || slackMode === "rate_limited") {
        return Response.json({ ok: false, error: slackMode }, { status: 429, headers: { "Retry-After": retryAfter } });
      }
      if (slackMode === "ratelimited_5xx") {
        return Response.json({ ok: false, error: "ratelimited" }, { status: 503, headers: { "Retry-After": retryAfter } });
      }
      const payload = JSON.parse(String(init?.body || "{}"));
      posts.push(payload);
      return Response.json({ ok: true, channel: payload.channel, ts: `1791107${String(posts.length).padStart(3, "0")}.000001` });
    }
    if (url.includes("api.x.com")) {
      xCalls += 1;
      if (xMode === "429") {
        const reset = String(Math.floor(Date.now() / 1000) + 2);
        return Response.json({ title: "Too Many Requests" }, { status: 429, headers: { "x-rate-limit-reset": reset } });
      }
      tweets += 1;
      return Response.json({ data: { id: `tweet_${tweets}` } });
    }
    if (url.includes("conversations.info")) return Response.json({ ok: true, channel: { is_ext_shared: false } });
    if (url.includes("reactions.add")) return Response.json({ ok: true });
    return Response.json({ ok: false, error: "unexpected_fetch" });
  }) as typeof fetch;
}

const ENV = ["COMM_REPLY_DEDUP_ENABLED", "DUPLICATE_GUARD_V2_ENABLED", "X_USER_ACCESS_TOKEN", "SNS_PUBLISH_STUB"];
const envBackup = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
const v2 = () => {
  process.env.COMM_REPLY_DEDUP_ENABLED = "true";
  process.env.DUPLICATE_GUARD_V2_ENABLED = "true";
};
const flagsOff = () => {
  delete process.env.COMM_REPLY_DEDUP_ENABLED;
  delete process.env.DUPLICATE_GUARD_V2_ENABLED;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  await upsertOrgChannel({ orgId: DEMO_ORG.id, surface: "slack", externalId: DM, classification: "internal", mixed: false, skipInspect: true });
  await upsertConversationAdapter({ orgId: DEMO_ORG.id, surface: "slack", enabled: true, secrets: { botToken: "xoxb-ratelimit-429-test" } });
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  slackMode = "ok";
  xMode = "ok";
  retryAfter = "30";
  for (const k of ENV) {
    if (envBackup[k] === undefined) delete process.env[k];
    else process.env[k] = envBackup[k];
  }
  resetDemoCommReplySends();
});
afterAll(async () => {
  await upsertConversationAdapter({ orgId: DEMO_ORG.id, surface: "slack", enabled: false, secrets: {} }).catch(() => undefined);
});

const jid = (s: string) => `job_rl429_${s}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
function conv(tool: "comm.send" | "comm.reply", text = TEXT, jobId = jid(tool.replace(".", "_"))): GatewayInvokeRequest {
  return {
    tool,
    purpose: "comm.internal",
    jobId,
    conversation: { surface: "slack", orgId: DEMO_ORG.id, slackChannelId: DM, speakerId: "U_YAMADA" } as GatewayInvokeRequest["conversation"],
    args: { text },
  } as GatewayInvokeRequest;
}
const invoke = (b: GatewayInvokeRequest) => runGatewayInvoke({ employeeId: "emp_comm", credentialId: "cred_comm", body: b });

function expectRateLimitedBody(body: Record<string, unknown>, seconds: number) {
  expect(body.ok).toBe(false);
  expect(body.code).toBe("provider_rate_limited");
  expect(body.reasonCode).toBe("provider_rate_limited");
  expect(body.retryable).toBe(true);
  expect(body.nextAction).toBe("retry_later");
  expect(body.retryAfterSeconds).toBe(seconds);
  expect(String(body.nextStep)).toContain(`${seconds} seconds`);
}

describe("direct conversation post", () => {
  test("v2: Slack ratelimited → 429 provider_rate_limited with the wait; claim released; audit has the wait; the later retry goes out", async () => {
    v2();
    recordFetch();
    slackMode = "ratelimited";
    const first = await invoke(conv("comm.reply"));
    expect(first.httpStatus).toBe(429);
    expectRateLimitedBody(first.body, 30);
    expect(first.body.providerError).toBe("ratelimited");
    expect(demoCommReplySendsForTests().length).toBe(0);
    const events = await listAuditEvents(DEMO_ORG.id, 50);
    const audit = events.find((e) => e.action === "slack.post_failed" && e.metadata?.jobId === first.body.jobId);
    expect(audit?.metadata?.code).toBe("provider_rate_limited");
    expect(audit?.metadata?.retryAfterSeconds).toBe(30);

    slackMode = "ok";
    const retry = await invoke(conv("comm.reply"));
    expect(retry.httpStatus).toBe(200);
    expect(posts.length).toBe(1);
  });

  test("rate_limited spelling too; surfaced with the flags OFF as well", async () => {
    flagsOff();
    recordFetch();
    slackMode = "rate_limited";
    retryAfter = "12";
    const res = await invoke(conv("comm.reply"));
    expect(res.httpStatus).toBe(429);
    expectRateLimitedBody(res.body, 12);
  });

  test("v2: a ratelimited body on a 5xx stays unknown (post_outcome_unknown, row kept)", async () => {
    v2();
    recordFetch();
    slackMode = "ratelimited_5xx";
    const res = await invoke(conv("comm.reply"));
    expect(res.httpStatus).toBe(502);
    expect(res.body.code).toBe("post_outcome_unknown");
    expect(res.body.retryAfterSeconds).toBeUndefined();
    expect(demoCommReplySendsForTests().map((r) => r.state)).toEqual(["uncertain"]);
  });
});

describe("approved conversation post", () => {
  test("v2: rate-limited at fulfil → provider_rate_limited + wait; stays approved; an early re-run stops before Slack; after the wait it posts once", async () => {
    v2();
    recordFetch();
    const body = conv("comm.send");
    const queued = await invoke(body);
    expect(queued.httpStatus).toBe(402);
    const approvalId = String(queued.body.approvalId);
    const approved = await resolveApproval(approvalId, "approved", "slack:U_APPROVER", DEMO_ORG.id);
    slackMode = "ratelimited";
    retryAfter = "1";
    const result = await fulfillIfApproved(approved!, "approved");
    expect(result?.ok).toBe(false);
    expect(result?.error).toBe("provider_rate_limited");
    expect(result?.retryAfterSeconds).toBe(1);
    expect(slackCalls).toBe(1);
    expect(demoCommReplySendsForTests().length).toBe(0);
    expect((await getApprovalById(approvalId, DEMO_ORG.id))?.status).toBe("approved");

    slackMode = "ok";
    const early = await invoke({ ...body, approvalId });
    expect(early.httpStatus).toBe(429);
    expect(early.body.code).toBe("provider_rate_limited");
    expect(Number(early.body.retryAfterSeconds)).toBeGreaterThanOrEqual(1);
    expect(slackCalls).toBe(1); // no provider call inside the wait

    await sleep(1100);
    const later = await invoke({ ...body, approvalId });
    expect(later.httpStatus).toBe(200);
    expect(posts.length).toBe(1);
  });
});

describe("approved sns.publish", () => {
  test("X 429 at fulfil → provider_rate_limited + wait from x-rate-limit-reset; an early re-run does not call X", async () => {
    v2();
    recordFetch();
    delete process.env.SNS_PUBLISH_STUB;
    process.env.X_USER_ACCESS_TOKEN = "x-dummy";
    const res = await runGatewayInvoke({
      employeeId: "emp_sns",
      credentialId: "cred_sns",
      body: { tool: "sns.publish", purpose: "sns.publish", jobId: jid("sns"), args: { surface: "x", text: "秋の新メニューのお知らせです。来週月曜から全店舗で販売を開始します。" } },
    });
    expect(res.httpStatus).toBe(402);
    const approvalId = String(res.body.approvalId);
    const approved = await resolveApproval(approvalId, "approved", "slack:U_APPROVER", DEMO_ORG.id);
    xMode = "429";
    const result = await fulfillIfApproved(approved!, "approved");
    expect(result?.ok).toBe(false);
    expect(result?.error).toBe("provider_rate_limited");
    expect(result?.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(result?.retryAfterSeconds).toBeLessThanOrEqual(2);
    expect(xCalls).toBe(1);
    expect(demoCommReplySendsForTests().length).toBe(0);

    xMode = "ok";
    const again = await fulfillApprovedInvoke((await getApprovalById(approvalId, DEMO_ORG.id))!);
    expect(again?.ok).toBe(false);
    expect(again?.error).toBe("provider_rate_limited");
    expect(xCalls).toBe(1);
    expect(tweets).toBe(0);
  });
});

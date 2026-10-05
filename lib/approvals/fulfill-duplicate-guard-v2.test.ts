/**
 * Duplicate post guard v2 on the approval-fulfil path (Yasaka 2026-10-05:
 * "make sure the approval-fulfil path is covered by (1) and (5)"). Background:
 * 稲盛 once posted the same content to two DMs twice, the second time from a
 * held approval approved later.
 *  (1) fulfil compares with the 6 h window and with the same jobId regardless
 *      of time (an approval queued while v1 was on and approved after the
 *      switch is still caught)
 *  (5) a fulfil post with an unknown outcome keeps the ledger row (uncertain):
 *      the approval is not re-run and a direct resend is blocked with nextStep;
 *      a gate that meets an uncertain row stops without closing the approval
 *  (6) sns.publish fulfil goes through the same ledger
 * Demo mode, dummy ids / tokens, Slack + X fetch recorded, no network.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { DEMO_ORG } from "@/lib/demo-data";
import { runGatewayInvoke } from "@/lib/gateway/invoke";
import { fulfillApprovedInvoke, fulfillIfApproved } from "@/lib/approvals/fulfill";
import { getApprovalById, resolveApproval } from "@/lib/data";
import { upsertConversationAdapter } from "@/lib/data/conversation-adapters";
import { upsertOrgChannel } from "@/lib/data/directory";
import { demoCommReplySendsForTests, resetDemoCommReplySends } from "@/lib/data/comm-reply-sends";
import { setCommReplyDedupClockForTests } from "@/lib/comm-reply-dedup/config";
import type { GatewayInvokeRequest } from "@/lib/types";

const DM = "D0FULFILLV2A";
const TEXT =
  "山田さん、明日10時からの定例会議の資料をカレンダーの予定に添付しました。議題は来期の予算配分と採用計画の2点です。";

const originalFetch = globalThis.fetch;
let posts: Array<{ channel?: string; text?: string }> = [];
let tweets = 0;
let slackMode: "ok" | "timeout" = "ok";
function recordFetch() {
  posts = [];
  tweets = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("chat.postMessage")) {
      if (slackMode === "timeout") throw new DOMException("The operation timed out.", "TimeoutError");
      const payload = JSON.parse(String(init?.body || "{}"));
      posts.push(payload);
      return Response.json({ ok: true, channel: payload.channel, ts: `1791106${String(posts.length).padStart(3, "0")}.000001` });
    }
    if (url.includes("api.x.com")) {
      tweets += 1;
      return Response.json({ data: { id: `tweet_${tweets}` } });
    }
    if (url.includes("conversations.info")) return Response.json({ ok: true, channel: { is_ext_shared: false } });
    return Response.json({ ok: false, error: "unexpected_fetch" });
  }) as typeof fetch;
}

const ENV = ["COMM_REPLY_DEDUP_ENABLED", "DUPLICATE_GUARD_V2_ENABLED", "X_USER_ACCESS_TOKEN", "SNS_PUBLISH_STUB"];
const envBackup = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
const v1 = () => {
  process.env.COMM_REPLY_DEDUP_ENABLED = "true";
  delete process.env.DUPLICATE_GUARD_V2_ENABLED;
};
const v2 = () => {
  process.env.COMM_REPLY_DEDUP_ENABLED = "true";
  process.env.DUPLICATE_GUARD_V2_ENABLED = "true";
};
let now = Date.now();

beforeAll(async () => {
  await upsertOrgChannel({ orgId: DEMO_ORG.id, surface: "slack", externalId: DM, classification: "internal", mixed: false, skipInspect: true });
  await upsertConversationAdapter({ orgId: DEMO_ORG.id, surface: "slack", enabled: true, secrets: { botToken: "xoxb-fulfill-v2-test" } });
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  slackMode = "ok";
  for (const k of ENV) {
    if (envBackup[k] === undefined) delete process.env[k];
    else process.env[k] = envBackup[k];
  }
  setCommReplyDedupClockForTests(null);
  resetDemoCommReplySends();
});
afterAll(async () => {
  await upsertConversationAdapter({ orgId: DEMO_ORG.id, surface: "slack", enabled: false, secrets: {} }).catch(() => undefined);
});

const jid = (s: string) => `job_fulfill_v2_${s}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
function conv(tool: "comm.send" | "comm.reply", text: string, jobId = jid(tool.replace(".", "_"))): GatewayInvokeRequest {
  return {
    tool,
    purpose: "comm.internal",
    jobId,
    conversation: { surface: "slack", orgId: DEMO_ORG.id, slackChannelId: DM, speakerId: "U_YAMADA" } as GatewayInvokeRequest["conversation"],
    args: { text },
  } as GatewayInvokeRequest;
}
const invoke = (b: GatewayInvokeRequest) => runGatewayInvoke({ employeeId: "emp_comm", credentialId: "cred_comm", body: b });
async function queue(text: string, jobId?: string) {
  const res = await invoke(conv("comm.send", text, jobId)); // comm.send → confidential → needs approval
  expect(res.httpStatus).toBe(402);
  return String(res.body.approvalId);
}
async function approve(id: string) {
  const approved = await resolveApproval(id, "approved", "slack:U_APPROVER", DEMO_ORG.id);
  return approved ? fulfillIfApproved(approved, "approved") : null;
}
const status = async (id: string) => (await getApprovalById(id, DEMO_ORG.id))?.status;

describe("(1) window + same jobId at fulfil", () => {
  test("v1 control: reply 40 min before the approval was created → approving later sends it again", async () => {
    v1();
    recordFetch();
    now = Date.now();
    setCommReplyDedupClockForTests(() => now);
    expect((await invoke(conv("comm.reply", TEXT))).httpStatus).toBe(200);
    now += 40 * 60_000;
    const id = await queue(TEXT);
    now += 18 * 60_000;
    expect((await approve(id))?.ok).toBe(true);
    expect(posts.length).toBe(2);
  });

  test("v2 switched on before approval: the held copy is not sent (window)", async () => {
    v1();
    recordFetch();
    now = Date.now();
    setCommReplyDedupClockForTests(() => now);
    expect((await invoke(conv("comm.reply", TEXT))).httpStatus).toBe(200);
    now += 40 * 60_000;
    const id = await queue(TEXT);
    v2();
    now += 18 * 60_000;
    const result = await approve(id);
    expect(result?.ok).toBe(false);
    expect(result?.error).toBe("approval_superseded");
    expect(await status(id)).toBe("superseded");
    expect(posts.length).toBe(1);
  });

  // The direct row was written under v1 (no job key), so what catches it is the
  // approval-relative window: at fulfil the window also reaches back from the
  // approval's creation (a held copy of a body sent 40 min before it was
  // requested is a duplicate however late it is approved). The job-key rule
  // itself is covered at invoke (invoke-duplicate-guard-v2.test.ts) and in SQL.
  test("v2: same job + same body sent before the approval is caught at fulfil 7 h later (approval-relative window)", async () => {
    v1();
    recordFetch();
    now = Date.now();
    setCommReplyDedupClockForTests(() => now);
    const jobId = jid("same");
    expect((await invoke(conv("comm.reply", TEXT, jobId))).httpStatus).toBe(200);
    now += 40 * 60_000;
    const id = await queue(TEXT, jobId);
    v2();
    now += 7 * 60 * 60_000; // beyond the 6 h window, inside the 24 h approval TTL
    const result = await approve(id);
    expect(result?.ok).toBe(false);
    expect(result?.error).toBe("approval_superseded");
    expect(posts.length).toBe(1);
  });
});

describe("(5) unknown outcome at fulfil", () => {
  test("v1 control: a timed-out fulfil post deletes the fingerprint; a direct resend goes out", async () => {
    v1();
    recordFetch();
    const id = await queue(TEXT);
    slackMode = "timeout";
    expect((await approve(id))?.ok).toBe(false);
    expect(demoCommReplySendsForTests().length).toBe(0);
    slackMode = "ok";
    expect((await invoke(conv("comm.reply", TEXT))).httpStatus).toBe(200);
  });

  test("v2: timed-out fulfil → post_outcome_unknown, row kept uncertain; a direct resend is blocked with nextStep", async () => {
    v2();
    recordFetch();
    const id = await queue(TEXT);
    slackMode = "timeout";
    const result = await approve(id);
    expect(result?.ok).toBe(false);
    expect(result?.error).toBe("post_outcome_unknown");
    expect(demoCommReplySendsForTests().map((r) => r.state)).toEqual(["uncertain"]);
    slackMode = "ok";
    const resend = await invoke(conv("comm.reply", TEXT));
    expect(resend.httpStatus).toBe(409);
    expect(resend.body.code).toBe("duplicate_post_uncertain");
    expect(resend.body.nextAction).toBe("verify_then_confirm");
    expect(posts.length).toBe(0);
  });

  test("v2: a fulfil gate that meets an uncertain row stops before the post and does not close the approval", async () => {
    v2();
    recordFetch();
    const id = await queue(TEXT);
    const approved = await resolveApproval(id, "approved", "slack:U_APPROVER", DEMO_ORG.id);
    // While the approval waits for fulfilment, a direct reply with the same body times out.
    slackMode = "timeout";
    expect((await invoke(conv("comm.reply", TEXT))).body.code).toBe("post_outcome_unknown");
    slackMode = "ok";
    const result = await fulfillIfApproved(approved!, "approved");
    expect(result?.ok).toBe(false);
    expect(result?.error).toBe("duplicate_post_uncertain");
    expect(await status(id)).toBe("approved");
    expect(posts.length).toBe(0);
  });
});

describe("(6) sns.publish fulfil uses the same ledger", () => {
  async function queueSns(text: string) {
    const res = await runGatewayInvoke({
      employeeId: "emp_sns",
      credentialId: "cred_sns",
      body: { tool: "sns.publish", purpose: "sns.publish", jobId: jid("sns"), args: { surface: "x", text } },
    });
    expect(res.httpStatus).toBe(402);
    return String(res.body.approvalId);
  }
  test("v1 control: two approvals with the same post both publish", async () => {
    v1();
    recordFetch();
    process.env.X_USER_ACCESS_TOKEN = "x-dummy";
    const a = await queueSns("新サービスの告知です。来週月曜から先行受付を始めます。詳細はプロフィールのリンクから。");
    const b = await queueSns("新サービスの告知です。来週月曜から先行受付を始めます。詳細はプロフィールのリンクから。");
    expect((await approve(a))?.ok).toBe(true);
    expect((await approve(b))?.ok).toBe(true);
    expect(tweets).toBe(2);
  });

  test("v2: the second identical post is not published (superseded)", async () => {
    v2();
    recordFetch();
    process.env.X_USER_ACCESS_TOKEN = "x-dummy";
    const a = await queueSns("新サービスの告知です。来週月曜から先行受付を始めます。詳細はプロフィールのリンクから。");
    const b = await queueSns("新サービスの告知です！ 来週月曜から先行受付を始めます。詳細はプロフィールのリンクから。");
    expect((await approve(a))?.ok).toBe(true);
    const second = await approve(b);
    expect(second?.ok).toBe(false);
    expect(second?.error).toBe("approval_superseded");
    expect(tweets).toBe(1);
  });
});

test("fulfillApprovedInvoke export is still used by the approved re-run (smoke)", () => {
  expect(typeof fulfillApprovedInvoke).toBe("function");
});

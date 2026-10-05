/**
 * Duplicate post guard v2 (DUPLICATE_GUARD_V2_ENABLED, default OFF) at the
 * gateway (Yasaka / 木村 2026-10-05, PR-A). Closes, for every guarded posting
 * path, the holes of the v1 conversation ledger (COMM_REPLY_DEDUP_ENABLED):
 *  (1) after 30 min the same post went through again; the same jobId resent
 *  (2) a top-level post and a thread post in one channel never compared
 *  (3) another employee posting the same content was not even noticed
 *  (4) short bodies: only exact; mentions / emoji / shortcodes slipped through,
 *      while a plain "OK" twice in 30 min was blocked (false positive)
 *  (5) a failed post (incl. timeout) deleted the fingerprint → blind resend
 *  (6) file uploads with a message were not covered
 * Every block returns a reason code + nextStep; store errors fail closed.
 * Demo mode, dummy ids / tokens, Slack fetch + upload recorded, no network.
 */
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import * as realUpload from "@/lib/gateway/adapters/slack-file-upload";
import * as realSends from "@/lib/data/comm-reply-sends";

let uploads: Array<{ channel: string; threadTs: string; filename: string; initialComment?: string }> = [];
mock.module("@/lib/gateway/adapters/slack-file-upload", () => ({
  ...realUpload,
  uploadSlackFile: async (input: Parameters<typeof realUpload.uploadSlackFile>[0]) => {
    uploads.push({ channel: input.channel, threadTs: input.threadTs, filename: input.filename, initialComment: input.initialComment });
    return { ok: true as const, fileId: `F0UP${uploads.length}`, filename: input.filename, bytes: 10, channel: input.channel, threadTs: input.threadTs };
  },
}));
let storeDown = false;
mock.module("@/lib/data/comm-reply-sends", () => ({
  ...realSends,
  claimOutboundSendV2: async (input: Parameters<typeof realSends.claimOutboundSendV2>[0]) =>
    storeDown ? { state: "unavailable" as const, reason: "claim_failed" } : realSends.claimOutboundSendV2(input),
}));

const { DEMO_ORG, getRuntimeEmployees } = await import("@/lib/demo-data");
const { runGatewayInvoke } = await import("@/lib/gateway/invoke");
const { listAuditEvents } = await import("@/lib/data");
const { upsertConversationAdapter } = await import("@/lib/data/conversation-adapters");
const { upsertOrgChannel } = await import("@/lib/data/directory");
const { demoCommReplySendsForTests, resetDemoCommReplySends } = await import("@/lib/data/comm-reply-sends");
const { setCommReplyDedupClockForTests } = await import("@/lib/comm-reply-dedup/config");
type GatewayInvokeRequest = import("@/lib/types").GatewayInvokeRequest;

const DM = "D0GUARDV2DM";
const CHANNEL = "C0GUARDV2CH";
const TEXT = "本日15時からの打ち合わせ資料をカレンダーに共有しました。ご確認よろしくお願いします。";
const OTHER = "経費精算の締め切りが今週金曜日に変更になりました。領収書は木曜日までに提出をお願いします。";
const BODY_PIECES = ["打ち合わせ資料", "カレンダー", "経費精算"];
const T1 = "1791105000.000001";
const T2 = "1791105000.000002";

const originalFetch = globalThis.fetch;
let posts: Array<{ channel?: string; text?: string; thread_ts?: string }> = [];
let slackMode: "ok" | "timeout" | "channel_not_found" = "ok";
function recordSlack() {
  posts = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("chat.postMessage")) {
      if (slackMode === "timeout") throw new DOMException("The operation timed out.", "TimeoutError");
      if (slackMode === "channel_not_found") return Response.json({ ok: false, error: "channel_not_found" });
      const payload = JSON.parse(String(init?.body || "{}"));
      posts.push(payload);
      return Response.json({ ok: true, channel: payload.channel, ts: `1791105${String(posts.length).padStart(3, "0")}.000009` });
    }
    if (url.includes("conversations.info")) return Response.json({ ok: true, channel: { is_ext_shared: false } });
    if (url.includes("reactions.add")) return Response.json({ ok: true });
    return Response.json({ ok: false, error: "unexpected_fetch" });
  }) as typeof fetch;
}

const ENV = ["COMM_REPLY_DEDUP_ENABLED", "DUPLICATE_GUARD_V2_ENABLED", "COMM_REPLY_DEDUP_CROSS_EMPLOYEE", "COMM_REPLY_DEDUP_WINDOW_MINUTES"];
const envBackup = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
function v1() {
  process.env.COMM_REPLY_DEDUP_ENABLED = "true";
  delete process.env.DUPLICATE_GUARD_V2_ENABLED;
}
function v2() {
  process.env.COMM_REPLY_DEDUP_ENABLED = "true";
  process.env.DUPLICATE_GUARD_V2_ENABLED = "true";
}
let now = Date.now();
function clock() {
  now = Date.now();
  setCommReplyDedupClockForTests(() => now);
}

beforeAll(async () => {
  for (const id of [DM, CHANNEL]) {
    await upsertOrgChannel({ orgId: DEMO_ORG.id, surface: "slack", externalId: id, classification: "internal", mixed: false, skipInspect: true });
  }
  await upsertConversationAdapter({ orgId: DEMO_ORG.id, surface: "slack", enabled: true, secrets: { botToken: "xoxb-guard-v2-test" } });
  const comm = getRuntimeEmployees().find((e) => e.id === "emp_comm")!;
  if (!getRuntimeEmployees().some((e) => e.id === "emp_comm2")) {
    getRuntimeEmployees().push({ ...comm, id: "emp_comm2", displayName: "社内連絡AI社員2", credentialId: "cred_comm2" });
  }
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  slackMode = "ok";
  storeDown = false;
  uploads = [];
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

const jid = () => `job_guard_v2_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
function req(conversation: Record<string, unknown>, text = TEXT, extra: Partial<GatewayInvokeRequest> = {}): GatewayInvokeRequest {
  return {
    tool: "comm.reply",
    purpose: "comm.internal",
    jobId: jid(),
    conversation: { orgId: DEMO_ORG.id, ...conversation } as GatewayInvokeRequest["conversation"],
    args: { text },
    ...extra,
  } as GatewayInvokeRequest;
}
const dm = (text = TEXT, extra: Partial<GatewayInvokeRequest> = {}) =>
  req({ surface: "slack", slackChannelId: DM, speakerId: "U_YAMADA" }, text, extra);
const ch = (text = TEXT, thread?: string, extra: Partial<GatewayInvokeRequest> = {}) =>
  req({ surface: "slack", slackChannelId: CHANNEL, ...(thread ? { threadId: thread } : {}) }, text, extra);
const invoke = (b: GatewayInvokeRequest, employeeId = "emp_comm") =>
  runGatewayInvoke({ employeeId, credentialId: employeeId === "emp_comm" ? "cred_comm" : "cred_comm2", body: b });

describe("(1) window and same jobId", () => {
  test("v1 control: the same body 31 min later goes out again", async () => {
    v1();
    recordSlack();
    clock();
    expect((await invoke(dm())).httpStatus).toBe(200);
    now += 31 * 60_000;
    expect((await invoke(dm())).httpStatus).toBe(200);
    expect(posts.length).toBe(2);
  });

  test("v2: 31 min later still suppressed (default window 6 h); after 6 h another job may send it", async () => {
    v2();
    recordSlack();
    clock();
    expect((await invoke(dm())).httpStatus).toBe(200);
    now += 31 * 60_000;
    const again = await invoke(dm());
    expect(again.httpStatus).toBe(409);
    expect(again.body.code).toBe("duplicate_reply_suppressed");
    expect(again.body.windowMinutes).toBe(360);
    now += 6 * 60 * 60_000;
    expect((await invoke(dm())).httpStatus).toBe(200);
    expect(posts.length).toBe(2);
  });

  test("v2: the same jobId with the same body goes out once, regardless of time; the job may still post another message", async () => {
    v2();
    recordSlack();
    clock();
    const jobId = jid();
    expect((await invoke(dm(TEXT, { jobId }))).httpStatus).toBe(200);
    now += 7 * 24 * 60 * 60_000; // a week later, far outside the window
    const resend = await invoke(dm(TEXT, { jobId }));
    expect(resend.httpStatus).toBe(409);
    expect(resend.body.code).toBe("duplicate_reply_suppressed");
    expect(resend.body.scope).toBe("same_job");
    expect((await invoke(dm(OTHER, { jobId }))).httpStatus).toBe(200);
    expect(posts.length).toBe(2);
  });
});

describe("(2) top-level vs thread in the same channel", () => {
  test("v1 control: top-level then thread is another conversation (posted twice)", async () => {
    v1();
    recordSlack();
    expect((await invoke(ch(TEXT))).httpStatus).toBe(200);
    expect((await invoke(ch(TEXT, T1))).httpStatus).toBe(200);
    expect(posts.length).toBe(2);
  });

  test("v2: top-level then the same body in a thread (and vice versa) → suppressed, scope cross_thread", async () => {
    v2();
    recordSlack();
    expect((await invoke(ch(TEXT))).httpStatus).toBe(200);
    const inThread = await invoke(ch(TEXT, T1));
    expect(inThread.httpStatus).toBe(409);
    expect(inThread.body.scope).toBe("cross_thread");
    resetDemoCommReplySends();
    expect((await invoke(ch(OTHER, T2))).httpStatus).toBe(200);
    const topLevel = await invoke(ch(OTHER));
    expect(topLevel.httpStatus).toBe(409);
    expect(topLevel.body.scope).toBe("cross_thread");
    expect(posts.length).toBe(2);
  });

  test("v2: a short reply in two different threads is two conversations (no false positive)", async () => {
    v2();
    recordSlack();
    expect((await invoke(ch("了解です", T1))).httpStatus).toBe(200);
    expect((await invoke(ch("了解です", T2))).httpStatus).toBe(200);
    expect(posts.length).toBe(2);
  });
});

describe("(3) another employee, same conversation, same content", () => {
  test("v1: detected and warned (posted, warning + audit, hashes only)", async () => {
    v1();
    recordSlack();
    expect((await invoke(ch(TEXT))).httpStatus).toBe(200);
    const second = await invoke(ch(TEXT), "emp_comm2");
    expect(second.httpStatus).toBe(200);
    expect(second.body.duplicateWarning).toMatchObject({ reasonCode: "cross_employee_duplicate", decision: "warn" });
    expect(posts.length).toBe(2);
    const events = await listAuditEvents(DEMO_ORG.id, 50);
    const audit = events.find((e) => e.action === "comm_reply.cross_employee_duplicate" && e.metadata?.jobId === second.body.jobId);
    expect(audit?.metadata).toMatchObject({ decision: "warn", match: "exact" });
    const json = JSON.stringify(audit);
    for (const piece of BODY_PIECES) expect(json.includes(piece)).toBe(false);
  });

  test("v2: blocked by default (scope cross_employee, audit decision block)", async () => {
    v2();
    recordSlack();
    expect((await invoke(ch(TEXT))).httpStatus).toBe(200);
    const second = await invoke(ch(TEXT, T1), "emp_comm2");
    expect(second.httpStatus).toBe(409);
    expect(second.body.code).toBe("duplicate_reply_suppressed");
    expect(second.body.scope).toBe("cross_employee");
    expect(posts.length).toBe(1);
    const events = await listAuditEvents(DEMO_ORG.id, 50);
    expect(events.some((e) => e.action === "comm_reply.cross_employee_duplicate" && e.metadata?.decision === "block" && e.metadata?.jobId === second.body.jobId)).toBe(true);
  });

  test("v2 with COMM_REPLY_DEDUP_CROSS_EMPLOYEE=warn: posted with a warning", async () => {
    v2();
    process.env.COMM_REPLY_DEDUP_CROSS_EMPLOYEE = "warn";
    recordSlack();
    expect((await invoke(ch(TEXT))).httpStatus).toBe(200);
    const second = await invoke(ch(TEXT), "emp_comm2");
    expect(second.httpStatus).toBe(200);
    expect(second.body.duplicateWarning).toMatchObject({ reasonCode: "cross_employee_duplicate", decision: "warn" });
  });

  test("v2: two employees each saying a short 'OK' is not a duplicate", async () => {
    v2();
    recordSlack();
    expect((await invoke(ch("OK", T1))).httpStatus).toBe(200);
    const second = await invoke(ch("OK", T1), "emp_comm2");
    expect(second.httpStatus).toBe(200);
    expect(second.body.duplicateWarning).toBeUndefined();
  });
});

describe("(4) short bodies", () => {
  test("v2: a trivial variant within the short window is suppressed", async () => {
    v2();
    recordSlack();
    clock();
    expect((await invoke(dm("<@U0NOGI|野木> 了解です"))).httpStatus).toBe(200);
    now += 60_000;
    const variant = await invoke(dm("<@U0NOGI> 了解です :+1: 👍🏻"));
    expect(variant.httpStatus).toBe(409);
    expect(variant.body.code).toBe("duplicate_reply_suppressed");
    expect(posts.length).toBe(1);
  });

  test("v2: the same short reply a few minutes later is a new reply (posted)", async () => {
    v2();
    recordSlack();
    clock();
    expect((await invoke(dm("OK"))).httpStatus).toBe(200);
    now += 3 * 60_000;
    expect((await invoke(dm("ＯＫ！"))).httpStatus).toBe(200);
    expect(posts.length).toBe(2);
  });

  test("v2: the same words to another addressee are not trivial", async () => {
    v2();
    recordSlack();
    expect((await invoke(ch("<@U0NOGI> 了解です", T1))).httpStatus).toBe(200);
    expect((await invoke(ch("<@U0YASAKA> 了解です", T1))).httpStatus).toBe(200);
    expect(posts.length).toBe(2);
  });
});

describe("(5) failed posts", () => {
  test("v1 control: a timed-out post deletes the fingerprint and a blind resend goes out", async () => {
    v1();
    recordSlack();
    slackMode = "timeout";
    expect((await invoke(dm())).httpStatus).toBe(502);
    slackMode = "ok";
    expect((await invoke(dm())).httpStatus).toBe(200);
  });

  test("v2: timeout → post_outcome_unknown + nextStep; blind resend blocked; confirmed resend goes out once", async () => {
    v2();
    recordSlack();
    slackMode = "timeout";
    const first = await invoke(dm());
    expect(first.httpStatus).toBe(502);
    expect(first.body.code).toBe("post_outcome_unknown");
    expect(first.body.reasonCode).toBe("post_outcome_unknown");
    expect(first.body.nextAction).toBe("verify_then_confirm");
    expect(String(first.body.nextStep)).toContain("confirmedNotDelivered");
    const ref = String(first.body.uncertainRef);
    expect(ref).toMatch(/^[0-9a-f-]{36}$/);
    expect(demoCommReplySendsForTests().map((r) => r.state)).toEqual(["uncertain"]);

    slackMode = "ok";
    const blind = await invoke(dm());
    expect(blind.httpStatus).toBe(409);
    expect(blind.body.code).toBe("duplicate_post_uncertain");
    expect(blind.body.nextAction).toBe("verify_then_confirm");
    expect(blind.body.uncertainRef).toBe(ref);
    expect(posts.length).toBe(0);

    // Another employee cannot release it.
    const foreign = await invoke(dm(TEXT, { duplicateGuard: { confirmedNotDelivered: ref } }), "emp_comm2");
    expect(foreign.httpStatus).toBe(409);
    expect(posts.length).toBe(0);

    const confirmed = await invoke(dm(TEXT, { duplicateGuard: { confirmedNotDelivered: ref } }));
    expect(confirmed.httpStatus).toBe(200);
    expect(posts.length).toBe(1);
    const events = await listAuditEvents(DEMO_ORG.id, 50);
    expect(events.some((e) => e.action === "comm_reply.uncertain_released" && e.metadata?.jobId === confirmed.body.jobId)).toBe(true);
    // And only once: the confirmation does not open the door again.
    expect((await invoke(dm(TEXT, { duplicateGuard: { confirmedNotDelivered: ref } }))).httpStatus).toBe(409);
    expect(posts.length).toBe(1);
  });

  test("v2: a definite provider refusal (channel_not_found) releases the claim; the retry is not a duplicate", async () => {
    v2();
    recordSlack();
    slackMode = "channel_not_found";
    const failed = await invoke(dm());
    expect(failed.httpStatus).toBe(502);
    expect(failed.body.code).toBe("slack_post_failed");
    expect(demoCommReplySendsForTests().length).toBe(0);
    slackMode = "ok";
    expect((await invoke(dm())).httpStatus).toBe(200);
  });
});

describe("(6) file upload with a message", () => {
  test("v2: the same file + comment to the same channel is shared once (another matter's text still posts)", async () => {
    v2();
    recordSlack();
    const file = { fileRef: "https://files.example.invalid/f/report.pdf", filename: "report.pdf", mimeType: "application/pdf", initialComment: "資料です" };
    const first = await invoke(ch(TEXT, T1, { fileAttachment: file }));
    expect(first.httpStatus).toBe(200);
    expect(uploads.length).toBe(1);
    const second = await invoke(ch(OTHER, T1, { fileAttachment: file }));
    expect(second.httpStatus).toBe(200);
    expect(posts.length).toBe(2);
    expect(uploads.length).toBe(1);
    expect(second.body.fileUpload).toMatchObject({ ok: false, code: "duplicate_reply_suppressed" });
  });
});

describe("fail closed + reason codes", () => {
  test("v2: ledger unavailable → 503 duplicate_check_unavailable, retryable, nextAction retry_later; nothing posted", async () => {
    v2();
    recordSlack();
    storeDown = true;
    const res = await invoke(dm());
    expect(res.httpStatus).toBe(503);
    expect(res.body.code).toBe("duplicate_check_unavailable");
    expect(res.body.retryable).toBe(true);
    expect(res.body.nextAction).toBe("retry_later");
    expect(posts.length).toBe(0);
  });

  test("v1 too: a suppressed duplicate carries reasonCode + nextStep (additive fields)", async () => {
    v1();
    recordSlack();
    expect((await invoke(dm())).httpStatus).toBe(200);
    const dup = await invoke(dm());
    expect(dup.body.reasonCode).toBe("duplicate_reply_suppressed");
    expect(dup.body.nextAction).toBe("none");
    expect(String(dup.body.nextStep).length).toBeGreaterThan(10);
  });

  test("v2: ledger rows and audits never contain the body", async () => {
    v2();
    recordSlack();
    await invoke(ch(TEXT));
    await invoke(ch(TEXT, T1));
    await invoke(ch(TEXT), "emp_comm2");
    const events = (await listAuditEvents(DEMO_ORG.id, 100)).filter((e) => String(e.action).startsWith("comm_reply."));
    const haystack = JSON.stringify(events) + JSON.stringify(demoCommReplySendsForTests());
    for (const piece of BODY_PIECES) expect(haystack.includes(piece)).toBe(false);
  });
});

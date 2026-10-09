/**
 * Thread single-flight (木村 10/9 A, 八坂 GO; triage #2: 稲盛 got two opposite
 * replies in one thread from two concurrent jobs). THREAD_SINGLE_FLIGHT_ENABLED
 * (default OFF):
 *  - one send per thread at a time (lease with TTL): the loser gets
 *    409 thread_busy (retryable, retryAfterSeconds, nextStep)
 *  - right before sending: if this employee already posted in the thread after
 *    the point the AI read through (readThroughTs, else the inbound ts) →
 *    409 thread_moved_on (not retryable as is: re-read first); the same job's
 *    own earlier post does not count
 *  - approval sends: the same check at fulfil, against the approved snapshot
 *  - lease released on every path; lease-store errors fail closed (503)
 *  - another org's lease / posts never interfere; flag OFF = unchanged
 *  - coexists with COMM_REPLY_DEDUP_ENABLED / DUPLICATE_GUARD_V2_ENABLED
 * Demo mode, dummy ids / tokens, Slack fetch recorded, no network.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { DEMO_ORG, getRuntimeEmployees } from "@/lib/demo-data";
import { linkAgent } from "@/lib/data/bindings";
import { runGatewayInvoke } from "@/lib/gateway/invoke";
import { fulfillIfApproved } from "@/lib/approvals/fulfill";
import { getApprovalById, listAuditEvents, resolveApproval } from "@/lib/data";
import { upsertConversationAdapter } from "@/lib/data/conversation-adapters";
import { upsertOrgChannel, upsertOrgParty } from "@/lib/data/directory";
import { demoCommReplySendsForTests, resetDemoCommReplySends } from "@/lib/data/comm-reply-sends";
import { setCommReplyDedupClockForTests } from "@/lib/comm-reply-dedup/config";
import { setThreadGuardClockForTests } from "@/lib/thread-guard/config";
import { threadKeyFor } from "@/lib/thread-guard/guard";
import {
  __resetThreadGuardStoreForTests,
  __setThreadGuardStoreFailureForTests,
  acquireThreadLease,
  recordSelfPost,
  releaseThreadLease,
} from "@/lib/thread-guard/store";
import { callStaffpassMcpTool } from "@/lib/mcp/tools";
import type { ResolvedEmployeeCredential } from "@/lib/auth/employee-credential";
import type { GatewayInvokeRequest } from "@/lib/types";

const CHANNEL = "C0THREADSF01";
const DM = "D0THREADSF01";
const THREAD = "1791200000.000100";
const LINE_USER = "U1234567890abcdef1234567890thrsf1";
const OTHER_ORG = "00000000-0000-4000-8000-0000000bb0b1";
const A_TEXT = "その件は来週の定例で決めましょう。資料は私の方で準備しておきます。";
const B_TEXT = "その件は今日中に決めてしまいましょう。資料は不要です。";
const C_TEXT = "補足です。定例は木曜10時からです。会議室はいつもの場所です。";

const originalFetch = globalThis.fetch;
let posts: Array<{ channel?: string; text?: string; thread_ts?: string }> = [];
let slackMode: "ok" | "channel_not_found" | "timeout" = "ok";
let postDelayMs = 0;
let seq = 0;
const nowS = () => Math.floor(Date.now() / 1000);
function recordSlack() {
  posts = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("chat.postMessage")) {
      if (postDelayMs) await new Promise((r) => setTimeout(r, postDelayMs));
      if (slackMode === "timeout") throw new DOMException("The operation timed out.", "TimeoutError");
      if (slackMode === "channel_not_found") return Response.json({ ok: false, error: "channel_not_found" });
      const payload = JSON.parse(String(init?.body || "{}"));
      posts.push(payload);
      seq += 1;
      return Response.json({ ok: true, channel: payload.channel, ts: `${nowS()}.${String(seq).padStart(6, "0")}` });
    }
    if (url.includes("conversations.info")) return Response.json({ ok: true, channel: { is_ext_shared: false } });
    if (url.includes("reactions.add")) return Response.json({ ok: true });
    return Response.json({ ok: false, error: "unexpected_fetch" });
  }) as typeof fetch;
}

const ENV = ["THREAD_SINGLE_FLIGHT_ENABLED", "THREAD_SINGLE_FLIGHT_LEASE_TTL_SECONDS", "COMM_REPLY_DEDUP_ENABLED", "DUPLICATE_GUARD_V2_ENABLED"];
const envBackup = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
const on = () => {
  process.env.THREAD_SINGLE_FLIGHT_ENABLED = "true";
};
const off = () => {
  delete process.env.THREAD_SINGLE_FLIGHT_ENABLED;
};

beforeAll(async () => {
  for (const id of [CHANNEL, DM]) {
    await upsertOrgChannel({ orgId: DEMO_ORG.id, surface: "slack", externalId: id, classification: "internal", mixed: false, skipInspect: true });
  }
  await upsertOrgParty({ orgId: DEMO_ORG.id, kind: "line", identifier: LINE_USER, audience: "internal" });
  await upsertConversationAdapter({ orgId: DEMO_ORG.id, surface: "slack", enabled: true, secrets: { botToken: "xoxb-thread-sf-test" } });
  const comm = getRuntimeEmployees().find((e) => e.id === "emp_comm")!;
  if (!getRuntimeEmployees().some((e) => e.id === "emp_comm2")) {
    getRuntimeEmployees().push({ ...comm, id: "emp_comm2", displayName: "社内連絡AI社員2", credentialId: "cred_comm2" });
  }
  await linkAgent("emp_comm2", { orgId: DEMO_ORG.id, grokBotAgentId: "agent_thread_sf_comm2" });
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  slackMode = "ok";
  postDelayMs = 0;
  for (const k of ENV) {
    if (envBackup[k] === undefined) delete process.env[k];
    else process.env[k] = envBackup[k];
  }
  setThreadGuardClockForTests(null);
  setCommReplyDedupClockForTests(null);
  __setThreadGuardStoreFailureForTests(null);
  __resetThreadGuardStoreForTests();
  resetDemoCommReplySends();
});
afterAll(async () => {
  await upsertConversationAdapter({ orgId: DEMO_ORG.id, surface: "slack", enabled: false, secrets: {} }).catch(() => undefined);
});

const jid = (s = "j") => `job_thread_sf_${s}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const old = () => `${nowS() - 600}.000001`;
const fresh = () => `${nowS() + 1}.999999`;
function threadReply(text: string, extra: { readThroughTs?: string; jobId?: string; inboundTs?: string } = {}): GatewayInvokeRequest {
  return {
    tool: "comm.reply",
    purpose: "comm.internal",
    jobId: extra.jobId ?? jid(),
    conversation: {
      surface: "slack",
      orgId: DEMO_ORG.id,
      slackChannelId: CHANNEL,
      threadId: THREAD,
      ...(extra.inboundTs ? { ts: extra.inboundTs } : {}),
    } as GatewayInvokeRequest["conversation"],
    args: { text, ...(extra.readThroughTs ? { readThroughTs: extra.readThroughTs } : {}) },
  } as GatewayInvokeRequest;
}
function dm(tool: "comm.reply" | "comm.send", text: string, readThroughTs?: string, jobId = jid(tool)): GatewayInvokeRequest {
  return {
    tool,
    purpose: "comm.internal",
    jobId,
    conversation: { surface: "slack", orgId: DEMO_ORG.id, slackChannelId: DM, speakerId: "U_YAMADA" } as GatewayInvokeRequest["conversation"],
    args: { text, ...(readThroughTs ? { readThroughTs } : {}) },
  } as GatewayInvokeRequest;
}
const invoke = (b: GatewayInvokeRequest, employeeId = "emp_comm") =>
  runGatewayInvoke({ employeeId, credentialId: employeeId === "emp_comm" ? "cred_comm" : `cred_${employeeId.slice(4)}`, body: b });
const threadKey = (orgId = DEMO_ORG.id, channel = CHANNEL, threadId: string | undefined = THREAD) =>
  threadKeyFor({ orgId, surface: "slack", slackChannelId: channel, threadId })!;

describe("flag OFF: unchanged", () => {
  test("two concurrent replies to one thread both go out; a moved-on reply goes out; the store is never touched", async () => {
    off();
    recordSlack();
    postDelayMs = 30;
    __setThreadGuardStoreFailureForTests("acquire");
    const [a, b] = await Promise.all([invoke(threadReply(A_TEXT)), invoke(threadReply(B_TEXT))]);
    expect([a.httpStatus, b.httpStatus]).toEqual([200, 200]);
    const c = await invoke(threadReply(C_TEXT, { readThroughTs: old() }));
    expect(c.httpStatus).toBe(200);
    expect(posts.length).toBe(3);
    for (const r of [a, b, c]) expect(String(r.body.code ?? "")).not.toMatch(/^thread_/);
  });
});

describe("race: single-flight lease", () => {
  test("two concurrent replies (opposite content) to one thread → exactly one posted, the other 409 thread_busy", async () => {
    on();
    recordSlack();
    postDelayMs = 40;
    const [a, b] = await Promise.all([invoke(threadReply(A_TEXT)), invoke(threadReply(B_TEXT))]);
    const statuses = [a.httpStatus, b.httpStatus].sort();
    expect(statuses).toEqual([200, 409]);
    const loser = a.httpStatus === 409 ? a : b;
    expect(loser.body.code).toBe("thread_busy");
    expect(loser.body.reasonCode).toBe("thread_busy");
    expect(loser.body.retryable).toBe(true);
    expect(loser.body.nextAction).toBe("retry_later");
    expect(Number(loser.body.retryAfterSeconds)).toBeGreaterThanOrEqual(1);
    expect(String(loser.body.nextStep)).toMatch(/re-read the thread/i);
    expect(posts.length).toBe(1);
    const events = await listAuditEvents(DEMO_ORG.id, 50);
    expect(events.some((e) => e.action === "thread_guard.busy" && e.metadata?.jobId === loser.body.jobId)).toBe(true);
  });

  test("8 concurrent replies by two employees → exactly one posted", async () => {
    on();
    recordSlack();
    postDelayMs = 40;
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => invoke(threadReply(`${A_TEXT} (${i})`), i % 2 ? "emp_comm2" : "emp_comm"))
    );
    expect(results.filter((r) => r.httpStatus === 200).length).toBe(1);
    expect(results.filter((r) => r.body.code === "thread_busy").length).toBe(7);
    expect(posts.length).toBe(1);
  });

  test("a different thread in the same channel is not blocked", async () => {
    on();
    recordSlack();
    postDelayMs = 40;
    const other = threadReply(B_TEXT);
    (other.conversation as Record<string, unknown>).threadId = "1791200000.000200";
    const [a, b] = await Promise.all([invoke(threadReply(A_TEXT)), invoke(other)]);
    expect([a.httpStatus, b.httpStatus]).toEqual([200, 200]);
  });
});

describe("thread_moved_on", () => {
  test("self posted after readThroughTs → 409 thread_moved_on, nothing posted; reading through that post → allowed", async () => {
    on();
    recordSlack();
    const first = await invoke(threadReply(A_TEXT, { readThroughTs: old() }));
    expect(first.httpStatus).toBe(200);
    const firstTs = String((first.body.conversationDelivery as { ts?: string } | undefined)?.ts ?? "");
    expect(firstTs).toMatch(/^\d+\.\d{6}$/);
    const stale = await invoke(threadReply(B_TEXT, { readThroughTs: old() }));
    expect(stale.httpStatus).toBe(409);
    expect(stale.body.code).toBe("thread_moved_on");
    expect(stale.body.retryable).toBe(false);
    expect(stale.body.nextAction).toBe("reread_thread");
    expect(String(stale.body.nextStep)).toMatch(/readThroughTs/);
    expect(stale.body.postedBy).toBe("self");
    expect(stale.body.aiPostedTs).toBe(firstTs);
    expect(stale.body.selfPostedTs).toBeUndefined();
    expect(posts.length).toBe(1);
    const events = await listAuditEvents(DEMO_ORG.id, 50);
    expect(events.some((e) => e.action === "thread_guard.moved_on" && e.metadata?.jobId === stale.body.jobId)).toBe(true);

    const caughtUp = await invoke(threadReply(B_TEXT, { readThroughTs: String(stale.body.aiPostedTs) }));
    expect(caughtUp.httpStatus).toBe(200);
    expect(posts.length).toBe(2);
  });

  test("no explicit readThroughTs: the inbound ts the AI was woken by is used", async () => {
    on();
    recordSlack();
    expect((await invoke(threadReply(A_TEXT))).httpStatus).toBe(200);
    const woken = await invoke(threadReply(B_TEXT, { inboundTs: old() }));
    expect(woken.httpStatus).toBe(409);
    expect(woken.body.code).toBe("thread_moved_on");
  });

  test("no read point at all → lease only (allowed), audited with readPoint 'unknown' (木村 decision 1)", async () => {
    on();
    recordSlack();
    const a = await invoke(threadReply(A_TEXT));
    const b = await invoke(threadReply(B_TEXT));
    expect([a.httpStatus, b.httpStatus]).toEqual([200, 200]);
    const events = await listAuditEvents(DEMO_ORG.id, 80);
    for (const r of [a, b]) {
      const row = events.find((e) => e.action === "thread_guard.read_point_unknown" && e.metadata?.jobId === r.body.jobId);
      expect(row?.metadata?.readPoint).toBe("unknown");
      expect(row?.metadata?.phase).toBe("invoke");
      expect(String(row?.metadata?.threadKeyRef ?? "")).toMatch(/^[0-9a-f]{12}$/);
    }
    // a known read point writes no marker; stops carry readPoint too
    const known = await invoke(threadReply(C_TEXT, { readThroughTs: fresh() }));
    expect(known.httpStatus).toBe(200);
    const after = await listAuditEvents(DEMO_ORG.id, 80);
    expect(after.some((e) => e.action === "thread_guard.read_point_unknown" && e.metadata?.jobId === known.body.jobId)).toBe(false);
  });

  test("a stop without a read point is marked readPoint 'unknown' on its audit row", async () => {
    on();
    recordSlack();
    const held = await acquireThreadLease({ orgId: DEMO_ORG.id, employeeId: "emp_comm2", threadKey: threadKey(), ttlSeconds: 60 });
    const busy = await invoke(threadReply(A_TEXT));
    expect(busy.body.code).toBe("thread_busy");
    const events = await listAuditEvents(DEMO_ORG.id, 80);
    expect(events.find((e) => e.action === "thread_guard.busy" && e.metadata?.jobId === busy.body.jobId)?.metadata?.readPoint).toBe("unknown");
    if (held.state === "acquired") await releaseThreadLease({ orgId: DEMO_ORG.id, threadKey: threadKey(), leaseId: held.leaseId });
  });

  test("the same job's own earlier post does not count (multi-part reply)", async () => {
    on();
    recordSlack();
    const jobId = jid("multi");
    expect((await invoke(threadReply(A_TEXT, { readThroughTs: old(), jobId }))).httpStatus).toBe(200);
    expect((await invoke(threadReply(C_TEXT, { readThroughTs: old(), jobId }))).httpStatus).toBe(200);
    expect(posts.length).toBe(2);
  });

  test("a future readThroughTs cannot switch the check off", async () => {
    on();
    recordSlack();
    expect((await invoke(threadReply(A_TEXT))).httpStatus).toBe(200);
    const res = await invoke(threadReply(B_TEXT, { readThroughTs: `${nowS() + 86400}.000000`, inboundTs: old() }));
    expect(res.body.code).toBe("thread_moved_on");
  });

  test("another AI employee of the SAME org posted after my read point → thread_moved_on (木村 decision 4)", async () => {
    on();
    recordSlack();
    const other = await invoke(threadReply(A_TEXT), "emp_comm2");
    expect(other.httpStatus).toBe(200);
    const otherTs = String((other.body.conversationDelivery as { ts?: string } | undefined)?.ts ?? "");
    const mine = await invoke(threadReply(B_TEXT, { readThroughTs: old() }));
    expect(mine.httpStatus).toBe(409);
    expect(mine.body.code).toBe("thread_moved_on");
    expect(mine.body.postedBy).toBe("other_ai_employee");
    expect(mine.body.aiPostedTs).toBe(otherTs);
    expect(JSON.stringify(mine.body)).not.toContain("emp_comm2");
    expect(posts.length).toBe(1);
    // having read through that post, my reply goes out
    expect((await invoke(threadReply(B_TEXT, { readThroughTs: otherTs }))).httpStatus).toBe(200);
  });

  test("human posts do not count: a newer human message in the thread (never recorded) does not stop the reply", async () => {
    on();
    recordSlack();
    // woken by a fresh human message, read point explicitly older; no AI post after it
    const res = await invoke(threadReply(A_TEXT, { readThroughTs: old(), inboundTs: fresh() }));
    expect(res.httpStatus).toBe(200);
  });

  test("BOLA: another org's AI posts in a thread with the same ids never count", async () => {
    on();
    recordSlack();
    for (const key of [threadKey(OTHER_ORG), threadKey()]) {
      expect(await recordSelfPost({ orgId: OTHER_ORG, employeeId: "emp_other", threadKey: key, micros: BigInt(nowS() + 5) * BigInt(1_000_000), jobKey: null })).toBe(true);
    }
    expect((await invoke(threadReply(A_TEXT, { readThroughTs: old() }))).httpStatus).toBe(200);
  });

  test("LINE (caller-delivered): the allowed reply is recorded; a stale second reply is thread_moved_on", async () => {
    on();
    recordSlack();
    const line = (text: string, readThroughTs: string) =>
      ({
        tool: "comm.reply",
        purpose: "comm.internal",
        jobId: jid("line"),
        conversation: { surface: "line", orgId: DEMO_ORG.id, lineId: LINE_USER },
        args: { text, readThroughTs },
      }) as unknown as GatewayInvokeRequest;
    expect((await invoke(line(A_TEXT, old()))).httpStatus).toBe(200);
    const stale = await invoke(line(B_TEXT, old()));
    expect(stale.httpStatus).toBe(409);
    expect(stale.body.code).toBe("thread_moved_on");
    expect((await invoke(line(B_TEXT, fresh()))).httpStatus).toBe(200);
  });
});

describe("lease release on every path + expiry", () => {
  test("after success, a provider refusal, a moved_on stop and a dedup stop the thread is free again", async () => {
    on();
    process.env.COMM_REPLY_DEDUP_ENABLED = "true";
    recordSlack();
    expect((await invoke(threadReply(A_TEXT))).httpStatus).toBe(200);
    slackMode = "channel_not_found";
    expect((await invoke(threadReply(B_TEXT))).httpStatus).toBe(502);
    slackMode = "ok";
    expect((await invoke(threadReply(B_TEXT, { readThroughTs: old() }))).body.code).toBe("thread_moved_on");
    const dup = await invoke(threadReply(A_TEXT));
    expect(dup.body.code).toBe("duplicate_reply_suppressed");
    // Every stop above released the lease: a crashed holder would make this busy.
    const lease = await acquireThreadLease({ orgId: DEMO_ORG.id, employeeId: "emp_comm", threadKey: threadKey(), ttlSeconds: 30 });
    expect(lease.state).toBe("acquired");
    if (lease.state === "acquired") await releaseThreadLease({ orgId: DEMO_ORG.id, threadKey: threadKey(), leaseId: lease.leaseId });
    expect((await invoke(threadReply(C_TEXT))).httpStatus).toBe(200);
  });

  test("a held lease (crashed sender) blocks until its TTL passes, then the reply goes out", async () => {
    on();
    recordSlack();
    let now = Date.now();
    setThreadGuardClockForTests(() => now);
    const held = await acquireThreadLease({ orgId: DEMO_ORG.id, employeeId: "emp_comm2", threadKey: threadKey(), ttlSeconds: 60 });
    expect(held.state).toBe("acquired");
    const busy = await invoke(threadReply(A_TEXT));
    expect(busy.httpStatus).toBe(409);
    expect(busy.body.code).toBe("thread_busy");
    expect(busy.body.retryAfterSeconds).toBe(60);
    now += 61_000;
    expect((await invoke(threadReply(A_TEXT))).httpStatus).toBe(200);
    expect(posts.length).toBe(1);
  });

  test("v2 unknown outcome (timeout): lease released, no self post recorded", async () => {
    on();
    process.env.COMM_REPLY_DEDUP_ENABLED = "true";
    process.env.DUPLICATE_GUARD_V2_ENABLED = "true";
    recordSlack();
    slackMode = "timeout";
    expect((await invoke(threadReply(A_TEXT))).body.code).toBe("post_outcome_unknown");
    slackMode = "ok";
    expect((await invoke(threadReply(C_TEXT, { readThroughTs: old() }))).httpStatus).toBe(200);
  });
});

describe("fail closed on lease-store errors", () => {
  test("acquire error → 503 thread_guard_unavailable, nothing posted", async () => {
    on();
    recordSlack();
    __setThreadGuardStoreFailureForTests("acquire");
    const res = await invoke(threadReply(A_TEXT));
    expect(res.httpStatus).toBe(503);
    expect(res.body.code).toBe("thread_guard_unavailable");
    expect(res.body.retryable).toBe(true);
    expect(res.body.nextAction).toBe("retry_later");
    expect(typeof res.body.nextStep).toBe("string");
    expect(posts.length).toBe(0);
  });

  test("self-post read error → 503 and the lease is released", async () => {
    on();
    recordSlack();
    __setThreadGuardStoreFailureForTests("read");
    expect((await invoke(threadReply(A_TEXT, { readThroughTs: old() }))).httpStatus).toBe(503);
    __setThreadGuardStoreFailureForTests(null);
    expect((await invoke(threadReply(A_TEXT))).httpStatus).toBe(200);
  });
});

describe("BOLA: another org never interferes", () => {
  test("another org's lease on the same channel / thread ids does not block; its key differs", async () => {
    on();
    recordSlack();
    expect(threadKey(OTHER_ORG)).not.toBe(threadKey());
    const foreign = await acquireThreadLease({ orgId: OTHER_ORG, employeeId: "emp_other", threadKey: threadKey(OTHER_ORG), ttlSeconds: 60 });
    expect(foreign.state).toBe("acquired");
    // Even a lease planted under this org's key but another org id does not block.
    expect((await acquireThreadLease({ orgId: OTHER_ORG, employeeId: "emp_other", threadKey: threadKey(), ttlSeconds: 60 })).state).toBe("acquired");
    expect((await invoke(threadReply(A_TEXT))).httpStatus).toBe(200);
  });
});

describe("coexistence with the duplicate post guard (#260 / #278)", () => {
  test("v1 + v2 ON: concurrent identical replies → one post, no reserved ledger row left", async () => {
    on();
    process.env.COMM_REPLY_DEDUP_ENABLED = "true";
    process.env.DUPLICATE_GUARD_V2_ENABLED = "true";
    recordSlack();
    postDelayMs = 40;
    const [a, b] = await Promise.all([invoke(threadReply(A_TEXT)), invoke(threadReply(A_TEXT))]);
    expect(posts.length).toBe(1);
    const loser = a.httpStatus === 200 ? b : a;
    expect(["thread_busy", "duplicate_reply_suppressed"]).toContain(String(loser.body.code));
    expect(demoCommReplySendsForTests().map((r) => r.state)).toEqual(["sent"]);
  });
});

describe("approval sends: the same check at fulfil", () => {
  async function queue(readThroughTs?: string) {
    const res = await invoke(dm("comm.send", B_TEXT, readThroughTs));
    expect(res.httpStatus).toBe(402);
    return { approvalId: String(res.body.approvalId), body: dm("comm.send", B_TEXT, readThroughTs, String(res.body.jobId)) };
  }
  const approve = async (id: string, by = "slack:U_APPROVER") => {
    const approved = await resolveApproval(id, "approved", by, DEMO_ORG.id);
    return approved ? fulfillIfApproved(approved, "approved") : null;
  };

  test("AI posted after the approved read point → fulfil CLOSES the approval as superseded (stale), nothing sent, terminal (木村 decision 2)", async () => {
    on();
    recordSlack();
    const { approvalId, body } = await queue(old());
    expect((await invoke(dm("comm.reply", A_TEXT))).httpStatus).toBe(200);
    expect(posts.length).toBe(1);
    const result = await approve(approvalId);
    expect(result?.ok).toBe(false);
    expect(result?.error).toBe("thread_moved_on");
    expect(posts.length).toBe(1);
    const closed = await getApprovalById(approvalId, DEMO_ORG.id);
    expect(closed?.status).toBe("superseded");
    expect((closed?.metadata?.closedWithoutSend as Record<string, unknown> | undefined)?.reason).toBe("thread_moved_on");
    const events = await listAuditEvents(DEMO_ORG.id, 80);
    expect(events.some((e) => e.action === "approval.superseded" && e.metadata?.approvalId === approvalId && e.metadata?.reason === "thread_moved_on")).toBe(true);
    // Terminal: a re-run (even with a newer readThroughTs) sends nothing and opens no new approval.
    const rerun = await invoke({ ...body, approvalId, args: { ...(body.args as object), readThroughTs: fresh() } } as GatewayInvokeRequest);
    expect(rerun.httpStatus).toBe(409);
    expect(rerun.body.code).toBe("thread_moved_on");
    expect(rerun.body.approvalStatus).toBe("superseded");
    expect(rerun.body.retryable).toBe(false);
    expect(rerun.body.nextAction).toBe("reread_thread");
    expect(String(rerun.body.nextStep)).toMatch(/new request/i);
    expect(rerun.body.approvalId).toBe(approvalId);
    expect(rerun.body.needs_approval).toBe(false);
    expect(posts.length).toBe(1);
  });

  test("another AI employee's post after the approved read point also closes it at fulfil", async () => {
    on();
    recordSlack();
    const { approvalId } = await queue(old());
    expect((await invoke(dm("comm.reply", A_TEXT), "emp_comm2")).httpStatus).toBe(200);
    expect((await approve(approvalId))?.error).toBe("thread_moved_on");
    expect((await getApprovalById(approvalId, DEMO_ORG.id))?.status).toBe("superseded");
    expect(posts.length).toBe(1);
  });

  test("the approver and the AI see it was not sent because it went stale (status API + MCP status)", async () => {
    on();
    recordSlack();
    const res = await invoke(dm("comm.send", B_TEXT, old()));
    const approvalId = String(res.body.approvalId);
    const statusToken = String(res.body.statusToken);
    expect((await invoke(dm("comm.reply", A_TEXT))).httpStatus).toBe(200);
    await approve(approvalId);
    const { GET } = await import("@/app/api/approvals/status/route");
    const api = await (await GET(new Request(`http://localhost/api/approvals/status?id=${approvalId}&token=${statusToken}`) as never)).json();
    expect(api.status).toBe("superseded");
    expect(api.pollHint).toBe("abort_job");
    expect(api.closedWithoutSend?.reason).toBe("thread_moved_on");
    expect(String(api.closedWithoutSend?.messageJa)).toMatch(/送信していません/);
    const cred = { employeeId: "emp_comm", orgId: DEMO_ORG.id, credentialId: "cred_comm", generation: 1, fingerprint: "fixture", secretPrefix: "gb_emp_fixture", binding: null } as unknown as ResolvedEmployeeCredential;
    const mcp = (await callStaffpassMcpTool("staffpass_get_approval_status", { approvalId, statusToken }, cred)).structuredContent as Record<string, unknown>;
    expect(mcp.status).toBe("superseded");
    expect(mcp.pollHint).toBe("abort_job");
    expect((mcp.closedWithoutSend as Record<string, unknown>)?.reason).toBe("thread_moved_on");
    expect(String((mcp.closedWithoutSend as Record<string, unknown>)?.nextStep)).toMatch(/new request/i);
  });

  test("self-approval: no approval (whoever resolves it, incl. the requesting employee's own identity) skips the recheck; no request field disables it", async () => {
    on();
    recordSlack();
    // A request-side "skip" field does not exist: it is ignored.
    const res = await invoke({ ...dm("comm.send", B_TEXT, old()), threadGuard: { skip: true } } as unknown as GatewayInvokeRequest);
    expect(res.httpStatus).toBe(402);
    const approvalId = String(res.body.approvalId);
    expect((await invoke(dm("comm.reply", A_TEXT))).httpStatus).toBe(200);
    const result = await approve(approvalId, "agent:agent_comm_self");
    expect(result?.ok).toBe(false);
    expect(result?.error).toBe("thread_moved_on");
    expect((await getApprovalById(approvalId, DEMO_ORG.id))?.status).toBe("superseded");
    expect(posts.length).toBe(1);
    const events = await listAuditEvents(DEMO_ORG.id, 80);
    expect(events.some((e) => e.action === "thread_guard.moved_on" && e.metadata?.approvalId === approvalId && e.metadata?.phase === "fulfil")).toBe(true);
  });

  test("nothing newer → fulfil posts and records the post (a later stale direct reply is moved_on)", async () => {
    on();
    recordSlack();
    const { approvalId } = await queue(old());
    expect((await approve(approvalId))?.ok).toBe(true);
    expect(posts.length).toBe(1);
    expect((await invoke(dm("comm.reply", A_TEXT, old()))).body.code).toBe("thread_moved_on");
  });

  test("lease busy at fulfil → thread_busy, approval stays approved and re-runnable; after release it posts", async () => {
    on();
    recordSlack();
    const { approvalId, body } = await queue(old());
    const key = threadKey(DEMO_ORG.id, DM, undefined);
    const held = await acquireThreadLease({ orgId: DEMO_ORG.id, employeeId: "emp_comm2", threadKey: key, ttlSeconds: 60 });
    const result = await approve(approvalId);
    expect(result?.ok).toBe(false);
    expect(result?.error).toBe("thread_busy");
    expect((await getApprovalById(approvalId, DEMO_ORG.id))?.status).toBe("approved");
    if (held.state === "acquired") await releaseThreadLease({ orgId: DEMO_ORG.id, threadKey: key, leaseId: held.leaseId });
    const rerun = await invoke({ ...body, approvalId });
    expect(rerun.httpStatus).toBe(200);
    expect(posts.length).toBe(1);
  });

  test("flag OFF: an approval approved after a newer self post still posts (unchanged)", async () => {
    off();
    recordSlack();
    const { approvalId } = await queue(old());
    expect((await invoke(dm("comm.reply", A_TEXT))).httpStatus).toBe(200);
    expect((await approve(approvalId))?.ok).toBe(true);
    expect(posts.length).toBe(2);
  });
});

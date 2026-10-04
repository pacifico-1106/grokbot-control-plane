/**
 * COMM_REPLY_DEDUP_ENABLED (default OFF): the same employee sending the same
 * (normalized) body to the same conversation within the window is not sent;
 * the result is `duplicate_reply_suppressed` and an audit row with hashes only.
 * Channel-independent (comm.reply / comm.send / slack.post family; Slack, LINE,
 * Telegram keys). Demo mode, dummy values, Slack fetch recorded, no network.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { DEMO_ORG } from "@/lib/demo-data";
import { runGatewayInvoke } from "@/lib/gateway/invoke";
import { listAuditEvents } from "@/lib/data";
import { upsertConversationAdapter } from "@/lib/data/conversation-adapters";
import { upsertOrgChannel, upsertOrgParty } from "@/lib/data/directory";
import {
  claimCommReplySend,
  demoCommReplySendsForTests,
  resetDemoCommReplySends,
} from "@/lib/data/comm-reply-sends";
import { setCommReplyDedupClockForTests } from "@/lib/comm-reply-dedup/config";
import { prepareCommReplyDedupFromBody } from "@/lib/comm-reply-dedup/guard";
import type { GatewayInvokeRequest } from "@/lib/types";

const FLAG = "COMM_REPLY_DEDUP_ENABLED";
const DM = "D0DEDUPDM01";
const CHANNEL = "C_INTERNAL";
const LINE_USER = "U1234567890abcdef1234567890dedup1";
const TEXT = "本日15時からの打ち合わせ資料をカレンダーに共有しました。ご確認よろしくお願いします。";
const TEXT_VARIANT = "本日 １５時から の打ち合わせ資料を、カレンダーに共有しました！ ご確認よろしくお願いします。";
const TEXT_REWRITTEN = "本日15時からの打ち合わせ資料をカレンダーで共有しました。お手すきの際にご確認よろしくお願いします。";
const BODY_PIECES = ["打ち合わせ資料", "カレンダー", "ご確認"];

const originalFetch = globalThis.fetch;
let posts: Array<{ channel?: string; text?: string; thread_ts?: string }> = [];
let now = Date.now();

function recordSlack() {
  posts = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.includes("chat.postMessage")) {
      const payload = JSON.parse(String(init?.body || "{}"));
      posts.push(payload);
      return Response.json({ ok: true, channel: payload.channel, ts: `1791104${String(posts.length).padStart(3, "0")}.000001` });
    }
    if (url.includes("conversations.info")) return Response.json({ ok: true, channel: { is_ext_shared: false } });
    return Response.json({ ok: false, error: "unexpected_fetch" });
  }) as typeof fetch;
}

const envKeys = [FLAG, "COMM_REPLY_DEDUP_MODE", "COMM_REPLY_DEDUP_WINDOW_MINUTES", "COMM_REPLY_DEDUP_SIMILARITY"];
const envBackup = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
function setFlag(on: boolean) {
  if (on) process.env[FLAG] = "true";
  else delete process.env[FLAG];
}

beforeAll(async () => {
  await upsertOrgChannel({ orgId: DEMO_ORG.id, surface: "slack", externalId: DM, classification: "internal", mixed: false, skipInspect: true });
  await upsertOrgParty({ orgId: DEMO_ORG.id, kind: "line", identifier: LINE_USER, audience: "internal" });
  await upsertConversationAdapter({ orgId: DEMO_ORG.id, surface: "slack", enabled: true, secrets: { botToken: "xoxb-dedup-test" } });
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const k of envKeys) {
    if (envBackup[k] === undefined) delete process.env[k];
    else process.env[k] = envBackup[k];
  }
  setCommReplyDedupClockForTests(null);
  resetDemoCommReplySends();
});
afterAll(async () => {
  await upsertConversationAdapter({ orgId: DEMO_ORG.id, surface: "slack", enabled: false, secrets: {} }).catch(() => undefined);
});

const jid = () => `job_dedup_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
function body(conversation: Record<string, unknown>, text = TEXT, tool = "comm.reply"): GatewayInvokeRequest {
  return {
    tool,
    purpose: "comm.internal",
    jobId: jid(),
    conversation: { orgId: DEMO_ORG.id, ...conversation } as GatewayInvokeRequest["conversation"],
    args: { text },
  } as GatewayInvokeRequest;
}
const dm = (text = TEXT, extra: Record<string, unknown> = {}) =>
  body({ surface: "slack", slackChannelId: DM, speakerId: "U_YAMADA", ...extra }, text);
const invoke = (b: GatewayInvokeRequest) => runGatewayInvoke({ employeeId: "emp_comm", credentialId: "cred_comm", body: b });

describe("flag OFF (default): unchanged", () => {
  test("two identical replies are both posted", async () => {
    setFlag(false);
    recordSlack();
    expect((await invoke(dm())).httpStatus).toBe(200);
    expect((await invoke(dm())).httpStatus).toBe(200);
    expect(posts.length).toBe(2);
  });
});

describe("flag ON: duplicate replies are suppressed", () => {
  test("same body (whitespace / width / punctuation variant) to the same DM → duplicate_reply_suppressed, posted once", async () => {
    setFlag(true);
    recordSlack();
    const first = await invoke(dm());
    expect(first.httpStatus).toBe(200);
    const second = await invoke(dm(TEXT_VARIANT));
    expect(second.httpStatus).toBe(409);
    expect(second.body.code).toBe("duplicate_reply_suppressed");
    expect(second.body.needs_approval).toBe(false);
    expect(posts.length).toBe(1);

    const events = await listAuditEvents(DEMO_ORG.id, 50);
    const audit = events.find((e) => e.action === "comm_reply.duplicate_suppressed" && e.metadata?.jobId === second.body.jobId);
    expect(audit).toBeTruthy();
    expect(audit?.metadata).toMatchObject({ tool: "comm.reply", code: "duplicate_reply_suppressed", match: "exact" });
    expect(String(audit?.metadata?.bodyHashPrefix)).toMatch(/^[0-9a-f]{12}$/);
    const json = JSON.stringify(audit);
    for (const piece of BODY_PIECES) expect(json.includes(piece)).toBe(false);
  });

  test("DM thread vs main flow: still the same conversation (suppressed)", async () => {
    setFlag(true);
    recordSlack();
    expect((await invoke(dm())).httpStatus).toBe(200);
    expect((await invoke(dm(TEXT, { threadId: "1791104000.000001" }))).body.code).toBe("duplicate_reply_suppressed");
    expect(posts.length).toBe(1);
  });

  test("channel: another thread is another conversation (posted)", async () => {
    setFlag(true);
    recordSlack();
    const ch = (thread: string) => body({ surface: "slack", slackChannelId: CHANNEL, threadId: thread });
    expect((await invoke(ch("1791104000.000001"))).httpStatus).toBe(200);
    expect((await invoke(ch("1791104000.000002"))).httpStatus).toBe(200);
    expect((await invoke(ch("1791104000.000001"))).body.code).toBe("duplicate_reply_suppressed");
    expect(posts.length).toBe(2);
  });

  test("across tools: comm.send/slack.post family shares the same conversation ledger", async () => {
    setFlag(true);
    recordSlack();
    expect((await invoke(body({ surface: "slack", slackChannelId: CHANNEL }, TEXT, "slack.post"))).httpStatus).toBe(200);
    expect((await invoke(body({ surface: "slack", slackChannelId: CHANNEL }, TEXT, "comm.reply"))).body.code).toBe("duplicate_reply_suppressed");
    expect(posts.length).toBe(1);
  });

  test("outside the window (default 30 min) the same body is sent again", async () => {
    setFlag(true);
    recordSlack();
    now = Date.now();
    setCommReplyDedupClockForTests(() => now);
    expect((await invoke(dm())).httpStatus).toBe(200);
    now += 29 * 60_000;
    expect((await invoke(dm())).body.code).toBe("duplicate_reply_suppressed");
    now += 2 * 60_000;
    expect((await invoke(dm())).httpStatus).toBe(200);
    expect(posts.length).toBe(2);
  });

  test("re-written body: suppressed in similar mode (default), sent in exact mode", async () => {
    setFlag(true);
    recordSlack();
    expect((await invoke(dm())).httpStatus).toBe(200);
    const similar = await invoke(dm(TEXT_REWRITTEN));
    expect(similar.body.code).toBe("duplicate_reply_suppressed");
    expect(similar.body.match).toBe("similar");
    resetDemoCommReplySends();
    process.env.COMM_REPLY_DEDUP_MODE = "exact";
    expect((await invoke(dm())).httpStatus).toBe(200);
    expect((await invoke(dm(TEXT_REWRITTEN))).httpStatus).toBe(200);
    expect(posts.length).toBe(3);
  });

  test("a failed Slack post does not count as sent (retry is not suppressed)", async () => {
    setFlag(true);
    posts = [];
    globalThis.fetch = (async (input) => {
      if (String(input).includes("chat.postMessage")) return Response.json({ ok: false, error: "channel_not_found" });
      if (String(input).includes("conversations.info")) return Response.json({ ok: true, channel: { is_ext_shared: false } });
      return Response.json({ ok: false });
    }) as typeof fetch;
    expect((await invoke(dm())).httpStatus).toBe(502);
    recordSlack();
    expect((await invoke(dm())).httpStatus).toBe(200);
    expect(posts.length).toBe(1);
  });
});

describe("channel-independent: LINE and Telegram", () => {
  test("LINE: second identical reply to the same LINE user is suppressed", async () => {
    setFlag(true);
    recordSlack();
    const line = () => body({ surface: "line", lineId: LINE_USER });
    expect((await invoke(line())).httpStatus).toBe(200);
    const again = await invoke(line());
    expect(again.httpStatus).toBe(409);
    expect(again.body.code).toBe("duplicate_reply_suppressed");
  });

  test("Telegram: the same guard gives a key and the ledger suppresses the repeat (gateway has no Telegram post yet)", async () => {
    setFlag(true);
    const tg = body({ surface: "telegram", telegramChatId: "123456789" });
    const prepared = prepareCommReplyDedupFromBody({ orgId: DEMO_ORG.id, employeeId: "emp_comm", body: tg, text: TEXT });
    expect(prepared.kind).toBe("ready");
    if (prepared.kind !== "ready") return;
    const claim = (p: typeof prepared) => claimCommReplySend({
      orgId: p.orgId, employeeId: p.employeeId, conversationKey: p.conversationKey,
      bodyHash: p.fingerprint.bodyHash, sketch: p.fingerprint.sketch, tool: "comm.reply",
      windowSeconds: p.settings.windowMinutes * 60, similarityThreshold: p.settings.similarityThreshold,
      retentionSeconds: 48 * 3600,
    });
    expect((await claim(prepared)).state).toBe("claimed");
    expect((await claim(prepared)).state).toBe("duplicate");
    // Same text to a Slack DM and a LINE user: different conversations.
    const slack = prepareCommReplyDedupFromBody({ orgId: DEMO_ORG.id, employeeId: "emp_comm", body: dm(), text: TEXT });
    const line = prepareCommReplyDedupFromBody({ orgId: DEMO_ORG.id, employeeId: "emp_comm", body: body({ surface: "line", lineId: LINE_USER }), text: TEXT });
    const keys = [prepared, slack, line].map((p) => (p.kind === "ready" ? p.conversationKey : null));
    expect(new Set(keys).size).toBe(3);
  });
});

describe("hash-only logging", () => {
  test("console output, audit rows and the ledger never contain the body", async () => {
    setFlag(true);
    recordSlack();
    const logged: string[] = [];
    const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
    for (const k of Object.keys(orig) as Array<keyof typeof orig>) {
      console[k] = (...args: unknown[]) => { logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")); };
    }
    try {
      await invoke(dm());
      await invoke(dm(TEXT_VARIANT));
      await invoke(dm(TEXT_REWRITTEN));
    } finally {
      Object.assign(console, orig);
    }
    const events = (await listAuditEvents(DEMO_ORG.id, 100)).filter((e) =>
      String(e.action).startsWith("comm_reply.")
    );
    expect(events.length).toBeGreaterThanOrEqual(2);
    const haystack = [logged.join("\n"), JSON.stringify(events), JSON.stringify(demoCommReplySendsForTests())].join("\n");
    for (const piece of BODY_PIECES) expect(haystack.includes(piece)).toBe(false);
  });
});

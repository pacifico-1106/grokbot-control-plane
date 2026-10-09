/**
 * 木村 2026-10-09 item 4 / R1 (#303): when the stored approval has
 * `metadata.topicGate.matchedTopics`, every approver card (Slack, Telegram,
 * LINE, Web via publicApproval) shows a 「検出された話題: …」 line —
 * REGARDLESS of APPROVAL_REASONS_ENABLED. The AI-facing payloads stay
 * category-only (pinned in lib/gateway/topic-gate-categories-only.test.ts).
 * Demo mode, dummy values, fetch mocked, no network.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY = "test-notification-key-0123456789abcdef-topics";

const reasons = await import("@/lib/approvals/approval-reasons");
const { publicApproval } = await import("@/lib/approvals/public");
const { buildApprovalTelegramMessage } = await import("@/lib/notify/telegram");
const { sendApprovalToSlackChannel } = await import("@/lib/notify/slack");
const { sendApprovalToLineChannel } = await import("@/lib/notify/line");
const { DEMO_ORG } = await import("@/lib/demo-data");
type ApprovalRequest = import("@/lib/types").ApprovalRequest;
type NotificationChannelRuntime = import("@/lib/data/notification-channels").NotificationChannelRuntime;

const cardDetectedTopicsLine = (reasons as unknown as Record<string, unknown>).cardDetectedTopicsLine as
  | ((metadata: unknown) => string | null)
  | undefined;
const LABEL = "検出された話題";
const FLAG = "APPROVAL_REASONS_ENABLED";

let savedFlag: string | undefined;
const originalFetch = globalThis.fetch;
beforeEach(() => { savedFlag = process.env[FLAG]; });
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (savedFlag === undefined) delete process.env[FLAG];
  else process.env[FLAG] = savedFlag;
});
const setFlag = (on: boolean) => { if (on) process.env[FLAG] = "true"; else delete process.env[FLAG]; };

let seq = 0;
function approval(metadata: Record<string, unknown>): ApprovalRequest {
  seq += 1;
  const now = new Date().toISOString();
  return {
    id: `apr_topics_${seq}_${Math.random().toString(36).slice(2, 8)}`,
    orgId: DEMO_ORG.id, employeeId: "emp_comm", credentialId: "cred_comm",
    title: "承認依頼（ダミー）", purpose: "comm.internal", summary: "要約（ダミー）",
    risk: "medium", status: "pending", tool: "comm.reply", jobId: "job_topics",
    revisionNote: null, revisionCount: 0, parentApprovalId: null,
    telegramRef: `tref_topics_${seq}`, telegramMessageId: null,
    metadata, createdAt: now, updatedAt: now,
  } as unknown as ApprovalRequest;
}
const WITH_TOPICS = () => approval({ topicGate: { matchedTopics: ["支払", "金額"], reason: "sensitive_topic" } });
const WITHOUT = () => approval({});

function channel(provider: "slack" | "line"): NotificationChannelRuntime {
  const now = new Date().toISOString();
  return {
    id: `nch_topics_${provider}`, orgId: DEMO_ORG.id, provider, label: provider, enabled: true, isDefault: true,
    config: provider === "slack" ? { channelId: "C_APPROVALS" } : { destinationId: "U_LINE_DEST" },
    webhookRef: "ref_topics", hasCredentials: true, webhookPath: "/x", createdAt: now, updatedAt: now,
    secrets: provider === "slack" ? { botToken: "xoxb-topics-test" } : { channelAccessToken: "line-topics-test" },
  } as NotificationChannelRuntime;
}
async function slackText(a: ApprovalRequest): Promise<string> {
  let payload: { blocks?: Array<{ text?: { text?: string } }> } = {};
  globalThis.fetch = (async (_i: unknown, init?: RequestInit) => {
    payload = JSON.parse(String(init?.body ?? "{}"));
    return Response.json({ ok: true, ts: "1787911800.000020", channel: "C_APPROVALS" });
  }) as typeof fetch;
  expect((await sendApprovalToSlackChannel(a, null, channel("slack"))).ok).toBe(true);
  return (payload.blocks || []).map((b) => b.text?.text || "").join("\n");
}
async function lineTexts(a: ApprovalRequest): Promise<string[]> {
  let payload: Record<string, unknown> = {};
  globalThis.fetch = (async (_i: unknown, init?: RequestInit) => {
    payload = JSON.parse(String(init?.body ?? "{}"));
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  expect((await sendApprovalToLineChannel(a, null, channel("line"))).ok).toBe(true);
  const texts: string[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") {
      const rec = v as Record<string, unknown>;
      if (rec.type === "text" && typeof rec.text === "string") texts.push(rec.text);
      Object.values(rec).forEach(walk);
    }
  };
  walk(payload);
  return texts;
}

describe("cardDetectedTopicsLine (not flag-gated)", () => {
  for (const on of [false, true]) {
    test(`APPROVAL_REASONS_ENABLED ${on ? "ON" : "OFF"} → 「検出された話題: 支払, 金額」`, () => {
      setFlag(on);
      expect(typeof cardDetectedTopicsLine).toBe("function");
      expect(cardDetectedTopicsLine!(WITH_TOPICS().metadata)).toBe(`${LABEL}: 支払, 金額`);
    });
  }
  test("no topicGate / empty / non-string topics → null", () => {
    expect(typeof cardDetectedTopicsLine).toBe("function");
    expect(cardDetectedTopicsLine!({})).toBeNull();
    expect(cardDetectedTopicsLine!(null)).toBeNull();
    expect(cardDetectedTopicsLine!({ topicGate: { matchedTopics: [] } })).toBeNull();
    expect(cardDetectedTopicsLine!({ topicGate: { matchedTopics: [1, null, "  "] } })).toBeNull();
    expect(cardDetectedTopicsLine!({ topicGate: { matchedTopics: "支払" } })).toBeNull();
  });
  test("one line, control / bidi chars removed, bounded length", () => {
    expect(typeof cardDetectedTopicsLine).toBe("function");
    const many = Array.from({ length: 30 }, (_, i) => `長い話題${i}`.repeat(10));
    const line = cardDetectedTopicsLine!({ topicGate: { matchedTopics: ["支\n払\u202E\u200B", ...many] } })!;
    expect(line.startsWith(`${LABEL}: 支 払`)).toBe(true);
    expect(line).not.toMatch(/[\n\r\u202E\u200B]/);
    expect(Array.from(line).length).toBeLessThanOrEqual(reasons.APPROVAL_REASONS_CARD_MAX_CHARS);
  });
});

describe("every approver surface shows the line, flag OFF and ON", () => {
  for (const on of [false, true]) {
    const tag = on ? "ON" : "OFF";
    test(`Slack (${tag})`, async () => {
      setFlag(on);
      expect(await slackText(WITH_TOPICS())).toContain(`${LABEL}: 支払, 金額`);
    });
    test(`Telegram (${tag})`, () => {
      setFlag(on);
      expect(buildApprovalTelegramMessage(WITH_TOPICS(), null)).toContain(`${LABEL}: 支払, 金額`);
    });
    test(`LINE (${tag})`, async () => {
      setFlag(on);
      expect((await lineTexts(WITH_TOPICS())).some((t) => t === `${LABEL}: 支払, 金額`)).toBe(true);
    });
    test(`Web publicApproval.cardTopics (${tag})`, () => {
      setFlag(on);
      const dto = publicApproval(WITH_TOPICS()) as unknown as Record<string, unknown>;
      expect(dto.cardTopics).toBe(`${LABEL}: 支払, 金額`);
    });
  }
  test("Web components render cardTopics (approvals list + admin proxy panel)", () => {
    for (const file of ["components/ApprovalsClient.tsx", "components/admin/ProxyApprovalPanel.tsx"]) {
      expect(readFileSync(file, "utf8")).toContain("cardTopics");
    }
  });
  test("surface escaping: Slack mrkdwn / Telegram HTML cannot be injected through a topic", async () => {
    const evil = approval({ topicGate: { matchedTopics: ["<!channel> *承認済み* <b>x</b> &"] } });
    const slack = await slackText(evil);
    const line = slack.split("\n").find((l) => l.includes(LABEL)) || "";
    expect(line).toContain(LABEL);
    expect(line).not.toContain("<!channel>");
    expect(line).not.toContain("*承認済み*");
    const tg = buildApprovalTelegramMessage(evil, null).split("\n").find((l) => l.includes(LABEL)) || "";
    expect(tg).toContain(LABEL);
    expect(tg).not.toContain("<b>");
    expect(tg).toContain("&lt;b&gt;");
  });
  test("no topicGate → no line on any surface (no regression)", async () => {
    setFlag(false);
    expect(await slackText(WITHOUT())).not.toContain(LABEL);
    expect(buildApprovalTelegramMessage(WITHOUT(), null)).not.toContain(LABEL);
    expect((await lineTexts(WITHOUT())).some((t) => t.includes(LABEL))).toBe(false);
    expect((publicApproval(WITHOUT()) as unknown as Record<string, unknown>).cardTopics ?? null).toBeNull();
  });
});

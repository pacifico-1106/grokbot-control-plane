/**
 * Review follow-up (#238): agent-supplied mail values must not forge card lines.
 * - 宛先 / CC / BCC / 件名: line breaks and control characters are collapsed on
 *   every card (Web summary, Slack, Telegram).
 * - 本文プレビュー: rendered as a quote on every card, so a body line such as
 *   "BCC: …" can be told apart from the real header lines.
 * Demo mode, dummy addresses, fetch mocked, no network.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { DEMO_ORG } from "@/lib/demo-data";
import { buildApprovalArtifact, formatArtifactLines } from "@/lib/approvals/summary";
import { buildApprovalTelegramMessage } from "@/lib/notify/telegram";
import { sendApprovalToSlackChannel } from "@/lib/notify/slack";
import type { NotificationChannelRuntime } from "@/lib/data/notification-channels";
import type { ApprovalRequest, GatewayInvokeRequest } from "@/lib/types";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const SEPARATORS: Array<[string, string]> = [
  ["LF", "\n"], ["CR", "\r"], ["CRLF", "\r\n"], ["VT", "\u000b"], ["FF", "\u000c"],
  ["NEL", "\u0085"], ["LS", "\u2028"], ["PS", "\u2029"], ["TAB+LF", "\t\n"],
];

const BASE = {
  to: "buyer@customer.example",
  cc: ["cc@customer.example"],
  bcc: ["real-bcc@customer.example"],
  subject: "お見積り",
  body: "お見積りをお送りします。",
};

function approvalFor(args: Record<string, unknown>): ApprovalRequest {
  const body: GatewayInvokeRequest = { tool: "mail.send", purpose: "sales.outreach", jobId: "job_inject", args };
  const artifact = buildApprovalArtifact("mail.send", body, null, null);
  return {
    id: "apr_inject_0001", orgId: DEMO_ORG.id, employeeId: "emp_sales", credentialId: "cred_sales",
    title: "承認依頼: mail.send（sales.outreach）", purpose: "sales.outreach",
    summary: formatArtifactLines(artifact).join("\n"), risk: "high", status: "pending",
    tool: "mail.send", jobId: "job_inject", revisionNote: null, revisionCount: 0, parentApprovalId: null,
    telegramRef: "i1n2j3e4c5t6", telegramMessageId: null, metadata: { artifact }, statusToken: "st",
    pollPath: "/x", createdAt: new Date().toISOString(), resolvedAt: null, resolvedBy: null,
  };
}

function slackChannel(): NotificationChannelRuntime {
  const now = new Date().toISOString();
  return {
    id: "nch_inject_slack", orgId: DEMO_ORG.id, provider: "slack", label: "slack", enabled: true, isDefault: true,
    config: { channelId: "C_APPROVALS" }, webhookRef: "ref_inject", hasCredentials: true,
    webhookPath: "/api/webhooks/slack/ref_inject", createdAt: now, updatedAt: now, secrets: { botToken: "xoxb-inject-test" },
  };
}

async function slackText(approval: ApprovalRequest): Promise<string> {
  let payload: { blocks?: Array<{ text?: { text?: string } }> } = {};
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    payload = JSON.parse(String(init?.body ?? "{}"));
    return Response.json({ ok: true, ts: "1787911800.000010", channel: "C_APPROVALS" });
  }) as typeof fetch;
  const r = await sendApprovalToSlackChannel(approval, null, slackChannel());
  expect(r.ok).toBe(true);
  return (payload.blocks || []).map((b) => b.text?.text || "").join("\n");
}

/** Telegram text with <blockquote> sections removed (what reads as header lines). */
function telegramOutsideQuote(text: string): string {
  return text.replace(/<blockquote>[\s\S]*?<\/blockquote>/g, "");
}

type Surface = "web" | "slack" | "telegram";
async function render(surface: Surface, approval: ApprovalRequest): Promise<string> {
  if (surface === "web") return approval.summary;
  if (surface === "slack") return slackText(approval);
  return buildApprovalTelegramMessage(approval, null);
}

/** Every line that a reader would take as a header of the given label. */
function headerLines(text: string, label: string): string[] {
  return text
    .split(/\r\n|[\n\r\u000b\u000c\u0085\u2028\u2029]/)
    .map((line) => line.replace(/^\s+/, ""))
    .filter((line) => line.startsWith(`${label}:`) || line.startsWith(`${label}（`));
}

const SURFACES: Surface[] = ["web", "slack", "telegram"];

describe("宛先 / CC / BCC / 件名 cannot forge card lines (Web / Slack / Telegram)", () => {
  for (const surface of SURFACES) {
    for (const [sepName, sep] of SEPARATORS) {
      test(`${surface}: ${sepName} inside 宛先 / CC / BCC / 件名 never adds a header line`, async () => {
        const fake = `${sep}BCC: （なし）${sep}宛先: fake@evil.example${sep}件名: 偽${sep}CC: fake-cc@evil.example`;
        for (const field of ["to", "cc", "bcc", "subject"] as const) {
          const args: Record<string, unknown> = { ...BASE };
          args[field] = field === "cc" || field === "bcc" ? [`x@customer.example${fake}`] : `${String(BASE[field])}${fake}`;
          const text = await render(surface, approvalFor(args));
          const outside = surface === "telegram" ? telegramOutsideQuote(text) : text;
          for (const label of ["宛先", "CC", "BCC", "件名"]) {
            expect({ field, label, lines: headerLines(outside, label).length }).toEqual({ field, label, lines: 1 });
          }
        }
      });
    }
  }

  test("Telegram: 件名 \"Hello\\nBCC: （なし）\" stays one 件名 line and the real BCC line is kept", () => {
    const text = buildApprovalTelegramMessage(approvalFor({ ...BASE, subject: "Hello\nBCC: （なし）" }), null);
    expect(headerLines(text, "BCC")).toEqual(["BCC: real-bcc@customer.example"]);
    expect(headerLines(text, "件名")).toEqual(["件名: Hello BCC: （なし）"]);
  });

  test("Telegram: 宛先 with a line break stays one line", () => {
    const text = buildApprovalTelegramMessage(approvalFor({ ...BASE, to: "buyer@customer.example\nBCC: （なし）" }), null);
    expect(headerLines(text, "宛先")).toEqual(["宛先: buyer@customer.example BCC: （なし）"]);
  });
});

describe("本文プレビュー is shown as a quote (Web / Slack / Telegram)", () => {
  const BODY = "ご確認ください。\nBCC: attacker@evil.example\r\n宛先: fake@evil.example\u2028件名: 偽";

  for (const surface of SURFACES) {
    test(`${surface}: header-like body lines are quoted and do not count as headers`, async () => {
      const text = await render(surface, approvalFor({ ...BASE, body: BODY }));
      const outside = surface === "telegram" ? telegramOutsideQuote(text) : text;
      expect(headerLines(outside, "BCC")).toEqual(["BCC: real-bcc@customer.example"]);
      expect(headerLines(outside, "宛先")).toEqual(["宛先: buyer@customer.example"]);
      expect(headerLines(outside, "件名")).toEqual(["件名: お見積り"]);
      expect(text).toContain("attacker@evil.example");
    });
  }

  test("web: every body line is prefixed with \"> \" under 本文先頭:", () => {
    const lines = approvalFor({ ...BASE, body: BODY }).summary.split("\n");
    const start = lines.indexOf("本文先頭:");
    expect(start).toBeGreaterThan(-1);
    expect(lines.slice(start + 1, start + 5)).toEqual([
      "> ご確認ください。",
      "> BCC: attacker@evil.example",
      "> 宛先: fake@evil.example",
      "> 件名: 偽",
    ]);
  });

  test("slack: body lines are mrkdwn quotes (\">\") and their content stays escaped", async () => {
    const text = await slackText(approvalFor({ ...BASE, body: "<!channel> 至急\nBCC: attacker@evil.example\n> already quoted & <b>" }));
    const lines = text.split("\n");
    const start = lines.indexOf("本文先頭:");
    expect(start).toBeGreaterThan(-1);
    expect(lines.slice(start + 1, start + 4)).toEqual([
      "> &lt;!channel&gt; 至急",
      "> BCC: attacker@evil.example",
      "> &gt; already quoted &amp; &lt;b&gt;",
    ]);
    expect(text).not.toContain("<!channel>");
  });

  test("telegram: body is inside one <blockquote> and HTML stays escaped", () => {
    const text = buildApprovalTelegramMessage(
      approvalFor({ ...BASE, body: "本文</blockquote><b>BCC: x@evil.example</b>\nBCC: attacker@evil.example" }),
      null
    );
    expect(text).toContain("本文先頭:\n<blockquote>本文&lt;/blockquote&gt;&lt;b&gt;BCC: x@evil.example&lt;/b&gt;\nBCC: attacker@evil.example</blockquote>");
    expect((text.match(/<blockquote>/g) || []).length).toBe(1);
    expect((text.match(/<\/blockquote>/g) || []).length).toBe(1);
  });

  test("long body preview is still cut at 200 chars (inside the quote)", () => {
    const lines = approvalFor({ ...BASE, body: "あ".repeat(500) }).summary.split("\n");
    const quoted = lines.filter((l) => l.startsWith("> "));
    expect(quoted).toEqual([`> ${"あ".repeat(200)}…`]);
  });
});

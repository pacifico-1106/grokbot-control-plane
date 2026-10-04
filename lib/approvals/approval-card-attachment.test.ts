/**
 * 2026-10-04 (木村, #252 follow-up 1): the approval card shows the attachment the
 * approver is approving — filename and size from the snapshot
 * (`metadata.invoke.fileAttachment`) only — on every surface: stored summary
 * (Web dashboard), Slack, Telegram, LINE, the status poll, MCP
 * staffpass_get_approval_status and publicApproval. Never the sealed
 * reference, the reference URL / host or its hash. The filename is collapsed to
 * one line, stripped of bidi / zero-width controls, escaped per surface and capped.
 * No attachment → "添付ファイル: なし". Legacy snapshot (no field) → no line.
 * Demo mode, dummy values, fetch mocked, no network.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY = "test-notification-key-0123456789abcdef-card";

const { DEMO_ORG } = await import("@/lib/demo-data");
const { runGatewayInvoke } = await import("@/lib/gateway/invoke");
const { getApprovalById } = await import("@/lib/data");
const { updateApprovalMetadata } = await import("@/lib/data/approvals");
const { publicApproval } = await import("@/lib/approvals/public");
const { buildApprovalTelegramMessage } = await import("@/lib/notify/telegram");
const { sendApprovalToSlackChannel } = await import("@/lib/notify/slack");
const { sendApprovalToLineChannel } = await import("@/lib/notify/line");
const { GET: statusGET } = await import("@/app/api/approvals/status/route");
const { callStaffpassMcpTool } = await import("@/lib/mcp/tools");
type ApprovalRequest = import("@/lib/types").ApprovalRequest;
type GatewayInvokeRequest = import("@/lib/types").GatewayInvokeRequest;
type NotificationChannelRuntime = import("@/lib/data/notification-channels").NotificationChannelRuntime;
type ResolvedEmployeeCredential = import("@/lib/auth/employee-credential").ResolvedEmployeeCredential;
type FileAttachment = NonNullable<GatewayInvokeRequest["fileAttachment"]>;

const REF = "https://example.com/approved.pdf?sig=SECRET_SIG_card";
const REF_SHA = createHash("sha256").update(REF).digest("hex");
const GOOD: FileAttachment = { fileRef: REF, filename: "見積書_2026.pdf", mimeType: "application/pdf", bytes: 123456 };
const LONG = "長い名前".repeat(40); // 160 chars, no ASCII run (secret detector)
const EVIL_NAME = `evil\n*承認済み* <!channel> \`x\` <https://evil.example|click> <b>bold</b> &amp; \u202Efdp.exe\u200B${LONG}.pdf`;
const EVIL: FileAttachment = { fileRef: REF, filename: EVIL_NAME, bytes: 2048 };

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const jid = () => `job_card_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
async function queue(fileAttachment?: FileAttachment, tool = "comm.reply") {
  const body: GatewayInvokeRequest = {
    tool, purpose: "comm.internal", jobId: jid(),
    conversation: { surface: "slack", orgId: DEMO_ORG.id, slackChannelId: "C_INTERNAL", threadId: "1787911797.502889" },
    informationClass: "confidential",
    args: { slackChannelId: "C_INTERNAL", text: "承認をお願いします（ダミー）", threadId: "1787911797.502889" },
    ...(fileAttachment ? { fileAttachment } : {}),
  };
  const r = await runGatewayInvoke({ employeeId: "emp_comm", credentialId: "cred_comm", body });
  expect(r.httpStatus).toBe(402);
  const approval = (await getApprovalById(String(r.body.approvalId), DEMO_ORG.id))!;
  return { approval, statusToken: String(r.body.statusToken) };
}

function channel(provider: "slack" | "line"): NotificationChannelRuntime {
  const now = new Date().toISOString();
  return {
    id: `nch_card_${provider}`, orgId: DEMO_ORG.id, provider, label: provider, enabled: true, isDefault: true,
    config: provider === "slack" ? { channelId: "C_APPROVALS" } : { destinationId: "U_LINE_DEST" },
    webhookRef: "ref_card", hasCredentials: true, webhookPath: "/x", createdAt: now, updatedAt: now,
    secrets: provider === "slack" ? { botToken: "xoxb-card-test" } : { channelAccessToken: "line-card-test" },
  } as NotificationChannelRuntime;
}
async function slackText(approval: ApprovalRequest): Promise<string> {
  let payload: { blocks?: Array<{ text?: { text?: string } }> } = {};
  globalThis.fetch = (async (_i: unknown, init?: RequestInit) => {
    payload = JSON.parse(String(init?.body ?? "{}"));
    return Response.json({ ok: true, ts: "1787911800.000010", channel: "C_APPROVALS" });
  }) as typeof fetch;
  expect((await sendApprovalToSlackChannel(approval, null, channel("slack"))).ok).toBe(true);
  return (payload.blocks || []).map((b) => b.text?.text || "").join("\n");
}
async function lineTexts(approval: ApprovalRequest): Promise<string[]> {
  let payload: Record<string, unknown> = {};
  globalThis.fetch = (async (_i: unknown, init?: RequestInit) => {
    payload = JSON.parse(String(init?.body ?? "{}"));
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  expect((await sendApprovalToLineChannel(approval, null, channel("line"))).ok).toBe(true);
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
const lines = (text: string, prefix: string) => text.split("\n").filter((l) => l.includes(prefix));
function mcpCred(): ResolvedEmployeeCredential {
  const now = new Date().toISOString();
  return {
    employeeId: "emp_comm", orgId: DEMO_ORG.id, credentialId: "cred_emp_comm", generation: 1,
    fingerprint: "fixture-hash", secretPrefix: "gb_emp_fixture",
    binding: { status: "linked", employeeId: "emp_comm", orgId: DEMO_ORG.id, credentialGeneration: 1,
      grokBotAgentId: "agent_test", grokBotWorkspaceId: null, credentialFingerprint: null, lastSuccessAt: null,
      lastError: null, wakeWebhookUrl: null, hasWakeWebhook: false, createdAt: now, updatedAt: now },
  } as ResolvedEmployeeCredential;
}
function noSecrets(text: string) {
  expect(text).not.toContain("SECRET_SIG_card");
  expect(text).not.toContain("example.com");
  expect(text).not.toContain(REF_SHA);
  expect(text).not.toMatch(/v1\.[A-Za-z0-9_-]{8,}\./); // sealed reference
}

describe("card shows the approved attachment (filename + size) on every surface", () => {
  test("stored summary (Web dashboard): one line before the body, nothing secret", async () => {
    const { approval } = await queue(GOOD);
    expect(lines(approval.summary, "添付ファイル:")).toEqual(["添付ファイル: 見積書_2026.pdf（120.6 KB）"]);
    const summaryLines = approval.summary.split("\n");
    expect(summaryLines.indexOf("添付ファイル: 見積書_2026.pdf（120.6 KB）")).toBeLessThan(summaryLines.indexOf("本文:"));
    noSecrets(approval.summary);
  });

  test("Slack: inline code, exactly once, nothing secret", async () => {
    const { approval } = await queue(GOOD);
    const text = await slackText(approval);
    expect(lines(text, "添付ファイル:")).toEqual(["添付ファイル: `見積書_2026.pdf`（120.6 KB）"]);
    noSecrets(text);
  });

  test("Telegram: <code>, exactly once, nothing secret", async () => {
    const { approval } = await queue(GOOD);
    const text = buildApprovalTelegramMessage(approval, null);
    expect(lines(text, "添付ファイル:")).toEqual(["添付ファイル: <code>見積書_2026.pdf</code>（120.6 KB）"]);
    noSecrets(text);
  });

  test("LINE: its own text row, exactly once, nothing secret", async () => {
    const { approval } = await queue(GOOD);
    const texts = await lineTexts(approval);
    expect(texts).toContain("添付ファイル: 見積書_2026.pdf（120.6 KB）");
    expect(texts.join("\n").split("添付ファイル:").length - 1).toBe(1);
    noSecrets(texts.join("\n"));
  });

  test("publicApproval keeps filename/size but drops sealed ref, ref host and hashes", async () => {
    const { approval } = await queue(GOOD);
    const pub = JSON.stringify(publicApproval(approval));
    expect(pub).toContain("見積書_2026.pdf");
    expect(pub).toContain("123456");
    noSecrets(pub);
    expect(pub).not.toContain("refHost");
    expect(pub).not.toContain("refSha256");
    expect(pub).not.toContain("fileRefCiphertext");
  });

  test("status poll and MCP staffpass_get_approval_status return attachment {filename, bytes}", async () => {
    const { approval, statusToken } = await queue(GOOD);
    const res = await statusGET(new Request(`http://localhost/api/approvals/status?id=${approval.id}&token=${statusToken}`));
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.attachment).toEqual({ filename: "見積書_2026.pdf", bytes: 123456, sizeLabel: "120.6 KB" });
    noSecrets(JSON.stringify(body));
    const mcp = await callStaffpassMcpTool("staffpass_get_approval_status", { approvalId: approval.id, statusToken }, mcpCred());
    const out = mcp.structuredContent as Record<string, unknown>;
    expect(out.attachment).toEqual({ filename: "見積書_2026.pdf", bytes: 123456, sizeLabel: "120.6 KB" });
    noSecrets(JSON.stringify(out));
  });
});

describe("hostile filename: escaped per surface, one line, capped", () => {
  const SAFE_PREFIX = "evil *承認済み* <!channel> `x` <https://evil.example|click> <b>bold</b> &amp; fdp.exe";

  test("summary: control / bidi / zero-width removed, capped at 100 chars", async () => {
    const { approval } = await queue(EVIL);
    const [line] = lines(approval.summary, "添付ファイル:");
    const name = line.replace(/^添付ファイル: /, "").replace(/（2 KB）$/, "");
    expect(name.startsWith(SAFE_PREFIX)).toBe(true);
    expect(Array.from(name).length).toBe(100);
    expect(name.endsWith("…")).toBe(true);
    expect(line).not.toMatch(/[\u0000-\u001f\u202a-\u202e\u2066-\u2069\u200b-\u200f]/);
    expect(approval.summary).not.toContain("*承認済み* <!channel> `x` <https://evil.example|click> <b>bold</b> &amp; fdp.exe\n");
  });

  test("Slack: no raw <, no backtick break-out, no mention/link markup", async () => {
    const { approval } = await queue(EVIL);
    const [line, ...more] = lines(await slackText(approval), "添付ファイル:");
    expect(more).toEqual([]);
    expect(line).not.toContain("<");
    expect(line).toContain("&lt;!channel&gt;");
    expect(line).toContain("&amp;amp;");
    expect(line.split("`").length - 1).toBe(2); // only the delimiters
    expect(line).toMatch(/^添付ファイル: `[^`]+`（2 KB）$/);
  });

  test("Telegram: HTML escaped inside <code>", async () => {
    const { approval } = await queue(EVIL);
    const [line, ...more] = lines(buildApprovalTelegramMessage(approval, null), "添付ファイル:");
    expect(more).toEqual([]);
    expect(line).toMatch(/^添付ファイル: <code>[^<]+<\/code>（2 KB）$/);
    expect(line).toContain("&lt;b&gt;bold&lt;/b&gt;");
    expect(line).toContain("&amp;amp;");
  });
});

describe("no attachment / legacy", () => {
  test("approved without an attachment → 添付ファイル: なし on summary, Slack, Telegram, LINE; status attachment null", async () => {
    const { approval, statusToken } = await queue();
    expect(lines(approval.summary, "添付ファイル:")).toEqual(["添付ファイル: なし"]);
    expect(lines(await slackText(approval), "添付ファイル:")).toEqual(["添付ファイル: なし"]);
    expect(lines(buildApprovalTelegramMessage(approval, null), "添付ファイル:")).toEqual(["添付ファイル: なし"]);
    expect((await lineTexts(approval))).toContain("添付ファイル: なし");
    const res = await statusGET(new Request(`http://localhost/api/approvals/status?id=${approval.id}&token=${statusToken}`));
    expect(((await res.json()) as Record<string, unknown>).attachment).toBeNull();
  });

  test("legacy snapshot (no field): Slack / Telegram add no attachment line", async () => {
    const { approval } = await queue();
    const invoke = { ...(approval.metadata.invoke as Record<string, unknown>) };
    delete invoke.fileAttachment;
    const legacy = (await updateApprovalMetadata(approval, { invoke }))!;
    const plain = { ...legacy, summary: legacy.summary.split("\n").filter((l) => !l.startsWith("添付ファイル:")).join("\n") };
    expect(lines(await slackText(plain), "添付ファイル:")).toEqual([]);
    expect(lines(buildApprovalTelegramMessage(plain, null), "添付ファイル:")).toEqual([]);
  });

  test("non-conversation tool (mail.send) gets no conversation attachment line", async () => {
    const r = await runGatewayInvoke({ employeeId: "emp_comm", credentialId: "cred_comm", body: {
      tool: "mail.send", purpose: "comm.internal", jobId: jid(), args: { to: "a@example.org", subject: "s", body: "b" } } });
    if (r.httpStatus !== 402) return; // policy may deny mail.send for this fixture; nothing to render then
    const approval = (await getApprovalById(String(r.body.approvalId), DEMO_ORG.id))!;
    expect(lines(approval.summary, "添付ファイル:")).toEqual([]);
  });
});

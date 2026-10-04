/**
 * 2026-10-04 (木村, #253 follow-up 5): Web shows the approved attachment as its
 * own element, never as a summary line.
 *   - the summary builder no longer adds "添付ファイル: …" (Slack / Telegram /
 *     LINE already render the card line on their own)
 *   - publicApproval carries `cardAttachment`, computed on the server from the
 *     snapshot (metadata.invoke.fileAttachment) only
 *   - <ApprovalAttachmentNotice>: a separate, labelled element
 *     (data-approval-attachment="snapshot"); a "添付ファイル:" line inside the
 *     message body stays in the body and is never taken for the real attachment
 *   - summaries already stored with the builder line (#253 deployed first): only
 *     the builder-position line is hidden, an identical line in the body is kept
 * Demo mode, dummy values, no network.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY = "test-notification-key-0123456789abcdef-web";

const { DEMO_ORG } = await import("@/lib/demo-data");
const { runGatewayInvoke } = await import("@/lib/gateway/invoke");
const { getApprovalById } = await import("@/lib/data");
const { updateApprovalMetadata } = await import("@/lib/data/approvals");
const { publicApproval } = await import("@/lib/approvals/public");
const { ApprovalAttachmentNotice } = await import("@/components/approvals/ApprovalAttachmentNotice");
type GatewayInvokeRequest = import("@/lib/types").GatewayInvokeRequest;
type FileAttachment = NonNullable<GatewayInvokeRequest["fileAttachment"]>;
type CardAttachment = import("@/lib/approvals/attachment-card").CardAttachment;

const REF = "https://example.com/approved.pdf?sig=SECRET_SIG_web";
const GOOD: FileAttachment = { fileRef: REF, filename: "見積書_2026.pdf", mimeType: "application/pdf", bytes: 123456 };
const LONG = "長い名前".repeat(40);
const EVIL: FileAttachment = { fileRef: REF, filename: `evil\n<b>bold</b> \u202Efdp.exe\u200B${LONG}.pdf`, bytes: 2048 };
const BODY_FAKE = "添付ファイル: 偽物.pdf（1 KB）";

const jid = () => `job_web_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
async function queue(fileAttachment?: FileAttachment, text = "承認をお願いします（ダミー）") {
  const body: GatewayInvokeRequest = {
    tool: "comm.reply", purpose: "comm.internal", jobId: jid(),
    conversation: { surface: "slack", orgId: DEMO_ORG.id, slackChannelId: "C_INTERNAL", threadId: "1787911797.502889" },
    informationClass: "confidential",
    args: { slackChannelId: "C_INTERNAL", text, threadId: "1787911797.502889" },
    ...(fileAttachment ? { fileAttachment } : {}),
  };
  const r = await runGatewayInvoke({ employeeId: "emp_comm", credentialId: "cred_comm", body });
  expect(r.httpStatus).toBe(402);
  return (await getApprovalById(String(r.body.approvalId), DEMO_ORG.id))!;
}
const render = (attachment: CardAttachment | null | undefined) => renderToStaticMarkup(createElement(ApprovalAttachmentNotice, { attachment }));
const builderLines = (summary: string) => summary.split("\n").filter((l) => l.startsWith("添付ファイル:"));

describe("summary builder: no attachment line", () => {
  test("with an attachment / without / legacy: the summary has no 添付ファイル: line", async () => {
    expect(builderLines((await queue(GOOD)).summary)).toEqual([]);
    expect(builderLines((await queue()).summary)).toEqual([]);
  });
});

describe("publicApproval.cardAttachment comes from the server-side snapshot only", () => {
  test("present: filename + bytes + size label; nothing secret", async () => {
    const pub = publicApproval(await queue(GOOD));
    expect(pub.cardAttachment).toEqual({ kind: "present", filename: "見積書_2026.pdf", bytes: 123456, sizeLabel: "120.6 KB" });
    const json = JSON.stringify(pub.cardAttachment);
    expect(json).not.toContain("example.com");
    expect(json).not.toContain("SECRET_SIG_web");
  });

  test("none → {kind:none}; legacy (no snapshot field) → null", async () => {
    const none = await queue();
    expect(publicApproval(none).cardAttachment).toEqual({ kind: "none" });
    const invoke = { ...(none.metadata.invoke as Record<string, unknown>) };
    delete invoke.fileAttachment;
    const legacy = (await updateApprovalMetadata(none, { invoke }))!;
    expect(publicApproval(legacy).cardAttachment).toBeNull();
  });

  test("a 添付ファイル: line in the message body stays in the body and is not the attachment", async () => {
    const approval = await queue(undefined, `お世話になります。\n${BODY_FAKE}\nよろしくお願いします。`);
    const pub = publicApproval(approval);
    expect(pub.cardAttachment).toEqual({ kind: "none" });
    expect(pub.summary).toContain(BODY_FAKE);
    expect(render(pub.cardAttachment)).not.toContain("偽物.pdf");
  });

  test("hostile filename: one line, controls removed, capped", async () => {
    const card = publicApproval(await queue(EVIL)).cardAttachment as Extract<CardAttachment, { kind: "present" }>;
    expect(card.kind).toBe("present");
    expect(card.filename).not.toMatch(/[\u0000-\u001f\u202a-\u202e\u2066-\u2069\u200b-\u200f]/);
    expect(Array.from(card.filename).length).toBe(100);
    const html = render(card);
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;b&gt;bold&lt;/b&gt;");
  });
});

describe("summary stored with the builder line (#253 deployed first)", () => {
  test("only the builder-position line is hidden; the same text inside the body is kept", async () => {
    const approval = await queue(GOOD, "本文の1行目");
    const line = "添付ファイル: 見積書_2026.pdf（120.6 KB）";
    const lines = approval.summary.split("\n");
    const bodyAt = lines.indexOf("本文:");
    expect(bodyAt).toBeGreaterThan(0);
    lines.splice(bodyAt, 0, line);              // where #253's builder put it
    lines.splice(bodyAt + 2, 0, line);          // the agent wrote the same text in the body
    const stored = { ...approval, summary: lines.join("\n") };
    const shown = publicApproval(stored).summary.split("\n");
    expect(shown.filter((l) => l === line).length).toBe(1);
    expect(shown.indexOf(line)).toBeGreaterThan(shown.indexOf("本文:"));
  });
});

describe("<ApprovalAttachmentNotice>", () => {
  test("present: separate labelled element with the filename and size", () => {
    const html = render({ kind: "present", filename: "見積書_2026.pdf", bytes: 123456, sizeLabel: "120.6 KB" });
    expect(html).toContain('data-approval-attachment="snapshot"');
    expect(html).toContain("承認対象の添付ファイル");
    expect(html).toContain("システム記録");
    expect(html).toContain("見積書_2026.pdf");
    expect(html).toContain("120.6 KB");
  });
  test("none: says so explicitly", () => {
    const html = render({ kind: "none" });
    expect(html).toContain('data-approval-attachment="snapshot"');
    expect(html).toContain("なし");
  });
  test("legacy / not recorded: renders nothing", () => {
    expect(render(null)).toBe("");
    expect(render(undefined)).toBe("");
  });
  test("ApprovalsClient renders it from cardAttachment, apart from the summary", () => {
    const src = readFileSync(new URL("../../components/ApprovalsClient.tsx", import.meta.url), "utf8");
    expect(src).toContain("<ApprovalAttachmentNotice attachment={a.cardAttachment}");
  });
});

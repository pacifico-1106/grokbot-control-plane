import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { DEMO_ORG } from "@/lib/demo-data";
import { getApprovalById, resolveApproval } from "@/lib/data";
import { setOrgMailPolicy, resetDemoMailPolicy } from "@/lib/data/mail-policy";
import { normalizeMailPolicy } from "@/lib/mail-policy/validate";
import { runGatewayInvoke } from "@/lib/gateway/invoke";
import { fulfillApprovedInvoke, parseFulfillment, parseInvokeSnapshot } from "@/lib/approvals/fulfill";
import { buildSnapshotMailAttachments, openSnapshotMailAttachmentBytes } from "@/lib/approvals/snapshot-mail-attachments";
import { formatMailCardLines, readMailArtifact } from "@/lib/approvals/summary";
import { publicApproval } from "@/lib/approvals/public";
import { encryptBytes } from "@/lib/notify/crypto";
import { minimalPdf } from "./test-pdf";
import { contentDispositionAttachment } from "./mime";
import { STAFFPASS_MCP_TOOLS } from "@/lib/mcp/tools";

const KEY = "test-mail-attachment-encryption-key-32b";
let savedKey: string | undefined;

beforeEach(() => {
  savedKey = process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY;
  process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY = KEY;
});
afterEach(() => {
  if (savedKey === undefined) delete process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY;
  else process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY = savedKey;
  resetDemoMailPolicy();
});

async function withNeedsApproval<T>(fn: () => Promise<T>): Promise<T> {
  await setOrgMailPolicy(
    DEMO_ORG.id,
    normalizeMailPolicy({
      policyId: "mpp_mail_att",
      policyName: "Needs approval",
      rules: [{ id: "mpr_ext", audience: "external", sendMode: "needs_approval" }],
    })
  );
  return fn();
}

function pdfArgs(overrides: Record<string, unknown> = {}) {
  const pdf = minimalPdf("% Staffpass overview");
  return {
    assetRef: "kb/public-faq",
    to: "info@s-value.co.jp",
    from: "tando@tokyo307inc.com",
    subject: "Staffpass サービス概要",
    body: "PDF を添付します。",
    provider: "gmail",
    gmailThreadId: "1a13940ce0564833",
    inReplyTo: "<CA+thread@mail.gmail.com>",
    attachments: [
      {
        filename: "Staffpass_サービス概要.pdf",
        mimeType: "application/pdf",
        content: pdf.toString("base64"),
        bytes: pdf.length,
      },
    ],
    ...overrides,
  };
}

describe("snapshot mail attachments", () => {
  test("round-trips bytes and denies a hash mismatch", () => {
    const pdf = minimalPdf("approved-bytes");
    const sha = createHash("sha256").update(pdf).digest("hex");
    const sealed = buildSnapshotMailAttachments([
      {
        filename: "Staffpass_サービス概要.pdf",
        mimeType: "application/pdf",
        kind: "pdf",
        bytes: pdf.length,
        contentSha256: sha,
        buffer: pdf,
        source: "content",
      },
    ]);
    expect(sealed).toBeTruthy();
    const opened = openSnapshotMailAttachmentBytes(sealed![0]!);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.buffer.equals(pdf)).toBe(true);

    const tampered = { ...sealed![0]!, contentCiphertext: encryptBytes(Buffer.from("%PDF-1.4 TAMPER")) };
    const bad = openSnapshotMailAttachmentBytes(tampered);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe("mail_attachment_hash_mismatch");
  });
});

describe("mail.send invoke attachments + threading", () => {
  test("external default still demotes to draft (does not weaken draft_only)", async () => {
    resetDemoMailPolicy();
    const result = await runGatewayInvoke({
      employeeId: "emp_sales",
      credentialId: "cred_sales",
      body: { tool: "mail.send", purpose: "sales.outreach", jobId: `job_demote_${Date.now()}`, args: pdfArgs() },
    });
    expect(result.httpStatus).toBe(200);
    expect(result.body.code).toBe("mail_send_demoted_to_draft");
  });

  test("CRLF in inReplyTo is 400 mail_header_invalid", async () => {
    const result = await withNeedsApproval(() =>
      runGatewayInvoke({
        employeeId: "emp_sales",
        credentialId: "cred_sales",
        body: {
          tool: "mail.send",
          purpose: "sales.outreach",
          jobId: `job_hdr_${Date.now()}`,
          args: pdfArgs({ inReplyTo: "<ok@x.example>\r\nBcc: attacker@x.example>" }),
        },
      })
    );
    expect(result.httpStatus).toBe(400);
    expect(result.body.code).toBe("mail_header_invalid");
  });

  test("queues approval showing filename, type, size; fulfill hashes bytes", async () => {
    const jobId = `job_att_${Date.now()}`;
    const queued = await withNeedsApproval(() =>
      runGatewayInvoke({
        employeeId: "emp_sales",
        credentialId: "cred_sales",
        body: { tool: "mail.send", purpose: "sales.outreach", jobId, args: pdfArgs() },
      })
    );
    expect(queued.httpStatus).toBe(402);
    expect(queued.body.needs_approval).toBe(true);
    const approvalId = String(queued.body.approvalId || "");
    const stored = await getApprovalById(approvalId, DEMO_ORG.id);
    expect(stored).toBeTruthy();
    const artifact = readMailArtifact(stored!.metadata);
    expect(artifact?.attachments?.[0]?.filename).toBe("Staffpass_サービス概要.pdf");
    expect(artifact?.attachments?.[0]?.mimeType).toBe("application/pdf");
    expect(artifact?.gmailThreadId).toBe("1a13940ce0564833");
    const lines = formatMailCardLines(artifact!);
    expect(lines.some((l) => l.includes("Staffpass_サービス概要.pdf") && l.includes("application/pdf"))).toBe(true);
    expect(lines.some((l) => l.startsWith("threadId: 1a13940ce0564833"))).toBe(true);
    const pub = publicApproval(stored!);
    expect(JSON.stringify(pub.metadata)).not.toContain("contentCiphertext");
    expect(pub.cardAttachment?.kind).toBe("present");
    if (pub.cardAttachment?.kind === "present") {
      expect(pub.cardAttachment.filename).toBe("Staffpass_サービス概要.pdf");
      expect(pub.cardAttachment.mimeType).toBe("application/pdf");
    }

    const approved = await resolveApproval(approvalId, "approved", "ando@example.com", DEMO_ORG.id);
    const fulfillment = await withNeedsApproval(() => fulfillApprovedInvoke(approved!));
    expect(fulfillment?.ok).toBe(true);
    expect(fulfillment?.delivery).toBe("stub");
    expect(parseFulfillment(approved && (await getApprovalById(approvalId, DEMO_ORG.id))?.metadata)?.ok).toBe(true);

    const snap = parseInvokeSnapshot((await getApprovalById(approvalId, DEMO_ORG.id))!.metadata);
    expect(snap?.mailAttachments?.[0]?.contentSha256).toHaveLength(64);
  });

  test("secret in a txt attachment is blocked before approval", async () => {
    const txt = Buffer.from("gb_emp_0123456789abcdef_0123456789abcdef0123456789abcdef");
    const result = await withNeedsApproval(() =>
      runGatewayInvoke({
        employeeId: "emp_sales",
        credentialId: "cred_sales",
        body: {
          tool: "mail.send",
          purpose: "sales.outreach",
          jobId: `job_sec_${Date.now()}`,
          args: pdfArgs({
            attachments: [{ filename: "keys.txt", mimeType: "text/plain", content: txt.toString("base64") }],
          }),
        },
      })
    );
    expect(result.httpStatus).toBe(400);
    expect(result.body.code).toBe("secret_detected_in_payload");
  });
});

describe("staffpass_invoke schema", () => {
  test("documents attachments[] reusing the fileAttachment shape plus content", () => {
    const invoke = STAFFPASS_MCP_TOOLS.find((t) => t.name === "staffpass_invoke");
    const props = invoke!.inputSchema.properties as Record<string, { type?: string; items?: { properties?: Record<string, unknown>; required?: string[] } }>;
    expect(props.attachments?.type).toBe("array");
    expect(props.attachments?.items?.required).toEqual(["filename"]);
    expect(props.attachments?.items?.properties?.content).toBeDefined();
    expect(props.attachments?.items?.properties?.fileRef).toBeDefined();
    expect((props.fileAttachment as { required: string[] }).required).toEqual(["fileRef", "filename"]);
  });
});

describe("gmail Content-Disposition", () => {
  test("uses RFC 2231 for the immediate-use filename", () => {
    const header = contentDispositionAttachment("Staffpass_サービス概要.pdf");
    expect(header.startsWith("attachment; ")).toBe(true);
    expect(header).toContain("filename*=UTF-8''");
  });
});

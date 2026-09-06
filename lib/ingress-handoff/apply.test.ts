import { describe, expect, test } from "bun:test";
import {
  applyBodyMode,
  applyAttachmentMode,
  applyIngressHandoffSync,
  buildWakeMetadata,
  type SlackAttachment,
} from "./apply";
import type { IngressHandoffRule } from "@/lib/types";

const DEFAULT_RULE: IngressHandoffRule = {
  id: "ihr_test",
  applyTo: "all",
  body: "full",
  attachment: "meta",
  attachmentApproval: "none",
  sealith: "off",
  audit: { jobId: true, sealithTransferId: false },
};

describe("applyBodyMode", () => {
  test("full mode preserves text", () => {
    const result = applyBodyMode("Hello, World!", "full");
    expect(result.text).toBe("Hello, World!");
    expect(result.truncated).toBe(false);
  });

  test("none mode returns empty string", () => {
    const result = applyBodyMode("Hello, World!", "none");
    expect(result.text).toBe("");
    expect(result.truncated).toBe(true);
  });

  test("none mode with empty text", () => {
    const result = applyBodyMode("", "none");
    expect(result.text).toBe("");
    expect(result.truncated).toBe(false);
  });

  test("prefix mode truncates long text", () => {
    const longText = "これは長いメッセージです。途中で切られます。";
    const result = applyBodyMode(longText, "prefix", 10);
    expect(result.text).toBe("これは長いメッセージ…");
    expect(result.truncated).toBe(true);
  });

  test("prefix mode preserves short text", () => {
    const shortText = "短い";
    const result = applyBodyMode(shortText, "prefix", 10);
    expect(result.text).toBe("短い");
    expect(result.truncated).toBe(false);
  });

  test("prefix mode with exact length", () => {
    const text = "1234567890";
    const result = applyBodyMode(text, "prefix", 10);
    expect(result.text).toBe("1234567890");
    expect(result.truncated).toBe(false);
  });

  test("prefix mode without prefixChars acts as full", () => {
    const text = "Hello, World!";
    const result = applyBodyMode(text, "prefix", undefined);
    expect(result.text).toBe("Hello, World!");
    expect(result.truncated).toBe(false);
  });
});

describe("applyAttachmentMode", () => {
  const attachments: SlackAttachment[] = [
    { id: "F1", name: "contract.pdf", mimetype: "application/pdf", size: 12345, url: "https://example.com/f1" },
    { id: "F2", name: "image.png", mimetype: "image/png", size: 5000, bytes: "base64data" },
  ];

  test("file mode preserves attachments", () => {
    const result = applyAttachmentMode(attachments, "file");
    expect(result.attachments).toEqual(attachments);
    expect(result.redacted).toBe(false);
    expect(result.removed).toBe(false);
  });

  test("meta mode strips bytes and url", () => {
    const result = applyAttachmentMode(attachments, "meta");
    expect(result.attachments).toHaveLength(2);
    expect(result.redacted).toBe(true);
    expect(result.removed).toBe(false);

    const first = result.attachments![0];
    expect(first.name).toBe("contract.pdf");
    expect(first.mimetype).toBe("application/pdf");
    expect(first.size).toBe(12345);
    expect("url" in first).toBe(false);
    expect((first as { redacted: boolean }).redacted).toBe(true);
  });

  test("none mode removes all attachments", () => {
    const result = applyAttachmentMode(attachments, "none");
    expect(result.attachments).toBeUndefined();
    expect(result.redacted).toBe(false);
    expect(result.removed).toBe(true);
  });

  test("handles undefined attachments", () => {
    const result = applyAttachmentMode(undefined, "file");
    expect(result.attachments).toBeUndefined();
    expect(result.redacted).toBe(false);
    expect(result.removed).toBe(false);
  });

  test("handles empty attachments array", () => {
    const result = applyAttachmentMode([], "file");
    expect(result.attachments).toBeUndefined();
    expect(result.redacted).toBe(false);
    expect(result.removed).toBe(false);
  });
});

describe("applyIngressHandoffSync", () => {
  const attachments: SlackAttachment[] = [
    { id: "F1", name: "file.pdf", mimetype: "application/pdf", size: 1000 },
  ];

  test("full body + file attachments", () => {
    const rule: IngressHandoffRule = { ...DEFAULT_RULE, body: "full", attachment: "file" };
    const result = applyIngressHandoffSync(rule, { text: "Hello", attachments });
    expect(result.text).toBe("Hello");
    expect(result.attachments).toEqual(attachments);
    expect(result.bodyMode).toBe("full");
    expect(result.attachmentMode).toBe("file");
    expect(result.sealithHandoff).toBe("off");
  });

  test("none body + none attachments", () => {
    const rule: IngressHandoffRule = { ...DEFAULT_RULE, body: "none", attachment: "none" };
    const result = applyIngressHandoffSync(rule, { text: "Secret", attachments });
    expect(result.text).toBe("");
    expect(result.attachments).toBeUndefined();
    expect(result.bodyTruncated).toBe(true);
    expect(result.attachmentsRemoved).toBe(true);
  });

  test("prefix body + meta attachments", () => {
    const rule: IngressHandoffRule = {
      ...DEFAULT_RULE,
      body: "prefix",
      bodyPrefixChars: 5,
      attachment: "meta",
    };
    const result = applyIngressHandoffSync(rule, { text: "Hello, World!", attachments });
    expect(result.text).toBe("Hello…");
    expect(result.bodyTruncated).toBe(true);
    expect(result.attachmentsRedacted).toBe(true);
    expect(result.attachments![0]).toMatchObject({
      id: "F1",
      name: "file.pdf",
      redacted: true,
    });
  });

  test("attachmentApproval=manager causes fail-closed (none mode)", () => {
    const rule: IngressHandoffRule = {
      ...DEFAULT_RULE,
      attachment: "file",
      attachmentApproval: "manager",
    };
    const result = applyIngressHandoffSync(rule, { text: "Hello", attachments });
    expect(result.attachments).toBeUndefined();
    expect(result.attachmentMode).toBe("none");
    expect(result.pendingManagerApproval).toBe(true);
  });

  test("attachmentApproval=manager with attachment=none does not flag pending", () => {
    const rule: IngressHandoffRule = {
      ...DEFAULT_RULE,
      attachment: "none",
      attachmentApproval: "manager",
    };
    const result = applyIngressHandoffSync(rule, { text: "Hello", attachments });
    expect(result.attachmentMode).toBe("none");
    expect(result.pendingManagerApproval).toBeUndefined();
  });

  test("attachmentApproval=manager with no attachments does not flag pending", () => {
    const rule: IngressHandoffRule = {
      ...DEFAULT_RULE,
      attachment: "file",
      attachmentApproval: "manager",
    };
    const result = applyIngressHandoffSync(rule, { text: "Hello" });
    expect(result.pendingManagerApproval).toBeUndefined();
  });

  test("sealith=required without transferId downgrades file to meta", () => {
    const rule: IngressHandoffRule = {
      ...DEFAULT_RULE,
      attachment: "file",
      sealith: "required",
    };
    const result = applyIngressHandoffSync(rule, { text: "Hello", attachments }, undefined);
    expect(result.attachmentMode).toBe("meta");
    expect(result.attachmentsRedacted).toBe(true);
    expect(result.sealithHandoff).toBe("required");
    expect(result.sealithTransferId).toBeUndefined();
  });

  test("sealith=required with transferId preserves file mode", () => {
    const rule: IngressHandoffRule = {
      ...DEFAULT_RULE,
      attachment: "file",
      sealith: "required",
    };
    const result = applyIngressHandoffSync(rule, { text: "Hello", attachments }, "stx_123");
    expect(result.attachmentMode).toBe("file");
    expect(result.attachments).toEqual(attachments);
    expect(result.sealithTransferId).toBe("stx_123");
  });

  test("sealith=suggest with no transferId keeps file mode", () => {
    const rule: IngressHandoffRule = {
      ...DEFAULT_RULE,
      attachment: "file",
      sealith: "suggest",
    };
    const result = applyIngressHandoffSync(rule, { text: "Hello", attachments }, undefined);
    expect(result.attachmentMode).toBe("file");
    expect(result.sealithHandoff).toBe("suggest");
  });

  test("sealith=off keeps file mode", () => {
    const rule: IngressHandoffRule = {
      ...DEFAULT_RULE,
      attachment: "file",
      sealith: "off",
    };
    const result = applyIngressHandoffSync(rule, { text: "Hello", attachments }, undefined);
    expect(result.attachmentMode).toBe("file");
    expect(result.sealithHandoff).toBe("off");
  });
});

describe("buildWakeMetadata", () => {
  test("builds metadata from rule and options", () => {
    const rule: IngressHandoffRule = {
      ...DEFAULT_RULE,
      body: "prefix",
      attachment: "meta",
      attachmentApproval: "manager",
      sealith: "suggest",
    };
    const meta = buildWakeMetadata(
      rule,
      { orgId: "org_1", jobId: "job_123", sealithTransferId: "stx_abc" },
      true,
      "test note"
    );
    expect(meta.jobId).toBe("job_123");
    expect(meta.sealithHandoff).toBe("suggest");
    expect(meta.sealithTransferId).toBe("stx_abc");
    expect(meta.bodyMode).toBe("prefix");
    expect(meta.attachmentMode).toBe("meta");
    expect(meta.attachmentApproval).toBe("manager");
    expect(meta.pendingManagerApproval).toBe(true);
    expect(meta.auditNote).toBe("test note");
  });

  test("handles missing optional fields", () => {
    const rule: IngressHandoffRule = { ...DEFAULT_RULE };
    const meta = buildWakeMetadata(rule, { orgId: "org_1" });
    expect(meta.jobId).toBeUndefined();
    expect(meta.sealithTransferId).toBeUndefined();
    expect(meta.pendingManagerApproval).toBeUndefined();
    expect(meta.auditNote).toBeUndefined();
  });
});

import { describe, expect, test } from "bun:test";
import {
  evaluateFileAttachmentEgress,
  uploadSlackFile,
  buildFileUploadAuditPayload,
  type SlackFileUploadResult,
} from "./slack-file-upload";
import { upsertConversationAdapter } from "@/lib/data/conversation-adapters";
import { DEMO_ORG } from "@/lib/demo-data";

describe("file attachment egress control", () => {
  test("internal audience with thread_ts allows file attachment", () => {
    const result = evaluateFileAttachmentEgress({
      audience: "internal",
      effectiveAudience: "internal",
      threadTs: "1787960001.111111",
      channel: "C_INTERNAL",
    });
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe("file_attachment_internal_allow");
  });

  test("external audience denies file attachment (fail-closed)", () => {
    const result = evaluateFileAttachmentEgress({
      audience: "external",
      effectiveAudience: "external",
      threadTs: "1787960001.111111",
      channel: "C_EXTERNAL",
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("file_attachment_external_denied");
    expect(result.messageJa).toContain("社外送信は許可されていません");
  });

  test("mixed audience (internal audience but external effective) denies file attachment", () => {
    const result = evaluateFileAttachmentEgress({
      audience: "internal",
      effectiveAudience: "external",
      threadTs: "1787960001.111111",
      channel: "C_SHARED",
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("file_attachment_external_denied");
  });

  test("unknown audience denies file attachment (fail-closed)", () => {
    const result = evaluateFileAttachmentEgress({
      audience: "unknown",
      effectiveAudience: "external",
      threadTs: "1787960001.111111",
      channel: "C_UNKNOWN",
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("file_attachment_unknown_audience_denied");
    expect(result.messageJa).toContain("宛先が未確認");
  });

  test("missing thread_ts denies file attachment", () => {
    const result = evaluateFileAttachmentEgress({
      audience: "internal",
      effectiveAudience: "internal",
      threadTs: "",
      channel: "C_INTERNAL",
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("file_attachment_thread_required");
    expect(result.messageJa).toContain("スレッド指定");
  });

  test("undefined thread_ts denies file attachment", () => {
    const result = evaluateFileAttachmentEgress({
      audience: "internal",
      effectiveAudience: "internal",
      threadTs: undefined,
      channel: "C_INTERNAL",
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("file_attachment_thread_required");
  });

  test("whitespace-only thread_ts denies file attachment", () => {
    const result = evaluateFileAttachmentEgress({
      audience: "internal",
      effectiveAudience: "internal",
      threadTs: "   ",
      channel: "C_INTERNAL",
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("file_attachment_thread_required");
  });
});

describe("uploadSlackFile validation", () => {
  test("missing bot token returns error", async () => {
    const result = await uploadSlackFile({
      orgId: DEMO_ORG.id,
      channel: "C_INTERNAL",
      threadTs: "1787960001.111111",
      fileRef: "temp://abc123",
      fileBuffer: Buffer.from("test"),
      filename: "test.pdf",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("slack_bot_token_missing");
    }
  });

  test("missing channel returns error", async () => {
    await upsertConversationAdapter({
      orgId: DEMO_ORG.id,
      surface: "slack",
      enabled: true,
      secrets: { botToken: "xoxb-validation-test" },
    });
    try {
      const result = await uploadSlackFile({
        orgId: DEMO_ORG.id,
        channel: "",
        threadTs: "1787960001.111111",
        fileRef: "temp://abc123",
        fileBuffer: Buffer.from("test"),
        filename: "test.pdf",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("channel_required");
      }
    } finally {
      await upsertConversationAdapter({
        orgId: DEMO_ORG.id,
        surface: "slack",
        enabled: false,
        secrets: {},
      });
    }
  });

  test("missing thread_ts returns error", async () => {
    await upsertConversationAdapter({
      orgId: DEMO_ORG.id,
      surface: "slack",
      enabled: true,
      secrets: { botToken: "xoxb-validation-test" },
    });
    try {
      const result = await uploadSlackFile({
        orgId: DEMO_ORG.id,
        channel: "C_INTERNAL",
        threadTs: "",
        fileRef: "temp://abc123",
        fileBuffer: Buffer.from("test"),
        filename: "test.pdf",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("thread_ts_required");
      }
    } finally {
      await upsertConversationAdapter({
        orgId: DEMO_ORG.id,
        surface: "slack",
        enabled: false,
        secrets: {},
      });
    }
  });

  test("missing filename returns error", async () => {
    await upsertConversationAdapter({
      orgId: DEMO_ORG.id,
      surface: "slack",
      enabled: true,
      secrets: { botToken: "xoxb-validation-test" },
    });
    try {
      const result = await uploadSlackFile({
        orgId: DEMO_ORG.id,
        channel: "C_INTERNAL",
        threadTs: "1787960001.111111",
        fileRef: "temp://abc123",
        fileBuffer: Buffer.from("test"),
        filename: "",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("filename_required");
      }
    } finally {
      await upsertConversationAdapter({
        orgId: DEMO_ORG.id,
        surface: "slack",
        enabled: false,
        secrets: {},
      });
    }
  });

  test("missing file source returns error", async () => {
    await upsertConversationAdapter({
      orgId: DEMO_ORG.id,
      surface: "slack",
      enabled: true,
      secrets: { botToken: "xoxb-validation-test" },
    });
    try {
      const result = await uploadSlackFile({
        orgId: DEMO_ORG.id,
        channel: "C_INTERNAL",
        threadTs: "1787960001.111111",
        fileRef: "temp://abc123",
        filename: "test.pdf",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("file_source_required");
      }
    } finally {
      await upsertConversationAdapter({
        orgId: DEMO_ORG.id,
        surface: "slack",
        enabled: false,
        secrets: {},
      });
    }
  });
});

describe("uploadSlackFile with mocked Slack API", () => {
  test("successful file upload flow", async () => {
    await upsertConversationAdapter({
      orgId: DEMO_ORG.id,
      surface: "slack",
      enabled: true,
      secrets: { botToken: "xoxb-file-upload-test" },
    });

    const originalFetch = globalThis.fetch;
    const apiCalls: Array<{ url: string; body?: unknown }> = [];

    try {
      globalThis.fetch = (async (input, init) => {
        const url = String(input);
        const body = init?.body
          ? typeof init.body === "string"
            ? init.body
            : init.body instanceof URLSearchParams
              ? Object.fromEntries(init.body)
              : init.body
          : undefined;
        apiCalls.push({ url, body });

        if (url.includes("files.getUploadURLExternal")) {
          return Response.json({
            ok: true,
            upload_url: "https://files.slack.com/upload/v1/ABC123",
            file_id: "F0123456789",
          });
        }
        if (url.includes("files.slack.com/upload")) {
          return new Response(null, { status: 200 });
        }
        if (url.includes("files.completeUploadExternal")) {
          return Response.json({
            ok: true,
            files: [{ id: "F0123456789", timestamp: "1787960002.222222" }],
          });
        }
        return Response.json({ ok: false, error: "unknown_endpoint" });
      }) as typeof fetch;

      const result = await uploadSlackFile({
        orgId: DEMO_ORG.id,
        channel: "C_INTERNAL",
        threadTs: "1787960001.111111",
        fileRef: "temp://abc123",
        fileBuffer: Buffer.from("%PDF-1.4 test content"),
        filename: "report.pdf",
        mimeType: "application/pdf",
        title: "Monthly Report",
        initialComment: "レポートを添付しました。",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.fileId).toBe("F0123456789");
        expect(result.filename).toBe("report.pdf");
        expect(result.bytes).toBe(21);
        expect(result.channel).toBe("C_INTERNAL");
        expect(result.threadTs).toBe("1787960001.111111");
        expect(result.ts).toBe("1787960002.222222");
      }

      expect(apiCalls.length).toBe(3);
      expect(apiCalls[0].url).toContain("files.getUploadURLExternal");
      expect(apiCalls[1].url).toContain("files.slack.com/upload");
      expect(apiCalls[2].url).toContain("files.completeUploadExternal");
    } finally {
      globalThis.fetch = originalFetch;
      await upsertConversationAdapter({
        orgId: DEMO_ORG.id,
        surface: "slack",
        enabled: false,
        secrets: {},
      });
    }
  });

  test("files:write scope error propagates", async () => {
    await upsertConversationAdapter({
      orgId: DEMO_ORG.id,
      surface: "slack",
      enabled: true,
      secrets: { botToken: "xoxb-missing-scope" },
    });

    const originalFetch = globalThis.fetch;

    try {
      globalThis.fetch = (async () => {
        return Response.json({
          ok: false,
          error: "missing_scope",
          needed: "files:write",
        });
      }) as typeof fetch;

      const result = await uploadSlackFile({
        orgId: DEMO_ORG.id,
        channel: "C_INTERNAL",
        threadTs: "1787960001.111111",
        fileRef: "temp://abc123",
        fileBuffer: Buffer.from("test"),
        filename: "test.pdf",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe("missing_scope");
        expect(result.code).toBe("get_upload_url_failed");
      }
    } finally {
      globalThis.fetch = originalFetch;
      await upsertConversationAdapter({
        orgId: DEMO_ORG.id,
        surface: "slack",
        enabled: false,
        secrets: {},
      });
    }
  });
});

describe("buildFileUploadAuditPayload", () => {
  test("builds correct audit payload", () => {
    const result: SlackFileUploadResult = {
      ok: true,
      fileId: "F0123456789",
      filename: "report.pdf",
      bytes: 12345,
      channel: "C_INTERNAL",
      threadTs: "1787960001.111111",
      ts: "1787960002.222222",
    };

    const payload = buildFileUploadAuditPayload(result, {
      jobId: "job_file_upload_123",
      audience: "internal",
      mimeType: "application/pdf",
      fileRef: "temp://abc123",
    });

    expect(payload.jobId).toBe("job_file_upload_123");
    expect(payload.channel).toBe("C_INTERNAL");
    expect(payload.threadTs).toBe("1787960001.111111");
    expect(payload.fileId).toBe("F0123456789");
    expect(payload.filename).toBe("report.pdf");
    expect(payload.bytes).toBe(12345);
    expect(payload.audience).toBe("internal");
    expect(payload.mimeType).toBe("application/pdf");
    expect(payload.fileRef).toBe("temp://abc123");
  });
});

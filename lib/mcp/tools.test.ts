// URL download policy has its own DNS/stream tests. These tests verify mapping
// and Slack API payloads using deterministic file bytes.
mock.module("@/lib/security/public-file-download", () => ({
  MAX_FILE_BYTES: 50 * 1024 * 1024,
  downloadPublicFile: async (url: string) => {
    if (!url.startsWith("https://example.com/")) throw new Error("unexpected_fixture_file");
    return Buffer.from("%PDF-1.4 test content");
  },
}));
import { describe, expect, test, mock } from "bun:test";
import { STAFFPASS_MCP_TOOLS, callStaffpassMcpTool } from "@/lib/mcp/tools";
import { DEMO_ORG, getRuntimeEmployees } from "@/lib/demo-data";
import { upsertConversationAdapter } from "@/lib/data/conversation-adapters";
import type { ResolvedEmployeeCredential } from "@/lib/auth/employee-credential";

function demoCred(employeeId = "emp_comm"): ResolvedEmployeeCredential {
  const employee = getRuntimeEmployees().find((e) => e.id === employeeId);
  return {
    employeeId,
    orgId: DEMO_ORG.id,
    credentialId: `cred_${employeeId}`,
    generation: 1,
    fingerprint: "fixture-hash",
    secretPrefix: "gb_emp_fixture",
    binding: {
      status: "linked",
      employeeId,
      orgId: DEMO_ORG.id,
      credentialGeneration: 1,
      grokBotAgentId: "agent_test",
      grokBotWorkspaceId: null,
      credentialFingerprint: null,
      lastSuccessAt: null,
      lastError: null,
      wakeWebhookUrl: null,
      hasWakeWebhook: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  };
}

describe("staffpass_invoke inputSchema fileAttachment", () => {
  test("inputSchema includes fileAttachment with correct properties", () => {
    const invokeTool = STAFFPASS_MCP_TOOLS.find((t) => t.name === "staffpass_invoke");
    expect(invokeTool).toBeDefined();

    const properties = invokeTool!.inputSchema.properties as Record<string, unknown>;
    expect(properties.fileAttachment).toBeDefined();

    const fileAttachment = properties.fileAttachment as {
      type: string;
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(fileAttachment.type).toBe("object");
    expect(fileAttachment.properties.fileRef).toBeDefined();
    expect(fileAttachment.properties.filename).toBeDefined();
    expect(fileAttachment.properties.mimeType).toBeDefined();
    expect(fileAttachment.properties.bytes).toBeDefined();
    expect(fileAttachment.properties.title).toBeDefined();
    expect(fileAttachment.properties.initialComment).toBeDefined();
    expect(fileAttachment.required).toEqual(["fileRef", "filename"]);
  });

  test("inputSchema still has additionalProperties: false", () => {
    const invokeTool = STAFFPASS_MCP_TOOLS.find((t) => t.name === "staffpass_invoke");
    expect(invokeTool!.inputSchema.additionalProperties).toBe(false);
  });
});

describe("staffpass_invoke fileAttachment mapping to Gateway", () => {
  test("top-level fileAttachment maps to Gateway body", async () => {
    await upsertConversationAdapter({
      orgId: DEMO_ORG.id,
      surface: "slack",
      enabled: true,
      secrets: { botToken: "xoxb-test" },
    });
    const originalFetch = globalThis.fetch;
    const apiCalls: Array<{ url: string }> = [];

    try {
      globalThis.fetch = (async (input) => {
        const url = String(input);
        apiCalls.push({ url });

        if (url.includes("chat.postMessage")) {
          return Response.json({
            ok: true,
            channel: "C_INTERNAL",
            ts: "1787960001.111111",
          });
        }
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

      const result = await callStaffpassMcpTool(
        "staffpass_invoke",
        {
          tool: "comm.reply",
          purpose: "comm.internal",
          jobId: `job_mcp_file_${Date.now()}`,
          conversation: {
            surface: "slack",
            orgId: DEMO_ORG.id,
            slackChannelId: "C_INTERNAL",
            threadId: "1787960001.111111",
          },
          payload: {
            slackChannelId: "C_INTERNAL",
            text: "レポートを添付しました。",
            threadId: "1787960001.111111",
          },
          fileAttachment: {
            fileRef: "https://example.com/report.pdf",
            filename: "report.pdf",
            mimeType: "application/pdf",
            title: "月次レポート",
          },
        },
        demoCred()
      );

      const data = result.structuredContent as Record<string, unknown>;
      expect(data.ok).toBe(true);
      const resultObj = data.result as { fileUpload?: { ok: boolean; fileId?: string } } | undefined;
      expect(resultObj?.fileUpload?.ok).toBe(true);
      expect(resultObj?.fileUpload?.fileId).toBe("F0123456789");
      expect(apiCalls.some((c) => c.url.includes("files.getUploadURLExternal"))).toBe(true);
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

  test("fileAttachment in payload falls back to Gateway body", async () => {
    await upsertConversationAdapter({
      orgId: DEMO_ORG.id,
      surface: "slack",
      enabled: true,
      secrets: { botToken: "xoxb-test" },
    });
    const originalFetch = globalThis.fetch;
    const apiCalls: Array<{ url: string }> = [];

    try {
      globalThis.fetch = (async (input) => {
        const url = String(input);
        apiCalls.push({ url });

        if (url.includes("chat.postMessage")) {
          return Response.json({
            ok: true,
            channel: "C_INTERNAL",
            ts: "1787960001.111111",
          });
        }
        if (url.includes("files.getUploadURLExternal")) {
          return Response.json({
            ok: true,
            upload_url: "https://files.slack.com/upload/v1/ABC123",
            file_id: "F_PAYLOAD_FALLBACK",
          });
        }
        if (url.includes("files.slack.com/upload")) {
          return new Response(null, { status: 200 });
        }
        if (url.includes("files.completeUploadExternal")) {
          return Response.json({
            ok: true,
            files: [{ id: "F_PAYLOAD_FALLBACK", timestamp: "1787960002.222222" }],
          });
        }
        return Response.json({ ok: false, error: "unknown_endpoint" });
      }) as typeof fetch;

      const result = await callStaffpassMcpTool(
        "staffpass_invoke",
        {
          tool: "comm.reply",
          purpose: "comm.internal",
          jobId: `job_mcp_payload_file_${Date.now()}`,
          conversation: {
            surface: "slack",
            orgId: DEMO_ORG.id,
            slackChannelId: "C_INTERNAL",
            threadId: "1787960001.111111",
          },
          payload: {
            slackChannelId: "C_INTERNAL",
            text: "レポートを添付しました（payload経由）。",
            threadId: "1787960001.111111",
            fileAttachment: {
              fileRef: "https://example.com/payload-report.pdf",
              filename: "payload-report.pdf",
              mimeType: "application/pdf",
            },
          },
        },
        demoCred()
      );

      const data = result.structuredContent as Record<string, unknown>;
      expect(data.ok).toBe(true);
      const resultObj = data.result as { fileUpload?: { ok: boolean; fileId?: string } } | undefined;
      expect(resultObj?.fileUpload?.ok).toBe(true);
      expect(resultObj?.fileUpload?.fileId).toBe("F_PAYLOAD_FALLBACK");
      expect(apiCalls.some((c) => c.url.includes("files.getUploadURLExternal"))).toBe(true);
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

  test("top-level fileAttachment takes precedence over payload.fileAttachment", async () => {
    await upsertConversationAdapter({
      orgId: DEMO_ORG.id,
      surface: "slack",
      enabled: true,
      secrets: { botToken: "xoxb-test" },
    });
    const originalFetch = globalThis.fetch;
    let capturedFilename = "";

    try {
      globalThis.fetch = (async (input, init) => {
        const url = String(input);

        if (url.includes("chat.postMessage")) {
          return Response.json({
            ok: true,
            channel: "C_INTERNAL",
            ts: "1787960001.111111",
          });
        }
        if (url.includes("files.getUploadURLExternal")) {
          const body = init?.body;
          if (body instanceof URLSearchParams) {
            capturedFilename = body.get("filename") || "";
          }
          return Response.json({
            ok: true,
            upload_url: "https://files.slack.com/upload/v1/ABC123",
            file_id: "F_PRECEDENCE",
          });
        }
        if (url.includes("files.slack.com/upload")) {
          return new Response(null, { status: 200 });
        }
        if (url.includes("files.completeUploadExternal")) {
          return Response.json({
            ok: true,
            files: [{ id: "F_PRECEDENCE", timestamp: "1787960002.222222" }],
          });
        }
        return Response.json({ ok: false, error: "unknown_endpoint" });
      }) as typeof fetch;

      const result = await callStaffpassMcpTool(
        "staffpass_invoke",
        {
          tool: "comm.reply",
          purpose: "comm.internal",
          jobId: `job_mcp_precedence_${Date.now()}`,
          conversation: {
            surface: "slack",
            orgId: DEMO_ORG.id,
            slackChannelId: "C_INTERNAL",
            threadId: "1787960001.111111",
          },
          fileAttachment: {
            fileRef: "https://example.com/top-level.pdf",
            filename: "top-level.pdf",
            mimeType: "application/pdf",
          },
          payload: {
            slackChannelId: "C_INTERNAL",
            text: "両方でファイル添付を指定",
            threadId: "1787960001.111111",
            fileAttachment: {
              fileRef: "https://example.com/payload-level.pdf",
              filename: "payload-level.pdf",
              mimeType: "application/pdf",
            },
          },
        },
        demoCred()
      );

      const data = result.structuredContent as Record<string, unknown>;
      expect(data.ok).toBe(true);
      expect(capturedFilename).toBe("top-level.pdf");
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

  test("missing fileRef or filename does not pass fileAttachment to Gateway", async () => {
    const result = await callStaffpassMcpTool(
      "staffpass_invoke",
      {
        tool: "comm.reply",
        purpose: "comm.internal",
        jobId: `job_mcp_invalid_file_${Date.now()}`,
        conversation: {
          surface: "slack",
          orgId: DEMO_ORG.id,
          slackChannelId: "C_INTERNAL",
          threadId: "1787960001.111111",
        },
        fileAttachment: {
          fileRef: "",
          filename: "missing-ref.pdf",
        },
        payload: {
          slackChannelId: "C_INTERNAL",
          text: "fileRefがない",
          threadId: "1787960001.111111",
        },
      },
      demoCred()
    );

    const data = result.structuredContent as Record<string, unknown>;
    expect(data.ok).toBe(true);
    const resultObj = data.result as { fileUpload?: unknown } | undefined;
    expect(resultObj?.fileUpload).toBeUndefined();
  });

  test("fileAttachment with all optional fields passes them to Gateway", async () => {
    await upsertConversationAdapter({
      orgId: DEMO_ORG.id,
      surface: "slack",
      enabled: true,
      secrets: { botToken: "xoxb-test" },
    });
    const originalFetch = globalThis.fetch;
    let capturedTitle = "";

    try {
      globalThis.fetch = (async (input, init) => {
        const url = String(input);

        if (url.includes("chat.postMessage")) {
          return Response.json({
            ok: true,
            channel: "C_INTERNAL",
            ts: "1787960001.111111",
          });
        }
        if (url.includes("files.getUploadURLExternal")) {
          return Response.json({
            ok: true,
            upload_url: "https://files.slack.com/upload/v1/ABC123",
            file_id: "F_FULL_OPTS",
          });
        }
        if (url.includes("files.slack.com/upload")) {
          return new Response(null, { status: 200 });
        }
        if (url.includes("files.completeUploadExternal")) {
          const body = init?.body;
          if (body && typeof body === "string") {
            const parsed = JSON.parse(body) as { files?: Array<{ id?: string; title?: string }> };
            capturedTitle = parsed.files?.[0]?.title || "";
          }
          return Response.json({
            ok: true,
            files: [{ id: "F_FULL_OPTS", timestamp: "1787960002.222222" }],
          });
        }
        return Response.json({ ok: false, error: "unknown_endpoint" });
      }) as typeof fetch;

      const result = await callStaffpassMcpTool(
        "staffpass_invoke",
        {
          tool: "comm.reply",
          purpose: "comm.internal",
          jobId: `job_mcp_full_opts_${Date.now()}`,
          conversation: {
            surface: "slack",
            orgId: DEMO_ORG.id,
            slackChannelId: "C_INTERNAL",
            threadId: "1787960001.111111",
          },
          payload: {
            slackChannelId: "C_INTERNAL",
            text: "全オプション付き",
            threadId: "1787960001.111111",
          },
          fileAttachment: {
            fileRef: "https://example.com/full-opts.pdf",
            filename: "full-opts.pdf",
            mimeType: "application/pdf",
            bytes: 12345,
            title: "カスタムタイトル",
            initialComment: "添付ファイルです。",
          },
        },
        demoCred()
      );

      const data = result.structuredContent as Record<string, unknown>;
      expect(data.ok).toBe(true);
      expect(capturedTitle).toBe("カスタムタイトル");
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

  test("fileAttachment to external channel is denied by egress", async () => {
    const result = await callStaffpassMcpTool(
      "staffpass_invoke",
      {
        tool: "comm.reply",
        purpose: "comm.internal",
        jobId: `job_mcp_external_file_${Date.now()}`,
        conversation: {
          surface: "slack",
          orgId: DEMO_ORG.id,
          slackChannelId: "C_SHARED",
          threadId: "1787960001.111111",
        },
        payload: {
          slackChannelId: "C_SHARED",
          text: "社外チャネルへのファイル添付",
          threadId: "1787960001.111111",
        },
        fileAttachment: {
          fileRef: "https://example.com/external.pdf",
          filename: "external.pdf",
        },
      },
      demoCred()
    );

    const data = result.structuredContent as Record<string, unknown>;
    expect(data.ok).toBe(false);
    expect(data.code).toBe("egress_denied");
  });
});

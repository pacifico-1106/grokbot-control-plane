import { describe, expect, test } from "bun:test";
import { probeSlackFilesWrite } from "@/lib/slack/files-write-probe";

describe("probeSlackFilesWrite", () => {
  test("returns no_token when token is empty", async () => {
    const result = await probeSlackFilesWrite("");
    expect(result.ready).toBe(false);
    expect(result.code).toBe("no_token");
  });

  test("detects missing_scope from Slack API", async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () =>
        Response.json({
          ok: false,
          error: "missing_scope",
          needed: "files:write",
        })) as typeof fetch;

      const result = await probeSlackFilesWrite("xoxb-test");
      expect(result.ready).toBe(false);
      expect(result.code).toBe("missing_scope");
      expect(result.needed).toBe("files:write");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("detects ok when upload URL is returned", async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () =>
        Response.json({
          ok: true,
          upload_url: "https://files.slack.com/upload/v1/abc",
          file_id: "F123",
        })) as typeof fetch;

      const result = await probeSlackFilesWrite("xoxb-test");
      expect(result.ready).toBe(true);
      expect(result.code).toBe("ok");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

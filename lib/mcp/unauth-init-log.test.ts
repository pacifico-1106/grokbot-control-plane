import { afterEach, describe, expect, test } from "bun:test";
import {
  buildUnauthInitLogEntry,
  hasNoCredentialHeader,
  maybeLogUnauthInitialize,
  sanitizeLogField,
} from "@/lib/mcp/unauth-init-log";
import { POST } from "@/app/api/mcp/route";

const ORIGINAL = process.env.MCP_UNAUTH_INIT_LOG_ENABLED;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.MCP_UNAUTH_INIT_LOG_ENABLED;
  else process.env.MCP_UNAUTH_INIT_LOG_ENABLED = ORIGINAL;
});

function req(headers: Record<string, string> = {}) {
  return new Request("https://staffpass.example/api/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "claude-ai", version: "1.2.3" },
      },
    }),
  });
}

const PARAMS = {
  protocolVersion: "2025-06-18",
  clientInfo: { name: "claude-ai", version: "1.2.3" },
};

describe("unauth initialize log (Q4)", () => {
  test("flag OFF (default): logs nothing", () => {
    delete process.env.MCP_UNAUTH_INIT_LOG_ENABLED;
    const lines: string[] = [];
    maybeLogUnauthInitialize(req(), PARAMS, (l) => lines.push(l));
    expect(lines).toEqual([]);
  });

  test("flag ON + no credential: logs clientInfo + UA only", () => {
    process.env.MCP_UNAUTH_INIT_LOG_ENABLED = "true";
    const lines: string[] = [];
    maybeLogUnauthInitialize(
      req({ "user-agent": "Claude-User/1.0", "x-forwarded-for": "203.0.113.9", cookie: "sb=secret" }),
      PARAMS,
      (l) => lines.push(l)
    );
    expect(lines.length).toBe(1);
    const entry = JSON.parse(lines[0]);
    expect(entry).toEqual({
      event: "mcp.unauth_initialize",
      clientName: "claude-ai",
      clientVersion: "1.2.3",
      protocolVersion: "2025-06-18",
      userAgent: "Claude-User/1.0",
    });
    expect(lines[0]).not.toContain("203.0.113.9");
    expect(lines[0]).not.toContain("secret");
  });

  test("flag ON + Authorization present: logs nothing (and never the token)", () => {
    process.env.MCP_UNAUTH_INIT_LOG_ENABLED = "true";
    const lines: string[] = [];
    maybeLogUnauthInitialize(req({ authorization: "Bearer gb_emp_x_y" }), PARAMS, (l) => lines.push(l));
    maybeLogUnauthInitialize(req({ "x-staffpass-credential": "gb_emp_x_y" }), PARAMS, (l) => lines.push(l));
    expect(lines).toEqual([]);
  });

  test("blank Authorization counts as missing", () => {
    expect(hasNoCredentialHeader(req({ authorization: "   " }))).toBe(true);
    expect(hasNoCredentialHeader(req({ authorization: "Bearer a" }))).toBe(false);
  });

  test("sanitize: strips control chars, truncates, rejects non-strings", () => {
    expect(sanitizeLogField("a\nb\u0000c")).toBe("a b c");
    expect(sanitizeLogField("x".repeat(500))!.length).toBe(121);
    expect(sanitizeLogField(42)).toBeNull();
    expect(sanitizeLogField("")).toBeNull();
    const e = buildUnauthInitLogEntry(req(), { clientInfo: "nope" } as Record<string, unknown>);
    expect(e.clientName).toBeNull();
  });

  test("logger throwing never affects the caller", () => {
    process.env.MCP_UNAUTH_INIT_LOG_ENABLED = "true";
    expect(() =>
      maybeLogUnauthInitialize(req(), PARAMS, () => {
        throw new Error("boom");
      })
    ).not.toThrow();
  });

  test("route: initialize response unchanged; logs once when flag ON", async () => {
    const calls: string[] = [];
    const originalInfo = console.info;
    console.info = (...args: unknown[]) => {
      calls.push(String(args[0]));
    };
    try {
      delete process.env.MCP_UNAUTH_INIT_LOG_ENABLED;
      const off = await POST(req({ "user-agent": "ua-test" }));
      const offBody = await off.json();
      expect(calls.filter((c) => c.includes("mcp.unauth_initialize")).length).toBe(0);

      process.env.MCP_UNAUTH_INIT_LOG_ENABLED = "true";
      const on = await POST(req({ "user-agent": "ua-test" }));
      const onBody = await on.json();
      expect(on.status).toBe(off.status);
      expect(onBody).toEqual(offBody);
      const hits = calls.filter((c) => c.includes("mcp.unauth_initialize"));
      expect(hits.length).toBe(1);
      expect(hits[0]).toContain("ua-test");
    } finally {
      console.info = originalInfo;
    }
  });
});

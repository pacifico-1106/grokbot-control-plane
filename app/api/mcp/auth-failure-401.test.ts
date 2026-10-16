/**
 * /api/mcp 401: flag-gated Japanese nextStepJa + auth-failure audit.
 * Machine-readable codes stay the same. Flag OFF → byte-identical to today.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const audits: Array<Record<string, unknown>> = [];
function auditFlagOn() {
  const v = (process.env.MCP_AUTH_FAILURE_AUDIT_ENABLED ?? "").trim().toLowerCase();
  return v === "true" || v === "1" || v === "on" || v === "enabled";
}
mock.module("@/lib/data/mcp-auth-failures", () => ({
  recordMcpAuthFailure: async (input: Record<string, unknown>) => {
    if (!auditFlagOn()) return;
    audits.push(input);
  },
}));
mock.module("@/lib/mode", () => ({
  isDemoMode: () => false,
  isSupabaseConfigured: () => true,
  runtimeModeLabel: () => "production",
  isStripeConfigured: () => false,
  isResendConfigured: () => false,
}));
mock.module("@/lib/auth/employee-credential", () => ({
  extractEmployeeSecret: (r: Request) => {
    const alt = (r.headers.get("x-staffpass-credential") || "").trim();
    if (alt) return alt;
    const m = /^Bearer\s+(.+)$/i.exec((r.headers.get("authorization") || "").trim());
    const tok = m?.[1]?.trim() || "";
    return tok || null;
  },
  resolveEmployeeCredential: async (r: Request) => {
    const raw =
      (r.headers.get("x-staffpass-credential") || "").trim() ||
      /^Bearer\s+(.+)$/i.exec((r.headers.get("authorization") || "").trim())?.[1]?.trim() ||
      "";
    if (!raw) {
      return {
        ok: false,
        code: "missing_credential",
        message: "Authorization: Bearer gb_emp_… (or x-staffpass-credential) is required",
        httpStatus: 401,
      };
    }
    if (raw === "gb_emp_expired_fixture") {
      return {
        ok: false,
        code: "expired",
        message: "credential expired (fail-closed)",
        httpStatus: 401,
        orgId: "aa000000-0000-4000-8000-0000000000a1",
        employeeId: "emp_expired_1",
        credentialId: "aa200000-0000-4000-8000-000000000001",
      };
    }
    return {
      ok: false,
      code: "invalid_credential",
      message: "credential not found or rotated (fail-closed)",
      httpStatus: 401,
    };
  },
}));

const { POST } = await import("./route");

const FLAGS = ["MCP_AUTH_FAILURE_AUDIT_ENABLED", "MCP_AUTH_401_NEXT_STEP_JA_ENABLED", "MCP_OAUTH_ENABLED"] as const;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  audits.length = 0;
  for (const k of FLAGS) (saved[k] = process.env[k]), delete process.env[k];
});
afterEach(() => {
  for (const k of FLAGS) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]!);
});

const rpc = (method: string, headers: Record<string, string> = {}, id: number | string = 3) =>
  POST(
    new Request("https://staffpass.test/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params: method === "tools/call" ? { name: "staffpass_whoami" } : {} }),
    })
  );

const SECRET = "gb_emp_not_real_0123456789abcdef";

describe("flags OFF: 401 body unchanged; no audit", () => {
  test("missing tools/list → 401 missing_credential, no nextStepJa", async () => {
    const res = await rpc("tools/list");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      jsonrpc: "2.0",
      id: 3,
      error: {
        code: -32001,
        message: "Authorization: Bearer gb_emp_… (or x-staffpass-credential) is required",
        data: { code: "missing_credential" },
      },
    });
    expect(audits).toEqual([]);
  });

  test("invalid Bearer → 401 invalid_credential, no nextStepJa", async () => {
    const res = await rpc("tools/call", { authorization: `Bearer ${SECRET}` });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.data).toEqual({ code: "invalid_credential" });
    expect(body.error.data.nextStepJa).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain(SECRET);
    expect(audits).toEqual([]);
  });
});

describe("MCP_AUTH_401_NEXT_STEP_JA_ENABLED ON", () => {
  test("missing vs expired have different Japanese nextStepJa; codes unchanged", async () => {
    process.env.MCP_AUTH_401_NEXT_STEP_JA_ENABLED = "1";
    const missing = await (await rpc("tools/list")).json();
    const expired = await (await rpc("tools/list", { authorization: "Bearer gb_emp_expired_fixture" }, 4)).json();
    expect(missing.error.data.code).toBe("missing_credential");
    expect(expired.error.data.code).toBe("expired");
    expect(missing.error.data.nextStepJa).toContain("届いていません");
    expect(missing.error.data.nextStepJa).toContain("環境変数");
    expect(expired.error.data.nextStepJa).toContain("期限");
    expect(expired.error.data.nextStepJa).toContain("再発行");
    expect(expired.error.data.nextStepJa).toContain("/app/employees/emp_expired_1");
    expect(missing.error.data.nextStepJa).not.toBe(expired.error.data.nextStepJa);
  });

  test("invalid nextStepJa does not reveal whether a 社員証 exists", async () => {
    process.env.MCP_AUTH_401_NEXT_STEP_JA_ENABLED = "1";
    const body = await (await rpc("tools/list", { authorization: `Bearer ${SECRET}` })).json();
    expect(body.error.data.code).toBe("invalid_credential");
    expect(body.error.data.nextStepJa).toContain("確認できませんでした");
    expect(body.error.data.nextStepJa).not.toContain("期限");
    expect(body.error.data.nextStepJa).not.toContain("届いていません");
    expect(JSON.stringify(body)).not.toContain(SECRET);
  });
});

describe("MCP_AUTH_FAILURE_AUDIT_ENABLED ON", () => {
  test("missing / invalid / expired are recorded with kind; token never stored", async () => {
    process.env.MCP_AUTH_FAILURE_AUDIT_ENABLED = "1";
    await rpc("tools/list");
    await rpc("tools/call", { authorization: `Bearer ${SECRET}` });
    await rpc("tools/list", { authorization: "Bearer gb_emp_expired_fixture" });
    expect(audits.map((a) => a.kind)).toEqual(["missing_credential", "invalid", "expired"]);
    expect(audits[2]).toMatchObject({
      kind: "expired",
      orgId: "aa000000-0000-4000-8000-0000000000a1",
      employeeId: "emp_expired_1",
      credentialId: "aa200000-0000-4000-8000-000000000001",
    });
    expect(JSON.stringify(audits)).not.toContain(SECRET);
  });

  test("flag OFF still skips audit when 401-JA is ON", async () => {
    process.env.MCP_AUTH_401_NEXT_STEP_JA_ENABLED = "1";
    delete process.env.MCP_AUTH_FAILURE_AUDIT_ENABLED;
    await rpc("tools/list");
    expect(audits).toEqual([]);
  });
});

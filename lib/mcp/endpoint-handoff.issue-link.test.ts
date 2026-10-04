/**
 * MCP endpoint handoff — employees.issue / link results (Admin MCP + REST),
 * MCP client-seen signal, staffpass_health endpoint.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ApprovalRequest } from "@/lib/types";

mock.module("@/lib/auth/employee-credential", () => ({
  resolveEmployeeCredential: async () => ({
    ok: true,
    credential: {
      employeeId: "emp_sales", orgId: "org_demo", generation: 2, credentialId: "cred_seen_test",
      fingerprint: "fp", binding: null, secretPrefix: "gb_emp_ab",
    },
  }),
  extractEmployeeSecret: () => null,
}));

const { DEMO_ORG, getRuntimeAudit } = await import("@/lib/demo-data");
const { fulfillApprovedAdmin, parseAdminFulfillment } = await import("@/lib/admin-mcp/fulfill-admin");
const { callStaffpassMcpTool } = await import("@/lib/mcp/tools");
const { resetMcpClientSeenThrottleForTests } = await import("@/lib/mcp/endpoint-handoff");
const { POST: linkPost, GET: linkGet } = await import("@/app/api/employees/[id]/link/route");
const { POST: issuePost } = await import("@/app/api/employees/issue/route");
const { POST: mcpPost } = await import("@/app/api/mcp/route");

const FLAG = "MCP_ENDPOINT_HANDOFF_ENABLED";
const ORIGIN = "https://handoff-issue.example.test";
const MCP_URL = `${ORIGIN}/api/mcp`;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of [FLAG, "NEXT_PUBLIC_APP_URL"]) saved[k] = process.env[k];
  process.env.NEXT_PUBLIC_APP_URL = ORIGIN;
  resetMcpClientSeenThrottleForTests();
});
afterEach(() => {
  for (const k of [FLAG, "NEXT_PUBLIC_APP_URL"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function adminApproval(tool: string, mutation: Record<string, unknown>): ApprovalRequest {
  return {
    id: `apr_handoff_${tool}_${Math.random().toString(36).slice(2, 8)}`,
    orgId: DEMO_ORG.id, employeeId: "emp_ops", credentialId: null, title: tool, summary: tool,
    purpose: `admin.${tool}`, risk: "high", tool, status: "approved", createdAt: new Date().toISOString(),
    metadata: { approvalClass: "admin", adminTool: tool, adminMutation: mutation },
  } as unknown as ApprovalRequest;
}

describe("Admin MCP employees.issue / link fulfillment", () => {
  test("employees.issue flag ON → mcpHandoff with endpoint; secret only in oneTimeSecret", async () => {
    process.env[FLAG] = "true";
    const r = await fulfillApprovedAdmin(adminApproval("employees.issue", {
      displayName: "ハンドオフ太郎", roleLabel: "テスト", scopes: ["mail:draft"], expiresInDays: 30,
    }));
    expect(r?.ok).toBe(true);
    expect(r?.oneTimeSecret).toMatch(/^gb_emp_/);
    expect(r?.mcpHandoff?.mcp.url).toBe(MCP_URL);
    expect(r?.mcpHandoff?.employeeId).toBe(r?.employeeId);
    expect(r?.mcpHandoff?.connectivityCheck.tool).toBe("staffpass_whoami");
    expect(JSON.stringify(r?.mcpHandoff)).not.toContain(String(r?.oneTimeSecret));
    expect(r?.nextStepJa).toContain(MCP_URL);
    // survives the stored → parsed round trip
    const parsed = parseAdminFulfillment({ adminFulfillment: JSON.parse(JSON.stringify(r)) });
    expect(parsed?.mcpHandoff?.mcp.url).toBe(MCP_URL);
  });

  test("employees.issue flag OFF → no mcpHandoff, nextStepJa unchanged", async () => {
    delete process.env[FLAG];
    const r = await fulfillApprovedAdmin(adminApproval("employees.issue", {
      displayName: "ハンドオフ次郎", roleLabel: "テスト", scopes: ["mail:draft"], expiresInDays: 30,
    }));
    expect(r?.ok).toBe(true);
    expect(r?.mcpHandoff).toBeUndefined();
    expect(r?.nextStepJa).not.toContain("/api/mcp");
  });

  test("link flag ON → mcpHandoff for the linked employee", async () => {
    process.env[FLAG] = "true";
    const r = await fulfillApprovedAdmin(adminApproval("link", { employeeId: "emp_ops", grokBotAgentId: "agent_handoff_1" }));
    expect(r?.ok).toBe(true);
    expect(r?.mcpHandoff?.employeeId).toBe("emp_ops");
    expect(r?.mcpHandoff?.mcp.url).toBe(MCP_URL);
  });

  test("parseAdminFulfillment drops a malformed mcpHandoff", () => {
    const parsed = parseAdminFulfillment({ adminFulfillment: { ok: true, tool: "link", mcpHandoff: { schema: "evil", mcp: "x" } } });
    expect(parsed?.mcpHandoff).toBeUndefined();
  });
});

describe("REST issue / link responses", () => {
  test("POST /api/employees/[id]/link flag ON → mcpHandoff; OFF → absent", async () => {
    process.env[FLAG] = "true";
    const req = () => new Request("https://x.invalid/api/employees/emp_ops/link", {
      method: "POST", body: JSON.stringify({ grokBotAgentId: "agent_handoff_rest" }),
    });
    const on = await (await linkPost(req(), { params: Promise.resolve({ id: "emp_ops" }) })).json();
    expect(on.ok).toBe(true);
    expect(on.mcpHandoff.mcp.url).toBe(MCP_URL);
    const getOn = await (await linkGet(new Request("https://x.invalid"), { params: Promise.resolve({ id: "emp_ops" }) })).json();
    expect(getOn.mcpHandoff?.mcp.url).toBe(MCP_URL);
    delete process.env[FLAG];
    const off = await (await linkPost(req(), { params: Promise.resolve({ id: "emp_ops" }) })).json();
    expect(off.ok).toBe(true);
    expect("mcpHandoff" in off).toBe(false);
  });

  test("POST /api/employees/issue flag ON → mcpHandoff without the one-time secret", async () => {
    process.env[FLAG] = "true";
    const res = await issuePost(new Request("https://x.invalid/api/employees/issue", {
      method: "POST",
      body: JSON.stringify({ displayName: "REST太郎", roleLabel: "テスト", scopes: ["mail:draft"] }),
    }));
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.mcpHandoff.mcp.url).toBe(MCP_URL);
    expect(body.mcpHandoff.employeeId).toBe(body.employee.id);
    expect(JSON.stringify(body.mcpHandoff)).not.toContain(body.credential.oneTimeSecret);
    delete process.env[FLAG];
    const off = await (await issuePost(new Request("https://x.invalid/api/employees/issue", {
      method: "POST",
      body: JSON.stringify({ displayName: "REST次郎", roleLabel: "テスト", scopes: ["mail:draft"] }),
    }))).json();
    expect(off.ok).toBe(true);
    expect("mcpHandoff" in off).toBe(false);
  });
});

describe("MCP route records the connected signal", () => {
  const rpc = (method: string, params: Record<string, unknown> = {}) =>
    new Request("https://x.invalid/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });

  test("flag OFF → tools/list records nothing", async () => {
    delete process.env[FLAG];
    await mcpPost(rpc("tools/list"));
    expect(getRuntimeAudit().some((e) => e.action === "mcp.client_seen" && e.credentialId === "cred_seen_test")).toBe(false);
  });

  test("flag ON → authenticated tools/list records mcp.client_seen (throttled, no secret)", async () => {
    process.env[FLAG] = "true";
    await mcpPost(rpc("tools/list"));
    await mcpPost(rpc("tools/list"));
    const rows = getRuntimeAudit().filter((e) => e.action === "mcp.client_seen" && e.credentialId === "cred_seen_test");
    expect(rows.length).toBe(1);
    expect(rows[0].employeeId).toBe("emp_sales");
    expect(JSON.stringify(rows[0].metadata)).not.toContain("gb_emp_ab");
  });
});

describe("staffpass_health endpoint", () => {
  const cred = {
    employeeId: "emp_sales", orgId: DEMO_ORG.id, generation: 1, credentialId: "cred_sales",
    fingerprint: "fp", binding: null, secretPrefix: "gb_emp_x",
  };
  const read = async () => {
    const r = await callStaffpassMcpTool("staffpass_health", {}, cred);
    return JSON.parse((r.content[0] as { text: string }).text) as Record<string, unknown>;
  };

  test("flag OFF → relative path unchanged; publicOrigin from config (#254 follow-up 1)", async () => {
    delete process.env[FLAG];
    const h = await read();
    expect(h.mcpEndpoint).toBe("/api/mcp");
    expect(h.publicOrigin).toBe(ORIGIN);
    expect(h.mcpEndpointUrl).toBeUndefined();
  });

  test("flag ON → absolute endpoint from config", async () => {
    process.env[FLAG] = "true";
    const h = await read();
    expect(h.mcpEndpoint).toBe("/api/mcp");
    expect(h.mcpEndpointUrl).toBe(MCP_URL);
    expect(h.publicOrigin).toBe(ORIGIN);
  });
});

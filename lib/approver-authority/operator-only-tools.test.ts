/**
 * #279 (木村 2026-10-09): orgs.issueAdminCredential and approvals.proxyResolve are
 * left OUT of the approver-authority targets because they are operator-only.
 * These tests pin that: they are callable ONLY with operator/platform auth
 * (PLATFORM_OPS_ORG_ID + SUPER_ADMIN allowlist owner for admin MCP; the
 * SUPER_ADMIN session for the web route). Tenant admin MCP credentials and
 * member sessions are refused, at call time and again at fulfil time.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { ApprovalRequest } from "@/lib/types";
import type { ResolvedAdminCredential } from "@/lib/auth/admin-credential";
import { scopedModuleMocks } from "@/tests/helpers/scoped-module-mock";

let session: Record<string, unknown> = { demo: true };
const mocks = scopedModuleMocks();
await mocks.mock("@/lib/auth/session", { getSessionContext: async () => session });

const { DEMO_ORG } = await import("@/lib/demo-data");
const { callAdminMcpTool } = await import("@/lib/mcp/admin-tools");
const { fulfillApprovedAdmin } = await import("@/lib/admin-mcp/fulfill-admin");
const { resetDemoAdminAgent } = await import("@/lib/data/admin-agents");
const { listApprovals, createApproval, getApprovalById } = await import("@/lib/data");
const { STAFFPASS_MCP_TOOL_NAMES } = await import("@/lib/mcp/public");
const { APPROVER_AUTHORITY_TARGETS } = await import("@/lib/approver-authority/targets");
const { POST: proxyResolvePost } = await import("@/app/api/admin/organizations/[orgId]/approvals/[approvalId]/resolve/route");
const { GET: proxyListGet } = await import("@/app/api/admin/organizations/[orgId]/approvals/route");

const TARGET_ORG_ID = "6d134a38-a0ab-4a8e-aba7-3202650ff523";
const OPERATOR_TOOLS = ["orgs.issueAdminCredential", "approvals.proxyResolve"] as const;

const envBackup = {
  emails: process.env.SUPER_ADMIN_EMAILS,
  userIds: process.env.SUPER_ADMIN_USER_IDS,
  platformOrgId: process.env.PLATFORM_OPS_ORG_ID,
};
afterEach(() => {
  for (const [k, v] of [["SUPER_ADMIN_EMAILS", envBackup.emails], ["SUPER_ADMIN_USER_IDS", envBackup.userIds], ["PLATFORM_OPS_ORG_ID", envBackup.platformOrgId]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  session = { demo: true };
});

function tenantCred(): ResolvedAdminCredential {
  const agent = resetDemoAdminAgent({ grokBotAgentId: "grok_tenant_admin", status: "linked" });
  return {
    orgId: DEMO_ORG.id, adminAgentId: agent.id, grokBotAgentId: agent.grokBotAgentId,
    actorId: agent.id, generation: agent.credentialGeneration, via: "bearer", agent,
  };
}

function argsFor(tool: (typeof OPERATOR_TOOLS)[number], approvalId = "apr_x") {
  return tool === "orgs.issueAdminCredential"
    ? { orgId: TARGET_ORG_ID }
    : { orgId: DEMO_ORG.id, approvalId, decision: "approved", mandate: "support" };
}

async function pendingTenantApproval(): Promise<ApprovalRequest> {
  const created = (await createApproval({
    orgId: DEMO_ORG.id, employeeId: "emp_sales", credentialId: null,
    title: "operator-only pin", summary: "operator-only pin", purpose: "pin", risk: "high", tool: "mail.send",
  } as never)) as unknown as { approval?: ApprovalRequest } & ApprovalRequest;
  return created.approval ?? created;
}
async function statusOf(id: string): Promise<string | undefined> {
  return (await getApprovalById(id, DEMO_ORG.id))?.status;
}

describe("tenant admin MCP credential is refused", () => {
  for (const tool of OPERATOR_TOOLS) {
    test(`${tool}: tenant admin (owner not on the SUPER_ADMIN allowlist) → platform_ops_forbidden, nothing queued or resolved`, async () => {
      process.env.SUPER_ADMIN_EMAILS = "ops@platform.example";
      delete process.env.SUPER_ADMIN_USER_IDS;
      delete process.env.PLATFORM_OPS_ORG_ID;
      const pending = await pendingTenantApproval();
      const before = (await listApprovals(DEMO_ORG.id)).length;
      const result = await callAdminMcpTool(tool, argsFor(tool, pending.id), tenantCred());
      expect(result.isError).toBe(true);
      expect((result.structuredContent as Record<string, unknown>).code).toBe("platform_ops_forbidden");
      expect((await listApprovals(DEMO_ORG.id)).length).toBe(before);
      expect(await statusOf(pending.id)).toBe("pending");
    });

    test(`${tool}: empty allowlists → refused (fail closed)`, async () => {
      delete process.env.SUPER_ADMIN_EMAILS;
      delete process.env.SUPER_ADMIN_USER_IDS;
      delete process.env.PLATFORM_OPS_ORG_ID;
      const result = await callAdminMcpTool(tool, argsFor(tool), tenantCred());
      expect(result.isError).toBe(true);
      expect((result.structuredContent as Record<string, unknown>).code).toBe("platform_ops_forbidden");
    });

    test(`${tool}: allowlisted owner but the caller org is not PLATFORM_OPS_ORG_ID → refused`, async () => {
      process.env.SUPER_ADMIN_EMAILS = "owner@example.com";
      process.env.PLATFORM_OPS_ORG_ID = "org_platform_ops_only";
      const result = await callAdminMcpTool(tool, argsFor(tool), tenantCred());
      expect(result.isError).toBe(true);
      expect((result.structuredContent as Record<string, unknown>).code).toBe("platform_ops_forbidden");
    });
  }

  test("operator auth (allowlisted owner of the platform org) is accepted — the gate is the only difference", async () => {
    process.env.SUPER_ADMIN_EMAILS = "owner@example.com";
    process.env.PLATFORM_OPS_ORG_ID = DEMO_ORG.id;
    const result = await callAdminMcpTool("orgs.issueAdminCredential", { orgId: TARGET_ORG_ID }, tenantCred());
    expect(Boolean(result.isError)).toBe(false);
    expect((result.structuredContent as Record<string, unknown>).needs_approval).toBe(true);
  });
});

describe("fulfil re-checks operator auth (an approved ticket alone is not enough)", () => {
  test("orgs.issueAdminCredential ticket in a tenant org without operator auth → not fulfilled, no credential minted", async () => {
    process.env.SUPER_ADMIN_EMAILS = "ops@platform.example";
    delete process.env.PLATFORM_OPS_ORG_ID;
    const approval = {
      id: `apr_oponly_${Math.random().toString(36).slice(2, 8)}`,
      orgId: DEMO_ORG.id, employeeId: "emp_ops", credentialId: null, title: "orgs.issueAdminCredential",
      summary: "orgs.issueAdminCredential", purpose: "admin.orgs.issueAdminCredential", risk: "high",
      tool: "orgs.issueAdminCredential", status: "approved", createdAt: new Date().toISOString(),
      metadata: {
        approvalClass: "admin", adminTool: "orgs.issueAdminCredential",
        adminMutation: { targetOrgId: TARGET_ORG_ID, platformActorEmail: "owner@example.com", platformActorOrgId: DEMO_ORG.id },
      },
    } as unknown as ApprovalRequest;
    const r = await fulfillApprovedAdmin(approval).catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }));
    expect(r?.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain("gb_adm_");
  });
});

describe("member / tenant sessions are refused on the operator web routes", () => {
  const listReq = () => proxyListGet(new Request(`https://x.invalid/api/admin/organizations/${DEMO_ORG.id}/approvals`), { params: Promise.resolve({ orgId: DEMO_ORG.id }) });
  const resolveReq = (approvalId: string) => proxyResolvePost(
    new Request(`https://x.invalid/api/admin/organizations/${DEMO_ORG.id}/approvals/${approvalId}/resolve`, {
      method: "POST", body: JSON.stringify({ decision: "approved", mandate: "support" }),
    }),
    { params: Promise.resolve({ orgId: DEMO_ORG.id, approvalId }) }
  );

  test("tenant owner session (not on the allowlist) → 403 and the approval stays pending", async () => {
    process.env.SUPER_ADMIN_EMAILS = "ops@platform.example";
    session = { demo: false, userId: "u_tenant_owner", email: "owner@tenant.example", orgId: DEMO_ORG.id };
    const pending = await pendingTenantApproval();
    expect((await resolveReq(pending.id)).status).toBe(403);
    expect((await listReq()).status).toBe(403);
    expect(await statusOf(pending.id)).toBe("pending");
  });

  test("no session → 401; demo session → refused", async () => {
    session = { demo: false, userId: null, email: null };
    expect((await resolveReq("apr_any")).status).toBe(401);
    session = { demo: true };
    expect([401, 403]).toContain((await resolveReq("apr_any")).status);
  });
});

describe("inventory", () => {
  test("not on the employee MCP surface, and deliberately not approver-authority targets", () => {
    for (const tool of OPERATOR_TOOLS) {
      expect(STAFFPASS_MCP_TOOL_NAMES as readonly string[]).not.toContain(tool);
      expect(APPROVER_AUTHORITY_TARGETS.standardTools as readonly string[]).not.toContain(tool);
      expect(APPROVER_AUTHORITY_TARGETS.sensitiveTools as readonly string[]).not.toContain(tool);
    }
  });

  test("the operator-only implementations are reachable only from the gated callers", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { join, relative } = await import("node:path");
    const root = process.cwd();
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name.startsWith(".")) continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(p);
      }
    };
    walk(join(root, "app"));
    walk(join(root, "lib"));
    const users = (fn: string) => files
      .filter((f) => new RegExp(`\\b${fn}\\b`).test(readFileSync(f, "utf8")))
      .map((f) => relative(root, f)).sort();
    expect(users("proxyResolveApproval")).toEqual([
      "app/api/admin/organizations/[orgId]/approvals/[approvalId]/resolve/route.ts",
      "lib/admin/proxy-approve.ts",
      "lib/mcp/admin-tools.ts",
    ]);
    expect(users("platformIssueAdminCredential")).toEqual(["lib/admin-mcp/orgs-issue-admin-credential.ts"]);
    expect(users("fulfillOrgIssueAdminCredentialFromQueuedArgs")).toEqual([
      "lib/admin-mcp/fulfill-admin.ts",
      "lib/admin-mcp/orgs-issue-admin-credential.ts",
    ]);
  });
});

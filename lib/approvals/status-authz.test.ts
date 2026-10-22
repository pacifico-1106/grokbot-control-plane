/**
 * Approval status IDOR: employee MCP (staffpass_get_approval_status) must
 * only return a ticket when the authenticated gb_emp_ caller matches the
 * approval's org AND requesting employee. Mismatches look like a missing
 * ticket (404 / not_found_or_invalid_token) so callers cannot infer existence.
 *
 * Public GET /api/approvals/status stays token-only for existing bot pollUrl
 * callers (Web copies the URL; docs/runbook curl it). Tightening that
 * payload (status only, no title/summary/PII) sits behind
 * APPROVAL_STATUS_PUBLIC_MINIMAL_ENABLED + _ORG_IDS (default OFF).
 *
 * fail-first: the cross-org / same-org-other-employee / public-minimal cases
 * must fail on main before the implementation lands.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEMO_ORG } from "@/lib/demo-data";
import { createApproval, getApprovalById } from "@/lib/data/approvals";
import { callStaffpassMcpTool } from "@/lib/mcp/tools";
import { GET as getApprovalStatus } from "@/app/api/approvals/status/route";
import { employeeOwnsApproval } from "@/lib/approvals/status-authz";
import type { ResolvedEmployeeCredential } from "@/lib/auth/employee-credential";

const FLAG = "APPROVAL_STATUS_PUBLIC_MINIMAL_ENABLED";
const ORG_IDS = "APPROVAL_STATUS_PUBLIC_MINIMAL_ORG_IDS";

const TITLE = "Authz secret title 山田太郎";
const SUMMARY = "本文: 顧客山田への見積フォロー。宛先 yamada@example.com";
const PII_NEEDLES = [TITLE, SUMMARY, "山田太郎", "yamada@example.com"];

const envBackup: Record<string, string | undefined> = {};

function saveEnv(...keys: string[]) {
  for (const key of keys) envBackup[key] = process.env[key];
}
function restoreEnv() {
  for (const [key, value] of Object.entries(envBackup)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function cred(employeeId: string, orgId = DEMO_ORG.id): ResolvedEmployeeCredential {
  const now = new Date().toISOString();
  return {
    employeeId,
    orgId,
    credentialId: `cred_${employeeId}`,
    generation: 1,
    fingerprint: "fixture-hash",
    secretPrefix: "gb_emp_fixture",
    binding: {
      status: "linked",
      employeeId,
      orgId,
      credentialGeneration: 1,
      grokBotAgentId: "agent_test",
      grokBotWorkspaceId: null,
      credentialFingerprint: null,
      lastSuccessAt: null,
      lastError: null,
      wakeWebhookUrl: null,
      hasWakeWebhook: false,
      createdAt: now,
      updatedAt: now,
    },
  };
}

async function fileTicket() {
  return createApproval({
    orgId: DEMO_ORG.id,
    employeeId: "emp_sales",
    credentialId: "cred_sales",
    title: TITLE,
    purpose: "sales.outreach",
    summary: SUMMARY,
    risk: "low",
    tool: "mail.send",
    jobId: `job_status_authz_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
  });
}

function mcpBody(result: { structuredContent?: unknown; content: Array<{ text: string }>; isError?: boolean }) {
  const structured = (result.structuredContent ?? JSON.parse(result.content[0].text)) as Record<string, unknown>;
  return { structured, isError: Boolean(result.isError) };
}

function hidden404(structured: Record<string, unknown>) {
  expect(structured.ok).toBe(false);
  expect(structured.error).toBe("not_found_or_invalid_token");
  expect(structured).not.toHaveProperty("approvalId");
  expect(structured).not.toHaveProperty("status");
  expect(structured).not.toHaveProperty("title");
  expect(structured).not.toHaveProperty("summary");
  expect(structured).not.toHaveProperty("employeeId");
  const blob = JSON.stringify(structured);
  for (const needle of PII_NEEDLES) expect(blob).not.toContain(needle);
}

beforeEach(() => {
  saveEnv(FLAG, ORG_IDS);
  delete process.env[FLAG];
  delete process.env[ORG_IDS];
});

afterEach(() => {
  restoreEnv();
});

describe("staffpass_get_approval_status caller binding", () => {
  test("requesting employee can poll with approvalId alone (no token)", async () => {
    const created = await fileTicket();
    const result = await callStaffpassMcpTool(
      "staffpass_get_approval_status",
      { approvalId: created.approval.id },
      cred("emp_sales")
    );
    const { structured, isError } = mcpBody(result);
    expect(isError).toBe(false);
    expect(structured.ok).toBe(true);
    expect(structured.approvalId).toBe(created.approval.id);
    expect(structured.status).toBe("pending");
    expect(structured.employeeId).toBe("emp_sales");
    expect(structured.title).toBe(TITLE);
    expect(JSON.stringify(structured)).not.toMatch(/"statusToken"\s*:/);
  });

  test("approvalId alone: other employee / other org / missing id → same 404", async () => {
    const created = await fileTicket();
    const cases = await Promise.all([
      callStaffpassMcpTool(
        "staffpass_get_approval_status",
        { approvalId: created.approval.id },
        cred("emp_ops")
      ),
      callStaffpassMcpTool(
        "staffpass_get_approval_status",
        { approvalId: created.approval.id },
        cred("emp_other", "org_other")
      ),
      callStaffpassMcpTool(
        "staffpass_get_approval_status",
        { approvalId: "apr_does_not_exist" },
        cred("emp_sales")
      ),
    ]);
    const bodies = cases.map((r) => mcpBody(r));
    for (const body of bodies) {
      expect(body.isError).toBe(true);
      hidden404(body.structured);
    }
    expect(bodies[0].structured).toEqual(bodies[1].structured);
    expect(bodies[1].structured).toEqual(bodies[2].structured);
  });

  test("requesting employee in the same org can read the ticket", async () => {
    const created = await fileTicket();
    const result = await callStaffpassMcpTool(
      "staffpass_get_approval_status",
      { approvalId: created.approval.id, statusToken: created.statusToken },
      cred("emp_sales")
    );
    const { structured, isError } = mcpBody(result);
    expect(isError).toBe(false);
    expect(structured.ok).toBe(true);
    expect(structured.approvalId).toBe(created.approval.id);
    expect(structured.status).toBe("pending");
    expect(structured.employeeId).toBe("emp_sales");
    expect(structured.title).toBe(TITLE);
  });

  test("same org, other employee → 404-equivalent, no existence leak", async () => {
    const created = await fileTicket();
    const result = await callStaffpassMcpTool(
      "staffpass_get_approval_status",
      { approvalId: created.approval.id, statusToken: created.statusToken },
      cred("emp_ops")
    );
    const { structured, isError } = mcpBody(result);
    expect(isError).toBe(true);
    hidden404(structured);
  });

  test("other org employee with a valid token → 404-equivalent, no existence leak", async () => {
    const created = await fileTicket();
    const result = await callStaffpassMcpTool(
      "staffpass_get_approval_status",
      { approvalId: created.approval.id, statusToken: created.statusToken },
      cred("emp_other", "org_other")
    );
    const { structured, isError } = mcpBody(result);
    expect(isError).toBe(true);
    hidden404(structured);
  });

  test("token mismatch → 404-equivalent, same shape as a missing ticket", async () => {
    const created = await fileTicket();
    const result = await callStaffpassMcpTool(
      "staffpass_get_approval_status",
      { approvalId: created.approval.id, statusToken: "st_definitely_wrong_token" },
      cred("emp_sales")
    );
    const { structured, isError } = mcpBody(result);
    expect(isError).toBe(true);
    hidden404(structured);
  });

  test("non-existent id → 404-equivalent, same shape as a token mismatch", async () => {
    const created = await fileTicket();
    const missing = await callStaffpassMcpTool(
      "staffpass_get_approval_status",
      { approvalId: "apr_does_not_exist", statusToken: created.statusToken },
      cred("emp_sales")
    );
    const wrongToken = await callStaffpassMcpTool(
      "staffpass_get_approval_status",
      { approvalId: created.approval.id, statusToken: "st_definitely_wrong_token" },
      cred("emp_sales")
    );
    const a = mcpBody(missing);
    const b = mcpBody(wrongToken);
    expect(a.isError).toBe(true);
    expect(b.isError).toBe(true);
    hidden404(a.structured);
    hidden404(b.structured);
    expect(a.structured).toEqual(b.structured);
  });

  test("admin-class ticket with empty requesting employee → 404-equivalent", async () => {
    const created = await createApproval({
      orgId: DEMO_ORG.id,
      employeeId: "",
      credentialId: "",
      title: TITLE,
      purpose: "admin.hire",
      summary: SUMMARY,
      risk: "high",
      tool: "orgs.issueAdminCredential",
      jobId: `job_status_authz_admin_${Date.now()}`,
    });
    const result = await callStaffpassMcpTool(
      "staffpass_get_approval_status",
      { approvalId: created.approval.id, statusToken: created.statusToken },
      cred("emp_sales")
    );
    const { structured, isError } = mcpBody(result);
    expect(isError).toBe(true);
    hidden404(structured);
  });

  test("cross-org / other-employee / wrong-token / missing-id errors are indistinguishable", async () => {
    const created = await fileTicket();
    const cases = await Promise.all([
      callStaffpassMcpTool(
        "staffpass_get_approval_status",
        { approvalId: created.approval.id, statusToken: created.statusToken },
        cred("emp_other", "org_other")
      ),
      callStaffpassMcpTool(
        "staffpass_get_approval_status",
        { approvalId: created.approval.id, statusToken: created.statusToken },
        cred("emp_ops")
      ),
      callStaffpassMcpTool(
        "staffpass_get_approval_status",
        { approvalId: created.approval.id, statusToken: "st_definitely_wrong_token" },
        cred("emp_sales")
      ),
      callStaffpassMcpTool(
        "staffpass_get_approval_status",
        { approvalId: "apr_does_not_exist", statusToken: created.statusToken },
        cred("emp_sales")
      ),
    ]);
    const bodies = cases.map((r) => mcpBody(r));
    for (const body of bodies) {
      expect(body.isError).toBe(true);
      hidden404(body.structured);
    }
    expect(bodies[0].structured).toEqual(bodies[1].structured);
    expect(bodies[1].structured).toEqual(bodies[2].structured);
    expect(bodies[2].structured).toEqual(bodies[3].structured);
  });
});

/**
 * Live AI employees (稲盛 / ともり / 安藤) already poll with a statusToken
 * they received before this leak fix. Tokens stay on the approval row;
 * MCP only stops echoing them. Optional input must keep working.
 */
describe("staffpass_get_approval_status: held statusToken (稲盛 / ともり / 安藤)", () => {
  const LIVE = [
    { employeeId: "emp_inamori", label: "稲盛" },
    { employeeId: "emp_tomori", label: "ともり" },
    { employeeId: "emp_ando", label: "安藤" },
  ] as const;

  async function fileFor(employeeId: string) {
    return createApproval({
      orgId: DEMO_ORG.id,
      employeeId,
      credentialId: `cred_${employeeId}`,
      title: TITLE,
      purpose: "sales.outreach",
      summary: SUMMARY,
      risk: "low",
      tool: "mail.send",
      jobId: `job_live_${employeeId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    });
  }

  test("valid token + matching employee/org returns status", async () => {
    for (const { employeeId } of LIVE) {
      const created = await fileFor(employeeId);
      const result = await callStaffpassMcpTool(
        "staffpass_get_approval_status",
        { approvalId: created.approval.id, statusToken: created.statusToken },
        cred(employeeId)
      );
      const { structured, isError } = mcpBody(result);
      expect(isError).toBe(false);
      expect(structured.ok).toBe(true);
      expect(structured.approvalId).toBe(created.approval.id);
      expect(structured.status).toBe("pending");
      expect(structured.employeeId).toBe(employeeId);
      expect(JSON.stringify(structured)).not.toMatch(/"statusToken"\s*:/);
    }
  });

  test("approvalId-only lookup works for the requesting employee", async () => {
    for (const { employeeId } of LIVE) {
      const created = await fileFor(employeeId);
      const result = await callStaffpassMcpTool(
        "staffpass_get_approval_status",
        { approvalId: created.approval.id },
        cred(employeeId)
      );
      const { structured, isError } = mcpBody(result);
      expect(isError).toBe(false);
      expect(structured.ok).toBe(true);
      expect(structured.approvalId).toBe(created.approval.id);
      expect(structured.status).toBe("pending");
      expect(JSON.stringify(structured)).not.toMatch(/"statusToken"\s*:/);
    }
  });

  test("token or id from another employee or org returns the same 404", async () => {
    const inamori = await fileFor("emp_inamori");
    const tomori = await fileFor("emp_tomori");
    const cases = await Promise.all([
      callStaffpassMcpTool(
        "staffpass_get_approval_status",
        { approvalId: inamori.approval.id, statusToken: inamori.statusToken },
        cred("emp_tomori")
      ),
      callStaffpassMcpTool(
        "staffpass_get_approval_status",
        { approvalId: inamori.approval.id },
        cred("emp_ando")
      ),
      callStaffpassMcpTool(
        "staffpass_get_approval_status",
        { approvalId: inamori.approval.id, statusToken: tomori.statusToken },
        cred("emp_inamori")
      ),
      callStaffpassMcpTool(
        "staffpass_get_approval_status",
        { approvalId: inamori.approval.id, statusToken: inamori.statusToken },
        cred("emp_inamori", "org_other")
      ),
    ]);
    const bodies = cases.map((r) => mcpBody(r));
    for (const body of bodies) {
      expect(body.isError).toBe(true);
      hidden404(body.structured);
    }
    expect(bodies[0].structured).toEqual(bodies[1].structured);
    expect(bodies[1].structured).toEqual(bodies[2].structured);
    expect(bodies[2].structured).toEqual(bodies[3].structured);
  });

  test("token issued before this change still works", async () => {
    const created = await fileFor("emp_inamori");
    // Pre-change clients cached this token from an older needs_approval body.
    const heldToken = created.statusToken;
    expect(heldToken).toMatch(/^st_/);

    const withField = await callStaffpassMcpTool(
      "staffpass_get_approval_status",
      { approvalId: created.approval.id, statusToken: heldToken },
      cred("emp_inamori")
    );
    const a = mcpBody(withField);
    expect(a.isError).toBe(false);
    expect(a.structured.ok).toBe(true);
    expect(a.structured.approvalId).toBe(created.approval.id);
    expect(a.structured.status).toBe("pending");
    expect(JSON.stringify(a.structured)).not.toMatch(/"statusToken"\s*:/);

    // Older handler alias (`token`) still accepted.
    const withAlias = await callStaffpassMcpTool(
      "staffpass_get_approval_status",
      { approvalId: created.approval.id, token: heldToken },
      cred("emp_inamori")
    );
    const b = mcpBody(withAlias);
    expect(b.isError).toBe(false);
    expect(b.structured.ok).toBe(true);
    expect(b.structured.approvalId).toBe(created.approval.id);

    // Token remains on the row for GET /api/approvals/status (bot pollUrl).
    const row = await getApprovalById(created.approval.id, DEMO_ORG.id);
    expect(row?.statusToken).toBe(heldToken);
  });
});

describe("GET /api/approvals/status public token poll", () => {
  test("flag OFF (default): token poll still returns title/summary (existing bot contract)", async () => {
    const created = await fileTicket();
    const res = await getApprovalStatus(
      new Request(
        `http://localhost/api/approvals/status?id=${encodeURIComponent(created.approval.id)}&token=${encodeURIComponent(created.statusToken)}`
      )
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.status).toBe("pending");
    expect(body.title).toBe(TITLE);
    expect(body.summary).toBe(SUMMARY);
    expect(body.employeeId).toBe("emp_sales");
  });

  test("flag ON: token poll returns status only — no title/summary/PII", async () => {
    process.env[FLAG] = "true";
    delete process.env[ORG_IDS];
    const created = await fileTicket();
    const res = await getApprovalStatus(
      new Request(
        `http://localhost/api/approvals/status?id=${encodeURIComponent(created.approval.id)}&token=${encodeURIComponent(created.statusToken)}`
      )
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.approvalId).toBe(created.approval.id);
    expect(body.status).toBe("pending");
    expect(body.pollHint).toBe("continue_polling");
    expect(body).not.toHaveProperty("title");
    expect(body).not.toHaveProperty("summary");
    expect(body).not.toHaveProperty("employeeId");
    expect(body).not.toHaveProperty("revisionNote");
    expect(body).not.toHaveProperty("fulfillment");
    expect(body).not.toHaveProperty("workflow");
    const blob = JSON.stringify(body);
    for (const needle of PII_NEEDLES) expect(blob).not.toContain(needle);
  });

  test("flag ON + _ORG_IDS excluding the ticket org keeps the full payload", async () => {
    process.env[FLAG] = "true";
    process.env[ORG_IDS] = "org_pilot_only";
    const created = await fileTicket();
    const res = await getApprovalStatus(
      new Request(
        `http://localhost/api/approvals/status?id=${encodeURIComponent(created.approval.id)}&token=${encodeURIComponent(created.statusToken)}`
      )
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.title).toBe(TITLE);
    expect(body.summary).toBe(SUMMARY);
    expect(body.employeeId).toBe("emp_sales");
  });

  test("flag ON + _ORG_IDS matching the ticket org strips PII", async () => {
    process.env[FLAG] = "true";
    process.env[ORG_IDS] = ` org_pilot_only , ${DEMO_ORG.id} `;
    const created = await fileTicket();
    const res = await getApprovalStatus(
      new Request(
        `http://localhost/api/approvals/status?id=${encodeURIComponent(created.approval.id)}&token=${encodeURIComponent(created.statusToken)}`
      )
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("pending");
    expect(body).not.toHaveProperty("title");
    expect(body).not.toHaveProperty("summary");
    expect(body).not.toHaveProperty("employeeId");
    const blob = JSON.stringify(body);
    for (const needle of PII_NEEDLES) expect(blob).not.toContain(needle);
  });

  test("wrong token and missing id stay 404 (no existence leak)", async () => {
    const created = await fileTicket();
    const wrong = await getApprovalStatus(
      new Request(
        `http://localhost/api/approvals/status?id=${encodeURIComponent(created.approval.id)}&token=st_definitely_wrong_token`
      )
    );
    const missing = await getApprovalStatus(
      new Request(
        `http://localhost/api/approvals/status?id=apr_does_not_exist&token=${encodeURIComponent(created.statusToken)}`
      )
    );
    expect(wrong.status).toBe(404);
    expect(missing.status).toBe(404);
    const a = (await wrong.json()) as Record<string, unknown>;
    const b = (await missing.json()) as Record<string, unknown>;
    expect(a).toEqual({ ok: false, error: "not_found_or_invalid_token" });
    expect(b).toEqual(a);
  });
});

describe("employeeOwnsApproval", () => {
  test("requires both org and requesting employee; empty ids fail closed", () => {
    const ticket = { orgId: DEMO_ORG.id, employeeId: "emp_sales" };
    expect(employeeOwnsApproval(ticket, { orgId: DEMO_ORG.id, employeeId: "emp_sales" })).toBe(true);
    expect(employeeOwnsApproval(ticket, { orgId: DEMO_ORG.id, employeeId: "emp_ops" })).toBe(false);
    expect(employeeOwnsApproval(ticket, { orgId: "org_other", employeeId: "emp_sales" })).toBe(false);
    expect(employeeOwnsApproval({ orgId: DEMO_ORG.id, employeeId: "" }, { orgId: DEMO_ORG.id, employeeId: "emp_sales" })).toBe(false);
    expect(employeeOwnsApproval(ticket, { orgId: DEMO_ORG.id, employeeId: "" })).toBe(false);
    expect(employeeOwnsApproval(ticket, { orgId: "", employeeId: "emp_sales" })).toBe(false);
  });
});

describe("APPROVAL_STATUS_PUBLIC_MINIMAL flag defaults", () => {
  test("unset / empty is OFF; only listed orgs when _ORG_IDS is set", async () => {
    const { isApprovalStatusPublicMinimalEnabled, isApprovalStatusPublicMinimalEnabledForOrg } =
      await import("@/lib/feature-flags");
    delete process.env[FLAG];
    delete process.env[ORG_IDS];
    expect(isApprovalStatusPublicMinimalEnabled()).toBe(false);
    expect(isApprovalStatusPublicMinimalEnabledForOrg(DEMO_ORG.id)).toBe(false);

    process.env[FLAG] = "true";
    delete process.env[ORG_IDS];
    expect(isApprovalStatusPublicMinimalEnabled()).toBe(true);
    expect(isApprovalStatusPublicMinimalEnabledForOrg(DEMO_ORG.id)).toBe(true);
    expect(isApprovalStatusPublicMinimalEnabledForOrg("")).toBe(false);
    expect(isApprovalStatusPublicMinimalEnabledForOrg(null)).toBe(false);

    process.env[ORG_IDS] = "org_a, org_b";
    expect(isApprovalStatusPublicMinimalEnabledForOrg("org_a")).toBe(true);
    expect(isApprovalStatusPublicMinimalEnabledForOrg("org_b")).toBe(true);
    expect(isApprovalStatusPublicMinimalEnabledForOrg(DEMO_ORG.id)).toBe(false);
  });
});

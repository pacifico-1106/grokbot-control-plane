import { describe, expect, test } from "bun:test";
import type { AuditEvent } from "@/lib/types";
import { indexApprovalsForOrg, resolveAuditApproval } from "./approval";
import { listApprovalsByIds } from "@/lib/data/approvals";
import { DEMO_ORG } from "@/lib/demo-data";

const ORG_A = "org_a";
const ORG_B = "org_b";

function ev(partial: Partial<AuditEvent> & Pick<AuditEvent, "action">): AuditEvent {
  return {
    id: "aud",
    orgId: ORG_A,
    employeeId: "emp_1",
    credentialId: "c",
    purpose: null,
    summary: "x",
    metadata: {},
    createdAt: "2026-10-16T00:00:00.000Z",
    ...partial,
  };
}

describe("resolveAuditApproval", () => {
  test("joins same-org approvalId and shows masked approver", () => {
    const lookups = {
      orgId: ORG_A,
      membersByEmail: new Map([
        ["owner@example.com", { displayName: "山田 太郎", email: "owner@example.com" }],
      ]),
      ...indexApprovalsForOrg(ORG_A, [
        {
          id: "apr_ok",
          orgId: ORG_A,
          status: "approved",
          resolvedBy: "owner@example.com",
          employeeId: "emp_1",
          jobId: "job_1",
        },
      ]),
    };
    const view = resolveAuditApproval(
      ev({ action: "slack.posted", metadata: { approvalId: "apr_ok", tool: "comm.reply" } }),
      lookups
    );
    expect(view).toMatchObject({
      needed: true,
      status: "approved",
      approvalId: "apr_ok",
      approverName: "山田 太郎",
      approverEmailMasked: "o***@example.com",
    });
    expect(JSON.stringify(view)).not.toContain("owner@example.com");
  });

  test("does not join another tenant's ticket even if the id is planted on the row", () => {
    const lookups = {
      orgId: ORG_B,
      ...indexApprovalsForOrg(ORG_B, [
        {
          id: "apr_foreign",
          orgId: ORG_A,
          status: "approved",
          resolvedBy: "leaked@other.example",
          employeeId: "emp_x",
          jobId: "job_x",
        },
      ]),
    };
    const view = resolveAuditApproval(
      ev({
        orgId: ORG_B,
        action: "tool.invoke",
        metadata: { approvalId: "apr_foreign", tool: "comm.reply" },
      }),
      lookups
    );
    expect(view.needed).toBeNull();
    expect(view.status).toBe("unknown");
    expect(view.approverName).toBeNull();
    expect(JSON.stringify(view)).not.toContain("leaked@other.example");
  });

  test("ambiguous jobId+employee does not join", () => {
    const lookups = {
      orgId: ORG_A,
      ...indexApprovalsForOrg(ORG_A, [
        { id: "apr_1", orgId: ORG_A, status: "approved", resolvedBy: "a@x.com", employeeId: "emp_1", jobId: "job_same" },
        { id: "apr_2", orgId: ORG_A, status: "rejected", resolvedBy: "b@x.com", employeeId: "emp_1", jobId: "job_same" },
      ]),
    };
    const view = resolveAuditApproval(
      ev({ action: "tool.invoke", metadata: { jobId: "job_same", tool: "comm.reply" } }),
      lookups
    );
    expect(view.status).toBe("unknown");
    expect(view.approverName).toBeNull();
  });

  test("unique jobId+employee joins; auto ping is 不要", () => {
    const lookups = {
      orgId: ORG_A,
      ...indexApprovalsForOrg(ORG_A, [
        { id: "apr_one", orgId: ORG_A, status: "pending", resolvedBy: null, employeeId: "emp_1", jobId: "job_only" },
      ]),
    };
    expect(
      resolveAuditApproval(ev({ action: "tool.invoke", metadata: { jobId: "job_only", tool: "comm.reply" } }), lookups)
    ).toMatchObject({ needed: true, status: "pending", approvalId: "apr_one" });
    expect(
      resolveAuditApproval(ev({ action: "tool.invoke", employeeId: null, metadata: { tool: "tools.ping", auto: true } }))
    ).toMatchObject({ needed: false, status: "none" });
  });

  test("ignores a foreign ticket stuffed into the lookup map", () => {
    const view = resolveAuditApproval(
      ev({
        orgId: ORG_B,
        action: "tool.invoke",
        metadata: { approvalId: "apr_foreign" },
      }),
      {
        orgId: ORG_B,
        approvalsById: new Map([
          [
            "apr_foreign",
            {
              id: "apr_foreign",
              orgId: ORG_A,
              status: "approved",
              resolvedBy: "leaked@other.example",
              employeeId: "emp_x",
              jobId: "job_x",
            },
          ],
        ]),
      }
    );
    expect(view.approverName).toBeNull();
    expect(view.status).toBe("unknown");
    expect(JSON.stringify(view)).not.toContain("leaked@other.example");
  });

  test("old row without auto/approval stays unknown — does not guess 不要", () => {
    expect(resolveAuditApproval(ev({ action: "employee.created", metadata: {} }))).toMatchObject({
      needed: null,
      status: "unknown",
    });
  });
});

describe("listApprovalsByIds tenant filter", () => {
  test("demo tickets are not returned for a different org", async () => {
    const own = await listApprovalsByIds(DEMO_ORG.id, ["apr_1"]);
    expect(own.map((r) => r.id)).toContain("apr_1");
    expect(own.every((r) => r.orgId === DEMO_ORG.id)).toBe(true);
    const foreign = await listApprovalsByIds("org_other", ["apr_1"]);
    expect(foreign).toEqual([]);
  });

  test("does not return pollPath or statusToken on the audit lookup path", async () => {
    const own = await listApprovalsByIds(DEMO_ORG.id, ["apr_1"]);
    const blob = JSON.stringify(own);
    expect(blob).not.toContain("st_demo_apr1_status_token_aaaaaaaa");
    expect(blob).not.toContain("/api/approvals/status");
    expect(own.every((row) => row.statusToken === "" && row.pollPath === "")).toBe(true);
  });
});

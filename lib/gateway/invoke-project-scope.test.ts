import { describe, expect, test } from "bun:test";
import { getRuntimeEmployees } from "@/lib/demo-data";
import { DEMO_PROJECT_A_ID } from "@/lib/data/projects";
import { PROJECT_SCOPE_DENIED_CODE, PROJECT_SCOPE_DENIED_MESSAGE_JA } from "@/lib/employees/project-access";
import { runGatewayInvoke } from "@/lib/gateway/invoke";
import { DEMO_ORG } from "@/lib/demo-data";
import type { EmployeeProjectAccess } from "@/lib/types";

function withAccess(employeeId: string, access: EmployeeProjectAccess) {
  const employee = getRuntimeEmployees().find((item) => item.id === employeeId);
  if (!employee) throw new Error("missing employee");
  const previous = employee.projectAccess;
  employee.projectAccess = access;
  return () => {
    employee.projectAccess = previous;
  };
}

describe("Gateway project knowledge walls", () => {
  test("default hire / demo comm is company-only", () => {
    const comm = getRuntimeEmployees().find((item) => item.id === "emp_comm");
    const sales = getRuntimeEmployees().find((item) => item.id === "emp_sales");
    expect(comm?.projectAccess.mode).toBe("company");
    expect(sales?.projectAccess.mode).toBe("company");
  });

  test("company employee + project-a confidential asset on comm.send internal → 403", async () => {
    const restore = withAccess("emp_comm", { mode: "company", projectIds: [] });
    try {
      const result = await runGatewayInvoke({
        employeeId: "emp_comm",
        credentialId: "cred_comm",
        body: {
          tool: "comm.send",
          purpose: "comm.internal",
          jobId: `job_proj_comm_${Date.now()}`,
          conversation: {
            surface: "slack",
            orgId: DEMO_ORG.id,
            slackChannelId: "C_INTERNAL",
          },
          args: { assetRef: "kb/project-a-plan", slackChannelId: "C_INTERNAL" },
        },
      });
      expect(result.httpStatus).toBe(403);
      expect(result.body.code).toBe(PROJECT_SCOPE_DENIED_CODE);
      expect(result.body.message).toBe(PROJECT_SCOPE_DENIED_MESSAGE_JA);
      expect(result.body.ok).toBe(false);
    } finally {
      restore();
    }
  });

  test("company employee + project-a asset on files.read → 403 even internally", async () => {
    const result = await runGatewayInvoke({
      employeeId: "emp_comm",
      credentialId: "cred_comm",
      body: {
        tool: "files.read",
        purpose: "knowledge.lookup",
        jobId: `job_proj_files_${Date.now()}`,
        args: { assetRef: "kb/project-a-plan" },
      },
    });
    expect(result.httpStatus).toBe(403);
    expect(result.body.code).toBe(PROJECT_SCOPE_DENIED_CODE);
  });

  test("selected employee with project-a id can use that asset (class still applies)", async () => {
    const restore = withAccess("emp_comm", {
      mode: "selected",
      projectIds: [DEMO_PROJECT_A_ID],
    });
    try {
      const read = await runGatewayInvoke({
        employeeId: "emp_comm",
        credentialId: "cred_comm",
        body: {
          tool: "files.read",
          purpose: "knowledge.lookup",
          jobId: `job_proj_sel_read_${Date.now()}`,
          args: { assetRef: "kb/project-a-plan" },
        },
      });
      expect(read.body.ok).toBe(true);

      const send = await runGatewayInvoke({
        employeeId: "emp_comm",
        credentialId: "cred_comm",
        body: {
          tool: "comm.send",
          purpose: "comm.internal",
          jobId: `job_proj_sel_send_${Date.now()}`,
          conversation: {
            surface: "slack",
            orgId: DEMO_ORG.id,
            slackChannelId: "C_INTERNAL",
          },
          args: { assetRef: "kb/project-a-plan", slackChannelId: "C_INTERNAL" },
        },
      });
      expect(send.body.code).not.toBe(PROJECT_SCOPE_DENIED_CODE);
      expect(send.body.needs_approval).toBe(true);
      expect((send.body.egress as { decision?: string } | undefined)?.decision).toBe("needs_approval");
    } finally {
      restore();
    }
  });

  test("mode all can use project-a asset", async () => {
    const restore = withAccess("emp_comm", { mode: "all", projectIds: [] });
    try {
      const result = await runGatewayInvoke({
        employeeId: "emp_comm",
        credentialId: "cred_comm",
        body: {
          tool: "files.read",
          purpose: "knowledge.lookup",
          jobId: `job_proj_all_${Date.now()}`,
          args: { assetRef: "kb/project-a-plan" },
        },
      });
      expect(result.body.ok).toBe(true);
    } finally {
      restore();
    }
  });

  test("unknown asset + company mode → project_scope_denied on files.read and knowledge.search", async () => {
    const files = await runGatewayInvoke({
      employeeId: "emp_comm",
      credentialId: "cred_comm",
      body: {
        tool: "files.read",
        purpose: "knowledge.lookup",
        jobId: `job_proj_unk_files_${Date.now()}`,
        args: { assetRef: "kb/does-not-exist" },
      },
    });
    expect(files.httpStatus).toBe(403);
    expect(files.body.code).toBe(PROJECT_SCOPE_DENIED_CODE);

    const search = await runGatewayInvoke({
      employeeId: "emp_comm",
      credentialId: "cred_comm",
      body: {
        tool: "knowledge.search",
        purpose: "knowledge.lookup",
        jobId: `job_proj_unk_search_${Date.now()}`,
        args: { assetRef: "kb/does-not-exist" },
      },
    });
    expect(search.httpStatus).toBe(403);
    expect(search.body.code).toBe(PROJECT_SCOPE_DENIED_CODE);
  });

  test("knowledge.search without asset refs includes projectAccess and invents no hits", async () => {
    const result = await runGatewayInvoke({
      employeeId: "emp_comm",
      credentialId: "cred_comm",
      body: {
        tool: "knowledge.search",
        purpose: "knowledge.lookup",
        jobId: `job_proj_search_empty_${Date.now()}`,
        args: { query: "新規事業" },
      },
    });
    expect(result.body.ok).toBe(true);
    expect((result.body.projectAccess as { mode?: string } | undefined)?.mode).toBe("company");
    const payload = result.body.result as { hits?: unknown[]; projectAccess?: { mode?: string } };
    expect(payload.hits).toEqual([]);
    expect(payload.projectAccess?.mode).toBe("company");
  });
});

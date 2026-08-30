import { describe, expect, test } from "bun:test";
import { getRuntimeEmployees } from "@/lib/demo-data";
import { runGatewayInvoke } from "@/lib/gateway/invoke";
import { DEMO_ORG } from "@/lib/demo-data";
import { evaluateSod } from "@/lib/employees/sod";
import { DEFAULT_SPEND_LIMITS } from "@/lib/spend-gate";

describe("Gateway SoD integration", () => {
  test("money+send warn does not blanket mail.draft when risk_based", async () => {
    const sales = getRuntimeEmployees().find((item) => item.id === "emp_sales");
    expect(sales).toBeTruthy();
    const previousScopes = [...sales!.scopes];
    const previousPolicy = sales!.approvalPolicy;
    const previousHints = sales!.toolApprovalDefaults;
    sales!.scopes = [...previousScopes, "commerce:order"];
    sales!.approvalPolicy = "risk_based";
    sales!.toolApprovalDefaults = {
      "mail.send": "always_human",
      "calendar.confirm": "always_human",
      "commerce.order": "always_human",
    };
    try {
      expect(evaluateSod(sales!.scopes).level).toBe("warn");
      const result = await runGatewayInvoke({
        employeeId: "emp_sales",
        credentialId: "cred_sales",
        body: {
          tool: "mail.draft",
          purpose: "sales.outreach",
          jobId: `job_sod_${Date.now()}`,
        },
      });
      expect(result.body.ok).toBe(true);
      expect(result.body.needs_approval).not.toBe(true);
    } finally {
      sales!.scopes = previousScopes;
      sales!.approvalPolicy = previousPolicy;
      sales!.toolApprovalDefaults = previousHints;
    }
  });

  test("always_human employee still queues mail.draft (employee policy, not SoD)", async () => {
    const sales = getRuntimeEmployees().find((item) => item.id === "emp_sales");
    expect(sales).toBeTruthy();
    const previousScopes = [...sales!.scopes];
    const previousPolicy = sales!.approvalPolicy;
    sales!.scopes = [...previousScopes, "commerce:order"];
    sales!.approvalPolicy = "always_human";
    try {
      const result = await runGatewayInvoke({
        employeeId: "emp_sales",
        credentialId: "cred_sales",
        body: {
          tool: "mail.draft",
          purpose: "sales.outreach",
          jobId: `job_sod_human_${Date.now()}`,
        },
      });
      expect(result.httpStatus).toBe(402);
      expect(result.body.needs_approval).toBe(true);
      expect(String(result.body.summary ?? "")).not.toContain("権限混在社員");
    } finally {
      sales!.scopes = previousScopes;
      sales!.approvalPolicy = previousPolicy;
    }
  });

  test("send+confirm sibling scopes do not force comm.reply when risk_based", async () => {
    const comm = getRuntimeEmployees().find((item) => item.id === "emp_comm");
    expect(comm).toBeTruthy();
    const previousScopes = [...comm!.scopes];
    const previousPolicy = comm!.approvalPolicy;
    const previousHints = comm!.toolApprovalDefaults;
    comm!.scopes = [...previousScopes, "mail:send", "calendar:confirm"];
    comm!.approvalPolicy = "risk_based";
    comm!.toolApprovalDefaults = {
      "mail.send": "always_human",
      "calendar.confirm": "always_human",
    };
    try {
      const result = await runGatewayInvoke({
        employeeId: "emp_comm",
        credentialId: "cred_comm",
        body: {
          tool: "comm.reply",
          purpose: "comm.internal",
          jobId: `job_sod_reply_${Date.now()}`,
          conversation: {
            surface: "slack",
            orgId: DEMO_ORG.id,
            slackChannelId: "C_INTERNAL",
          },
          args: { slackChannelId: "C_INTERNAL", text: "社内メンションへの返信です。" },
        },
      });
      expect(result.body.ok).toBe(true);
      expect(result.body.needs_approval).not.toBe(true);

      const send = await runGatewayInvoke({
        employeeId: "emp_comm",
        credentialId: "cred_comm",
        body: {
          tool: "mail.send",
          purpose: "comm.internal",
          jobId: `job_sod_send_${Date.now()}`,
        },
      });
      expect(send.httpStatus).toBe(402);
      expect(send.body.needs_approval).toBe(true);
    } finally {
      comm!.scopes = previousScopes;
      comm!.approvalPolicy = previousPolicy;
      comm!.toolApprovalDefaults = previousHints;
    }
  });

  test("commerce.order auto hint actually runs when spend allows", async () => {
    const sales = getRuntimeEmployees().find((item) => item.id === "emp_sales");
    expect(sales).toBeTruthy();
    const previousScopes = [...sales!.scopes];
    const previousPolicy = sales!.approvalPolicy;
    const previousHints = sales!.toolApprovalDefaults;
    const previousSpend = sales!.spend;
    sales!.scopes = [...previousScopes, "commerce:order"];
    sales!.approvalPolicy = "risk_based";
    sales!.toolApprovalDefaults = {
      ...(sales!.toolApprovalDefaults ?? {}),
      "commerce.order": "auto",
    };
    sales!.spend = { ...DEFAULT_SPEND_LIMITS, firstOrderRequiresHuman: false };
    try {
      const result = await runGatewayInvoke({
        employeeId: "emp_sales",
        credentialId: "cred_sales",
        body: {
          tool: "commerce.order",
          purpose: "sales.outreach",
          jobId: `job_sod_order_auto_${Date.now()}`,
          amountJpy: 1000,
          isFirstOrder: false,
        },
      });
      expect(result.body.ok).toBe(true);
      expect(result.body.needs_approval).not.toBe(true);
    } finally {
      sales!.scopes = previousScopes;
      sales!.approvalPolicy = previousPolicy;
      sales!.toolApprovalDefaults = previousHints;
      sales!.spend = previousSpend;
    }
  });

  test("money+destructive sibling scopes do not force comm.reply when risk_based", async () => {
    const comm = getRuntimeEmployees().find((item) => item.id === "emp_comm");
    expect(comm).toBeTruthy();
    const previousScopes = [...comm!.scopes];
    const previousPolicy = comm!.approvalPolicy;
    const previousHints = comm!.toolApprovalDefaults;
    comm!.scopes = [...previousScopes, "commerce:order", "files:write"];
    comm!.approvalPolicy = "risk_based";
    comm!.toolApprovalDefaults = {
      "commerce.order": "always_human",
      "files.write": "always_human",
    };
    try {
      expect(evaluateSod(comm!.scopes).level).toBe("warn");
      const result = await runGatewayInvoke({
        employeeId: "emp_comm",
        credentialId: "cred_comm",
        body: {
          tool: "comm.reply",
          purpose: "comm.internal",
          jobId: `job_sod_money_reply_${Date.now()}`,
          conversation: {
            surface: "slack",
            orgId: DEMO_ORG.id,
            slackChannelId: "C_INTERNAL",
          },
          args: { slackChannelId: "C_INTERNAL", text: "社内メンションへの返信です。" },
        },
      });
      expect(result.body.ok).toBe(true);
      expect(result.body.needs_approval).not.toBe(true);
    } finally {
      comm!.scopes = previousScopes;
      comm!.approvalPolicy = previousPolicy;
      comm!.toolApprovalDefaults = previousHints;
    }
  });

  test("files.write auto hint runs under risk_based", async () => {
    const comm = getRuntimeEmployees().find((item) => item.id === "emp_comm");
    expect(comm).toBeTruthy();
    const previousScopes = [...comm!.scopes];
    const previousPolicy = comm!.approvalPolicy;
    const previousHints = comm!.toolApprovalDefaults;
    comm!.scopes = [...previousScopes, "files:write"];
    comm!.approvalPolicy = "risk_based";
    comm!.toolApprovalDefaults = { "files.write": "auto" };
    try {
      const result = await runGatewayInvoke({
        employeeId: "emp_comm",
        credentialId: "cred_comm",
        body: {
          tool: "files.write",
          purpose: "comm.internal",
          jobId: `job_sod_write_auto_${Date.now()}`,
        },
      });
      expect(result.body.ok).toBe(true);
      expect(result.body.needs_approval).not.toBe(true);
    } finally {
      comm!.scopes = previousScopes;
      comm!.approvalPolicy = previousPolicy;
      comm!.toolApprovalDefaults = previousHints;
    }
  });
});

import { describe, expect, test } from "bun:test";
import { getRuntimeEmployees } from "@/lib/demo-data";
import { runGatewayInvoke } from "@/lib/gateway/invoke";
import { DEMO_ORG } from "@/lib/demo-data";

describe("Gateway SoD integration", () => {
  test("force_human mixed money+send still blankets mail.draft when always_human", async () => {
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
          jobId: `job_sod_${Date.now()}`,
        },
      });

      expect(result.httpStatus).toBe(402);
      expect(result.body.needs_approval).toBe(true);
      expect(result.body.risk).toBe("high");
      expect(String(result.body.summary)).toContain("権限混在社員");
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
});

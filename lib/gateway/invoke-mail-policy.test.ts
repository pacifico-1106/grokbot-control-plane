/**
 * B1 mail.policy × Gateway approval gate integration.
 *
 * Regression: mail policy `sendMode: auto` (with highRiskConsent) must only
 * lift the tool-level always-human default for mail.send. It must NOT
 * override stricter, independent guards:
 *   - employee.approvalPolicy === "always_human"
 *   - explicit per-tool hint toolApprovalDefaults["mail.send"] === "always_human"
 *   - action limit reached (actionLimit.decision === "needs_approval")
 * Stricter side wins (fail-closed). Dummy recipients only; demo mode, no network.
 */
import { describe, expect, test } from "bun:test";
import { DEMO_ORG, getRuntimeEmployees } from "@/lib/demo-data";
import { runGatewayInvoke } from "@/lib/gateway/invoke";
import { resetDemoMailPolicy, setOrgMailPolicy } from "@/lib/data/mail-policy";
import { getActionCounts, incrementActionCounter } from "@/lib/data/action-counters";
import { normalizeMailPolicy } from "@/lib/mail-policy/validate";
import type { Employee } from "@/lib/types";

async function withAutoConsentedMailPolicy<T>(fn: () => Promise<T>): Promise<T> {
  await setOrgMailPolicy(
    DEMO_ORG.id,
    normalizeMailPolicy({
      policyId: "mpp_test_auto_consented",
      policyName: "Test Auto (consented)",
      rules: [{ id: "mpr_any_auto", audience: "any", sendMode: "auto" }],
      highRiskConsentAt: "2026-10-01T00:00:00Z",
      highRiskConsentBy: "admin@dummy.example",
    })
  );
  try {
    return await fn();
  } finally {
    resetDemoMailPolicy();
  }
}

async function withSalesEmployee<T>(
  patch: Partial<Pick<Employee, "approvalPolicy" | "toolApprovalDefaults" | "actionLimits">>,
  fn: (employee: Employee) => Promise<T>
): Promise<T> {
  const sales = getRuntimeEmployees().find((item) => item.id === "emp_sales");
  expect(sales).toBeTruthy();
  const previous = {
    approvalPolicy: sales!.approvalPolicy,
    toolApprovalDefaults: sales!.toolApprovalDefaults,
    actionLimits: sales!.actionLimits,
  };
  Object.assign(sales!, patch);
  try {
    return await fn(sales!);
  } finally {
    Object.assign(sales!, previous);
  }
}

function sendMail(jobSuffix: string) {
  return runGatewayInvoke({
    employeeId: "emp_sales",
    credentialId: "cred_sales",
    body: {
      tool: "mail.send",
      purpose: "sales.outreach",
      jobId: `job_mail_policy_${jobSuffix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      args: {
        assetRef: "kb/public-faq",
        to: "buyer@customer.example",
        subject: "フォロー",
        body: "ご確認ください。",
      },
    },
  });
}

function expectQueuedNotSent(result: Awaited<ReturnType<typeof runGatewayInvoke>>) {
  expect(result.httpStatus).toBe(402);
  expect(result.body.needs_approval).toBe(true);
  const sent = (result.body.result as { sent?: boolean } | undefined)?.sent;
  expect(sent).not.toBe(true);
}

describe("mail.send: mail policy auto does not override stricter guards", () => {
  test("always_human employee still needs approval under consented auto mail policy", async () => {
    await withSalesEmployee({ approvalPolicy: "always_human", toolApprovalDefaults: undefined }, () =>
      withAutoConsentedMailPolicy(async () => {
        expectQueuedNotSent(await sendMail("always_human"));
      })
    );
  });

  test("explicit per-tool hint always_human still needs approval under consented auto mail policy", async () => {
    await withSalesEmployee(
      { approvalPolicy: "risk_based", toolApprovalDefaults: { "mail.send": "always_human" } },
      () =>
        withAutoConsentedMailPolicy(async () => {
          expectQueuedNotSent(await sendMail("hint_always_human"));
        })
    );
  });

  test("per-tool hint deny is never lifted by consented auto mail policy", async () => {
    await withSalesEmployee(
      { approvalPolicy: "risk_based", toolApprovalDefaults: { "mail.send": "deny" } },
      () =>
        withAutoConsentedMailPolicy(async () => {
          // Follow-up hardening: deny is now an immediate reject (stricter than queueing).
          const result = await sendMail("hint_deny");
          expect(result.httpStatus).toBe(403);
          expect(result.body.code).toBe("mail_send_denied_by_tool_setting");
          expect((result.body.result as { sent?: boolean } | undefined)?.sent).not.toBe(true);
        })
    );
  });

  test("action limit reached still needs approval under consented auto mail policy", async () => {
    await withSalesEmployee(
      { approvalPolicy: "risk_based", toolApprovalDefaults: undefined },
      async (employee) => {
        const counter = { orgId: employee.orgId, employeeId: employee.id, tool: "mail.send" };
        if ((await getActionCounts(counter)).countToday === 0) {
          await incrementActionCounter({ ...counter, jobId: `job_mail_policy_seed_${Date.now()}` });
        }
        // limit == today's count → "reached" (needs_approval), below the 2x hard stop (deny).
        const { countToday } = await getActionCounts(counter);
        employee.actionLimits = { "mail.send": { perDay: countToday } };
        await withAutoConsentedMailPolicy(async () => {
          const result = await sendMail("action_limit");
          expectQueuedNotSent(result);
          expect((result.body.actionLimit as { decision?: string } | undefined)?.decision).toBe(
            "needs_approval"
          );
        });
      }
    );
  });

  test("consented auto still auto-sends for risk_based employee within limits (intended B1 behavior kept)", async () => {
    await withSalesEmployee(
      { approvalPolicy: "risk_based", toolApprovalDefaults: undefined, actionLimits: undefined },
      () =>
        withAutoConsentedMailPolicy(async () => {
          const result = await sendMail("auto_ok");
          expect(result.httpStatus).toBe(200);
          expect(result.body.ok).toBe(true);
          expect(result.body.needs_approval).not.toBe(true);
        })
    );
  });

  test("auto without consent still needs approval (regression)", async () => {
    await withSalesEmployee(
      { approvalPolicy: "risk_based", toolApprovalDefaults: { "mail.send": "auto" }, actionLimits: undefined },
      async () => {
        await setOrgMailPolicy(
          DEMO_ORG.id,
          normalizeMailPolicy({
            policyId: "mpp_test_auto_no_consent",
            policyName: "Test Auto (no consent)",
            rules: [{ id: "mpr_any_auto", audience: "any", sendMode: "auto" }],
          })
        );
        try {
          expectQueuedNotSent(await sendMail("auto_no_consent"));
        } finally {
          resetDemoMailPolicy();
        }
      }
    );
  });
});

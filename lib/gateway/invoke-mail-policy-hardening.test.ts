/**
 * Mail policy hardening at the Gateway invoke boundary (follow-up to PR #223).
 * - concern 5: toolApprovalDefaults["mail.send"] === "deny" rejects immediately
 *   (before: queued for approval, or even auto-sent / demoted).
 * - concern 2/3 wiring: cc / bcc reach the evaluator; unreadable recipient
 *   containers and non-string `to` fail closed.
 * Demo mode, dummy recipients, no network.
 */
import { describe, expect, test } from "bun:test";
import { DEMO_ORG, getRuntimeEmployees } from "@/lib/demo-data";
import { runGatewayInvoke } from "@/lib/gateway/invoke";
import { resetDemoMailPolicy, setOrgMailPolicy } from "@/lib/data/mail-policy";
import { normalizeMailPolicy } from "@/lib/mail-policy/validate";
import type { Employee, MailPolicyRule } from "@/lib/types";

const CONSENT = { highRiskConsentAt: "2026-10-01T00:00:00Z", highRiskConsentBy: "admin@dummy.example" };

async function withMailPolicy<T>(
  rules: Partial<MailPolicyRule>[] | null,
  fn: () => Promise<T>,
  consent = true
): Promise<T> {
  if (rules) {
    await setOrgMailPolicy(
      DEMO_ORG.id,
      normalizeMailPolicy({
        policyId: "mpp_hardening_invoke",
        policyName: "Hardening invoke",
        rules: rules.map((r, i) => ({ id: `mpr_${i}`, sendMode: "draft_only", ...r })),
        ...(consent ? CONSENT : {}),
      })
    );
  } else {
    resetDemoMailPolicy();
  }
  try {
    return await fn();
  } finally {
    resetDemoMailPolicy();
  }
}

async function withSales<T>(
  patch: Partial<Pick<Employee, "approvalPolicy" | "toolApprovalDefaults" | "actionLimits">>,
  fn: () => Promise<T>
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
    return await fn();
  } finally {
    Object.assign(sales!, previous);
  }
}

function invoke(tool: "mail.send" | "mail.draft", args: Record<string, unknown>, suffix: string) {
  return runGatewayInvoke({
    employeeId: "emp_sales",
    credentialId: "cred_sales",
    body: {
      tool,
      purpose: "sales.outreach",
      jobId: `job_mail_hardening_${suffix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      args: { assetRef: "kb/public-faq", subject: "フォロー", body: "ご確認ください。", ...args },
    },
  });
}

const RISK_BASED = { approvalPolicy: "risk_based" as const, actionLimits: undefined };

describe("concern 5: per-tool deny on mail.send rejects immediately", () => {
  const deny = { ...RISK_BASED, toolApprovalDefaults: { "mail.send": "deny" as const } };

  test("deny + consented auto policy → 403 (before: 402 approval on #223, 200 sent on main)", async () => {
    await withSales(deny, () =>
      withMailPolicy([{ audience: "any", sendMode: "auto" }], async () => {
        const r = await invoke("mail.send", { to: "buyer@customer.example" }, "deny_auto");
        expect(r.httpStatus).toBe(403);
        expect(r.body.code).toBe("mail_send_denied_by_tool_setting");
        expect(r.body.needs_approval).toBe(false);
      })
    );
  });

  test("deny + needs_approval policy → 403 (before: 402)", async () => {
    await withSales(deny, () =>
      withMailPolicy([{ audience: "any", sendMode: "needs_approval" }], async () => {
        const r = await invoke("mail.send", { to: "buyer@customer.example" }, "deny_na");
        expect(r.httpStatus).toBe(403);
        expect(r.body.code).toBe("mail_send_denied_by_tool_setting");
      })
    );
  });

  test("deny + default policy (external draft_only) → 403, not a demoted draft (before: 200 demoted)", async () => {
    await withSales(deny, () =>
      withMailPolicy(null, async () => {
        const r = await invoke("mail.send", { to: "buyer@customer.example" }, "deny_default");
        expect(r.httpStatus).toBe(403);
        expect(r.body.code).toBe("mail_send_denied_by_tool_setting");
      })
    );
  });

  test("deny on mail.send does not block mail.draft", async () => {
    await withSales(deny, () =>
      withMailPolicy(null, async () => {
        const r = await invoke("mail.draft", { to: "buyer@customer.example" }, "deny_draft_ok");
        expect(r.body.ok).toBe(true);
      })
    );
  });

  test("control: risk_based without deny under consented auto still auto-sends", async () => {
    await withSales({ ...RISK_BASED, toolApprovalDefaults: undefined }, () =>
      withMailPolicy([{ audience: "any", sendMode: "auto" }], async () => {
        const r = await invoke("mail.send", { to: "buyer@customer.example", cc: ["c@customer.example"] }, "auto_ok");
        expect(r.httpStatus).toBe(200);
        expect(r.body.ok).toBe(true);
      })
    );
  });
});

describe("concern 2/3 at invoke: every recipient reaches the policy, unreadable input fails closed", () => {
  const auto = { ...RISK_BASED, toolApprovalDefaults: undefined };

  test("denylisted CC → 403 mail_domain_denied (before: 200 sent)", async () => {
    await withSales(auto, () =>
      withMailPolicy([{ audience: "any", sendMode: "auto", toDomainDenylist: ["blocked.example"] }], async () => {
        const r = await invoke("mail.send", { to: "buyer@customer.example", cc: ["z@blocked.example"] }, "cc_deny");
        expect(r.httpStatus).toBe(403);
        expect(r.body.code).toBe("mail_domain_denied");
      })
    );
  });

  test("multi-address to string with a denylisted address → 403 (before: 200 sent)", async () => {
    await withSales(auto, () =>
      withMailPolicy([{ audience: "any", sendMode: "auto", toDomainDenylist: ["blocked.example"] }], async () => {
        const r = await invoke("mail.send", { to: "z@blocked.example, buyer@customer.example" }, "multi_to");
        expect(r.httpStatus).toBe(403);
        expect(r.body.code).toBe("mail_domain_denied");
      })
    );
  });

  test("cc with non-string entries → 403 mail_recipient_invalid (before: entries dropped, 200 sent)", async () => {
    await withSales(auto, () =>
      withMailPolicy([{ audience: "any", sendMode: "auto", toDomainDenylist: ["blocked.example"] }], async () => {
        const r = await invoke(
          "mail.send",
          { to: "buyer@customer.example", cc: [{ email: "z@blocked.example" }] },
          "cc_object"
        );
        expect(r.httpStatus).toBe(403);
        expect(r.body.code).toBe("mail_recipient_invalid");
      })
    );
  });

  test("non-string `to` is rejected even if another recipient field is present (before: fell back, 200 sent)", async () => {
    await withSales(auto, () =>
      withMailPolicy([{ audience: "any", sendMode: "auto", toDomainDenylist: ["blocked.example"] }], async () => {
        const r = await invoke(
          "mail.send",
          { to: ["z@blocked.example"], recipient: "buyer@customer.example" },
          "to_array"
        );
        expect(r.httpStatus).toBe(400);
        expect(r.body.code).toBe("mail_recipient_invalid");
      })
    );
  });

  test("to without a domain → 403 mail_recipient_invalid (before: allowlist skipped, approval/sent)", async () => {
    await withSales(auto, () =>
      withMailPolicy([{ audience: "any", sendMode: "auto", toDomainAllowlist: ["customer.example"] }], async () => {
        const r = await invoke("mail.send", { to: "buyer" }, "no_domain");
        expect(r.httpStatus).toBe(403);
        expect(r.body.code).toBe("mail_recipient_invalid");
      })
    );
  });
});

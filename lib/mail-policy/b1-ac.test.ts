/**
 * P0-B1 mail.policy acceptance criteria tests.
 * B1-1 through B1-6 per Yasaka GO 2026-09-15.
 */
import { describe, expect, test } from "bun:test";
import {
  evaluateMailPolicy,
  resolveMailAttachmentPolicy,
} from "./apply";
import {
  normalizeMailPolicy,
  validateMailPolicy,
  defaultMailPolicy,
} from "./validate";
import type { MailPolicyRule, OrgIngressHandoffPolicy, OrgMailPolicy } from "@/lib/types";

function makePolicy(
  rules: Partial<MailPolicyRule>[],
  extras: Partial<OrgMailPolicy> = {}
): OrgMailPolicy {
  return normalizeMailPolicy({
    policyId: "mpp_b1_test",
    policyName: "B1 Test Policy",
    rules: rules.map((r, i) => ({
      id: `mpr_${i}`,
      sendMode: "draft_only",
      ...r,
    })),
    ...extras,
  });
}

function d1Policy(
  attachment: "file" | "meta" | "none",
  sealith: "off" | "suggest" | "required"
): OrgIngressHandoffPolicy {
  return {
    version: 1,
    policyId: "ihp_test",
    policyName: "D1 Test",
    rules: [
      {
        id: "ihr_0",
        applyTo: "all",
        body: "full",
        attachment,
        sealith,
        audit: { jobId: true, sealithTransferId: false },
      },
    ],
    updatedAt: new Date().toISOString(),
    updatedBy: "admin_mcp",
  };
}

describe("B1-1: default external no real send", () => {
  test("default policy demotes external mail.send to draft", () => {
    const policy = defaultMailPolicy();
    const result = evaluateMailPolicy({
      policy,
      to: "client@external.example",
    });
    expect(result.demotedToDraft).toBe(true);
    expect(result.code).toBe("mail_send_demoted_to_draft");
    expect(result.sendMode).toBe("draft_only");
    expect(result.audience).toBe("external");
    expect(result.rejected).toBe(false);
  });
});

describe("B1-2: needs_approval shows card fields", () => {
  test("needs_approval mode does not demote", () => {
    const policy = makePolicy([
      { audience: "external", sendMode: "needs_approval" },
    ]);
    const result = evaluateMailPolicy({
      policy,
      to: "client@external.example",
      hasAttachments: true,
    });
    expect(result.demotedToDraft).toBe(false);
    expect(result.needsApproval).toBe(true);
    expect(result.sendMode).toBe("needs_approval");
    expect(result.attachmentAllowed).toBe(true);
  });
});

describe("B1-3: approve fulfill audit fields", () => {
  test("needs_approval decision includes sendMode for audit", () => {
    const policy = makePolicy([
      { audience: "external", sendMode: "needs_approval" },
    ]);
    const result = evaluateMailPolicy({
      policy,
      to: "client@external.example",
    });
    expect(result.sendMode).toBe("needs_approval");
    expect(result.appliedRules.length).toBeGreaterThan(0);
    expect(result.auditLabels).toContain("sendMode:needs_approval");
  });
});

describe("B1-4: auto without consent cannot patch", () => {
  test("auto sendMode without consent fails validation", () => {
    const result = validateMailPolicy(
      {
        rules: [{ sendMode: "auto", audience: "external" }],
      },
      { requireHighRiskConsent: true }
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "high_risk_consent_required")).toBe(true);
    }
  });

  test("auto with consent passes validation", () => {
    const result = validateMailPolicy(
      {
        rules: [{ sendMode: "auto", audience: "external" }],
        highRiskConsentAt: "2026-09-15T00:00:00Z",
        highRiskConsentBy: "admin@example.com",
      },
      { requireHighRiskConsent: true }
    );
    expect(result.ok).toBe(true);
  });
});

describe("B1-5: denylist fail-closed", () => {
  test("denylisted domain is rejected", () => {
    const policy = makePolicy([
      {
        audience: "external",
        sendMode: "needs_approval",
        toDomainDenylist: ["blocked.example"],
      },
    ]);
    const result = evaluateMailPolicy({
      policy,
      to: "user@blocked.example",
    });
    expect(result.rejected).toBe(true);
    expect(result.rejectCode).toBe("mail_domain_denied");
    expect(result.demotedToDraft).toBe(false);
  });
});

describe("B1-6: D1 conflict stricter wins", () => {
  test("mail inherit_d1 + D1 attachment none → forbid", () => {
    const result = resolveMailAttachmentPolicy(
      "inherit_d1",
      d1Policy("none", "off"),
      true
    );
    expect(result.allowed).toBe(false);
    expect(result.effective).toBe("forbid");
  });

  test("mail forbid wins over D1 file", () => {
    const result = resolveMailAttachmentPolicy(
      "forbid",
      d1Policy("file", "off"),
      true
    );
    expect(result.allowed).toBe(false);
    expect(result.effective).toBe("forbid");
  });

  test("mail inherit_d1 + D1 sealith required without transferId → reject", () => {
    const result = resolveMailAttachmentPolicy(
      "inherit_d1",
      d1Policy("file", "required"),
      true,
      null
    );
    expect(result.allowed).toBe(false);
    expect(result.effective).toBe("sealith_required");
  });

  test("evaluateMailPolicy rejects attachment when D1 stricter", () => {
    const policy = makePolicy([
      {
        audience: "external",
        sendMode: "needs_approval",
        attachmentPolicyRef: "inherit_d1",
      },
    ]);
    const result = evaluateMailPolicy({
      policy,
      to: "client@external.example",
      hasAttachments: true,
      ingressHandoffPolicy: d1Policy("none", "off"),
    });
    expect(result.rejected).toBe(true);
    expect(result.rejectCode).toBe("d1_attachment_none");
  });
});

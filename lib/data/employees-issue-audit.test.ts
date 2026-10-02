import { expect, test } from "bun:test";
import { DEMO_ORG, getRuntimeAudit } from "../demo-data";
import { issueEmployee } from "./employees";

/**
 * credential.issued must name who issued the 社員証 and carry only a 12-char
 * hash prefix (same shape as credential.rotated) — never the secret or full hash.
 */
test("credential.issued audit row carries actor + 12-char hash prefix only", async () => {
  const secretHash = "a".repeat(12) + "b".repeat(52);
  const result = await issueEmployee({
    orgId: DEMO_ORG.id,
    displayName: "監査テスト",
    roleLabel: "営業",
    jobDescription: "",
    scopes: ["tools:read"],
    allowedPurposes: [],
    approvalPolicy: "always_human",
    spend: null,
    allowedAccounts: [],
    secretHash,
    secretPrefix: "gb_emp_test",
    expiresAt: null,
    auditSummary: "監査テスト の社員証を発行",
    actorEmail: "admin@example.com",
    actorMemberId: "mem_admin",
  });
  const row = getRuntimeAudit().find(
    (r) => r.action === "credential.issued" && r.employeeId === result.employee.id
  );
  expect(row).toBeDefined();
  const meta = row!.metadata as Record<string, unknown>;
  expect(meta.secretHashPrefix).toBe("a".repeat(12));
  expect(meta.actorMemberId).toBe("mem_admin");
  expect(meta.actorEmail).toBe("admin@example.com");
  expect(JSON.stringify(row)).not.toContain(secretHash);
});

/**
 * Dedup store for the 社員証 pre-expiry notice (demo / in-memory path; the
 * production table + its unique key and same-org trigger are covered by
 * tests/security/db-credential-expiry-notices.sql). Org-scoped counts.
 */
import { describe, expect, test } from "bun:test";
import {
  claimCredentialExpiryNotice,
  countRecentCredentialExpiryNotices,
  releaseCredentialExpiryNotice,
  resetDemoCredentialExpiryNotices,
} from "./credential-expiry-notices";

const A = { credentialId: "cred_a1", orgId: "org_a", employeeId: "emp_a1", expiresAt: "2026-10-19T00:00:00Z" };
const B = { credentialId: "cred_b1", orgId: "org_b", employeeId: "emp_b1", expiresAt: "2026-10-19T00:00:00Z" };

describe("credential expiry notice store (demo)", () => {
  test("claim once per credential × threshold; release reopens", async () => {
    resetDemoCredentialExpiryNotices();
    expect(await claimCredentialExpiryNotice(A, "7d")).toBe("claimed");
    expect(await claimCredentialExpiryNotice(A, "7d")).toBe("duplicate");
    expect(await claimCredentialExpiryNotice(A, "1d")).toBe("claimed");
    await releaseCredentialExpiryNotice(A, "7d");
    expect(await claimCredentialExpiryNotice(A, "7d")).toBe("claimed");
  });
  test("counts are per org and per window", async () => {
    resetDemoCredentialExpiryNotices();
    await claimCredentialExpiryNotice(A, "7d");
    await claimCredentialExpiryNotice(A, "1d");
    await claimCredentialExpiryNotice(B, "7d");
    const since = new Date(Date.now() - 60_000);
    expect(await countRecentCredentialExpiryNotices("org_a", since)).toBe(2);
    expect(await countRecentCredentialExpiryNotices("org_b", since)).toBe(1);
    expect(await countRecentCredentialExpiryNotices("org_a", new Date(Date.now() + 60_000))).toBe(0);
  });
  test("release is scoped to the credential's own org", async () => {
    resetDemoCredentialExpiryNotices();
    await claimCredentialExpiryNotice(A, "7d");
    await releaseCredentialExpiryNotice({ ...A, orgId: "org_b" }, "7d");
    expect(await claimCredentialExpiryNotice(A, "7d")).toBe("duplicate");
  });
});

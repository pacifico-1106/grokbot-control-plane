/**
 * 八坂さん 2026-10-12: 社員証 default expiry 90 days (range 1–365 unchanged);
 * rotate / reissue pickup = now + 90 days; no backfill of existing null rows.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EMPLOYEE_CREDENTIAL_TTL_DAYS, credentialExpiresAtFromNow, issueExpiryDays } from "@/lib/employees/credential-ttl";
import { buildEmployeePolicyDraft } from "@/lib/employees/policy-draft";

const DAY = 86_400_000;
const NOW = new Date("2026-10-12T00:00:00.000Z");

describe("credential TTL", () => {
  test("default 90 days; explicit 1–365 kept; out of range clamped as before", () => {
    expect(EMPLOYEE_CREDENTIAL_TTL_DAYS).toBe(90);
    expect(issueExpiryDays(undefined)).toBe(90);
    expect(issueExpiryDays(null)).toBe(90);
    expect(issueExpiryDays(0)).toBe(90);
    expect(issueExpiryDays("abc")).toBe(90);
    expect(issueExpiryDays(1)).toBe(1);
    expect(issueExpiryDays(30)).toBe(30);
    expect(issueExpiryDays(365)).toBe(365);
    expect(issueExpiryDays(400)).toBe(365);
    expect(issueExpiryDays(-5)).toBe(1);
  });
  test("credentialExpiresAtFromNow: now + days (default 90)", () => {
    expect(credentialExpiresAtFromNow(NOW)).toBe(new Date(NOW.getTime() + 90 * DAY).toISOString());
    expect(credentialExpiresAtFromNow(NOW, 7)).toBe(new Date(NOW.getTime() + 7 * DAY).toISOString());
  });
  test("job-text draft defaults to 90 days and says so", () => {
    const d = buildEmployeePolicyDraft("営業のメール下書きを手伝う");
    expect(d.policy.expiresInDays).toBe(90);
    expect(d.assumptions.join("\n")).toContain("90日後");
    expect(d.assumptions.join("\n")).not.toContain("30日後");
  });
});

describe("no backfill: existing credentials keep their (null) expires_at", () => {
  test("no migration updates credentials.expires_at", () => {
    const dir = join(process.cwd(), "supabase/migrations");
    const offenders = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .filter((f) => /update\s+(public\.)?credentials\b[\s\S]{0,400}?\bexpires_at\b/i.test(readFileSync(join(dir, f), "utf8")));
    expect(offenders).toEqual([]);
  });
  test("no app code writes expires_at onto an existing credentials row (only the insert of a new row)", () => {
    const src = readFileSync(join(process.cwd(), "lib/data/bindings.ts"), "utf8");
    const updates = src.match(/\.from\("credentials"\)\s*\.update\(\{[^}]*\}\)/g) ?? [];
    expect(updates.length).toBeGreaterThan(0);
    for (const u of updates) expect(u).not.toContain("expires_at");
  });
});

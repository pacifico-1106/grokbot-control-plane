/**
 * CREDENTIAL_AUTO_RENEW_ENABLED (default OFF) + org allowlist (fail-closed).
 * R1: flags / types / schema only — no cron, HTTP, or MCP wiring.
 *
 * Fail-first: before the module and flag helpers exist this file cannot load;
 * after a stub that is not fail-closed, the cases below fail on assertion.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  isCredentialAutoRenewEnabled,
  isCredentialAutoRenewOrgAllowlistRequired,
} from "@/lib/feature-flags";
import { ADMIN_MCP_TOOL_NAMES } from "@/lib/mcp/admin-public";
import {
  CREDENTIAL_AUTO_RENEW_ADMIN_TOOL,
  CREDENTIAL_AUTO_RENEW_CLAIM_WINDOW_MS,
  CREDENTIAL_AUTO_RENEW_MODES,
  CREDENTIAL_AUTO_RENEW_OVERLAP_WINDOW_MS,
  CREDENTIAL_AUTO_RENEW_STATES,
  CREDENTIAL_AUTO_RENEW_THRESHOLDS,
  isCredentialAutoRenewOnForOrg,
} from "./credential-auto-renew";

const FLAG = "CREDENTIAL_AUTO_RENEW_ENABLED";
const ALLOWLIST = "CREDENTIAL_AUTO_RENEW_ORG_ALLOWLIST";
const REQUIRED = "CREDENTIAL_AUTO_RENEW_ORG_ALLOWLIST_REQUIRED";
const ENV_KEYS = [FLAG, ALLOWLIST, REQUIRED] as const;

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
const SPACE_TREE = "6d134a38-a0ab-4a8e-aba7-3202650ff523";
const INAMORI_PREFIX = "9a795dfd";

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => restoreEnv());

function restoreEnv() {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}

function src(rel: string): string {
  return readFileSync(resolve(rel), "utf8");
}

describe("CREDENTIAL_AUTO_RENEW flags (default OFF, fail-closed)", () => {
  test("unset / empty / garbage → global OFF", () => {
    expect(isCredentialAutoRenewEnabled()).toBe(false);
    process.env[FLAG] = "";
    expect(isCredentialAutoRenewEnabled()).toBe(false);
    process.env[FLAG] = "false";
    expect(isCredentialAutoRenewEnabled()).toBe(false);
    process.env[FLAG] = "yes";
    expect(isCredentialAutoRenewEnabled()).toBe(false);
  });

  test("true / 1 / on / enabled → global ON", () => {
    process.env[FLAG] = "true";
    expect(isCredentialAutoRenewEnabled()).toBe(true);
    process.env[FLAG] = "1";
    expect(isCredentialAutoRenewEnabled()).toBe(true);
    process.env[FLAG] = "ON";
    expect(isCredentialAutoRenewEnabled()).toBe(true);
    process.env[FLAG] = "enabled";
    expect(isCredentialAutoRenewEnabled()).toBe(true);
  });

  test("REQUIRED defaults true; only 0/false/off/disabled open the empty-list hatch", () => {
    expect(isCredentialAutoRenewOrgAllowlistRequired()).toBe(true);
    process.env[REQUIRED] = "";
    expect(isCredentialAutoRenewOrgAllowlistRequired()).toBe(true);
    process.env[REQUIRED] = "true";
    expect(isCredentialAutoRenewOrgAllowlistRequired()).toBe(true);
    process.env[REQUIRED] = "0";
    expect(isCredentialAutoRenewOrgAllowlistRequired()).toBe(false);
    process.env[REQUIRED] = "false";
    expect(isCredentialAutoRenewOrgAllowlistRequired()).toBe(false);
    process.env[REQUIRED] = "off";
    expect(isCredentialAutoRenewOrgAllowlistRequired()).toBe(false);
    process.env[REQUIRED] = "disabled";
    expect(isCredentialAutoRenewOrgAllowlistRequired()).toBe(false);
  });
});

describe("isCredentialAutoRenewOnForOrg", () => {
  test("global unset → every org OFF, even a listed UUID", () => {
    process.env[ALLOWLIST] = ORG_A;
    expect(isCredentialAutoRenewOnForOrg(ORG_A)).toBe(false);
    expect(isCredentialAutoRenewOnForOrg(ORG_B)).toBe(false);
  });

  test("empty / missing orgId / non-UUID → OFF even if the hatch is open", () => {
    process.env[FLAG] = "1";
    process.env[REQUIRED] = "0";
    expect(isCredentialAutoRenewOnForOrg(null)).toBe(false);
    expect(isCredentialAutoRenewOnForOrg("")).toBe(false);
    expect(isCredentialAutoRenewOnForOrg("org_a")).toBe(false);
    expect(isCredentialAutoRenewOnForOrg("not-a-uuid")).toBe(false);
  });

  test("global ON + empty allowlist (REQUIRED default) → all orgs OFF", () => {
    process.env[FLAG] = "1";
    expect(isCredentialAutoRenewOnForOrg(ORG_A)).toBe(false);
    process.env[ALLOWLIST] = "";
    expect(isCredentialAutoRenewOnForOrg(ORG_A)).toBe(false);
    process.env[ALLOWLIST] = " , ";
    expect(isCredentialAutoRenewOnForOrg(ORG_A)).toBe(false);
  });

  test("global ON + broken allowlist (non-UUID token) → all orgs OFF", () => {
    process.env[FLAG] = "1";
    process.env[ALLOWLIST] = `${ORG_A},not-a-uuid`;
    expect(isCredentialAutoRenewOnForOrg(ORG_A)).toBe(false);
    expect(isCredentialAutoRenewOnForOrg(ORG_B)).toBe(false);
    process.env[ALLOWLIST] = "org_a";
    expect(isCredentialAutoRenewOnForOrg(ORG_A)).toBe(false);
  });

  test("global ON + one org → only that org ON; other org OFF", () => {
    process.env[FLAG] = "1";
    process.env[ALLOWLIST] = ORG_A;
    expect(isCredentialAutoRenewOnForOrg(ORG_A)).toBe(true);
    expect(isCredentialAutoRenewOnForOrg(ORG_A.toUpperCase())).toBe(true);
    expect(isCredentialAutoRenewOnForOrg(ORG_B)).toBe(false);
  });

  test("comma list + surrounding space; comparison is case-insensitive", () => {
    process.env[FLAG] = "true";
    process.env[ALLOWLIST] = ` ${ORG_A.toUpperCase()} , ${ORG_B} `;
    expect(isCredentialAutoRenewOnForOrg(ORG_A)).toBe(true);
    expect(isCredentialAutoRenewOnForOrg(ORG_B)).toBe(true);
  });

  test("REQUIRED=0 + empty list → valid UUID orgs ON; non-UUID still OFF", () => {
    process.env[FLAG] = "1";
    process.env[REQUIRED] = "0";
    expect(isCredentialAutoRenewOnForOrg(ORG_A)).toBe(true);
    expect(isCredentialAutoRenewOnForOrg(ORG_B)).toBe(true);
    expect(isCredentialAutoRenewOnForOrg("org_a")).toBe(false);
  });

  test("non-empty list still applies when REQUIRED=0", () => {
    process.env[FLAG] = "1";
    process.env[REQUIRED] = "0";
    process.env[ALLOWLIST] = ORG_A;
    expect(isCredentialAutoRenewOnForOrg(ORG_A)).toBe(true);
    expect(isCredentialAutoRenewOnForOrg(ORG_B)).toBe(false);
  });

  test("truncated / mixed-case-garbage UUID tokens are unreadable → all OFF", () => {
    process.env[FLAG] = "1";
    process.env[ALLOWLIST] = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa";
    expect(isCredentialAutoRenewOnForOrg(ORG_A)).toBe(false);
    process.env[ALLOWLIST] = `${ORG_A}\n${ORG_B}`;
    expect(isCredentialAutoRenewOnForOrg(ORG_A)).toBe(false);
  });
});

describe("R1 types / constants (no secrets, no tenant hardcode)", () => {
  test("tool name is the new auto_renew ticket, not reissue", () => {
    expect(CREDENTIAL_AUTO_RENEW_ADMIN_TOOL).toBe("employees.credential.auto_renew");
    expect(CREDENTIAL_AUTO_RENEW_ADMIN_TOOL).not.toBe("employees.credential.reissue");
  });

  test("claim and overlap windows are 24 hours", () => {
    expect(CREDENTIAL_AUTO_RENEW_CLAIM_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
    expect(CREDENTIAL_AUTO_RENEW_OVERLAP_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
  });

  test("threshold includes now (R-now) and 7d (cron); states and modes match the design", () => {
    expect(CREDENTIAL_AUTO_RENEW_THRESHOLDS).toEqual(["7d", "now"]);
    expect(CREDENTIAL_AUTO_RENEW_MODES).toEqual(["gen2", "gen1_http"]);
    expect(CREDENTIAL_AUTO_RENEW_STATES).toEqual([
      "pending_approval",
      "claimable",
      "claimed",
      "old_revoked",
      "rejected",
      "expired",
      "held_blocked",
    ]);
  });

  test("production sources do not hardcode スペースツリー / 稲盛 ids or 社員証 secrets", () => {
    const files = [
      "lib/employees/credential-auto-renew.ts",
      "lib/employees/credential-auto-renew-overlap.ts",
      "lib/feature-flags.ts",
      "lib/employees/credential-auto-renew.test.ts",
      "supabase/migrations/20261019100000_credential_auto_renew.sql",
      "supabase/migrations/20261020100000_credential_auto_renew_overlap.sql",
      "supabase/migrations/20261020200000_credential_auto_renew_gen1_http.sql",
      "supabase/verification/20261019100000_credential_auto_renew_rollback.sql",
      "supabase/verification/20261020100000_credential_auto_renew_overlap_rollback.sql",
      "supabase/verification/20261020200000_credential_auto_renew_gen1_http_rollback.sql",
      "lib/employees/credential-auto-renew-gen1.ts",
      "app/api/mcp/employee/credential/claim/route.ts",
      "tests/security/db-credential-auto-renew.sql",
      "tests/security/db-credential-auto-renew-overlap.sql",
    ];
    const prod = files.filter((f) => !f.endsWith(".test.ts") && !f.includes("tests/security/"));
    for (const f of prod) {
      const text = src(f);
      expect(text).not.toContain(SPACE_TREE);
      expect(text.toLowerCase()).not.toContain(INAMORI_PREFIX);
      expect(text).not.toMatch(/gb_emp_[0-9a-f]{8}_[0-9a-f]+/i);
    }
    // The test file may name the ids only to forbid them in production sources.
    expect(src("lib/employees/credential-auto-renew.test.ts")).toContain(SPACE_TREE);
  });

  test(".env.example documents the three R1 flags as default-OFF comments", () => {
    const example = src(".env.example");
    expect(example).toContain("CREDENTIAL_AUTO_RENEW_ENABLED");
    expect(example).toContain("CREDENTIAL_AUTO_RENEW_ORG_ALLOWLIST");
    expect(example).toContain("CREDENTIAL_AUTO_RENEW_ORG_ALLOWLIST_REQUIRED");
    expect(example).toContain("CREDENTIAL_AUTO_RENEW_GEN1_HTTP_ENABLED");
    expect(example).not.toMatch(/^CREDENTIAL_AUTO_RENEW_ENABLED=(true|1|on)/m);
    expect(example).not.toMatch(/^CREDENTIAL_AUTO_RENEW_GEN1_HTTP_ENABLED=(true|1|on)/m);
    expect(example).not.toContain(SPACE_TREE);
  });

  test("L5: restoreEnv does not use a ternary as a statement (no-unused-expressions)", () => {
    const text = src("lib/employees/credential-auto-renew.test.ts");
    expect(text).not.toMatch(/saved\[k\] === undefined \? delete process\.env\[k\]/);
  });

  test("employee MCP still has no staffpass_credential_renew (R4/R8)", () => {
    expect(src("lib/mcp/tools.ts")).not.toContain("staffpass_credential_renew");
  });
});

describe("#409 review M1/M2/M3/L2/L4 (SQL, fail-first)", () => {
  const sql = src("supabase/migrations/20261019100000_credential_auto_renew.sql");

  test("M1: claim / release / revoke require active employee, live old badge, approved ticket, and no hold", () => {
    expect(sql).toMatch(/e\.status\s*=\s*'active'/);
    expect(sql).toMatch(/c\.revoked_at\s+is\s+null/i);
    expect(sql).toMatch(/a\.status\s*=\s*'approved'/);
    expect(sql).toMatch(/e\.hold_state\s+is\s+null/i);
    expect(sql).toMatch(/o\.hold_state\s+is\s+null/i);
    for (const fn of ["claim_credential_renewal", "release_credential_renewal", "revoke_overlapped_old_credential"]) {
      expect(sql).toContain(fn);
    }
  });

  test("M2: second UPDATE of revoke_overlapped_old_credential RAISEs when 0 rows", () => {
    expect(sql).toMatch(/raise exception\s+'credential_renewal_revoke_incomplete'/i);
  });

  test("M3: new_credential_id is ON DELETE RESTRICT so release cannot reopen after the new badge is gone", () => {
    expect(sql).toMatch(/new_credential_id uuid references public\.credentials\(id\) on delete restrict/i);
  });

  test("L2/L4: expire_stale_credential_renewals marks expired claimable and stuck claimed rows", () => {
    expect(sql).toContain("expire_stale_credential_renewals");
    expect(sql).toMatch(/state\s*=\s*'claimable'/);
    expect(sql).toMatch(/claimable_until\s*<\s*p_at/);
  });
});

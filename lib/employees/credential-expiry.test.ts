/**
 * 木村 2026-10-12: all TOKYO307 社員証 expired 9/23–9/30 while the AI社員 list
 * still said 「稼働中」. The display must read the credential's expires_at, not
 * only employees.status. Pure helper; no key material involved.
 */
import { describe, expect, test } from "bun:test";
import {
  CREDENTIAL_EXPIRING_SOON_DAYS,
  credentialExpiry,
  employeeStatusView,
  formatCredentialExpiryJa,
} from "./credential-expiry";

const NOW = new Date("2026-10-12T00:00:00.000Z");
const day = 86_400_000;
const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
const emp = (over: Partial<{ status: "active" | "suspended" | "draft"; credentialId: string | null; credentialExpiresAt: string | null }>) => ({
  status: "active" as const,
  credentialId: "cred_1",
  credentialExpiresAt: null as string | null,
  ...over,
});

describe("credentialExpiry", () => {
  test("no credential → none", () => {
    expect(credentialExpiry(emp({ credentialId: null }), NOW).state).toBe("none");
  });
  test("credential without expires_at → no_expiry", () => {
    expect(credentialExpiry(emp({ credentialExpiresAt: null }), NOW)).toMatchObject({ state: "no_expiry", expiresAt: null });
  });
  test("in the past (or exactly now) → expired", () => {
    expect(credentialExpiry(emp({ credentialExpiresAt: at(-1) }), NOW).state).toBe("expired");
    expect(credentialExpiry(emp({ credentialExpiresAt: at(0) }), NOW).state).toBe("expired");
    expect(credentialExpiry(emp({ credentialExpiresAt: "2026-09-23T00:00:00Z" }), NOW).state).toBe("expired");
  });
  test("unparsable expires_at fails closed → expired", () => {
    expect(credentialExpiry(emp({ credentialExpiresAt: "not-a-date" }), NOW).state).toBe("expired");
  });
  test(`within ${CREDENTIAL_EXPIRING_SOON_DAYS} days → expiring with whole days left (ceil)`, () => {
    expect(CREDENTIAL_EXPIRING_SOON_DAYS).toBe(7);
    expect(credentialExpiry(emp({ credentialExpiresAt: at(1) }), NOW)).toMatchObject({ state: "expiring", daysLeft: 1 });
    expect(credentialExpiry(emp({ credentialExpiresAt: at(7 * day) }), NOW)).toMatchObject({ state: "expiring", daysLeft: 7 });
    expect(credentialExpiry(emp({ credentialExpiresAt: at(2.5 * day) }), NOW)).toMatchObject({ state: "expiring", daysLeft: 3 });
  });
  test("later → valid", () => {
    expect(credentialExpiry(emp({ credentialExpiresAt: at(7 * day + 1) }), NOW)).toMatchObject({ state: "valid", daysLeft: 8 });
  });
});

describe("employeeStatusView", () => {
  test("active + expired credential → 期限切れ (danger), never 稼働中", () => {
    const v = employeeStatusView(emp({ credentialExpiresAt: at(-day) }), NOW);
    expect(v).toMatchObject({ label: "期限切れ", tone: "danger", credential: "expired" });
  });
  test("active + no credential → 社員証なし (warn)", () => {
    expect(employeeStatusView(emp({ credentialId: null }), NOW)).toMatchObject({ label: "社員証なし", tone: "warn" });
  });
  test("active + valid / no-expiry / expiring credential → 稼働中 (ok)", () => {
    expect(employeeStatusView(emp({ credentialExpiresAt: at(30 * day) }), NOW)).toMatchObject({ label: "稼働中", tone: "ok" });
    expect(employeeStatusView(emp({ credentialExpiresAt: null }), NOW)).toMatchObject({ label: "稼働中", tone: "ok" });
    expect(employeeStatusView(emp({ credentialExpiresAt: at(2 * day) }), NOW)).toMatchObject({ label: "稼働中", tone: "ok", credential: "expiring" });
  });
  test("suspended / draft keep their labels regardless of the credential", () => {
    expect(employeeStatusView(emp({ status: "suspended", credentialExpiresAt: at(-day) }), NOW)).toMatchObject({ label: "契約終了", tone: "danger" });
    expect(employeeStatusView(emp({ status: "draft" }), NOW)).toMatchObject({ label: "下書き", tone: "warn" });
  });
});

describe("formatCredentialExpiryJa", () => {
  test("JST date + time, with a label", () => {
    expect(formatCredentialExpiryJa("2026-09-23T03:00:00.000Z")).toBe("2026/09/23 12:00 JST");
    expect(formatCredentialExpiryJa(null)).toBe("無期限");
    expect(formatCredentialExpiryJa("garbage")).toBe("不明（期限切れ扱い）");
  });
});

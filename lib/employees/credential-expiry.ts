/**
 * 社員証 expiry for display (AI社員 list / detail). Reads the current
 * credential's expires_at — employees.status alone said 「稼働中」 while every
 * TOKYO307 credential had expired (2026-09-23〜30). Display only: no
 * authentication or authorization decision uses this module (those check
 * expires_at themselves, e.g. lib/auth/employee-credential.ts).
 *
 * Never touches key material: input is the credential id + expires_at only.
 */
import type { Employee } from "@/lib/types";

export const CREDENTIAL_EXPIRING_SOON_DAYS = 7;
const DAY_MS = 86_400_000;

export type CredentialExpiryState = "none" | "no_expiry" | "valid" | "expiring" | "expired";

export interface CredentialExpiry {
  state: CredentialExpiryState;
  expiresAt: string | null;
  /** Whole days left (rounded up); null when there is no expiry / no credential / already expired. */
  daysLeft: number | null;
}

type ExpiryInput = Pick<Employee, "credentialId"> & { credentialExpiresAt?: string | null };

export function credentialExpiry(employee: ExpiryInput, now: Date = new Date()): CredentialExpiry {
  if (!employee.credentialId) return { state: "none", expiresAt: null, daysLeft: null };
  const expiresAt = employee.credentialExpiresAt ?? null;
  if (!expiresAt) return { state: "no_expiry", expiresAt: null, daysLeft: null };
  const ms = Date.parse(expiresAt);
  // Unparsable → treat as expired (same fail-closed rule as lib/auth/approval-authority.ts).
  if (!Number.isFinite(ms) || ms <= now.getTime()) return { state: "expired", expiresAt, daysLeft: null };
  const daysLeft = Math.ceil((ms - now.getTime()) / DAY_MS);
  return { state: daysLeft <= CREDENTIAL_EXPIRING_SOON_DAYS ? "expiring" : "valid", expiresAt, daysLeft };
}

export type StatusTone = "ok" | "warn" | "danger";

export interface EmployeeStatusView {
  label: string;
  tone: StatusTone;
  credential: CredentialExpiryState;
}

type StatusInput = ExpiryInput & Pick<Employee, "status">;

/** The 状態 chip: employees.status first, then (for active) the credential. */
export function employeeStatusView(employee: StatusInput, now: Date = new Date()): EmployeeStatusView {
  const credential = credentialExpiry(employee, now).state;
  if (employee.status === "suspended") return { label: "契約終了", tone: "danger", credential };
  if (employee.status === "draft") return { label: "下書き", tone: "warn", credential };
  if (employee.status !== "active") return { label: String(employee.status), tone: "warn", credential };
  if (credential === "expired") return { label: "期限切れ", tone: "danger", credential };
  if (credential === "none") return { label: "社員証なし", tone: "warn", credential };
  return { label: "稼働中", tone: "ok", credential };
}

export function statusChipClass(tone: StatusTone): string {
  return tone === "ok" ? "chip-ok" : tone === "danger" ? "chip-danger" : "chip-warn";
}

const JST = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export function formatCredentialExpiryJa(expiresAt: string | null | undefined): string {
  if (!expiresAt) return "無期限";
  const ms = Date.parse(expiresAt);
  if (!Number.isFinite(ms)) return "不明（期限切れ扱い）";
  const parts = Object.fromEntries(JST.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  const hour = parts.hour === "24" ? "00" : parts.hour;
  return `${parts.year}/${parts.month}/${parts.day} ${hour}:${parts.minute} JST`;
}

/** One-line summary for list rows: 「社員証期限 2026/10/30 12:00 JST（あと 3 日）」. */
export function credentialExpiryLineJa(employee: ExpiryInput, now: Date = new Date()): string {
  const e = credentialExpiry(employee, now);
  if (e.state === "none") return "社員証なし";
  if (e.state === "no_expiry") return "社員証期限 無期限";
  const date = formatCredentialExpiryJa(e.expiresAt);
  if (e.state === "expired") return `社員証期限 ${date}（期限切れ）`;
  if (e.state === "expiring") return `社員証期限 ${date}（あと ${e.daysLeft} 日）`;
  return `社員証期限 ${date}`;
}

/**
 * Setup diagnostics / home (木村 2026-10-12 follow-up): an ACTIVE employee whose
 * current 社員証 has expired is listed as 「期限切れ」 instead of as an active /
 * ready employee. expires_at only — never key material.
 */
export function hasExpiredCredential(employee: StatusInput, now: Date = new Date()): boolean {
  return employee.status === "active" && credentialExpiry(employee, now).state === "expired";
}

export interface ExpiredCredentialEmployeeRow {
  employeeId: string;
  displayName: string;
  statusLabelJa: "期限切れ";
  credentialExpiresAt: string | null;
  credentialExpiresAtJa: string;
}

export function expiredCredentialEmployeeRow(employee: StatusInput & { id: string; displayName: string }): ExpiredCredentialEmployeeRow {
  const expiresAt = employee.credentialExpiresAt ?? null;
  return {
    employeeId: employee.id,
    displayName: employee.displayName,
    statusLabelJa: "期限切れ",
    credentialExpiresAt: expiresAt,
    credentialExpiresAtJa: formatCredentialExpiryJa(expiresAt),
  };
}

/** One line for nextSteps / issues. dashboardUrl = the AI社員 page (reissue there). */
export function expiredCredentialStepJa(row: ExpiredCredentialEmployeeRow, dashboardUrl: string): string {
  return `${row.displayName}: 社員証が期限切れです（${row.credentialExpiresAtJa}）。MCP / OAuth で接続できません。AI社員ページ（${dashboardUrl}）で社員証を再発行してください。`;
}

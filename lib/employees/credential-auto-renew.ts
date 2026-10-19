/**
 * 社員証 auto-renew (R1): flags, org allowlist, and types.
 * Cron / HTTP / MCP wiring is later PRs. Default OFF, fail-closed.
 *
 * Org UUIDs belong in CREDENTIAL_AUTO_RENEW_ORG_ALLOWLIST only — never in code.
 */
import {
  isCredentialAutoRenewEnabled,
  isCredentialAutoRenewOrgAllowlistRequired,
} from "@/lib/feature-flags";
import { isUuid } from "@/lib/data/members";

export const CREDENTIAL_AUTO_RENEW_ADMIN_TOOL = "employees.credential.auto_renew" as const;

export const CREDENTIAL_AUTO_RENEW_CLAIM_WINDOW_MS = 24 * 60 * 60 * 1000;
export const CREDENTIAL_AUTO_RENEW_OVERLAP_WINDOW_MS = 24 * 60 * 60 * 1000;

export const CREDENTIAL_AUTO_RENEW_THRESHOLDS = ["7d", "now"] as const;
export type CredentialAutoRenewThreshold = (typeof CREDENTIAL_AUTO_RENEW_THRESHOLDS)[number];

export const CREDENTIAL_AUTO_RENEW_MODES = ["gen2", "gen1_http"] as const;
export type CredentialAutoRenewMode = (typeof CREDENTIAL_AUTO_RENEW_MODES)[number];

export const CREDENTIAL_AUTO_RENEW_STATES = [
  "pending_approval",
  "claimable",
  "claimed",
  "old_revoked",
  "rejected",
  "expired",
  "held_blocked",
] as const;
export type CredentialAutoRenewState = (typeof CREDENTIAL_AUTO_RENEW_STATES)[number];

function allowlistEntries(): string[] | null {
  const raw = process.env.CREDENTIAL_AUTO_RENEW_ORG_ALLOWLIST;
  const list = (raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.some((id) => !isUuid(id))) return null;
  return list;
}

/**
 * Global ON is not enough: the org must be on the env allowlist.
 * Empty / missing / unreadable / non-UUID entries → OFF.
 * orgId empty or not a UUID → OFF.
 */
export function isCredentialAutoRenewOnForOrg(orgId: string | null | undefined): boolean {
  try {
    if (!isUuid(orgId)) return false;
    if (!isCredentialAutoRenewEnabled()) return false;
    const list = allowlistEntries();
    if (list === null) return false;
    if (list.length === 0) return !isCredentialAutoRenewOrgAllowlistRequired();
    const needle = orgId.toLowerCase();
    return list.some((id) => id.toLowerCase() === needle);
  } catch {
    return false;
  }
}

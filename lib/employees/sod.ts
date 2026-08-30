import { highRiskDomainsOf } from "@/lib/gateway/domains";
import {
  comboDomainsOf,
  DEFAULT_SOD_WARN_POLICY,
  isDefaultSodWarnPolicy,
  normalizeSodWarnPolicy,
} from "@/lib/employees/sod-warn-policy";
import type { EmployeeScope, RiskDomain, SodVerdict, SodWarnPolicy } from "@/lib/types";

export type { SodVerdict } from "@/lib/types";
export {
  DEFAULT_SOD_WARN_POLICY,
  normalizeSodWarnPolicy,
  SOD_WARN_DOMAIN_LABELS,
  SOD_WARN_DOMAIN_ORDER,
} from "@/lib/employees/sod-warn-policy";

export const SOD_OPERATOR_RESPONSIBILITY_JA =
  "高リスク権限を同時に持たせています。責任は事業者にあります";

export const SOD_BROWSER_SESSION_JA =
  "ブラウザ操作は共有セッションの影響を受けます。許可アカウントを必ず確認してください。";

/**
 * comm_external + commit (mail.send + calendar.confirm). Browser may coexist.
 */
export function isSendConfirmDomainMix(domains: readonly RiskDomain[]): boolean {
  const core = domains.filter((domain) => domain !== "browser" && domain !== "safe");
  return core.includes("comm_external") && core.includes("commit");
}

export function isSendConfirmSodWarn(
  verdict: Pick<SodVerdict, "level" | "domains">
): boolean {
  return verdict.level === "warn" && isSendConfirmDomainMix(verdict.domains);
}

export function isBrowserOnlySodWarn(
  verdict: Pick<SodVerdict, "level" | "domains">
): boolean {
  if (verdict.level !== "warn") return false;
  const high = verdict.domains.filter((domain) => domain !== "safe");
  return high.length === 1 && high[0] === "browser";
}

export function isComboSodWarn(
  verdict: Pick<SodVerdict, "level" | "domains">
): boolean {
  if (verdict.level === "force_human") return true;
  if (verdict.level !== "warn") return false;
  const high = verdict.domains.filter((domain) => domain !== "safe");
  return high.length >= 2;
}

/**
 * Operator must ack before save when the mix warns.
 * Browser-only session warning does not require ack.
 * Legacy force_human rows still require ack.
 */
export function sodNeedsOperatorAck(
  verdict: Pick<SodVerdict, "level" | "domains">
): boolean {
  return isComboSodWarn(verdict);
}

/**
 * SoD never returns force_human. 2+ of the org combo domains → warn, 責任は事業者.
 * Missing policy uses the strict default (any 2+ of comm_external/money/destructive/commit).
 * Browser-only stays the existing session warning (no ack).
 */
export function evaluateSod(
  scopes: EmployeeScope[],
  policy?: SodWarnPolicy | null
): SodVerdict {
  const domains = highRiskDomainsOf(scopes);
  const warnPolicy =
    policy == null ? DEFAULT_SOD_WARN_POLICY : normalizeSodWarnPolicy(policy);
  const combo = comboDomainsOf(domains, warnPolicy);
  const hasBrowser = domains.includes("browser");
  const otherHigh = domains.filter((domain) => domain !== "browser" && domain !== "safe");

  if (combo.length >= 2) {
    return {
      level: "warn",
      domains,
      reason: SOD_OPERATOR_RESPONSIBILITY_JA,
    };
  }

  // Strict default: browser + another high-risk domain also warns.
  if (hasBrowser && otherHigh.length >= 1 && isDefaultSodWarnPolicy(warnPolicy)) {
    return {
      level: "warn",
      domains,
      reason: SOD_OPERATOR_RESPONSIBILITY_JA,
    };
  }

  if (hasBrowser && otherHigh.length === 0) {
    return {
      level: "warn",
      domains,
      reason: SOD_BROWSER_SESSION_JA,
    };
  }

  return { level: "ok", domains };
}

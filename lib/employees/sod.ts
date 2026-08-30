import { highRiskDomainsOf } from "@/lib/gateway/domains";
import type { EmployeeScope, RiskDomain, SodVerdict } from "@/lib/types";

export type { SodVerdict } from "@/lib/types";

export const SOD_OPERATOR_RESPONSIBILITY_JA =
  "メール送信と予定確定を同時に持たせています。責任は事業者にあります";

const HARD_SOD_DOMAINS: ReadonlySet<RiskDomain> = new Set(["money", "destructive"]);

function hasMailSend(scopes: readonly string[]): boolean {
  return scopes.includes("mail:send") || scopes.includes("agentmail:send");
}

function hasCalendarConfirm(scopes: readonly string[]): boolean {
  return scopes.includes("calendar:confirm");
}

/**
 * comm_external + commit (mail.send + calendar.confirm). Browser may coexist.
 * Money / destructive in the mix is not this warning path.
 */
export function isSendConfirmDomainMix(domains: readonly RiskDomain[]): boolean {
  const core = domains.filter((domain) => domain !== "browser");
  if (core.some((domain) => HARD_SOD_DOMAINS.has(domain))) return false;
  return core.includes("comm_external") && core.includes("commit");
}

export function isSendConfirmSodWarn(
  verdict: Pick<SodVerdict, "level" | "domains">
): boolean {
  return verdict.level === "warn" && isSendConfirmDomainMix(verdict.domains);
}

/**
 * Operator must ack before save: remaining force_human mixes, or send+confirm warn.
 * Browser-only warn does not require ack.
 */
export function sodNeedsOperatorAck(
  verdict: Pick<SodVerdict, "level" | "domains">
): boolean {
  if (verdict.level === "force_human") return true;
  return isSendConfirmSodWarn(verdict);
}

/**
 * Two-high-risk SoD lock was changed to a warning for comm_external + commit
 * (mail.send + calendar.confirm). Operator ack is required to SAVE; Gateway
 * must not rewrite approvalPolicy to always_human just because SoD warned.
 * Money / destructive mixed with another high-risk domain still force_human.
 */
export function evaluateSod(scopes: EmployeeScope[]): SodVerdict {
  const domains = highRiskDomainsOf(scopes);
  if (isSendConfirmDomainMix(domains) && hasMailSend(scopes) && hasCalendarConfirm(scopes)) {
    return {
      level: "warn",
      domains,
      reason: SOD_OPERATOR_RESPONSIBILITY_JA,
    };
  }
  if (domains.length >= 2) {
    return {
      level: "force_human",
      domains,
      reason: `高リスク権限が複数領域（${domains.join(" + ")}）に集中しているため、すべての行為を人が確認します。`,
    };
  }
  if (domains[0] === "browser") {
    return {
      level: "warn",
      domains,
      reason: "ブラウザ操作は共有セッションの影響を受けます。許可アカウントを必ず確認してください。",
    };
  }
  return { level: "ok", domains };
}

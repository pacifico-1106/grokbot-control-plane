import type { EmployeeScope, RiskDomain } from "@/lib/types";

export type { RiskDomain } from "@/lib/types";

export const HIGH_RISK_DOMAINS: RiskDomain[] = [
  "comm_external",
  "money",
  "destructive",
  "commit",
  "browser",
];

export const SCOPE_DOMAINS: Record<EmployeeScope, RiskDomain> = {
  "tools:read": "safe",
  "tools:invoke": "safe",
  "calendar:read": "safe",
  "calendar:propose": "safe",
  "calendar:confirm": "commit",
  "mail:draft": "safe",
  "mail:send": "comm_external",
  "agentmail:draft": "safe",
  "agentmail:send": "comm_external",
  "files:read": "safe",
  "files:write": "destructive",
  "browser:use": "browser",
  "commerce:quote": "safe",
  "commerce:order": "money",
  "slack:post": "safe",
  "slack:post_external": "comm_external",
  "drive:share_external": "comm_external",
  "knowledge:search": "safe",
  "approvals:request": "safe",
  "audit:append": "safe",
};

export const DOMAIN_LABELS: Record<RiskDomain, string> = {
  comm_external: "社外送信",
  money: "決済",
  destructive: "更新・削除",
  commit: "日程確定",
  browser: "ブラウザ",
  safe: "安全操作",
};

export function domainOfScope(scope: EmployeeScope): RiskDomain {
  return SCOPE_DOMAINS[scope];
}

export function highRiskDomainsOf(scopes: EmployeeScope[]): RiskDomain[] {
  const highRisk = new Set(HIGH_RISK_DOMAINS);
  return [...new Set(scopes.map(domainOfScope).filter((domain) => highRisk.has(domain)))];
}

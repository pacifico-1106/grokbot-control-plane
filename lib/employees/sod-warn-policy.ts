import type { RiskDomain, SodWarnDomain, SodWarnPolicy } from "@/lib/types";

export const SOD_WARN_DOMAIN_ORDER: readonly SodWarnDomain[] = [
  "comm_external",
  "money",
  "destructive",
  "commit",
];

export const SOD_WARN_DOMAIN_LABELS: Record<SodWarnDomain, string> = {
  comm_external: "社外送信",
  money: "決済",
  destructive: "更新・削除",
  commit: "日程確定",
};

export const DEFAULT_SOD_WARN_POLICY: SodWarnPolicy = {
  domains: [...SOD_WARN_DOMAIN_ORDER],
};

export function isSodWarnDomain(value: unknown): value is SodWarnDomain {
  return (
    value === "comm_external" ||
    value === "money" ||
    value === "destructive" ||
    value === "commit"
  );
}

/**
 * Missing / invalid policy → strict default (warn on 2+ of the four).
 * An explicit empty domains array is valid (no combo warnings).
 */
export function normalizeSodWarnPolicy(value: unknown): SodWarnPolicy {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return { domains: [...DEFAULT_SOD_WARN_POLICY.domains] };
  }
  const src = value as Record<string, unknown>;
  if (!("domains" in src) || !Array.isArray(src.domains)) {
    return { domains: [...DEFAULT_SOD_WARN_POLICY.domains] };
  }
  const seen = new Set<SodWarnDomain>();
  for (const item of src.domains) {
    if (isSodWarnDomain(item)) seen.add(item);
  }
  return { domains: SOD_WARN_DOMAIN_ORDER.filter((domain) => seen.has(domain)) };
}

export function isDefaultSodWarnPolicy(policy: SodWarnPolicy): boolean {
  if (policy.domains.length !== DEFAULT_SOD_WARN_POLICY.domains.length) return false;
  return DEFAULT_SOD_WARN_POLICY.domains.every((domain) => policy.domains.includes(domain));
}

export function comboDomainsOf(
  highRisk: readonly RiskDomain[],
  policy: SodWarnPolicy
): SodWarnDomain[] {
  return highRisk.filter((domain): domain is SodWarnDomain =>
    policy.domains.includes(domain as SodWarnDomain)
  );
}

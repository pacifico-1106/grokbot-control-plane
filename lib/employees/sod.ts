import { highRiskDomainsOf } from "@/lib/gateway/domains";
import type { EmployeeScope, SodVerdict } from "@/lib/types";

export type { SodVerdict } from "@/lib/types";

export function evaluateSod(scopes: EmployeeScope[]): SodVerdict {
  const domains = highRiskDomainsOf(scopes);
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

import type { Metadata } from "next";
import { AIEmployeeLanding } from "../ai-employee/AIEmployeeLanding";
import { SERVICE_FULL_NAME } from "../ai-employee/variants";

/**
 * LP pattern B: handed out directly to acquaintances / referrals (A is the canonical
 * page for search). Same components as /lp/ai-employee, switched by variant config.
 *
 * Search: noindex (+ follow), no canonical (noindex + canonical are mixed signals),
 * kept out of the sitemap, and noai / noimageai for AI crawlers. The same directives
 * are sent as X-Robots-Tag from next.config.ts. Not listed in robots.txt on purpose
 * (a Disallow would stop crawlers from ever seeing the noindex, and would publish the path).
 *
 * ?ref= is handled in middleware (validated → HttpOnly cookie, URL cleaned). This page
 * takes no searchParams, so the ref can never be rendered.
 */
const LP_CORP_ROBOTS = "noindex, follow, noai, noimageai";

export const metadata: Metadata = {
  title: `${SERVICE_FULL_NAME} — AI社員の導入・運用パック`,
  description: `${SERVICE_FULL_NAME}で、AI社員の導入から運用までをまとめて支援。社員証・許可・記録、会社メール、Grok Bot をまとめて導入。月50,000円から。`,
  robots: LP_CORP_ROBOTS,
};

export default function AIEmployeeCorpLP() {
  return <AIEmployeeLanding variant="ai-employee-corp" />;
}

import { NextResponse } from "next/server";

export const runtime = "nodejs";

/**
 * Legacy SaaS checkout (starter / business / managed, mode=subscription with
 * trial_period_days) — CLOSED (fail-closed).
 *
 * This route used to let any logged-in org member create a Stripe Customer and
 * a subscription Checkout Session (with a free trial that auto-converts to a
 * paid subscription) with no human approval. A contract (= money movement)
 * must only start after human approval, and no approved-contract record type
 * exists yet, so every request is rejected here before any Stripe call or DB
 * write (including the referral-code write the old route did).
 *
 * Not affected: the AI社員パック setup-fee checkout
 * (`/api/lp/ai-employee/checkout`, mode=payment) — it does not use this route.
 * Future subscription starts must go through an approved path
 * (see docs/billing-automation-design-20261003.md §7, `billing.*` + always_human).
 */
export async function POST() {
  return NextResponse.json(
    {
      ok: false,
      error: "contract_requires_approval",
      message:
        "オンラインでの月額プランのお申し込みは受け付けておりません。ご契約は担当者が内容を確認し、承認したうえで開始します。お問い合わせください。",
    },
    { status: 403 }
  );
}

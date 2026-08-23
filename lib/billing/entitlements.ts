import { getSubscription } from "../data/subscriptions";
import { isDemoMode } from "../mode";
import type { Subscription, SubscriptionStatus } from "../types";
import { NextResponse } from "next/server";

export type PlanKey = Subscription["planKey"];

export type Entitlements = {
  plan: PlanKey;
  status: SubscriptionStatus;
  canHire: boolean;
  maxEmployees?: number;
  features: string[];
  /** True when soft-gated (production only). */
  blocked: boolean;
  blockReasonJa: string | null;
};

const BLOCKED_STATUSES: SubscriptionStatus[] = [
  "past_due",
  "canceled",
  "incomplete",
  "unpaid",
];

const PLAN_FEATURES: Record<PlanKey, { maxEmployees?: number; features: string[] }> =
  {
    starter: {
      maxEmployees: 3,
      features: ["employees", "audit_basic", "email_notify"],
    },
    business: {
      maxEmployees: 25,
      features: [
        "employees",
        "approvals",
        "audit_timeline",
        "team",
        "email_notify",
      ],
    },
    managed: {
      features: [
        "employees",
        "approvals",
        "audit_timeline",
        "team",
        "care_ops",
        "policy_assist",
        "email_notify",
      ],
    },
  };

function statusBlockMessageJa(status: SubscriptionStatus): string {
  switch (status) {
    case "past_due":
      return "お支払いが確認できません。請求ページからカードを更新するか、カスタマーポータルでお手続きください。";
    case "canceled":
      return "ご契約が解約済みです。プランを再選択して Checkout から再開してください。";
    case "incomplete":
      return "お申し込み手続きが完了していません。請求ページから Checkout を完了してください。";
    case "unpaid":
      return "未払いのため一部機能を制限しています。請求ページまたはカスタマーポータルでお支払いください。";
    default:
      return "現在のご契約状態ではこの操作を実行できません。";
  }
}

/**
 * Given org subscription row (or DEMO), return plan entitlements.
 * Demo always allowed (canHire=true, blocked=false).
 */
export function entitlementsFromSubscription(
  sub: Subscription | null | undefined
): Entitlements {
  const plan: PlanKey = sub?.planKey || "business";
  const status: SubscriptionStatus = sub?.status || "trialing";
  const pack = PLAN_FEATURES[plan] || PLAN_FEATURES.business;

  if (isDemoMode()) {
    return {
      plan,
      status,
      canHire: true,
      maxEmployees: pack.maxEmployees,
      features: [...pack.features],
      blocked: false,
      blockReasonJa: null,
    };
  }

  const blocked = BLOCKED_STATUSES.includes(status);
  return {
    plan,
    status,
    canHire: !blocked,
    maxEmployees: pack.maxEmployees,
    features: [...pack.features],
    blocked,
    blockReasonJa: blocked ? statusBlockMessageJa(status) : null,
  };
}

export async function getOrgEntitlements(
  orgId?: string | null
): Promise<Entitlements> {
  const sub = await getSubscription(orgId);
  return entitlementsFromSubscription(sub);
}

export type EntitlementAction = "hire" | "team";

/**
 * Soft-gate hire/issue and team when status is past_due/canceled/incomplete/unpaid
 * in production. Demo always passes.
 */
export async function assertBillingAllows(
  orgId: string | null | undefined,
  action: EntitlementAction
): Promise<{ ok: true; entitlements: Entitlements } | { ok: false; response: NextResponse }> {
  const entitlements = await getOrgEntitlements(orgId);
  if (!entitlements.blocked) {
    return { ok: true, entitlements };
  }

  const actionJa =
    action === "hire"
      ? "AI社員の雇用・社員証発行"
      : "チームメンバーの追加・編集";

  return {
    ok: false,
    response: NextResponse.json(
      {
        ok: false,
        error: "billing_entitlement_blocked",
        code: entitlements.status,
        action,
        message: `現在「${entitlements.status}」のため、${actionJa}はご利用いただけません。${entitlements.blockReasonJa ?? ""}`,
        billingPath: "/app/billing",
        entitlements: {
          plan: entitlements.plan,
          status: entitlements.status,
          canHire: entitlements.canHire,
        },
      },
      { status: 402 }
    ),
  };
}

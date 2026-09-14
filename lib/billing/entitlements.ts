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
  /** True when expired trial — confirm-class Gateway invokes are gated. */
  expiredTrial: boolean;
};

const BLOCKED_STATUSES: SubscriptionStatus[] = [
  "past_due",
  "canceled",
  "incomplete",
  "unpaid",
  "expired",
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
    case "expired":
      return "トライアル期間が終了しました。プランを選択して Checkout からお手続きください。";
    default:
      return "現在のご契約状態ではこの操作を実行できません。";
  }
}

/**
 * Confirm-class Gateway tools soft-gated when trial is expired.
 * mail.send, comm.reply, calendar.confirm, sns.publish, commerce.*
 * View + approval poll remain allowed.
 */
export const EXPIRED_TRIAL_GATED_TOOLS = new Set([
  "mail.send",
  "comm.reply",
  "calendar.confirm",
  "sns.publish",
  "commerce.order",
  "commerce.quote",
]);

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
      expiredTrial: false,
    };
  }

  const blocked = BLOCKED_STATUSES.includes(status);
  const expiredTrial = status === "expired";
  return {
    plan,
    status,
    canHire: !blocked,
    maxEmployees: pack.maxEmployees,
    features: [...pack.features],
    blocked,
    blockReasonJa: blocked ? statusBlockMessageJa(status) : null,
    expiredTrial,
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
 * Soft-gate hire/issue and team when status is past_due/canceled/incomplete/unpaid/expired
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

export type GatewayGateResult =
  | { ok: true; entitlements: Entitlements }
  | { ok: false; code: "expired_trial_gated"; tool: string; entitlements: Entitlements };

/**
 * Soft-gate confirm-class Gateway tools when trial is expired.
 * Gated tools: mail.send, comm.reply, calendar.confirm, sns.publish, commerce.*
 * View + approval poll remain allowed.
 * Returns ok=true for non-gated tools or non-expired status.
 */
export async function assertBillingAllowsGateway(
  orgId: string | null | undefined,
  tool: string
): Promise<GatewayGateResult> {
  const entitlements = await getOrgEntitlements(orgId);

  if (!entitlements.expiredTrial) {
    return { ok: true, entitlements };
  }

  if (!EXPIRED_TRIAL_GATED_TOOLS.has(tool)) {
    return { ok: true, entitlements };
  }

  return {
    ok: false,
    code: "expired_trial_gated",
    tool,
    entitlements,
  };
}

/**
 * Build a 402 response for expired trial gated tools.
 */
export function expiredTrialGatedResponse(
  tool: string,
  entitlements: Entitlements
): NextResponse {
  return NextResponse.json(
    {
      ok: false,
      error: "expired_trial_gated",
      code: "expired_trial_gated",
      tool,
      message: `トライアル期間が終了したため、${tool} はご利用いただけません。プランを選択してお手続きください。`,
      billingPath: "/app/billing",
      entitlements: {
        plan: entitlements.plan,
        status: entitlements.status,
        canHire: entitlements.canHire,
        expiredTrial: entitlements.expiredTrial,
      },
    },
    { status: 402 }
  );
}

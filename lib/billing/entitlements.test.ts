import { describe, expect, test } from "bun:test";
import type { Subscription, SubscriptionStatus } from "../types";

const BLOCKED_STATUSES: SubscriptionStatus[] = [
  "past_due",
  "canceled",
  "incomplete",
  "unpaid",
  "expired",
];

const EXPIRED_TRIAL_GATED_TOOLS = new Set([
  "mail.send",
  "comm.reply",
  "calendar.confirm",
  "sns.publish",
  "commerce.order",
  "commerce.quote",
]);

type PlanKey = "starter" | "business" | "managed";

type Entitlements = {
  plan: PlanKey;
  status: SubscriptionStatus;
  canHire: boolean;
  maxEmployees?: number;
  features: string[];
  blocked: boolean;
  blockReasonJa: string | null;
  expiredTrial: boolean;
};

const PLAN_FEATURES: Record<PlanKey, { maxEmployees?: number; features: string[] }> = {
  starter: { maxEmployees: 3, features: ["employees", "audit_basic", "email_notify"] },
  business: { maxEmployees: 25, features: ["employees", "approvals", "audit_timeline", "team", "email_notify"] },
  managed: { features: ["employees", "approvals", "audit_timeline", "team", "care_ops", "policy_assist", "email_notify"] },
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

function entitlementsFromSubscription(
  sub: Subscription | null | undefined,
  demoMode = false
): Entitlements {
  const plan: PlanKey = sub?.planKey || "business";
  const status: SubscriptionStatus = sub?.status || "trialing";
  const pack = PLAN_FEATURES[plan] || PLAN_FEATURES.business;

  if (demoMode) {
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

const mockSubscription = (
  status: Subscription["status"],
  planKey: Subscription["planKey"] = "business"
): Subscription => ({
  id: "sub-1",
  orgId: "org-1",
  planKey,
  status,
  stripeSubscriptionId: null,
  trialEndsAt: null,
  currentPeriodEnd: null,
});

describe("entitlementsFromSubscription", () => {
  test("trialing status is not blocked", () => {
    const ent = entitlementsFromSubscription(mockSubscription("trialing"));
    expect(ent.blocked).toBe(false);
    expect(ent.canHire).toBe(true);
    expect(ent.expiredTrial).toBe(false);
  });

  test("active status is not blocked", () => {
    const ent = entitlementsFromSubscription(mockSubscription("active"));
    expect(ent.blocked).toBe(false);
    expect(ent.canHire).toBe(true);
    expect(ent.expiredTrial).toBe(false);
  });

  test("expired status is blocked with expiredTrial=true", () => {
    const ent = entitlementsFromSubscription(mockSubscription("expired"));
    expect(ent.blocked).toBe(true);
    expect(ent.canHire).toBe(false);
    expect(ent.expiredTrial).toBe(true);
    expect(ent.blockReasonJa).toContain("トライアル期間が終了しました");
  });

  test("past_due status is blocked but not expiredTrial", () => {
    const ent = entitlementsFromSubscription(mockSubscription("past_due"));
    expect(ent.blocked).toBe(true);
    expect(ent.canHire).toBe(false);
    expect(ent.expiredTrial).toBe(false);
  });

  test("canceled status is blocked but not expiredTrial", () => {
    const ent = entitlementsFromSubscription(mockSubscription("canceled"));
    expect(ent.blocked).toBe(true);
    expect(ent.canHire).toBe(false);
    expect(ent.expiredTrial).toBe(false);
  });

  test("incomplete status is blocked but not expiredTrial", () => {
    const ent = entitlementsFromSubscription(mockSubscription("incomplete"));
    expect(ent.blocked).toBe(true);
    expect(ent.canHire).toBe(false);
    expect(ent.expiredTrial).toBe(false);
  });

  test("unpaid status is blocked but not expiredTrial", () => {
    const ent = entitlementsFromSubscription(mockSubscription("unpaid"));
    expect(ent.blocked).toBe(true);
    expect(ent.canHire).toBe(false);
    expect(ent.expiredTrial).toBe(false);
  });

  test("null subscription defaults to trialing and is not blocked", () => {
    const ent = entitlementsFromSubscription(null);
    expect(ent.status).toBe("trialing");
    expect(ent.blocked).toBe(false);
    expect(ent.canHire).toBe(true);
    expect(ent.expiredTrial).toBe(false);
  });

  test("starter plan has maxEmployees of 3", () => {
    const ent = entitlementsFromSubscription(mockSubscription("active", "starter"));
    expect(ent.maxEmployees).toBe(3);
  });

  test("business plan has maxEmployees of 25", () => {
    const ent = entitlementsFromSubscription(mockSubscription("active", "business"));
    expect(ent.maxEmployees).toBe(25);
  });

  test("managed plan has no maxEmployees limit", () => {
    const ent = entitlementsFromSubscription(mockSubscription("active", "managed"));
    expect(ent.maxEmployees).toBeUndefined();
  });
});

describe("EXPIRED_TRIAL_GATED_TOOLS", () => {
  test("includes mail.send", () => {
    expect(EXPIRED_TRIAL_GATED_TOOLS.has("mail.send")).toBe(true);
  });

  test("includes comm.reply", () => {
    expect(EXPIRED_TRIAL_GATED_TOOLS.has("comm.reply")).toBe(true);
  });

  test("includes calendar.confirm", () => {
    expect(EXPIRED_TRIAL_GATED_TOOLS.has("calendar.confirm")).toBe(true);
  });

  test("includes sns.publish", () => {
    expect(EXPIRED_TRIAL_GATED_TOOLS.has("sns.publish")).toBe(true);
  });

  test("includes commerce.order", () => {
    expect(EXPIRED_TRIAL_GATED_TOOLS.has("commerce.order")).toBe(true);
  });

  test("includes commerce.quote", () => {
    expect(EXPIRED_TRIAL_GATED_TOOLS.has("commerce.quote")).toBe(true);
  });

  test("does not include tools.ping (read/view)", () => {
    expect(EXPIRED_TRIAL_GATED_TOOLS.has("tools.ping")).toBe(false);
  });

  test("does not include calendar.read (read/view)", () => {
    expect(EXPIRED_TRIAL_GATED_TOOLS.has("calendar.read")).toBe(false);
  });

  test("does not include calendar.propose (propose)", () => {
    expect(EXPIRED_TRIAL_GATED_TOOLS.has("calendar.propose")).toBe(false);
  });

  test("does not include mail.draft (draft)", () => {
    expect(EXPIRED_TRIAL_GATED_TOOLS.has("mail.draft")).toBe(false);
  });

  test("does not include approvals.request (approval poll)", () => {
    expect(EXPIRED_TRIAL_GATED_TOOLS.has("approvals.request")).toBe(false);
  });
});

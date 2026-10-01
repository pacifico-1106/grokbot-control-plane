"use client";

import Link from "next/link";
import { useAppSession } from "@/components/AppSessionProvider";
import { PlanBadge } from "@/components/PlanBadge";
import { PLAN_DISPLAY_INFO, type PlanKey } from "@/lib/billing/plan-scopes";

/**
 * Plan guidance for setup pages.
 * Shows current plan and available features with upgrade hints.
 */
export function PlanGuidance() {
  const {
    planKey,
    planRailsEnabled,
    scheduledPlanKey,
    scheduledPlanEffectiveAt,
  } = useAppSession();

  if (!planRailsEnabled) {
    return null;
  }

  if (!planKey) {
    return null;
  }

  const planInfo = PLAN_DISPLAY_INFO[planKey];

  return (
    <section className="surface p-5 border-l-4 border-l-[var(--accent-strong)]">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs faint font-mono">現在のプラン</p>
          <div className="mt-2 flex items-center gap-2">
            <PlanBadge planKey={planKey} showDescription />
          </div>
          <p className="mt-2 text-sm muted leading-relaxed">
            {planInfo.descriptionJa}
          </p>
        </div>
        <Link
          href="/app/billing"
          className="shrink-0 text-xs text-[var(--accent-strong)] hover:underline"
        >
          プラン詳細
        </Link>
      </div>

      {scheduledPlanKey && scheduledPlanEffectiveAt ? (
        <div className="mt-4 pt-3 border-t border-[var(--border-soft)]">
          <p className="text-xs text-[var(--warn)]">
            {new Date(scheduledPlanEffectiveAt).toLocaleDateString("ja-JP")} に{" "}
            {PLAN_DISPLAY_INFO[scheduledPlanKey]?.nameJa ?? scheduledPlanKey} プランへ変更予定
          </p>
        </div>
      ) : null}

      <PlanFeatureList planKey={planKey} />
    </section>
  );
}

function PlanFeatureList({ planKey }: { planKey: PlanKey }) {
  const features = getPlanFeatures(planKey);
  const nextPlan = getNextPlan(planKey);
  const nextPlanFeatures = nextPlan ? getNewFeaturesInPlan(planKey, nextPlan) : [];

  return (
    <div className="mt-4 pt-3 border-t border-[var(--border-soft)]">
      <p className="text-xs font-semibold text-[var(--text-muted)] mb-2">
        利用可能な機能
      </p>
      <ul className="space-y-1.5">
        {features.map((feature) => (
          <li key={feature.key} className="flex items-start gap-2 text-sm">
            <span className="text-[var(--ok)] shrink-0">✓</span>
            <span className="text-[var(--text-muted)]">{feature.label}</span>
          </li>
        ))}
      </ul>

      {nextPlan && nextPlanFeatures.length > 0 ? (
        <div className="mt-4">
          <p className="text-xs font-semibold text-[var(--text-muted)] mb-2">
            {PLAN_DISPLAY_INFO[nextPlan].nameJa} プランで追加される機能
          </p>
          <ul className="space-y-1.5">
            {nextPlanFeatures.map((feature) => (
              <li
                key={feature.key}
                className="flex items-start gap-2 text-sm opacity-60"
              >
                <span className="text-[var(--text-faint)] shrink-0">○</span>
                <span className="text-[var(--text-muted)]">{feature.label}</span>
              </li>
            ))}
          </ul>
          <Link
            href="/app/billing"
            className="mt-3 inline-flex items-center gap-1 text-xs text-[var(--accent-strong)] hover:underline"
          >
            アップグレードを検討
            <span aria-hidden>→</span>
          </Link>
        </div>
      ) : null}
    </div>
  );
}

interface PlanFeature {
  key: string;
  label: string;
}

function getPlanFeatures(planKey: PlanKey): PlanFeature[] {
  const common: PlanFeature[] = [
    { key: "employees", label: "AI社員の雇用・管理" },
    { key: "approvals", label: "承認ワークフロー" },
    { key: "read", label: "カレンダー・メール・ファイルの読み取り" },
    { key: "slack_post", label: "Slack内部投稿" },
    { key: "approval_channels", label: "Slack/LINE/Telegram通知口" },
  ];

  const proper: PlanFeature[] = [
    { key: "mail_send", label: "メール送信" },
    { key: "calendar_confirm", label: "予定の確定" },
    { key: "commerce_quote", label: "見積作成" },
    { key: "policy_editor", label: "ポリシー編集" },
    { key: "approval_routes", label: "承認ルート設定" },
  ];

  const executive: PlanFeature[] = [
    { key: "browser_use", label: "ブラウザ操作" },
    { key: "commerce_order", label: "発注実行" },
    { key: "external_sharing", label: "外部共有" },
    { key: "sns_publish", label: "SNS投稿" },
    { key: "audit_export", label: "監査ログ詳細出力" },
    { key: "identity_mgmt", label: "ID管理" },
  ];

  switch (planKey) {
    case "intern":
      return common;
    case "proper":
      return [...common, ...proper];
    case "executive":
      return [...common, ...proper, ...executive];
    default:
      return common;
  }
}

function getNextPlan(planKey: PlanKey): PlanKey | null {
  switch (planKey) {
    case "intern":
      return "proper";
    case "proper":
      return "executive";
    case "executive":
      return null;
    default:
      return null;
  }
}

function getNewFeaturesInPlan(
  currentPlan: PlanKey,
  nextPlan: PlanKey
): PlanFeature[] {
  const currentFeatures = getPlanFeatures(currentPlan);
  const nextFeatures = getPlanFeatures(nextPlan);
  const currentKeys = new Set(currentFeatures.map((f) => f.key));
  return nextFeatures.filter((f) => !currentKeys.has(f.key));
}

/**
 * Compact plan guidance for inline use.
 */
export function PlanGuidanceCompact() {
  const { planKey, planRailsEnabled } = useAppSession();

  if (!planRailsEnabled || !planKey) {
    return null;
  }

  const planInfo = PLAN_DISPLAY_INFO[planKey];

  return (
    <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
      <PlanBadge planKey={planKey} />
      <span>{planInfo.businessCapacity}</span>
      <Link
        href="/app/billing"
        className="text-[var(--accent-strong)] hover:underline"
      >
        変更
      </Link>
    </div>
  );
}

"use client";

import type {
  ApprovalKind,
  ApprovalKindQuorum,
  ApprovalKindRoute,
  DecisionWorkflowConfig,
  OrgApprovalKindRoutesPolicy,
  TopicGateConfig,
} from "@/lib/approval-kind-routes/types";
import { APPROVAL_KINDS } from "@/lib/approval-kind-routes/types";

type Props = {
  policy: OrgApprovalKindRoutesPolicy | null;
  enabled: boolean;
};

const KIND_LABELS: Record<ApprovalKind, string> = {
  post: "投稿 (post)",
  mail: "メール (mail)",
  account: "アカウント (account)",
  decision: "決裁 (decision)",
  other: "その他 (other)",
};

const KIND_DESCRIPTIONS: Record<ApprovalKind, string> = {
  post: "Slack/SNS投稿",
  mail: "メール送信",
  account: "組織・従業員設定の変更",
  decision: "稟議・決裁",
  other: "未分類ツール",
};

function formatQuorum(quorum: ApprovalKindQuorum): string {
  switch (quorum.type) {
    case "any":
      return "1名";
    case "count":
      return `${quorum.n}名`;
    case "all":
      return "全員";
    default:
      return "不明";
  }
}

function RouteCard({ route }: { route: ApprovalKindRoute }) {
  return (
    <div className="rounded-lg border border-[var(--border-soft)] p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <span className="font-medium text-sm">{KIND_LABELS[route.kind]}</span>
          <span className="text-xs text-[var(--text-muted)] ml-2">
            {KIND_DESCRIPTIONS[route.kind]}
          </span>
        </div>
        {route.kind === "account" && (
          <span className="chip chip-warning text-xs">owner/adminのみ</span>
        )}
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-2 text-sm">
        <div>
          <div className="text-xs text-[var(--text-faint)]">承認者数</div>
          <div>{route.approverUserIds.length}名</div>
        </div>

        <div>
          <div className="text-xs text-[var(--text-faint)]">Quorum</div>
          <div>{formatQuorum(route.quorum)}</div>
        </div>

        <div>
          <div className="text-xs text-[var(--text-faint)]">finalGo</div>
          <div className={route.finalGoUserId ? "text-[var(--accent-strong)]" : "text-[var(--text-muted)]"}>
            {route.finalGoUserId ? "あり" : "なし"}
          </div>
        </div>

        <div>
          <div className="text-xs text-[var(--text-faint)]">期限切れ</div>
          <div className={route.onExpire === "fail_closed" ? "text-[var(--accent-strong)]" : ""}>
            {route.onExpire === "fail_closed" ? "自動却下" : "保持"}
          </div>
        </div>

        {route.deadlineHours && (
          <div>
            <div className="text-xs text-[var(--text-faint)]">期限</div>
            <div>{route.deadlineHours}時間</div>
          </div>
        )}

        <div>
          <div className="text-xs text-[var(--text-faint)]">リマインド</div>
          <div>{route.remindEveryDays}日ごと</div>
        </div>
      </div>
    </div>
  );
}

function TopicGateCard({ config }: { config: TopicGateConfig }) {
  return (
    <div className="rounded-lg bg-[var(--bg-soft)] p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-medium text-sm">話題ゲート (Topic Gate)</h3>
        <span className={`chip text-xs ${config.enabled ? "chip-success" : "chip-neutral"}`}>
          {config.enabled ? "有効" : "無効"}
        </span>
      </div>

      {config.enabled && (
        <>
          <div>
            <div className="text-xs text-[var(--text-faint)] mb-1">機密話題 (自動承認不可)</div>
            <div className="flex flex-wrap gap-1">
              {config.sensitiveTopics.map((topic) => (
                <span key={topic} className="chip chip-warning text-xs">
                  {topic}
                </span>
              ))}
            </div>
          </div>

          {config.mainBoardChannelIds.length > 0 && (
            <div>
              <div className="text-xs text-[var(--text-faint)] mb-1">メインボードチャネル</div>
              <div className="text-sm">{config.mainBoardChannelIds.length}チャネル</div>
            </div>
          )}
        </>
      )}

      <p className="text-xs text-[var(--text-faint)]">
        P1_TOPIC_GATED_POSTING_ENABLED が ON のとき有効。
        機密話題への投稿は承認必須。
      </p>
    </div>
  );
}

function DecisionWorkflowCard({ config }: { config: DecisionWorkflowConfig }) {
  return (
    <div className="rounded-lg bg-[var(--bg-soft)] p-4 space-y-3">
      <h3 className="font-medium text-sm">決裁ワークフロー (Decision Workflow)</h3>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-2 text-sm">
        <div>
          <div className="text-xs text-[var(--text-faint)]">自動昇格閾値</div>
          <div>{config.amountThresholdJpy.toLocaleString()}円(税抜)</div>
        </div>

        <div>
          <div className="text-xs text-[var(--text-faint)]">会計年度開始</div>
          <div>{config.fiscalYearStartMonth}月{config.fiscalYearStartDay}日</div>
        </div>

        {config.deputyUserId && (
          <div>
            <div className="text-xs text-[var(--text-faint)]">代理人</div>
            <div>設定あり</div>
          </div>
        )}
      </div>

      <div className="space-y-2">
        <div className="text-xs text-[var(--text-faint)]">Tier設定</div>
        {config.tiers.map((tier) => (
          <div key={tier.tier} className="rounded border border-[var(--border-soft)] p-2 text-sm">
            <div className="flex items-center justify-between">
              <span className="font-medium">{tier.tier}: {tier.nameJa}</span>
              <span className="text-xs text-[var(--text-muted)]">
                {tier.approverUserIds.length}名 / {formatQuorum(tier.quorum)}
              </span>
            </div>
            {tier.deadlineHours && (
              <div className="text-xs text-[var(--text-muted)] mt-1">
                期限: {tier.deadlineHours}時間 ({tier.onExpire === "fail_closed" ? "自動却下" : "保持"})
              </div>
            )}
          </div>
        ))}
      </div>

      <p className="text-xs text-[var(--text-faint)]">
        P1_DECISION_WORKFLOW_ENABLED が ON のとき有効。
        閾値超過でT2自動昇格、定款変更・役員・決算はT3。
      </p>
    </div>
  );
}

export function ApprovalKindRoutesClient({ policy, enabled }: Props) {
  if (!enabled) {
    return (
      <section className="surface p-5 space-y-4">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h2 className="font-medium">承認ルート設定</h2>
            <p className="text-sm text-[var(--text-muted)] mt-1">
              ツール種類ごとの承認ルート。Quorum、期限、リマインドを設定できます。
            </p>
          </div>
          <span className="chip chip-neutral text-xs shrink-0">無効</span>
        </div>

        <div className="rounded-lg bg-[var(--bg-soft)] p-4">
          <p className="text-sm">
            <code className="font-mono text-xs">P1_APPROVAL_KIND_ROUTES_ENABLED</code> が OFF です。
          </p>
          <p className="text-xs text-[var(--text-muted)] mt-2">
            有効にすると、ツール種類（post, mail, account, decision, other）ごとに承認ルートを設定できます。
            既存の routes[] (class=admin|business) は自動的に移行されます。
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="surface p-5 space-y-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="font-medium">{policy?.policyName || "承認ルート設定"}</h2>
          <p className="text-sm text-[var(--text-muted)] mt-1">
            ツール種類ごとの承認ルート。Quorum、期限、リマインドを設定できます。
          </p>
          {policy?.policyId && (
            <p className="text-xs text-[var(--text-faint)] mt-1">
              Policy ID: <code className="font-mono">{policy.policyId}</code>
            </p>
          )}
        </div>
        <span className="chip chip-neutral text-xs shrink-0">読み取り専用</span>
      </div>

      {policy ? (
        <>
          <div className="space-y-3">
            <p className="text-xs text-[var(--text-faint)]">
              {policy.routes.length}種類のルート • AI承認者禁止 • 自己承認禁止 • account種類はowner/adminのみ
            </p>
            {policy.routes.map((route) => (
              <RouteCard key={route.kind} route={route} />
            ))}
          </div>

          {policy.topicGate && <TopicGateCard config={policy.topicGate} />}

          {policy.decisionWorkflow && <DecisionWorkflowCard config={policy.decisionWorkflow} />}

          <p className="text-xs text-[var(--text-faint)]">
            最終更新: {new Date(policy.updatedAt).toLocaleString("ja-JP")} by {policy.updatedBy} •{" "}
            編集するには Admin MCP{" "}
            <code className="font-mono text-[10px]">approvalRoutes.patch</code> (always_human)
          </p>
        </>
      ) : (
        <div className="rounded-lg bg-[var(--bg-soft)] p-4 space-y-2">
          <p className="text-sm font-medium">デフォルト設定</p>
          <ul className="text-sm text-[var(--text-muted)] space-y-1">
            {APPROVAL_KINDS.map((kind) => (
              <li key={kind}>
                • {KIND_LABELS[kind]}: owner 1名承認
              </li>
            ))}
          </ul>
          <p className="text-xs text-[var(--text-faint)] mt-2">
            カスタマイズするには Admin MCP{" "}
            <code className="font-mono text-[10px]">approvalRoutes.patch</code> (always_human) を使用します。
          </p>
        </div>
      )}
    </section>
  );
}

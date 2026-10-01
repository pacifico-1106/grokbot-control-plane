"use client";

import { useState, useCallback } from "react";
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
  members?: { id: string; displayName: string; email: string; role: string }[];
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

function RouteCard({
  route,
  isEditing,
  onUpdate,
  members,
}: {
  route: ApprovalKindRoute;
  isEditing: boolean;
  onUpdate?: (route: ApprovalKindRoute) => void;
  members?: { id: string; displayName: string; email: string; role: string }[];
}) {
  const eligibleMembers = members?.filter((m) =>
    route.kind === "account" ? ["owner", "admin"].includes(m.role) : true
  ) ?? [];

  const handleApproverToggle = (memberId: string) => {
    if (!onUpdate) return;
    const current = route.approverUserIds;
    const next = current.includes(memberId)
      ? current.filter((id) => id !== memberId)
      : [...current, memberId];
    onUpdate({ ...route, approverUserIds: next });
  };

  const handleQuorumChange = (type: "any" | "count" | "all", n?: number) => {
    if (!onUpdate) return;
    let quorum: ApprovalKindQuorum;
    if (type === "count" && n !== undefined) {
      quorum = { type: "count", n };
    } else if (type === "all") {
      quorum = { type: "all" };
    } else {
      quorum = { type: "any" };
    }
    onUpdate({ ...route, quorum });
  };

  const handleFinalGoChange = (userId: string | null) => {
    if (!onUpdate) return;
    onUpdate({ ...route, finalGoUserId: userId });
  };

  const handleOnExpireChange = (onExpire: "fail_closed" | "keep_open") => {
    if (!onUpdate) return;
    onUpdate({ ...route, onExpire });
  };

  const handleDeadlineChange = (hours: number | null) => {
    if (!onUpdate) return;
    onUpdate({ ...route, deadlineHours: hours });
  };

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

      {isEditing ? (
        <div className="space-y-4">
          <div>
            <label className="text-xs text-[var(--text-faint)] block mb-1">承認者</label>
            <div className="flex flex-wrap gap-2">
              {eligibleMembers.map((m) => (
                <label key={m.id} className="flex items-center gap-1 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={route.approverUserIds.includes(m.id)}
                    onChange={() => handleApproverToggle(m.id)}
                    className="rounded"
                  />
                  {m.displayName || m.email}
                </label>
              ))}
              {eligibleMembers.length === 0 && (
                <span className="text-xs text-[var(--text-muted)]">
                  利用可能なメンバーがいません
                </span>
              )}
            </div>
            {route.approverUserIds.length === 0 && (
              <p className="text-xs text-red-500 mt-1">承認者は1名以上必要です</p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-xs text-[var(--text-faint)] block mb-1">Quorum</label>
              <select
                value={route.quorum.type === "count" ? `count_${route.quorum.n}` : route.quorum.type}
                onChange={(e) => {
                  const val = e.target.value;
                  if (val === "any") handleQuorumChange("any");
                  else if (val === "all") handleQuorumChange("all");
                  else if (val.startsWith("count_")) {
                    handleQuorumChange("count", parseInt(val.replace("count_", ""), 10));
                  }
                }}
                className="input-field text-sm w-full"
              >
                <option value="any">1名 (any)</option>
                {[2, 3, 4, 5].map((n) => (
                  <option key={n} value={`count_${n}`}>{n}名</option>
                ))}
                <option value="all">全員</option>
              </select>
            </div>

            <div>
              <label className="text-xs text-[var(--text-faint)] block mb-1">期限切れ時</label>
              <select
                value={route.onExpire}
                onChange={(e) => handleOnExpireChange(e.target.value as "fail_closed" | "keep_open")}
                className="input-field text-sm w-full"
              >
                <option value="keep_open">保持</option>
                <option value="fail_closed">自動却下</option>
              </select>
            </div>

            <div>
              <label className="text-xs text-[var(--text-faint)] block mb-1">期限 (時間)</label>
              <input
                type="number"
                value={route.deadlineHours ?? ""}
                onChange={(e) => handleDeadlineChange(e.target.value ? parseInt(e.target.value, 10) : null)}
                placeholder="無制限"
                className="input-field text-sm w-full"
                min={1}
              />
            </div>

            <div>
              <label className="text-xs text-[var(--text-faint)] block mb-1">finalGo</label>
              <select
                value={route.finalGoUserId ?? ""}
                onChange={(e) => handleFinalGoChange(e.target.value || null)}
                className="input-field text-sm w-full"
              >
                <option value="">なし</option>
                {route.approverUserIds.map((id) => {
                  const m = members?.find((m) => m.id === id);
                  return (
                    <option key={id} value={id}>
                      {m?.displayName || m?.email || id}
                    </option>
                  );
                })}
              </select>
            </div>
          </div>
        </div>
      ) : (
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
              {route.onExpire === "fail_closed" ? "自動却下" : "継続"}
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
      )}
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
        {config.amountThresholdJpy != null && (
          <div>
            <div className="text-xs text-[var(--text-faint)]">自動昇格閾値 (非推奨)</div>
            <div>{config.amountThresholdJpy.toLocaleString()}円(税抜)</div>
          </div>
        )}

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
        段の自動振り分け（キーワード・金額・カテゴリ）は会社ごとの tierRouting 設定に従います。未設定なら最下位の段に回ります。
      </p>
    </div>
  );
}

function createDefaultRoutes(): ApprovalKindRoute[] {
  return APPROVAL_KINDS.map((kind) => ({
    kind,
    approverUserIds: [],
    quorum: { type: "any" as const },
    finalGoUserId: null,
    deadlineHours: null,
    onExpire: "keep_open" as const,
    remindEveryDays: 3,
  }));
}

export function ApprovalKindRoutesClient({ policy, enabled, members }: Props) {
  const [isEditing, setIsEditing] = useState(false);
  const [editedRoutes, setEditedRoutes] = useState<ApprovalKindRoute[]>(() =>
    policy?.routes ?? createDefaultRoutes()
  );
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);

  const handleRouteUpdate = useCallback((updatedRoute: ApprovalKindRoute) => {
    setEditedRoutes((prev) =>
      prev.map((r) => (r.kind === updatedRoute.kind ? updatedRoute : r))
    );
  }, []);

  const handleSave = async () => {
    setSaveError(null);
    setSaveSuccess(false);

    const hasEmptyApprovers = editedRoutes.some((r) => r.approverUserIds.length === 0);
    if (hasEmptyApprovers) {
      setSaveError("全てのルートに少なくとも1名の承認者が必要です");
      return;
    }

    const accountRoute = editedRoutes.find((r) => r.kind === "account");
    if (accountRoute && members) {
      const invalidApprovers = accountRoute.approverUserIds.filter((id) => {
        const m = members.find((m) => m.id === id);
        return m && !["owner", "admin"].includes(m.role);
      });
      if (invalidApprovers.length > 0) {
        setSaveError("account種類の承認者はowner/adminのみです");
        return;
      }
    }

    setIsSaving(true);

    try {
      const proposedPolicy: OrgApprovalKindRoutesPolicy = {
        version: 1,
        policyId: policy?.policyId || `policy-${Date.now()}`,
        policyName: policy?.policyName || "承認ルート設定",
        routes: editedRoutes,
        topicGate: policy?.topicGate,
        decisionWorkflow: policy?.decisionWorkflow,
        updatedAt: new Date().toISOString(),
        updatedBy: "web_api",
      };

      const beforeStateHash = policy
        ? Buffer.from(JSON.stringify(policy)).toString("base64").slice(0, 32)
        : "";

      const res = await fetch("/api/approval-routes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ policy: proposedPolicy, beforeStateHash }),
      });

      const data = await res.json();

      if (!res.ok) {
        if (data.error === "before_state_mismatch") {
          setSaveError("設定が他のユーザーによって更新されました。ページを再読み込みしてください。");
        } else if (data.errors) {
          setSaveError(`バリデーションエラー: ${data.errors.join(", ")}`);
        } else {
          setSaveError(data.error || "保存に失敗しました");
        }
        return;
      }

      setSaveSuccess(true);
      setIsEditing(false);
    } catch (err) {
      setSaveError("ネットワークエラーが発生しました");
    } finally {
      setIsSaving(false);
    }
  };

  const handleCancel = () => {
    setEditedRoutes(policy?.routes ?? createDefaultRoutes());
    setIsEditing(false);
    setSaveError(null);
  };

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
        {!isEditing ? (
          <button
            onClick={() => setIsEditing(true)}
            className="btn btn-secondary text-xs"
          >
            編集
          </button>
        ) : (
          <span className="chip chip-warning text-xs shrink-0">編集中</span>
        )}
      </div>

      {saveError && (
        <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-700">
          {saveError}
        </div>
      )}

      {saveSuccess && (
        <div className="rounded-lg bg-green-50 border border-green-200 p-3 text-sm text-green-700">
          変更リクエストを送信しました。承認後に設定が適用されます。
        </div>
      )}

      <div className="space-y-3">
        <p className="text-xs text-[var(--text-faint)]">
          {(isEditing ? editedRoutes : policy?.routes ?? []).length}種類のルート • AI承認者禁止 • 自己承認禁止 • account種類はowner/adminのみ
        </p>
        {(isEditing ? editedRoutes : policy?.routes ?? createDefaultRoutes()).map((route) => (
          <RouteCard
            key={route.kind}
            route={route}
            isEditing={isEditing}
            onUpdate={isEditing ? handleRouteUpdate : undefined}
            members={members}
          />
        ))}
      </div>

      {policy?.topicGate && <TopicGateCard config={policy.topicGate} />}

      {policy?.decisionWorkflow && <DecisionWorkflowCard config={policy.decisionWorkflow} />}

      {isEditing ? (
        <div className="flex gap-2 pt-2">
          <button
            onClick={handleSave}
            disabled={isSaving}
            className="btn btn-primary text-sm"
          >
            {isSaving ? "送信中..." : "変更を申請"}
          </button>
          <button
            onClick={handleCancel}
            disabled={isSaving}
            className="btn btn-secondary text-sm"
          >
            キャンセル
          </button>
          <p className="text-xs text-[var(--text-faint)] self-center ml-2">
            変更は承認が必要です (always_human)
          </p>
        </div>
      ) : (
        <p className="text-xs text-[var(--text-faint)]">
          {policy ? (
            <>
              最終更新: {new Date(policy.updatedAt).toLocaleString("ja-JP")} by {policy.updatedBy}
            </>
          ) : (
            "デフォルト設定"
          )}
        </p>
      )}
    </section>
  );
}

"use client";

import type {
  AttachmentApproval,
  AttachmentHandoff,
  BodyHandoff,
  IngressApplyTo,
  IngressHandoffRule,
  OrgIngressHandoffPolicy,
  SealithHandoff,
} from "@/lib/types";

type Props = {
  policy: OrgIngressHandoffPolicy;
  isDefault: boolean;
};

const APPLY_TO_LABELS: Record<IngressApplyTo, string> = {
  all: "全て",
  channels: "指定チャネル",
  classified_external_sensitive: "外部/機密分類",
};

const BODY_HANDOFF_LABELS: Record<BodyHandoff, string> = {
  full: "全文",
  prefix: "先頭のみ",
  none: "渡さない",
};

const ATTACHMENT_HANDOFF_LABELS: Record<AttachmentHandoff, string> = {
  file: "ファイル",
  meta: "メタ情報のみ",
  none: "渡さない",
};

const ATTACHMENT_APPROVAL_LABELS: Record<AttachmentApproval, string> = {
  none: "なし",
  manager: "上長承認",
};

const SEALITH_HANDOFF_LABELS: Record<SealithHandoff, string> = {
  off: "オフ",
  suggest: "推奨",
  required: "必須",
};

const SEALITH_HINT_LABELS: Record<string, string> = {
  contract: "契約書",
  nda: "秘密保持",
  quote: "見積書",
  other: "その他",
};

function RuleCard({ rule, index }: { rule: IngressHandoffRule; index: number }) {
  const bodyDisplay =
    rule.body === "prefix" && rule.bodyPrefixChars
      ? `先頭${rule.bodyPrefixChars}文字`
      : BODY_HANDOFF_LABELS[rule.body];

  const sealithHints =
    rule.sealithRequiredHints && rule.sealithRequiredHints.length > 0
      ? rule.sealithRequiredHints.map((h) => SEALITH_HINT_LABELS[h] || h).join("、")
      : null;

  return (
    <div className="rounded-lg border border-[var(--border-soft)] p-4 space-y-3">
      <div className="flex items-center gap-2">
        <span className="chip chip-neutral text-xs">#{index + 1}</span>
        <span className="font-medium text-sm">{APPLY_TO_LABELS[rule.applyTo]}</span>
        {rule.applyTo === "channels" && rule.channelIds && (
          <span className="text-xs text-[var(--text-muted)]">
            ({rule.channelIds.length}チャネル)
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-2 text-sm">
        <div>
          <div className="text-xs text-[var(--text-faint)]">本文の渡し方</div>
          <div>{bodyDisplay}</div>
        </div>

        {rule.body === "prefix" && rule.bodyPrefixChars && (
          <div>
            <div className="text-xs text-[var(--text-faint)]">先頭の文字数</div>
            <div>{rule.bodyPrefixChars}文字</div>
          </div>
        )}

        <div>
          <div className="text-xs text-[var(--text-faint)]">添付の渡し方</div>
          <div>{ATTACHMENT_HANDOFF_LABELS[rule.attachment]}</div>
        </div>

        {rule.attachment !== "none" && rule.attachmentApproval && (
          <div>
            <div className="text-xs text-[var(--text-faint)]">添付を渡す前の承認</div>
            <div>{ATTACHMENT_APPROVAL_LABELS[rule.attachmentApproval]}</div>
          </div>
        )}

        <div>
          <div className="text-xs text-[var(--text-faint)]">Sealithへの暗号化受け渡し</div>
          <div className={rule.sealith === "required" ? "text-[var(--accent-strong)]" : ""}>
            {SEALITH_HANDOFF_LABELS[rule.sealith]}
          </div>
        </div>

        {rule.sealith !== "off" && sealithHints && (
          <div>
            <div className="text-xs text-[var(--text-faint)]">必須にする目安</div>
            <div>
              {sealithHints}
              {rule.sealithRequiredOtherText && (
                <span className="text-xs text-[var(--text-muted)]">
                  {" "}
                  ({rule.sealithRequiredOtherText})
                </span>
              )}
            </div>
          </div>
        )}

        <div>
          <div className="text-xs text-[var(--text-faint)]">監査のひも付け</div>
          <div>
            {rule.audit.sealithTransferId ? (
              <span className="text-[var(--accent-strong)]">sealithTransferId あり</span>
            ) : (
              <span className="text-[var(--text-muted)]">jobId のみ</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export function IngressHandoffPolicyClient({ policy, isDefault }: Props) {
  const hasHighRiskConfig =
    policy.rules.some(
      (r) =>
        r.applyTo === "classified_external_sensitive" &&
        r.attachment === "file" &&
        r.sealith === "off"
    );
  const hasHighRiskConsent = Boolean(policy.highRiskConsentAt);

  return (
    <section className="surface p-5 space-y-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="font-medium">{policy.policyName || "受信の渡し方（組織ポリシー）"}</h2>
          <p className="text-sm text-[var(--text-muted)] mt-1">
            Slack/外部からのメッセージをAI社員にどう渡すか。ルールは評価順（first-match）。AI社員ごとにオーバーライド可能。
          </p>
          {policy.policyId && (
            <p className="text-xs text-[var(--text-faint)] mt-1">
              Policy ID: <code className="font-mono">{policy.policyId}</code>
            </p>
          )}
        </div>
        <div className="flex flex-col items-end gap-1">
          <span className="chip chip-neutral text-xs shrink-0">読み取り専用</span>
          {hasHighRiskConfig && (
            <span
              className={`chip text-xs shrink-0 ${
                hasHighRiskConsent
                  ? "chip-warning"
                  : "chip-danger"
              }`}
            >
              {hasHighRiskConsent ? "高リスク承諾済" : "高リスク警告"}
            </span>
          )}
        </div>
      </div>

      {isDefault ? (
        <div className="rounded-lg bg-[var(--bg-soft)] p-4 space-y-2">
          <p className="text-sm font-medium">デフォルトの便利設定</p>
          <ul className="text-sm text-[var(--text-muted)] space-y-1">
            <li>• 本文の渡し方: 全文</li>
            <li>• 添付の渡し方: メタ情報のみ</li>
            <li>• Sealithへの暗号化受け渡し: オフ</li>
          </ul>
          <p className="text-xs text-[var(--text-faint)] mt-2">
            外部/機密チャネルにはルールを追加してください。組織全体を編集するには Admin MCP{" "}
            <code className="font-mono text-[10px]">ingressHandoff.patch</code> (always_human)。
            AI社員ごとにオーバーライドする場合は employeeId を指定します。
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-[var(--text-faint)]">
            {policy.rules.length}ルール • 評価順で最初にマッチしたルールが適用されます • AI社員ごとにオーバーライド可能
          </p>
          {policy.rules.map((rule, index) => (
            <RuleCard key={rule.id} rule={rule} index={index} />
          ))}
          {hasHighRiskConfig && (
            <div
              className={`rounded-lg p-3 text-sm ${
                hasHighRiskConsent
                  ? "bg-amber-50 text-amber-900 dark:bg-amber-900/20 dark:text-amber-200"
                  : "bg-red-50 text-red-900 dark:bg-red-900/20 dark:text-red-200"
              }`}
            >
              {hasHighRiskConsent ? (
                <>
                  <p className="font-medium">高リスク設定の承諾あり</p>
                  <p className="text-xs mt-1">
                    承諾日時: {new Date(policy.highRiskConsentAt!).toLocaleString("ja-JP")}
                    {policy.highRiskConsentBy && ` • 承諾者: ${policy.highRiskConsentBy}`}
                  </p>
                </>
              ) : (
                <>
                  <p className="font-medium">【高リスク警告】テナント承諾が必要です</p>
                  <p className="text-xs mt-1">
                    外部/機密チャネルにファイル本体をSealithなしで渡す設定があります。
                    Admin MCP の highRiskConsentAt/By を設定してください。
                  </p>
                </>
              )}
            </div>
          )}
          <p className="text-xs text-[var(--text-faint)]">
            最終更新: {new Date(policy.updatedAt).toLocaleString("ja-JP")} • 組織全体を編集するには Admin MCP{" "}
            <code className="font-mono text-[10px]">ingressHandoff.patch</code> (always_human)。
            AI社員ごとのオーバーライドは employeeId 指定。
          </p>
        </div>
      )}
    </section>
  );
}

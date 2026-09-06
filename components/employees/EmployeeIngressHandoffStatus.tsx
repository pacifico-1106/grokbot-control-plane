"use client";

import type {
  IngressHandoffPolicySource,
  EffectiveIngressHandoffPolicy,
} from "@/lib/data";
import type {
  AttachmentHandoff,
  BodyHandoff,
  IngressApplyTo,
  IngressHandoffRule,
  OrgIngressHandoffPolicy,
  SealithHandoff,
} from "@/lib/types";

type Props = {
  effective: EffectiveIngressHandoffPolicy;
};

const SOURCE_LABELS: Record<IngressHandoffPolicySource, string> = {
  employee: "社員オーバーライド",
  org: "組織ポリシー",
  default: "デフォルト",
};

const SOURCE_CHIPS: Record<IngressHandoffPolicySource, string> = {
  employee: "chip-accent",
  org: "chip-neutral",
  default: "chip-neutral",
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

const SEALITH_HANDOFF_LABELS: Record<SealithHandoff, string> = {
  off: "オフ",
  suggest: "推奨",
  required: "必須",
};

function RuleSummary({ rule }: { rule: IngressHandoffRule }) {
  const bodyDisplay =
    rule.body === "prefix" && rule.bodyPrefixChars
      ? `先頭${rule.bodyPrefixChars}文字`
      : BODY_HANDOFF_LABELS[rule.body];

  return (
    <div className="flex flex-wrap gap-2 text-xs">
      <span className="chip chip-neutral">{APPLY_TO_LABELS[rule.applyTo]}</span>
      <span>本文={bodyDisplay}</span>
      <span>添付={ATTACHMENT_HANDOFF_LABELS[rule.attachment]}</span>
      <span className={rule.sealith === "required" ? "text-[var(--accent-strong)]" : ""}>
        Sealith={SEALITH_HANDOFF_LABELS[rule.sealith]}
      </span>
    </div>
  );
}

function PolicyDetails({ policy, label }: { policy: OrgIngressHandoffPolicy | null; label: string }) {
  if (!policy) {
    return (
      <div className="text-xs muted">
        <span className="font-medium">{label}:</span> 未設定
      </div>
    );
  }

  return (
    <details className="text-xs">
      <summary className="cursor-pointer font-medium">
        {label}: {policy.rules.length}ルール
      </summary>
      <div className="mt-2 space-y-2 pl-2 border-l border-[var(--border-soft)]">
        {policy.rules.map((rule, index) => (
          <div key={rule.id}>
            <span className="text-[var(--text-faint)]">#{index + 1}</span>
            <RuleSummary rule={rule} />
          </div>
        ))}
      </div>
    </details>
  );
}

export function EmployeeIngressHandoffStatus({ effective }: Props) {
  const { policy, source, employeeOverride, orgPolicy } = effective;

  return (
    <section className="surface p-5 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="font-medium">受信の渡し方</h2>
          <p className="text-sm text-[var(--text-muted)] mt-1">
            Slack/外部からのメッセージをどう渡すか（AI社員ごとに設定可能）
          </p>
        </div>
        <span className={`chip ${SOURCE_CHIPS[source]} text-xs shrink-0`}>
          {SOURCE_LABELS[source]}
        </span>
      </div>

      <div className="rounded-lg bg-[var(--bg-soft)] p-4 space-y-3">
        <p className="text-sm font-medium">現在の適用ルール</p>
        {policy.rules.map((rule, index) => (
          <div key={rule.id} className="flex items-start gap-2">
            <span className="chip chip-neutral text-[10px]">#{index + 1}</span>
            <RuleSummary rule={rule} />
          </div>
        ))}
      </div>

      <div className="pt-2 border-t border-[var(--border-soft)] space-y-2">
        <p className="text-xs font-medium text-[var(--text-faint)]">フォールバック順: 社員オーバーライド → 組織ポリシー → デフォルト</p>
        
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <PolicyDetails policy={employeeOverride} label="社員オーバーライド" />
          <PolicyDetails policy={orgPolicy} label="組織ポリシー" />
        </div>
      </div>

      <p className="text-xs text-[var(--text-faint)] pt-2">
        編集は Admin MCP{" "}
        <code className="font-mono text-[10px]">ingressHandoff.patch</code>{" "}
        (always_human)。社員ごとに設定する場合は employeeId を指定。クリアして組織ポリシーを継承するには clearOverride=true。
      </p>
    </section>
  );
}

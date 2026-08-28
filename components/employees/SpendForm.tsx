"use client";

import type { ApprovalPolicy, SpendLimits } from "@/lib/types";

const MERCHANT_CHIPS = ["eSIMのみ", "オフィス消耗品", "クラウドSaaS", "指定なし"];

export function SpendForm({
  approvalPolicy,
  setApprovalPolicy,
  spend,
  patchSpend,
  disabled = false,
}: {
  approvalPolicy: ApprovalPolicy;
  setApprovalPolicy: (p: ApprovalPolicy) => void;
  spend: SpendLimits;
  patchSpend: (p: Partial<SpendLimits>) => void;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-4">
      <fieldset className="space-y-2" disabled={disabled}>
        <legend className="text-sm muted">購入の承認モード</legend>
        <label className="flex items-start gap-2 text-sm cursor-pointer">
          <input
            type="radio"
            name="purchaseApproval"
            className="mt-1"
            checked={approvalPolicy === "always_human"}
            onChange={() => setApprovalPolicy("always_human")}
            disabled={disabled}
          />
          <span>
            <span className="font-medium">常に人間が承認</span>
            <span className="block text-xs muted mt-0.5">
              安心優先。少額でも毎回社長（または管理者）が OK します。
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm cursor-pointer">
          <input
            type="radio"
            name="purchaseApproval"
            className="mt-1"
            checked={approvalPolicy === "risk_based"}
            onChange={() => setApprovalPolicy("risk_based")}
            disabled={disabled}
          />
          <span>
            <span className="font-medium">少額は自動（リスクベース）</span>
            <span className="block text-xs muted mt-0.5">
              下の上限以内だけ自動。超えたら承認待ち。上限未設定は自動しません。
            </span>
          </span>
        </label>
      </fieldset>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <label className="block text-sm">
          <span className="muted">1件あたり上限（円）</span>
          <input
            type="number"
            min={0}
            value={spend.maxPerOrderJpy}
            onChange={(e) =>
              patchSpend({ maxPerOrderJpy: Number(e.target.value) || 0 })
            }
            className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm"
            disabled={disabled}
          />
          <span className="mt-1 block text-[11px] faint">
            目安 3,000。0 = 発注禁止（自動不可）
          </span>
        </label>
        <label className="block text-sm">
          <span className="muted">1日あたり上限（任意）</span>
          <input
            type="number"
            min={0}
            placeholder="未設定"
            value={spend.maxPerDayJpy ?? ""}
            onChange={(e) =>
              patchSpend({
                maxPerDayJpy:
                  e.target.value === "" ? null : Number(e.target.value) || 0,
              })
            }
            className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm"
            disabled={disabled}
          />
        </label>
        <label className="block text-sm">
          <span className="muted">月あたり上限（任意）</span>
          <input
            type="number"
            min={0}
            placeholder="未設定"
            value={spend.maxPerMonthJpy ?? ""}
            onChange={(e) =>
              patchSpend({
                maxPerMonthJpy:
                  e.target.value === "" ? null : Number(e.target.value) || 0,
              })
            }
            className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm"
            disabled={disabled}
          />
        </label>
      </div>

      <div>
        <div className="text-sm muted mb-2">買ってよいもののヒント（任意）</div>
        <div className="flex flex-wrap gap-2 mb-2">
          {MERCHANT_CHIPS.map((chip) => (
            <button
              key={chip}
              type="button"
              className={`chip ${spend.merchantAllowTip === chip ? "chip-ok" : ""}`}
              onClick={() =>
                patchSpend({
                  merchantAllowTip: chip === "指定なし" ? null : chip,
                })
              }
              disabled={disabled}
            >
              {chip}
            </button>
          ))}
        </div>
        <input
          value={spend.merchantAllowTip ?? ""}
          onChange={(e) =>
            patchSpend({ merchantAllowTip: e.target.value || null })
          }
          placeholder="例: 海外渡航用 eSIM のみ"
          className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm"
          disabled={disabled}
        />
      </div>

      <label className="flex items-start gap-2 text-sm cursor-pointer">
        <input
          type="checkbox"
          className="mt-1"
          checked={spend.firstOrderRequiresHuman !== false}
          onChange={(e) =>
            patchSpend({ firstOrderRequiresHuman: e.target.checked })
          }
          disabled={disabled}
        />
        <span>
          <span className="font-medium">初回発注は必ず人間承認</span>
          <span className="block text-xs muted mt-0.5">
            おすすめ ON。初めての買い物は社長が一度目を通します。
          </span>
        </span>
      </label>
    </div>
  );
}

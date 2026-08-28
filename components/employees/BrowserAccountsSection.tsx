"use client";

import {
  ACCOUNT_SERVICE_PRESETS,
  emptyAllowedAccount,
} from "@/lib/employees/allowed-accounts";
import type { AllowedAccount } from "@/lib/types";

export function BrowserAccountsSection({
  browserAllowed,
  setBrowserAllowed,
  allowedAccounts,
  setAllowedAccounts,
  disabled = false,
}: {
  browserAllowed: boolean;
  setBrowserAllowed: (on: boolean) => void;
  allowedAccounts: AllowedAccount[];
  setAllowedAccounts: (rows: AllowedAccount[]) => void;
  disabled?: boolean;
}) {
  function patchRow(index: number, partial: Partial<AllowedAccount>) {
    if (disabled) return;
    setAllowedAccounts(
      allowedAccounts.map((row, i) => (i === index ? { ...row, ...partial } : row))
    );
  }

  function removeRow(index: number) {
    if (disabled) return;
    setAllowedAccounts(allowedAccounts.filter((_, i) => i !== index));
  }

  function addRow(service = "google") {
    if (disabled) return;
    setAllowedAccounts([...allowedAccounts, emptyAllowedAccount(service)]);
  }

  return (
    <div className="rounded-lg border border-[var(--border-soft)] p-4 space-y-4">
      <div>
        <h3 className="text-sm font-medium">ブラウザ・外部アカウント</h3>
        <p className="mt-2 text-xs muted leading-relaxed">
          共有PCではログインが混ざる可能性があるため、使ってよいIDを社員証に刻みます。不一致時は要確認／停止。
        </p>
      </div>

      <label className="flex items-start gap-2 text-sm cursor-pointer">
        <input
          type="checkbox"
          className="mt-1"
          checked={browserAllowed}
          onChange={(e) => setBrowserAllowed(e.target.checked)}
          disabled={disabled}
        />
        <span>
          <span className="font-medium">ブラウザ利用を許可する</span>
          <span className="block text-xs muted mt-0.5">
            ON にすると「ブラウザ利用」が許可されます。共有のログインのまま個人のIDで動かさないでください。
          </span>
        </span>
      </label>

      <div>
        <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
          <span className="text-sm muted">許可する外部アカウント</span>
          <button
            type="button"
            className="chip text-[11px]"
            onClick={() => addRow(browserAllowed ? "google" : "google")}
            disabled={disabled}
          >
            ＋ 追加
          </button>
        </div>
        <div className="flex flex-wrap gap-2 mb-3">
          {ACCOUNT_SERVICE_PRESETS.map((preset) => (
            <button
              key={preset.key}
              type="button"
              className="chip text-[11px]"
              onClick={() =>
                addRow(preset.key === "other" ? "" : preset.key)
              }
              disabled={disabled}
            >
              {preset.label}
            </button>
          ))}
        </div>

        {allowedAccounts.length === 0 ? (
          <p className="text-xs faint">
            まだありません。チップからサービスを選ぶか「追加」してください（Google以外のSNSもOK）。
          </p>
        ) : (
          <ul className="space-y-3">
            {allowedAccounts.map((row, index) => {
              const isOther =
                !ACCOUNT_SERVICE_PRESETS.some(
                  (p) => p.key === row.service && p.key !== "other"
                );
              return (
                <li
                  key={index}
                  className="rounded-lg border border-[var(--border)] bg-[var(--bg)] p-3 space-y-2"
                >
                  <div className="grid md:grid-cols-2 gap-2">
                    <label className="block text-xs">
                      <span className="muted">サービス</span>
                      <select
                        value={
                          ACCOUNT_SERVICE_PRESETS.some(
                            (p) => p.key === row.service && p.key !== "other"
                          )
                            ? row.service
                            : "other"
                        }
                        onChange={(e) => {
                          const v = e.target.value;
                          if (v === "other") {
                            patchRow(index, {
                              service: row.service && isOther ? row.service : "",
                            });
                          } else {
                            patchRow(index, {
                              service: v,
                              browserRequired:
                                v === "google" || v === "microsoft365"
                                  ? true
                                  : row.browserRequired,
                            });
                          }
                        }}
                        className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--bg-soft)] px-2 py-1.5 text-sm"
                        disabled={disabled}
                      >
                        {ACCOUNT_SERVICE_PRESETS.map((preset) => (
                          <option key={preset.key} value={preset.key}>
                            {preset.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    {isOther ||
                    !ACCOUNT_SERVICE_PRESETS.some(
                      (p) => p.key === row.service && p.key !== "other"
                    ) ? (
                      <label className="block text-xs">
                        <span className="muted">サービス名（自由記入）</span>
                        <input
                          value={row.service}
                          onChange={(e) =>
                            patchRow(index, { service: e.target.value })
                          }
                          placeholder="例: Chatwork / Notion"
                          className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--bg-soft)] px-2 py-1.5 text-sm"
                          disabled={disabled}
                        />
                      </label>
                    ) : (
                      <label className="block text-xs">
                        <span className="muted">表示ラベル（任意）</span>
                        <input
                          value={row.label ?? ""}
                          onChange={(e) =>
                            patchRow(index, { label: e.target.value })
                          }
                          placeholder="例: 営業用Google"
                          className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--bg-soft)] px-2 py-1.5 text-sm"
                          disabled={disabled}
                        />
                      </label>
                    )}
                  </div>
                  <label className="block text-xs">
                    <span className="muted">アカウントID（メール / @handle / ページID）</span>
                    <input
                      value={row.accountId}
                      onChange={(e) =>
                        patchRow(index, { accountId: e.target.value })
                      }
                      placeholder="例: sales@company.co.jp / @brand_jp"
                      className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--bg-soft)] px-2 py-1.5 text-sm"
                      disabled={disabled}
                    />
                  </label>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <label className="flex items-center gap-2 text-xs cursor-pointer">
                      <input
                        type="checkbox"
                        checked={row.browserRequired === true}
                        onChange={(e) =>
                          patchRow(index, {
                            browserRequired: e.target.checked,
                          })
                        }
                        disabled={disabled}
                      />
                      ブラウザ一致を重視
                    </label>
                    <button
                      type="button"
                      className="text-xs text-[var(--danger)]"
                      onClick={() => removeRow(index)}
                      disabled={disabled}
                    >
                      削除
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

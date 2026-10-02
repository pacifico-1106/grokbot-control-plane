"use client";

import { useCallback, useState } from "react";
import {
  buildChannelScopePatchBody,
  channelScopeErrorJa,
  channelScopeModeLabelJa,
  channelScopeSourceLabelJa,
  type ChannelScopeFormState,
} from "@/lib/channel-scope/ui";
import type { ChannelScopeMode } from "@/lib/channel-scope/types";

type ScopeView = {
  enabled: boolean;
  flags?: { enabled: boolean; connectEnabled: boolean };
  employeeId?: string | null;
  effective?: { policy?: { mode?: ChannelScopeMode; includeSlackConnect?: boolean }; source?: string; connectSuppressed?: boolean };
  employeeOverride?: unknown;
  beforeStateHash?: string | null;
  memberships?: { member: number; out_of_scope: number; left: number; removed: number; truncated?: boolean } | null;
  unconfirmedConnect?: Array<{ externalId: string; externalTeamIds: string[]; source: string }>;
};

type Props = {
  initial: ScopeView;
  employees: Array<{ id: string; displayName: string }>;
};

/**
 * P1 Channel Scope (CS6): read the effective scope and FILE a change request.
 * Changes are applied only after a different owner approves (always_human).
 */
export function ChannelScopeClient({ initial, employees }: Props) {
  const [view, setView] = useState<ScopeView>(initial);
  const [form, setForm] = useState<ChannelScopeFormState>({
    employeeId: "",
    mode: initial.effective?.policy?.mode ?? "registered_only",
    includeSlackConnect: Boolean(initial.effective?.policy?.includeSlackConnect),
    clearOverride: false,
  });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string; diff?: string[] } | null>(null);
  const connectEnabled = Boolean(view.flags?.connectEnabled);

  const load = useCallback(async (employeeId: string) => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/channel-scope${employeeId ? `?employeeId=${encodeURIComponent(employeeId)}` : ""}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(channelScopeErrorJa(body));
      setView(body as ScopeView);
      setForm((f) => ({
        ...f,
        employeeId,
        mode: (body as ScopeView).effective?.policy?.mode ?? "registered_only",
        includeSlackConnect: Boolean((body as ScopeView).effective?.policy?.includeSlackConnect),
        clearOverride: false,
      }));
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof Error ? error.message : "読み込みに失敗しました" });
    } finally {
      setBusy(false);
    }
  }, []);

  async function submit() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/channel-scope", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildChannelScopePatchBody(form, { beforeStateHash: view.beforeStateHash ?? null, connectEnabled })),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(channelScopeErrorJa(body));
      setMessage({
        kind: "ok",
        text: "変更を申請しました。別の承認者（owner）が承認した後に適用されます。",
        diff: Array.isArray(body.diffSummary) ? body.diffSummary : undefined,
      });
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof Error ? error.message : "申請に失敗しました" });
    } finally {
      setBusy(false);
    }
  }

  if (!view.enabled) {
    return (
      <section className="surface p-5 space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h2 className="font-medium">チャンネル範囲</h2>
            <p className="text-sm muted mt-1">AI社員がどの Slack チャンネルで起動するか。</p>
          </div>
          <span className="chip chip-neutral text-xs shrink-0">無効</span>
        </div>
        <p className="text-sm">
          <code className="font-mono text-xs">P1_CHANNEL_SCOPE_ENABLED</code> が OFF です。現在は「登録済みのみ」（channels.classify
          で登録したチャンネルだけ）で動作しています。
        </p>
      </section>
    );
  }

  const effectiveMode = view.effective?.policy?.mode ?? "registered_only";
  const unconfirmed = view.unconfirmedConnect ?? [];
  return (
    <section className="surface p-5 space-y-4">
      <div>
        <h2 className="font-medium">チャンネル範囲</h2>
        <p className="text-sm muted mt-1">
          AI社員がどの Slack チャンネルで起動するか。変更は申請だけで、owner の承認後に適用されます（自己承認不可）。
        </p>
      </div>

      <label className="block text-sm">
        <span className="text-xs muted block mb-1">対象</span>
        <select
          className="input"
          value={form.employeeId}
          disabled={busy}
          onChange={(e) => void load(e.target.value)}
        >
          <option value="">テナント既定</option>
          {employees.map((e) => (
            <option key={e.id} value={e.id}>
              {e.displayName}
            </option>
          ))}
        </select>
      </label>

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="muted">現在の範囲</dt>
        <dd>{channelScopeModeLabelJa(effectiveMode, Boolean(view.effective?.policy?.includeSlackConnect))}</dd>
        <dt className="muted">設定元</dt>
        <dd>{channelScopeSourceLabelJa(view.effective?.source)}</dd>
        {view.effective?.connectSuppressed ? (
          <>
            <dt className="muted">Slack Connect</dt>
            <dd>設定は含めるだが、全体スイッチ（P1_CHANNEL_SCOPE_CONNECT_ENABLED）が OFF のため除外中</dd>
          </>
        ) : null}
        {view.memberships ? (
          <>
            <dt className="muted">参加記録</dt>
            <dd>
              範囲内 {view.memberships.member} / 範囲外 {view.memberships.out_of_scope} / 退出 {view.memberships.left} / 削除{" "}
              {view.memberships.removed}
              {view.memberships.truncated ? "（一部）" : ""}
            </dd>
          </>
        ) : null}
      </dl>

      {unconfirmed.length > 0 ? (
        <div className="rounded-lg border border-[var(--border-soft)] p-3 text-sm space-y-1">
          <p className="font-medium">人の確定待ちの Slack Connect チャンネル（送信は承認制）</p>
          <ul className="text-xs muted space-y-0.5">
            {unconfirmed.slice(0, 20).map((c) => (
              <li key={c.externalId}>
                <code className="font-mono">{c.externalId}</code>
                {c.externalTeamIds.length ? `（相手 team: ${c.externalTeamIds.join(", ")}）` : ""}
              </li>
            ))}
          </ul>
          <p className="text-xs muted">確定は管理MCPの channels.classify（人の承認）で行います。</p>
        </div>
      ) : null}

      <fieldset className="space-y-2" disabled={busy}>
        <legend className="text-xs muted mb-1">変更を申請</legend>
        {form.employeeId ? (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.clearOverride}
              onChange={(e) => setForm({ ...form, clearOverride: e.target.checked })}
            />
            上書きを解除してテナント既定に戻す
          </label>
        ) : null}
        {!form.clearOverride ? (
          <>
            {(["registered_only", "all_joined"] as ChannelScopeMode[]).map((mode) => (
              <label key={mode} className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="channel-scope-mode"
                  checked={form.mode === mode}
                  onChange={() => setForm({ ...form, mode, includeSlackConnect: mode === "all_joined" && form.includeSlackConnect })}
                />
                {channelScopeModeLabelJa(mode)}
              </label>
            ))}
            <label className="flex items-center gap-2 text-sm pl-5">
              <input
                type="checkbox"
                checked={form.mode === "all_joined" && form.includeSlackConnect}
                disabled={form.mode !== "all_joined" || !connectEnabled}
                onChange={(e) => setForm({ ...form, includeSlackConnect: e.target.checked })}
              />
              Slack Connect（社外共有チャンネル）も含める
              {!connectEnabled ? <span className="text-xs muted">（全体スイッチ OFF）</span> : null}
            </label>
          </>
        ) : null}
        <div className="flex items-center gap-2 pt-1">
          <button type="button" className="btn btn-primary text-sm" onClick={() => void submit()} disabled={busy}>
            {busy ? "送信中..." : "変更を申請"}
          </button>
          <span className="text-xs muted">承認が必要です（always_human・kind=account）</span>
        </div>
      </fieldset>

      {message ? (
        <div
          className={
            message.kind === "ok"
              ? "rounded-lg bg-green-50 border border-green-200 p-3 text-sm text-green-700"
              : "rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-700"
          }
        >
          <p>{message.text}</p>
          {message.diff?.length ? (
            <ul className="mt-1 text-xs list-disc pl-5">
              {message.diff.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

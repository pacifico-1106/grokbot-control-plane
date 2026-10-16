"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { FEATURE_FLAG_ENV_NAMES } from "@/lib/operator-notices/flag-names";
import type {
  NoticeApplyMode,
  NoticeAudienceScope,
  NoticeSeverity,
  NoticeTargetPicker,
  OperatorNotice,
} from "@/lib/operator-notices/types";

type Target = { orgId: string; employeeId: string | null };

type Props = {
  notice?: OperatorNotice;
  targets?: Target[];
  picker: NoticeTargetPicker;
  receiptsCsvHref?: string;
};

type PreviewState =
  | { status: "idle" }
  | { status: "hidden" }
  | { status: "visible"; json: string }
  | { status: "error"; message: string };

async function postJson(url: string, body: unknown): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok && data.ok === true, status: res.status, data };
}

function errMessage(data: Record<string, unknown>, fallback: string): string {
  const code = typeof data.error === "string" ? data.error : "";
  const message = typeof data.message === "string" ? data.message : "";
  return message || code || fallback;
}

export function NoticeEditor({ notice, targets = [], picker, receiptsCsvHref }: Props) {
  const router = useRouter();
  const isNew = !notice;
  const published = notice?.status === "published";
  const withdrawn = notice?.status === "withdrawn";
  const draft = !notice || notice.status === "draft";

  const [title, setTitle] = useState(notice?.title ?? "");
  const [changeSummary, setChangeSummary] = useState(notice?.changeSummary ?? "");
  const [aiUsageChange, setAiUsageChange] = useState(notice?.aiUsageChange ?? "");
  const [audienceScope, setAudienceScope] = useState<NoticeAudienceScope>(notice?.audienceScope ?? "all");
  const [sticky, setSticky] = useState(notice?.sticky ?? false);
  const [severity, setSeverity] = useState<NoticeSeverity>(notice?.severity ?? "normal");
  const [applyMode, setApplyMode] = useState<NoticeApplyMode>(notice?.applyMode ?? "self_rules");
  const [showToTenantAdmin, setShowToTenantAdmin] = useState(notice?.showToTenantAdmin ?? true);
  const [relatedFlags, setRelatedFlags] = useState<string[]>(notice?.relatedFlags ?? []);
  const [selectedTargets, setSelectedTargets] = useState<Target[]>(targets);
  const [orgPick, setOrgPick] = useState(picker.orgs[0]?.id ?? "");
  const [empPick, setEmpPick] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [acknowledgeWarnings, setAcknowledgeWarnings] = useState(false);
  const [changeNote, setChangeNote] = useState("");
  const [kind, setKind] = useState<"correction" | "minor">("correction");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [previewOrg, setPreviewOrg] = useState(picker.orgs[0]?.id ?? "");
  const [previewEmp, setPreviewEmp] = useState(picker.employees.find((e) => e.orgId === (picker.orgs[0]?.id ?? ""))?.id ?? "");
  const [preview, setPreview] = useState<PreviewState>({ status: "idle" });

  const employeesInOrg = useMemo(
    () => picker.employees.filter((e) => e.orgId === orgPick),
    [picker.employees, orgPick]
  );
  const previewEmployees = useMemo(
    () => picker.employees.filter((e) => e.orgId === previewOrg),
    [picker.employees, previewOrg]
  );

  const payload = () => ({
    title,
    changeSummary,
    aiUsageChange,
    audienceScope,
    sticky,
    severity,
    applyMode,
    showToTenantAdmin,
    relatedFlags,
    targets: audienceScope === "all" ? [] : selectedTargets,
  });

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : "network_error");
    } finally {
      setBusy(false);
    }
  };

  const saveDraft = () =>
    run(async () => {
      const url = isNew ? "/api/admin/notices" : `/api/admin/notices/${notice.id}`;
      const r = await postJson(url, payload());
      if (!r.ok) {
        setError(errMessage(r.data, "save_failed"));
        return;
      }
      const id = String((r.data.notice as { id?: string } | undefined)?.id ?? notice?.id ?? "");
      setInfo("下書きを保存しました。");
      if (isNew && id) router.push(`/admin/notices/${id}`);
      else router.refresh();
    });

  const publish = () =>
    run(async () => {
      if (!notice) return;
      const r = await postJson(`/api/admin/notices/${notice.id}/publish`, { confirmed, acknowledgeWarnings });
      if (!r.ok) {
        setError(errMessage(r.data, "publish_failed"));
        return;
      }
      setInfo("公開しました。");
      router.refresh();
    });

  const correct = () =>
    run(async () => {
      if (!notice) return;
      const r = await postJson(`/api/admin/notices/${notice.id}`, {
        intent: "correct",
        kind,
        changeNote,
        confirmed,
        acknowledgeWarnings,
        ...payload(),
      });
      if (!r.ok) {
        setError(errMessage(r.data, "correct_failed"));
        return;
      }
      setInfo("訂正を保存しました。");
      router.refresh();
    });

  const withdraw = () =>
    run(async () => {
      if (!notice) return;
      const r = await postJson(`/api/admin/notices/${notice.id}`, { intent: "withdraw", confirmed });
      if (!r.ok) {
        setError(errMessage(r.data, "withdraw_failed"));
        return;
      }
      setInfo("取り下げました。受領の記録は残ります。");
      router.refresh();
    });

  const runPreview = () =>
    run(async () => {
      if (!notice) {
        setPreview({ status: "error", message: "先に下書きを保存してください。" });
        return;
      }
      const r = await postJson(`/api/admin/notices/${notice.id}`, {
        intent: "preview",
        orgId: previewOrg,
        employeeId: previewEmp,
      });
      if (!r.ok) {
        setPreview({ status: "error", message: errMessage(r.data, "preview_failed") });
        return;
      }
      if (r.data.visible === false) {
        setPreview({ status: "hidden" });
        return;
      }
      setPreview({ status: "visible", json: JSON.stringify(r.data.payload, null, 2) });
    });

  const addTarget = () => {
    if (!orgPick) return;
    const employeeId = empPick || null;
    if (selectedTargets.some((t) => t.orgId === orgPick && t.employeeId === employeeId)) return;
    setSelectedTargets([...selectedTargets, { orgId: orgPick, employeeId }]);
  };

  return (
    <div className="space-y-6">
      {error ? <p className="text-sm text-[var(--warn)]">{error}</p> : null}
      {info ? <p className="text-sm text-[var(--ok)]">{info}</p> : null}

      <section className="surface p-4 sm:p-5 space-y-4">
        <h2 className="text-base font-bold">{draft ? "下書き" : published ? "訂正" : "取り下げ済み"}</h2>
        <label className="block text-xs font-semibold">
          題名
          <input className="input mt-1 w-full" maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} disabled={withdrawn} />
        </label>
        <label className="block text-xs font-semibold">
          変更内容
          <textarea className="input mt-1 min-h-32 w-full" maxLength={4000} value={changeSummary} onChange={(e) => setChangeSummary(e.target.value)} disabled={withdrawn} />
        </label>
        <label className="block text-xs font-semibold">
          AI 側の使い方の変化
          <textarea className="input mt-1 min-h-32 w-full" maxLength={4000} value={aiUsageChange} onChange={(e) => setAiUsageChange(e.target.value)} disabled={withdrawn} />
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-xs font-semibold">
            重要度
            <select className="input mt-1 w-full" value={severity} onChange={(e) => setSeverity(e.target.value as NoticeSeverity)} disabled={!draft}>
              <option value="info">info</option>
              <option value="normal">normal</option>
              <option value="important">important</option>
              <option value="urgent">urgent（Webhook は別 PR）</option>
            </select>
          </label>
          <label className="block text-xs font-semibold">
            反映の仕方
            <select className="input mt-1 w-full" value={applyMode} onChange={(e) => setApplyMode(e.target.value as NoticeApplyMode)} disabled={withdrawn}>
              <option value="none">読むだけでよい</option>
              <option value="self_rules">自分の運用ルールに反映</option>
              <option value="instructions_via_approval">Instructions（テナント承認）</option>
            </select>
          </label>
        </div>
        <label className="block text-xs font-semibold">
          宛先
          <select className="input mt-1 w-full" value={audienceScope} onChange={(e) => setAudienceScope(e.target.value as NoticeAudienceScope)} disabled={!draft}>
            <option value="all">全テナント</option>
            <option value="orgs">テナント限定</option>
            <option value="employees">社員限定</option>
          </select>
        </label>
        {audienceScope === "all" ? (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={sticky} onChange={(e) => setSticky(e.target.checked)} disabled={!draft} />
            公開後に作られたテナントにも出す
          </label>
        ) : (
          <div className="space-y-2">
            <div className="flex flex-col gap-2 sm:flex-row">
              <select className="input" value={orgPick} onChange={(e) => { setOrgPick(e.target.value); setEmpPick(""); }} disabled={!draft}>
                {picker.orgs.map((o) => (
                  <option key={o.id} value={o.id}>{o.name}</option>
                ))}
              </select>
              <select className="input" value={empPick} onChange={(e) => setEmpPick(e.target.value)} disabled={!draft || audienceScope !== "employees"}>
                <option value="">テナント全員</option>
                {employeesInOrg.map((e) => (
                  <option key={e.id} value={e.id}>{e.name}</option>
                ))}
              </select>
              <button type="button" className="btn btn-ghost text-xs" onClick={addTarget} disabled={!draft}>宛先を追加</button>
            </div>
            <ul className="text-xs muted space-y-1">
              {selectedTargets.map((t) => (
                <li key={`${t.orgId}:${t.employeeId ?? ""}`} className="flex items-center justify-between gap-2">
                  <span>{t.orgId}{t.employeeId ? ` / ${t.employeeId}` : "（全員）"}</span>
                  {draft ? (
                    <button type="button" className="btn btn-ghost min-h-8 px-2 text-[11px]" onClick={() => setSelectedTargets(selectedTargets.filter((x) => x !== t))}>外す</button>
                  ) : null}
                </li>
              ))}
              {selectedTargets.length === 0 ? <li>宛先がありません。</li> : null}
            </ul>
          </div>
        )}
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={showToTenantAdmin} onChange={(e) => setShowToTenantAdmin(e.target.checked)} disabled={!draft} />
          テナント管理者の画面にも出す
        </label>
        <label className="block text-xs font-semibold">
          関連フラグ（表示用。コードは切り替えません）
          <select
            className="input mt-1 w-full min-h-28"
            multiple
            value={relatedFlags}
            disabled={withdrawn}
            onChange={(e) => setRelatedFlags(Array.from(e.target.selectedOptions).map((o) => o.value).slice(0, 10))}
          >
            {FEATURE_FLAG_ENV_NAMES.map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
        </label>
        {applyMode === "self_rules" ? (
          <p className="text-xs faint">反映してよいのは AI 自身の運用ルールだけです。テナントの人への振る舞いが変わるものは Instructions（承認）にしてください。</p>
        ) : null}
      </section>

      {draft ? (
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn btn-primary text-sm" disabled={busy} onClick={saveDraft}>下書きを保存</button>
        </div>
      ) : null}

      {notice ? (
        <section className="surface p-4 sm:p-5 space-y-3">
          <h2 className="text-base font-bold">見え方の確認</h2>
          <p className="text-xs muted">staffpass_notices_list と同じ JSON を出します。受領行は作りません。</p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <select className="input" value={previewOrg} onChange={(e) => {
              setPreviewOrg(e.target.value);
              setPreviewEmp(picker.employees.find((x) => x.orgId === e.target.value)?.id ?? "");
            }}>
              {picker.orgs.map((o) => (
                <option key={o.id} value={o.id}>{o.name}</option>
              ))}
            </select>
            <select className="input" value={previewEmp} onChange={(e) => setPreviewEmp(e.target.value)}>
              {previewEmployees.map((e) => (
                <option key={e.id} value={e.id}>{e.name}</option>
              ))}
            </select>
            <button type="button" className="btn btn-ghost text-xs" disabled={busy} onClick={runPreview}>この社員にどう見えるか</button>
          </div>
          {preview.status === "hidden" ? <p className="text-sm muted">この社員には見えません。</p> : null}
          {preview.status === "error" ? <p className="text-sm text-[var(--warn)]">{preview.message}</p> : null}
          {preview.status === "visible" ? (
            <pre className="max-h-96 overflow-auto bg-[var(--bg-soft)] p-3 text-[11px]">{preview.json}</pre>
          ) : null}
        </section>
      ) : null}

      {draft && notice ? (
        <section className="surface p-4 sm:p-5 space-y-3">
          <h2 className="text-base font-bold">公開</h2>
          <p className="text-xs muted">公開できるのはこの画面だけです。15 分以内のログインと確認チェックが必要です。AI 社員証では公開できません。</p>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
            宛先と本文を確認しました。公開します。
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={acknowledgeWarnings} onChange={(e) => setAcknowledgeWarnings(e.target.checked)} />
            文面の警告（ある場合）を確認しました。
          </label>
          <button type="button" className="btn btn-primary text-sm" disabled={busy || !confirmed} onClick={publish}>公開する</button>
        </section>
      ) : null}

      {published ? (
        <section className="surface p-4 sm:p-5 space-y-3">
          <h2 className="text-base font-bold">訂正 / 取り下げ</h2>
          <p className="text-xs muted">宛先は公開後に変えられません。変えるときは取り下げて作り直してください。</p>
          <label className="block text-xs font-semibold">
            種類
            <select className="input mt-1 w-full" value={kind} onChange={(e) => setKind(e.target.value as "correction" | "minor")}>
              <option value="correction">訂正（未読に戻す）</option>
              <option value="minor">誤字など（使い方が変わると自動で訂正）</option>
            </select>
          </label>
          <label className="block text-xs font-semibold">
            変更メモ
            <input className="input mt-1 w-full" maxLength={500} value={changeNote} onChange={(e) => setChangeNote(e.target.value)} />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
            内容を確認しました。
          </label>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-primary text-sm" disabled={busy || !confirmed} onClick={correct}>訂正を公開</button>
            <button type="button" className="btn btn-ghost text-sm" disabled={busy || !confirmed} onClick={withdraw}>取り下げる</button>
          </div>
        </section>
      ) : null}

      {receiptsCsvHref ? (
        <p className="text-xs">
          <a className="underline" href={receiptsCsvHref}>受領状況を CSV で書き出す</a>
        </p>
      ) : null}
    </div>
  );
}

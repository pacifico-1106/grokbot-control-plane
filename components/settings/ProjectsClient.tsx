"use client";

import { useState } from "react";
import type { InformationAsset, InformationClass, OrgProject } from "@/lib/types";

const CLASS_LABELS: Record<InformationClass, string> = {
  public: "公開",
  internal: "社内",
  confidential: "機密",
  verbatim: "原文",
};

export function ProjectsClient({
  initialProjects,
  initialAssets = [],
}: {
  initialProjects: OrgProject[];
  initialAssets?: InformationAsset[];
}) {
  const [projects, setProjects] = useState(initialProjects);
  const [assets, setAssets] = useState(initialAssets);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [assetRef, setAssetRef] = useState("");
  const [assetClass, setAssetClass] = useState<InformationClass>("confidential");
  const [assetProjectId, setAssetProjectId] = useState(initialProjects.find((item) => item.isDefault)?.id || "");

  async function createProject() {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/settings/projects", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "保存に失敗しました");
      setProjects((current) => [body.project, ...current.filter((row) => row.id !== body.project.id)]);
      setName("");
      setMessage("プロジェクトを追加しました");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    const response = await fetch(`/api/settings/projects?id=${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      setMessage(body.error === "cannot_delete_default" ? "会社全般は削除できません" : body.error || "削除に失敗しました");
      return;
    }
    setProjects((current) => current.filter((row) => row.id !== id));
  }

  async function saveAsset() {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/settings/directory", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          record: "asset",
          ref: assetRef,
          class: assetClass,
          projectId: assetProjectId || null,
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "保存に失敗しました");
      setAssets((current) => [body.asset, ...current.filter((row) => row.id !== body.asset.id)]);
      setAssetRef("");
      setMessage("アセットを保存しました");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  async function setAssetProject(asset: InformationAsset, projectId: string) {
    const response = await fetch("/api/settings/directory", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        record: "asset",
        ref: asset.ref,
        class: asset.class,
        projectId: projectId || null,
      }),
    });
    const body = await response.json();
    if (!response.ok) return;
    setAssets((current) => current.map((row) => (row.id === body.asset.id ? body.asset : row)));
  }

  return (
    <section className="surface p-5 space-y-4 mt-4">
      <div>
        <h2 className="text-sm font-medium">プロジェクト</h2>
        <p className="mt-2 text-xs muted leading-relaxed">
          ナレッジの壁です。新規雇用の既定は会社全般のみ。指名プロジェクトは社員証で付与します。会社全般は削除できません。
        </p>
      </div>
      {message ? <p className="text-sm">{message}</p> : null}
      <div className="flex flex-col sm:flex-row gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="例: 新規事業A"
          className="flex-1 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm"
        />
        <button type="button" className="btn btn-primary text-xs" disabled={busy || !name.trim()} onClick={() => void createProject()}>
          プロジェクトを追加
        </button>
      </div>
      <ul className="space-y-2">
        {projects.map((row) => (
          <li key={row.id} className="flex items-center justify-between gap-2 text-sm">
            <span>
              {row.name}
              <span className="font-mono text-xs muted ml-2">{row.slug}</span>
              {row.isDefault ? <span className="chip chip-ok ml-2 text-[11px]">会社全般</span> : null}
            </span>
            {row.isDefault ? (
              <span className="text-[11px] muted">削除不可</span>
            ) : (
              <button type="button" className="text-[var(--danger)] text-xs" onClick={() => void remove(row.id)}>
                削除
              </button>
            )}
          </li>
        ))}
      </ul>

      <div className="rounded-xl border border-[var(--border-soft)] p-4 space-y-3">
        <h3 className="text-sm font-medium">情報アセットのプロジェクト</h3>
        <p className="text-xs muted leading-relaxed">未設定は会社全般として扱います。</p>
        <div className="grid sm:grid-cols-3 gap-2">
          <input
            value={assetRef}
            onChange={(e) => setAssetRef(e.target.value)}
            placeholder="例: kb/handbook"
            className="rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm"
          />
          <select
            value={assetClass}
            onChange={(e) => setAssetClass(e.target.value as InformationClass)}
            className="rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm"
          >
            {(Object.keys(CLASS_LABELS) as InformationClass[]).map((item) => (
              <option key={item} value={item}>
                {CLASS_LABELS[item]}
              </option>
            ))}
          </select>
          <select
            value={assetProjectId}
            onChange={(e) => setAssetProjectId(e.target.value)}
            className="rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm"
          >
            {projects.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </div>
        <button type="button" className="btn btn-primary text-xs" disabled={busy || !assetRef.trim()} onClick={() => void saveAsset()}>
          アセットを保存
        </button>
        <ul className="space-y-2">
          {assets.map((row) => (
            <li key={row.id} className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs">
              <span>
                <span className="font-mono">{row.ref}</span>
                <span className="chip ml-2 text-[11px]">{CLASS_LABELS[row.class]}</span>
              </span>
              <select
                value={row.projectId || projects.find((item) => item.isDefault)?.id || ""}
                onChange={(e) => void setAssetProject(row, e.target.value)}
                className="rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-xs"
              >
                {projects.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

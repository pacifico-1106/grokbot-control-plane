"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import {
  CAPABILITY_DEFS,
  JOB_ROLE_PRESETS,
  VIEW_ONLY_CAPABILITIES,
  capabilitiesForJobRole,
  capabilityLabel,
  jobRoleLabel,
} from "@/lib/team/rbac";
import {
  KNOWN_CAPABILITIES,
  KNOWN_ROLES,
  PRIVILEGED_CAPABILITIES,
  memberChangeEditability,
  type MemberChangeActor,
} from "@/lib/team/member-change-guard";
import type {
  HumanCapability,
  HumanJobRole,
  OrgMember,
  OrgMemberRole,
} from "@/lib/types";

function uniqueCaps(caps: HumanCapability[]): HumanCapability[] {
  return [...new Set(caps)];
}

const NO_ACTOR: MemberChangeActor = {
  kind: "member",
  id: "",
  orgId: "",
  role: "member",
  capabilities: [],
  status: "disabled",
  emails: [],
};

/** POST /api/team/members `inviteEmail` (only present when invite activation is ON). */
const INVITE_EMAIL_NOTICE: Record<string, string> = {
  sent: "招待メールを送信しました。受け取った方はメールのリンクを開いてパスワードを設定すると、この組織に参加できます。",
  existing_account: "このメールアドレスには既にアカウントがあるため、招待メールは送信していません。",
  failed: "招待メールの送信に失敗しました。メンバーは「招待中」として保存されています。",
};

export function TeamClient({
  initialMembers,
  viewer = null,
}: {
  initialMembers: OrgMember[];
  /** Session member (server-resolved). Drives checkbox state; the API re-checks. */
  viewer?: MemberChangeActor | null;
}) {
  const router = useRouter();
  const [members, setMembers] = useState<OrgMember[]>(initialMembers);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [jobRole, setJobRole] = useState<HumanJobRole>("sales");
  const [jobLabel, setJobLabel] = useState("");
  const [capabilities, setCapabilities] = useState<HumanCapability[]>(
    capabilitiesForJobRole("sales")
  );
  const [coarseRole, setCoarseRole] = useState<OrgMemberRole>("admin");

  const editing = useMemo(
    () => members.find((m) => m.id === editingId) ?? null,
    [members, editingId]
  );

  // Same pure guard as the server (lib/team/member-change-guard.ts).
  const editable = useMemo(() => {
    const ownerCount = members.filter((m) => m.role === "owner" && m.status === "active").length;
    return memberChangeEditability({
      actor: viewer ?? NO_ACTOR,
      before: editing
        ? {
            id: editing.id,
            userId: editing.userId ?? null,
            orgId: editing.orgId,
            email: editing.email,
            role: editing.role,
            capabilities: editing.capabilities ?? [],
            status: editing.status,
          }
        : null,
      ownerCount,
    });
  }, [members, editing, viewer]);
  const baselineCaps = useMemo<HumanCapability[]>(
    () => (editing?.capabilities ?? []).filter((c) => KNOWN_CAPABILITIES.includes(c)),
    [editing]
  );
  const isSelfEdit = Boolean(viewer && viewer.kind === "member" && editing && editing.id === viewer.id);

  /** Locked boxes keep the current value; only editable boxes take the new state. */
  function lockAware(next: HumanCapability[]): HumanCapability[] {
    return KNOWN_CAPABILITIES.filter((c) =>
      editable.capabilities[c] ? next.includes(c) : baselineCaps.includes(c)
    );
  }

  function applyJobRole(role: HumanJobRole) {
    setJobRole(role);
    setCapabilities(lockAware(capabilitiesForJobRole(role)));
    const nextRole: OrgMemberRole =
      role === "owner" ? "owner" : role === "ops_ai" || role === "admin_affairs" ? "admin" : "member";
    if (editable.roles[nextRole]) setCoarseRole(nextRole);
  }

  function toggleCap(cap: HumanCapability) {
    if (!editable.capabilities[cap]) return;
    setCapabilities((cur) =>
      cur.includes(cap) ? cur.filter((c) => c !== cap) : [...cur, cap]
    );
  }

  function startCreate() {
    setEditingId(null);
    setEmail("");
    setDisplayName("");
    setJobRole("sales");
    // Invite defaults: only boxes the viewer may set (privileged ones are owner-only).
    const invite = memberChangeEditability({
      actor: viewer ?? NO_ACTOR,
      before: null,
      ownerCount: members.filter((m) => m.role === "owner" && m.status === "active").length,
    });
    setCapabilities(capabilitiesForJobRole("sales").filter((c) => invite.capabilities[c]));
    setCoarseRole("member");
    setJobLabel("");
    setError("");
  }

  function startEdit(m: OrgMember) {
    setEditingId(m.id);
    setEmail(m.email);
    setDisplayName(m.displayName);
    setJobRole(m.jobRole ?? "custom");
    setJobLabel(m.jobLabel ?? "");
    setCapabilities(uniqueCaps((m.capabilities ?? []).filter((c) => KNOWN_CAPABILITIES.includes(c))));
    setCoarseRole(m.role);
    setError("");
  }

  async function saveMember() {
    if (!email.trim() || !displayName.trim()) {
      setError("名前とメールは必須です");
      return;
    }
    if (!capabilities.length) {
      setError("権限を1つ以上選んでください");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/team/members", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: editingId,
          email: email.trim(),
          displayName: displayName.trim(),
          role: coarseRole,
          jobRole,
          jobLabel: jobRole === "custom" ? jobLabel.trim() || null : null,
          capabilities: uniqueCaps(capabilities),
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.message || body.error || "save_failed");
      const next = body.member as OrgMember;
      setMembers((cur) => {
        const idx = cur.findIndex((m) => m.id === next.id);
        if (idx >= 0) {
          const copy = [...cur];
          copy[idx] = next;
          return copy;
        }
        return [next, ...cur];
      });
      startCreate();
      if (body.demo === true) {
        setError("デモモードのため、データベースには保存されていません。");
      }
      const inviteNotice =
        typeof body.inviteEmail === "string" ? INVITE_EMAIL_NOTICE[body.inviteEmail] : undefined;
      if (inviteNotice) setError(inviteNotice);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "save_failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <section className="surface p-5 lg:col-span-2 space-y-4 min-w-0">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-medium">メンバー</h2>
          <button type="button" className="btn btn-ghost text-xs px-3 py-1.5" onClick={startCreate}>
            新規追加フォームを開く
          </button>
        </div>
        <ul className="divide-y divide-[var(--border-soft)]">
          {members.map((m) => (
            <li key={m.id} className="py-3 space-y-2">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <div className="text-sm font-medium">{m.displayName}</div>
                  <div className="text-xs muted">{m.email}</div>
                </div>
                <div className="flex flex-wrap gap-1 justify-end">
                  <span className="chip chip-ok text-[11px]">
                    {jobRoleLabel(m.jobRole ?? "custom", m.jobLabel)}
                  </span>
                  <span className="chip text-[11px]">{m.role}</span>
                  <button
                    type="button"
                    className="chip text-[11px]"
                    onClick={() => startEdit(m)}
                  >
                    編集
                  </button>
                </div>
              </div>
              <div className="flex flex-wrap gap-1">
                {(m.capabilities ?? []).map((c) => (
                  <span key={c} className="chip text-[10px]">
                    {capabilityLabel(c)}
                  </span>
                ))}
                {(m.capabilities ?? []).length === 0 ? (
                  <span className="text-xs faint">権限未設定</span>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="surface p-5 space-y-4 min-w-0">
        <h2 className="text-sm font-medium">
          {editing ? "メンバーを編集" : "メンバーを追加"}
        </h2>
        <p className="text-xs muted leading-relaxed">
          職務チップで権限パックを入れ、チェックで微調整できます。「閲覧のみ」は view_* だけにします。
        </p>

        {error ? (
          <p className="rounded-lg border border-[color-mix(in_oklab,var(--danger)_40%,var(--border))] px-3 py-2 text-xs text-[var(--danger)]">
            {error}
          </p>
        ) : null}

        <label className="block text-sm">
          <span className="muted">表示名</span>
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm"
            placeholder="山田 太郎"
          />
        </label>
        <label className="block text-sm">
          <span className="muted">メール</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm"
            placeholder="member@example.com"
          />
        </label>

        <div>
          <div className="text-sm muted mb-2">職務</div>
          <div className="flex flex-wrap gap-2">
            {JOB_ROLE_PRESETS.map((p) => (
              <button
                key={p.key}
                type="button"
                className={`chip text-[11px] ${jobRole === p.key ? "chip-ok" : ""}`}
                title={p.hint}
                onClick={() => applyJobRole(p.key)}
              >
                {p.label}
              </button>
            ))}
          </div>
          {jobRole === "custom" ? (
            <input
              value={jobLabel}
              onChange={(e) => setJobLabel(e.target.value)}
              placeholder="カスタム職務名"
              className="mt-2 w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm"
            />
          ) : null}
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="chip text-[11px]"
            onClick={() => setCapabilities(lockAware([...VIEW_ONLY_CAPABILITIES]))}
          >
            閲覧のみ
          </button>
          <button
            type="button"
            className="chip text-[11px]"
            onClick={() => setCapabilities(lockAware(capabilitiesForJobRole(jobRole)))}
          >
            職務パックを再適用
          </button>
        </div>

        <div>
          <div className="text-sm muted mb-2">権限</div>
          {isSelfEdit ? (
            <p className="mb-2 text-[11px] faint">自分自身の権限は上げられません（外すことはできます）。</p>
          ) : null}
          <ul className="space-y-2">
            {CAPABILITY_DEFS.map((c) => {
              const locked = !editable.capabilities[c.key];
              return (
                <li key={c.key}>
                  <label className={`flex items-start gap-2 text-sm ${locked ? "opacity-60 cursor-not-allowed" : "cursor-pointer"}`}>
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={capabilities.includes(c.key)}
                      disabled={locked}
                      onChange={() => toggleCap(c.key)}
                    />
                    <span>
                      <span className="font-medium">{c.label}</span>
                      <span className="block text-[11px] faint">
                        {c.group}
                        {locked && PRIVILEGED_CAPABILITIES.includes(c.key) && viewer?.kind === "member" && viewer.role !== "owner"
                          ? " · オーナーのみ変更できます"
                          : locked && isSelfEdit
                            ? " · 自分には付けられません"
                            : null}
                      </span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        </div>

        <label className="block text-sm">
          <span className="muted">席種別（粗い・互換）</span>
          <select
            value={coarseRole}
            onChange={(e) => setCoarseRole(e.target.value as OrgMemberRole)}
            className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm"
          >
            {KNOWN_ROLES.map((r) => (
              <option key={r} value={r} disabled={!editable.roles[r] && r !== coarseRole}>
                {r}
                {!editable.roles[r] && r !== coarseRole ? "（変更不可）" : ""}
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          className="btn btn-primary text-sm w-full"
          disabled={saving}
          onClick={() => void saveMember()}
        >
          {saving ? "保存中…" : editing ? "更新する" : "追加する（デモ）"}
        </button>
      </section>
    </div>
  );
}

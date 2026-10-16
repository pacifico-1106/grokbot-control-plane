"use client";

import { useMemo, useState } from "react";

type EmployeeOpt = { id: string; displayName: string };
type AllowRow = {
  id: string;
  fromEmployeeId: string;
  toEmployeeId: string;
  slackChannelId: string | null;
  enabled: boolean;
};
type ThreadRow = {
  id: string;
  slackChannelId: string;
  threadTs: string | null;
  threadKey: string;
  wakeCount: number;
  cap: number;
  stoppedAt: string | null;
  updatedAt: string;
};

export function AiPeerWakeClient(props: {
  flags: { allowlist: boolean; threadGuard: boolean; cap: number };
  employees: EmployeeOpt[];
  initialAllowlist: AllowRow[];
  initialThreads: ThreadRow[];
}) {
  const [allowlist, setAllowlist] = useState(props.initialAllowlist);
  const [threads, setThreads] = useState(props.initialThreads);
  const [fromEmployeeId, setFromEmployeeId] = useState(props.employees[0]?.id ?? "");
  const [toEmployeeId, setToEmployeeId] = useState(props.employees[1]?.id ?? props.employees[0]?.id ?? "");
  const [channel, setChannel] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const names = useMemo(() => {
    const map = new Map(props.employees.map((e) => [e.id, e.displayName]));
    return (id: string) => map.get(id) || id;
  }, [props.employees]);

  async function run(path: RequestInit & { url?: string }) {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(path.url || "/api/settings/ai-peer-wake", {
        method: path.method,
        headers: { "content-type": "application/json" },
        body: path.body,
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.message || body.error || "failed");
      return body;
    } finally {
      setBusy(false);
    }
  }

  async function addPair() {
    try {
      const body = await run({
        method: "POST",
        body: JSON.stringify({
          action: "allowlist",
          fromEmployeeId,
          toEmployeeId,
          slackChannelId: channel.trim() || null,
        }),
      });
      if (body.allowlist) {
        setAllowlist((prev) => {
          const rest = prev.filter((row) => row.id !== body.allowlist.id);
          return [body.allowlist, ...rest];
        });
      }
      setMessage("許可を保存しました");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存に失敗しました");
    }
  }

  async function removePair(id: string) {
    try {
      await run({ method: "DELETE", url: `/api/settings/ai-peer-wake?id=${encodeURIComponent(id)}` });
      setAllowlist((prev) => prev.filter((row) => row.id !== id));
      setMessage("許可を削除しました");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "削除に失敗しました");
    }
  }

  async function stopThread(id: string) {
    try {
      const body = await run({ method: "POST", body: JSON.stringify({ action: "stop", threadId: id }) });
      if (body.thread) {
        setThreads((prev) => prev.map((row) => (row.id === body.thread.id ? body.thread : row)));
      }
      setMessage("この会話の AI 同士の起動を止めました");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "停止に失敗しました");
    }
  }

  async function resumeThread(id: string) {
    try {
      const body = await run({ method: "POST", body: JSON.stringify({ action: "resume", threadId: id }) });
      if (body.thread) {
        setThreads((prev) => prev.map((row) => (row.id === body.thread.id ? body.thread : row)));
      }
      setMessage("停止を解除しました");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "解除に失敗しました");
    }
  }

  return (
    <section id="ai-peer-wake" className="surface p-5 space-y-4">
      <h2 className="font-medium">AI社員同士のメンション</h2>
      <p className="text-sm muted leading-relaxed">
        発言者が紐づいた AI 社員のとき、他の AI 社員は既定では起こしません。許可した組み合わせ（A→B、任意でチャンネル）だけ起こします。
        同じスレッドでの往復は既定 {props.flags.cap} 回で打ち切ります。停止は人だけができます。
      </p>
      <p className="text-xs muted">
        許可リスト: {props.flags.allowlist ? "有効" : "フラグ OFF（保存はできますが、起こす判定には使いません）"}
        {" / "}
        往復上限・停止: {props.flags.threadGuard ? "有効" : "フラグ OFF"}
      </p>

      <div className="space-y-2">
        <h3 className="text-sm font-medium">起こしてよい組み合わせ</h3>
        <div className="flex flex-wrap gap-2 items-end">
          <label className="text-xs">
            発言する AI
            <select className="block mt-1 border rounded px-2 py-1 text-sm" value={fromEmployeeId} onChange={(e) => setFromEmployeeId(e.target.value)}>
              {props.employees.map((e) => (
                <option key={e.id} value={e.id}>{e.displayName}</option>
              ))}
            </select>
          </label>
          <label className="text-xs">
            起こす AI
            <select className="block mt-1 border rounded px-2 py-1 text-sm" value={toEmployeeId} onChange={(e) => setToEmployeeId(e.target.value)}>
              {props.employees.map((e) => (
                <option key={`to-${e.id}`} value={e.id}>{e.displayName}</option>
              ))}
            </select>
          </label>
          <label className="text-xs">
            チャンネル（空欄=すべて）
            <input className="block mt-1 border rounded px-2 py-1 text-sm" value={channel} onChange={(e) => setChannel(e.target.value)} placeholder="C…" />
          </label>
          <button type="button" className="text-sm px-3 py-1 border rounded" disabled={busy} onClick={() => void addPair()}>
            追加
          </button>
        </div>
        <ul className="space-y-1 text-sm">
          {allowlist.length === 0 ? <li className="muted">まだありません。未設定のときは AI 同士は起こしません（フラグ ON 時）。</li> : null}
          {allowlist.map((row) => (
            <li key={row.id} className="flex items-center justify-between gap-2">
              <span>
                {names(row.fromEmployeeId)} → {names(row.toEmployeeId)}
                {row.slackChannelId ? `（${row.slackChannelId}）` : "（全チャンネル）"}
                {row.enabled ? "" : "・無効"}
              </span>
              <button type="button" className="text-xs underline" disabled={busy} onClick={() => void removePair(row.id)}>
                削除
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-medium">スレッドの停止</h3>
        <ul className="space-y-1 text-sm">
          {threads.length === 0 ? <li className="muted">記録されている会話はありません。</li> : null}
          {threads.map((row) => (
            <li key={row.id} className="flex items-center justify-between gap-2">
              <span>
                {row.slackChannelId} {row.threadTs ? `thread ${row.threadTs}` : row.threadKey}
                {" · "}
                {row.wakeCount}/{row.cap}
                {row.stoppedAt ? " · 停止中" : ""}
              </span>
              {row.stoppedAt ? (
                <button type="button" className="text-xs underline" disabled={busy} onClick={() => void resumeThread(row.id)}>
                  解除
                </button>
              ) : (
                <button type="button" className="text-xs underline" disabled={busy} onClick={() => void stopThread(row.id)}>
                  停止
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>
      {message ? <p className="text-xs muted">{message}</p> : null}
    </section>
  );
}

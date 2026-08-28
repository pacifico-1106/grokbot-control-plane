"use client";

import { useMemo, useState } from "react";
import type { ChannelClassification, OrgChannel, OrgParty, OrgPartyKind } from "@/lib/types";

const PARTY_KIND_LABELS: Record<OrgPartyKind, string> = {
  email_domain: "メールドメイン",
  slack_channel: "Slack チャネル ID",
  slack_user: "Slack ユーザー ID",
  phone: "電話番号",
  line: "LINE ID",
  mail_address: "メールアドレス",
};

const CLASS_LABELS: Record<ChannelClassification, string> = {
  internal: "社内",
  shared_external: "社外混在",
  unknown: "不明（社外扱い）",
};

export function PartyDirectoryClient({
  initialParties,
  initialChannels,
}: {
  initialParties: OrgParty[];
  initialChannels: OrgChannel[];
}) {
  const [parties, setParties] = useState(initialParties);
  const [channels, setChannels] = useState(initialChannels);
  const [kind, setKind] = useState<OrgPartyKind>("email_domain");
  const [identifier, setIdentifier] = useState("");
  const [audience, setAudience] = useState<"internal" | "external">("internal");
  const [channelId, setChannelId] = useState("");
  const [classification, setClassification] = useState<ChannelClassification>("internal");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const domainParties = useMemo(
    () => parties.filter((row) => row.kind === "email_domain" || row.kind === "mail_address"),
    [parties]
  );
  const slackParties = useMemo(
    () => parties.filter((row) => row.kind === "slack_channel" || row.kind === "slack_user"),
    [parties]
  );

  async function saveParty() {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/settings/directory", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ record: "party", kind, identifier, audience }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "保存に失敗しました");
      setParties((current) => [body.party, ...current.filter((row) => row.id !== body.party.id)]);
      setIdentifier("");
      setMessage("相手を保存しました");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  const matchingChannel = useMemo(
    () => channels.find((row) => row.externalId.trim() === channelId.trim()),
    [channels, channelId]
  );
  const lockInternal =
    matchingChannel?.classification === "shared_external" || matchingChannel?.mixed === true;
  const classificationOptions = (
    Object.keys(CLASS_LABELS) as ChannelClassification[]
  ).filter((item) => !(lockInternal && item === "internal"));

  async function saveChannel() {
    setBusy(true);
    setMessage("");
    try {
      const nextClass = lockInternal && classification === "internal" ? "shared_external" : classification;
      if (lockInternal && classification === "internal") {
        throw new Error("Slack Connect / 社外混在は社内にできません");
      }
      const response = await fetch("/api/settings/directory", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          record: "channel",
          surface: "slack",
          externalId: channelId,
          classification: nextClass,
          mixed: nextClass === "shared_external",
        }),
      });
      const body = await response.json();
      if (!response.ok) {
        if (body.error === "connect_cannot_be_internal") {
          throw new Error("Slack Connect / 社外混在は社内にできません");
        }
        throw new Error(body.error || "保存に失敗しました");
      }
      setChannels((current) => [body.channel, ...current.filter((row) => row.id !== body.channel.id)]);
      setChannelId("");
      setMessage("チャネルを保存しました");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  async function remove(record: "party" | "channel", id: string) {
    const response = await fetch(`/api/settings/directory?record=${record}&id=${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    if (!response.ok) return;
    if (record === "party") setParties((current) => current.filter((row) => row.id !== id));
    else setChannels((current) => current.filter((row) => row.id !== id));
  }

  return (
    <section className="surface p-5 space-y-4 mt-4">
      <div>
        <h2 className="text-sm font-medium">相手台帳</h2>
        <p className="mt-2 text-xs muted leading-relaxed">
          会話の宛先が社内か社外かを登録します。Bot token は不要です。未登録は社外扱いです。
        </p>
      </div>
      {message ? <p className="text-sm">{message}</p> : null}

      <div className="grid lg:grid-cols-2 gap-4">
        <div className="rounded-xl border border-[var(--border-soft)] p-4 space-y-3">
          <h3 className="text-sm font-medium">ドメイン / アドレス</h3>
          <div className="grid sm:grid-cols-2 gap-2">
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as OrgPartyKind)}
              className="rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm"
            >
              {(Object.keys(PARTY_KIND_LABELS) as OrgPartyKind[]).map((item) => (
                <option key={item} value={item}>
                  {PARTY_KIND_LABELS[item]}
                </option>
              ))}
            </select>
            <select
              value={audience}
              onChange={(e) => setAudience(e.target.value as "internal" | "external")}
              className="rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm"
            >
              <option value="internal">社内</option>
              <option value="external">社外</option>
            </select>
          </div>
          <input
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            placeholder="例: sample-shoji.example / C0123ABCD"
            className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm"
          />
          <button type="button" className="btn btn-primary text-xs" disabled={busy || !identifier.trim()} onClick={() => void saveParty()}>
            相手を追加
          </button>
          <ul className="space-y-2">
            {domainParties.concat(slackParties).map((row) => (
              <li key={row.id} className="flex items-center justify-between gap-2 text-xs">
                <span>
                  {PARTY_KIND_LABELS[row.kind]} · <span className="font-mono">{row.identifier}</span>
                  <span className={`chip ml-2 ${row.audience === "internal" ? "chip-ok" : "chip-warn"}`}>
                    {row.audience === "internal" ? "社内" : "社外"}
                  </span>
                </span>
                <button type="button" className="text-[var(--danger)]" onClick={() => void remove("party", row.id)}>
                  削除
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className="rounded-xl border border-[var(--border-soft)] p-4 space-y-3">
          <h3 className="text-sm font-medium">このチャンネルは社内？社外？</h3>
          <input
            value={channelId}
            onChange={(e) => setChannelId(e.target.value)}
            placeholder="例: C_INTERNAL"
            className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm"
          />
          <p className="text-xs muted leading-relaxed">
            チャンネル ID を社内 / 社外に分けます。Slack Connect / 社外混在は社内にできません。未登録は社外扱いです。
          </p>
          <select
            value={lockInternal && classification === "internal" ? "shared_external" : classification}
            onChange={(e) => setClassification(e.target.value as ChannelClassification)}
            className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm"
          >
            {classificationOptions.map((item) => (
              <option key={item} value={item}>
                {CLASS_LABELS[item]}
              </option>
            ))}
          </select>
          <button type="button" className="btn btn-primary text-xs" disabled={busy || !channelId.trim()} onClick={() => void saveChannel()}>
            チャネルを追加
          </button>
          <ul className="space-y-2">
            {channels.map((row) => (
              <li key={row.id} className="flex items-center justify-between gap-2 text-xs">
                <span>
                  <span className="font-mono">{row.externalId}</span>
                  <span className={`chip ml-2 ${row.classification === "internal" && !row.mixed ? "chip-ok" : "chip-warn"}`}>
                    {CLASS_LABELS[row.classification]}
                    {row.mixed ? " · ゲスト混在" : ""}
                  </span>
                </span>
                <button type="button" className="text-[var(--danger)]" onClick={() => void remove("channel", row.id)}>
                  削除
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

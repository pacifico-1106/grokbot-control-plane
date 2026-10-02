/**
 * P1 Channel Scope — CS6 setup.slackStatus section (design §7). Read-only.
 *
 * Only computed when P1_CHANNEL_SCOPE_ENABLED is ON; flag OFF ⇒ null and setup.slackStatus is
 * unchanged (no extra Slack / DB calls).
 *
 * - tenantDefault: effective mode and whether the tenant ever chose one (channelScope.patch).
 * - Bot scope probes (Slack read calls, no writes):
 *     users.conversations limit=1  → channels:read + groups:read (CS3 classification, CS5 reconcile)
 *     users.info (bot user)        → users:read (CS4 inviter team)
 * - User token probe for linked employees whose effective scope is all_joined (CS5 reconcile).
 * - Event subscription: Slack has no API to read an app's event subscriptions, so this is an
 *   ESTIMATE — any membership written by an event (not by reconcile) proves the events arrive.
 * Tokens are never returned or logged.
 */
import { isChannelScopeConnectEnabled, isChannelScopeEnabled } from "@/lib/feature-flags";
import { getLinkedSlackUserToken } from "@/lib/data/slack-identities";
import { getEffectiveChannelScope, listEmployeeChannelMemberships, listUnconfirmedConnectChannels } from "./data";
import type { ChannelScopeMode, ChannelScopeSource } from "./types";

const PROBE_TIMEOUT_MS = 5_000;

export type ScopeProbe = { ready: boolean | null; code: string; needed: string | null };

export type ChannelScopeSetupStatus = {
  enabled: true;
  connectEnabled: boolean;
  tenantDefault: { mode: ChannelScopeMode; includeSlackConnect: boolean; source: ChannelScopeSource; chosen: boolean };
  allJoinedEmployees: number;
  bot: { channelsRead: ScopeProbe; usersRead: ScopeProbe } | null;
  userTokens: Array<{ employeeId: string; displayName: string; channelsRead: ScopeProbe }>;
  eventsObserved: boolean | null;
  eventSubscriptionNoteJa: string;
  unconfirmedConnectCount: number | null;
  issues: string[];
  nextStepJa: string | null;
};

export async function probeSlackReadScope(token: string, url: string): Promise<ScopeProbe> {
  if (!token) return { ready: null, code: "token_missing", needed: null };
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (response.status === 429) return { ready: null, code: "ratelimited", needed: null };
    const body = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string; needed?: string };
    if (body.ok) return { ready: true, code: "ok", needed: null };
    if (body.error === "missing_scope") return { ready: false, code: "missing_scope", needed: typeof body.needed === "string" ? body.needed.slice(0, 120) : null };
    return { ready: null, code: typeof body.error === "string" ? body.error.slice(0, 64) : "slack_error", needed: null };
  } catch {
    return { ready: null, code: "slack_unreachable", needed: null };
  }
}

const USERS_CONVERSATIONS_PROBE =
  "https://slack.com/api/users.conversations?types=public_channel,private_channel&exclude_archived=true&limit=1";

export async function diagnoseChannelScopeSetup(input: {
  orgId: string;
  botToken: string;
  botUserId: string | null;
  employees: Array<{ id: string; displayName: string; slackIdentityLinked: boolean }>;
}): Promise<ChannelScopeSetupStatus | null> {
  if (!isChannelScopeEnabled()) return null;
  const issues: string[] = [];
  const tenant = await getEffectiveChannelScope(input.orgId, null);
  const tenantDefault = {
    mode: tenant.policy.mode,
    includeSlackConnect: tenant.policy.includeSlackConnect,
    source: tenant.source,
    chosen: tenant.source === "org",
  };

  const allJoined: Array<{ id: string; displayName: string; linked: boolean; connect: boolean }> = [];
  for (const emp of input.employees) {
    const scope = await getEffectiveChannelScope(input.orgId, emp.id).catch(() => null);
    if (scope?.policy.mode === "all_joined") {
      allJoined.push({ id: emp.id, displayName: emp.displayName, linked: emp.slackIdentityLinked, connect: scope.policy.includeSlackConnect });
    }
  }

  let bot: ChannelScopeSetupStatus["bot"] = null;
  if (input.botToken) {
    const channelsRead = await probeSlackReadScope(input.botToken, USERS_CONVERSATIONS_PROBE);
    const usersRead = input.botUserId
      ? await probeSlackReadScope(input.botToken, `https://slack.com/api/users.info?user=${encodeURIComponent(input.botUserId)}`)
      : { ready: null, code: "bot_user_unknown", needed: null };
    bot = { channelsRead, usersRead };
    if (channelsRead.ready === false) issues.push("Bot Token に channels:read / groups:read がありません（チャンネル自動分類・照合に必要）");
    if (usersRead.ready === false) issues.push("Bot Token に users:read がありません（Connect 招待元 team の確認に必要）");
  }

  const userTokens: ChannelScopeSetupStatus["userTokens"] = [];
  for (const emp of allJoined) {
    if (!emp.linked) continue;
    const token = await getLinkedSlackUserToken(emp.id);
    const channelsRead = await probeSlackReadScope(token, USERS_CONVERSATIONS_PROBE);
    userTokens.push({ employeeId: emp.id, displayName: emp.displayName, channelsRead });
    if (channelsRead.ready === false) issues.push(`${emp.displayName}: User Token に channels:read / groups:read がありません（再連携が必要）`);
  }

  let eventsObserved: boolean | null = null;
  try {
    const rows = await listEmployeeChannelMemberships(input.orgId, { limit: 100 });
    eventsObserved = rows.some((r) => r.lastEventId && !r.lastEventId.startsWith("reconcile:"));
  } catch {
    eventsObserved = null;
  }
  const eventSubscriptionNoteJa =
    eventsObserved === true
      ? "チャンネル参加イベントの受信を確認済み"
      : eventsObserved === false
        ? "チャンネル参加イベントをまだ受信していません（推定）。Event Subscriptions に member_joined_channel / member_left_channel / channel_left / group_left / channel_shared / channel_unshared（Bot events）と member_joined_channel / member_left_channel（events on behalf of users）を追加したか確認してください。"
        : "チャンネル参加イベントの受信状況を確認できませんでした";
  if (eventsObserved === false && allJoined.length > 0) issues.push("チャンネル参加イベント未受信（Event Subscriptions を確認）");

  let unconfirmedConnectCount: number | null = null;
  try {
    unconfirmedConnectCount = (await listUnconfirmedConnectChannels(input.orgId, 500)).length;
  } catch {
    unconfirmedConnectCount = null;
  }

  const status: ChannelScopeSetupStatus = {
    enabled: true,
    connectEnabled: isChannelScopeConnectEnabled(),
    tenantDefault,
    allJoinedEmployees: allJoined.length,
    bot,
    userTokens,
    eventsObserved,
    eventSubscriptionNoteJa,
    unconfirmedConnectCount,
    issues,
    nextStepJa: null,
  };
  status.nextStepJa = channelScopeNextStepJa(status, allJoined.some((e) => e.connect));
  return status;
}

/** The channel-scope step for setup.slackStatus nextStepJa (null = nothing to do). */
export function channelScopeNextStepJa(s: ChannelScopeSetupStatus, anyConnect = false): string | null {
  if (!s.tenantDefault.chosen) {
    return (
      "channelScope.patch でチャンネル範囲モードを選択してください（既定は登録済みのみ。" +
      "参加中すべて＝all_joined、Slack Connect も含める＝includeSlackConnect。変更は owner 承認）。" +
      "registered_only のままにする場合も mode=registered_only で一度確定してください。詳細: docs/tenant-slack-kickoff-rail.md"
    );
  }
  if (s.allJoinedEmployees === 0) return null;
  if (s.bot?.channelsRead.ready === false) {
    return (
      "Slack API → OAuth & Permissions → Bot Token Scopes に channels:read, groups:read（Connect を使う場合は users:read も）を追加し、" +
      "Install to Workspace で再インストールしてから新しい xoxb をダッシュボードで更新してください。"
    );
  }
  if (anyConnect && s.bot?.usersRead.ready === false) {
    return "Bot Token Scopes に users:read を追加して再インストールしてください（Slack Connect 招待元の team 確認に使います）。";
  }
  const reauth = s.userTokens.find((u) => u.channelsRead.ready === false);
  if (reauth) {
    return `社員「${reauth.displayName}」（employeeId: ${reauth.employeeId}）が社員証から Slack 再連携（Authorize）してください（User Token に channels:read / groups:read が必要）。`;
  }
  if (s.eventsObserved === false) {
    return `${s.eventSubscriptionNoteJa} 設定後、AI社員をテスト用チャンネルに招待して channelScope.listMemberships で記録を確認してください。`;
  }
  return null;
}

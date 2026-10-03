/**
 * SLACK_IM_NO_ROUTE_AUDIT — user-token DM の im_no_route を org の監査ログに残す。
 *
 * 背景: Path B（user token の message.im）でルートが無いと、これまで orgId が
 * 決まらないため audit が何も残らず、DM チャンネル ID の取り違えが運用側から見えなかった。
 *
 * 信頼境界とテナント分離:
 * - 呼び出し元は Slack 署名検証済み envelope の処理中（processSlackMentionEnvelope）。
 * - 記録先 org は envelope.authorizations の user（is_bot=false）から、
 *   employee_slack_identities の linked 行（team 一致）で引いた社員の org のみ。
 *   0件・複数件・unlinked・team 不一致・社員不在は「書かない」（誤った org に記録しない）。
 * - 本文（text / blocks）、ts、発言者 ID、トークン類は metadata に入れない。
 * - 失敗は握りつぶす（fail-closed = 書かない）。DM 処理本体の結果には影響しない。
 */
import { appendAuditEvent } from "@/lib/data/audit";
import { getOrgChannel } from "@/lib/data/directory";
import { getEmployee } from "@/lib/data/employees";
import { isSlackImChannelId } from "@/lib/data/slack-im-routes";
import { getEmployeesBySlackUserIds } from "@/lib/data/slack-identities";
import { isSlackImNoRouteAuditEnabled } from "@/lib/feature-flags";
import type { AuditEvent } from "@/lib/types";

/** 同じ org×team×DM の記録間隔（インスタンス内ベストエフォート）。 */
export const IM_NO_ROUTE_AUDIT_WINDOW_MS = 10 * 60_000;
const MAX_THROTTLE_KEYS = 5_000;
const SLACK_ID_RE = /^[A-Z0-9_]{1,64}$/i;
/** Slack sends 1 authorization per event; cap lookups defensively. */
const MAX_USER_AUTHORIZATIONS = 5;

export type ImNoRouteAuditStatus =
  | "flag_off"
  | "invalid_channel"
  | "no_user_authorization"
  | "no_linked_employee"
  | "ambiguous_employee"
  | "employee_not_found"
  | "suppressed"
  | "written"
  | "error";

export type ImNoRouteAuditResult = {
  status: ImNoRouteAuditStatus;
  /** Only set when written; never contains message content. */
  orgId?: string;
};

type Authorization = { is_bot?: unknown; user_id?: unknown; team_id?: unknown };

type AuditWriter = (
  event: Omit<AuditEvent, "id" | "createdAt"> & { actorEmail?: string }
) => Promise<void>;

let writerOverride: AuditWriter | null = null;

/** Test-only: replace the audit writer (e.g. to simulate insert failure). */
export function setImNoRouteAuditWriterForTests(writer: AuditWriter | null): void {
  writerOverride = writer;
}

type ThrottleEntry = { windowStart: number; suppressed: number };
const throttle = new Map<string, ThrottleEntry>();

/** Test-only: clear the per-instance suppression window. */
export function resetImNoRouteAuditThrottleForTests(): void {
  throttle.clear();
}

/**
 * Fixed-window, 1 write per key per window. Same shape as lib/auth/auth-flow.ts
 * takeRateLimit, but a separate map so Slack ingress traffic can never evict
 * login / signup rate-limit buckets.
 */
function takeThrottleSlot(
  key: string,
  now: number
): { allowed: true; suppressedSinceLast: number } | { allowed: false } {
  const entry = throttle.get(key);
  if (entry && now - entry.windowStart < IM_NO_ROUTE_AUDIT_WINDOW_MS) {
    entry.suppressed += 1;
    return { allowed: false };
  }
  if (!entry && throttle.size >= MAX_THROTTLE_KEYS) {
    for (const [k, v] of throttle) {
      if (now - v.windowStart >= IM_NO_ROUTE_AUDIT_WINDOW_MS) throttle.delete(k);
    }
    if (throttle.size >= MAX_THROTTLE_KEYS) throttle.clear();
  }
  const suppressedSinceLast = entry?.suppressed ?? 0;
  throttle.set(key, { windowStart: now, suppressed: 0 });
  return { allowed: true, suppressedSinceLast };
}

function slackId(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  return SLACK_ID_RE.test(raw) ? raw : "";
}

function isUserAuthorization(auth: Authorization | null | undefined): boolean {
  return Boolean(auth) && (auth?.is_bot === false || auth?.is_bot === "false");
}

/** user（is_bot=false）の authorization を user+team の組で重複なく取り出す。 */
function userAuthorizations(
  auths: unknown,
  envelopeTeamId: string
): Array<{ userId: string; teamId: string }> {
  if (!Array.isArray(auths)) return [];
  const seen = new Set<string>();
  const out: Array<{ userId: string; teamId: string }> = [];
  for (const auth of auths as Authorization[]) {
    if (out.length >= MAX_USER_AUTHORIZATIONS) break;
    if (!isUserAuthorization(auth)) continue;
    const userId = slackId(auth.user_id);
    const teamId = slackId(auth.team_id) || envelopeTeamId;
    if (!userId || !teamId) continue;
    const key = `${userId.toUpperCase()}:${teamId.toUpperCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ userId, teamId });
  }
  return out;
}

function buildHintJa(input: {
  channel: string;
  employeeId: string;
  crossTeam: boolean;
}): string {
  if (input.crossTeam) {
    return (
      `DM ${input.channel} は起動ルートが無いため社員を起動しませんでした。` +
      "Slack Connect（別ワークスペース）の相手との DM の可能性があります。" +
      "社外の相手であれば internal に分類しないでください。相手と DM チャンネル ID を確認してから判断してください。"
    );
  }
  return (
    `DM ${input.channel} は起動ルートが無いため社員を起動しませんでした。` +
    "社内の 1:1 DM であることを確認したうえで、Admin MCP の channels.classify を " +
    `surface=slack, externalId=${input.channel}, classification=internal, mixed=false, employeeId=${input.employeeId} ` +
    "で申請・承認すると、次回からこの DM で社員が起動します。" +
    "別の DM を登録済みの場合は、チャンネル ID の取り違えがないか確認してください。"
  );
}

/**
 * im_no_route を、一意に特定できた社員の org にだけ記録する。決して throw しない。
 * 呼び出し側はフラグ OFF の時点で呼ばないが、念のためここでも確認する。
 */
export async function recordImNoRouteAudit(input: {
  authorizations: unknown;
  envelopeTeamId: string;
  channel: string;
  channelType: string;
  eventType: string;
  eventId: string;
  now?: number;
}): Promise<ImNoRouteAuditResult> {
  try {
    if (!isSlackImNoRouteAuditEnabled()) return { status: "flag_off" };
    const channel = input.channel.trim();
    if (!isSlackImChannelId(channel) || !slackId(channel)) {
      return { status: "invalid_channel" };
    }
    const envelopeTeamId = slackId(input.envelopeTeamId);
    const auths = userAuthorizations(input.authorizations, envelopeTeamId);
    if (!auths.length) return { status: "no_user_authorization" };

    // Linked + team-matched identities only (DB-level filter in getEmployeesBySlackUserIds).
    const byEmployee = new Map<string, { employeeId: string; orgId: string; slackTeamId: string }>();
    for (const auth of auths) {
      const rows = await getEmployeesBySlackUserIds([auth.userId], auth.teamId);
      for (const row of rows) {
        if (!row.employeeId || !row.orgId) continue;
        byEmployee.set(`${row.orgId}:${row.employeeId}`, {
          employeeId: row.employeeId,
          orgId: row.orgId,
          slackTeamId: row.slackTeamId,
        });
      }
    }
    if (byEmployee.size === 0) return { status: "no_linked_employee" };
    if (byEmployee.size > 1) return { status: "ambiguous_employee" };
    const target = [...byEmployee.values()][0];

    // Defense in depth: the employee must exist in that org.
    const employee = await getEmployee(target.employeeId, target.orgId);
    if (!employee || employee.orgId !== target.orgId) {
      return { status: "employee_not_found" };
    }

    const subscriberTeamId = slackId(target.slackTeamId) || auths[0].teamId;
    const throttleKey = `${target.orgId}|${subscriberTeamId.toUpperCase()}|${channel.toUpperCase()}`;
    const slot = takeThrottleSlot(throttleKey, input.now ?? Date.now());
    if (!slot.allowed) return { status: "suppressed" };

    const crossTeam = Boolean(
      envelopeTeamId && envelopeTeamId.toUpperCase() !== subscriberTeamId.toUpperCase()
    );
    const orgChannel = await getOrgChannel(target.orgId, "slack", channel).catch(() => null);

    const write = writerOverride ?? appendAuditEvent;
    await write({
      orgId: target.orgId,
      employeeId: target.employeeId,
      credentialId: null,
      action: "slack.im_wake_skipped",
      purpose: "slack.internal_im",
      summary: "IM起動スキップ: im_no_route（DM の起動ルート未設定。channels.classify で登録すると起動します）",
      metadata: {
        reason: "im_no_route",
        skipReason: "im_no_route_or_self",
        channel,
        channelType: slackId(input.channelType) || null,
        teamId: envelopeTeamId || null,
        subscriberTeamId,
        crossTeam,
        eventType: slackId(input.eventType) || null,
        eventId: input.eventId.trim().slice(0, 128),
        userToken: true,
        employeeStatus: employee.status,
        channelClassification: orgChannel?.classification ?? "unregistered",
        channelMixed: orgChannel ? orgChannel.mixed : null,
        suppressedSinceLast: slot.suppressedSinceLast,
        suppressWindowMinutes: IM_NO_ROUTE_AUDIT_WINDOW_MS / 60_000,
        recommendedAction: crossTeam
          ? null
          : {
              tool: "channels.classify",
              args: {
                surface: "slack",
                externalId: channel,
                classification: "internal",
                mixed: false,
                employeeId: target.employeeId,
                slackTeamId: subscriberTeamId,
              },
            },
        hintJa: buildHintJa({ channel, employeeId: target.employeeId, crossTeam }),
      },
    });
    return { status: "written", orgId: target.orgId };
  } catch (error) {
    console.error(
      "slack_im_no_route_audit_failed",
      error instanceof Error ? error.message : "unknown_error"
    );
    return { status: "error" };
  }
}

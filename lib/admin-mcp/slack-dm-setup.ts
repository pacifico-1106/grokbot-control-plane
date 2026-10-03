/**
 * PR-4 — Admin MCP tools for Slack DM auto-route + approval delivery setup.
 *
 *   setup.slackDmApprovalStatus        read-only
 *   dmAutoroute.list                   read-only
 *   dmAutoroute.run                    dryRun=true (default): read-only preview
 *                                      dryRun=false: always_human ticket;
 *                                      ADMIN_MCP_DM_AUTOROUTE_AUDIT_ONLY=ON (default OFF)
 *                                      → runs directly + audit row (proposal)
 *   setup.approvalDelivery.autoResolve always_human, regardless of any flag
 *
 * Security invariants (tests in slack-dm-setup.test.ts):
 * - Admin MCP only (/api/mcp/admin). Not in the employee MCP (/api/mcp).
 * - orgId ALWAYS comes from the resolved admin credential; no orgId argument.
 *   Every employee / inbox / route / audit lookup is filtered by that org.
 * - No secret is accepted: unknown keys are rejected, and any value that looks
 *   like a token / credential is rejected (queueAdminTool also scans).
 * - No token / secret is ever returned. Slack tokens are local variables only
 *   (auth.test scope probe); Slack errors are reduced to short codes.
 * - Missing scopes are returned as names + a deep link for the human.
 */
import type { ResolvedAdminCredential } from "@/lib/auth/admin-credential";
import { getAppOrigin } from "@/lib/approvals/tokens";
import { appendAuditEvent, listAuditEvents } from "@/lib/data/audit";
import { getBinding } from "@/lib/data/bindings";
import { listOrgParties } from "@/lib/data/directory";
import { getEmployee, listEmployees } from "@/lib/data/employees";
import {
  getNotificationChannelSecretsById,
  listNotificationChannels,
  upsertNotificationChannel,
} from "@/lib/data/notification-channels";
import {
  getEmployeeSlackIdentity,
  getLinkedSlackUserToken,
  listLinkedSlackIdentitiesForOrg,
} from "@/lib/data/slack-identities";
import { listAutoSlackImRoutes, listSlackImRoutesByOrg } from "@/lib/data/slack-im-routes";
import {
  APPROVAL_DM_REQUIRED_BOT_SCOPES,
  isSlackApprovalDmAutoOpenEnabled,
  openApprovalDeliveryDm,
  pickApprovalDeliveryUser,
  sendApprovalSetupNotice,
} from "@/lib/slack/approval-dm-open";
import { syncAutoDmRoutesForEmployee, type DmAutorouteItem, type DmAutorouteResult } from "@/lib/slack/dm-autoroute";
import { isSlackAuthorizeLinkEnabled } from "@/lib/slack/authorize-link-flags";
import { ALLOWED_ACCOUNTS_SLACK_NEXT_STEP_JA, allowedSlackAccountIds } from "@/lib/slack/authorize-link-guidance";
import { isSlackDmAutorouteEnabled, isSlackUserScopeImWriteEnabled } from "@/lib/slack/dm-autoroute-flags";
import { slackAuthorizeUrlTemplate } from "@/lib/slack/slack-status-diagnose";
import type { NotificationChannel } from "@/lib/types";

export const SLACK_DM_SETUP_TOOLS = [
  "setup.slackDmApprovalStatus",
  "dmAutoroute.run",
  "dmAutoroute.list",
  "setup.approvalDelivery.autoResolve",
] as const;
export type SlackDmSetupTool = (typeof SLACK_DM_SETUP_TOOLS)[number];

export function isSlackDmSetupTool(name: string): name is SlackDmSetupTool {
  return (SLACK_DM_SETUP_TOOLS as readonly string[]).includes(name);
}

function parseFlag(value: string | undefined): boolean {
  const v = (value ?? "").trim().toLowerCase();
  return v === "true" || v === "1" || v === "on" || v === "enabled";
}

/**
 * ADMIN_MCP_DM_AUTOROUTE_AUDIT_ONLY (default OFF, proposal for 八坂):
 * dmAutoroute.run dryRun=false runs without a human ticket and leaves an
 * admin.channel audit row instead. It only replays the SAME automatic logic
 * that already runs on identity link / parties.upsert (counterparts =
 * human-approved internal org_parties only). Never applies to
 * setup.approvalDelivery.autoResolve.
 */
export function isAdminMcpDmAutorouteAuditOnlyEnabled(): boolean {
  return parseFlag(process.env.ADMIN_MCP_DM_AUTOROUTE_AUDIT_ONLY);
}

const MAX_EMPLOYEES = 20;
const MAX_INBOXES = 5;
const SLACK_TIMEOUT_MS = 5_000;
const SLACK_USER_ID_RE = /^[UW][A-Z0-9]{2,30}$/;
const SAFE_ID_RE = /^[A-Za-z0-9_.:-]{1,80}$/;
const SECRETISH_RE = /(xox[a-z]-|xapp-|gb_(adm|emp)_|sk_(live|test)_|-----BEGIN|eyJ[A-Za-z0-9_-]{10,}\.)/i;
const SECRETISH_KEY_RE = /(token|secret|password|credential|signing|apikey|api_key|authorization|cookie)/i;
export const SLACK_APPS_CONSOLE_URL = "https://api.slack.com/apps";

export type ToolOutcome =
  | { kind: "result"; data: Record<string, unknown>; isError?: boolean }
  | { kind: "queue"; queuedArgs: Record<string, unknown>; summary: string };

function fail(code: string, message: string, extra: Record<string, unknown> = {}): ToolOutcome {
  return { kind: "result", data: { ok: false, code, message, ...extra }, isError: true };
}

/** Reject unknown keys and anything that looks like a secret. Returns null when OK. */
export function rejectUnsafeArgs(args: Record<string, unknown>, allowed: readonly string[]): ToolOutcome | null {
  for (const [key, value] of Object.entries(args || {})) {
    if (SECRETISH_KEY_RE.test(key)) {
      return fail("secret_not_accepted", "このツールは token / secret を受け取りません。チャットに貼らず、ダッシュボードで人が入力してください。");
    }
    if (!allowed.includes(key)) {
      return fail("unexpected_argument", `未対応の引数です: ${key.slice(0, 40)}`);
    }
    if (typeof value === "string" && SECRETISH_RE.test(value)) {
      return fail("secret_not_accepted", "このツールは token / secret を受け取りません。チャットに貼らず、ダッシュボードで人が入力してください。");
    }
  }
  return null;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function code(value: unknown, fallback: string): string {
  const raw = typeof value === "string" ? value.trim() : "";
  return /^[a-z0-9_]{1,64}$/.test(raw) ? raw : fallback;
}

/** auth.test scope probe. Token stays local; only scope names / a code come back. */
async function probeScopes(token: string): Promise<{ ok: boolean; scopes: string[] | null; error: string; appId: string }> {
  if (!token) return { ok: false, scopes: null, error: "token_missing", appId: "" };
  try {
    const response = await fetch("https://slack.com/api/auth.test", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
      body: "{}",
      signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
    });
    const data = ((await response.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
    const header = response.headers?.get?.("x-oauth-scopes");
    const scopes = typeof header === "string" ? header.split(",").map((s) => s.trim()).filter(Boolean) : null;
    const appId = /^A[A-Z0-9]{2,30}$/.test(str(data.app_id)) ? str(data.app_id) : "";
    if (data.ok !== true) return { ok: false, scopes, error: code(data.error, "slack_error"), appId };
    return { ok: true, scopes, error: "", appId };
  } catch {
    return { ok: false, scopes: null, error: "network_error", appId: "" };
  }
}

function slackAppUrl(appId: string | null | undefined, page: "oauth" | "general" = "oauth"): string {
  const id = str(appId);
  return /^A[A-Z0-9]{2,30}$/.test(id) ? `${SLACK_APPS_CONSOLE_URL}/${id}/${page}` : SLACK_APPS_CONSOLE_URL;
}

function dashboardUrl(path: string): string {
  return `${getAppOrigin()}${path}`;
}

function flagSnapshot() {
  return {
    SLACK_DM_AUTOROUTE_ENABLED: isSlackDmAutorouteEnabled(),
    SLACK_USER_SCOPE_IM_WRITE: isSlackUserScopeImWriteEnabled(),
    SLACK_APPROVAL_DM_AUTO_OPEN: isSlackApprovalDmAutoOpenEnabled(),
    APPROVAL_DELIVERY_FAILURE_ALERT: parseFlag(process.env.APPROVAL_DELIVERY_FAILURE_ALERT),
    ADMIN_MCP_DM_AUTOROUTE_AUDIT_ONLY: isAdminMcpDmAutorouteAuditOnlyEnabled(),
    SLACK_AUTHORIZE_LINK_ENABLED: isSlackAuthorizeLinkEnabled(),
  };
}

async function slackInboxes(orgId: string): Promise<NotificationChannel[]> {
  return (await listNotificationChannels(orgId))
    .filter((channel) => channel.orgId === orgId && channel.provider === "slack")
    .slice(0, MAX_INBOXES);
}

function allowedUsers(channel: NotificationChannel): string[] {
  const raw = channel.config?.allowedUserIds;
  return Array.isArray(raw) ? raw.map(String).map((s) => s.trim()).filter(Boolean) : [];
}

function destinationKind(destination: string): "dm" | "channel" | "none" {
  if (!destination) return "none";
  return destination.startsWith("D") ? "dm" : "channel";
}

// ---------------------------------------------------------------------------
// setup.slackDmApprovalStatus (read-only)
// ---------------------------------------------------------------------------

export async function diagnoseSlackDmApprovalSetup(orgId: string): Promise<Record<string, unknown>> {
  const flags = flagSnapshot();
  const nextStepsJa: string[] = [];
  const missingScopes: Array<{ app: string; scope: string; where: string; url: string }> = [];

  // Approval inbox (approval app = Slack App B, bot token).
  const inboxes = await slackInboxes(orgId);
  const approvalInboxes: Array<Record<string, unknown>> = [];
  let usersReadVerified = false;
  for (const inbox of inboxes) {
    const destination = str(inbox.config?.channelId);
    const secrets = inbox.hasCredentials ? await getNotificationChannelSecretsById(orgId, inbox.id) : {};
    const probe = await probeScopes(str(secrets.botToken));
    const appId = str(inbox.config?.apiAppId) || probe.appId;
    const required = [...APPROVAL_DM_REQUIRED_BOT_SCOPES];
    const missing = probe.scopes ? required.filter((scope) => !probe.scopes!.includes(scope)) : [];
    if (inbox.enabled && probe.scopes?.includes("users:read")) usersReadVerified = true;
    for (const scope of missing) {
      missingScopes.push({ app: "approval_app", scope, where: "Bot Token Scopes", url: slackAppUrl(appId) });
    }
    approvalInboxes.push({
      inboxId: inbox.id,
      label: inbox.label,
      enabled: inbox.enabled,
      isDefault: inbox.isDefault,
      botTokenPresent: Boolean(secrets.botToken),
      botAuthOk: probe.ok,
      botAuthError: probe.ok ? null : probe.error,
      botScopesVerified: Boolean(probe.scopes),
      missingBotScopes: missing,
      destinationKind: destinationKind(destination),
      destinationPresent: Boolean(destination),
      allowedUserCount: allowedUsers(inbox).length,
      autoOpened: Boolean(inbox.config?.autoOpened),
      setupNoticeSent: typeof inbox.config?.setupNoticeAt === "string",
      slackAppConfigUrl: slackAppUrl(appId),
    });
  }
  const enabledInbox = approvalInboxes.find((inbox) => inbox.enabled);

  // Employees (linked identity + user token scopes).
  const parties = (await listOrgParties(orgId)).filter(
    (party) => party.orgId === orgId && party.kind === "slack_user" && party.audience === "internal"
  );
  const allRoutes = (await listSlackImRoutesByOrg(orgId)).filter((route) => route.orgId === orgId);
  const autoRoutes = flags.SLACK_DM_AUTOROUTE_ENABLED
    ? (await listAutoSlackImRoutes({ orgId }).catch(() => [])).filter((route) => route.orgId === orgId)
    : [];
  const employees = (await listEmployees(orgId))
    .filter((employee) => employee.orgId === orgId && employee.status === "active")
    .slice(0, MAX_EMPLOYEES);
  const employeeRows: Array<Record<string, unknown>> = [];
  for (const employee of employees) {
    const identity = await getEmployeeSlackIdentity(employee.id);
    const linked = Boolean(identity && identity.orgId === orgId && identity.status === "linked");
    let imWrite: boolean | null = null;
    let usersRead: boolean | null = null;
    let tokenError: string | null = null;
    if (linked) {
      const probe = await probeScopes(await getLinkedSlackUserToken(employee.id));
      if (probe.scopes) {
        imWrite = probe.scopes.includes("im:write");
        usersRead = probe.scopes.includes("users:read");
      }
      if (!probe.ok) tokenError = probe.error;
    }
    const missingUserScopes = [
      ...(imWrite === false ? ["im:write"] : []),
      ...(usersRead === false ? ["users:read"] : []),
    ];
    const routes = allRoutes.filter((route) => route.employeeId === employee.id);
    const auto = autoRoutes.filter((route) => route.employeeId === employee.id).length;
    employeeRows.push({
      employeeId: employee.id,
      displayName: employee.displayName,
      slackIdentityLinked: linked,
      slackIdentityStatus: identity?.orgId === orgId ? identity.status : null,
      userTokenError: tokenError,
      missingUserScopes,
      imRoutes: routes.length,
      autoRoutes: flags.SLACK_DM_AUTOROUTE_ENABLED ? auto : null,
      authorizeUrl: slackAuthorizeUrlTemplate(employee.id),
      allowedSlackAccounts: allowedSlackAccountIds(employee).length,
    });
  }

  // nextStepsJa (ordered; humans tap, the agent never handles secrets).
  if (inboxes.length === 0) {
    nextStepsJa.push(
      `承認アプリ（Slack App B）を作り、Bot Token Scopes に ${APPROVAL_DM_REQUIRED_BOT_SCOPES.join(", ")} を入れて Install。` +
        `ダッシュボード「承認を受け取る」（${dashboardUrl("/app/settings")}）で Bot token と許可 user ID（承認者の U…）を人が入力し、チャンネル ID は空欄で保存。`
    );
  }
  if (!usersReadVerified) {
    nextStepsJa.push(
      `承認アプリの Bot Token Scopes に users:read を追加し、Reinstall to Workspace してください（承認者が社外・ゲスト・bot でないかを確かめるのに必要。無いと DM 自動オープンは止まります）。${String(enabledInbox?.slackAppConfigUrl || SLACK_APPS_CONSOLE_URL)}`
    );
  }
  const otherMissing = [...new Set(missingScopes.filter((m) => m.scope !== "users:read").map((m) => m.scope))];
  if (otherMissing.length) {
    nextStepsJa.push(`承認アプリの Bot Token Scopes に ${otherMissing.join(", ")} を追加して Reinstall してください。`);
  }
  if (!flags.SLACK_APPROVAL_DM_AUTO_OPEN) {
    nextStepsJa.push("運営: SLACK_APPROVAL_DM_AUTO_OPEN を ON にする（チャンネル ID 空欄で承認 DM を自動で開く）。");
  }
  if (enabledInbox && !enabledInbox.destinationPresent) {
    nextStepsJa.push("承認口の宛先が未設定です。setup.approvalDelivery.autoResolve（人の承認 1 回）か、ダッシュボードでチャンネル ID 空欄のまま保存し直してください。");
  } else if (enabledInbox && flags.SLACK_APPROVAL_DM_AUTO_OPEN && !enabledInbox.setupNoticeSent) {
    nextStepsJa.push("承認口に「設定しました」がまだ届いていません。setup.approvalDelivery.autoResolve か、ダッシュボードで保存し直してください。");
  }
  if (!flags.SLACK_USER_SCOPE_IM_WRITE) {
    nextStepsJa.push(
      `運営: Staffpass Slack アプリ（App A）の User Token Scopes に im:write を追加（${SLACK_APPS_CONSOLE_URL}）→ SLACK_USER_SCOPE_IM_WRITE を ON。`
    );
  }
  if (!flags.SLACK_DM_AUTOROUTE_ENABLED) {
    nextStepsJa.push("運営: migration 20261004000000_slack_im_route_autoroute を適用してから SLACK_DM_AUTOROUTE_ENABLED を ON。");
  }
  if (parties.length === 0) {
    nextStepsJa.push("社内の相手を parties.upsert（kind=slack_user, audience=internal）で登録してください（DM 自動ルートの相手はこの台帳だけ）。");
  }
  for (const row of employeeRows) {
    // SLACK_AUTHORIZE_LINK_ENABLED: point at the re-authorize link (approver gets
    // it in the approval-app DM; the employee's Slack account only taps 「許可する」).
    const linkStep = flags.SLACK_AUTHORIZE_LINK_ENABLED
      ? `setup.slackAuthorizeLink.issue（employeeId=${row.employeeId}）で再認可リンクを発行（人の承認 1 回 → 承認アプリの DM で社員本人の Slack に届く（U… が 1 つに決まらないときは承認者）→ 社員本人の Slack で開いて「許可する」）。`
      : "";
    if (!row.slackIdentityLinked && linkStep && row.allowedSlackAccounts === 0) {
      // No Slack U… on the badge: the link would be refused — say how to add it.
      nextStepsJa.push(`${row.displayName}: 社員証の allowedAccounts に Slack アカウントがありません。${ALLOWED_ACCOUNTS_SLACK_NEXT_STEP_JA}`);
    } else if (!row.slackIdentityLinked) {
      nextStepsJa.push(
        linkStep
          ? `${row.displayName}: Slack 未連携です。${linkStep}`
          : `${row.displayName}: 社員証の Slack 連携を人がタップ（${row.authorizeUrl}）。`
      );
    } else if ((row.missingUserScopes as string[]).length) {
      const missing = (row.missingUserScopes as string[]).join(", ");
      nextStepsJa.push(
        linkStep
          ? `${row.displayName}: user token に ${missing} がありません。${linkStep}`
          : `${row.displayName}: user token に ${missing} がありません。もう一度 Slack 連携をタップ（${row.authorizeUrl}）。`
      );
    }
  }
  if (flags.SLACK_DM_AUTOROUTE_ENABLED && parties.length > 0) {
    nextStepsJa.push("dmAutoroute.run（dryRun=true）で作られる DM を確認 → dryRun=false で実行。結果は dmAutoroute.list。");
  }
  nextStepsJa.push("テスト承認は不要です。最初の本物の承認依頼が実地確認です（届かない・押せないときは承認されず、管理者に通知されます）。");

  for (const row of employeeRows) {
    for (const scope of row.missingUserScopes as string[]) {
      missingScopes.push({ app: "staffpass_app_user_token", scope, where: "User Token Scopes", url: SLACK_APPS_CONSOLE_URL });
    }
  }

  return {
    ok: true,
    readOnly: true,
    flags,
    testApprovalRequired: false,
    approvalBotRequiredScopes: [...APPROVAL_DM_REQUIRED_BOT_SCOPES],
    approvalBotUsersReadVerified: usersReadVerified,
    approvalInboxes,
    internalSlackParties: parties.length,
    imRoutesTotal: allRoutes.length,
    employees: employeeRows,
    missingScopes,
    deepLinks: {
      approvalSettings: dashboardUrl("/app/settings"),
      slackAppsConsole: SLACK_APPS_CONSOLE_URL,
      approvals: dashboardUrl("/app/approvals"),
    },
    nextStepsJa,
  };
}

// ---------------------------------------------------------------------------
// dmAutoroute.list (read-only)
// ---------------------------------------------------------------------------

export async function listDmAutorouteResults(
  orgId: string,
  input: { employeeId?: string; limit?: number }
): Promise<ToolOutcome> {
  const employeeId = str(input.employeeId);
  if (employeeId) {
    const employee = await getEmployee(employeeId, orgId);
    if (!employee || employee.orgId !== orgId) return fail("employee_not_found", "この組織の AI 社員ではありません。");
  }
  const limit = Math.min(Math.max(Number(input.limit) || 50, 1), 100);
  const flagOn = isSlackDmAutorouteEnabled();
  const auto = flagOn
    ? new Map(
        (await listAutoSlackImRoutes({ orgId, ...(employeeId ? { employeeId } : {}) }).catch(() => []))
          .filter((route) => route.orgId === orgId)
          .map((route) => [route.slackChannelId, route])
      )
    : new Map();
  const routes = (await listSlackImRoutesByOrg(orgId))
    .filter((route) => route.orgId === orgId && (!employeeId || route.employeeId === employeeId))
    .slice(0, limit)
    .map((route) => {
      const a = auto.get(route.slackChannelId);
      return {
        slackChannelId: route.slackChannelId,
        employeeId: route.employeeId,
        source: flagOn ? (a ? "auto_party" : "manual") : "unknown",
        counterpartSlackUserId: a?.counterpartSlackUserId ?? null,
        updatedAt: route.updatedAt ?? null,
      };
    });
  const events = (await listAuditEvents(orgId, 500))
    .filter((event) => event.orgId === orgId)
    .filter((event) => String(event.metadata?.event || "").startsWith("slack_dm_autoroute."))
    .filter((event) => !employeeId || event.employeeId === employeeId || event.metadata?.employeeId === employeeId)
    .slice(0, limit)
    .map((event) => ({
      at: event.createdAt,
      outcome: String(event.metadata?.event || "").replace("slack_dm_autoroute.", ""),
      trigger: event.metadata?.trigger ?? null,
      reason: event.metadata?.reason ?? null,
      employeeId: event.employeeId ?? event.metadata?.employeeId ?? null,
      counterpartSlackUserId: event.metadata?.counterpartSlackUserId ?? null,
      channelId: event.metadata?.channelId ?? null,
    }));
  const counts: Record<string, number> = {};
  for (const event of events) counts[event.outcome] = (counts[event.outcome] ?? 0) + 1;
  return {
    kind: "result",
    data: {
      ok: true,
      readOnly: true,
      flagEnabled: flagOn,
      routes,
      recentResults: events,
      counts,
      nextStepJa: flagOn
        ? "skipped / failed の reason を見て、相手台帳（parties.upsert）や Slack 連携（再認可）を直してください。"
        : "SLACK_DM_AUTOROUTE_ENABLED が OFF のため、ルートの由来（auto/manual）は表示しません。",
    },
  };
}

// ---------------------------------------------------------------------------
// dmAutoroute.run
// ---------------------------------------------------------------------------

async function targetEmployees(orgId: string, employeeId: string): Promise<string[] | ToolOutcome> {
  if (employeeId) {
    const employee = await getEmployee(employeeId, orgId);
    if (!employee || employee.orgId !== orgId) return fail("employee_not_found", "この組織の AI 社員ではありません。");
    return [employee.id];
  }
  return (await listLinkedSlackIdentitiesForOrg(orgId))
    .filter((identity) => identity.orgId === orgId && identity.status === "linked")
    .map((identity) => identity.employeeId)
    .slice(0, MAX_EMPLOYEES);
}

function summarize(results: Array<{ employeeId: string; result: DmAutorouteResult }>) {
  const counts: Record<string, number> = {};
  const employees = results.map(({ employeeId, result }) => {
    for (const item of result.items) counts[item.outcome] = (counts[item.outcome] ?? 0) + 1;
    return {
      employeeId,
      status: result.status,
      reason: result.reason ?? null,
      items: result.items.map((item: DmAutorouteItem) => ({
        counterpartSlackUserId: item.counterpartSlackUserId || null,
        outcome: item.outcome,
        reason: item.reason,
        channelId: item.channelId ?? null,
      })),
    };
  });
  return { counts, employees };
}

/** Execute (not dryRun). Shared by fulfillment and the audit-only path. Org from caller. */
export async function executeDmAutorouteRun(orgId: string, employeeIdInput: string) {
  const targets = await targetEmployees(orgId, employeeIdInput);
  if (!Array.isArray(targets)) return { ok: false as const, code: "employee_not_found" };
  const results: Array<{ employeeId: string; result: DmAutorouteResult }> = [];
  for (const employeeId of targets) {
    results.push({ employeeId, result: await syncAutoDmRoutesForEmployee({ orgId, employeeId, trigger: "admin_mcp" }) });
  }
  return { ok: true as const, ...summarize(results) };
}

export async function handleDmAutorouteRun(
  cred: ResolvedAdminCredential,
  args: Record<string, unknown>
): Promise<ToolOutcome> {
  const orgId = cred.orgId;
  const employeeId = str(args.employeeId);
  if (employeeId && !SAFE_ID_RE.test(employeeId)) return fail("invalid_employee_id", "employeeId が不正です。");
  if (args.dryRun !== undefined && typeof args.dryRun !== "boolean") {
    return fail("invalid_dry_run", "dryRun は true / false で指定してください。");
  }
  const dryRun = args.dryRun !== false;
  const targets = await targetEmployees(orgId, employeeId);
  if (!Array.isArray(targets)) return targets;

  if (dryRun) {
    const results: Array<{ employeeId: string; result: DmAutorouteResult }> = [];
    for (const id of targets) {
      results.push({ employeeId: id, result: await syncAutoDmRoutesForEmployee({ orgId, employeeId: id, trigger: "admin_mcp", dryRun: true }) });
    }
    return {
      kind: "result",
      data: {
        ok: true,
        dryRun: true,
        readOnly: true,
        flagEnabled: isSlackDmAutorouteEnabled(),
        ...summarize(results),
        nextStepJa: isSlackDmAutorouteEnabled()
          ? "would_open の DM が dryRun=false で開かれ、ルートが入ります（人の承認 1 回）。"
          : "SLACK_DM_AUTOROUTE_ENABLED が OFF のため dryRun=false は実行できません。",
      },
    };
  }

  if (!isSlackDmAutorouteEnabled()) {
    return fail("dm_autoroute_flag_off", "SLACK_DM_AUTOROUTE_ENABLED が OFF です（運営が migration 適用後に ON）。dryRun=true は使えます。");
  }
  if (targets.length === 0) return fail("no_linked_employees", "Slack 連携済みの AI 社員がいません。");

  if (isAdminMcpDmAutorouteAuditOnlyEnabled()) {
    // No self-escalation: an employee bound to this admin agent itself always
    // goes through a human ticket, even in audit-only mode.
    for (const id of targets) {
      const binding = await getBinding(id);
      if (binding?.grokBotAgentId && binding.grokBotAgentId === cred.grokBotAgentId) {
        return {
          kind: "queue",
          queuedArgs: { employeeId: employeeId || null, dryRun: false, employeeCount: targets.length, selfBound: true },
          summary: `管理エージェント自身にひもづく AI 社員を含むため、DM 自動ルート作成を人が確認します（${targets.length} 名）`,
        };
      }
    }
    const run = await executeDmAutorouteRun(orgId, employeeId);
    await appendAuditEvent({
      orgId,
      employeeId: employeeId || null,
      credentialId: null,
      action: "admin.channel",
      purpose: "admin.channel",
      summary: `管理MCPから DM 自動ルートを実行（承認省略・監査のみ / ${targets.length} 名）`,
      metadata: {
        auditClass: "admin",
        event: "admin_mcp.dm_autoroute.run_audit_only",
        adminAgentId: cred.adminAgentId,
        grokBotAgentId: cred.grokBotAgentId,
        employeeIds: targets,
        counts: run.ok ? run.counts : null,
      },
    });
    return { kind: "result", data: { ok: true, dryRun: false, auditOnly: true, ...(run.ok ? run : {}) } };
  }

  return {
    kind: "queue",
    queuedArgs: { employeeId: employeeId || null, dryRun: false, employeeCount: targets.length },
    summary: employeeId
      ? `AI社員 ${employeeId.slice(0, 8)}… の社内 DM 自動ルート作成を人が確認します（相手は相手台帳の internal のみ）`
      : `Slack 連携済み AI 社員 ${targets.length} 名の社内 DM 自動ルート作成を人が確認します（相手は相手台帳の internal のみ）`,
  };
}

// ---------------------------------------------------------------------------
// setup.approvalDelivery.autoResolve (always_human)
// ---------------------------------------------------------------------------

async function resolveInbox(orgId: string, inboxId: string): Promise<NotificationChannel | ToolOutcome> {
  const inboxes = (await slackInboxes(orgId)).filter((inbox) => inbox.enabled);
  if (inboxId) {
    const inbox = inboxes.find((item) => item.id === inboxId);
    return inbox ?? fail("inbox_not_found", "この組織の有効な Slack 承認口が見つかりません。");
  }
  if (inboxes.length === 0) {
    return fail("inbox_not_found", "有効な Slack 承認口がありません。ダッシュボード「承認を受け取る」で Bot token と許可 user ID を人が入力してください。", {
      deepLink: dashboardUrl("/app/settings"),
    });
  }
  if (inboxes.length > 1) return fail("inbox_ambiguous", "Slack 承認口が複数あります。inboxId を指定してください。");
  return inboxes[0];
}

export async function handleApprovalDeliveryAutoResolve(
  cred: ResolvedAdminCredential,
  args: Record<string, unknown>
): Promise<ToolOutcome> {
  if (!isSlackApprovalDmAutoOpenEnabled()) {
    return fail("approval_dm_auto_open_flag_off", "SLACK_APPROVAL_DM_AUTO_OPEN が OFF です（運営が ON にしてから使えます）。");
  }
  const inboxId = str(args.inboxId);
  const deliveryUserId = str(args.deliveryUserId);
  if (inboxId && !SAFE_ID_RE.test(inboxId)) return fail("invalid_inbox_id", "inboxId が不正です。");
  if (deliveryUserId && !SLACK_USER_ID_RE.test(deliveryUserId)) {
    return fail("invalid_slack_user_id", "deliveryUserId は Slack の user ID（U…）で指定してください。");
  }
  const inbox = await resolveInbox(cred.orgId, inboxId);
  if ("kind" in inbox) return inbox;
  if (!inbox.hasCredentials) {
    return fail("bot_token_required", "承認口に Bot token がありません。ダッシュボードで人が入力してください（チャットに貼らない）。", {
      deepLink: dashboardUrl("/app/settings"),
    });
  }
  const picked = pickApprovalDeliveryUser(allowedUsers(inbox), deliveryUserId);
  if (!picked.ok) return fail(picked.code, picked.messageJa, { deepLink: dashboardUrl("/app/settings") });
  const current = str(inbox.config?.channelId);
  return {
    kind: "queue",
    queuedArgs: { inboxId: inbox.id, deliveryUserId: picked.userId, previousDestinationKind: destinationKind(current) },
    summary:
      `Slack 承認口「${inbox.label}」の宛先を、承認アプリと ${picked.userId} の DM に自動設定し「設定しました」を 1 回送ることを人が確認します` +
      (current ? `（現在の宛先 ${destinationKind(current) === "dm" ? "DM" : "チャンネル"} を置き換えます）` : ""),
  };
}

export type AutoResolveFulfillment =
  | { ok: true; inboxId: string; destinationKind: "dm"; deliveryUserId: string }
  | { ok: false; code: string; messageJa: string; missingScope?: string; deepLink?: string };

/** Fulfillment of a human-approved setup.approvalDelivery.autoResolve. Org from the approval row. */
export async function fulfillApprovalDeliveryAutoResolve(input: {
  orgId: string;
  approvalId: string;
  args: Record<string, unknown>;
}): Promise<AutoResolveFulfillment> {
  const { orgId } = input;
  const auditFail = async (result: Extract<AutoResolveFulfillment, { ok: false }>) => {
    await appendAuditEvent({
      orgId,
      employeeId: null,
      credentialId: null,
      action: "admin.notificationChannel",
      purpose: "admin.notificationChannel",
      summary: `承認口の宛先の自動設定を中止（${result.code}）`,
      metadata: {
        auditClass: "admin",
        event: "approval_dm.auto_resolve_failed",
        approvalId: input.approvalId,
        code: result.code,
        missingScope: result.missingScope ?? null,
      },
    }).catch(() => undefined);
    return result;
  };
  if (!isSlackApprovalDmAutoOpenEnabled()) {
    return auditFail({ ok: false, code: "approval_dm_auto_open_flag_off", messageJa: "SLACK_APPROVAL_DM_AUTO_OPEN が OFF です。" });
  }
  const inbox = await resolveInbox(orgId, str(input.args.inboxId));
  if ("kind" in inbox) return auditFail({ ok: false, code: "inbox_not_found", messageJa: "承認口が見つかりません。" });
  const secrets = await getNotificationChannelSecretsById(orgId, inbox.id);
  const botToken = str(secrets.botToken);
  const appUrl = slackAppUrl(str(inbox.config?.apiAppId));
  const opened = await openApprovalDeliveryDm({
    botToken,
    allowedUserIds: allowedUsers(inbox),
    deliveryUserId: str(input.args.deliveryUserId),
  });
  if (!opened.ok) {
    return auditFail({
      ok: false,
      code: opened.code,
      messageJa: opened.messageJa,
      ...(opened.missingScope ? { missingScope: opened.missingScope, deepLink: appUrl } : {}),
    });
  }
  const notice = await sendApprovalSetupNotice(botToken, opened.channelId);
  if (!notice.ok) {
    return auditFail({
      ok: false,
      code: notice.code,
      messageJa: notice.messageJa,
      ...(notice.missingScope ? { missingScope: notice.missingScope, deepLink: appUrl } : {}),
    });
  }
  const at = new Date().toISOString();
  await upsertNotificationChannel({
    id: inbox.id,
    orgId,
    provider: "slack",
    label: inbox.label,
    enabled: true,
    isDefault: inbox.isDefault,
    config: {
      ...inbox.config,
      channelId: opened.channelId,
      expectedTeamId: opened.teamId,
      autoOpened: { userId: opened.userId, at },
      setupNoticeAt: at,
    },
    secrets: {},
  });
  await appendAuditEvent({
    orgId,
    employeeId: null,
    credentialId: null,
    action: "admin.notificationChannel",
    purpose: "admin.notificationChannel",
    summary: `Slack 承認口の宛先を承認 DM に自動設定（「設定しました」送信済み・管理MCP・人承認）`,
    metadata: {
      auditClass: "admin",
      event: "approval_dm.auto_resolved",
      approvalId: input.approvalId,
      inboxId: inbox.id,
      channelId: opened.channelId,
      deliveryUserId: opened.userId,
    },
  });
  return { ok: true, inboxId: inbox.id, destinationKind: "dm", deliveryUserId: opened.userId };
}

// ---------------------------------------------------------------------------
// Dispatcher (called from callAdminMcpTool)
// ---------------------------------------------------------------------------

const ALLOWED_ARGS: Record<SlackDmSetupTool, readonly string[]> = {
  "setup.slackDmApprovalStatus": [],
  "dmAutoroute.list": ["employeeId", "limit"],
  "dmAutoroute.run": ["employeeId", "dryRun", "jobId", "approvalId"],
  "setup.approvalDelivery.autoResolve": ["inboxId", "deliveryUserId", "jobId", "approvalId"],
};

export async function handleSlackDmSetupTool(
  name: SlackDmSetupTool,
  args: Record<string, unknown>,
  cred: ResolvedAdminCredential
): Promise<ToolOutcome> {
  const unsafe = rejectUnsafeArgs(args, ALLOWED_ARGS[name]);
  if (unsafe) return unsafe;
  switch (name) {
    case "setup.slackDmApprovalStatus":
      return { kind: "result", data: await diagnoseSlackDmApprovalSetup(cred.orgId) };
    case "dmAutoroute.list":
      return listDmAutorouteResults(cred.orgId, { employeeId: str(args.employeeId), limit: Number(args.limit) });
    case "dmAutoroute.run":
      return handleDmAutorouteRun(cred, args);
    case "setup.approvalDelivery.autoResolve":
      return handleApprovalDeliveryAutoResolve(cred, args);
  }
}

// Shared with setup.slackAuthorizeLink.issue (lib/slack/authorize-link.ts).
export {
  resolveInbox as resolveSlackApprovalInbox,
  allowedUsers as approvalInboxAllowedUsers,
  probeScopes as probeSlackTokenScopes,
};

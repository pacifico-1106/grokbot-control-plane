/**
 * Slack integration diagnostics for Admin MCP setup.slackStatus (read-only).
 */

import { listEmployees } from "@/lib/data";
import { listConversationAdapters } from "@/lib/data/conversation-adapters";
import { getEmployeeSlackIdentity, getLinkedSlackUserToken } from "@/lib/data/slack-identities";
import { listSlackImRoutesByOrg } from "@/lib/data/slack-im-routes";
import { getAppOrigin } from "@/lib/approvals/tokens";
import { probeSlackTokenScopes } from "@/lib/admin-mcp/slack-dm-setup";
import { resolveOrgSlackBotToken } from "@/lib/slack/bot-token";
import { probeSlackFilesWrite } from "@/lib/slack/files-write-probe";
import type { PostingAs } from "@/lib/types";

export const DASHBOARD_BOT_TOKEN_PATH_JA =
  "つながり → チャンネルに書き込む（会社のBot）";

const SLACK_AUTH_TEST_TIMEOUT_MS = 5_000;

export type SlackAuthTestResult = {
  ok: boolean;
  bot_id?: string;
  user_id?: string;
  team_id?: string;
  error?: string;
};

export type EmployeeSlackPathStatus = {
  employeeId: string;
  displayName: string;
  postingAs: PostingAs | string;
  slackIdentityLinked: boolean;
  slackIdentityStatus: string | null;
  needsPathB: boolean;
  fileUploadReady: boolean | null;
  needsReoauthForFilesWrite: boolean;
  authorizeUrlTemplate: string | null;
};

export type PathBReadiness = {
  pathBEmployeeCount: number;
  linkedCount: number;
  fileUploadReadyCount: number;
  needsReoauthCount: number;
  needsAuthorizeCount: number;
  ready: boolean;
};

/** Explicit code + next step when the org has no conversation bot token of its own. */
export const CONVERSATION_BOT_TOKEN_NOT_REGISTERED = "conversation_bot_token_not_registered";
export const SET_BOT_TOKEN_TOOL = "setup.slackAdapter.setBotToken";

/**
 * Conversation-plane bot token status. Only the org's OWN token counts (the env
 * SLACK_BOT_TOKEN fallback and the shared approval app are never candidates), so
 * an org without one is `not_registered` and never reported ok / ready.
 */
export type ConversationBotTokenStatus =
  | { status: "registered" }
  | {
      status: "not_registered";
      code: typeof CONVERSATION_BOT_TOKEN_NOT_REGISTERED;
      nextTool: typeof SET_BOT_TOKEN_TOOL;
    };

/**
 * The Staffpass Slack app (the conversation bot every tenant installs). There is
 * no env / config for this id elsewhere in the code, so it lives here.
 */
export const STAFFPASS_SLACK_APP_ID = "A0BU8TABSV6";

/** Bot scopes channel-classify proposals need (lib/slack/oauth.ts SLACK_BOT_SCOPES, #311). */
export const CHANNEL_CLASSIFY_BOT_SCOPES = ["channels:read", "groups:read", "users:read", "im:read", "mpim:read"] as const;

/**
 * Real scopes of the org's own conversation bot token, from auth.test
 * x-oauth-scopes. `missingChannelClassifyScopes` is null when the scopes could
 * not be read (never treated as "nothing missing").
 */
export type BotScopeCheck = {
  status: "ok" | "token_missing" | "auth_test_failed" | "scopes_unavailable";
  /** Slack error code (invalid_auth, ratelimited, …) or "" — never a token. */
  code: string;
  scopes: string[] | null;
  missingChannelClassifyScopes: string[] | null;
  channelClassifyScopesReady: boolean;
};

/** App id of the org's own conversation bot, from bots.info (bot_id from auth.test). */
export type BotAppCheck = {
  status: "ok" | "not_probed" | "bot_id_missing" | "bots_info_failed";
  code: string;
  appId: string | null;
  expectedAppId: string;
  /** null when the app id is unknown. */
  matchesStaffpassApp: boolean | null;
};

export type SlackStatusResult = {
  ok: boolean;
  botTokenPresent: boolean;
  conversationBotToken: ConversationBotTokenStatus;
  /** Admin MCP tool for the next human-approved step (null when none is fixed). */
  nextTool: string | null;
  authTest: SlackAuthTestResult | null;
  botScopeCheck: BotScopeCheck;
  botApp: BotAppCheck;
  /** Shortcut of botScopeCheck.missingChannelClassifyScopes. */
  missingChannelClassifyScopes: string[] | null;
  /** Shortcut of botApp.matchesStaffpassApp. */
  botAppIdMatchesStaffpass: boolean | null;
  botHasFilesWrite: boolean;
  botFilesWriteCode: string;
  botFilesWriteNeeded: string | null;
  adapterEnabled: boolean;
  adapterLabel: string | null;
  imRoutesCount: number;
  employeePostingAsBot: number;
  employeePostingAsUser: number;
  pathAEmployees: number;
  pathBEmployees: number;
  employees: EmployeeSlackPathStatus[];
  pathBReadiness: PathBReadiness;
  postingMismatch: string[];
  issues: string[];
  nextStepJa: string;
  authorizeUrlTemplate: string;
  dashboardBotTokenPathJa: string;
};

/**
 * Where a human connects an employee's Slack: the admin-issued single-use
 * re-authorize link (SLACK_AUTHORIZE_LINK_PATH in lib/slack/authorize-link.ts).
 * {token} arrives in the approval-app DM after setup.slackAuthorizeLink.issue
 * (one human approval). Never the session start route /api/slack/oauth/start,
 * which requires hire_issue_credentials (#284).
 */
const SLACK_BOTS_INFO_TIMEOUT_MS = 5_000;
const SLACK_CODE_RE = /^[a-z0-9_]{1,64}$/;
const SLACK_BOT_ID_RE = /^B[A-Z0-9]{2,30}$/;
const SLACK_APP_ID_RE = /^A[A-Z0-9]{2,30}$/;

function slackCode(value: unknown, fallback: string): string {
  return typeof value === "string" && SLACK_CODE_RE.test(value.trim()) ? value.trim() : fallback;
}

/** bots.info → app id. Read-only; token stays local; only an id / code comes back. */
async function slackBotsInfoAppId(token: string, botId: string): Promise<{ appId: string; code: string }> {
  try {
    const response = await fetch(`https://slack.com/api/bots.info?bot=${encodeURIComponent(botId)}`, {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(SLACK_BOTS_INFO_TIMEOUT_MS),
    });
    const data = ((await response.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
    if (data.ok !== true) {
      return { appId: "", code: slackCode(data.error, response.status === 429 ? "ratelimited" : "slack_error") };
    }
    const bot = (data.bot && typeof data.bot === "object" ? data.bot : {}) as Record<string, unknown>;
    const appId = typeof bot.app_id === "string" && SLACK_APP_ID_RE.test(bot.app_id) ? bot.app_id : "";
    return appId ? { appId, code: "" } : { appId: "", code: "app_id_missing" };
  } catch {
    return { appId: "", code: "network_error" };
  }
}

/**
 * Conversation bot scopes (auth.test x-oauth-scopes via probeScopes) and app id
 * (bots.info). Slack errors become a status; nothing throws, nothing is written.
 */
export async function checkConversationBotScopesAndApp(
  token: string
): Promise<{ botScopeCheck: BotScopeCheck; botApp: BotAppCheck }> {
  const appUnknown = (status: BotAppCheck["status"], code = ""): BotAppCheck => ({
    status,
    code,
    appId: null,
    expectedAppId: STAFFPASS_SLACK_APP_ID,
    matchesStaffpassApp: null,
  });
  const scopesUnknown = (status: BotScopeCheck["status"], code = ""): BotScopeCheck => ({
    status,
    code,
    scopes: null,
    missingChannelClassifyScopes: null,
    channelClassifyScopesReady: false,
  });
  if (!token) return { botScopeCheck: scopesUnknown("token_missing"), botApp: appUnknown("not_probed") };

  let probe: Awaited<ReturnType<typeof probeSlackTokenScopes>>;
  try {
    probe = await probeSlackTokenScopes(token);
  } catch {
    probe = { ok: false, scopes: null, error: "network_error", appId: "", botId: "" };
  }
  if (!probe.ok) {
    return { botScopeCheck: scopesUnknown("auth_test_failed", probe.error || "slack_error"), botApp: appUnknown("not_probed") };
  }

  let botScopeCheck: BotScopeCheck;
  if (!probe.scopes) {
    botScopeCheck = scopesUnknown("scopes_unavailable", "x_oauth_scopes_missing");
  } else {
    const granted = new Set(probe.scopes);
    const missing = CHANNEL_CLASSIFY_BOT_SCOPES.filter((s) => !granted.has(s));
    botScopeCheck = {
      status: "ok",
      code: "",
      scopes: probe.scopes,
      missingChannelClassifyScopes: missing,
      channelClassifyScopesReady: missing.length === 0,
    };
  }

  if (!SLACK_BOT_ID_RE.test(probe.botId)) return { botScopeCheck, botApp: appUnknown("bot_id_missing") };
  const info = await slackBotsInfoAppId(token, probe.botId);
  const botApp: BotAppCheck = info.appId
    ? {
        status: "ok",
        code: "",
        appId: info.appId,
        expectedAppId: STAFFPASS_SLACK_APP_ID,
        matchesStaffpassApp: info.appId === STAFFPASS_SLACK_APP_ID,
      }
    : appUnknown("bots_info_failed", info.code);
  return { botScopeCheck, botApp };
}

export function slackAuthorizeUrlTemplate(): string {
  return `${getAppOrigin()}/api/slack/oauth/link?t={token}`;
}

/** Next step for "this employee's Slack must be (re)connected". */
export function slackAuthorizeLinkIssueStepJa(employeeId: string): string {
  return (
    `Admin MCP の setup.slackAuthorizeLink.issue（employeeId: ${employeeId}）で再認可リンクを発行してください` +
    `（人の承認 1 回 → 承認アプリの DM でリンクが届く → 社員本人の Slack で開いて「許可する（Authorize）」）。` +
    `SLACK_AUTHORIZE_LINK_ENABLED が OFF の間は、社員証画面で「雇う／社員証発行」の権限を持つ人が Slack 連携をタップします。`
  );
}

export async function slackAuthTest(token: string): Promise<SlackAuthTestResult> {
  if (!token) {
    return { ok: false, error: "token_missing" };
  }
  try {
    const response = await fetch("https://slack.com/api/auth.test", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      signal: AbortSignal.timeout(SLACK_AUTH_TEST_TIMEOUT_MS),
    });
    const body = (await response.json().catch(() => ({}))) as SlackAuthTestResult;
    return body;
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "auth_test_failed" };
  }
}

export type SlackStatusNextStepInput = {
  botTokenPresent: boolean;
  authTest: SlackAuthTestResult | null;
  botHasFilesWrite: boolean;
  botFilesWriteCode: string;
  adapterEnabled: boolean;
  imRoutesCount: number;
  postingMismatch: string[];
  employees: EmployeeSlackPathStatus[];
  pathBReadiness: PathBReadiness;
};

/** Canonical human-action order for Slack / Path B onboarding. */
export function computeSlackStatusNextStepJa(input: SlackStatusNextStepInput): string {
  const path = DASHBOARD_BOT_TOKEN_PATH_JA;

  if (!input.botTokenPresent) {
    return (
      `conversation bot token not registered（この組織の会話投稿Botトークンが未登録です。環境変数のBotは使いません）。` +
      `Admin MCP の ${SET_BOT_TOKEN_TOOL} で登録してください（人の承認が必要）。` +
      `Slack API → OAuth & Permissions → Bot Token Scopes に files:write（および im:history, chat:write, im:write）を追加し、` +
      `Install to Workspace で再インストールしてください。その後 Bot User OAuth Token (xoxb-...) をダッシュボード「${path}」に登録してください。`
    );
  }

  if (input.authTest && !input.authTest.ok) {
    return `Bot Token の認証に失敗しました (${input.authTest.error || "unknown"})。Slack で再インストール後、新しい xoxb をダッシュボード「${path}」で更新してください。`;
  }

  if (!input.adapterEnabled) {
    return `ダッシュボード「${path}」で有効にし、Bot token を保存してください。`;
  }

  if (input.botTokenPresent && input.authTest?.ok && !input.botHasFilesWrite) {
    if (input.botFilesWriteCode === "missing_scope") {
      return (
        `Slack API → OAuth & Permissions → Bot Token Scopes に files:write を追加し、Install to Workspace で再インストールしてください。` +
        `その後新しい xoxb をダッシュボード「${path}」に貼り付けて保存してください。`
      );
    }
    return (
      `Bot Token の files:write 確認に失敗しました (${input.botFilesWriteCode})。` +
      `Slack アプリの Bot Token Scopes と再インストールを確認し、xoxb をダッシュボード「${path}」で更新してください。`
    );
  }

  const needsAuthorize = input.employees.filter(
    (e) => e.needsPathB && !e.slackIdentityLinked
  );
  if (needsAuthorize.length > 0) {
    const first = needsAuthorize[0];
    return (
      `Path B（posting_as: user / 人↔人 DM）には社員の Slack 連携が必要です。` +
      `社員「${first.displayName}」（employeeId: ${first.employeeId}）: ${slackAuthorizeLinkIssueStepJa(first.employeeId)}` +
      `URL テンプレート: ${first.authorizeUrlTemplate || slackAuthorizeUrlTemplate()}`
    );
  }

  const needsReoauth = input.employees.filter((e) => e.needsReoauthForFilesWrite);
  if (needsReoauth.length > 0) {
    const first = needsReoauth[0];
    return (
      `Path B ファイル添付には User Token の files:write が必要です。` +
      `Slack API → User Token Scopes に files:write を追加後、社員「${first.displayName}」（employeeId: ${first.employeeId}）を再連携します。${slackAuthorizeLinkIssueStepJa(first.employeeId)}` +
      `URL テンプレート: ${first.authorizeUrlTemplate || slackAuthorizeUrlTemplate()}`
    );
  }

  if (input.imRoutesCount === 0) {
    return (
      "チャネル分類を設定してください。内部1:1には channels.classify で employeeId を指定します。" +
      "混在/Connect chは mixed=true + parties.upsert（相手台帳必須）。詳細: docs/tenant-slack-kickoff-rail.md"
    );
  }

  if (input.postingMismatch.length > 0) {
    return (
      "posting_as の設定を確認してください。【Bot】会社窓口・アプリDM向け。【個人(user)】社員名義・チャネル/人対人DM向け。" +
      "Path A (App DM) は bot、Path B (人↔人DM) は user。詳細: docs/tenant-slack-kickoff-rail.md"
    );
  }

  if (input.pathBReadiness.pathBEmployeeCount > 0 && !input.pathBReadiness.ready) {
    return (
      "Path B のファイル添付準備が未完了です。setup.slackStatus の employees / pathBReadiness を確認し、" +
      "User Token Scopes（files:write）と社員 Slack 再連携を完了してください。"
    );
  }

  return (
    "Slack 設定は完了しています。Path B で PDF 添付を試す場合は comm.reply + fileAttachment で e2e 確認してください。" +
    "混在/Connect chを使う場合は parties.upsert で相手台帳を登録してください。詳細: docs/tenant-slack-kickoff-rail.md"
  );
}

function employeeNeedsPathB(
  postingAs: PostingAs | string | null | undefined,
  hasLinkedIdentity: boolean
): boolean {
  return postingAs === "user" || hasLinkedIdentity;
}

export async function diagnoseSlackStatus(orgId: string): Promise<SlackStatusResult> {
  const issues: string[] = [];

  const botToken = await resolveOrgSlackBotToken(orgId);
  const botTokenPresent = Boolean(botToken);

  let authTest: SlackAuthTestResult | null = null;
  if (botTokenPresent) {
    authTest = await slackAuthTest(botToken);
    if (!authTest.ok) {
      issues.push(`auth.test 失敗: ${authTest.error || "unknown"}`);
    }
  } else {
    issues.push(
      `conversation bot token not registered: この組織の会話投稿Botトークンが未登録です（${SET_BOT_TOKEN_TOOL} で登録）`
    );
  }
  const conversationBotToken: ConversationBotTokenStatus = botTokenPresent
    ? { status: "registered" }
    : {
        status: "not_registered",
        code: CONVERSATION_BOT_TOKEN_NOT_REGISTERED,
        nextTool: SET_BOT_TOKEN_TOOL,
      };

  // Only this org's own adapter token (resolveOrgSlackBotToken(orgId) above);
  // the org comes from the caller's credential, never from tool arguments.
  const { botScopeCheck, botApp } = await checkConversationBotScopesAndApp(botTokenPresent ? botToken : "");

  let botFilesWriteCode = "not_probed";
  let botFilesWriteNeeded: string | null = null;
  let botHasFilesWrite = false;
  if (botTokenPresent && authTest?.ok) {
    const probe = await probeSlackFilesWrite(botToken);
    botHasFilesWrite = probe.ready;
    botFilesWriteCode = probe.code;
    botFilesWriteNeeded = probe.needed || null;
    if (!probe.ready) {
      if (probe.code === "missing_scope") {
        issues.push(`Bot Token に files:write スコープがありません (needed: ${probe.needed || "files:write"})`);
      } else {
        issues.push(`Bot files:write プローブ失敗: ${probe.code}`);
      }
    }
  }

  const adapters = await listConversationAdapters(orgId);
  const slackAdapter = adapters.find((a) => a.surface === "slack");
  const adapterEnabled = slackAdapter?.enabled ?? false;
  const adapterLabel = slackAdapter?.label ?? null;
  if (!adapterEnabled) {
    issues.push("Slack 会話アダプタが無効です");
  }

  const imRoutes = await listSlackImRoutesByOrg(orgId);
  const imRoutesCount = imRoutes.length;
  const employeesWithRoutes = new Set(imRoutes.map((r) => r.employeeId));

  const employees = await listEmployees(orgId);
  let postingAsBot = 0;
  let postingAsUser = 0;
  let pathAEmployees = 0;
  let pathBEmployees = 0;
  const postingMismatch: string[] = [];
  const employeeStatuses: EmployeeSlackPathStatus[] = [];

  for (const emp of employees) {
    if (emp.status !== "active") continue;
    const posting = emp.postingAs || "bot";
    if (posting === "bot") postingAsBot++;
    else if (posting === "user") postingAsUser++;
    else postingAsBot++;

    const hasRoute = employeesWithRoutes.has(emp.id);
    const identity = await getEmployeeSlackIdentity(emp.id);
    const hasLinkedIdentity = identity?.status === "linked";
    const needsPathB = employeeNeedsPathB(posting, hasLinkedIdentity);

    if (hasLinkedIdentity) {
      pathBEmployees++;
      if (posting === "bot" && hasRoute) {
        postingMismatch.push(
          `${emp.displayName}: Path B (linked identity) だが posting_as: bot。人↔人DMには user が必要`
        );
      }
    } else if (hasRoute) {
      pathAEmployees++;
      if (posting === "user") {
        postingMismatch.push(
          `${emp.displayName}: Path A (App DM route のみ) だが posting_as: user。Bot DMには bot が必要`
        );
      }
    }

    let fileUploadReady: boolean | null = null;
    let needsReoauthForFilesWrite = false;
    const authorizeUrlTemplate =
      needsPathB ? slackAuthorizeUrlTemplate() : null;

    if (needsPathB) {
      if (!hasLinkedIdentity) {
        fileUploadReady = false;
        issues.push(`${emp.displayName}: Path B だが Slack 連携未完了`);
      } else if (identity?.status === "needs_reauth") {
        fileUploadReady = false;
        needsReoauthForFilesWrite = true;
        issues.push(`${emp.displayName}: Slack 連携が再認可を必要としています`);
      } else {
        const userToken = await getLinkedSlackUserToken(emp.id);
        if (!userToken) {
          fileUploadReady = false;
          needsReoauthForFilesWrite = true;
          issues.push(`${emp.displayName}: User Token が取得できません（再連携が必要）`);
        } else {
          const userProbe = await probeSlackFilesWrite(userToken);
          fileUploadReady = userProbe.ready;
          if (!userProbe.ready) {
            if (userProbe.code === "missing_scope") {
              needsReoauthForFilesWrite = true;
              issues.push(
                `${emp.displayName}: User Token に files:write がありません (needed: ${userProbe.needed || "files:write"})`
              );
            } else {
              issues.push(`${emp.displayName}: User files:write プローブ失敗: ${userProbe.code}`);
            }
          }
        }
      }
    }

    employeeStatuses.push({
      employeeId: emp.id,
      displayName: emp.displayName,
      postingAs: posting,
      slackIdentityLinked: hasLinkedIdentity,
      slackIdentityStatus: identity?.status ?? null,
      needsPathB,
      fileUploadReady,
      needsReoauthForFilesWrite,
      authorizeUrlTemplate,
    });
  }

  if (postingMismatch.length > 0) {
    issues.push(...postingMismatch);
  }

  const pathBEmployeesList = employeeStatuses.filter((e) => e.needsPathB);
  const linkedCount = pathBEmployeesList.filter((e) => e.slackIdentityLinked).length;
  const fileUploadReadyCount = pathBEmployeesList.filter((e) => e.fileUploadReady === true).length;
  const needsReoauthCount = pathBEmployeesList.filter((e) => e.needsReoauthForFilesWrite).length;
  const needsAuthorizeCount = pathBEmployeesList.filter((e) => !e.slackIdentityLinked).length;

  const pathBReadiness: PathBReadiness = {
    pathBEmployeeCount: pathBEmployeesList.length,
    linkedCount,
    fileUploadReadyCount,
    needsReoauthCount,
    needsAuthorizeCount,
    ready:
      pathBEmployeesList.length === 0 ||
      (needsAuthorizeCount === 0 &&
        needsReoauthCount === 0 &&
        fileUploadReadyCount === pathBEmployeesList.length),
  };

  const nextStepJa = computeSlackStatusNextStepJa({
    botTokenPresent,
    authTest,
    botHasFilesWrite,
    botFilesWriteCode,
    adapterEnabled,
    imRoutesCount,
    postingMismatch,
    employees: employeeStatuses,
    pathBReadiness,
  });

  return {
    ok: botTokenPresent && issues.length === 0,
    botTokenPresent,
    conversationBotToken,
    nextTool: botTokenPresent ? null : SET_BOT_TOKEN_TOOL,
    authTest,
    botScopeCheck,
    botApp,
    missingChannelClassifyScopes: botScopeCheck.missingChannelClassifyScopes,
    botAppIdMatchesStaffpass: botApp.matchesStaffpassApp,
    botHasFilesWrite,
    botFilesWriteCode,
    botFilesWriteNeeded,
    adapterEnabled,
    adapterLabel,
    imRoutesCount,
    employeePostingAsBot: postingAsBot,
    employeePostingAsUser: postingAsUser,
    pathAEmployees,
    pathBEmployees,
    employees: employeeStatuses,
    pathBReadiness,
    postingMismatch,
    issues,
    nextStepJa,
    authorizeUrlTemplate: slackAuthorizeUrlTemplate(),
    dashboardBotTokenPathJa: DASHBOARD_BOT_TOKEN_PATH_JA,
  };
}

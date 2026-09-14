/**
 * Slack integration diagnostics for Admin MCP setup.slackStatus (read-only).
 */

import { listEmployees } from "@/lib/data";
import { listConversationAdapters } from "@/lib/data/conversation-adapters";
import { getEmployeeSlackIdentity, getLinkedSlackUserToken } from "@/lib/data/slack-identities";
import { listSlackImRoutesByOrg } from "@/lib/data/slack-im-routes";
import { getAppOrigin } from "@/lib/approvals/tokens";
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

export type SlackStatusResult = {
  ok: boolean;
  botTokenPresent: boolean;
  authTest: SlackAuthTestResult | null;
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

export function slackAuthorizeUrlTemplate(employeeId?: string): string {
  const origin = getAppOrigin();
  const id = (employeeId || "").trim() || "{employeeId}";
  return `${origin}/api/slack/oauth/start?employeeId=${encodeURIComponent(id)}`;
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
      `社員「${first.displayName}」（employeeId: ${first.employeeId}）の社員証画面から Authorize をタップしてください（人間がブラウザで実行）。` +
      `URL テンプレート: ${first.authorizeUrlTemplate || slackAuthorizeUrlTemplate(first.employeeId)}`
    );
  }

  const needsReoauth = input.employees.filter((e) => e.needsReoauthForFilesWrite);
  if (needsReoauth.length > 0) {
    const first = needsReoauth[0];
    return (
      `Path B ファイル添付には User Token の files:write が必要です。` +
      `Slack API → User Token Scopes に files:write を追加後、社員「${first.displayName}」（employeeId: ${first.employeeId}）が社員証から Slack 再連携（Authorize）してください。` +
      `URL テンプレート: ${first.authorizeUrlTemplate || slackAuthorizeUrlTemplate(first.employeeId)}`
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
    issues.push("Bot Token が設定されていません");
  }

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
      needsPathB ? slackAuthorizeUrlTemplate(emp.id) : null;

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
    ok: issues.length === 0,
    botTokenPresent,
    authTest,
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

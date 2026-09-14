/**
 * LINE approval-inbox diagnostics for Admin MCP setup.lineApprovalStatus (read-only).
 */

import { listEmployees, listNotificationChannels } from "@/lib/data";
import { getAppOrigin } from "@/lib/approvals/tokens";
import type { NotificationChannel, NotificationProvider } from "@/lib/types";

export const LINE_OA_NAME_RULE_JA =
  "OA 表示名は {employeeDisplayName}（AIスタッフ）形式（docs/space-tree-line-oa-design.md §P1-e 参照）";

export const WEBHOOK_REGISTER_HINT_JA =
  "LINE Developers コンソール → Messaging API 設定 → Webhook URL に webhookUrlTemplate を貼り付け、「Webhookの利用」を ON にしてください。自動登録はできません。";

export const LINE_APPROVAL_CONFUSION_NOTE_JA =
  "承認用LINE（本ツール群）は「承認を受け取る」インボックスです。会話投稿LINE（P1 予定）や Slack 会話投稿アダプタ（setup.slackAdapter.setBotToken）とは別です。";

export type LineDestinationKind = "user" | "group" | "room";

export type LineApprovalChannelStatus = {
  id: string;
  label: string;
  enabled: boolean;
  isDefault: boolean;
  destinationPresent: boolean;
  destinationKind?: LineDestinationKind;
  allowedUserIdsCount: number;
  hasCredentials: boolean;
  webhookPath: string;
  webhookUrlTemplate: string;
  webhookRegisterHintJa: string;
};

export type LineEmployeeInboxRow = {
  employeeId: string;
  displayName: string;
  inbox: "line" | "telegram" | "unset" | "other";
};

export type LineEmployeeInboxSummary = {
  lineCount: number;
  telegramCount: number;
  unsetCount: number;
  employees: LineEmployeeInboxRow[];
};

export type LineApprovalStatusResult = {
  ok: boolean;
  channels: LineApprovalChannelStatus[];
  telegramApprovalEnabled: boolean;
  telegramIsDefault: boolean;
  employeeInboxSummary: LineEmployeeInboxSummary;
  confusionNoteJa: string;
  nextStepJa: string;
};

export function lineDestinationKind(destinationId: string): LineDestinationKind | undefined {
  const id = destinationId.trim();
  if (!id) return undefined;
  if (id.startsWith("U")) return "user";
  if (id.startsWith("C")) return "group";
  if (id.startsWith("R")) return "room";
  return undefined;
}

function webhookUrlForChannel(channel: NotificationChannel): string {
  const origin = getAppOrigin();
  const ref = channel.webhookRef?.trim() || "{ref}";
  return `${origin}/api/webhooks/line/${encodeURIComponent(ref)}`;
}

export function mapLineApprovalChannelStatus(channel: NotificationChannel): LineApprovalChannelStatus {
  const destinationId = String(channel.config.destinationId || "").trim();
  const allowedUserIds = Array.isArray(channel.config.allowedUserIds)
    ? channel.config.allowedUserIds.map(String).filter(Boolean)
    : [];
  const kind = lineDestinationKind(destinationId);
  return {
    id: channel.id,
    label: channel.label,
    enabled: channel.enabled,
    isDefault: channel.isDefault,
    destinationPresent: Boolean(destinationId),
    ...(kind ? { destinationKind: kind } : {}),
    allowedUserIdsCount: allowedUserIds.length,
    hasCredentials: channel.hasCredentials,
    webhookPath: channel.webhookPath,
    webhookUrlTemplate: webhookUrlForChannel(channel),
    webhookRegisterHintJa: WEBHOOK_REGISTER_HINT_JA,
  };
}

function resolveEmployeeInboxProvider(
  employee: { approvalChannelId?: string | null },
  channels: NotificationChannel[]
): "line" | "telegram" | "unset" | "other" {
  const requested = employee.approvalChannelId?.trim() || "";
  const chosen = requested
    ? channels.find((channel) => channel.id === requested && channel.enabled)
    : channels.find((channel) => channel.isDefault && channel.enabled) ??
      channels.find((channel) => channel.enabled);
  if (!chosen) return "unset";
  if (chosen.provider === "line") return "line";
  if (chosen.provider === "telegram") return "telegram";
  return "other";
}

export function buildEmployeeInboxSummary(
  employees: Awaited<ReturnType<typeof listEmployees>>,
  channels: NotificationChannel[]
): LineEmployeeInboxSummary {
  const enabledChannels = channels.filter((channel) => channel.enabled);
  const rows: LineEmployeeInboxRow[] = employees.map((employee) => ({
    employeeId: employee.id,
    displayName: employee.displayName,
    inbox: resolveEmployeeInboxProvider(employee, enabledChannels),
  }));
  return {
    lineCount: rows.filter((row) => row.inbox === "line").length,
    telegramCount: rows.filter((row) => row.inbox === "telegram").length,
    unsetCount: rows.filter((row) => row.inbox === "unset").length,
    employees: rows,
  };
}

export type LineApprovalNextStepInput = {
  lineChannels: LineApprovalChannelStatus[];
  telegramApprovalEnabled: boolean;
  telegramIsDefault: boolean;
  employeeInboxSummary: LineEmployeeInboxSummary;
};

/** Canonical human-action order for Space Tree LINE approval kickoff. */
export function computeLineApprovalNextStepJa(input: LineApprovalNextStepInput): string {
  const readyLine = input.lineChannels.find(
    (channel) =>
      channel.enabled &&
      channel.destinationPresent &&
      channel.hasCredentials &&
      channel.isDefault
  );
  const anyLine = input.lineChannels.find((channel) => channel.enabled);

  if (input.lineChannels.length === 0) {
    return (
      "1. LINE Developers で Messaging API チャネル（公式アカウント）を作成してください（人間作業）。" +
      `2. OA 表示名を ${LINE_OA_NAME_RULE_JA.replace("{employeeDisplayName}", "対象AI社員名")} に設定（人間作業）。` +
      "3. 上長が OA を友だち追加し、userId を取得（人間作業）。" +
      "4. setup.lineApproval.upsert で channelAccessToken / channelSecret / destinationId を登録し、人が承認してください。"
    );
  }

  if (!anyLine?.hasCredentials || !anyLine.destinationPresent) {
    return (
      "setup.lineApproval.upsert で channelAccessToken / channelSecret / destinationId を登録し、人が承認してください。" +
      " destinationId は上長の userId（U...）またはグループ/ルーム ID です。"
    );
  }

  if (!readyLine) {
    return (
      "setup.lineApproval.upsert で isDefault=true に設定するか、既定の承認用 LINE を有効化してください。" +
      " その後 setup.lineApprovalStatus で webhookUrlTemplate を確認します。"
    );
  }

  return (
    "5. setup.lineApprovalStatus の webhookUrlTemplate を LINE Developers の Webhook URL に貼り付け、Webhook を ON にしてください（人間作業）。" +
    "6. テスト送信 / Flex 承認カードで postback が動くことを確認。" +
    (input.telegramApprovalEnabled
      ? "7. setup.lineApproval.setEmployeeInbox で AI 社員の承認インボックスを LINE に割り当て、setup.lineApproval.demoteTelegram で Telegram 二重送信を止めてください。"
      : "7. setup.lineApproval.setEmployeeInbox で AI 社員の承認インボックスを LINE チャネルへ割り当ててください。")
  );
}

export async function diagnoseLineApprovalStatus(orgId: string): Promise<LineApprovalStatusResult> {
  const channels = await listNotificationChannels(orgId);
  const lineChannels = channels
    .filter((channel) => channel.provider === "line")
    .map(mapLineApprovalChannelStatus);
  const telegramChannels = channels.filter((channel) => channel.provider === "telegram");
  const telegramApprovalEnabled = telegramChannels.some((channel) => channel.enabled);
  const telegramIsDefault = telegramChannels.some(
    (channel) => channel.enabled && channel.isDefault
  );
  const employees = await listEmployees(orgId);
  const employeeInboxSummary = buildEmployeeInboxSummary(employees, channels);

  return {
    ok: true,
    channels: lineChannels,
    telegramApprovalEnabled,
    telegramIsDefault,
    employeeInboxSummary,
    confusionNoteJa: LINE_APPROVAL_CONFUSION_NOTE_JA,
    nextStepJa: computeLineApprovalNextStepJa({
      lineChannels,
      telegramApprovalEnabled,
      telegramIsDefault,
      employeeInboxSummary,
    }),
  };
}

export function providerLabel(provider: NotificationProvider): string {
  if (provider === "telegram") return "Telegram";
  if (provider === "line") return "LINE";
  return "Slack";
}

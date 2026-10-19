/** Japanese titles for Admin MCP tools. Keep this module free of queue I/O. */

export const ADMIN_TOOL_TITLE_JA: Record<string, string> = {
  "employees.issue": "AI社員の発行",
  "employees.credential.auto_renew": "社員証を更新しますか",
  link: "AI社員の連携",
  "policy.patch": "権限の更新",
  "parties.upsert": "相手台帳の更新",
  "channels.classify": "チャネル分類",
  "channels.list": "チャネル分類台帳の一覧（読み取り）",
  "parties.list": "相手台帳の一覧（読み取り）",
  "roles.propose": "職務案の提案",
  "ingressHandoff.patch": "受信の渡し方",
  "setup.slackAdapter.setBotToken": "Slack会話投稿Botトークン",
  "setup.lineApproval.upsert": "承認用LINEチャネル",
  "setup.lineApproval.setEmployeeInbox": "AI社員の承認インボックス（LINE）",
  "setup.lineApproval.demoteTelegram": "Telegram承認チャネルの無効化",
  "approvalWorkflow.bindVoter": "承認者バインディング作成",
  "approvalWorkflow.unbindVoter": "承認者バインディング取り消し",
  "orgs.create": "テナント作成（プラットフォーム運用）",
  "orgs.issueAdminCredential": "管理MCP認証発行（プラットフォーム運用）",
  "channels.remove": "チャネル台帳から削除",
  "parties.remove": "相手台帳から削除",
};

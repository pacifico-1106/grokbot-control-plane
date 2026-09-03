/**
 * Kickoff vs daily shell.
 * Unconfigured: no admin MCP connected and/or no employees confirmed.
 */
export type OrgSetupInput = {
  adminMcpConnected: boolean;
  confirmedEmployeeCount: number;
};

export function orgNeedsSetup(input: OrgSetupInput): boolean {
  if (!input.adminMcpConnected) return true;
  if (input.confirmedEmployeeCount < 1) return true;
  return false;
}

export const SETUP_STEPS = [
  {
    id: "account",
    title: "アカウント",
    body: "会社のアカウントで Staffpass に入ります。",
    href: "/app",
    label: "アカウント",
  },
  {
    id: "admin-mcp",
    title: "admin MCP 接続",
    body: "テナントに1つの管理エージェントを接続します。社員証（gb_emp_）とは別口です。",
    href: "/app/getting-started#admin-mcp",
    label: "接続する",
  },
  {
    id: "process-source",
    title: "工程の正本",
    body: "ドキュメントまたは音声またはテキスト。必須はどれか一つです。Drive がなくても進めます。会話ログも同じ正本候補です。",
    href: "/app/getting-started#process-source",
    label: "正本を渡す",
  },
  {
    id: "confirm-employees",
    title: "社員を1人ずつ人確認",
    body: "管理エージェントが提案した最初の権限案を、人が1人ずつ確認します。",
    href: "/app/approvals",
    label: "承認へ",
  },
  {
    id: "link-agents",
    title: "手足の紐付け",
    body: "MCPが案内します。Bot作成はエージェント側。Staffpassは社員証だけを管理します。",
    href: "/app/approvals",
    label: "紐付けへ",
  },
  {
    id: "approvers",
    title: "承認者と通知口",
    body: "日々の通す／止めるは Telegram / LINE / Slack の通知口が主です。社内1:1を分類すると、指定したAI社員の受け口も同時に付きます。",
    href: "/app/settings",
    label: "通知口",
  },
  {
    id: "connectors",
    title: "コネクタ認証",
    body: "Gmail / Slack などの OAuth は人がタップします。承認チケットとは別です。",
    href: "/app/integrations",
    label: "連携へ",
  },
] as const;

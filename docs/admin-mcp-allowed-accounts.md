# 管理 MCP: 社員証の許可アカウント（allowedAccounts）編集

フラグ `ADMIN_MCP_ALLOWED_ACCOUNTS_TOOLS_ENABLED`（既定 OFF）。

| ツール | 種別 | 内容 |
| --- | --- | --- |
| `employees.allowedAccounts.add` | always_human | 1 件追加。人が承認したときに反映 |
| `employees.allowedAccounts.remove` | always_human | 1 件削除。人が承認したときに反映 |
| `employees.allowedAccounts.list` | read-only | 現在の一覧（承認不要） |

- org は管理資格情報（gb_adm_）からのみ取得します。`orgId` 引数は受け付けません（`unexpected_argument`）。他 org の社員は、存在しない ID と同じ `employee_not_found` になります。
- 保存先と正規化はダッシュボード AI 社員ページ「ブラウザ・外部アカウント」と同じです（`normalizeAllowedAccounts` → `employees.allowed_accounts` と有効な `credentials.allowed_accounts`）。`browser:use` がある社員証は 0 件にできません（`allowed_accounts_required`）。
- provider: `slack`（`^[UW][A-Z0-9]{8,20}$`）、`google` / `microsoft365`（メール）、`line` / `x` / `note` / `linkedin` / `youtube` / `instagram` / `facebook`（ハンドル。空白・URL は不可）。`other` や自由記入のサービスはダッシュボード専用です（`unsupported_provider`）。
- 既にあるものを add → `already_allowed`（ok、チケットなし、重複なし）。無いものを remove → `allowed_account_not_found`。
- 承認チケットの要約例: 「社員「稲盛」の許可アカウントに Slack U0C1RN0AHE1 を追加します（現在 1 件 → 2 件）。承認すると反映されます。」
- 承認後の反映時に再検証します: フラグ、入力形式、社員が同じ org に今もいること、停止されていないこと、自分に紐づく社員証でないこと、現在の一覧（add は既にあれば変更なし、remove は既に無ければ `allowed_account_not_found`）。
- 変更ログ（audit_events, action `admin.policy`, auditClass `admin`）: event `employee.allowed_accounts.added` / `.removed` / `.unchanged` / `.rejected`、`actor`（管理エージェント）、`approver`、`employeeId`、`provider`、`accountId`、`before` / `after`、`approvalId`。
- 管理エージェントは、自分の Grok Bot に紐づく社員証を変更できません（`cannot_target_self`）。
- remove は既存の Slack 連携（employee_slack_identities）を解除しません。

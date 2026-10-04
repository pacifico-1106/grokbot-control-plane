# 管理 MCP: Slack 投稿名義（posting_as）の切り替え

| ツール | 種別 | 内容 |
| --- | --- | --- |
| `employees.postingIdentity.set` | always_human | AI 社員の Slack 投稿名義を `bot`（会社の Bot）/ `user`（本人の Slack ユーザートークン）に切り替える。人が承認したときに反映 |

引数は `employeeId` と `postingAs`（`"bot"` か `"user"`）だけです（ほかに `jobId`、結果を読むときの `approvalId`）。

これまで投稿名義はダッシュボード（AI社員ページ「Slack 投稿名義」、`PATCH /api/employees/[id]/slack-identity`）でしか変えられず、`policy.patch` では変えられませんでした。このツールは、ダッシュボードと同じ保存処理（`writeEmployeePostingAs`、`lib/employees/posting-identity.ts`）を使います。

## フラグを付けない理由

always_human のチケットで人が 1 回承認するまで何も変わりません（`policy.patch` と同じ扱い）。さらに `user` への切り替えは、本人が OAuth / 再認可リンクで自分の Slack を連携し chat:write を許可していないと通りません。フラグを足しても守りは増えず、運営の手順が 1 つ増えるだけなので、付けていません。

## チェック

- org は管理資格情報（gb_adm_）からのみ取得します。`orgId` 引数は受け付けません（`unexpected_argument`）。他 org の社員は、存在しない ID と同じ `employee_not_found` になります。
- 停止中の社員 → `employee_terminated`。自分の Grok Bot に紐づく社員証 → `cannot_target_self`。
- いまと同じ名義 → `already_set`（ok、チケットなし）。
- `postingAs` は `"bot"` / `"user"` 以外 → `invalid_posting_as`。token / secret らしい引数 → `secret_not_accepted`。

### `user` に切り替えるとき（提案時と、承認後の反映直前の 2 回）

| 状態 | コード | 変更 |
| --- | --- | --- |
| 同じ org の linked な Slack 連携がない／再認可待ち（needs_reauth）／ユーザートークンが保存されていない | `user_token_missing` | しない |
| 保存されているトークンを Slack が拒否（`invalid_auth` / `token_revoked` / `token_expired` / `account_inactive` / `not_authed`） | `user_token_invalid`（`slackError`） | しない |
| 付与された scope を読めない（auth.test 失敗・`x-oauth-scopes` なし） | `user_token_scope_check_failed` | しない（確認できないので止める） |
| scope に `chat:write` がない | `missing_scope_chat_write`（`missingScopes: ["chat:write"]`） | しない |

- scope は、保存されている本人のユーザートークンで `auth.test` を 1 回呼び、`x-oauth-scopes` ヘッダーで確かめます（`setup.slackDmApprovalStatus` / `setup.slackAuthorizeLink.issue` と同じ `probeSlackTokenScopes`）。トークンはその場の変数だけで、チケット・MCP の結果・監査には出しません。
- 断ったときの `nextStepJa`: `SLACK_AUTHORIZE_LINK_ENABLED` が ON なら `setup.slackAuthorizeLink.issue` で再認可リンクを送る案内、OFF ならダッシュボード「Slack 連携（Authorize）」の案内。
- 承認待ちのあいだに連携が解除された・chat:write のないトークンで連携し直された、という場合は、反映直前のチェックで断り、名義は変えません。

### `bot` に切り替えるとき

トークンの確認はしません（Slack も呼びません）。トークンが壊れていても `bot` には戻せます。

## 変更ログ

audit_events, action `admin.policy`, auditClass `admin`:

- `employee.posting_as.changed`: `from` / `to`（と従来どおり `postingAs` = to）、`actor`（管理エージェント）、`approver`、`approvalId`、`tool`、`employeeId`、`user` のときは `slackUserId`。`actorEmail` は承認者。
- `employee.posting_as.unchanged`: 承認待ちのあいだに既に切り替わっていた。
- `employee.posting_as.rejected`: 反映時に断った（`code` 付き）。

ダッシュボードの `PATCH /api/employees/[id]/slack-identity` の監査（action `employee.updated`）にも `from` / `to` を足しました（`postingAs` はそのまま）。ダッシュボードの動き（未連携でも `user` を選べる）は変えていません。

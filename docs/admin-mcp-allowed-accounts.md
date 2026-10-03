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

## Slack の U… を remove したとき

実行時の Slack の処理は、そのたびに allowedAccounts を見ていません。allowedAccounts を見るのは、紐づけるとき（`bindEmployeeSlackIdentity`）だけです。

| 経路 | 毎回 allowedAccounts を見るか | 根拠 |
|---|---|---|
| 受信（mention / channel / user-token channel） | 見ていない | `lib/slack/mention-ingress.ts` の `getEmployeesBySlackUserIds` / `listLinkedSlackIdentitiesForTeam` → `lib/data/slack-identities.ts`（identity の linked 行だけ） |
| 受信（DM / IM ルート） | 見ていない | `lib/data/slack-im-routes.ts` の `resolveSlackImWakeTarget` / `resolveSlackUserTokenImWakeTarget` → `getSlackWakeTargetByEmployeeId` |
| 送信（user token: chat.postMessage、ファイル、リアクション） | 見ていない | `lib/gateway/adapters/slack.ts` の `resolveConversationToken` → `getLinkedSlackUserToken`（status=linked だけ） |
| 認可（OAuth callback） | 見ている（紐づけのたび） | `app/api/slack/oauth/callback/route.ts` → `bindEmployeeSlackIdentity` → `employeeAllowsSlackUser` |
| 認可（#240 の再認可リンク） | 見ている（紐づけのたび） | `lib/slack/authorize-link.ts` の `completeAuthorizeLinkCallback` → `bindEmployeeSlackIdentity` |

そのため、その U… に linked の紐づけが残っている間は、remove 後も受信と送信で使われ続けます。remove の結果には、次の案内を出します（自動解除はしません）。

- 出す条件：provider が slack で、その社員に同じ U… の **linked** の紐づけが同じ org で残っているとき。needs_reauth（token もウェイクも使われない）や、別の U… の紐づけのときは出しません。
- MCP の結果：`slackIdentityRemains: true`、`slackIdentityNoticeJa`「既存の Slack 紐づけは残っています。止めるにはダッシュボードで解除してください」、`nextStepJa`、チケットの要約にも追記します。既に許可アカウントから外れている（`allowed_account_not_found`）ときも同じ案内を付けます。
- 承認後の処理結果：反映の直前にもう一度確かめ、残っていれば `noticeJa` / `nextStepJa` と `summaryJa` に出します。
- 監査（`employee.allowed_accounts.removed`）：`slackIdentityRemains`（true / false）、残っていれば `slackIdentityNoticeJa`、summary にも追記します。
- 止め方：ダッシュボードの AI社員詳細 →「Slack 連携（Authorize）」→「連携を解除」。

## バックログ

- [ ] **remove したら実行時も止まるようにする**（紐づけを自動で無効化するか、実行時に毎回確認するか）。どちらの方式にするかは八坂さんの確認を待ち、別PRで対応します（#238〜#243 のセットには入れません）。それまでは上の案内（「既存の Slack 紐づけは残っています。止めるにはダッシュボードで解除してください」）で対応します。
  - 対象の経路（2026-10-04 調査。#242 head `1e4a4e2` と #240 head `ea103d5` の行番号）：

    | 区分 | 経路 | 毎回 allowedAccounts を見るか | file:line |
    |---|---|---|---|
    | 受信 | events（mention / channel） | 見ていない | `lib/slack/mention-ingress.ts:376,378`（`getEmployeesBySlackUserIds`）、`:417`（`listLinkedSlackIdentitiesForTeam`）→ `lib/data/slack-identities.ts:274-317`、`:320-340` |
    | 受信 | user-token channel ingress | 見ていない | `lib/slack/mention-ingress.ts:818`（`getEmployeesBySlackUserIds`） |
    | 受信 | DM（IM ルート / user-token IM） | 見ていない | `lib/slack/mention-ingress.ts:343,354` → `lib/data/slack-im-routes.ts:323-379` → `lib/data/slack-identities.ts:232-254`（`getSlackWakeTargetByEmployeeId`） |
    | 受信 | cross-team ウェイク（G7） | 見ていない | `lib/data/cross-team-wake-bindings.ts:134`（`getSlackWakeTargetByEmployeeId`） |
    | 受信 | IM no-route 監査 | 見ていない | `lib/slack/im-no-route-audit.ts:171`（`getEmployeesBySlackUserIds`） |
    | 送信 | chat.postMessage（postingAs=user） | 見ていない | `lib/gateway/invoke.ts:1848` → `lib/gateway/adapters/slack.ts:95-100`（`resolveConversationToken`）→ `lib/data/slack-identities.ts:67-98`（`getLinkedSlackUserToken`、status=linked だけ）。`lib/gateway/invoke.ts:882-918` の allowedAccounts チェックは browser.use 専用 |
    | 送信 | ファイル | 見ていない | `lib/gateway/adapters/slack-file-upload.ts:348`（`resolveConversationToken`） |
    | 送信 | リアクション | 見ていない | `lib/slack/reaction-stamps.ts:65`（`getLinkedSlackUserToken`） |
    | user token 利用 | DM 自動ルート | 見ていない | `lib/slack/dm-autoroute.ts:365`（`getLinkedSlackUserToken`。auth.test で紐づけの U… と比べるだけ） |
    | 認可 | OAuth callback | 見ている（紐づけのたび） | `app/api/slack/oauth/callback/route.ts:108` → `lib/data/slack-identities.ts:117`（`employeeAllowsSlackUser`、合わなければ `slack_identity_mismatch`） |
    | 認可 | #240 の再認可リンク | 見ている（紐づけのたび） | #240 `lib/slack/authorize-link.ts:573`（`bindEmployeeSlackIdentity`、合わなければ `:583` で `allowed_accounts_mismatch`）。リンク発行時の `:222-228`（`authorizeLinkPins`）は既存の紐づけの U… を固定するだけで、allowedAccounts は callback の bind で確かめる |

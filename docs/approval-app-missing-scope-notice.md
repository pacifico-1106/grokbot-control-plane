# 承認アプリの権限不足を承認者にすぐ伝える（APPROVAL_APP_MISSING_SCOPE_NOTICE_ENABLED）

既定 OFF。OFF の間は何も変わらない。

## 対象
テナント独自の承認アプリ（共通承認アプリ「Staffpass承認」は対象外）で、次のチケットが
`approval_app_missing_scope`（users:read / im:write / chat:write がない）で止まったとき:

- `setup.approvalDelivery.autoResolve`
- `setup.slackAuthorizeLink.issue`

## ON のときの動き
1. **すぐ通知**: そのチケットを承認した人（同じ組織の有効なメンバー。分からなければ owner/admin）にメール、
   さらに組織の他の有効な承認口（止まった承認口は除く・最大 3）に、
   「承認アプリ（App ID）に Slack の権限 <scope> がありません。この権限を足して入れ直してください」。
   載せるのは ID だけ（承認ID・App ID・scope・ツール名）。依頼本文・トークンは載せない。
   監査: `admin.notificationChannel` / `approval_app.missing_scope_notice`。
2. **同じチケットを再実行できる**: このコードは書き込み・投稿より前の拒否なので、実行クレームを
   `failed`（再実行可）で閉じる。入れ直した後、管理エージェントが同じツールを `approvalId` 付きで呼び直す。
3. **W2 は自動再実行に回数を使わない**: 直さないと成功しないエラーなので `fix_required`（stuckHint=fix）。
   一時的なエラーは従来どおり `maxAutoRetries`（既定 2）まで。

## 本番手順
1. マージ後、`APPROVAL_APP_MISSING_SCOPE_NOTICE_ENABLED=true`。
2. 戻すときは OFF にするだけ（DB 変更なし）。

## 追加: 直さないと成功しない 3 コード（APPROVAL_APP_FIX_REQUIRED_CODES_ENABLED、既定 OFF）

`APPROVAL_APP_MISSING_SCOPE_NOTICE_ENABLED` とは別のフラグ（本番で先に ON にしていても、こちらは OFF のまま何も変わらない）。

| コード | 何がおかしいか | 直し方 | 止まる位置 |
|---|---|---|---|
| `bot_token_required` | 承認口の Bot token（xoxb-…）がない／形式違い | owner/admin が /app/settings「承認を受け取る」で入れ直す → 同じチケットを呼び直し | Slack を一度も呼ぶ前 |
| `approval_user_guest` | 承認 DM の相手がゲスト | フルメンバーにする（同じチケット可）／別の人にする（許可 user ID を直す。相手を指定したチケットは作り直し） | users.info の後、conversations.open の前 |
| `approval_user_external` | 相手が社外（Slack Connect）・別ワークスペース | 同じワークスペースの社内メンバーを許可 user ID に（相手を指定したチケットは作り直し） | users.info の後（または conversations.open の応答が外部共有 DM のとき。どちらも投稿・保存の前） |

ON のとき: W2 は `fix_required`（回数を使わない）、実行クレームは再実行可（2 ツールのみ）、コードごとの文面で承認者に通知（監査 `approval_app.fix_required_notice`、`code` 付き）。
共通承認アプリでは `bot_token_required` は運営側の問題なのでテナントに通知しない（ゲスト／社外はテナントが直すので通知する）。
`setup.approvalDelivery.autoResolve` はキュー時に相手（deliveryUserId）を固定するため、社外の相手は同じチケットでは成功しない（新しいチケットを作る）。

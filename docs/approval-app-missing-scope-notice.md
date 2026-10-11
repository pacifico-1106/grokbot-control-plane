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

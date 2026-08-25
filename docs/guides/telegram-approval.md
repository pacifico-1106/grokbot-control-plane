# Telegram 承認チャット — 本番設定

StaffPass の承認通知を専用Telegramグループへ送り、承認・却下・修正依頼を処理するための運用手順です。Telegramが未設定または一時的に失敗しても、Gatewayと既存メール通知は継続します。

## 1. Botとグループ

1. BotFatherで承認専用Botを作成し、トークンを `TELEGRAM_BOT_TOKEN` に設定する。
2. 承認専用グループへBotを追加する。既存のSales Bot / Admin Botは利用しない。
3. BotFatherの `/setprivacy` でこのBotの **Group PrivacyをDisable** にする。修正指示の返信テキスト受信に必要。
4. グループの負数chat IDを `TELEGRAM_APPROVAL_CHAT_ID` に設定する。
5. 操作を許可する数値user IDを `TELEGRAM_ALLOWED_USER_IDS` にカンマ区切りで設定する。空の場合は対象chat内の全員を許可する。

## 2. Vercel環境変数

Productionへ次を設定し、再デプロイする。

```text
TELEGRAM_BOT_TOKEN=<BotFather token>
TELEGRAM_APPROVAL_CHAT_ID=-100...
TELEGRAM_WEBHOOK_SECRET=<十分に長いランダム値>
TELEGRAM_ALLOWED_USER_IDS=123456789,987654321
CRON_SECRET=<十分に長い別のランダム値>
```

`TELEGRAM_WEBHOOK_SECRET` と `CRON_SECRET` は別の値にする。値をログ、Issue、PR本文へ貼らない。

## 3. Webhook登録

環境変数を設定した安全な端末から実行する。

```bash
curl -fsS -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -d "url=https://staffpass.sealith.com/api/webhooks/telegram" \
  -d "secret_token=${TELEGRAM_WEBHOOK_SECRET}" \
  -d 'allowed_updates=["message","callback_query"]'
```

確認:

```bash
curl -fsS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo"
```

URLが正しく、`last_error_message` が空であることを確認する。

## 4. DBとcron

既存DBには `supabase/migrations/20260826_telegram_revision.sql` を適用してからコードをデプロイする。Vercel Cronは `vercel.json` に定義済み。

- JST 08:30: `30 23 * * *`（UTC）
- JST 18:00: `0 9 * * *`（UTC）

## 5. 受け入れ確認

1. `mail.send` など承認必須toolをinvokeし、Telegramに3ボタンが届く。
2. 承認と却下がpoll / callbackへ反映され、元メッセージのボタンが消える。
3. 「修正」→元メッセージへ返信し、pollで `revision_requested` と `revisionNote` を確認する。
4. 同じ `jobId` と `parentApprovalId` で再invokeし、元通知への返信として届くことを確認する。
5. `/app/approvals` でも三択と修正指示が表示されることを確認する。

Webhookはsecret不一致を401、chat/user不一致を200で無視する。Telegram API呼び出しは5秒でtimeoutし、承認データの更新自体を巻き戻さない。

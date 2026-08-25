# テナント別 Telegram / LINE 承認チャネル

各組織は `/app/settings` から専用の Telegram Bot または LINE Messaging API チャネルを設定できます。承認依頼、承認・却下・修正依頼、定時ダイジェストは同一 `org_id` のチャネルとデータだけを使用します。通知障害が発生してもGatewayの承認作成、Web画面、メール通知は継続します。

## セキュリティ境界

- Bot token、LINE channel access token / secret、Webhook secretはAES-256-GCMで暗号化する。
- 暗号文は `org_notification_channel_secrets` に分離し、ブラウザ用RLS policyを作らない。service roleだけが読み書きする。
- 設定APIはログイン中のowner/adminのみ利用でき、secretは保存後にレスポンス・画面へ戻さない。
- Webhook URLは推測困難なチャネル別refを含み、Telegram secret headerまたはLINE署名を検証する。
- chat/group/room/userと `org_id`、承認の配信記録を照合する。別テナントのrefや承認は処理しない。

Productionでは `NOTIFICATION_CONFIG_ENCRYPTION_KEY` に32文字以上の安定したランダム値が必須です。ローテーション時は既存暗号文の再暗号化が必要なので、通常の再デプロイで値を変えないでください。

## Telegram（テナント設定）

1. BotFatherでテナント専用Botを作成し、対象グループへ追加する。
2. 修正指示の返信を受ける場合、BotFather `/setprivacy` でGroup PrivacyをDisableにする。
3. `/app/settings` で負数のchat ID、Bot token、必要なら許可する数値user IDを設定して有効化・保存する。
4. 保存時にアプリが `setWebhook` を自動実行する。画面に表示された `/api/webhooks/telegram/<ref>` とテスト送信を確認する。

## LINE（テナント設定）

1. LINE Developersでテナント専用Messaging APIチャネルを作成する。
2. `/app/settings` に送信先group / room / user ID、channel access token、channel secret、必要なら許可user IDを設定する。
3. 保存後に表示されるパスへ本番originを付け、LINE DevelopersのWebhook URLへ登録する。
4. 「Webhookの利用」を有効化し、検証とテスト送信を行う。

LINEのWebhook URLはLINE Developers側の操作が必要なため自動登録されません。

## Tokyo307パイロットのenvフォールバック

既存のグローバルenv方式は、activeな `org_members.email = info@tokyo307inc.com` を含む組織だけに残します。

```text
TELEGRAM_BOT_TOKEN=...
TELEGRAM_APPROVAL_CHAT_ID=-100...
TELEGRAM_WEBHOOK_SECRET=...
TELEGRAM_ALLOWED_USER_IDS=123456789
```

- この組織にテナント別Telegramが有効ならテナント設定を優先し、envへ二重送信しない。
- この組織にテナント別Telegramがなければ `/api/webhooks/telegram` とenvを使う。
- 他組織では上記envが存在しても送信・Webhook処理・ダイジェストに一切使用しない。
- LINEにグローバルフォールバックはない。

## DB・デプロイ順序

1. `supabase/migrations/20260827_tenant_notification_channels.sql` を適用する。
2. Productionへ `NOTIFICATION_CONFIG_ENCRYPTION_KEY` を追加する。
3. アプリをデプロイする。
4. `info@tokyo307inc.com` の所属組織が1つでactiveであることを確認する。
5. 各テナントのowner/adminが設定、テスト送信、承認三択、修正返信を確認する。

定時ダイジェストのcron URLは後方互換のため `/api/cron/telegram-digest` のままですが、実際には有効なTelegram・LINEをテナント単位で処理します。

## 受け入れ確認

1. テナントAとBに異なるチャネルを設定し、Aの承認がBへ届かない。
2. Telegram / LINEの承認と却下がpoll / callbackへ反映される。
3. 修正依頼後の返信で `revision_requested` と `revisionNote` が保存される。
4. Web画面で解決した場合も、実際に配信した各チャネルだけが更新される。
5. secret不一致は401、送信先・user・テナント・配信記録不一致は処理されない。
6. secret入力欄は再表示されず、監査ログに設定変更・テスト送信・配信失敗が残る。

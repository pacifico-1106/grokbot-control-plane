# 承認アプリの DM 自動オープンと「設定しました」（SLACK_APPROVAL_DM_AUTO_OPEN）

既定 OFF。ON のとき、/app/settings →「承認を受け取る」→ Slack で **チャンネル ID を空欄**のまま保存すると:

1. 許可 user ID が 1 人ならその人、複数なら「DM を開く相手」（許可 user ID の中の 1 人）宛てに、
   承認アプリの bot token で `conversations.open` して D… を決める。
2. その前に `auth.test` → `users.info` で、Slack Connect（is_stranger）・別ワークスペース（Grid 含む）・ゲスト・bot・削除済み・判定不能を拒否（保存しない）。
3. 既存の外部共有チェック（conversations.info）と expectedTeamId 取得はそのまま通る。
4. 宛先が新規または変更のときだけ「設定しました」を 1 通送る。**送れたら宛先は有効とみなす（テスト送信・テスト承認は不要）**。送れなければ保存しない。
5. config に `autoOpened {userId, at}` と `setupNoticeAt` を残す。監査は `admin.notificationChannel`（auditClass=admin、event=`approval_dm.*`）。

チャンネル ID を手入力した場合も、ON なら宛先が変わったときに「設定しました」を 1 通送る（送れなければ保存しない）。OFF なら従来どおり。

## 承認アプリの manifest（From an app manifest で貼る）
```yaml
display_information:
  name: Staffpass承認（会社名）
features:
  app_home:
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false
  bot_user:
    display_name: Staffpass承認
    always_online: false
oauth_config:
  scopes:
    bot: [chat:write, im:write, im:read, users:read]
settings:
  interactivity:
    is_enabled: true
    request_url: https://staffpass.sealith.com/api/webhooks/slack/interactivity
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
```
`users:read` は 2. の判定に必須（無いと「承認アプリの Bot Token Scopes に users:read がありません」で保存しない）。既存の承認アプリに足した場合は Reinstall to Workspace が必要。

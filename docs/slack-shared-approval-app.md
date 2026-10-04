# 共通承認アプリ「Staffpass承認」（`SLACK_SHARED_APPROVAL_APP_ENABLED`、既定 OFF）

テナントごとに承認用の Slack アプリを作らなくてよくするための、Staffpass 共通の配布アプリ（distributable app）です。テナント側の作業は次の 2 つだけです。

1. owner/admin が「Slack に追加」を押し、Slack で「許可する」を押す
2. 管理 AI 社員が `setup.slackApprover.set` を出し、人が 1 回承認する

- 社員用アプリ（App A, `A0BU8TABSV6`）とは**別アプリ**です。client、secret、env 名がすべて別なので、承認の経路（このアプリの xoxb）と会話の経路（App A）のトークンは混ざりません。
- テナント別の承認アプリ（みらい社中など）は、今までどおり並行して動きます。共通アプリへの移行は後で別途行います。
- 承認 DM の送信、「設定しました」の送信、#240 の再認可リンクの DM 送信は、どれも org の Slack 承認口（`org_notification_channels`、provider `slack`）にある secrets の **`botToken`** を使います。共通アプリをインストールすると、その xoxb が同じ provider・同じキーに保存されます。#240 の `resolveApprovalAppBotToken(orgId, inboxId)` も、そのまま共通アプリの xoxb を使います。

## フロー

| # | だれが | 何をする | 回数 |
|---|---|---|---|
| 1 | org の owner/admin（Staffpass にログインした状態） | `https://staffpass.sealith.com/api/slack/approval-app/install/start` を開き、Slack で「許可する」を押す | 1 回 |
| 2 | 管理 AI 社員 | `setup.slackDmApprovalStatus` で次の手順を確認し、`setup.slackApprover.set { slackUserId: "U…" }` を出す | — |
| 3 | 人（承認者） | 上のチケットを 1 回承認する。その後、承認アプリと承認者の DM が自動で開き（#235）、「設定しました」が 1 回届く | 1 回 |
| 4 | — | 本物の承認依頼がその DM に届き、ボタンで承認・却下できる（テスト承認は不要） | — |

### インストール（`/api/slack/approval-app/install/start` → `/api/slack/approval-app/callback`）

- **開始できる人:** owner/admin のセッションを持つ人だけです。org はセッションから決まります。
- **state:** 共通アプリの Client Secret で HMAC 署名します。中身は `orgId`・nonce・purpose・期限（10 分）です。App A の state とは鍵もドメインも別です。
  - nonce は cookie と突き合わせます。
  - 1 回限りです。使った nonce は `slack_oauth_state_uses` に sha256 で記録します。
- **callback でのセッション確認:** callback 側でも、**同じ org** の owner/admin セッションを要求します。違えば 403 です。
- **拒否する条件:** 次のどれかに当たると拒否します。何も保存せず、受け取った token は `auth.revoke` で失効させ、結果ページにエラーを出し、拒否を監査に記録します。

  | 条件 | コード |
  |---|---|
  | Enterprise Grid の org 全体インストール（`is_enterprise_install=true`）、または enterprise だけで team が無い | `enterprise_install_not_supported` |
  | 返ってきたのが bot token ではない | `not_bot_token` |
  | `app_id` が `SLACK_SHARED_APPROVAL_APP_ID` と違う | `app_mismatch` |
  | `auth.test` の team と OAuth の team が違う | `auth_failed` |
  | その Slack ワークスペースが**別の org** に紐づいている（その org の Slack 承認口や Slack 会話アダプタの `teamId` / `expectedTeamId` が一致）。**既存の紐づけは変えない** | `team_bound_to_other_org` |
  | この org がすでに**別の**ワークスペースを使っている | `team_mismatch_org` |
  | 確認のための照会に失敗した（fail-closed） | `lookup_failed` |

  `team_bound_to_other_org` のときに MCP 結果に出す文言:
  「このSlackワークスペースは別の組織に接続済みです。運営に連絡してください。」
  結果ページ（`/api/slack/approval-app/callback`）は別の文言です（下の「結果ページ」）。
- **成功時の保存先:** その org の Slack 承認口に、`config` = `{ sharedApprovalApp: true, apiAppId, teamId, expectedTeamId, teamName, channelId: "", allowedUserIds: [] }` と、暗号化した `secrets.botToken` を保存します。
  - signing secret は承認口に保存しません。共通アプリへのリクエストは env の secret だけで検証します。
  - 承認口が 1 つも無い org では、これがデフォルトの承認口になります。
  - すでに既定の承認口がある org では、デフォルトは変えません。
  - 同じ org が再インストールした場合は同じ承認口を使い、承認者と DM はそのまま残します。
- **DB による保証:** migration の unique index により、1 つのワークスペースにつき共通アプリの承認口は 1 つだけです。2 つの org が同時にインストールしても、後の方は `team_bound_to_other_org` で拒否されます。
- **監査:** 監査には token や token の先頭も記録しません。拒否の記録に相手の org ID は書きません。

### 承認者の設定（`setup.slackApprover.set`、always_human）

- 引数は `slackUserId`（U…）と、必要なら `inboxId` です。token や orgId などの未知の引数は拒否します。org は credential から決まります。
- 共通アプリの承認口がまだ無い場合は `shared_app_not_installed`（インストール URL 付き）を返します。直前のインストールが拒否されていた場合は、その理由（例: `team_bound_to_other_org` と上の文言）をそのまま返します。
- 承認後は、#235 の `openApprovalDeliveryDm` を共通アプリの xoxb で呼びます。users.info で次を確認し、当てはまる人は拒否します: 同じワークスペースではない、ゲスト、bot、削除済み、Slack Connect。
  - DM の team が、インストールしたときの team と一致することも確認します。
  - 確認が通ったら、**先に** `allowedUserIds = [U…]` と `channelId = D…` を保存し、保存できてから「設定しました」を 1 回送ります（送れたら `setupNoticeAt` を記録）。
  - 保存に失敗したら「設定しました」は送らず、`save_failed` を返して監査（`shared_approval_app.approver_set_failed`）に残します。
  - 保存のあとで「設定しました」だけ送れなかったときは、承認者は保存済みのまま失敗（Slack のエラーコード）を返します。`setupNoticeSent` は false のままなので、状態の確認で分かります。
  - DM を開く段階（users.info・team の確認）で失敗したら何も保存しません。
- ダッシュボードの「承認を受け取る」から共通アプリの承認口を上書き保存することはできません（`shared_app_inbox_managed`）。

### ボタン（Interactivity）: `/api/webhooks/slack/interactivity`（テナント別アプリと同じ URL）

1. `api_app_id` が `SLACK_SHARED_APPROVAL_APP_ID` と一致し、かつフラグが ON のときだけ、共通アプリの処理に入ります。
2. 最初に、**共通アプリの Signing Secret だけ**で署名とタイムスタンプ（±5 分）を検証します。
3. 次に team_id から、そのワークスペースで有効な共通アプリの承認口を引きます。0 件なら 403 `unknown_team`、2 件以上なら 403 `ambiguous_team` です。
4. その後は既存の処理と同じです。承認依頼は**その承認口の org** の中でだけ探します。届け先（`approval_notification_deliveries` の channel_id と ts）が一致することと、`allowedUserIds` の確認も既存どおりです。
   - 別の org の承認依頼は見つからないので、承認は通りません。

- 共通アプリの承認口には signing secret が無いので、テナント別アプリの検証経路では絶対に通りません。逆に、テナント別アプリの secret で署名したリクエストを共通アプリの処理に入れても 401 になります。
- フラグが OFF のときは、共通アプリからのリクエストは常に 401 `shared_approval_app_disabled` です（fail-closed）。共通アプリの Signing Secret で署名が通り、team から承認口が 1 つに決まったときだけ、その org に #236 のボタンのアラート（`approval_button.failed`、理由 `shared_approval_app_disabled`、30 分の間引きあり）を出します。署名が通らない押下ではアラートを出しません。

### Events: `/api/webhooks/slack/approval-app/events`

- 最初に、共通アプリの Signing Secret で署名とタイムスタンプを検証します。署名が不正、またはタイムスタンプが古い場合は 401 です。
- `url_verification` には challenge を返します。
- 処理するイベントは `app_uninstalled` と `tokens_revoked`（bot token が含まれるもの）だけです。それ以外のイベントは 200 を返して無視します。team が分からないときも 200 で無視します。
- 上の 2 つを受け取ったら、team_id からその org の共通アプリの承認口を引き、その承認口の **暗号化した secrets（`botToken`）を削除**して **無効**にします（`disabledReason` / `disabledAt`、削除したときは `secretsPurgedAt` / `secretsPurgedReason` を記録）。監査は `shared_approval_app.disabled` と `shared_approval_app.secrets_purged` です。
- **token を削除したときは、理由や経路にかかわらず必ず #236 のアラート**（`APPROVAL_DELIVERY_FAILURE_ALERT`）を出します（`app_uninstalled` / `tokens_revoked` / 配信時の `token_revoked` / `invalid_auth` / `account_inactive`）。削除は 1 回きりなので、直前に別の配信失敗で 30 分の間引き枠が使われていても、このアラートは間引かずに出します。すでに無効だった承認口でも、token が残っていて削除したならアラートを出します。
  - アラートの文面とメール、監査の `nextStepJa` には、次の一手として「共通承認アプリの接続が切れました。owner/admin が Staffpass にログインした状態で install/start を開き、「許可する」を押せば戻ります」を出します。完全な URL は書きません。
  - 同じ削除が 2 回目に来たとき（もう無効で token も無く、何もしないとき）はアラートを出しません。
- `setup.slackDmApprovalStatus` の `sharedApprovalApp` には、削除された状態として `tokenDeleted: true`、`tokenDeletedAt`、`tokenDeletedReason`、`connectionLost: true` が出ます。次の手順（`nextStepsJa`）には、上と同じ文（URL なし）を、インストール URL 付きの手順の代わりに出します。再インストールすると `tokenDeleted: false` / `connectionLost: false` に戻ります。
- 監査（`shared_approval_app.secrets_purged`）に残すのは `teamId`、削除した日時（`deletedAt`）、理由（`reason`）、削除したキーの名前（`deletedKeys`、例: `["botToken"]`）だけで、token の値や先頭は残しません。
- **ほかの検知経路:** 本物の承認依頼をこの承認口に送ったとき、Slack が `token_revoked` / `invalid_auth` / `account_inactive` を返した場合も、同じように無効化して secrets を削除し、アラートを出します（理由はその Slack のエラー名）。`channel_not_found` など、それ以外のエラーでは何も消しません。フラグが OFF のときは、そもそも共通アプリの token で送らないので何も消しません。
  - 消すのは、**そのエラーを返した共通アプリの承認口の token だけ**です。同じ org にあるテナント別アプリの承認口の token には触りません。テナント別アプリの承認口が `invalid_auth` などを返しても、何も削除しません（共通アプリの印が無い承認口は削除の対象外）。
- 同じイベントが 2 回来ても安全です。2 回目は、承認口がもう無効で secrets も無いので、何もせず、監査もアラートも書きません。
- 消すのは、その org の、共通アプリの印（`sharedApprovalApp`）が付いた承認口の secrets だけです。別の org の secrets や、同じ org のテナント別アプリの承認口には触りません。
- 削除のあとは、#240 の `resolveApprovalAppBotToken` も token なしとして空を返し、承認 DM もリンク DM も送られません（fail-closed）。token なしで承認口を有効に戻そうとしても、保存の時点で拒否されます。

**アンインストール後に残すもの / 消すもの**

| 対象 | 扱い |
|---|---|
| 承認口の行（`org_notification_channels`） | 残す。無効（`enabled=false`）にして、`disabledReason` / `disabledAt` を記録 |
| `config.teamId` / `apiAppId` | 残す。別の org がそのワークスペースを取れないようにするため（unique index も残る） |
| 承認者（`allowedUserIds`）と DM の `channelId` | 残す。再インストールしたときにそのまま使う |
| 暗号化した secrets（`botToken`） | **削除する**（`org_notification_channel_secrets` の行ごと） |
| 監査 | 無効化と削除の記録を残す（token の値は残さない） |

- 同じ org が再インストールすれば、新しい token が保存され、承認口が有効に戻ります。承認者と DM はそのまま使えます。
- フラグが OFF のときは 404 です。

## Slack アプリの作り方（八坂さん・手作業）

**events なしの manifest で作るのが確実です**（下の手順はこの作り方です）。events 付きの manifest で作っても構いませんが、フラグが OFF のあいだは Event Subscriptions の Request URL の確認（`url_verification`）が通らない（404）ので、フラグを ON にしたあとに Request URL の **Retry** を押してください。

1. **events なしの manifest でアプリを作る**
   1. https://api.slack.com/apps → **Create New App** → **From a manifest** を選び、Staffpass の開発用ワークスペースを選ぶ。
   2. 下の manifest（events なし版）を貼り、**Create** を押す。Slack の画面は **JSON** タブが最初に開くので、JSON 版をそのまま貼れば足ります（YAML タブに切り替えて YAML 版を貼っても中身は同じ）。
   3. **Basic Information** で次の 4 つを控える（チャットには貼らず、Vercel に直接入れる）: App ID / Client ID / Client Secret / Signing Secret
   4. **Manage Distribution**（Settings → Manage Distribution）で、チェックリストを確認して **Activate Public Distribution** を押す。Slack Marketplace への申請は不要。
   5. **OAuth & Permissions** で次を確認する:
      - 「Advanced token security via token rotation」が **OFF**（manifest の `token_rotation_enabled: false`）。ON にすると xoxb が 12 時間で失効し、承認が届かなくなる。
      - Redirect URL が 1 件だけ入っている。
      - Bot Token Scopes が 4 つ（chat:write、im:write、im:read、users:read）になっている。
      - User Token Scopes は **空**のまま。
2. **env 4 つを設定し、フラグを ON にする**: Vercel に env 4 つ（下の表）を入れて deploy し、`SLACK_SHARED_APPROVAL_APP_ENABLED=1` にして redeploy する。これで Events URL が `url_verification` に応答するようになる。
3. **Slack のアプリ設定画面で Event Subscriptions を ON にする**
   1. **Event Subscriptions** を開き、**Enable Events** を ON にする。
   2. **Request URL** に `https://staffpass.sealith.com/api/webhooks/slack/approval-app/events` を入れる。すぐに確認が走り、**Verified** と出れば OK（出なければ、2 のフラグと env が反映されているか確認して **Retry**）。
   3. **Subscribe to bot events** に `app_uninstalled` と `tokens_revoked` を足す（追加のスコープは要らない）。
4. **Save Changes** を押して保存する。画面上部に reinstall を促す表示が出ても、開発用ワークスペースには入れていないので押さなくてよい。

- 開発用ワークスペースに自分でインストールする必要はない。テナントは `install/start` から追加する。
- 3 を済ませるまでは、アンインストールや token の取り消しが Events では届かない（配信時に `token_revoked` / `invalid_auth` / `account_inactive` が返ったときの検知は動く）。テナントにインストールしてもらう前に 3・4 を終えること。
- manifest を貼る前に、Slack 画面の JSON / YAML タブを貼る形式に合わせる（JSON タブに YAML を貼るとエラーになる）。

### manifest（events なし版・最初に使う）

Slack の画面の初期表示は JSON タブです。JSON 版と YAML 版は同じ内容です（scopes・redirect URL・interactivity・settings が一致することを確認済み）。Events は手順 3 で画面から足すので、ここには入れていません。

JSON 版:

```json
{
  "display_information": {
    "name": "Staffpass承認",
    "description": "Staffpass の承認依頼を承認者の DM に届け、ボタンで承認・却下するためのアプリです。",
    "background_color": "#1f2937"
  },
  "features": {
    "bot_user": {
      "display_name": "Staffpass承認",
      "always_online": true
    }
  },
  "oauth_config": {
    "redirect_urls": [
      "https://staffpass.sealith.com/api/slack/approval-app/callback"
    ],
    "scopes": {
      "bot": [
        "chat:write",
        "im:write",
        "im:read",
        "users:read"
      ]
    }
  },
  "settings": {
    "interactivity": {
      "is_enabled": true,
      "request_url": "https://staffpass.sealith.com/api/webhooks/slack/interactivity"
    },
    "org_deploy_enabled": false,
    "socket_mode_enabled": false,
    "token_rotation_enabled": false
  }
}
```

YAML 版:

```yaml
display_information:
  name: Staffpass承認
  description: Staffpass の承認依頼を承認者の DM に届け、ボタンで承認・却下するためのアプリです。
  background_color: "#1f2937"
features:
  bot_user:
    display_name: Staffpass承認
    always_online: true
oauth_config:
  redirect_urls:
    - https://staffpass.sealith.com/api/slack/approval-app/callback
  scopes:
    bot:
      - chat:write
      - im:write
      - im:read
      - users:read
settings:
  interactivity:
    is_enabled: true
    request_url: https://staffpass.sealith.com/api/webhooks/slack/interactivity
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
```

手順 3・4 のあとの最終形（参考）: 上の `settings` に次が加わった状態になります。manifest を後から編集するときに比べるためのものです。最初からこれを含めて作る場合は、上に書いたとおり、フラグ ON のあとに Request URL の **Retry** を押します。

```yaml
settings:
  event_subscriptions:
    request_url: https://staffpass.sealith.com/api/webhooks/slack/approval-app/events
    bot_events:
      - app_uninstalled
      - tokens_revoked
```

- `org_deploy_enabled: false` で、Enterprise Grid の org 全体へのインストールを出さないようにしています。コード側でも拒否します。
- `app_uninstalled` と `tokens_revoked` には追加のスコープは要りません。

### フラグを OFF にしたとき（インストール済みでも全部止まる）

`SLACK_SHARED_APPROVAL_APP_ENABLED` を OFF にすると、インストール済みの共通アプリの承認口（`config.sharedApprovalApp === true`）は「停止中」になり、どの経路からも共通アプリの token では送りません。token は消さないので、ON に戻せばそのまま再開します（ロールバックのスイッチ）。テナント別アプリの承認口には影響しません。

止まる経路:
- 承認依頼の配信（`sendApprovalNotifications`）: 停止中の承認口は配信先になりません。届かなかった扱い（`shared_approval_app_disabled`）にして #236 のアラートを出します（30 分の間引きあり）。
- データ層: 有効な通知チャンネルの一覧（`getEnabledNotificationChannels` / `listAllEnabledNotificationChannels` / webhook 照会 / `resolveEmployeeApprovalChannel`）から外します。これで、アラートの送り先の候補、stuck-watch、decision-workflow、配信アダプタ、bot token の解決（`resolveOrgSlackBotToken`）、mention-ingress、設定画面のテスト送信、カードの更新も止まります。
- token の取り出し（`getNotificationChannelSecretsById`）: 停止中の承認口には空を返し、#236 のアラートを出します。#240 の `resolveApprovalAppBotToken`（リンク DM）、`slack-delivery-adapter`、`approval-workflow/admin`、`fulfill-admin` はここを通るので止まります。行が確かめられないときも空を返します（fail-closed）。
- 承認 DM の自動オープン（`setup.approvalDelivery.autoResolve`）: `shared_approval_app_disabled` で止めます。
- 承認者の設定（`setup.slackApprover.set`）: `feature_disabled` で止めます（承認者の設定は消しません）。
- 状態の確認（`setup.slackDmApprovalStatus`）: 停止中の承認口は `suspended: "shared_approval_app_flag_off"` と出し、token を読まず Slack にも問い合わせません。
- 古いカードのボタン: 上の「ボタン」のとおり 401 とアラートです。

## Vercel env（Production）

| 名前 | 値（どこから） | 必須 |
|---|---|---|
| `SLACK_SHARED_APPROVAL_APP_ID` | Basic Information → App ID（`A…`） | 必須 |
| `SLACK_SHARED_APPROVAL_CLIENT_ID` | Basic Information → App Credentials → Client ID | 必須 |
| `SLACK_SHARED_APPROVAL_CLIENT_SECRET` | 同 → Client Secret（state の署名鍵も兼ねる） | 必須（secret） |
| `SLACK_SHARED_APPROVAL_SIGNING_SECRET` | 同 → Signing Secret | 必須（secret） |
| `SLACK_SHARED_APPROVAL_APP_ENABLED` | `1`（上の 4 つを入れて deploy した後、最後に入れる） | 有効化 |
| `APPROVAL_DELIVERY_FAILURE_ALERT` | `1` を推奨（アンインストールや届かなかったときのアラート、#236） | 任意 |

- 4 つの値のどれかが欠けると、全部の入口が拒否します。インストールは 503、ボタンは 401、events は 503 です。
- App A の `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET` / `SLACK_SIGNING_SECRET` は**使いませんし、変えません**。

## migration と適用順

`supabase/migrations/20261004110000_slack_shared_approval_app.sql` の中身:
- `public.slack_oauth_state_uses`: nonce の sha256、purpose、org_id、期限。RLS 有効・policy なし・anon と authenticated は revoke（service role だけが使える）。
- unique index `org_notification_channels_shared_approval_team_uidx`: `(config->>'apiAppId', config->>'teamId')` の組み合わせを一意にする。対象は provider が slack で、`sharedApprovalApp` が true の行だけ。

**`slack_oauth_state_uses` の掃除:** 書き込みのついでに消します。インストールの state を使うたび、insert の前に `expires_at` が 1 時間（`SLACK_OAUTH_STATE_USE_RETENTION_MS`）より前の行を消します。cron、新しい route、新しい secret は足しません。
- 理由: インストールはまれなので、行はほとんど増えません。state 自体は署名付きで 10 分で切れ、このテーブルを見る前の検証で拒否されます。そのため、期限切れの古い行を消しても、同じ state をもう一度使えるようにはなりません。
- 掃除に失敗しても無視します。1 回きりの判定（insert）は止めませんし、通しもしません。

適用順:
1. PR を merge して deploy する（フラグは OFF のまま）
2. migration を適用する（#234、#240 の migration とは順不同。フラグ OFF のまま先に入れても害はない）
3. env の 4 つを入れて deploy する
4. `SLACK_SHARED_APPROVAL_APP_ENABLED=1` にする
5. Slack のアプリ設定画面で Event Subscriptions を ON にし、Request URL（`/api/webhooks/slack/approval-app/events`）を入れて Verified を確認、bot events に `app_uninstalled` と `tokens_revoked` を足して保存する（上の「Slack アプリの作り方」の手順 3・4）

ロールバックは、フラグを OFF にすれば足ります。テーブルと index を消す SQL は migration のコメントに書いてあります。

## 本番有効化: スペースツリー（team `T07UGN964N5`、org `6d134a38-a0ab-4a8e-aba7-3202650ff523`）

スペースツリーにはテナント別の承認アプリがありません。共通アプリを直接インストールし、そこから最後まで通します。B（#240）もこの承認アプリを使って届きます。

| # | だれ | 何を押すか | 回数 |
|---|---|---|---|
| 0 | 野木 | 事前確認（read-only SQL）。T07UGN964N5 が別の org に紐づいていないこと:<br>`select org_id, enabled, config->>'teamId' t, config->>'expectedTeamId' e from org_notification_channels where provider='slack' and (config->>'teamId'='T07UGN964N5' or config->>'expectedTeamId'='T07UGN964N5');`<br>`select org_id, enabled from org_conversation_adapters where surface='slack' and config->>'teamId'='T07UGN964N5';`<br>結果が 0 行か、`6d134a38-…` の行だけなら OK。スペースツリー自身の Slack の行が**別の** team を指していたら、インストールは `team_mismatch_org` で拒否されるので、先に運営で確認する。 | 0 クリック（SQL 2 本） |
| 1 | 野木 | A と B（#240）を merge・deploy する。migration を適用する（#234 → #240 → A の順で問題ない） | — |
| 2 | 八坂 | Slack で **events なしの** manifest からアプリを作る（JSON 版を貼って Create、1 回）。Activate Public Distribution（1 回）。4 つの値を Vercel に入れる | 約 3 回 |
| 3 | 野木 | `SLACK_SHARED_APPROVAL_APP_ENABLED=1`、`APPROVAL_DELIVERY_FAILURE_ALERT=1`、`SLACK_AUTHORIZE_LINK_ENABLED=1`（B）、`SLACK_USER_SCOPE_IM_WRITE=1` / `SLACK_DM_AUTOROUTE_ENABLED=1`（#234、必要なら）を入れて redeploy する | — |
| 4 | 八坂 | 3 のあと、Slack のアプリ設定画面で Event Subscriptions を ON → Request URL `https://staffpass.sealith.com/api/webhooks/slack/approval-app/events`（Verified になる）→ bot events に `app_uninstalled` / `tokens_revoked` を追加 → Save Changes | 約 4 回 |
| 5 | 稲盛（スペースツリー org の owner/admin で、Slack にアプリを追加できる人） | Staffpass にログインした状態で `https://staffpass.sealith.com/api/slack/approval-app/install/start` を開き、Slack で「許可する」を押す | **2 回** |
| 6 | 木村（スペースツリーの管理 AI 社員を使う） | `setup.slackDmApprovalStatus` で状態を見て、`setup.slackApprover.set { slackUserId: "<承認者の U…>" }` を出す | — |
| 7 | スペースツリーの人間の承認者（owner/admin） | 6 のチケットを `/app/approvals` で承認する。承認者の Slack に「Staffpass承認」との DM が開き、「設定しました」が届く | **1 回** |
| 8 | 人（ダッシュボード） | 稲盛の社員証の allowedAccounts に、Slack の `U0C1RN0AHE1` を**ダッシュボードで**追加する。allowedAccounts を編集する管理 MCP ツールはまだ無い。**#240 のリンクを出す前に**やる | 1 回 |
| 9 | 木村（管理 AI 社員） | 8 が済んでから `setup.slackAuthorizeLink.issue { employeeId: <稲盛の社員 ID> }`（#240）を出し、人が 1 回承認する。#240 の deliverTo は既定で `employee` なので、リンクは「Staffpass承認」から稲盛（`U0C1RN0AHE1`）への DM で届く。承認者には URL なしの「社員本人に送りました」が届く。8 が済んでいないと U… が分からないので、承認者に届く（理由 `employee_slack_user_missing`） | 承認 1 回 |
| 10 | 稲盛 | 届いたリンクを、自分の Slack にログインしたブラウザで開き、「許可する」を押す | **1 回** |
| 11 | — | 連携が完了し、DM ルートが自動で作られる（#234）。最初に来た本物の承認依頼が「Staffpass承認」の DM に届き、ボタンで承認できれば完了（テスト承認は不要） | — |

確認用の MCP:
- `setup.slackDmApprovalStatus`: `sharedApprovalApp.installed`、`approverSlackUserIds`、`destinationKind: "dm"`、`setupNoticeSent: true` を見る
- `dmAutoroute.list`

インストールが拒否されたときは、その理由が `setup.slackDmApprovalStatus.sharedApprovalApp.lastInstallError` と次の手順に出ます。

## 結果ページ

`/api/slack/approval-app/callback` と `install/start`（env 未設定の 503）が返す HTML（`sharedApprovalResultHtml`）。表示だけの話で、成功・失敗の判定、state の検証、ステータスコードは変わりません。

- 見た目はアプリと同じ（`lib/ui/standalone-result-page.ts`。`app/globals.css` のトークンと `.surface` / `.btn` / `.chip` をそのまま写し、ずれるとテストが落ちる）。
- 成功の画面にはエラーコードを出さない。次にやること:「承認者の設定は AI が申請します。確認が届いたら 1 回押すだけです。」
- 失敗の画面は、理由コードごとに「何が起きたか」と「次にやること」（もう一度押す / 管理者に頼む / 運営に連絡）を出し、最後に問い合わせコード（知っているコードだけ。それ以外は `unknown`）。押し直しで直る理由だけ「もう一度追加する」ボタン（`install/start`）を出す。
- クエリの値、DB / Slack API の生のエラー、token、orgId は出さない。値はすべてエスケープ。文言は `SHARED_APPROVAL_RESULT_PAGE_COPY`。
- 再認可リンク（#240）の結果ページ（`authorizeLinkResultHtml`）も同じ部品を使う。

## 要判断

1. **複数の org が 1 つのワークスペースを共有する場合**（例: 同じ会社の部署ごとに org を分ける）。今は**拒否**しています（1 ワークスペース = 1 org）。DB の unique index と、他 org の承認口・会話アダプタを見る検査の両方で拒否します。認めるには、team → org の解決に別の鍵（例: チャンネルごとの紐づけ）が必要になり、ボタンの org の取り違えリスクが上がります。
2. **Enterprise Grid:** org 全体へのインストールは拒否しています。Grid の中の 1 ワークスペースへのインストールは、`team` が返るので**許可**しています。ただし、承認者が別ワークスペースのメンバーなら DM 自動オープンで拒否されます。
3. **「別の org に紐づいている」の判定範囲:** 他 org の Slack 承認口（有効・無効どちらも、どのアプリでも）と、Slack 会話アダプタ（App A の bot install）を見ています。社員の Slack 連携（`employee_slack_identities`）は判定に**入れていません**。ワークスペースをまたいで働く社員がいると、誤って拒否してしまうためです。厳しくするかどうか。
   - 注意: `teamId` も `expectedTeamId` も保存されていない古い承認口（テナント別アプリを昔の手順で保存したもの）は、この判定で見つけられません。
4. **アンインストール時の扱い（回答済み）:** 承認口を無効にし、`teamId` は残します（別の org に乗っ取られないため）。暗号化した token（secrets）は削除します（上の「アンインストール後に残すもの / 消すもの」）。
   - 追加の回答: `invalid_auth` も削除の対象のままです。削除したときは必ず #236 のアラート（次の一手つき・URL なし）を出し、2 回目の削除（何もしないとき）では出しません。削除するのは、エラーを返した共通アプリの承認口の token だけです。
5. **承認者の人数（回答済み）:** 今は 1 人のままです。`setup.slackApprover.set` は 1 人に**置き換え**ます（今の承認者はチケットの要約に表示）。複数人はバックログに回しました。
6. **承認者の制限:** 承認者は、人間の社員が自分の Slack を連携した U… でも構いません。人間の社員は自分の Slack を連携するためです。bot、ゲスト、社外、別ワークスペースは拒否します。自分で自分を承認する操作は、既存の押下時の検査で止まります。
7. **既存のテナント別アプリからの移行**（みらい社中など）は後回しです。共通アプリの承認口はデフォルトを奪わないので、移行するときはデフォルトを切り替える操作が別に必要です。

## バックログ

- 承認者を複数にする：八坂さんの汎用要望（承認の種類ごとに承認者と必要人数を設定できるようにする）の一部として別途対応する

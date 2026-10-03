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

  `team_bound_to_other_org` のときに出す文言（結果ページと MCP 結果で同じ）:
  「このSlackワークスペースは別の組織に接続済みです。運営に連絡してください。」
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
  - 確認が通ったら「設定しました」を 1 回送り、`allowedUserIds = [U…]` と `channelId = D…` を保存します。
  - どこかで失敗したら何も保存しません。
- ダッシュボードの「承認を受け取る」から共通アプリの承認口を上書き保存することはできません（`shared_app_inbox_managed`）。

### ボタン（Interactivity）: `/api/webhooks/slack/interactivity`（テナント別アプリと同じ URL）

1. `api_app_id` が `SLACK_SHARED_APPROVAL_APP_ID` と一致し、かつフラグが ON のときだけ、共通アプリの処理に入ります。
2. 最初に、**共通アプリの Signing Secret だけ**で署名とタイムスタンプ（±5 分）を検証します。
3. 次に team_id から、そのワークスペースで有効な共通アプリの承認口を引きます。0 件なら 403 `unknown_team`、2 件以上なら 403 `ambiguous_team` です。
4. その後は既存の処理と同じです。承認依頼は**その承認口の org** の中でだけ探します。届け先（`approval_notification_deliveries` の channel_id と ts）が一致することと、`allowedUserIds` の確認も既存どおりです。
   - 別の org の承認依頼は見つからないので、承認は通りません。

- 共通アプリの承認口には signing secret が無いので、テナント別アプリの検証経路では絶対に通りません。逆に、テナント別アプリの secret で署名したリクエストを共通アプリの処理に入れても 401 になります。
- フラグが OFF のときは、共通アプリからのリクエストはテナント別の経路に流れて 401 になります（fail-closed）。

### Events: `/api/webhooks/slack/approval-app/events`

- 最初に、共通アプリの Signing Secret で署名とタイムスタンプを検証します。署名が不正、またはタイムスタンプが古い場合は 401 です。
- `url_verification` には challenge を返します。
- 処理するイベントは `app_uninstalled` と `tokens_revoked`（bot token が含まれるもの）だけです。それ以外のイベントは 200 を返して無視します。team が分からないときも 200 で無視します。
- 上の 2 つを受け取ったら、team_id からその org の共通アプリの承認口を引いて **無効**にします（`disabledReason` を記録）。そのうえで管理者向けの監査（`shared_approval_app.disabled`）と、#236 のアラート（`APPROVAL_DELIVERY_FAILURE_ALERT`）を出します。
- `teamId` は残すので、別の org がそのワークスペースを取ることはできません。同じ org が再インストールすれば、また有効になります。
- フラグが OFF のときは 404 です。

## Slack アプリの作り方（八坂さん・手作業）

1. https://api.slack.com/apps → **Create New App** → **From a manifest** を選び、Staffpass の開発用ワークスペースを選ぶ。
2. 下の manifest（YAML）をそのまま貼り、**Create** を押す。
3. **Basic Information** で次の 4 つを控える（チャットには貼らず、Vercel に直接入れる）:
   - App ID
   - Client ID
   - Client Secret
   - Signing Secret
4. **Manage Distribution**（Settings → Manage Distribution）で、チェックリストを確認して **Activate Public Distribution** を押す。Slack Marketplace への申請は不要。
5. **OAuth & Permissions** で次を確認する:
   - 「Advanced token security via token rotation」が **OFF**（manifest の `token_rotation_enabled: false`）。ON にすると xoxb が 12 時間で失効し、承認が届かなくなる。
   - Redirect URL が 1 件だけ入っている。
   - Bot Token Scopes が 4 つ（chat:write、im:write、im:read、users:read）になっている。
   - User Token Scopes は **空**のまま。
6. Vercel に env を入れて deploy し、`SLACK_SHARED_APPROVAL_APP_ENABLED=1` にする（下の表）。その後 **Event Subscriptions** を開き、Request URL の **Retry**（または保存し直し）で Verified にする。
   - アプリを作った直後は、env が未設定なので URL の確認に失敗するが、それで正常。
7. 開発用ワークスペースに自分でインストールする必要はない。テナントは `install/start` から追加する。

### manifest（Create app from manifest に貼り付け）

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
  event_subscriptions:
    request_url: https://staffpass.sealith.com/api/webhooks/slack/approval-app/events
    bot_events:
      - app_uninstalled
      - tokens_revoked
  interactivity:
    is_enabled: true
    request_url: https://staffpass.sealith.com/api/webhooks/slack/interactivity
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
```

- `org_deploy_enabled: false` で、Enterprise Grid の org 全体へのインストールを出さないようにしています。コード側でも拒否します。
- `app_uninstalled` と `tokens_revoked` には追加のスコープは要りません。

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

適用順:
1. PR を merge して deploy する（フラグは OFF のまま）
2. migration を適用する（#234、#240 の migration とは順不同。フラグ OFF のまま先に入れても害はない）
3. env の 4 つを入れて deploy する
4. `SLACK_SHARED_APPROVAL_APP_ENABLED=1` にする
5. Slack の Event Subscriptions で Retry して Verified にする

ロールバックは、フラグを OFF にすれば足ります。テーブルと index を消す SQL は migration のコメントに書いてあります。

## 本番有効化: スペースツリー（team `T07UGN964N5`、org `6d134a38-a0ab-4a8e-aba7-3202650ff523`）

スペースツリーにはテナント別の承認アプリがありません。共通アプリを直接インストールし、そこから最後まで通します。B（#240）もこの承認アプリを使って届きます。

| # | だれ | 何を押すか | 回数 |
|---|---|---|---|
| 0 | 野木 | 事前確認（read-only SQL）。T07UGN964N5 が別の org に紐づいていないこと:<br>`select org_id, enabled, config->>'teamId' t, config->>'expectedTeamId' e from org_notification_channels where provider='slack' and (config->>'teamId'='T07UGN964N5' or config->>'expectedTeamId'='T07UGN964N5');`<br>`select org_id, enabled from org_conversation_adapters where surface='slack' and config->>'teamId'='T07UGN964N5';`<br>結果が 0 行か、`6d134a38-…` の行だけなら OK。スペースツリー自身の Slack の行が**別の** team を指していたら、インストールは `team_mismatch_org` で拒否されるので、先に運営で確認する。 | 0 クリック（SQL 2 本） |
| 1 | 野木 | A と B（#240）を merge・deploy する。migration を適用する（#234 → #240 → A の順で問題ない） | — |
| 2 | 八坂 | Slack で manifest からアプリを作る（貼って Create、1 回）。Activate Public Distribution（1 回）。4 つの値を Vercel に入れる | 約 3 回 |
| 3 | 野木 | `SLACK_SHARED_APPROVAL_APP_ENABLED=1`、`APPROVAL_DELIVERY_FAILURE_ALERT=1`、`SLACK_AUTHORIZE_LINK_ENABLED=1`（B）、`SLACK_USER_SCOPE_IM_WRITE=1` / `SLACK_DM_AUTOROUTE_ENABLED=1`（#234、必要なら）を入れて redeploy する | — |
| 4 | 八坂 | Slack の Event Subscriptions → Retry（Verified になる） | 1 回 |
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

## 要判断

1. **複数の org が 1 つのワークスペースを共有する場合**（例: 同じ会社の部署ごとに org を分ける）。今は**拒否**しています（1 ワークスペース = 1 org）。DB の unique index と、他 org の承認口・会話アダプタを見る検査の両方で拒否します。認めるには、team → org の解決に別の鍵（例: チャンネルごとの紐づけ）が必要になり、ボタンの org の取り違えリスクが上がります。
2. **Enterprise Grid:** org 全体へのインストールは拒否しています。Grid の中の 1 ワークスペースへのインストールは、`team` が返るので**許可**しています。ただし、承認者が別ワークスペースのメンバーなら DM 自動オープンで拒否されます。
3. **「別の org に紐づいている」の判定範囲:** 他 org の Slack 承認口（有効・無効どちらも、どのアプリでも）と、Slack 会話アダプタ（App A の bot install）を見ています。社員の Slack 連携（`employee_slack_identities`）は判定に**入れていません**。ワークスペースをまたいで働く社員がいると、誤って拒否してしまうためです。厳しくするかどうか。
4. **アンインストール時の扱い:** 承認口を無効にし、`teamId` は残します（別の org に乗っ取られないため）。暗号化した token は失効済みなので残したままです。消す処理を入れるかどうか。
5. **承認者の人数:** `setup.slackApprover.set` は 1 人に**置き換え**ます（今の承認者はチケットの要約に表示）。複数人にする場合は、追加する専用の操作を別に用意するかどうか。
6. **承認者の制限:** 承認者は、人間の社員が自分の Slack を連携した U… でも構いません。人間の社員は自分の Slack を連携するためです。bot、ゲスト、社外、別ワークスペースは拒否します。自分で自分を承認する操作は、既存の押下時の検査で止まります。
7. **既存のテナント別アプリからの移行**（みらい社中など）は後回しです。共通アプリの承認口はデフォルトを奪わないので、移行するときはデフォルトを切り替える操作が別に必要です。

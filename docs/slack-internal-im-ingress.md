# Slack 社内1:1の受け口

## できること

管理MCPの `channels.classify` で Slack の1:1を `internal` にし、同じ承認チケットに `employeeId` を指定すると、そのAI社員の受け口を同時に登録します。以後、その1:1で Staffpass Slack アプリが受信した相手の投稿は、メンションなしで指定社員を起こします。

- チャンネルとグループは従来どおり Staffpass Slack アプリへのメンションが必要です。
- 未分類DM、社員未指定、複数候補、停止社員は起動しません。
- すべて `always_human` で、管理エージェントは自己承認できません。
- ダッシュボードに権限編集UIはありません。更新も同じ `channels.classify` を使います。

## 2つの経路

### Path A: Staffpass app DM（Bot message.im）

Slack の `message.im` Bot event は、Staffpass Slack アプリ自身とのDMのみに届きます。利用者が Slack の Staffpass アプリを開き、その Messages / App Home のDMへ投稿する経路です。そのDMの `D...` チャネルを `channels.classify` で社内分類し、起こす社員を1人指定してください。

### Path B: 人対人DM（User-token message.im）

社員の user token で送信している人対人DMに Staffpass アプリは参加できないため、Bot event では見えません。しかし、社員が `im:history` スコープで Slack OAuth 認可を済ませ、Slack アプリ側で「Subscribe to events on behalf of users」の `message.im` を有効にすると、社員のユーザートークン経由で人対人DMのイベントを受信できます。

この Path B のイベントは `authorizations[].is_bot = false` で届きます。受信したら:

1. `authorizations[].user_id` がリンク済み社員の Slack ID と一致するか確認
2. `slack_im_employee_routes` に対象チャネルの internal ルートが存在するか確認
3. ルートの `employee_id` が認可ユーザーの社員と一致するか確認
4. すべて満たせば、その社員を起こす

fail-closed: 1つでも条件を満たさなければ、何もしない（偽イベントや履歴ポーリングは作りません）。

監査ログには `slack.user_token_im_wake` アクションで記録されます。

参考:

- [Slack `message.im` event](https://docs.slack.dev/reference/events/message.im)
- [Slack App Home: Subscribe to `message.im`](https://docs.slack.dev/surfaces/app-home/)
- [Slack Events on behalf of users](https://docs.slack.dev/apis/events-api/request-urls#events-on-behalf-of-users)

## オペレータ設定

### Path A（Bot event）

Staffpass Slack アプリの設定で、次を追加します。

1. **OAuth & Permissions** の Bot Token Scopes に `im:history` があることを確認する。
2. **Event Subscriptions** → **Subscribe to bot events** に `message.im` を追加する。
3. **Save Changes**。Slack が再インストールを求めた場合は、管理者が権限を確認して再インストールする。
4. Request URL は既存の `/api/webhooks/slack/events` のままにする。

### Path B（User-token event）

Staffpass Slack アプリの設定で、次を追加します。

1. **OAuth & Permissions** の User Token Scopes に以下を含める:
   - `chat:write` — 投稿
   - `users:read` — ユーザー情報
   - `channels:read` — チャネル情報
   - `groups:read` — プライベートチャネル情報
   - `im:history` — DM履歴（user-token event 受信に必須）
2. **Event Subscriptions** → **Subscribe to events on behalf of users** に `message.im` を追加する。
3. **Save Changes**。

### 社員の再OAuth

Path B を有効にした後、既存のリンク済み社員の Slack 認可には `im:history` スコープが含まれていません。社員は Staffpass ダッシュボードから Slack 認可を再度行う必要があります。

1. 社員ダッシュボード → Slack 設定 → 「再リンク」または「Slack を再認可」
2. Slack OAuth 画面で新しいスコープ（`im:history`）を確認して承認
3. 認可完了後、その社員の人対人DMで Path B wake が動作

### Socket Mode

Socket Mode は Off のままにしてください。Event Subscriptions の HTTP webhook を使用します。

秘密値はチケット、チャット、PR本文へ貼りません。

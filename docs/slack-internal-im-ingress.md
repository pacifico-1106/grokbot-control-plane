# Slack 社内1:1の受け口

## できること

管理MCPの `channels.classify` で Slack の1:1を `internal` にし、同じ承認チケットに `employeeId` を指定すると、そのAI社員の受け口を同時に登録します。以後、その1:1で Staffpass Slack アプリが受信した相手の投稿は、メンションなしで指定社員を起こします。

- チャンネルとグループは従来どおり Staffpass Slack アプリへのメンションが必要です。
- 未分類DM、社員未指定、複数候補、停止社員は起動しません。
- すべて `always_human` で、管理エージェントは自己承認できません。
- ダッシュボードに権限編集UIはありません。更新も同じ `channels.classify` を使います。

## Slack が見える範囲

Slack の `message.im` は、Staffpass Slack アプリ自身とのDMに届く Bot event です。社員の user token で送信している人対人DMに Staffpass アプリは参加できないため、そのDMは Event Subscriptions では見えません。見えない会話の偽イベントや履歴ポーリングは作りません。

メンション不要の入口には、利用者が Slack の Staffpass アプリを開き、その Messages / App Home のDMへ投稿する Staffpass ネイティブ経路を使います。そのDMの `D...` チャネルを `channels.classify` で社内分類し、起こす社員を1人指定してください。

参考:

- [Slack `message.im` event](https://docs.slack.dev/reference/events/message.im)
- [Slack App Home: Subscribe to `message.im`](https://docs.slack.dev/surfaces/app-home/)

## オペレータ設定

Staffpass Slack アプリの設定で、次を追加します。

1. **OAuth & Permissions** の Bot Token Scopes に `im:history` があることを確認する。
2. **Event Subscriptions** → **Subscribe to bot events** に `message.im` を追加する。
3. **Save Changes**。Slack が再インストールを求めた場合は、管理者が権限を確認して再インストールする。
4. Request URL は既存の `/api/webhooks/slack/events` のままにする。

秘密値はチケット、チャット、PR本文へ貼りません。

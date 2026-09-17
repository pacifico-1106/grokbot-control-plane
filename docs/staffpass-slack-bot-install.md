# Staffpass Slack ワークスペースインストール

このドキュメントは、テナント管理者が Staffpass Slack アプリを自社の Slack ワークスペースにインストールするための OAuth フローを説明します。

## 概要

Staffpass Slack アプリには2つの OAuth フローがあります：

| フロー | 目的 | 誰が実行 | トークン種別 | ルート |
|--------|------|----------|-------------|--------|
| **Bot Install** | Bot をワークスペースに追加 | ワークスペース管理者（1回） | `xoxb-` Bot Token | `/api/slack/bot-install/*` |
| **Employee Authorize** | 社員が個人の Slack を連携 | 各社員 | `xoxp-` User Token | `/api/slack/oauth/*` |

### Install と Authorize の違い

- **Install（インストール）**: Slack アプリをワークスペースに追加する操作。Bot Token (`xoxb-`) が発行され、会社の Bot 名義でメッセージ投稿が可能になる。ワークスペース管理者が1回実行すれば、全社員が利用可能。

- **Authorize（認可）**: 社員が自分の Slack アカウントを Staffpass に連携する操作。User Token (`xoxp-`) が発行され、本人名義での投稿（`posting_as: user`）が可能になる。Path B（人↔人 DM）に必要。

## Bot Install フロー

### 前提条件

- Staffpass 組織のオーナーまたは管理者ロール
- インストール先 Slack ワークスペースの管理者権限

### フロー

```
┌─────────────────────┐     ┌──────────────────────┐     ┌─────────────────────┐
│  Staffpass 設定画面  │────▶│  /api/slack/bot-     │────▶│  Slack OAuth 画面   │
│  「インストール」     │     │  install/start       │     │  Bot scopes 確認    │
└─────────────────────┘     └──────────────────────┘     └─────────────────────┘
                                                                    │
┌─────────────────────┐     ┌──────────────────────┐     ┌─────────┴───────────┐
│  成功/エラー画面     │◀────│  /api/slack/bot-     │◀────│  Slack から callback │
│  「完了」「次のステップ」│     │  install/callback    │     │  code + state       │
└─────────────────────┘     └──────────────────────┘     └─────────────────────┘
```

1. **Start**: ダッシュボード「つながり → チャンネルに書き込む」から「Slack ワークスペースにインストール」をクリック
2. **Redirect**: Slack OAuth 画面にリダイレクト（Bot scopes のみ要求）
3. **Callback**: 認可後、Staffpass に戻り `oauth.v2.access` でトークン交換
4. **Save**: Bot Token を暗号化して conversation adapter に保存
5. **Done**: 成功画面で次のステップを案内

### Bot Token Scopes

インストール時に要求するスコープ：

| スコープ | 用途 |
|----------|------|
| `im:write` | App DM の作成 |
| `app_mentions:read` | @mention イベント受信 |
| `channels:history` | パブリックチャンネル履歴読み取り |
| `groups:history` | プライベートチャンネル履歴読み取り |
| `im:history` | DM 履歴読み取り |
| `chat:write` | メッセージ投稿 |

## セキュリティ

### テナント分離

- `orgId` は署名済み state からのみ取得（cookie の nonce と照合）
- 異なる組織のトークンを誤って書き込むことを防止
- state の有効期限は 10 分

### シークレット管理

- Bot Token は AES-256-GCM で暗号化して保存
- 完全なトークンはログに出力しない（先頭12文字のみ記録）
- 成功画面でトークンを再表示しない

### 監査

- インストール完了時に `conversation.adapter_installed` イベントを記録
- team_id、team_name、token_prefix を metadata に含める

## 運用手順

### Slack アプリ設定（Ops 担当）

**重要**: 新しい redirect_uri を Slack アプリ設定に追加する必要があります。

1. [Slack App 管理画面](https://api.slack.com/apps) にアクセス
2. Staffpass アプリ (App ID: `A0BU8TABSV6`) を選択
3. **OAuth & Permissions** → **Redirect URLs**
4. 以下の URL を追加：
   ```
   https://staffpass.sealith.com/api/slack/bot-install/callback
   ```
5. 既存の employee OAuth callback は残す：
   ```
   https://staffpass.sealith.com/api/slack/oauth/callback
   ```

### Miraishachu e2e チェックリスト

redirect_uri allowlist 更新後：

- [ ] Miraishachu ワークスペース管理者でログイン
- [ ] 「つながり → チャンネルに書き込む」→「Slack ワークスペースにインストール」
- [ ] Slack OAuth 画面で Bot scopes を確認して承認
- [ ] 成功画面でワークスペース名が表示されることを確認
- [ ] 「つながり」画面で adapter が有効になっていることを確認
- [ ] Bot をテストチャンネルに招待 (`/invite @Staffpass`)
- [ ] AI社員から投稿が Bot 名義で送信されることを確認

## トラブルシューティング

### エラー: "認証エラー" (error_state)

原因: セッションタイムアウトまたは state 不一致
対処: もう一度「インストール」からやり直す

### エラー: "トークンタイプエラー" (error_token_type)

原因: Bot Token が取得できなかった（User Token のみ返却された）
対処: Slack アプリの Bot Token Scopes を確認

### エラー: "インストール拒否" (denied)

原因: Slack ワークスペース管理者がインストールを拒否
対処: ワークスペース管理者に連絡してアプリインストールを許可してもらう

## 関連ドキュメント

- [tenant-slack-kickoff-rail.md](./tenant-slack-kickoff-rail.md) - テナント Slack 設定 RAIL
- [slack-internal-im-ingress.md](./slack-internal-im-ingress.md) - Slack DM 受信設定

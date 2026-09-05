# テナント Slack 設定 RAIL

このドキュメントは、Staffpass 管理エージェントがテナントの Slack 設定をガイドするための RAIL（Rails for AI-guided Loops）です。オペレータと管理エージェント向けに、Slack 連携設定の順序と分担を整理します。

## 概要

テナントが Staffpass の Slack 機能を使うには、Slack アプリ側とStaffpass側の両方で設定が必要です。管理MCPはAPI経由の設定を担当し、人間はSlack UI・Vercel UIでしかできない設定を担当します。

**制約**
- `always_human` ツール（hire / classify / parties など）は人の承認が必須
- テナントにSQLマイグレーションを依頼しない（スキーマはオペレータが共有制御面に適用済み）
- 秘密値はチャット・PR本文へ貼らない（org-scoped）

---

## 管理MCPの能力一覧（設定前に提示）

管理エージェントは、設定を提案する前に、利用可能なAdmin MCPツールを簡潔に列挙してください（ダッシュボードUIと異なります）:

| ツール | 用途 | 承認 |
|--------|------|------|
| `employees.issue` | AI社員証の発行 | always_human |
| `link` | 社員証とGrok Bot連携 | always_human |
| `policy.patch` | 権限更新 | always_human |
| `parties.upsert` | 相手台帳登録 | always_human |
| `channels.classify` | チャネル分類 + 1:1 IM受口設定 | always_human |
| `roles.propose` | 職務案の提案 | always_human |
| `setup.slackStatus` | Slack設定診断（read-only） | なし |

> **注意**: ダッシュボードUIは管理MCPの完全な代替ではありません。特に `channels.classify` の `employeeId` 指定やIM受口設定はAdmin MCPのみで行えます。

---

## 設定ステップ（順序重要）

### ステップ1: Slack アプリ基本設定（人間がSlack UIで実施）

Slack API サイトで Staffpass Slack アプリを設定します。

#### 1-1. Socket Mode を OFF に設定

**必須**: Socket Mode が ON だと Event Subscriptions の Request URL にイベントが届きません。

1. [api.slack.com/apps](https://api.slack.com/apps) → 対象アプリ選択
2. **Settings → Socket Mode**
3. **Enable Socket Mode** を **OFF**

**症状（Socket Mode ON のまま）**:
- Events が `https://staffpass.sealith.com/api/webhooks/slack/events` に届かない
- メンション・DMに反応しない

#### 1-2. Event Subscriptions 設定

1. **Features → Event Subscriptions**
2. **Enable Events** を ON
3. **Request URL**: `https://staffpass.sealith.com/api/webhooks/slack/events`
   - Slack が `challenge` を送り、Staffpass が `challenge` を返して検証完了
4. **Subscribe to bot events** に追加:
   - `message.im`（必須: App Home DM受信）
   - `app_mention`（必要に応じて: チャンネルでのメンション）

**症状（Request URL 未設定・誤り）**:
- `url_verification` 失敗でイベント受信できない
- Vercel `/api/webhooks/slack/events` のログにリクエストが来ない

#### 1-3. Bot Token Scopes 設定

1. **Features → OAuth & Permissions**
2. **Bot Token Scopes** に追加:
   - `im:history` - DM履歴の読み取り
   - `chat:write` - メッセージ投稿
   - `im:write` - DMの開始/書き込み

**重要**: スコープ変更後は **Reinstall to Workspace** が必要です。

**症状（スコープ不足）**:
- `missing_scope` エラー
- Bot DM送信失敗

#### 1-4. App Home Messages Tab 有効化

1. **Features → App Home**
2. **Messages Tab** セクション
3. **Allow users to send Slash commands and messages from the messages tab** を ON
   - `messages_tab_read_only_enabled: false` にする

**症状（Messages Tab 無効）**:
- ユーザーがアプリDMを開いてもメッセージ入力欄が出ない
- `message.im` イベントが届かない

### ステップ2: Bot Token をStaffpassへ登録（人間がダッシュボードで実施）

1. Slack アプリの **OAuth & Permissions** → **Bot User OAuth Token** (`xoxb-...`) をコピー
2. Staffpassダッシュボード → **設定 → 会話アダプタ** → **Slack**
3. **Bot Token** 欄に貼り付けて保存

> アダプタトークンは環境変数 `SLACK_BOT_TOKEN` より優先されます。新しいトークンでの再設定が反映されない場合は、アダプタ設定を更新してください。

**症状（Token未登録・期限切れ）**:
- `auth.test` 失敗
- 投稿時に `invalid_auth` エラー

### ステップ3: 設定診断（管理エージェントがMCPで実施）

```
tools/call: setup.slackStatus
```

診断結果の例:
```json
{
  "ok": true,
  "botTokenPresent": true,
  "authTest": { "ok": true, "bot_id": "B...", "user_id": "U..." },
  "adapterEnabled": true,
  "imRoutesCount": 0,
  "nextStepJa": "チャネル分類を設定してください。内部1:1には channels.classify で employeeId を指定します。"
}
```

`nextStepJa` フィールドに次の人間アクションが示されます。

### ステップ4: チャネル分類（管理エージェントがMCPで実施）

内部1:1 DM（Staffpassアプリへの直接DM）を設定します。

```
tools/call: channels.classify
arguments: {
  "externalId": "D...",           // Slack DM チャネルID
  "surface": "slack",
  "classification": "internal",
  "employeeId": "emp_xxx",        // ★ 重要: この社員のメンション不要受口を有効化
  "slackTeamId": "T...",          // ワークスペースID（推奨）
  "jobId": "job_xxx"
}
```

**`employeeId` の役割**:
- 指定すると、そのDMへの人間の投稿がメンションなしで指定社員を起こす
- 省略すると、IM受口が削除される（fail-closed）
- チャンネル・グループは従来どおりメンションが必要

**症状（employeeId 省略）**:
- DM が `internal` でも AI社員が起動しない
- `channels.classify` の結果に `employeeId: null`

### ステップ5: 投稿設定の確認（パス別）

Slack の `posting_as` 設定は**通信パスによって異なります**:

| パス | 用途 | posting_as | 理由 |
|------|------|------------|------|
| **パスA: App DM** | 人 ↔ Staffpassアプリ DM | `bot` | User token では Bot DM を見られない |
| **パスB: 人↔人DM** | 人の代理で人へ送信（将来） | `user` | 人対人 DM に Bot は参加できない |

#### パスA: App DM（このRAILの対象）

App DM（Staffpassアプリへの直接DM）への返信には `posting_as: bot` が**必須**です。

社員のSlackポスティング設定:
- ダッシュボード → 社員 → Slack Identity → **投稿者** を `Bot` に設定
- または `policy.patch` で `postingAs: "bot"` を指定

**症状（posting_as: user のまま）**:
- Bot DM への返信が見えない
- `channel_not_found` エラー（user token からは Bot DM が見えない）

#### パスB: 人↔人DM（将来対応予定）

人の代理で別の人に DM を送る場合は `posting_as: user` を使用します。Slack Bot は人対人 DM に参加できないため、User token での投稿が必要です。

> **注意**: すべての Slack mouth が `bot` である必要はありません。用途に応じて設定してください。

---

## トラブルシューティング

### イベントが届かない

| 確認項目 | 期待値 | 症状 |
|----------|--------|------|
| Socket Mode | OFF | Events が HTTPS endpoint に来ない |
| Request URL | `https://staffpass.sealith.com/api/webhooks/slack/events` | 検証失敗 |
| Bot events | `message.im` 含む | DM 未受信 |
| SLACK_SIGNING_SECRET | 設定済み | 署名検証失敗 (401) |

### DM送信できない

| 確認項目 | 期待値 | 症状 |
|----------|--------|------|
| Bot Token Scopes | `im:history`, `chat:write`, `im:write` | `missing_scope` |
| アプリ再インストール | スコープ変更後に実施 | スコープが反映されない |
| Bot Token 登録 | ダッシュボードまたは env | `invalid_auth` |
| posting_as（パスA） | `bot` | Bot DM に返信できない（App DM の場合） |

### AI社員が起動しない

| 確認項目 | 期待値 | 症状 |
|----------|--------|------|
| channels.classify employeeId | 社員ID指定 | IM route 未登録 |
| チャネル分類 | `internal` | unknown のまま |
| 社員ステータス | `active` | 停止社員は起動しない |
| App Home Messages Tab | 有効 | メッセージ入力欄なし |

---

## 典型的な設定フロー

```
管理エージェント                       人間
     │                                   │
     │ 1. 管理MCP能力を列挙              │
     │ ←───────────────────────────────  │
     │                                   │
     │ 2. setup.slackStatus 実行         │
     │    → nextStepJa を確認            │
     │                                   │
     │    Socket Mode OFF 指示 ─────────→│ Slack UI で設定
     │                                   │
     │    Event Subscriptions 指示 ────→ │ Slack UI で設定
     │                                   │
     │    Bot Scopes 指示 ─────────────→ │ Slack UI で設定
     │                                   │ → Reinstall
     │                                   │
     │    Bot Token 登録指示 ──────────→ │ ダッシュボードで設定
     │                                   │
     │ 3. setup.slackStatus で確認       │
     │                                   │
     │ 4. channels.classify 呼び出し     │
     │    (employeeId 指定)              │
     │                                   │
     │ ←─────────────────────────────────│ 承認タップ
     │                                   │
     │ 5. 完了確認                        │
     └───────────────────────────────────┘
```

---

## 関連ドキュメント

- [slack-internal-im-ingress.md](./slack-internal-im-ingress.md) - 社内1:1の受け口技術詳細
- [mcp.md](./mcp.md) - MCP全般
- [agent-credential-guide.md](./agent-credential-guide.md) - 社員証ガイド

---

## 2026-09-05 パスA本番からの学習事項

このRAILは以下の実運用経験を反映しています:

1. **Socket Mode OFF 必須** - ON のままだと Events が HTTPS endpoint に届かない
2. **Bot events: `message.im`** - App Home DM 受信に必須。`app_mention` は追加で必要に応じて
3. **Bot scopes: `im:history`, `chat:write`, `im:write`** - スコープ変更後は再インストール必須
4. **Bot Token 二重登録** - ダッシュボード「チャンネルに書き込む」(アダプタ) AND 環境変数 `SLACK_BOT_TOKEN`。アダプタトークンが優先
5. **App Home Messages Tab** - `messages_tab_read_only_enabled: false` でないとユーザーがDMを送れない
6. **channels.classify + employeeId** - 内部1:1の `employeeId` 指定で IM route をインストール。省略すると fail-closed で削除
7. **posting_as: bot（パスA App DM）** - Bot DM への返信には必須。User token では Bot DM を見られない。※パスB（人↔人DM）は `user` を使用
8. **SQLマイグレーションはオペレータ専用** - テナントにSQL実行を依頼しない。スキーマは共有制御面に適用済み

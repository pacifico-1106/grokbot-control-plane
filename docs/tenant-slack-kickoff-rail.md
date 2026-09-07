# テナント Slack 設定 RAIL

このドキュメントは、Staffpass 管理エージェントがテナントの Slack 設定をガイドするための RAIL（Rails for AI-guided Loops）です。オペレータと管理エージェント向けに、Slack 連携設定の順序と分担を整理します。

## 概要

テナントが Staffpass の Slack 機能を使うには、Slack アプリ側とStaffpass側の両方で設定が必要です。管理MCPはAPI経由の設定を担当し、人間はSlack UI・ダッシュボードでしかできない設定を担当します。

**制約**
- `always_human` ツール（hire / classify / parties など）は人の承認が必須
- **SQLマイグレーションはオペレータ専用** — テナントにSQL実行を依頼しない。スキーマは共有制御面に適用済み
- 秘密値はチャット・PR本文へ貼らない（org-scoped）

---

## パス定義（Path A / Path B）

Staffpass は2つの Slack DM パスをサポートします：

### パス A: Staffpass アプリ DM（Bot Events）

人間が Staffpass アプリと直接 DM するパス。

| 項目 | 値 |
|------|-----|
| **用途** | 人 ↔ Staffpass アプリ DM |
| **Events** | Bot events: `message.im` |
| **posting_as** | `bot` |
| **Token** | Bot Token (`xoxb-...`) |
| **受口** | `channels.classify` + `employeeId` で IM route 登録 |

### パス B: 人↔人 DM（User Token Events）

人間が別の人間と DM し、社員の User Token でそのイベントを受信するパス。

| 項目 | 値 |
|------|-----|
| **用途** | 人 ↔ 人 DM（社員が人間の代理で参加） |
| **Events** | **Subscribe to events on behalf of users**: `message.im` |
| **posting_as** | `user` |
| **Token** | User Token (`xoxp-...`) — 社員が Slack 再 OAuth で取得 |
| **User Token Scopes** | `im:history` |
| **受口** | `channels.classify` + `employeeId` で IM route 登録 |

**重要**: Bot は人↔人 DM に参加できないため、パス B では User Token と `posting_as: user` が必須。

---

## Bot vs 個人（user）の比較

管理MCPが社員設定をガイドする際に、以下の比較を提示してください:

**Bot（推奨: アプリDM向け社員）**
- ✓ 会社の窓口として一貫
- ✓ アプリDM口と相性が良い
- ✓ 人のSlack退席に依存しにくい
- △ 個人っぽさは出ない
- △ チャンネルで「人」として見せたいときは弱い

**個人 / user（推奨: チャネル・Connect・人対人DM向け）**
- ✓ 社員名義で信頼・責任が明確
- ✓ 既存DM/チャンネルの人対人運用と一致
- △ 本人OAuth・トークン寿命・退席に依存
- △ アプリDMではBotトークンでないと投稿できない制約あり

**推奨デフォルト**: アプリDM向け社員は `bot` / チャネル・Connect・人対人DM向けは `user`。

---

## 共通設定事項

### Socket Mode と Request URL

| 項目 | 値 |
|------|-----|
| **Socket Mode** | **OFF**（必須） |
| **Request URL** | `https://staffpass.sealith.com/api/webhooks/slack/events` |

Socket Mode が ON だと Events が HTTPS endpoint に届きません。

---

## 管理MCPの能力一覧（設定前に提示）

管理エージェントは、設定を提案する前に、利用可能なAdmin MCPツールを簡潔に列挙してください（ダッシュボードUIと異なります）:

| ツール | 用途 | 承認 |
|--------|------|------|
| `setup.slackStatus` | **Slack設定診断（read-only、最初のステップ）** | なし |
| `employees.issue` | AI社員証の発行 | always_human |
| `link` | 社員証とGrok Bot連携 | always_human |
| `policy.patch` | 権限更新 | always_human |
| `parties.upsert` | 相手台帳登録 | always_human |
| `channels.classify` | チャネル分類 + 1:1 IM受口設定 | always_human |
| `roles.propose` | 職務案の提案 | always_human |
| `ingressHandoff.get` | **受信ハンドオフポリシー読み取り（read-only、AI社員ごとにemployeeId指定可）** | なし |
| `ingressHandoff.patch` | 受信ハンドオフポリシー更新（AI社員ごとにemployeeId指定可、clearOverrideで継承） | always_human |

> **Note**: Admin MCP に新しいツールがデプロイされた場合、MCP コネクタを再起動/再接続してください（`capabilities.tools.listChanged: true` ですが、Streamable HTTP では通知 push が制限されます）。

### `setup.slackStatus` — 最初のステップ

`setup.slackStatus` は **read-only** の診断ツールで、承認なしで実行できます。`nextStepJa` フィールドに次の人間アクションが示されます（posting_as の pros/cons 推奨を含む）。Slack 設定の最初のステップとして常にこれを呼び出してください。

### `channels.classify` と `employeeId`

> **重要**: ダッシュボードUIは管理MCPの完全な代替ではありません。特に `channels.classify` の `employeeId` 指定やIM受口設定は **Admin MCP のみ** で行えます。
>
> - `employeeId` を指定すると、そのDMへの人間の投稿がメンションなしで指定社員を起こす（IM route インストール）
> - `employeeId` を省略すると、IM受口が削除される（**fail-closed**）
> - チャンネル・グループは従来どおりメンションが必要

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
4. **Subscribe to bot events** に追加（パス A）:
   - `message.im`（必須: App Home DM受信）
   - `app_mention`（必要に応じて: チャンネルでのメンション）
5. **Subscribe to events on behalf of users** に追加（パス B のみ）:
   - `message.im`（人↔人 DM で User Token イベント受信）

**パス B の注意**: 「Subscribe to events on behalf of users」は「Subscribe to bot events」とは別のセクションです。Bot events だけ設定しても User Token イベントは届きません。

**症状（Request URL 未設定・誤り）**:
- `url_verification` 失敗でイベント受信できない
- Vercel `/api/webhooks/slack/events` のログにリクエストが来ない

#### 1-3. Bot Token Scopes 設定（パス A）

1. **Features → OAuth & Permissions**
2. **Bot Token Scopes** に追加:
   - `im:history` - DM履歴の読み取り
   - `chat:write` - メッセージ投稿
   - `im:write` - DMの開始/書き込み

**重要**: スコープ変更後は **Reinstall to Workspace** が必要です。

**症状（スコープ不足）**:
- `missing_scope` エラー
- Bot DM送信失敗

#### 1-4. User Token Scopes 設定（パス B のみ）

1. **Features → OAuth & Permissions**
2. **User Token Scopes** に追加:
   - `im:history` - DM履歴の読み取り（User Token イベント受信に必須）

**重要**: User Token Scopes を追加後、社員が Slack で再 OAuth を行う必要があります。これにより `xoxp-...` トークンが取得され、人↔人 DM イベントを受信できます。

#### 1-5. App Home Messages Tab 有効化（パス A）

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

内部1:1 DM（パス A: Staffpassアプリへの直接DM、パス B: 人↔人DM）を設定します。

```
tools/call: channels.classify
arguments: {
  "externalId": "D...",           // Slack DM チャネルID
  "surface": "slack",
  "classification": "internal",
  "employeeId": "emp_xxx",        // ★ 必須: この社員のメンション不要受口を有効化
  "slackTeamId": "T...",          // ワークスペースID（推奨）
  "jobId": "job_xxx"
}
```

**症状（employeeId 省略）**:
- DM が `internal` でも AI社員が起動しない（claim-without-wake）
- `channels.classify` の結果に `employeeId: null`

### ステップ5: 投稿設定の確認（パス別）

Slack の `posting_as` 設定は**通信パスによって異なります**:

| パス | 用途 | posting_as | 理由 |
|------|------|------------|------|
| **パスA: App DM** | 人 ↔ Staffpassアプリ DM | `bot` | User token では Bot DM を見られない |
| **パスB: 人↔人1:1 DM** | 人の代理で人へ送信 | `user` | 人対人 DM に Bot は参加できない |
| **チャネル / Connect** | メンション起動、人として返信 | `user` | 人間アイデンティティで返信 |

**メンション不要 wake は個別DM（1:1）のみ**:
- パスA（App DM）: メンション不要（`employeeId` 指定で wake）
- パスB（人↔人1:1 DM）: メンション不要（`employeeId` 指定で wake）
- チャネル / Slack Connect: **メンション必須**（`app_mention` または紐付けユーザーへのメンション）

#### パスA: App DM

App DM（Staffpassアプリへの直接DM）への返信には `posting_as: bot` が**必須**です。

社員のSlackポスティング設定:
- ダッシュボード → 社員 → Slack Identity → **投稿者** を `Bot` に設定
- または `policy.patch` で `postingAs: "bot"` を指定

**症状（posting_as: user のまま）**:
- Bot DM への返信が見えない
- `channel_not_found` エラー（user token からは Bot DM が見えない）

#### パスB: 人↔人1:1 DM（本番稼働中）

人の代理で別の人に DM を送る場合は `posting_as: user` を使用します。Slack Bot は人対人 DM に参加できないため、User token での投稿が必要です。D0BSWG1804F スタイルで本番稼働中。

**パスB 設定手順**:
1. **User Token Scopes** に `im:history` を追加（OAuth & Permissions）
2. **Subscribe to events on behalf of users** に `message.im` を追加（Event Subscriptions）
3. 社員が Staffpass ダッシュボードから **Slack 再認可**（新スコープ付与）
4. 社員バッジの `posting_as` を `user` に設定
5. `channels.classify` で人↔人DMを `internal` 分類、`employeeId` 指定

#### チャネル / Slack Connect

チャネルと Slack Connect 共有チャネルでは:
- **wake**: メンション必須（`app_mention` または紐付け社員ユーザーへのメンション）
- **返信**: `posting_as: user`（人間アイデンティティ）
- Bot posting mouth は App DM（パスA）のみ

**Connect / shared_external の注意点**:
- `channels.classify` で `shared_external` 分類が必要（egress 制御）
- **オーディエンス行列**が承認要否を決定 — 外部の人がメンションしてくることもある
- 「メンション相手＝承認者」ではない。承認要否は**相手方（parties / audience / チャネル分類）**で判断

> **注意**: すべての Slack mouth が `bot` である必要はありません。用途に応じて設定してください。

---

## トラブルシューティング

### 症状表（クイックリファレンス）

| 症状 | 原因 | パス | 修正 |
|------|------|------|------|
| DM 投稿が見えない（claim-without-wake） | IM route 未登録 | A/B | `channels.classify` で `employeeId` 指定 |
| `missing_scope` エラー | User/Bot Token スコープ不足 | A/B | スコープ追加 → 再インストール |
| App DM で `channel_not_found` | `posting_as: user` になっている | A | `posting_as: bot` に変更 |
| 人↔人 DM で `channel_not_found` | `posting_as: bot` になっている | B | `posting_as: user` に変更 |
| パス B イベントが届かない | Bot events のみ設定 | B | **on behalf of users** で `message.im` 追加 |
| User Token イベントで wake しない | 社員の Slack 再 OAuth 未完了 | B | 社員に `im:history` スコープで再 OAuth 依頼 |

### イベントが届かない

| 確認項目 | 期待値 | 症状 |
|----------|--------|------|
| Socket Mode | OFF | Events が HTTPS endpoint に来ない |
| Request URL | `https://staffpass.sealith.com/api/webhooks/slack/events` | 検証失敗 |
| Bot events | `message.im` 含む（パス A） | App DM 未受信 |
| Subscribe to events on behalf of users | `message.im` 含む（パス B） | 人↔人 DM 未受信 |
| SLACK_SIGNING_SECRET | 設定済み | 署名検証失敗 (401) |

### DM送信できない

| 確認項目 | 期待値 | 症状 |
|----------|--------|------|
| Bot Token Scopes | `im:history`, `chat:write`, `im:write` | `missing_scope` |
| User Token Scopes（パス B） | `im:history` | `missing_scope` |
| アプリ再インストール | スコープ変更後に実施 | スコープが反映されない |
| Bot Token 登録 | ダッシュボードまたは env | `invalid_auth` |
| posting_as（パスA App DM） | `bot` | Bot DM に返信できない |
| posting_as（パスB 人↔人DM） | `user` | 人 DM に返信できない |

### AI社員が起動しない

| 確認項目 | 期待値 | 症状 |
|----------|--------|------|
| channels.classify employeeId | 社員ID指定 | IM route 未登録 |
| チャネル分類 | `internal` | unknown のまま |
| 社員ステータス | `active` | 停止社員は起動しない |
| App Home Messages Tab | 有効 | メッセージ入力欄なし |
| 社員 Slack 再 OAuth（パス B） | `im:history` スコープで完了 | User Token イベント未受信 |

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
- [egress-policy.md](./egress-policy.md) - 相手×情報区分の出域制御（dual-audience 詳細）
- [staffpass-situation-policy-catalog.md](./staffpass-situation-policy-catalog.md) - シチュエーション／補足ルール カタログ（scheduling backlog / product locks の正本）

---

## プロダクトロック・ガイダンス（オペレータ向け）

管理エージェントはテナントに以下の製品ロックと進捗を説明してください。

### 1. 混在チャネル dual-audience（メンバーレベル解決）

混在チャネル（`shared_external` / Slack Connect / ゲスト招待）では、チャネル単位ではなく **宛先パーティごと** に audience を解決します。

| スライス | ステータス | 内容 |
|----------|------------|------|
| **S1** | ✅ 本番稼働（PR #34 / main ~06feb7f） | `resolveAudience` がパーティごとの `dualAudience` を返却（`internalFacing` / `externalFacing`）。チャネル単位の `effectiveAudience` は後方互換で external（floor） |
| **S2** | ✅ 本番稼働（PR #36 / main ~aea4162） | 二重マトリクス評価 `dualEgress`（`internalDecision` / `externalDecision`）。チャネル投稿は external-safe を維持 |
| **S3** | ✅ 本番稼働（F1 口ルーティング / PR #40 マージ済み） | `evaluateMouthRouting` で分離配信を決定。チャネル投稿 = external-safe、内部詳細 = DM / 限定スレッドへ。外部パーティ存在時は fail-closed で内部 hold |

**例**: `#stablo_tokyo307` Connect チャネル
- Yasaka 社員 `U_YAMADA` → `partySignals[{internal, resolved}]`
- Uehara/Stablo 外部ゲスト → `partySignals[{external, resolved}]` または `{unknown, !resolved}`
- `dualAudience.hasInternalParty = true`, `hasExternalParty = true`

**運用ガイダンス（S4スタイル）**:
- **混在chは相手台帳必須**: `parties.upsert` でメンバーの audience（internal / external）を登録
- 未登録パーティは fail-closed で external 扱い
- メンションは依然としてチャネル / Connect の wake に必要（DM の `employeeId` 指定とは別）
- **承認要否 ≠ メンション相手**: 承認判定は audience × 情報区分マトリクス。メンションした人が承認者になるわけではない

### 2. スケジューリング / scheduling.policy（A1 本番稼働）

> **ステータス**: ✅ 本番稼働（PR #39 マージ済み）

カレンダー連携の自動化フローです。

**Admin MCP ツール**:
- `schedulingPolicy.get` — 読み取り専用、承認不要
- `schedulingPolicy.patch` — `always_human`、高リスク設定には承諾必須

**想定フロー**:
1. `calendar.freebusy` で空き時間を取得
2. （任意）manager / org ポリシーで候補をフィルタ
3. 対外提案には **最終候補のみ** を表示（内部の全空き枠は見せない）
4. `calendar.confirm` で予定を確定

**オンラインミーティング設定**:
- `online_calendar_target`: カレンダープロバイダ（Google / Outlook 等）
- `online_video_tool`: ビデオツール（Zoom / Meet / Teams 等）— 許可リスト + デフォルト
- 未定義または許可外は **fail-closed**（対外には送信しない）

**確定能力の上限**:
- 製品の強制上限は **フル自動確定を許可** する設計（テナント ToS で自己責任）
- `always_human` を強制する製品ハードシーリングは**ありません**
- デフォルトプリセットは cautious（人間承認推奨）に留まる可能性あり

**高リスク設定の警告**:
以下の設定は有効化前に **明示的なテナント承諾** が必要です（informed consent + 監査記録）。サイレント有効化は禁止。

| 高リスク設定 | 警告 |
|--------------|------|
| フル自動確定（`calendar.confirm` 人間承認なし） | 誤送信・ダブルブッキングのリスク |
| 外部/クライアント宛の自動送信 | audience 判定ミスで機密漏洩 |
| ポリシーなしの自動化 | ガードレールなしの野良運用 |
| 過度に広い egress 許可 | 情報区分を無視した漏洩 |

詳細: [scheduling-policy.md](./scheduling-policy.md)

### 3. 複数の通信口（会話アダプタ vs 承認通知チャネル）

Staffpass は **会話アダプタ**（AI社員が相手と話す口）と **承認通知チャネル**（人間へ承認を届ける口）を **混ぜません**。

| 面 | 役割 | 例 |
|----|------|----|
| 会話アダプタ | AI社員 ↔ 相手 の情報送受信 | `comm.send` / `comm.reply` / `slack.post` |
| 承認通知チャネル | 人間 ← 承認依頼 の通知 | Telegram / LINE notify |

**会話アダプタのロードマップ（SME）**:
1. **Slack** — 本番稼働中（パスA・B）
2. **LINE** — 予約中（Jurin 電話含む）
3. **Chatwork** — ConversationSurface 未実装
4. **Messenger** — ConversationSurface 未実装

**現在の稼働状況**:
- 会話の本番: 主に **Slack**
- 承認通知: **Telegram**（LINE notify も存在）
- LINE / Jurin の会話アダプタ: 予約（未稼働）
- Chatwork / Messenger: ConversationSurface にまだ載っていない

**重要**: 会話アダプタを承認通知チャネルとして使わないでください。逆も同様。

### 4. F1 口ルーティング（mouth routing）

> **ステータス**: ✅ 本番稼働（PR #40 マージ済み）。S1+S2+S3 dual-audience 本番。A1 scheduling.policy 本番。

F1 は Staffpass シチュエーションポリシーパック族の次の箱です。dual-gate S3 と multi-mouth priority を提供します。

#### 4-1. dual-gate S3（分離配信）

`dualEgress` で `internalDecision` と `externalDecision` が異なる場合、配信先を分岐します：

| 配信先 | 内容 | 例 |
|--------|------|----|
| **チャネル投稿** | external-safe / `effectiveDecision` のコンテンツのみ | 公開可能な要約・確認メッセージ |
| **内部向け詳細** | 解決済み内部パーティの **DM** へ配信 | 機密詳細・社内向け補足 |

**fail-closed**: 未知 / 外部混在で解決不能な内部パーティ → 内部漏洩なし（hold / deny）

#### 4-2. multi-mouth priority（口の優先順位）

複数の会話アダプタがある場合の既定優先順位：

```
Slack → LINE → (Chatwork / Messenger: 予約)
```

- `resolvePreferredMouth()` で最優先の利用可能 surface を選択
- ポリシーでルールごとの `mouthPriority` オーバーライドをサポート
- **会話口と承認通知口は別**（混ぜない方針を維持）

#### 4-3. mouth-routing policy の設定ガイダンス

管理エージェントは以下の順序でテナントをガイドしてください：

1. **相手台帳の整備** — 混在chで分離配信を使うには `parties.upsert` でメンバーの audience（internal / external）を登録
2. **チャネル分類** — `channels.classify` で `mixed=true`（shared_external / Connect / ゲスト招待）を設定
3. **口ルーティングポリシー確認** — 組織または AI社員ごとの `mouthRouting.policy` を確認

**必須条件（分離配信）**:
- 混在chは相手台帳必須（`parties.upsert`）
- 未登録パーティは fail-closed external
- DM 配信先は解決済み internal パーティのみ

**Admin MCP ツール**:
- `mouthRoutingPolicy.get` — 読み取り専用、承認不要（将来）
- `mouthRoutingPolicy.patch` — `always_human`、人間承認が必要（将来）

#### 4-4. ルールパック族の接続（A1 → F1 → B2）

| ID | 名前 | ステータス | 内容 |
|----|------|-----------|------|
| **A1** | scheduling.policy | ✅ 本番稼働 | 日程調整ルールパック（場所親和・移動バッファ・オンライン設定・confirm自動化レベル）|
| **F1** | mouth routing | ✅ 本番稼働 | 口ルーティング（分離配信・優先順位・fail-closed）|
| **B2** | Slack/LINE返信 | 次箱 | スレッド規則・営業時間制御など |

詳細: [scheduling-policy.md](./scheduling-policy.md) / [staffpass-situation-policy-catalog.md](./staffpass-situation-policy-catalog.md)

### 5. F6 アイデンティティ開示（identity disclosure）— スタブ

> **ステータス**: 予定（F1 の後）。本 RAIL では配置のみ記載。

F6 はエージェント自身に関する Q&A 応答を制御します（「あなたは誰？」「どこの会社？」など）。

- **F1 と F6 は別ポリシー族**: F1 = コンテンツの配信先制御、F6 = エージェント自己紹介の制御
- **配置**: `disclosure.policy`（予定）
- **詳細エンジン**: 本 PR の範囲外（スタブのみ）

### 6. 製品コピー / 本分

Staffpass の本分:

> **与えられた権限の範囲内で行動し、範囲外はブロックする。自動行為は consent / tool / destination を監査に残す。**

**危険な組み合わせの扱い**:
- 製品は能力を hard-stop **しません**
- 危険な組み合わせには **承諾ログ** を要求します（組み合わせ警告は承諾のみ）
- 例: 高リスク設定の有効化 → 警告 + 明示的テナント承諾 → 監査記録

---

## 2026-09-05/06 パスA+B本番からの学習事項（Yasaka/Ando locks）

このRAILは以下の実運用経験を反映しています:

### 共通

1. **Socket Mode OFF 必須** - ON のままだと Events が HTTPS endpoint に届かない
2. **Request URL**: `https://staffpass.sealith.com/api/webhooks/slack/events`
3. **channels.classify + employeeId** - 内部1:1の `employeeId` 指定で IM route をインストール。省略すると fail-closed で削除
4. **setup.slackStatus は read-only 最初のステップ** - `nextStepJa` で次の人間アクションを確認（posting_as pros/cons 推奨を含む）
5. **SQLマイグレーションはオペレータ専用** - テナントにSQL実行を依頼しない。スキーマは共有制御面に適用済み

### パス A: Staffpass アプリ DM

6. **Bot events: `message.im`** - App Home DM 受信に必須。`app_mention` は追加で必要に応じて
7. **Bot scopes: `im:history`, `chat:write`, `im:write`** - スコープ変更後は再インストール必須
8. **Bot Token 二重登録** - ダッシュボード「チャンネルに書き込む」(アダプタ) AND 環境変数 `SLACK_BOT_TOKEN`。アダプタトークンが優先
9. **App Home Messages Tab** - `messages_tab_read_only_enabled: false` でないとユーザーがDMを送れない
10. **posting_as: bot** - Bot DM への返信には必須。User token では Bot DM を見られない

### パス B: 人↔人 DM（User Token Events） — 本番稼働中

11. **Subscribe to events on behalf of users: `message.im`** - Bot events とは別セクション。Bot events だけでは User Token イベントは届かない
12. **User Token Scopes: `im:history`** - 社員が Slack 再 OAuth で取得する User Token に必要
13. **社員 Slack 再 OAuth** - User Token Scopes 追加後、社員が OAuth フローを再実行して `xoxp-...` を取得
14. **posting_as: user** - Bot は人↔人 DM に参加できない。User Token での投稿が必須

### チャネル / Slack Connect

15. **メンション必須** - チャネルと Connect はメンション wake のみ（`app_mention` / 紐付けユーザーメンション）
16. **shared_external 分類** - Connect チャネルは egress 制御のため分類必須
17. **オーディエンス行列** - 承認要否は parties / audience / チャネル分類で決定。「メンション相手＝承認者」ではない

### posting_as 推奨（Bot vs 個人）

18. **Bot（アプリDM向け）**: 会社窓口として一貫・アプリDM口と相性良好・退席非依存
19. **個人/user（チャネル・Connect・人対人DM向け）**: 社員名義で信頼明確・人対人運用一致・OAuth依存
20. **ダッシュボード社員詳細 / 雇用フロー / PolicyPreview** で同じ比較表を表示

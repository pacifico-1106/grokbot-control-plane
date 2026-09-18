# P0: AI社員の個人メンション起こし

**ステータス:** 設計スパイク  
**日付:** 2026-09-19  
**担当:** Ando model lock (Ando/user 2026-09-19)  
**優先度:** P0（短期実装必須）

---

## 1. 課題と望ましい UX

### 現状の制約

Staffpass の Slack ingress は現在、以下のパスで AI社員を起こせる:

| パス | 対象 | Wake 方法 | 制約 |
|------|------|-----------|------|
| **Path A** | Staffpass app DM | Bot `message.im` event | App DM 限定 |
| **Path B** | 人対人 1:1 DM | User-token `message.im` event | DM 限定、`im:history` スコープ必須 |
| **チャネル** | 社内チャネル | `app_mention` event | Staffpass Bot がチャネルに存在必須 |

### 問題

外部 Slack Connect チャネル（例: `#stablo_tokyo307`）で、相手方ワークスペース（例: Stablo 社）のメンバーが AI社員 `@tando` をメンションしても:

1. **`app_mention` が届かない** — Staffpass Bot は自社 WS にのみインストール。相手方 WS にアプリ配布は **Ando model で禁止**。
2. **User-token channel events が未実装** — 現在の Path B は `message.im`（DM）のみ。`message.channels` / `message.groups` の user-token 購読がない。

結果、Connect チャネルで `@tando` とメンションしても AI社員は起きない。

### 望ましい UX

```
[#stablo_tokyo307 — Slack Connect チャネル]

Uehara (Stablo): @tando 来週の打ち合わせ、火曜と木曜どちらが都合いいですか？

[→ Staffpass が Tando 社員を起こす]
[→ Tando が人間アイデンティティで返信]

Tando (AI): 火曜日の午後2時から空いています。ご都合いかがでしょうか。
```

**必須要件:**
- 相手方 WS に Staffpass アプリを配布 **しない**
- AI社員は人間アイデンティティ（`posting_as=user`）で返信
- egress は既存の dual-gate / external-safe を維持

---

## 2. 現行 G7 Bot Events パスが Ando model を満たせない理由

### Ando model の定義

> **internal = Bot**, **external = user account**  
> (partner workspace must NOT require Staffpass app install)

### G7 Bot Events の限界

| 要件 | G7 Bot Events | 判定 |
|------|---------------|------|
| 社内チャネル wake | `app_mention` で Bot mention → ✓ | OK |
| 社内 DM wake | Bot `message.im` または User-token `message.im` → ✓ | OK |
| **外部 Connect wake** | `app_mention` には **相手方 WS に Bot 必要** | NG |

Bot を相手方 WS に配布すると:
- 相手方管理者の承認が必要
- 相手方にアプリ管理負担が発生
- Staffpass の「境界は自社で完結」ポリシーに反する

**結論:** G7 Bot+Connect path は **短期 smoke only** であり、長期の external mouth には使えない。

---

## 3. オプション・スパイク

### Option A: User-token Events / Socket Mode for linked employee Slack identity

社員の Slack OAuth トークン（xoxp）を使い、Events API の「Subscribe to events on behalf of users」で `message.channels` / `message.groups` を購読。

**メリット:**
- Bot 不要で任意のチャネル（Connect 含む）のイベントを受信可能
- 人間アイデンティティと完全一致（購読者 = 投稿者）
- Slack 公式の user-token events 機構を活用

**リスク / 課題:**

| 課題 | 詳細 | 緩和策 |
|------|------|--------|
| スコープ拡大 | `channels:history`, `groups:history` が user scope に必要 | 社員 OAuth 再フローで取得。既存 `im:history` と同じパターン |
| Connect team_id 解決 | `message.channels` の `team_id` は **発言者の所属チーム**、購読者のチームではない | `authorizations[].team_id` で購読者チーム特定。チャネルの shared 状態は別途解決 |
| 自己ループ防止 | AI が投稿 → user-token event が自社にも届く → 再 wake | `event.user === authorizations[].user_id` ならスキップ（既存 im_self_skip と同様） |
| レート制限 | Events API の user-token quota（詳細未確定） | 単一 Request URL で集約。per-employee socket は不要 |
| クレデンシャル管理 | user token を長期保持。漏洩リスク | 既存 `slack_user_token` 暗号化保存、定期ローテ検討 |

**Socket Mode オプション:**
- 現在 Events API（HTTP webhook）を使用中。Socket Mode は off。
- Socket Mode に切り替えると HTTP endpoint 不要だが、常時接続コスト発生。
- **判定:** Events API の user-token events で十分。Socket Mode 移行は不要。

### Option B: Slack Events with user scopes + Events API caveats

Option A と本質的に同じだが、Events API の制約を整理:

**Events API 制約（user-token events）:**

| 項目 | 制約 |
|------|------|
| Request URL | Bot events と共通可。同一エンドポイントに bot/user 両方のイベントが届く |
| 署名検証 | `SLACK_SIGNING_SECRET` で共通（アプリ単位） |
| `authorizations[]` | user-token event では `is_bot=false`、`user_id` = 購読ユーザー |
| イベント形式 | `message.channels`, `message.groups` の payload は bot event と同一構造 |
| 重複配信 | Bot と User 両方が購読している場合、同一メッセージが 2 回届く可能性 | `event_id` で dedupe（既存実装あり） |

**結論:** Option A と Option B は実装上同一。Option A として進める。

### Option C: Polling（reject unless justified）

社員の user token で `conversations.history` を定期ポーリング。

**判定: REJECT**

| 理由 | 詳細 |
|------|------|
| レイテンシ | ポーリング間隔（例: 10秒）分の遅延。リアルタイム UX に不適 |
| レート制限 | `conversations.history` は Tier 3（50+ req/min 可だが、多チャネル × 多社員でスケールしない） |
| 複雑性 | ポーリング状態管理、cursor 保持、重複検出が必要 |
| Slack 推奨 | Slack は Events API / Socket Mode を推奨。polling は「last resort」扱い |

**例外的に許容されるケース:**
- Events API が技術的に使えない環境（極めて稀）
- 過去ログの一括インポート（別機能）

### Option D: Hybrid — Bot only on home WS; external via user ingress

**推奨アーキテクチャ:**

| 対象 | Wake 方法 | 返信アイデンティティ |
|------|-----------|---------------------|
| **社内チャネル** | Bot `app_mention` | Bot or User（設定次第） |
| **社内 DM (App DM)** | Bot `message.im` | Bot |
| **社内 DM (人対人)** | User-token `message.im` | User |
| **外部 Connect チャネル** | **User-token `message.channels`** | **User** |

**理由:**
- 社内は Bot で十分（既存実装で動作中）
- 外部は user ingress で相手方アプリ不要を実現
- Bot と User を併用することで、社内 Bot 一貫性と外部 User 透明性を両立

**Ando model との整合:**
- internal = Bot ✓（社内チャネルは Bot mention）
- external = user ✓（Connect は User-token events + User posting）

---

## 4. 技術リスク

### 4.1 スコープ

User-token events で `message.channels` / `message.groups` を受信するには:

```
User Token Scopes:
  channels:history   — public channel message events
  groups:history     — private channel message events
  (既存) im:history  — DM message events
```

**影響:**
- 社員 OAuth フローで新スコープを要求
- 既存社員は再 OAuth が必要（既存 im:history 追加時と同パターン）

### 4.2 Connect team_id 解決

Slack Connect チャネルでは、`event.team_id` は **発言者の所属チーム** を示す。

```json
{
  "team_id": "T_STABLO",        // 発言者 Uehara の所属チーム
  "event": {
    "channel": "C_SHARED_123", // Connect チャネル
    "user": "U_UEHARA"
  },
  "authorizations": [{
    "is_bot": false,
    "user_id": "U_TANDO",       // 購読者（AI社員）
    "team_id": "T_YASAKA"       // 購読者の所属チーム
  }]
}
```

**解決策:**
- `authorizations[].team_id` で **購読者側（自社）** のチーム特定
- チャネル分類は `org_channels.external_id` で事前登録済み
- 未分類チャネルは fail-closed（wake しない）

### 4.3 メンション抽出

現在の `extractMentionedUserIds()` は text/blocks から `<@UXXXXX>` を抽出。

**課題:**
- Connect チャネルで相手方が `@tando` と入力すると、Slack は `<@U_TANDO|tando>` に変換
- User-token event でも同様のフォーマットで届く → **既存実装で対応可能**

**追加考慮:**
- `authorizations[].user_id` が mention に含まれているか確認（self-mention 検出）
- 含まれていなければ wake しない（誰かが会話しているだけ）

### 4.4 自己ループ防止

AI が投稿 → 同じチャネルの user-token event が自社に届く → 再 wake

**対策（既存パターン拡張）:**
```typescript
if (event.user === userTokenAuth.user_id) {
  return { targets: [], skipReason: "self_post_skip" };
}
```

既存の `im_self_skip` と同じロジックをチャネルにも適用。

### 4.5 クレデンシャル・リース / セキュリティ

| 項目 | 現状 | 追加対策 |
|------|------|----------|
| 保存 | `slack_user_token` 暗号化保存（Supabase Vault） | 変更なし |
| 漏洩検知 | 監査ログで token 使用を記録 | チャネル events の量的監視追加 |
| ローテーション | OAuth 再フローで更新 | 定期強制ローテは未実装（将来検討） |
| スコープ最小化 | `im:history` のみ → `channels:history`, `groups:history` 追加 | 必要最小限。`admin.*` 等は要求しない |

### 4.6 監査

```typescript
// 新規監査アクション
"slack.user_token_channel_wake"  // Connect/shared channel での user-token wake

// 監査メタデータ
{
  channel: "C_SHARED_123",
  channelClassification: "shared_external",
  teamId: "T_YASAKA",
  speakerTeamId: "T_STABLO",  // 発言者のチーム（Connect の場合は異なる）
  userTokenPath: true,
  eventId: "Ev..."
}
```

### 4.7 マルチテナント分離

| 懸念 | 対策 |
|------|------|
| 同一 Connect チャネルが複数 org に存在 | `org_channels` は org_id + external_id でユニーク。wake 時は `authorizations[].team_id` → org 解決 |
| 異なる org の社員が同じチャネルにいる | 各社員の org context で独立に wake。一方の wake が他方に影響しない |
| チャネル分類の競合 | 各 org が独自に分類。shared channel の分類は org ごとに独立 |

### 4.8 レート制限

| API | Tier | 制限 |
|-----|------|------|
| Events API (HTTP) | N/A | Slack から push。受信側制限なし |
| Events API (user token) | 未公開 | Slack 公式ドキュメントに user-token quota の明記なし。Bot events と同等と想定 |
| `chat.postMessage` (user token) | Tier 2 | 1 token あたり 20+ req/min。返信頻度では問題なし |

**リスク:**
- 高頻度チャネルで user-token events が大量に流入すると処理負荷増
- **緩和:** チャネル分類済み + mention 含む場合のみ wake。それ以外は早期 skip

### 4.9 Slack プロダクト制約（user-token channel events）

| 制約 | 詳細 |
|------|------|
| アプリ審査 | User Token Scopes 追加時、Slack App Directory 掲載には再審査が必要な場合あり。非公開アプリなら不要 |
| Enterprise Grid | Grid 環境では org-level vs workspace-level token の違いあり。現時点は workspace token 前提 |
| Connect 制限 | 相手方 WS がアプリのユーザー認可を許可しない設定の場合、Connect チャネルのイベントが届かない可能性（要検証） |

---

## 5. Non-goals / Path B との関係

### Non-goals（本設計スコープ外）

| 項目 | 理由 |
|------|------|
| Bot 経由の外部 Connect wake | Ando model で禁止（相手方にアプリ不要が必須） |
| Socket Mode 移行 | Events API で十分。常時接続コストを回避 |
| 相手方 WS へのアプリ配布 | Ando model で明示的に禁止 |
| DM ingress の変更 | 既存 Path A/B は維持。本設計はチャネル ingress の追加 |
| `message.mpim`（グループ DM） | 優先度低。必要なら別途検討 |

### Path B（DM message.im）との関係

| 項目 | Path B（既存） | 本設計（Channel ingress） |
|------|----------------|---------------------------|
| イベント種別 | `message.im` | `message.channels`, `message.groups` |
| スコープ | `im:history` | `channels:history`, `groups:history` |
| Wake 条件 | DM ルート登録済み + 発言者が社員以外 | チャネル分類済み + 社員へのメンション含む |
| 自己ループ | `event.user === authorizations[].user_id` | 同左 |
| 返信 | User token (`posting_as=user`) | 同左 |

**共通化ポイント:**
- `extractUserTokenAuthorization()` — 既存関数を再利用
- `resolveWakeTargets()` — チャネル用ブランチを追加
- 監査フレームワーク — 既存 `postWake()` を拡張

---

## 6. スパイク計画

### 6.1 PoC 目標（1–2 日）

**最小検証項目:**

| ID | 項目 | 判定基準 |
|----|------|----------|
| S1 | User-token events で `message.channels` が届くか | Slack app に user scope `channels:history` 追加、test channel で受信確認 |
| S2 | Connect チャネルで相手方発言が届くか | `authorizations[].team_id` が自社チーム、`event.team_id` が相手方チーム |
| S3 | メンション抽出が動作するか | `<@U_TANDO>` が正しく抽出され、社員解決できる |
| S4 | 自己ループが防げるか | AI 投稿後のイベントが skip される |

**PoC コード変更（thin slice）:**

```typescript
// lib/slack/mention-ingress.ts
// 1. eventType に "message" + channelType in ["channel", "group"] を追加
// 2. resolveWakeTargets() でチャネル用の user-token 解決を追加
// 3. 監査に slack.user_token_channel_wake を追加
```

**Slack App 設定変更:**

1. User Token Scopes に `channels:history`, `groups:history` 追加
2. Event Subscriptions → Subscribe to events on behalf of users に `message.channels`, `message.groups` 追加
3. テスト社員が OAuth 再フローで新スコープ取得

### 6.2 Yasaka / Ando オープンロック

| ロック | 担当 | 内容 |
|--------|------|------|
| **L1: スコープ追加承認** | Yasaka | User OAuth スコープ拡大（`channels:history`, `groups:history`）の承認 |
| **L2: Connect 相手方検証** | Ando | Stablo 側で Connect チャネル発言→イベント受信の実地検証 |
| **L3: 社員 OAuth 再フロー UX** | Yasaka | 既存社員に再 OAuth を促す UI/通知の設計承認 |
| **L4: 監査要件** | Yasaka | `slack.user_token_channel_wake` の監査フィールド仕様承認 |
| **L5: ロールアウト戦略** | Ando | org 単位 feature flag での段階展開 or 一括有効化 |

### 6.3 実装フェーズ（PoC 後）

| フェーズ | 内容 | 依存 |
|----------|------|------|
| P1 | Slack App scope/events 追加、コード実装 | L1 承認 |
| P2 | テスト社員で Connect PoC 実行 | L2 検証環境 |
| P3 | 社員 OAuth 再フロー UI | L3 承認 |
| P4 | 監査・ダッシュボード統合 | L4 承認 |
| P5 | 本番展開 | L5 戦略確定 |

---

## 7. 参考リンク

- [Slack Events API: Subscribe to events on behalf of users](https://docs.slack.dev/apis/events-api/request-urls#events-on-behalf-of-users)
- [Slack message.channels event](https://docs.slack.dev/reference/events/message.channels)
- [Slack message.groups event](https://docs.slack.dev/reference/events/message.groups)
- [Slack Connect: Shared Channels](https://api.slack.com/apis/connect)
- 内部: `docs/slack-internal-im-ingress.md` — Path B 実装詳細
- 内部: `docs/tenant-slack-kickoff-rail.md` — Slack 設定ガイド

---

## 変更履歴

| 日付 | 著者 | 内容 |
|------|------|------|
| 2026-09-19 | Ando/user | 初版作成。P0 product lock に基づく設計メモ |

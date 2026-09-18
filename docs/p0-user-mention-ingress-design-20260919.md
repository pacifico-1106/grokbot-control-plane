# P0: AI社員の個人メンション起こし

**ステータス:** 🔒 DESIGN LOCK IN PROGRESS  
**日付:** 2026-09-19  
**担当:** Ando model lock (Ando/user 2026-09-19)  
**優先度:** P0（短期実装必須）

---

## Design Lock（プロダクト制約 — 非交渉）

> **DESIGN LOCK from user via Ando (2026-09-19)**
>
> User-token channel listen（スコープ、信頼境界、Connect ID スキュー、漏洩時のブラスト半径）は **リスクポイントそのもの — それを乗り越えることが Staffpass の価値**。セキュリティファーストは前提。
>
> **理想を放棄しない:**
> - internal = Bot
> - external = User-originated ingress
> - 相手方 WS に Staffpass アプリ不要

以下は **ロック済みプロダクト制約** であり、オプションや将来検討ではない:

| ID | 制約 | 状態 |
|----|------|------|
| **DL-1** | 最小スコープ + クレデンシャル・リース（短命・目的限定、channel history 用の常駐 god-token 禁止） | 🔒 LOCKED |
| **DL-2** | テナント分離 + 明示マップのみ（fuzzy/display-name マッチ禁止）+ fail-closed | 🔒 LOCKED |
| **DL-3** | 監査: token subject / channel / employee / event / wake outcome | 🔒 LOCKED |
| **DL-4** | Connect: `team_id` とゲスト `U…`/`W…` vs ホームアイデンティティの明示的ハンドリング | 🔒 LOCKED |
| **DL-5** | Revoke / 再OAuth / オフボーディング フロー | 🔒 LOCKED |
| **DL-6** | G7 Bot path = fallback/transitional のみ。**正規の external mouth = User-originated ingress** | 🔒 LOCKED |

技術的オプション・スパイク（Events vs Socket vs etc.）は **このロック下でのエンジニアリング選択** として open。

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

## 2. G7 Bot Path の位置づけ（DL-6）

### 🔒 LOCKED: G7 Bot = Fallback / Transitional Only

> **正規の external mouth = User-originated ingress**

G7 Bot Events path は以下の位置づけ:

| 用途 | 状態 | 説明 |
|------|------|------|
| **社内チャネル** | ✅ 継続 | `app_mention` で Bot mention → wake（internal = Bot） |
| **社内 App DM** | ✅ 継続 | Bot `message.im` → wake |
| **外部 Connect（短期）** | ⚠️ Transitional | Connect チャネルに Bot 招待可能な場合の暫定パス。**長期では使用しない** |
| **外部 Connect（長期）** | 🔒 User ingress | User-token events が正規パス。相手方アプリ不要を実現 |

### Ando model との整合

| 領域 | 口 | 理由 |
|------|-----|------|
| internal | Bot | 社内は一貫した会社窓口。Bot mention で wake |
| external | User | 相手方にアプリ不要。人間アイデンティティで透明性確保 |

**G7 Bot+Connect path を「正解」として設計してはならない。** User-originated ingress の実装が完了次第、外部チャネルでの Bot 依存は段階的に廃止。

---

## 3. 最小スコープ + クレデンシャル・リース（DL-1）

### 🔒 LOCKED: No Standing God-Token

User-token での channel events 受信は強力な能力。**常駐 god-token（全チャネル履歴アクセス）を禁止**。

### スコープ最小化

```
User Token Scopes (必要最小限):
  channels:history   — public channel message events 受信
  groups:history     — private channel message events 受信
  im:history         — DM message events 受信（既存 Path B）
  chat:write         — 返信投稿
  users:read         — ユーザー情報取得
```

**禁止スコープ（要求してはならない）:**

| スコープ | 理由 |
|----------|------|
| `admin.*` | 管理権限は不要。ブラスト半径が組織全体に拡大 |
| `channels:read` (all) | 全チャネルリスト不要。分類済みチャネルのみ対象 |
| `files:read` | ファイル読み取りは別途 D1 ingress handoff で制御 |
| `search:read` | 検索能力は不要 |

### クレデンシャル・リース設計

| 原則 | 実装 |
|------|------|
| **短命** | Slack user token は OAuth フローで発行。refresh token があれば短命 access token を都度取得（Slack の token rotation 機能活用） |
| **目的限定** | token は「この社員の wake 受信」のみに使用。他目的（履歴バッチ取得等）に流用禁止 |
| **分離保存** | 各社員の token は独立。1社員の漏洩が他社員に影響しない |
| **アクセス時監査** | token 使用は監査ログに記録。異常パターン（大量 API 呼び出し等）を検知可能に |

### Token Rotation（Slack 機能）

Slack の token rotation を有効化すると:
1. OAuth 完了時に `access_token` + `refresh_token` を取得
2. `access_token` は短命（通常 12 時間）
3. `refresh_token` で新しい `access_token` を取得
4. 古い `access_token` は自動失効

**実装方針:**
- Token rotation 有効化を推奨設定とする
- `refresh_token` は Supabase Vault で暗号化保存
- Events 受信は Slack からの push なので token 不要（署名検証のみ）
- 返信時に短命 `access_token` を取得して使用

---

## 4. テナント分離 + 明示マップのみ（DL-2）

### 🔒 LOCKED: No Fuzzy Match, Fail-Closed

テナント間のデータ漏洩を防ぐため、**明示的なマッピングのみ** を許可。

### 禁止パターン

| パターン | 理由 | 対策 |
|----------|------|------|
| **Display name マッチ** | `@tando` という表示名が複数 WS に存在しうる | Slack User ID (`U...`) で厳密マッチのみ |
| **Email 推測マッチ** | 同一メールが複数アカウントに紐付く可能性 | OAuth で取得した identity のみ信頼 |
| **Team ID 推測** | Connect では複数 team_id が交錯 | `authorizations[].team_id` で購読者チームを厳密特定 |
| **Channel ID 共有** | 同一 `C...` が複数 org に分類される | `org_channels` は `org_id + external_id` でユニーク。org context で分離 |

### 明示マップ要件

```typescript
// 社員 → Slack identity マッピング
interface SlackIdentityBinding {
  employeeId: string;           // Staffpass 社員 ID
  slackUserId: string;          // Slack User ID (U... or W...)
  slackTeamId: string;          // Slack Team ID (T...)
  orgId: string;                // Staffpass Org ID
  boundAt: string;              // OAuth 完了日時
  boundBy: "oauth";             // 常に OAuth フローで確立
}

// チャネル → 分類マッピング
interface ChannelClassificationBinding {
  orgId: string;
  externalId: string;           // Slack Channel ID (C...)
  surface: "slack";
  classification: ChannelClassification;
  classifiedAt: string;
  classifiedBy: string;         // 管理者 or admin MCP
}
```

### Fail-Closed 動作

| 条件 | 動作 | 監査 |
|------|------|------|
| 社員 Slack ID が未バインド | wake しない | `slack.wake_skipped` + `reason: employee_not_bound` |
| チャネルが未分類 | wake しない | `slack.wake_skipped` + `reason: channel_not_classified` |
| `authorizations[]` に該当社員なし | wake しない | `slack.wake_skipped` + `reason: auth_mismatch` |
| `team_id` が org にマッチしない | wake しない | `slack.wake_skipped` + `reason: team_mismatch` |
| メンションが抽出できない | wake しない | `slack.wake_skipped` + `reason: no_mention` |

**「わからないときは何もしない」が原則。**

---

## 5. 監査（DL-3）

### 🔒 LOCKED: Token Subject / Channel / Employee / Event / Wake Outcome

User-token channel ingress の全操作を監査ログに記録。

### 監査イベント

| アクション | トリガー | 必須フィールド |
|-----------|----------|----------------|
| `slack.user_token_channel_wake` | User-token event で社員を起こした | 下記参照 |
| `slack.user_token_channel_wake_skipped` | User-token event を受信したが wake しなかった | 下記参照 |
| `slack.user_token_refresh` | Token rotation で access_token を更新 | `tokenSubject`, `employeeId` |
| `slack.user_token_revoked` | Token が revoke された | `tokenSubject`, `employeeId`, `revokedBy` |

### Wake 監査フィールド（必須）

```typescript
interface UserTokenChannelWakeAudit {
  // Token subject
  tokenSubject: {
    slackUserId: string;        // 購読者（AI社員）の Slack ID
    slackTeamId: string;        // 購読者のチーム ID
  };
  
  // Channel
  channel: {
    channelId: string;          // Slack Channel ID
    channelClassification: ChannelClassification;
    isShared: boolean;          // Connect/shared channel か
  };
  
  // Employee
  employee: {
    employeeId: string;         // Staffpass 社員 ID
    orgId: string;              // Staffpass Org ID
  };
  
  // Event
  event: {
    eventId: string;            // Slack event ID
    eventType: string;          // message.channels / message.groups
    speakerId: string;          // 発言者の Slack User ID
    speakerTeamId: string;      // 発言者のチーム ID（Connect で重要）
    mentionedIds: string[];     // 抽出されたメンション
    timestamp: string;          // Slack ts
  };
  
  // Wake outcome
  outcome: {
    woke: boolean;              // wake したか
    skipReason?: string;        // skip した場合の理由
    webhookStatus?: number;     // webhook 応答ステータス
    ingressHandoff?: {          // D1 適用結果
      bodyMode: string;
      attachmentMode: string;
      sealithHandoff: string;
    };
  };
}
```

### Wake Skipped 監査（必須）

skip 時も監査ログに記録。**silent drop 禁止**。

```typescript
// 例: チャネル未分類で skip
{
  action: "slack.user_token_channel_wake_skipped",
  tokenSubject: { slackUserId: "U_TANDO", slackTeamId: "T_YASAKA" },
  channel: { channelId: "C_UNKNOWN", channelClassification: "unknown" },
  employee: { employeeId: "emp_...", orgId: "org_..." },
  event: { eventId: "Ev...", speakerId: "U_UEHARA", speakerTeamId: "T_STABLO" },
  outcome: { woke: false, skipReason: "channel_not_classified" }
}
```

---

## 6. Connect: team_id とゲスト ID のハンドリング（DL-4）

### 🔒 LOCKED: Explicit Handling Required

Slack Connect チャネルでは、複数のチームとアイデンティティが交錯する。**暗黙の推測禁止**。

### Connect イベントの構造

```json
{
  "team_id": "T_STABLO",              // ← 発言者のチーム（相手方）
  "event": {
    "type": "message",
    "channel": "C_SHARED_123",
    "user": "U_UEHARA",               // ← 発言者（相手方 WS の ID）
    "text": "<@U_TANDO> 来週の件"
  },
  "authorizations": [{
    "is_bot": false,
    "user_id": "U_TANDO",             // ← 購読者（自社 AI社員）
    "team_id": "T_YASAKA"             // ← 購読者のチーム（自社）
  }]
}
```

### team_id 解決ルール

| フィールド | 意味 | 用途 |
|-----------|------|------|
| `envelope.team_id` | **発言者** の所属チーム | 相手方チーム特定。audience 判定に使用 |
| `authorizations[].team_id` | **購読者** の所属チーム | 自社チーム特定。org 解決に使用 |
| `event.user` | 発言者の Slack User ID | 自己ループ判定、発言者情報 |
| `authorizations[].user_id` | 購読者の Slack User ID | 社員解決、メンション照合 |

### ゲスト ID（`U...` vs `W...`）

Slack Enterprise Grid では:
- `U...` = ワークスペースローカル ID
- `W...` = Grid 全体で一意の ID

**対応方針:**
- 両形式を受け入れる（既存実装の `USER_ID_RE = /^[UW][A-Z0-9_]+$/i`）
- マッピングは OAuth で取得した ID をそのまま使用（変換しない）
- Grid 環境では `W...` が来ることを想定

### Connect ゲスト vs ホームアイデンティティ

| ケース | 判定 | 動作 |
|--------|------|------|
| 自社メンバーが Connect で発言 | `event.user` in 自社社員リスト | audience = internal |
| 相手方メンバーが Connect で発言 | `envelope.team_id` ≠ `authorizations[].team_id` | audience = external |
| ゲスト招待（自社 WS 内） | `parties.upsert` で事前登録 | 登録済み audience を使用 |
| 未登録ゲスト | — | fail-closed: external 扱い |

### 実装要件

```typescript
function resolveConnectContext(envelope: SlackEnvelope): ConnectContext {
  const userTokenAuth = extractUserTokenAuthorization(envelope);
  if (!userTokenAuth) {
    return { valid: false, reason: "no_user_token_auth" };
  }
  
  const speakerTeamId = envelope.team_id;
  const subscriberTeamId = userTokenAuth.team_id;
  const subscriberUserId = userTokenAuth.user_id;
  
  // 明示チェック: すべて存在しなければ invalid
  if (!speakerTeamId || !subscriberTeamId || !subscriberUserId) {
    return { valid: false, reason: "missing_identity_fields" };
  }
  
  const isConnect = speakerTeamId !== subscriberTeamId;
  
  return {
    valid: true,
    isConnect,
    speakerTeamId,
    subscriberTeamId,
    subscriberUserId,
    audience: isConnect ? "external" : "internal"
  };
}
```

---

## 7. Revoke / 再OAuth / オフボーディング（DL-5）

### 🔒 LOCKED: Complete Lifecycle Handling

User-token は社員のライフサイクルと連動して管理。

### Revoke フロー

| トリガー | アクション | 監査 |
|----------|-----------|------|
| **社員が手動 revoke** | ダッシュボードから「Slack 連携解除」 | `slack.user_token_revoked` + `revokedBy: employee` |
| **管理者が revoke** | Admin MCP / ダッシュボードから解除 | `slack.user_token_revoked` + `revokedBy: admin` |
| **Slack 側で revoke** | ユーザーが Slack 設定からアプリ連携解除 | token 使用時に 401 → 検知 → `slack.user_token_revoked` + `revokedBy: slack_user` |
| **Token 期限切れ** | refresh_token で更新失敗 | `slack.user_token_expired` |

### Revoke 時の動作

```typescript
async function handleTokenRevocation(employeeId: string, reason: string): Promise<void> {
  // 1. DB から token 削除
  await deleteSlackUserToken(employeeId);
  
  // 2. Events 購読は自動停止（token 無効で Slack が配信停止）
  
  // 3. 監査記録
  await appendAuditEvent({
    action: "slack.user_token_revoked",
    employeeId,
    metadata: { reason, revokedAt: new Date().toISOString() }
  });
  
  // 4. 社員ステータス更新（channel ingress 無効化）
  await updateEmployeeSlackStatus(employeeId, { channelIngressEnabled: false });
}
```

### 再OAuth フロー

既存社員がスコープ追加のため再 OAuth する場合:

1. **ダッシュボード通知**: 「Slack 連携を更新してください」バナー表示
2. **OAuth 開始**: 社員が「Slack を再連携」をクリック
3. **スコープ要求**: 新スコープ（`channels:history`, `groups:history`）を含む OAuth フロー
4. **Token 更新**: 新 token を DB に保存（古い token を上書き）
5. **監査記録**: `slack.user_token_reauthorized`
6. **機能有効化**: channel ingress が有効に

### オフボーディング・フロー

社員が組織を離れる / AI社員が無効化される場合:

| ステップ | アクション |
|----------|-----------|
| 1. 社員無効化 | `employees.status = 'disabled'` |
| 2. Token 自動 revoke | 無効化時に `deleteSlackUserToken()` を呼び出し |
| 3. Events 停止 | Slack からの events 配信が自動停止 |
| 4. 監査記録 | `slack.user_token_revoked` + `revokedBy: offboarding` |
| 5. Wake 拒否 | 無効社員への wake 試行は fail-closed |

### 緊急 Revoke

セキュリティインシデント時の即時 revoke:

```typescript
// Admin MCP ツール
async function emergencyRevokeSlackTokens(params: {
  orgId: string;
  employeeIds?: string[];  // 省略時は org 全体
  reason: string;
}): Promise<void> {
  const targets = params.employeeIds 
    ? await getEmployeesByIds(params.employeeIds)
    : await getOrgEmployees(params.orgId);
  
  for (const emp of targets) {
    await handleTokenRevocation(emp.id, `emergency: ${params.reason}`);
  }
  
  // 追加: Slack API で token を明示的に revoke（オプション）
  // これにより Slack 側でも即座に無効化
}
```

---

## 8. 技術オプション・スパイク（Engineering Choices）

> 以下は DL-1〜DL-6 の **ロック済み制約下** でのエンジニアリング選択。

### Option A: User-token Events API（HTTP webhook）

現在の Events API 基盤を拡張。

**メリット:**
- 既存インフラ（Request URL）を再利用
- ステートレス（常時接続不要）
- Slack 公式の user-token events 機構

**課題:**
- Token rotation 有効時でも Events 受信自体には token 不要（署名検証のみ）
- 返信時に短命 token を取得する追加フロー

### Option B: Socket Mode

WebSocket 常時接続でイベント受信。

**メリット:**
- HTTP endpoint 不要（ファイアウォール内でも動作）
- 低レイテンシ

**課題:**
- 常時接続の運用コスト
- 接続断時の再接続ハンドリング
- 現在 off で運用中

**判定:** Events API で十分。Socket Mode への移行は不要。

### Option C: Polling（REJECT）

**判定: REJECT** — DL-1（最小スコープ）違反。Polling は `conversations.history` の常時アクセスを必要とし、god-token 問題を引き起こす。

### 推奨: Option A + Token Rotation

```
Events API (HTTP webhook)
  ↓
署名検証 (SLACK_SIGNING_SECRET)
  ↓
User-token event 判定 (authorizations[].is_bot = false)
  ↓
明示マップ照合 (DL-2)
  ↓
Wake or Skip (fail-closed)
  ↓
監査記録 (DL-3)
  ↓
返信時: refresh_token → 短命 access_token → chat.postMessage
```

---

## 9. スパイク計画

### 9.1 PoC 目標（1–2 日）

| ID | 項目 | 判定基準 | DL 関連 |
|----|------|----------|---------|
| S1 | User-token `message.channels` 受信 | Slack app に user scope 追加、test channel で受信確認 | — |
| S2 | Connect で相手方発言受信 | `authorizations[].team_id` が自社、`envelope.team_id` が相手方 | DL-4 |
| S3 | 明示マップ照合 | 未分類チャネル/未バインド社員で wake しない | DL-2 |
| S4 | 自己ループ防止 | AI 投稿後のイベントが skip | DL-2 |
| S5 | 監査ログ出力 | wake/skip 両方で必須フィールド記録 | DL-3 |
| S6 | Token rotation | refresh → access token フロー動作確認 | DL-1 |

### 9.2 Yasaka / Ando オープンロック

| ロック | 担当 | 内容 | DL 関連 |
|--------|------|------|---------|
| **L1** | Yasaka | User OAuth スコープ拡大承認 | DL-1 |
| **L2** | Ando | Connect 相手方検証（Stablo 側でイベント受信確認） | DL-4 |
| **L3** | Yasaka | 社員 OAuth 再フロー UX 設計承認 | DL-5 |
| **L4** | Yasaka | 監査フィールド仕様承認 | DL-3 |
| **L5** | Ando | ロールアウト戦略（feature flag vs 一括） | — |

### 9.3 実装フェーズ

| フェーズ | 内容 | 依存 |
|----------|------|------|
| P1 | Slack App scope/events 追加、明示マップ照合実装 | L1 承認 |
| P2 | Connect PoC 実行、team_id ハンドリング検証 | L2 検証環境 |
| P3 | 社員 OAuth 再フロー UI、revoke フロー | L3 承認 |
| P4 | 監査統合、ダッシュボード表示 | L4 承認 |
| P5 | Token rotation 有効化、本番展開 | L5 戦略確定 |

---

## 10. Non-goals

| 項目 | 理由 |
|------|------|
| Bot 経由の外部 Connect wake（長期） | **DL-6**: 正規パスは User ingress |
| 相手方 WS へのアプリ配布 | Ando model で明示的に禁止 |
| DM ingress の変更 | 既存 Path A/B は維持 |
| Channel history バッチ取得 | **DL-1**: god-token 禁止 |
| Display name / email でのマッチ | **DL-2**: 明示マップのみ |
| `message.mpim`（グループ DM） | 優先度低。必要なら別途検討 |

---

## 11. 参考リンク

- [Slack Events API: Subscribe to events on behalf of users](https://docs.slack.dev/apis/events-api/request-urls#events-on-behalf-of-users)
- [Slack message.channels event](https://docs.slack.dev/reference/events/message.channels)
- [Slack Token Rotation](https://api.slack.com/authentication/rotation)
- [Slack Connect: Shared Channels](https://api.slack.com/apis/connect)
- 内部: `docs/slack-internal-im-ingress.md` — Path B 実装詳細
- 内部: `docs/tenant-slack-kickoff-rail.md` — Slack 設定ガイド

---

## 変更履歴

| 日付 | 著者 | 内容 |
|------|------|------|
| 2026-09-19 | Ando/user | 初版作成。P0 product lock に基づく設計メモ |
| 2026-09-19 | Ando/user | **DESIGN LOCK** 追加。DL-1〜DL-6 をロック済み制約として明記。最小スコープ、テナント分離、監査、Connect ハンドリング、Revoke フロー、G7 Bot 位置づけを必須セクションとして追加 |

# 承認強制ロールアウトランブック 2026-09-28

**対象組織**: TOKYO307（オーナー: 八坂）
**作成日**: 2026-09-28
**最終更新**: 2026-09-28

---

## 目次

1. [前提条件と事前チェック](#1-前提条件と事前チェック)
2. [ステップ1: 八坂の Telegram 投票者バインディング登録](#2-ステップ1-八坂の-telegram-投票者バインディング登録)
3. [ステップ2: Slack Interactivity Request URL 切替](#3-ステップ2-slack-interactivity-request-url-切替)
4. [ステップ3: SLACK_APPROVAL_STRICT 有効化](#4-ステップ3-slack_approval_strict-有効化)
5. [ステップ4: ADMIN_APPROVER_POLICY_REQUIRED 有効化](#5-ステップ4-admin_approver_policy_required-有効化)
6. [ステップ5: per-org admin_approver_enforcement 有効化](#6-ステップ5-per-org-admin_approver_enforcement-有効化)
7. [ステップ6: APPROVAL_RECIPIENT_ROUTING 有効化](#7-ステップ6-approval_recipient_routing-有効化)
8. [ロックアウトリスク分析](#8-ロックアウトリスク分析)
9. [Slack Interactivity エンドポイント確認](#9-slack-interactivity-エンドポイント確認)
10. [配信一意制約修正確認](#10-配信一意制約修正確認)
11. [追加セットアップ: Space Tree / みらい社中](#11-追加セットアップ-space-tree--みらい社中)

---

## 1. 前提条件と事前チェック

### 必須条件

- [ ] TOKYO307 組織が存在する
- [ ] 八坂が組織オーナーである
- [ ] Telegram ボット (TELEGRAM_BOT_TOKEN) が設定されている
- [ ] TELEGRAM_ALLOWED_USER_IDS に八坂の Telegram ID が含まれている
- [ ] VOTER_BINDING_SECRET が本番環境で設定されている

### 検証クエリ

```sql
-- 組織とオーナーの確認
SELECT o.id, o.name, om.id as member_id, om.email, om.role, om.display_name
FROM orgs o
JOIN org_members om ON om.org_id = o.id
WHERE o.name = 'TOKYO307' AND om.role = 'owner';
```

**期待結果**: 八坂が `role = 'owner'` で表示される

---

## 2. ステップ1: 八坂の Telegram 投票者バインディング登録

### ルーティングの仕組み

**重要**: 承認通知のルーティングは以下の優先順位で決まります:

1. **テナントチャネル優先**: `org_notification_channels` に有効な Telegram チャネルがある場合、そこに配信
2. **グローバルフォールバック**: テナントチャネルがない場合のみ、`telegram:global` (env 設定の Bot) にフォールバック

TOKYO307 には以下のテナント Telegram チャネルがあります:
- `承認用Telegram` (ID: `98eb7dd7-f401-4291-a9de-64b510d90d31`)
- `依頼者` (ID: `d430bb5a-c60e-44b4-89cd-7683e57b85be`)

**したがって、八坂が投票に使うのはテナントチャネル経由であり、`telegram:global` ではありません。**

### 実施内容

八坂がテナントチャネルから投票できるように、各チャネル ID をキーとしてバインドする。

### 手順

1. Admin MCP で以下を実行（**承認用Telegram チャネル**用）:

```json
{
  "tool": "approvalWorkflow.bindVoter",
  "args": {
    "memberId": "db77fa1c-615b-401a-9125-9c52b9adc5a6",
    "provider": "telegram",
    "channelKey": "98eb7dd7-f401-4291-a9de-64b510d90d31",
    "externalUserId": "8446547736"
  }
}
```

2. Admin MCP で以下を実行（**依頼者チャネル**用、deliveries 0件だが将来用に推奨）:

```json
{
  "tool": "approvalWorkflow.bindVoter",
  "args": {
    "memberId": "db77fa1c-615b-401a-9125-9c52b9adc5a6",
    "provider": "telegram",
    "channelKey": "d430bb5a-c60e-44b4-89cd-7683e57b85be",
    "externalUserId": "8446547736"
  }
}
```

3. always_human チケットが発行されるので、既存の承認者（またはプラットフォーム運用代行）が承認
4. 承認後、各チャネルの Bot から八坂の Telegram に確認ボタン付き DM が送信される

### DM 送信と事前作業について

**承認用Telegram チャネル (98eb7dd7...)** は chatId=-5253257557 の**グループチャット**です。

| シナリオ | 動作 |
|---------|------|
| 八坂が Bot と DM 開始済み | Bot から八坂宛に DM で確認ボタンが届く |
| 八坂が Bot と DM 未開始 | **フォールバック**: グループチャット内に確認ボタンが投稿される（ボタンは八坂本人のみ有効） |

**推奨事前作業（オプション）**:
- 八坂が承認用Telegram チャネルの Bot を Telegram で `/start` しておく
- これにより、確認ボタンが DM で届き、グループに投稿されない（プライバシー向上）
- ただし、未開始でもグループフォールバックにより登録は完了可能

**依頼者チャネル (d430bb5a...)** は chatId=8446547736 で**八坂宛 DM** なので、この問題は発生しない。

5. 八坂が「承認者として登録する」ボタンをクリック（DM またはグループ内）

### 検証クエリ

```sql
-- バインディング状態の確認（テナントチャネル）
SELECT provider, channel_key, external_user_id, member_id, 
       verified_at, expires_at, revoked_at
FROM approval_workflow_voter_bindings
WHERE org_id = '92f3617c-33fc-4dac-b9b4-d4f42e8522ac'
  AND provider = 'telegram'
  AND channel_key IN (
    '98eb7dd7-f401-4291-a9de-64b510d90d31',
    'd430bb5a-c60e-44b4-89cd-7683e57b85be'
  );
```

**期待結果**: 各チャネルについて `verified_at IS NOT NULL` かつ `revoked_at IS NULL`

### ロールバック

```sql
UPDATE approval_workflow_voter_bindings
SET revoked_at = NOW()
WHERE org_id = '92f3617c-33fc-4dac-b9b4-d4f42e8522ac'
  AND provider = 'telegram'
  AND member_id = 'db77fa1c-615b-401a-9125-9c52b9adc5a6';
```

### telegram:global バインディング（オプション）

グローバルフォールバックが有効な場合（テナントチャネルがすべて無効化された場合）に備え、
`telegram:global` バインディングも追加で作成しておくことを推奨:

```json
{
  "tool": "approvalWorkflow.bindVoter",
  "args": {
    "memberId": "db77fa1c-615b-401a-9125-9c52b9adc5a6",
    "provider": "telegram",
    "channelKey": "telegram:global",
    "externalUserId": "8446547736"
  }
}
```

---

## 3. ステップ2: Slack Interactivity Request URL 切替

### 実施内容

Slack アプリの Interactivity Request URL を `/api/webhooks/slack/interactivity` に切り替える。

### 手順

1. Slack App 管理画面 (api.slack.com/apps) でアプリを開く
2. 「Interactivity & Shortcuts」 → 「Request URL」を変更:
   - 旧: `https://<domain>/api/webhooks/slack/<ref>`
   - 新: `https://<domain>/api/webhooks/slack/interactivity`
3. 「Save Changes」

### 検証

```bash
# Interactivity エンドポイントの疎通確認
curl -X POST https://<domain>/api/webhooks/slack/interactivity \
  -H "Content-Type: application/json" \
  -d '{"type":"url_verification","challenge":"test123"}'
# 期待結果: {"challenge":"test123"}
```

### 必須環境変数

新エンドポイントは以下を使用:
- チャネルごとの `signingSecret` (org_notification_channels.secrets に暗号化保存)
- `api_app_id` (チャネル config)
- `expectedTeamId` / `teamId` (外部ユーザー拒否用)

### ロールバック

Request URL を旧パスに戻す: `https://<domain>/api/webhooks/slack/<ref>`

---

## 4. ステップ3: SLACK_APPROVAL_STRICT 有効化

### 動作変更

| 項目 | OFF (デフォルト) | ON |
|------|-----------------|-----|
| allowedUserIds | 空なら全員許可 | 空なら投票者バインディング必須 |
| team_id 検証 | なし | expectedTeamId と一致必須 |
| expectedTeamId 未設定 | 無視 | **フェイルクローズド** (拒否) |
| decision_id 記録 | なし | W1 リプレイ防御用に記録 |

### 誰が承認できるか

- `allowedUserIds` に含まれるユーザー、または
- 有効な `approval_workflow_voter_bindings` がある投票者

### フェイルクローズド条件

- expectedTeamId が未設定 → 承認ボタン無効 (ephemeral 拒否メッセージ)
- 外部ワークスペースユーザー → 拒否

### 手順

```bash
# 環境変数を設定
SLACK_APPROVAL_STRICT=true
```

### 検証クエリ

```sql
-- 全チャネルに expectedTeamId があるか確認
SELECT id, label, provider, 
       config->>'expectedTeamId' as expected_team_id,
       config->>'teamId' as team_id
FROM org_notification_channels
WHERE org_id = '<TOKYO307_ORG_ID>'
  AND provider = 'slack'
  AND enabled = true;
```

**期待結果**: 全行で `expected_team_id` または `team_id` が設定されている

### ロールバック

```bash
SLACK_APPROVAL_STRICT=false
```

---

## 5. ステップ4: ADMIN_APPROVER_POLICY_REQUIRED 有効化

### 動作変更

| 項目 | OFF (デフォルト) | ON |
|------|-----------------|-----|
| 管理系承認 | 任意の単一承認者 (W1) | admin route または org owner 必須 |
| employee override | 有効 | admin class には適用不可 |
| org owner fallback | なし | admin route がなければ owner がデフォルト承認者 |

### 誰が承認できるか

**管理系 (admin class) チケット**:
1. 明示的な admin route がある場合 → route 内の voterUserIds
2. admin route がない場合 → **組織オーナーがデフォルト承認者**

**業務系 (business class) チケット**:
- 従来通り employee override または org policy

### フェイルクローズド条件

- admin route がなく、かつ組織オーナーが0人 → `admin_policy_required` エラー

### 八坂へのロックアウトリスク

**リスクなし**: 八坂は組織オーナーなので、admin route がなくてもデフォルト承認者として許可される。

### 手順

```bash
ADMIN_APPROVER_POLICY_REQUIRED=true
```

### 検証クエリ

```sql
-- org owner の存在確認
SELECT COUNT(*) as owner_count
FROM org_members
WHERE org_id = '<TOKYO307_ORG_ID>'
  AND role = 'owner'
  AND status = 'active';
```

**期待結果**: `owner_count >= 1`

### ロールバック

```bash
ADMIN_APPROVER_POLICY_REQUIRED=false
```

---

## 6. ステップ5: per-org admin_approver_enforcement 有効化

### 動作変更

| 項目 | OFF (デフォルト) | ON |
|------|-----------------|-----|
| 強制レベル | アプリレベルのみ | **DB/RPC トリガーレベル** |
| resolver 検証 | なし | memberId 必須、non-owner 拒否 |
| W1 解決 | 任意の承認者 | admin route 投票者 or org owner のみ |

### 誰が承認できるか

**管理系チケット (admin_approver_enforcement=true)**:
- 明示的な admin route 投票者、または
- 組織オーナー（memberId lookup で確認）

### フェイルクローズド条件

- resolver の `memberId` が取得できない（投票者バインディングなし）→ DB トリガー拒否
- non-owner が admin class を解決しようとした → `non_owner_on_admin_ticket` 拒否

### 八坂へのロックアウトリスク

**条件付きリスク**: 
- **ステップ1が完了していない場合**: 八坂の `telegram:global` バインディングがないと `memberId` が `null` になり、DB トリガーで拒否される
- **ステップ1が完了している場合**: バインディング経由で `memberId` が取得できるため、org owner として承認可能

### 手順

```sql
-- 組織単位で有効化
UPDATE orgs
SET admin_approver_enforcement = true
WHERE id = '<TOKYO307_ORG_ID>';
```

### 検証クエリ

```sql
-- enforcement 状態確認
SELECT id, name, admin_approver_enforcement
FROM orgs
WHERE id = '<TOKYO307_ORG_ID>';

-- 八坂のバインディング確認 (必須)
SELECT b.*, om.role
FROM approval_workflow_voter_bindings b
JOIN org_members om ON om.id = b.member_id
WHERE b.org_id = '<TOKYO307_ORG_ID>'
  AND b.channel_key = 'telegram:global'
  AND b.verified_at IS NOT NULL
  AND b.revoked_at IS NULL;
```

**期待結果**: 
- `admin_approver_enforcement = true`
- 八坂のバインディングが `role = 'owner'` で存在

### ロールバック

```sql
UPDATE orgs
SET admin_approver_enforcement = false
WHERE id = '<TOKYO307_ORG_ID>';
```

---

## 7. ステップ6: APPROVAL_RECIPIENT_ROUTING 有効化

### 動作変更

| 項目 | OFF (デフォルト) | ON |
|------|-----------------|-----|
| 配信先 | チャネルのみ | 投票者 DM またはスレッド |
| admin class | チャネル | デフォルトチャネル (DM なし) |
| business class | チャネル | 投票者バインディングに基づく DM |
| Slack Connect | 許可 | **ブロック** (共有チャネルへの配信禁止) |

### 前提条件

**配信一意制約の修正が必要** (マイグレーション `20260927300000_delivery_unique_fix.sql`)

### 検証クエリ

```sql
-- 一意制約修正の確認
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'approval_notification_deliveries'
  AND indexname LIKE '%unique%';
```

**期待結果**:
- `approval_notification_deliveries_channel_unique_idx` (recipient IS NULL)
- `approval_notification_deliveries_recipient_unique_idx` (recipient IS NOT NULL)

### 手順

```bash
APPROVAL_RECIPIENT_ROUTING=true
```

### ロールバック

```bash
APPROVAL_RECIPIENT_ROUTING=false
```

---

## 8. ロックアウトリスク分析

### 八坂 (Telegram のみ) のロックアウトリスク一覧

| ステップ | フラグ | ロックアウトリスク | 緩和策 |
|---------|--------|------------------|--------|
| 1 | バインディング | なし | - |
| 2 | Interactivity URL | なし (Telegram に影響なし) | - |
| 3 | SLACK_APPROVAL_STRICT | なし (Telegram に影響なし) | - |
| 4 | ADMIN_APPROVER_POLICY_REQUIRED | **なし** (org owner はデフォルト許可) | - |
| 5 | admin_approver_enforcement | **条件付き** | **ステップ1を先に完了（テナントチャネル用）** |
| 6 | APPROVAL_RECIPIENT_ROUTING | なし (admin class は DM 対象外) | - |

### 重要: テナントチャネルと channelKey の関係

**TOKYO307 にはテナント Telegram チャネルが存在します。**

`lib/notify/telegram-channel-webhook.ts` では、投票時に `channelKey: channel.id` で `getMemberIdFromVoterBinding()` を呼びます:

```typescript
const memberId = await getMemberIdFromVoterBinding(channel.orgId, {
  provider: "telegram",
  channelKey: channel.id,  // テナントチャネルの UUID
  userId: String(query.from!.id),
});
```

つまり、`telegram:global` バインディングだけでは**テナントチャネル経由の投票にマッチしません**。

### ステップ1 の前提条件

**ステップ5 (admin_approver_enforcement) を有効にする前に、必ずステップ1（テナントチャネル用のバインディング）を完了させること。**

バインディングがないと:
- `getMemberIdFromVoterBinding()` が `null` を返す
- DB トリガー `guard_admin_approval_resolution_tg` が resolver を拒否
- 八坂が管理系チケットを承認できなくなる

### バインディングが必要なチャネル

TOKYO307 の場合、以下のバインディングが必要です（少なくとも通知が配信されるチャネル分）:

| チャネル名 | channelKey (UUID) | chatId | deliveries | 備考 |
|-----------|------------------|--------|------------|------|
| 承認用Telegram | `98eb7dd7-f401-4291-a9de-64b510d90d31` | `-5253257557` | 36件 | **グループチャット** - 管理者承認はここに届く |
| 依頼者 | `d430bb5a-c60e-44b4-89cd-7683e57b85be` | `8446547736` | 0件 | 八坂宛 DM |
| (オプション) グローバルフォールバック | `telegram:global` | - | - | テナントチャネルが無効な場合用 |

**八坂の Telegram user ID**: `8446547736`（全チャネルの allowedUserIds がこれ1件のみ）

---

## 9. Slack Interactivity エンドポイント確認

### 新エンドポイント `/api/webhooks/slack/interactivity`

**処理するアクション**:
- `staffpass_approve` - 承認
- `staffpass_reject` - 却下
- `staffpass_revise` - 修正依頼
- `staffpass_verify_voter_binding` - 投票者バインディング確認
- `staffpass_reject_voter_binding` - 投票者バインディング拒否

**セキュリティ**:
- (api_app_id, team_id) で候補チャネルを絞り込み
- 署名検証は候補チャネルの signingSecret で実施
- 曖昧な署名一致は拒否 (複数チャネルで同じ secret = エラー)
- カード期限切れ (7日) でエフェメラル拒否

### レガシーエンドポイント `/api/webhooks/slack/[ref]`

**引き続き機能**: 既存のカードは per-ref URL を使用しているため、切替後も動作する

**処理するアクション**:
- `staffpass_approve`
- `staffpass_reject`
- `staffpass_revise`

---

## 10. 配信一意制約修正確認

### 問題

旧来の一意制約 `UNIQUE (approval_id, channel_id)` では、DM 配信とチャネル配信が衝突していた。

### 修正内容 (20260927300000_delivery_unique_fix.sql)

1. 旧来の完全一意制約を削除
2. 部分一意インデックスを2つ作成:
   - `approval_notification_deliveries_channel_unique_idx` (recipient IS NULL)
   - `approval_notification_deliveries_recipient_unique_idx` (recipient IS NOT NULL)
3. `upsert_notification_delivery` RPC 関数を作成

### 検証クエリ

```sql
-- 完全一意制約がないことを確認
SELECT constraint_name
FROM information_schema.table_constraints
WHERE table_name = 'approval_notification_deliveries'
  AND constraint_type = 'UNIQUE';
-- 期待結果: 空

-- 部分インデックスの存在確認
SELECT indexname
FROM pg_indexes
WHERE tablename = 'approval_notification_deliveries'
  AND indexname LIKE '%unique%';
-- 期待結果: 2行 (channel_unique_idx, recipient_unique_idx)

-- 重複がないことを確認
SELECT approval_id, channel_id, recipient, COUNT(*)
FROM approval_notification_deliveries
GROUP BY approval_id, channel_id, recipient
HAVING COUNT(*) > 1;
-- 期待結果: 0行
```

**ステータス**: ✅ 修正済み (main ブランチに存在)

---

## 11. 追加セットアップ: Space Tree / みらい社中

### Space Tree: 野木への Slack 1:1 DM

**必要なデータ/設定**:

| 項目 | 内容 | 設定方法 |
|------|------|---------|
| 投票者バインディング | 野木の Slack ID → 野木の memberId | `approvalWorkflow.bindVoter` (always_human) |
| 承認チャンネル | 内部チャンネル (Slack Connect 禁止) | `setup.lineApproval.upsert` or ダッシュボード |
| employee.approverUserIds | 野木の userId | `policy.patch` |
| Slack Bot Token | Space Tree ワークスペース用 | `setup.slackAdapter.setBotToken` |

**always_human ステップ**:
- `approvalWorkflow.bindVoter` (組織オーナー承認必須)

### みらい社中: Telegram 承認チャネル

**本番データ (2026-09-28)**:
- 承認用Telegram チャネル: `6f3a9dff-0625-4b11-b2ce-e3975d23a062`
- chatId: `8446547736` (DM - 八坂宛)
- deliveries: 19件、最終 2026-09-21 09:01 UTC

**注意**: このチャネルの chatId は八坂の Telegram user ID と同じであり、DM チャネルとして機能しています。

### みらい社中: 上原・仲田への Slack (共有チャンネル禁止)

**必要なデータ/設定**:

| 項目 | 内容 | 設定方法 |
|------|------|---------|
| 投票者バインディング (上原) | 上原の Slack ID → 上原の memberId | `approvalWorkflow.bindVoter` (always_human) |
| 投票者バインディング (仲田) | 仲田の Slack ID → 仲田の memberId | `approvalWorkflow.bindVoter` (always_human) |
| 承認チャンネル | **内部チャンネルのみ** | ダッシュボードで登録 (Slack Connect 自動拒否) |
| Slack Bot Token | みらい社中ワークスペース用 | `setup.slackAdapter.setBotToken` |

**Slack Connect 共有チャンネルのブロック**:
- 登録時に `conversations.info` で `is_ext_shared` / `is_shared` / `is_pending_ext_shared` をチェック
- 外部共有チャンネルは自動拒否

**always_human ステップ**:
- `approvalWorkflow.bindVoter` x 2 (上原, 仲田)

---

## 付録: 監査クエリまとめ

```sql
-- 1. 組織とオーナー
SELECT o.id, o.name, o.admin_approver_enforcement,
       om.id as member_id, om.display_name, om.role
FROM orgs o
JOIN org_members om ON om.org_id = o.id AND om.role = 'owner';

-- 2. 投票者バインディング
SELECT b.org_id, b.provider, b.channel_key, b.external_user_id,
       b.member_id, b.verified_at, b.expires_at, b.revoked_at,
       om.display_name, om.role
FROM approval_workflow_voter_bindings b
JOIN org_members om ON om.id = b.member_id
WHERE b.verified_at IS NOT NULL AND b.revoked_at IS NULL;

-- 3. 通知チャンネル
SELECT id, org_id, provider, label, enabled, is_default,
       config->>'expectedTeamId' as expected_team_id
FROM org_notification_channels
WHERE enabled = true;

-- 4. 配信一意インデックス
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'approval_notification_deliveries'
  AND indexname LIKE '%unique%';
```

---

*最終更新: 2026-09-28*

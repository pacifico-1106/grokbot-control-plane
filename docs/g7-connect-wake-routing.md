# G7 Cross-team wake routing — Option A locked (2026-09-19)

## ステータス

**スキャフォールド完了・フラグ OFF**

フィーチャーフラグ `G7_CONNECT_WAKE_ROUTING=1` はデフォルト OFF。本番 wake 経路は現行と同一の動作を維持。

**テーブル名**: `cross_team_wake_bindings` (Option A locked)

## Smoke 対象（Design Lock 2026-09-18）

フラグを ON にした最初の smoke テストは以下を予定:

> **TOKYO307 `#aitest` → explicit binding → Mirai Tomori wake**

- 307 が `#aitest` Connect チャネルでメンションを受信
- 明示的バインディングが Mirai Tomori 社員へルーティング
- チャネル ID は本番コードにハードコードしない（テスト・フィクスチャ・コメントのみ）

本番有効化は別途 GO 判断。

## 概要

Slack Connect 共有チャネルで、ゲストユーザーが @メンションされた際に、そのゲストの home テナントの AI 社員を起こす機能。

従来の team-scoped identity lookup（同一ワークスペース内のみ）では、Connect ゲストは別テナント所属のため wake できなかった。G7 では明示的なバインディングテーブルにより、クロステナント wake を可能にする。

## セキュリティ設計

- **テナント分離**: バインディングは (receiving_org, target_org) ペアでスコープ
- **Fail-closed**: バインディングなし / 曖昧（複数候補） = wake しない
- **表示名推測禁止**: 表示名でのクロスオーグ推測は絶対しない。明示的 admin バインディングのみ
- **Service-role only**: `cross_team_wake_bindings` テーブルは RLS 有効、ブラウザポリシーなし

## データモデル

```sql
cross_team_wake_bindings (
  id uuid primary key,
  receiving_org_id uuid,       -- メンション受信側の org
  receiving_team_id text,      -- メンション受信側の Slack team
  mentioned_slack_user_id text,-- @メンションされた Connect ゲストの user id
  target_org_id uuid,          -- 起こす社員の home org
  target_employee_id uuid,     -- 起こす社員
  enabled boolean default true,
  created_at, updated_at
)
```

ユニーク制約: `(receiving_org_id, receiving_team_id, mentioned_slack_user_id)` where `enabled = true`

## フラグ動作

| `G7_CONNECT_WAKE_ROUTING` | 動作 |
|---------------------------|------|
| 未設定 / 空 / `0` | 既存の team-scoped lookup のみ。cross-team バインディングは無視。 |
| `1` | team-scoped lookup で見つからない後、cross-team バインディングを確認。 |

## 処理フロー（フラグ ON 時）

```
resolveWakeTargets()
  ├─ DM? → 既存の IM route resolver
  └─ チャネル mention
       ├─ getEmployeesBySlackUserIds(teamId) → 同一チーム内の社員
       ├─ 見つからない mentioned user に対して:
       │    └─ resolveCrossTeamWakeTarget(teamId, mentionedUserId)
       │         └─ getCrossTeamWakeBinding() → 0/1 件のみ有効
       └─ 全 targets を merge して wake
```

## Admin MCP / バインディング管理

**本 PR ではスコープ外**。データ層関数（`upsertCrossTeamWakeBinding`, `deleteCrossTeamWakeBinding`）はテスト用に存在するが、公開 MCP ツールは別 PR で実装予定。

## 関連

- マイグレーション: `supabase/migrations/20260918_cross_team_wake_bindings.sql`
- データ層: `lib/data/cross-team-wake-bindings.ts`
- ワイヤーポイント: `lib/slack/mention-ingress.ts` の `resolveWakeTargets`
- テスト: `lib/data/cross-team-wake-bindings.test.ts`, `lib/slack/mention-ingress.test.ts`

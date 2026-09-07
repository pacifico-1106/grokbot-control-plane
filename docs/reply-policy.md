# B2 Reply Policy — Slack/LINE 返信ポリシー

**ステータス:** ✅ 本番稼働（PR #42 マージ済み `2d7f32c`）  
**SQL:** `20260908_reply_policy.sql`（Grokbot 共有制御面に適用済み）  
**カタログ:** B2 Slack/LINE等の返信  
**関連:** F1 口ルーティング（mouth-routing）、[tenant-slack-kickoff-rail.md](./tenant-slack-kickoff-rail.md) § 5

## 概要

B2 Reply Policy は AI 社員の会話返信行動を制御するルールパックです。A1 scheduling.policy / F1 mouth-routing と同じパターンに従います。

### 主な機能

1. **営業時間外動作** — 時間外は下書きのみ、承認必須、または自動送信（高リスク）
2. **絵文字制御** — 全許可、全禁止、または許可リスト制限
3. **短文制御** — 許可、禁止、または警告
4. **スレッド親和性** — 既存スレッド優先、トピック別スレッド、チャネル直接投稿

## ポリシー構造

```typescript
interface OrgReplyPolicy {
  version: 1;
  policyId: string;
  policyName: string;
  rules: ReplyPolicyRule[];
  highRiskConsentAt?: string;
  highRiskConsentBy?: string;
  updatedAt: string;
  updatedBy: string;
}

interface ReplyPolicyRule {
  id: string;
  priority?: number;
  surface?: "slack" | "line" | "mail" | "phone" | "web";
  afterHoursMode: "draft_only" | "allow_send" | "hold_approval";
  businessHours?: BusinessHoursWindow;
  shortReplyMode: "allow" | "deny" | "warn";
  shortReplyMinChars?: number;
  emojiMode: "allow" | "deny" | "limited";
  allowedEmojis?: string[];
  threadAffinity: "prefer_thread" | "new_thread_per_topic" | "channel_root";
  topicChangeThreshold?: number;
}
```

## 優先度とフォールバック

1. **AI社員オーバーライド** — `employees.reply_policy`
2. **組織ポリシー** — `orgs.reply_policy`
3. **デフォルト** — `draft_only` / 絵文字制限 / スレッド優先

## Admin MCP ツール

### replyPolicy.get

読み取り専用、承認不要。

```json
{
  "employeeId": "optional_employee_id"
}
```

レスポンス:
- `policy` — 有効なポリシー
- `source` — `"employee"` / `"org"` / `"default"`
- `layers` — employeeOverride / orgPolicy
- `summaryJa` — 日本語サマリー
- `hasHighRiskAutoSend` — 高リスク設定の有無
- `highRiskConsentRecorded` — 承諾記録の有無

### replyPolicy.patch

人間承認必須（always_human）。

```json
{
  "employeeId": "optional_employee_id",
  "clearOverride": false,
  "policyName": "カスタムポリシー",
  "rules": [
    {
      "afterHoursMode": "draft_only",
      "businessHours": {
        "dayOfWeek": [1, 2, 3, 4, 5],
        "startTime": "09:00",
        "endTime": "18:00",
        "timezone": "Asia/Tokyo"
      },
      "shortReplyMode": "allow",
      "emojiMode": "limited",
      "allowedEmojis": ["👍", "✅"],
      "threadAffinity": "prefer_thread"
    }
  ]
}
```

## 高リスク設定

`afterHoursMode: "allow_send"` は営業時間外でも自動送信を許可します。この設定には明示的なテナント承諾が必要です：

```json
{
  "highRiskConsentAt": "2026-09-08T00:00:00Z",
  "highRiskConsentBy": "admin@example.com"
}
```

## F1 mouth-routing との連携

B2 は F1 の口選択機能を**再発明せず**連携します：

- **口の優先度** — F1 `MouthRoutingPolicy.defaultMouthPriority` を参照
- **二重ゲート** — F1 `dualEgress` との組み合わせでチャネル body は external-safe
- **分離配信** — 内部向け詳細は DM / 限定スレッドへ（F1 決定）

B2 は返信の **タイミングと形式** を制御し、F1 は **送信先と内容の分離** を制御します。

## スキーマ

```sql
-- Migration: 20260908_reply_policy.sql
alter table orgs
  add column if not exists reply_policy jsonb default null;

alter table employees
  add column if not exists reply_policy jsonb default null;
```

## 実装ファイル

- `lib/types.ts` — 型定義
- `lib/gateway/reply-policy-validate.ts` — 検証・正規化
- `lib/gateway/reply-policy.ts` — 適用ロジック
- `lib/data/reply-policy.ts` — ストレージ
- `lib/gateway/adapters/slack.ts` — Slack 統合
- `lib/mcp/admin-tools.ts` — Admin MCP ツール

## 制約

- **会話口 ≠ 承認通知口** — 混在禁止（F1 と同じ）
- **LINE** — 予約スタブのみ（Slack 先行実装）
- **メンション** — チャネル/Connect wake には依然必要
- **D1 / B1 / F6** — 本 PR では実装しない（カタログスタブのみ）

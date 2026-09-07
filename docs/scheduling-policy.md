# A1 Scheduling Policy（日程調整ポリシー）

**更新:** 2026-09-07  
**状態:** shipped-slice（A1完了）  
**次:** F1 口ルーティング → B2 Slack/LINE返信

---

## 概要

`scheduling.policy` は Staffpass のシチュエーションポリシーパック族の最初の実装です。
日程調整（`calendar.propose` / `calendar.confirm`）に適用され、候補スロットのフィルタリング・スコアリング・確定自動化レベルを制御します。

### 設計原則

- **fail-closed**: ルール欠落・衝突時は候補を広げず人間にエスカレート
- **audit labels (F5)**: どのルールで残ったか／落ちたかを記録
- **高リスク警告 + 承諾**: `full_auto` confirm / external 自動 / ポリシーなし自動は silent enable 禁止
- **ポリシー階層**: 従業員オーバーライド → 組織ポリシー → デフォルト (always_human)

---

## スキーマ

### Supabase マイグレーション

```sql
-- supabase/migrations/20260907_scheduling_policy.sql

-- 組織レベル
alter table orgs
  add column if not exists scheduling_policy jsonb;

-- 従業員オーバーライド（オプション）
alter table employees
  add column if not exists scheduling_policy jsonb;
```

### SQL 適用手順（オペレーター向け）

```bash
psql -d <database> -f supabase/migrations/20260907_scheduling_policy.sql
```

---

## ポリシー構造

```typescript
interface OrgSchedulingPolicy {
  version: 1;
  policyId: string;          // sp_xxx
  policyName: string;        // 表示名
  rules: SchedulingRule[];   // first-match順
  highRiskConsentAt?: string;  // ISO timestamp
  highRiskConsentBy?: string;  // 承諾者
  updatedAt: string;
  updatedBy: string;
}

interface SchedulingRule {
  id: string;                           // spr_xxx
  priority?: number;
  locationAffinity?: LocationAffinity;  // office_first | remote_first | hybrid | any
  travelBufferMinutes?: number;
  onlinePack?: OnlineMeetingPack;
  hardBlackout?: TimeWindow[];          // スロット除外
  softPrefer?: TimeWindow[];            // スコア加点
  costCapJpy?: number;                  // コスト上限
  confirmAutomation: ConfirmAutomationLevel;
}

type ConfirmAutomationLevel =
  | "always_human"   // デフォルト・安全
  | "risk_based"     // 高リスク
  | "conditional"    // 高リスク
  | "full_auto";     // 高リスク
```

---

## 高リスク承諾ゲート

`confirmAutomation` が `always_human` 以外の場合、テナントの明示的な承諾が必要です。

```json
{
  "rules": [{ "confirmAutomation": "full_auto" }],
  "highRiskConsentAt": "2026-09-07T00:00:00Z",
  "highRiskConsentBy": "admin@example.com"
}
```

承諾なしで高リスクレベルを設定しようとすると `high_risk_consent_required` エラーが返ります。

---

## Admin MCP ツール

### `schedulingPolicy.get`

読み取り専用。承認不要。

```json
{
  "employeeId": "optional - for per-employee lookup"
}
```

**レスポンス:**

```json
{
  "ok": true,
  "policy": { ... },
  "source": "org",           // "employee" | "org" | "default"
  "layers": {
    "employeeOverride": null,
    "orgPolicy": { ... }
  },
  "summaryJa": "オフィス優先 / 常に人間承認 / 移動30分",
  "sourceJa": "組織ポリシー",
  "nextStepJa": "スケジューリングポリシー設定完了。calendar.propose 呼び出し時に適用されます。",
  "hasHighRiskAutomation": false,
  "highRiskConsentRecorded": false
}
```

### `schedulingPolicy.patch`

`always_human`。人間承認が必要。

```json
{
  "employeeId": "optional - for per-employee override",
  "clearOverride": false,
  "policyName": "カスタムポリシー",
  "rules": [
    {
      "locationAffinity": "office_first",
      "travelBufferMinutes": 30,
      "onlinePack": {
        "enabled": true,
        "calendarTarget": "work@example.com",
        "videoToolAllowlist": [
          { "tool": "zoom", "isDefault": true },
          { "tool": "meet" }
        ]
      },
      "hardBlackout": [
        { "dayOfWeek": [0, 6], "reason": "週末" }
      ],
      "softPrefer": [
        { "startTime": "10:00", "endTime": "12:00", "reason": "午前優先" }
      ],
      "costCapJpy": 50000,
      "confirmAutomation": "always_human"
    }
  ],
  "highRiskConsentAt": "2026-09-07T00:00:00Z",
  "highRiskConsentBy": "admin@example.com",
  "jobId": "job_xxx"
}
```

---

## 適用エンジン

### フロー

```
freebusy/read → apply scheduling.policy → outward propose shows final candidates only
```

### スコアリング

| 条件 | スコア変化 |
|------|-----------|
| 基本スコア | 100 |
| softPrefer 窓内 | +20 |
| office_first + オフィス | +15 |
| remote_first + オンライン | +15 |
| コスト比率 | -0〜10 |
| hardBlackout 窓内 | 除外 (kept=false) |
| costCap 超過 | 除外 (kept=false) |
| videoTool 許可リスト外 | 除外 (kept=false) |
| calendarTarget 不一致 | 除外 (kept=false) |

### 監査ラベル (F5)

```typescript
interface SchedulingAuditLabel {
  slotId: string;
  kept: boolean;
  appliedRules: string[];     // 適用されたルールID
  droppedByRules?: string[];  // 除外したルールID
  reason?: string;            // 理由の詳細
}
```

---

## オンライン設定

### `online_calendar_target`

ポリシーで指定されたカレンダーのみ外部返却可。未指定または不一致は fail-closed。

### `online_video_tool`

許可リスト + デフォルト設定。

```json
{
  "onlinePack": {
    "enabled": true,
    "calendarTarget": "work@example.com",
    "videoToolAllowlist": [
      { "tool": "zoom", "isDefault": true },
      { "tool": "meet" },
      { "tool": "teams" }
    ],
    "defaultVideoTool": "zoom"
  }
}
```

---

## calendar.propose との統合

```typescript
import { applySchedulingPolicyToPropose } from "@/lib/scheduling-policy/propose";

const result = await applySchedulingPolicyToPropose({
  slots: freebusySlots,
  context: { orgId, employeeId, jobId },
  requestedVideoTool: "zoom",
});

// result.finalCandidates - 外部に返す最終候補のみ
// result.effectiveConfirmAutomation - 確定時の自動化レベル
// result.auditMetadata - 監査用メタデータ
```

---

## テスト

```bash
bun test lib/scheduling-policy/
```

51 テストケース:
- 検証 (validate.test.ts): 31 テスト
- 適用エンジン (apply.test.ts): 20 テスト

---

## スライス境界（A1）

### 含む

- ✅ スキーマ（org + employee override）
- ✅ 型定義 + 検証
- ✅ 適用エンジン（unit tested）
- ✅ データレイヤー（CRUD）
- ✅ Admin MCP ツール（get/patch）
- ✅ calendar.propose 統合ヘルパー
- ✅ ドキュメント

### 含まない（A2/A3/F1）

- ❌ 会場/会議室予約 (A2)
- ❌ 出張/訪問 (A3)
- ❌ 口ルーティング (F1)
- ❌ ダッシュボード UI（Admin MCP で十分）
- ❌ auto-confirm 実行パス（always_human がデフォルト）

---

## 関連ドキュメント

- [シチュエーションポリシーカタログ](./staffpass-situation-policy-catalog.md)
- [Admin MCP キックオフレール](./tenant-slack-kickoff-rail.md)

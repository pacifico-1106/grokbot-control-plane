# P1 Plan Rails — プラン別MCPアクセス制御

**機能フラグ:** `P1_PLAN_RAILS_ENABLED`（デフォルトOFF）  
**正本:** `lib/billing/plan-scopes.ts`  
**関連:** [pricing-model.md](./pricing-model.md) | [stripe-billing-notes.md](./stripe-billing-notes.md)

---

## 概要

Plan Railsは、組織のプラン（`intern` / `proper` / `executive`）に応じてMCPツールの利用可能範囲を制御する機能。

**設計原則:**
- プランはツールの**可用性**を制御し、承認要件は制御しない
- `always_human`ツール（send/confirm/order）はプランに関係なく常に人間承認必須
- 不明なプラン、エラー、欠損データ → フェイルクローズド（スコープ拡大なし）
- テナントごとのオーバーライドは縮小のみ可、拡大不可

---

## プラン定義

| プランキー | 対象業務 | ビジネスキャパシティ |
|-----------|----------|---------------------|
| `intern` | 定型・一般事務（日報/議事録下書き、定型メール下書き、FAQ一次返答案） | ≈1業務 |
| `proper` | 営業・顧客対応（Intern + 見積/提案、商談日程、フォローアップ） | ≈3業務 |
| `executive` | 経営補佐・開発保守（Proper + 高度権限設計、監査ログ詳細、開発保守） | 高度運用 |
| `NULL` | レガシー組織 — フィルタなし（既存動作維持） | 全ツール |

**スコープ階層:** `intern ⊂ proper ⊂ executive`（上位プランは下位プランの全ツールを包含）

---

## 機能フラグ動作

### `P1_PLAN_RAILS_ENABLED=OFF`（デフォルト）

**バイト同一性の保証:** フラグOFF時は、Plan Rails導入前のコードと完全に同一の動作を保証。

- すべてのツールが全組織で利用可能（`plan_key = NULL` と同等）
- `plan_key`カラムは存在するがスコープフィルタには使用されない
- プラン変更ハンドラはno-opを返却
- フルフィル時の再チェックはスキップ
- UIは既存表示を維持

### `P1_PLAN_RAILS_ENABLED=ON`

- Gatewayツールは `org.plan_key` → コード定義スコープでフィルタ
- Admin MCPツールは `org.plan_key` → コード定義スコープでフィルタ
- 新規org（Stripe checkout経由）は subscription metadata から `plan_key` を取得
- プラン変更時にスコープ監査と保留中承認のキャンセルを実行
- フルフィル時にプランを再チェック

---

## セキュリティ不変条件

1. **フェイルクローズド:** 不明なプラン、欠損データ、エラー時はツールアクセスを拒否（スコープ拡大なし）
2. **承認要件は不変:** `always_human`マークされたツールはプランに関係なく常に人間承認必須
3. **読み取り専用ツールは非制限:** `*.get`, `*.list`, `*.status`, `*.inspect` などの読み取り専用Admin MCPツールはプランによる制限なし
4. **オーバーライドは縮小のみ:** テナント設定でプランスコープを拡大することは不可
5. **アップグレードは承認必須:** プランアップグレードは `always_human` 承認後に適用
6. **ダウングレードは期末適用:** 通常のダウングレードは請求期間終了時に予約適用
7. **解約・停止は即時:** `canceled` / `suspended` ステータス変更は即座にスコープを縮小

---

## Gatewayツールスコープ

```typescript
// lib/billing/plan-scopes.ts より抜粋
PLAN_GATEWAY_SCOPES = {
  intern: [
    "tools.ping", "tools.read", "calendar.read", "calendar.propose",
    "mail.draft", "files.read", "slack.post", "comm.reply",
    "knowledge.search", "approvals.request"
  ],
  proper: [
    // intern全て +
    "calendar.confirm", "mail.send", "comm.send", "commerce.quote"
  ],
  executive: [
    // proper全て +
    "calendar.allowlist.patch", "files.write", "browser.use",
    "commerce.order", "slack.post_external", "drive.share_external",
    "sns.publish", "audit.append"
  ]
}
```

**注意:** `calendar.confirm`, `mail.send`, `comm.send`, `commerce.order` は `always_human` マークされたツール。プランで利用可能であっても常に人間承認が必要。

---

## Admin MCPツールスコープ

```typescript
// lib/billing/plan-scopes.ts より抜粋
PLAN_ADMIN_SCOPES = {
  intern: [
    // 基本セットアップ
    "employees.issue", "link", "roles.propose",
    // 承認チャネル（InternはLINE対応含む）
    "setup.slackStatus", "setup.slackAdapter.setBotToken",
    "setup.lineApprovalStatus", "setup.lineApproval.upsert",
    // ... 読み取り専用・基本管理ツール
    "orgs.patch", "orgs.issueAdminCredential", "approvals.proxyResolve"
  ],
  proper: [
    // intern全て +
    "policy.patch", "parties.upsert", "approvalWorkflow.patch",
    "schedulingPolicy.patch", "replyPolicy.patch", "mailPolicy.patch",
    "internalAudienceRule.patch", "approvalRoutes.patch"
  ],
  executive: [
    // proper全て +
    "ingressHandoff.patch", "stuckWatch.patch", "stuckWatch.retry",
    "stuckWatch.resolve", "stuckWatch.classify",
    "employeeIdentity.upsert", "employeeIdentity.bindMailbox"
  ]
}
```

**読み取り専用ツール（非制限）:**
```typescript
READ_ONLY_ADMIN_TOOLS = [
  "setup.slackStatus", "setup.lineApprovalStatus", "setup.approverBindingStatus",
  "setup.connectInternalBase", "approvalWorkflow.get", "approvalWorkflow.inspect",
  "approvalWorkflow.listVoterBindings", "ingressHandoff.get",
  "schedulingPolicy.get", "replyPolicy.get", "mailPolicy.get",
  "internalAudienceRule.get", "stuckWatch.get", "stuckWatch.list",
  "stuckWatch.inspect", "approvalRoutes.get", "orgs.status", "employeeIdentity.status"
]
```

---

## プラン変更フロー

### ダウングレード（通常）

```
[Stripe subscription変更] → [processSubscriptionForPlanChange]
                                    ↓
                         [handlePlanDowngrade]
                                    ↓
                         [scheduleOrgPlanDowngrade]
                         scheduled_plan_key = newPlan
                         scheduled_plan_effective_at = period_end
                                    ↓
                         [audit: plan.downgrade_scheduled]

[請求期間終了 / cron] → [applyScheduledDowngrade]
                                    ↓
                         [applyScheduledPlanChange]
                         plan_key = scheduled_plan_key
                         scheduled_plan_key = NULL
                                    ↓
                         [cancelPendingApprovalsForTools]
                         (失効ツールの保留承認をキャンセル)
                                    ↓
                         [audit: plan.downgrade_applied]
```

### アップグレード

```
[Stripe subscription変更] → [processSubscriptionForPlanChange]
                                    ↓
                         [createUpgradeTicket]
                         (always_human承認チケット作成)
                                    ↓
                         [audit: plan.upgrade_requested]

[人間が承認] → [applyApprovedUpgrade]
                     ↓
              [applyImmediatePlanChange]
              plan_key = newPlan
                     ↓
              [audit: plan.upgrade_applied]
```

### 解約・停止（即時）

```
[Stripe subscription canceled/suspended] → [handleBillingStatusChange]
                                                    ↓
                                          [updateOrgBillingStatus]
                                          billing_status = 'canceled' | 'suspended'
                                                    ↓
                                          [cancelPendingApprovalsForTools]
                                          (全ツールの保留承認をキャンセル)
                                                    ↓
                                          [audit: plan.billing_status_narrowed]
```

---

## Stripe連携

### プラン解決

プランは Stripe price の `lookup_key` から解決する。**金額のハードコードは禁止。**

```typescript
// lib/billing/plan-scopes.ts
STRIPE_PRICE_LOOKUP_KEYS = {
  intern: { monthly: "staffpass_plan_intern_monthly", yearly: "staffpass_plan_intern_yearly" },
  proper: { monthly: "staffpass_plan_proper_monthly", yearly: "staffpass_plan_proper_yearly" },
  executive: { monthly: "staffpass_plan_executive_monthly", yearly: "staffpass_plan_executive_yearly" }
}

// Stripe product IDs (参照用、プラン解決には使用しない)
STRIPE_PRODUCT_IDS = {
  intern: "prod_VMIoT9bpVDgzXL",
  proper: "prod_VMIoVllelHMMyh",
  executive: "prod_VMIo0WkobCbV7B"
}
```

### Webhookイベント処理

```typescript
// lib/billing/stripe-plan-webhook.ts
processSubscriptionForPlanChange(event, subscription) {
  // 1. イベント重複排除（stripe_processed_events テーブル）
  // 2. lookup_key からプランキー解決
  // 3. 現在のプランと比較
  // 4. アップグレード → createUpgradeTicket (always_human)
  //    ダウングレード → handlePlanDowngrade (期末予約)
  //    ステータス変更 → handleBillingStatusChange (即時)
}
```

### 重複排除

```sql
-- Stripe webhook イベント重複排除テーブル
CREATE TABLE stripe_processed_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  processed_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- 定期的なクリーンアップ（30日以上前のイベントを削除）
DELETE FROM stripe_processed_events WHERE processed_at < now() - INTERVAL '30 days';
```

---

## フルフィル時再チェック

承認から実行までの間にプランが変更される可能性があるため、フルフィル時に再チェックを行う。

```typescript
// lib/billing/plan-fulfill-recheck.ts

// Gateway ツール用
recheckGatewayToolAtFulfill(orgId, toolId): Promise<RecheckResult>
// → ok: true (実行許可) | ok: false, reason: "plan_changed" (ブロック)

// Admin MCP ツール用
recheckAdminToolAtFulfill(orgId, toolName): Promise<RecheckResult>
```

**フェイル時の動作:**
- 承認済み（pending → approved）のリクエストを `blocked` に変更
- 監査ログに `plan.fulfill_blocked` を記録
- ユーザーにはプラン変更によるブロックを通知

---

## データベーススキーマ

### orgsテーブル拡張

```sql
ALTER TABLE orgs
  ADD COLUMN plan_key TEXT DEFAULT NULL
    CHECK (plan_key IS NULL OR plan_key IN ('intern', 'proper', 'executive')),
  ADD COLUMN billing_status TEXT DEFAULT 'active'
    CHECK (billing_status IN ('active', 'past_due', 'canceled', 'suspended')),
  ADD COLUMN scheduled_plan_key TEXT DEFAULT NULL
    CHECK (scheduled_plan_key IS NULL OR scheduled_plan_key IN ('intern', 'proper', 'executive')),
  ADD COLUMN scheduled_plan_effective_at TIMESTAMP WITH TIME ZONE DEFAULT NULL;
```

### 監査アクション追加

```typescript
type AuditAction =
  // ... 既存 ...
  | "plan.downgrade_scheduled"
  | "plan.downgrade_applied"
  | "plan.downgrade_cancelled"
  | "plan.billing_status_narrowed"
  | "plan.changed"
  | "plan.upgrade_requested"
  | "plan.upgrade_applied"
  | "plan.upgrade_rejected"
  | "plan.fulfill_blocked"
  | "approval.cancelled_by_plan_change"
```

---

## UI表示

### プランバッジ

`components/PlanBadge.tsx` — ヘッダーに現在のプランを表示

### 予約変更バナー

`components/ScheduledPlanChangeBanner.tsx` — ダウングレード予約時に表示

### アップグレードヒント

`components/PlanUpgradeHint.tsx` — ツールがプラン制限でブロックされた際に表示

### React Hook

```typescript
// hooks/usePlanGate.ts
const { planKey, planRailsEnabled, isToolAvailable, scheduledPlanKey } = usePlanGate();

// Gateway ツール可用性チェック
const canSendMail = isToolAvailable('gateway', 'mail.send');

// Admin ツール可用性チェック
const canPatchPolicy = isToolAvailable('admin', 'policy.patch');
```

---

## ロールアウト手順

### 1. マイグレーション適用

```bash
# PR-B マイグレーションを適用
pnpm db:migrate
```

### 2. フラグOFF検証

フラグOFFの状態で本番デプロイし、既存動作に影響がないことを確認:
- 全ツールが利用可能であること
- 承認フローが正常に動作すること
- 監査ログが正常に記録されること

### 3. フラグON（段階的）

```bash
# Vercel環境変数に追加
P1_PLAN_RAILS_ENABLED=true
```

### 4. 既存org のプラン設定

レガシーorg（`plan_key = NULL`）は全ツールにアクセス可能。
必要に応じて手動または Stripe checkout 経由でプランを設定:

```sql
-- 手動設定（管理者のみ）
UPDATE orgs SET plan_key = 'executive' WHERE id = 'org_xxx';
```

---

## トラブルシューティング

### ツールがブロックされる

1. `isPlanRailsEnabled()` が `true` を返しているか確認
2. `org.plan_key` が設定されているか確認
3. 該当ツールがプランスコープに含まれているか `plan-scopes.ts` を確認
4. 読み取り専用ツールは `READ_ONLY_ADMIN_TOOLS` に含まれていれば非制限

### ダウングレードが適用されない

1. `scheduled_plan_key` と `scheduled_plan_effective_at` が設定されているか確認
2. cron ジョブが `applyScheduledDowngrade` を呼び出しているか確認
3. 監査ログで `plan.downgrade_scheduled` / `plan.downgrade_applied` を確認

### アップグレードが適用されない

1. アップグレード承認チケットが作成されているか確認（`plan.upgrade_requested`）
2. チケットが承認されているか確認
3. 承認後に `applyApprovedUpgrade` が呼び出されているか確認

---

## 参照

| ファイル | 内容 |
|---------|------|
| `lib/billing/plan-scopes.ts` | プラン定義・スコープ（正本） |
| `lib/billing/org-plan.ts` | org プランデータ層 |
| `lib/billing/plan-gate.ts` | Gateway/Admin プランゲート |
| `lib/billing/plan-api-gate.ts` | API レベルプランゲート |
| `lib/billing/plan-change-handler.ts` | プラン変更ハンドラ |
| `lib/billing/plan-upgrade-handler.ts` | アップグレードハンドラ |
| `lib/billing/stripe-plan-webhook.ts` | Stripe webhook 処理 |
| `lib/billing/plan-fulfill-recheck.ts` | フルフィル時再チェック |
| `lib/billing/approval-cancellation.ts` | 承認キャンセル処理 |
| `lib/feature-flags.ts` | 機能フラグ定義 |
| `components/PlanBadge.tsx` | プランバッジ表示 |
| `hooks/usePlanGate.ts` | React プランゲートHook |

---

## 変更履歴

| 日付 | 決定 | 内容 |
|------|------|------|
| 2026-10-01 | P1 Plan Rails | 初期設計・実装完了 |

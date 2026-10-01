# プラン別MCP許可リスト・承認ルート設計メモ

**日付:** 2026-10-01  
**起案:** Design Memo (Cloud Agent)  
**ステータス:** Draft  
**関連PR:** #148–#156 (approval-kind-routes 作業)

---

## 1. 背景と目的

AI社員LP (`app/lp/ai-employee`) では 3つのプラン（Intern / Proper / Executive）を販売している。各テナントに対し、プランに応じた：

1. **MCP操作の許可リスト**（どのツールを使えるか）
2. **承認ルートのデフォルト**（誰が承認するか）

をテンプレートとして提供し、**テナント自己セットアップ**と**オペレーター伴走セットアップ**の両方で、プランが許可する範囲を案内しながら環境構築を行う。

---

## 2. プラン定義（ビジネスオーナー指定）

| プラン | 業務キャパ | 対象業務 |
|--------|-----------|---------|
| **Intern** | ≈1業務 | 定型・一般事務（日報/議事録下書き、定型メール下書き、社内案内下書き、予定空き確認、FAQ一次返答案） |
| **Proper** | ≈3業務 | 営業・顧客対応（Intern全て＋問い合わせ一次返信下書き、見積/提案メモ、商談日程候補、対応ログ要約、フォローアップリマインド） |
| **Executive** | 高度運用 | 経営補佐・開発保守（Proper全て＋高度な権限設計、高度な承認ルール運用、監査ログ詳細出力、開発・保守） |

参照: `app/lp/ai-employee/PricingSection.tsx` L46–L120

---

## 3. Per-Plan MCP許可リスト

### 3.1 Gatewayツール→プランマッピング

参照: `lib/gateway/tools.ts` (GATEWAY_TOOL_DEFS)

| Gatewayツール | kind | Intern | Proper | Executive | 業務項目との対応 |
|--------------|------|--------|--------|-----------|-----------------|
| `calendar.read` | read | ✓ | ✓ | ✓ | 予定の空き確認 |
| `calendar.propose` | propose | ✓ | ✓ | ✓ | 予定の空き確認と候補提示 |
| `calendar.confirm` | confirm | ✗ | ✓ | ✓ | 商談・打合せの日程候補提示（確定） |
| `mail.draft` | draft | ✓ | ✓ | ✓ | 定型メール/日報/議事録の下書き |
| `mail.send` | send | ✗ | ✓ | ✓ | 問い合わせへの一次返信 |
| `comm.reply` | mutate | ✓ | ✓ | ✓ | FAQ一次返答案、社内案内下書き |
| `comm.send` | mutate | ✗ | ✓ | ✓ | フォローアップのリマインド |
| `slack.post` | mutate | ✓ | ✓ | ✓ | 社内案内の投稿準備 |
| `commerce.quote` | propose | ✗ | ✓ | ✓ | 見積・提案メモの整理 |
| `commerce.order` | order | ✗ | ✗ | ✓ | 発注（Executiveのみ） |
| `files.read` | read | ✓ | ✓ | ✓ | 顧客対応ログの要約 |
| `files.write` | mutate | ✗ | ✗ | ✓ | 開発・保守（マスタ更新） |
| `browser.use` | mutate | ✗ | ✗ | ✓ | 開発・保守 |
| `knowledge.search` | read | ✓ | ✓ | ✓ | FAQ一次返答案の検索 |
| `audit.append` | mutate | ✗ | ✗ | ✓ | 監査ログ詳細出力 |
| `drive.share_external` | send | ✗ | ✗ | ✓ | 高度な権限設計 |
| `sns.publish` | send | ✗ | ✗ | ✓ | 開発・保守（SNS連携） |

### 3.2 Admin MCPツール→プランマッピング

参照: `lib/mcp/admin-public.ts` (ADMIN_MCP_TOOL_NAMES), `lib/mcp/admin-tools.ts`

| Admin MCPツール | Intern | Proper | Executive | 用途 |
|----------------|--------|--------|-----------|------|
| `employees.issue` | ✓ | ✓ | ✓ | AI社員証発行 |
| `link` | ✓ | ✓ | ✓ | Grok Bot紐付け |
| `policy.patch` | ✗ | ✓ | ✓ | カスタム承認フロー設定 |
| `parties.upsert` | ✗ | ✓ | ✓ | 相手台帳（複数チャネル対応） |
| `channels.classify` | ✗ | ✓ | ✓ | チャネル分類（複数チャネル対応） |
| `roles.propose` | ✓ | ✓ | ✓ | 役割提案 |
| `setup.slackStatus` | ✓ | ✓ | ✓ | Slack診断 |
| `setup.slackAdapter.setBotToken` | ✓ | ✓ | ✓ | Slackアダプタ設定 |
| `ingressHandoff.get/patch` | ✗ | ✗ | ✓ | 高度な権限設計 |
| `schedulingPolicy.get/patch` | ✗ | ✓ | ✓ | カスタム承認フロー |
| `replyPolicy.get/patch` | ✗ | ✓ | ✓ | 返信ポリシー |
| `mailPolicy.get/patch` | ✗ | ✓ | ✓ | メールポリシー |
| `approvalWorkflow.*` | ✗ | ✓ | ✓ | 承認ワークフロー設定 |
| `stuckWatch.*` | ✗ | ✗ | ✓ | スタック監視（週次レポート機能の基盤） |

### 3.3 ギャップ分析（既存ツールなし）

| 業務項目 | 必要な機能 | ギャップ |
|---------|-----------|---------|
| 週次レポート（Proper機能） | 自動要約・定期配信 | **要実装**: `report.weekly` ツールまたは cron job |
| 週次論点整理（Executive） | 経営向けサマリー生成 | **要実装**: 上記の拡張 |
| 開発・保守の調査と実装案 | コード分析・PR作成 | **外部連携**: Cursor Agent / GitHub MCP（スコープ外） |

---

## 4. デフォルト承認ルート（per-plan）

### 4.1 承認種別（approval kind）とルートの対応

参照: PR #148 `lib/approval-kind-routes/types.ts`

| kind | 説明 | always_human |
|------|------|--------------|
| `post` | Slack/LINE投稿 | ✗（audience-gated） |
| `mail` | メール送信 | ✓ (`mail.send`) |
| `account` | org/admin操作 | ✓ (owner/adminのみ) |
| `decision` | 稟議（D1–D4対応） | ✓ (tier別) |
| `other` | その他confirm/send/order | ✓ |

### 4.2 プラン別デフォルトルート

**セキュリティ不変条件**（PR #148–#156 より）:
- `send` / `pay` / `confirm` は常に `always_human`
- AI approverは禁止 (`ai_approver_forbidden`)
- self-approvalは禁止 (`self_approval_forbidden`)
- `account` kindはowner/adminのみ
- ツール→kind マッピングはコード固定（テナント変更不可）

#### Intern プラン

```typescript
{
  version: 1,
  policyId: "plan_intern_default",
  policyName: "Intern デフォルト承認ルート",
  routes: [
    {
      kind: "post",
      approverUserIds: [], // 内部 audience は自動、外部は fail-closed
      quorum: { type: "any" },
      onExpire: "fail_closed",
      remindEveryDays: 1,
    },
    {
      kind: "mail",
      approverUserIds: ["{{owner}}"], // プレースホルダー: org owner
      quorum: { type: "any" },
      onExpire: "fail_closed",
      remindEveryDays: 1,
    },
    {
      kind: "account",
      approverUserIds: ["{{owner}}"],
      quorum: { type: "any" },
      onExpire: "fail_closed",
      remindEveryDays: 1,
    },
    {
      kind: "other",
      approverUserIds: ["{{owner}}"],
      quorum: { type: "any" },
      onExpire: "fail_closed",
      remindEveryDays: 1,
    },
  ],
}
```

#### Proper プラン

```typescript
{
  version: 1,
  policyId: "plan_proper_default",
  policyName: "Proper デフォルト承認ルート",
  routes: [
    {
      kind: "post",
      approverUserIds: [], // audience-gated
      quorum: { type: "any" },
      topicGate: { enabled: true, sensitiveTopics: [...DEFAULT_SENSITIVE_TOPICS] },
      onExpire: "fail_closed",
      remindEveryDays: 1,
    },
    {
      kind: "mail",
      approverUserIds: ["{{owner}}", "{{admins}}"], // 複数承認者
      quorum: { type: "any" },
      onExpire: "fail_closed",
      remindEveryDays: 1,
    },
    {
      kind: "account",
      approverUserIds: ["{{owner}}"],
      quorum: { type: "any" },
      onExpire: "fail_closed",
      remindEveryDays: 1,
    },
    {
      kind: "decision",
      // T1/T2/T3 tier routes with thresholds
      tiers: [...DEFAULT_DECISION_TIERS],
    },
    {
      kind: "other",
      approverUserIds: ["{{owner}}", "{{admins}}"],
      quorum: { type: "any" },
      onExpire: "fail_closed",
      remindEveryDays: 1,
    },
  ],
  topicGate: {
    enabled: true,
    sensitiveTopics: ["決算", "役員", "人事", "給与", "個人情報"],
    mainBoardChannelIds: [],
  },
}
```

#### Executive プラン

```typescript
{
  version: 1,
  policyId: "plan_executive_default",
  policyName: "Executive デフォルト承認ルート",
  routes: [
    // Proper と同様だが、より詳細な設定が可能
    // finalGoUserId, deadlineHours, voterWeights が設定可能
  ],
  topicGate: {
    enabled: true,
    sensitiveTopics: [...EXTENDED_SENSITIVE_TOPICS],
    mainBoardChannelIds: [], // テナント設定可能
  },
  decisionWorkflow: {
    enabled: true,
    amountThresholdJpy: 100000,
    tiers: [...FULL_DECISION_TIERS], // T1/T2/T3 + 稟議
  },
}
```

---

## 5. セットアップ案内順序

### 5.1 テナント自己セットアップ（セルフサービス）

#### Intern

1. `orgs.create` → 組織作成
2. `roles.propose` → AI社員の役割定義
3. `employees.issue` → AI社員証発行（scopes制限: Internスコープのみ）
4. `link` → Grok Bot紐付け
5. `setup.slackStatus` → Slack連携診断
6. `setup.slackAdapter.setBotToken` → Slackアダプタ設定
7. **完了**: 基本運用開始

#### Proper

1–6: Intern と同様  
7. `channels.classify` → チャネル分類（複数チャネル対応）  
8. `parties.upsert` → 相手台帳登録  
9. `schedulingPolicy.patch` → 日程調整ポリシー  
10. `replyPolicy.patch` → 返信ポリシー  
11. `approvalWorkflow.patch` → カスタム承認フロー  
12. **完了**: 週次レポート設定案内

#### Executive

1–11: Proper と同様  
12. `ingressHandoff.patch` → 高度な権限設計  
13. `stuckWatch.patch` → スタック監視設定  
14. `approvalWorkflow.patch` → 稟議ワークフロー（T1/T2/T3）  
15. **完了**: 監査ログ出力設定案内

### 5.2 オペレーター伴走セットアップ

Admin MCPを使用し、上記順序に従って案内。各ステップで：

1. **プランの許可範囲を表示**: 「このプランでは X が使用可能です」
2. **スコープ超過を警告**: 「この操作は上位プランが必要です。アップグレードをご検討ください」
3. **推奨設定を提案**: 「〇〇業務には△△の設定をお勧めします」

---

## 6. プラン変更（アップグレード・ダウングレード）

### 6.1 アップグレード

1. **Stripe subscription 更新**: webhook `customer.subscription.updated`
2. **スコープ拡張**: 新プランの許可スコープを追加
3. **承認ルートは維持**: 既存設定を保持（新機能は案内のみ）
4. **監査ログ**: `plan_upgraded` イベント記録

### 6.2 ダウングレード（fail-closed）

**重要**: プラン変更自体が `always_human` 承認必須

1. **Stripe subscription 更新**: webhook `customer.subscription.updated`
2. **スコープ剥奪**: 新プランを超えるスコープを無効化
   ```typescript
   const revokedScopes = currentScopes.filter(s => !newPlanScopes.includes(s));
   ```
3. **保留中の承認を処理**:
   - 剥奪スコープに関連する `pending` 承認 → `expired` に変更
   - 理由: `plan_downgrade_scope_revoked`
4. **既存オーバーライドの処理**:
   - 従業員別オーバーライド (`approval_kind_routes_override`) で新プラン外の設定 → 警告ログ + 無効化
5. **監査ログ**: `plan_downgraded` イベント（剥奪スコープ一覧を含む）
6. **通知**: owner/admin に変更サマリーをメール/Slack送信

```typescript
// lib/billing/plan-change.ts (新規)
export async function handlePlanDowngrade(
  orgId: string,
  oldPlanKey: PlanKey,
  newPlanKey: PlanKey,
  approvalId: string // always_human 承認ID
): Promise<PlanChangeResult> {
  // 1. 承認済みか確認
  const approval = await getApproval(approvalId);
  if (approval.status !== "approved") {
    throw new Error("plan_change_requires_approval");
  }

  // 2. スコープ差分計算
  const oldScopes = PLAN_SCOPES[oldPlanKey];
  const newScopes = PLAN_SCOPES[newPlanKey];
  const revokedScopes = oldScopes.filter(s => !newScopes.includes(s));

  // 3. pending 承認を expire
  await expirePendingApprovals(orgId, revokedScopes);

  // 4. オーバーライド無効化
  await disableOutOfPlanOverrides(orgId, newScopes);

  // 5. 監査ログ
  await appendAuditLog({
    orgId,
    event: "plan_downgraded",
    metadata: { oldPlanKey, newPlanKey, revokedScopes, approvalId },
  });

  return { success: true, revokedScopes };
}
```

---

## 7. Stripe連携

### 7.1 現状の実装

参照: 
- `app/api/lp/ai-employee/checkout/route.ts` — チェックアウトセッション作成
- `app/api/webhooks/stripe/route.ts` — webhook処理
- `lib/data/subscriptions.ts` — subscription upsert

### 7.2 真実の源（Source of Truth）

| データ | Source of Truth |
|--------|----------------|
| `planKey` | Stripe subscription metadata |
| `status` | Stripe subscription status (mapped) |
| `trialEndsAt` | Stripe `trial_end` |
| `currentPeriodEnd` | Stripe `current_period_end` |

### 7.3 webhook駆動の同期

```typescript
// 現状: app/api/webhooks/stripe/route.ts L159-L172
case "customer.subscription.created":
case "customer.subscription.updated":
case "customer.subscription.deleted": {
  const sub = event.data.object as Stripe.Subscription;
  const result = await syncSubscriptionFromStripe(sub);
  // ...
}
```

**拡張必要**: `customer.subscription.updated` で `planKey` 変更を検知し、`handlePlanDowngrade` / `handlePlanUpgrade` を呼び出す。

### 7.4 冪等性キー

現状のチェックアウト作成には冪等性キーが**未設定**。

```typescript
// 追加が必要: app/api/lp/ai-employee/checkout/route.ts
const session = await stripe.checkout.sessions.create({
  // ...existing config
}, {
  idempotencyKey: `checkout_${orgId}_${plan}_${Date.now()}`,
});
```

### 7.5 支払い失敗時の挙動

```typescript
// 現状: webhook L174-L191
case "invoice.paid":
case "invoice.payment_failed": {
  // sync subscription status
}
```

**拡張必要**:
- `payment_failed` → `status: "past_due"` に更新
- 猶予期間（3日）後に `status: "suspended"` に変更
- suspended 時は `always_human` 承認以外をブロック

---

## 8. データモデルとマイグレーション

### 8.1 新規テーブル

```sql
-- plan_templates: プラン別デフォルト設定
CREATE TABLE plan_templates (
  plan_key TEXT PRIMARY KEY, -- 'intern' | 'proper' | 'executive'
  gateway_scopes TEXT[] NOT NULL,
  admin_scopes TEXT[] NOT NULL,
  approval_kind_routes_policy JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- RLS: read-only for all authenticated
ALTER TABLE plan_templates ENABLE ROW LEVEL SECURITY;
CREATE POLICY "read_all" ON plan_templates FOR SELECT USING (true);
```

### 8.2 既存テーブル変更

```sql
-- orgs: plan_key カラム追加
ALTER TABLE orgs ADD COLUMN plan_key TEXT DEFAULT 'intern';
ALTER TABLE orgs ADD CONSTRAINT fk_plan_key FOREIGN KEY (plan_key) REFERENCES plan_templates(plan_key);

-- employees: effective_scopes を plan_key から導出
-- (実装時はアプリケーション層で計算)
```

### 8.3 マイグレーション

```sql
-- 20261001_plan_rails.sql
-- 1. plan_templates 作成
-- 2. orgs.plan_key 追加
-- 3. 既存 orgs は subscriptions.plan_key を参照して設定
UPDATE orgs o
SET plan_key = COALESCE(
  (SELECT s.plan_key FROM subscriptions s WHERE s.org_id = o.id),
  'intern'
);
```

---

## 9. フィーチャーフラグ

参照: `lib/feature-flags.ts`

```typescript
// 追加: lib/feature-flags.ts
/**
 * P1-PLAN-RAILS: Plan-based MCP allowlists and approval route templates.
 *
 * When ON:
 * - Gateway tools are filtered by org.plan_key → plan_templates.gateway_scopes
 * - Admin MCP tools are filtered by org.plan_key → plan_templates.admin_scopes
 * - New orgs get approval_kind_routes_policy from plan_templates
 * - Plan changes trigger scope audit and pending approval expiration
 *
 * When OFF (default):
 * - Existing behavior preserved
 * - All scopes available to all orgs
 */
export function isPlanRailsEnabled(): boolean {
  return parseFlag(process.env.P1_PLAN_RAILS_ENABLED);
}
```

---

## 10. PR 分割と工数見積もり

| PR# | 内容 | 工数 | 依存 |
|-----|------|------|------|
| **PR-A** | `plan_templates` テーブル + マイグレーション + seed data | 3h | - |
| **PR-B** | `orgs.plan_key` カラム追加 + 既存データマイグレーション | 2h | PR-A |
| **PR-C** | Feature flag `P1_PLAN_RAILS_ENABLED` + Gateway scope filtering | 4h | PR-B |
| **PR-D** | Admin MCP scope filtering | 4h | PR-C |
| **PR-E** | Plan change handlers (upgrade/downgrade) | 6h | PR-D |
| **PR-F** | Stripe webhook拡張 (plan change detection) | 3h | PR-E |
| **PR-G** | Setup guidance (plan-aware messaging) | 4h | PR-D |
| **PR-H** | 週次レポート機能（ギャップ実装） | 8h | PR-D |
| **PR-I** | 監査ログ詳細出力（Executive機能） | 4h | PR-D |
| **PR-J** | E2Eテスト + ドキュメント | 4h | PR-I |

### 合計: 42h

### リスク

1. **既存テナントの互換性**: `plan_key` 未設定の既存 org は `intern` にフォールバック。スコープ削減が発生する可能性あり。
2. **Stripe Price ID の整合性**: 現状の `STRIPE_PRICE_ID_AI_EMP_*` 環境変数と `plan_key` の対応が不完全。
3. **approval-kind-routes との統合**: PR #148–#156 が merge 前のため、依存関係に注意。

---

## 11. オープンクエスチョン（ビジネスオーナー確認事項）

1. **Intern の `mail.send` 許可**: FAQ一次返答案を「送信」まで自動化するか、下書きのみか？
2. **週次レポートの配信先**: Slack/メール/両方？Executive は経営向けにカスタマイズ可能？
3. **ダウングレード猶予期間**: 即時スコープ剥奪か、X日間の移行期間を設けるか？
4. **既存テナントのマイグレーション**: `plan_key` 未設定 org の扱い（通知後に設定 or デフォルト適用）？
5. **Custom プランの扱い**: `plan_templates` に含めるか、完全に個別設定か？

---

## 12. 参照ファイル

- `app/lp/ai-employee/PricingSection.tsx` — プラン定義UI
- `lib/gateway/tools.ts` — Gateway tool allowlist
- `lib/mcp/admin-tools.ts` — Admin MCP tools
- `lib/mcp/admin-public.ts` — Admin tool names
- `lib/approval-kind-routes/types.ts` (PR #148) — Approval kind routes
- `lib/data/subscriptions.ts` — Subscription data layer
- `app/api/webhooks/stripe/route.ts` — Stripe webhook
- `lib/feature-flags.ts` — Feature flags

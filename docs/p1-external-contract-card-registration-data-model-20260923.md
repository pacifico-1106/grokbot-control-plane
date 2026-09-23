# P1 外部契約カード登録 データモデル設計

**更新:** 2026-09-23  
**状態:** 📐 PROPOSED — **ドキュメントのみ**（実装 GO は別途セキュリティ監査ゲート後）  
**親設計ロック:** [p1-external-contract-card-registration-design-20260923.md](./p1-external-contract-card-registration-design-20260923.md)  
**関連:** [stripe-billing-notes.md](./stripe-billing-notes.md) · [supabase/schema.sql](../supabase/schema.sql)

---

## 概要

本ドキュメントは P1 外部契約カード登録のデータモデル提案である。親設計メモ（PR #119 でマージ済み）のロック済み決定に基づき、以下を詳細化する：

- Org ↔ Stripe Customer + PaymentMethod の主ストア
- カード登録関連の監査テーブル
- インデックス・一意性・NULL 許容規則
- jsonb metadata に入れてはいけないもの
- 既存テーブルとの関係

**注意:** 本ドキュメントに含まれる SQL は **ドキュメント内サンプル** であり、`supabase/migrations/` に配置しない。実装 GO 後に別 PR でマイグレーションを作成する。

---

## ロック済み決定の再確認（親設計メモより）

| # | 決定 |
|---|------|
| **L1** | PAN / CVV / expiry / card_fingerprint を **絶対に保存しない** |
| **L4** | 保存可: `stripe_customer_id`, `stripe_payment_method_id`（トークン参照のみ）、契約メタデータ、監査イベント |
| **L7** | デフォルト = **Org (tenant) Customer**（org 単位で 1 つの Stripe Customer） |
| **L8** | AI社員パック Checkout と **分離**（既存 `subscriptions` / Checkout セッションとは別テーブル） |
| **L9** | 支払い方法 bind / change = **always_human**（approval_id 必須） |

---

## 既存テーブルとの関係

### `orgs.stripe_customer_id`

既存の `orgs` テーブルには `stripe_customer_id` カラムが存在する。これは AI社員パック Checkout フローで Stripe Customer を作成する際に設定される。

```sql
-- supabase/schema.sql より抜粋
create table if not exists orgs (
  ...
  stripe_customer_id text,
  ...
);
```

**提案:** 外部契約カード登録でも **同じ `orgs.stripe_customer_id`** を使用する。org 単位で 1 つの Stripe Customer という v1 制約に合致し、Stripe Customer の重複作成を防ぐ。

- AI社員パック Checkout: `orgs.stripe_customer_id` に Customer 作成/取得
- 外部契約カード登録: 同じ Customer に PaymentMethod をアタッチ

既存の `getOrgStripeCustomerId` / `setOrgStripeCustomerId` 関数（`lib/data/subscriptions.ts`）を再利用可能。

### `subscriptions` テーブル

既存の `subscriptions` テーブルは AI社員パックの **サブスクリプション状態** を管理する：

```sql
create table if not exists subscriptions (
  id uuid primary key,
  org_id uuid not null references orgs(id),
  plan_key text not null,
  status text not null,
  stripe_subscription_id text,
  ...
);
```

**提案:** 外部契約カード登録は `subscriptions` テーブルを **拡張しない**。目的が異なる：

| テーブル | 目的 |
|----------|------|
| `subscriptions` | AI社員パックの月額/トライアル状態 |
| `org_external_contract_payment_methods`（新規） | 外部契約の支払い方法アタッチ状態 |

### `approval_requests` テーブル

支払い方法の bind / change は **always_human** 承認が必要。既存の `approval_requests` テーブルを使用し、監査テーブルで `approval_id` を参照する。

### `audit_events` テーブル

既存の汎用監査テーブル。外部契約カード登録専用のイベントは **別テーブル** を提案する理由：

1. 専用テーブルの方がセキュリティレビューで追跡しやすい
2. カード登録固有のカラム（`stripe_session_id`, `outcome`）を追加しやすい
3. 将来的に PCI DSS 関連のログ保持要件が異なる可能性

ただし、重要イベントは `audit_events` にも **重複記録** することを推奨（監査横断検索用）。

---

## 新規テーブル提案

### 1. `org_external_contract_payment_methods`

外部契約の支払い方法登録状態を管理する主テーブル。

#### 設計方針

- `orgs.stripe_customer_id` を参照（重複保存しない）
- org 単位で **1 つだけアクティブな PaymentMethod**（v1 制約）
- セットアップ中の「ペンディング」行も許容（Checkout session 作成後、完了前）

#### スキーマ

```sql
-- PROPOSED — do not apply until impl GO

create table if not exists org_external_contract_payment_methods (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  
  -- Stripe PaymentMethod ID (token reference only)
  stripe_payment_method_id text,
  
  -- Setup status
  setup_status text not null default 'pending'
    check (setup_status in ('pending', 'completed', 'failed', 'removed')),
  
  -- Setup completion metadata
  setup_completed_at timestamptz,
  setup_completed_by uuid references org_members(id) on delete set null,
  setup_approval_id uuid references approval_requests(id) on delete set null,
  
  -- Stripe SetupIntent ID (for tracking pending setup)
  stripe_setup_intent_id text,
  
  -- Contract metadata (PAN-free)
  metadata jsonb not null default '{}'::jsonb,
  
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table org_external_contract_payment_methods is
  'P1 external contract payment method registration. Stores PaymentMethod token reference only — never PAN/CVV/expiry/fingerprint.';

comment on column org_external_contract_payment_methods.stripe_payment_method_id is
  'Stripe PaymentMethod ID (pm_xxx). Token reference only — card details remain in Stripe.';

comment on column org_external_contract_payment_methods.setup_approval_id is
  'always_human approval ID for bind/change. Required for completed status.';

comment on column org_external_contract_payment_methods.metadata is
  'Contract metadata. FORBIDDEN: card_number, cvv, expiry, card_fingerprint, full PAN, billing address with card details.';
```

#### インデックス

```sql
-- PROPOSED — do not apply until impl GO

-- Primary lookup: org's payment method
create index if not exists org_ext_contract_pm_org_idx
  on org_external_contract_payment_methods (org_id, setup_status);

-- Ensure only one active/completed payment method per org
create unique index if not exists org_ext_contract_pm_one_active_per_org
  on org_external_contract_payment_methods (org_id)
  where setup_status = 'completed';

-- SetupIntent lookup (for webhook processing)
create index if not exists org_ext_contract_pm_setup_intent_idx
  on org_external_contract_payment_methods (stripe_setup_intent_id)
  where stripe_setup_intent_id is not null;
```

#### RLS

```sql
-- PROPOSED — do not apply until impl GO

alter table org_external_contract_payment_methods enable row level security;

drop policy if exists org_ext_contract_pm_select on org_external_contract_payment_methods;
drop policy if exists org_ext_contract_pm_write_admin on org_external_contract_payment_methods;

create policy org_ext_contract_pm_select on org_external_contract_payment_methods
  for select using (public.is_org_member(org_id));

create policy org_ext_contract_pm_write_admin on org_external_contract_payment_methods
  for all using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));
```

#### NULL 許容規則

| カラム | NULL 許容 | 理由 |
|--------|----------|------|
| `stripe_payment_method_id` | ✓ | pending 状態では未設定 |
| `setup_completed_at` | ✓ | completed 時のみ設定 |
| `setup_completed_by` | ✓ | completed 時のみ設定（webhook 経由の場合は user 不明の可能性） |
| `setup_approval_id` | ✓ | completed 時のみ必須（アプリケーション層で検証） |
| `stripe_setup_intent_id` | ✓ | Checkout session 作成時に設定 |

---

### 2. `audit_external_contract_card_events`

カード登録に特化した監査テーブル。

#### 設計方針

- 全イベントを時系列で記録
- `approval_id` は bind / change イベントで **必須**
- Stripe session ID は監査用に記録（秘密ではない）
- **PAN / CVV / expiry / fingerprint は絶対に記録しない**

#### スキーマ

```sql
-- PROPOSED — do not apply until impl GO

create table if not exists audit_external_contract_card_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  
  -- Action type
  action text not null
    check (action in (
      'link_opened',           -- Setup link clicked
      'setup_completed',       -- SetupIntent succeeded
      'setup_failed',          -- SetupIntent failed
      'setup_expired',         -- Checkout session expired
      'portal_opened',         -- Customer Portal link clicked
      'method_changed',        -- PaymentMethod changed via Portal
      'method_removed',        -- PaymentMethod removed via Portal
      'card_like_string_blocked'  -- PAN-like string detected and blocked
    )),
  
  -- Actor (human who performed the action)
  actor_user_id uuid references org_members(id) on delete set null,
  actor_email text,
  
  -- Approval reference (required for setup_completed / method_changed)
  approval_id uuid references approval_requests(id) on delete set null,
  
  -- Stripe session reference (not secret)
  stripe_session_id text,
  
  -- Outcome
  outcome text
    check (outcome in ('success', 'failure', 'expired', 'blocked', null)),
  
  -- Event metadata (PAN-free)
  metadata jsonb not null default '{}'::jsonb,
  
  created_at timestamptz not null default now()
);

comment on table audit_external_contract_card_events is
  'P1 external contract card setup audit log. NEVER store PAN/CVV/expiry/fingerprint in any column including metadata.';

comment on column audit_external_contract_card_events.approval_id is
  'always_human approval ID. Required for setup_completed / method_changed actions.';

comment on column audit_external_contract_card_events.stripe_session_id is
  'Stripe Checkout or Portal session ID for audit trail. Not a secret.';

comment on column audit_external_contract_card_events.metadata is
  'Additional event context. FORBIDDEN: card_number, cvv, expiry, card_fingerprint, error messages containing card data.';
```

#### インデックス

```sql
-- PROPOSED — do not apply until impl GO

-- Primary lookup: org's card events timeline
create index if not exists audit_ext_card_org_created_idx
  on audit_external_contract_card_events (org_id, created_at desc);

-- Action-specific queries
create index if not exists audit_ext_card_action_idx
  on audit_external_contract_card_events (org_id, action, created_at desc);

-- Approval reference lookup
create index if not exists audit_ext_card_approval_idx
  on audit_external_contract_card_events (approval_id)
  where approval_id is not null;

-- Security monitoring: blocked events
create index if not exists audit_ext_card_blocked_idx
  on audit_external_contract_card_events (created_at desc)
  where action = 'card_like_string_blocked';
```

#### RLS

```sql
-- PROPOSED — do not apply until impl GO

alter table audit_external_contract_card_events enable row level security;

drop policy if exists audit_ext_card_select on audit_external_contract_card_events;
drop policy if exists audit_ext_card_insert_member on audit_external_contract_card_events;

-- Member can read org's audit log
create policy audit_ext_card_select on audit_external_contract_card_events
  for select using (public.is_org_member(org_id));

-- Service role inserts (webhook handler, etc.)
-- Browser inserts blocked — audits come from server-side only
create policy audit_ext_card_insert_member on audit_external_contract_card_events
  for insert with check (public.is_org_member(org_id));
```

---

## `metadata` jsonb に入れてはいけないもの

### 絶対禁止（親設計 L1 より）

| 禁止項目 | 理由 |
|----------|------|
| `card_number` / `pan` | 生カードデータ |
| `cvv` / `cvc` / `security_code` | セキュリティコード |
| `expiry` / `exp_month` / `exp_year` | 有効期限 |
| `card_fingerprint` | Stripe fingerprint も保存禁止（必要なら API で都度取得） |
| `full_billing_address` | カードと紐づく完全住所 |

### 注意（保存可能だが最小限に）

| 項目 | 扱い |
|------|------|
| `last4` | Stripe が提供する場合のみ、表示用に保存可。ただし本テーブルでは保存しない方針を推奨（必要なら Stripe API から取得） |
| `brand` | 同上 |
| `billing_country` | 請求国のみなら可。完全住所は不可 |

### 推奨 metadata 構造

```json
{
  "contract_type": "external_service",
  "contract_ref": "contract-2026-001",
  "setup_source": "admin_mcp",
  "setup_channel": "slack"
}
```

---

## Webhook ペイロード処理のセキュリティガイダンス

### `setup_intent.succeeded` Webhook

```typescript
// ガイダンスモード — 実装コードではない

// ✓ 保存可
const paymentMethodId = event.data.object.payment_method; // pm_xxx
const customerId = event.data.object.customer; // cus_xxx

// ❌ 保存禁止（Webhook ペイロードに含まれていても無視）
// event.data.object.payment_method_details.card.fingerprint
// event.data.object.payment_method_details.card.last4
// event.data.object.payment_method_details.card.exp_month
```

### ログ出力の注意

```typescript
// ❌ NG — ペイロード全体をログ
console.log('Webhook payload:', JSON.stringify(event.data));

// ✓ OK — 必要な情報のみ
console.log('Setup completed:', { 
  customerId: event.data.object.customer,
  setupIntentId: event.data.object.id,
  orgId: orgId
});
```

---

## バックログ項目 #2 完了、#3–#7 保留

親設計メモのバックログ順序より：

| # | 項目 | 状態 |
|---|------|------|
| 1 | 設計メモ | ✅ 完了（PR #119） |
| 2 | データモデル | ✅ **本ドキュメント** |
| 3 | Mint deep link | 🔲 保留（実装 GO 後） |
| 4 | Stripe Webhook | 🔲 保留（実装 GO 後） |
| 5 | Customer Portal link mint | 🔲 保留（実装 GO 後） |
| 6 | Detector 拡張 | 🔲 保留（実装 GO 後） |
| 7 | 完全セキュリティ監査 | 🔲 保留（本番有効化前に必須） |

---

## 関連ドキュメント

- [p1-external-contract-card-registration-design-20260923.md](./p1-external-contract-card-registration-design-20260923.md) — 親設計ロック
- [stripe-billing-notes.md](./stripe-billing-notes.md) — Stripe Checkout / Webhook の既存実装
- [agent-commerce/cross-product-commerce-event-contract-v1.md](./agent-commerce/cross-product-commerce-event-contract-v1.md) — `card PAN/CVC` を forbidden data として明記
- [security-review-20260916.md](./security-review-20260916.md) — セキュリティレビュー基準

---

---

## 実装状況

**実装完了:** 2026-09-23  
**フラグ名:** `EXTERNAL_CONTRACT_CARD_SETUP`  
**デフォルト:** `0`（OFF）

マイグレーションファイル: `supabase/migrations/20260923_external_contract_card_setup.sql`

⚠️ **本番環境では `EXTERNAL_CONTRACT_CARD_SETUP=0`（デフォルト）を維持してください。**

本番有効化には完全なセキュリティ監査と別途 GO が必要です。

---

## 変更履歴

| 日付 | 担当 | 内容 |
|------|------|------|
| 2026-09-23 | Cloud Agent | Initial data model proposal |
| 2026-09-23 | Cloud Agent | Implementation (flag OFF, pending security audit) |

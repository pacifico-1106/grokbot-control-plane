# Stripe billing notes（JP SME / Staffpass）

Sealith docs/stripe-billing-strategy.md から trial → Checkout → webhook 同期の考え方のみ参照。
価格表・R2 原価計算・紹介クレジットは移植しない。**円価格は Dashboard が正** — コードや UI に実額を事実として書かない。

## フロー

1. `/signup` → トライアル開始（`TRIAL_DAYS`、既定 14）+ `subscriptions` 行（trialing）
2. `/app/billing` → `POST /api/billing/checkout`
3. Stripe Checkout `mode=subscription` + `trial_period_days`
   - `client_reference_id` = orgId
   - `metadata.orgId` / `metadata.org_id` / `planKey`
   - `subscription_data.metadata` にも同じ orgId
   - Customer は org 単位で create/retrieve → `orgs.stripe_customer_id`
4. `POST /api/webhooks/stripe` で `subscriptions` 同期（+ customer id）
5. `customer.subscription.trial_will_end` → Resend `trial_ending`
6. 支払い方法変更・解約 → `POST /api/billing/portal`（Customer Portal）

## ステータス・エンタイトルメント

| Stripe status | 当社 `SubscriptionStatus` | 本番 soft-gate |
|---------------|---------------------------|----------------|
| trialing / active | 同名 | 雇用・チーム OK |
| past_due / unpaid / paused→past_due | past_due / unpaid | 雇用・チーム 402 |
| canceled | canceled | 同上 |
| incomplete / incomplete_expired | incomplete | 同上 |

DEMO（Supabase `replace_me_*`）では常に許可。メッセージは日本語。

実装: `lib/billing/entitlements.ts` · `lib/data/subscriptions.ts`

## 支払い方法

- **card** — 常時 Checkout に含める
- **customer_balance** — 日本の銀行振込・請求書寄り。Dashboard 有効化後に `STRIPE_ENABLE_CUSTOMER_BALANCE=1`

## プラン表示名（プレースホルダのみ）

| planKey | 表示名（案） | 価格 |
|---------|--------------|------|
| starter | スターター | `{{STARTER_PRICE}}`（Dashboardで設定） |
| business | ビジネス | `{{BUSINESS_PRICE}}`（Dashboardで設定） |
| managed | Managed（Care） | `{{MANAGED_PRICE}}`（Dashboardで設定） |

メーター・仮枠の詳細は `docs/pricing-model.md`。

## 必要な env

- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`
- `STRIPE_PRICE_ID_STARTER` / `STRIPE_PRICE_ID_BUSINESS` / `STRIPE_PRICE_ID_MANAGED`
- `STRIPE_ENABLE_CUSTOMER_BALANCE`（任意・`1` で Checkout に振込系を追加）
- `BILLING_NOTIFY_EMAIL`（webhook 通知先）
- `TRIAL_DAYS` / `NEXT_PUBLIC_APP_URL`

キーが `replace_me_*` のあいだ Checkout / Portal / Webhook はスタブ。`bun run build` にライブキー不要。

## Dashboard チェックリスト（キー投入前〜）

1. **Products / Prices** — スターター・ビジネス・Managed/Care（JPY 定期）。Price ID を env へ
2. **Webhook** — `https://<domain>/api/webhooks/stripe`  
   推奨イベント: `customer.subscription.created|updated|deleted`, `invoice.paid`, `invoice.payment_failed`, `customer.subscription.trial_will_end`, `checkout.session.completed`
3. **Customer Portal** — Settings → Billing → Customer portal（プラン変更・支払方法・解約）
4. **customer_balance**（任意）— 銀行振込フローを有効化してから env=1
5. **Test vs Live** — テストキーで E2E → 本番キーは cutover 最後
6. **署名秘密** — Webhook signing secret → `STRIPE_WEBHOOK_SECRET`

詳細な本番順序は `docs/production-cutover.md` の Stripe 節。

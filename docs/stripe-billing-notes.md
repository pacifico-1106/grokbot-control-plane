# Stripe billing notes（JP SME / Staffpass）

Sealith docs/stripe-billing-strategy.md から trial → Checkout → webhook 同期の考え方のみ参照。
価格表・R2 原価計算・紹介クレジットは移植しない。

**表示額（税別・仮決め）は `lib/billing/plans.ts` / UI / `docs/pricing-model.md`。**
**Checkout 実課金は Stripe Dashboard の Price ID（env）が正。** コードに fake `price_…` を書かない。

## フロー

1. `/signup` → トライアル開始（`TRIAL_DAYS`、既定 14）+ `subscriptions` 行（trialing）
2. `/app/billing` → `POST /api/billing/checkout`
3. Stripe Checkout `mode=subscription` + `trial_period_days`
   - `client_reference_id` = orgId
   - `metadata.orgId` / `metadata.org_id` / `planKey`
   - `subscription_data.metadata` にも同じ orgId
   - Customer は org 単位で create/retrieve → `orgs.stripe_customer_id`
   - **business**: `STRIPE_PRICE_ID_BUSINESS_ONBOARDING` が設定されていれば、一式（one-time）を `line_items` に追加
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

## プラン表示（税別・仮決め／事業確定前）

| planKey | 表示名 | 月額（表示） | 仮枠 | 超過（表示） | 導入 |
|---------|--------|--------------|------|--------------|------|
| starter | スターター | ¥12,000 | 50 | ¥80/件 | — |
| business | ビジネス | ¥39,800 | 500 | ¥40/件 | ¥150,000 一式 |
| managed | Managed（Care） | ¥128,000 | 2000 | ¥25/件 | 月額に含む |

詳細は `docs/pricing-model.md`。超過の **Metered Price 配線は P0.5 スタブ**（未実装）。

## 必要な env

- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`
- `STRIPE_PRICE_ID_STARTER` / `STRIPE_PRICE_ID_BUSINESS` / `STRIPE_PRICE_ID_MANAGED`
- `STRIPE_PRICE_ID_BUSINESS_ONBOARDING`（任意・business 一式 one-time）
- `STRIPE_ENABLE_CUSTOMER_BALANCE`（任意・`1` で Checkout に振込系を追加）
- `BILLING_NOTIFY_EMAIL`（webhook 通知先）
- `TRIAL_DAYS` / `NEXT_PUBLIC_APP_URL`

キーが `replace_me_*` のあいだ Checkout / Portal / Webhook はスタブ。`bun run build` にライブキー不要。

## Dashboard チェックリスト（キー投入後 — ユーザー作業）

`STRIPE_SECRET_KEY` が `replace_me_*` のあいだ API での Product/Price 作成はスキップする。本物のキーが入ったら、**Dashboard（または API）で Price を作り、ID を env に貼る**。

### Products / Prices 作成手順（JPY）

1. **Product: Staffpass Starter**
   - Recurring Price: ¥12,000 / month（税別表示用。税は Stripe Tax または請求書側で別途）
   - → `STRIPE_PRICE_ID_STARTER`
2. **Product: Staffpass Business**
   - Recurring Price: ¥39,800 / month → `STRIPE_PRICE_ID_BUSINESS`
   - One-time Price: ¥150,000（導入一式）→ `STRIPE_PRICE_ID_BUSINESS_ONBOARDING`
3. **Product: Staffpass Managed (Care)**
   - Recurring Price: ¥128,000 / month → `STRIPE_PRICE_ID_MANAGED`
   - 導入は月額に含む（別 Price 不要）
4. **Overage（P0.5・後続）** — Metered Price（starter ¥80 / business ¥40 / managed ¥25 per `gated_confirm_action`）。Usage Records 配線は未実装。作成しても env 未接続でよい。
5. **Webhook** — `https://<domain>/api/webhooks/stripe`  
   推奨イベント: `customer.subscription.created|updated|deleted`, `invoice.paid`, `invoice.payment_failed`, `customer.subscription.trial_will_end`, `checkout.session.completed`
6. **Customer Portal** — Settings → Billing → Customer portal（プラン変更・支払方法・解約）
7. **customer_balance**（任意）— 銀行振込フローを有効化してから env=1
8. **Test vs Live** — テストキーで E2E → 本番キーは cutover 最後
9. **署名秘密** — Webhook signing secret → `STRIPE_WEBHOOK_SECRET`

### API 作成（任意・キーが本物のときのみ）

```bash
# Example only — run locally with real STRIPE_SECRET_KEY; do not commit IDs.
stripe products create --name "Staffpass Business" …
stripe prices create --product prod_… --currency jpy --unit-amount 39800 --recurring[interval]=month
```

このリポジトリの CI / demo 環境ではキーが `replace_me_*` のため **API create は実行しない**。

詳細な本番順序は `docs/production-cutover.md` の Stripe 節。

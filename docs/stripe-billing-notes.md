# Stripe billing notes（JP SME）

Sealith docs/stripe-billing-strategy.md から trial → Checkout → webhook 同期の考え方のみ参照。
価格表・R2 原価計算・紹介クレジットは移植しない。

## フロー

1. /signup → トライアル開始（TRIAL_DAYS、既定 14）
2. /app/billing → POST /api/billing/checkout
3. Stripe Checkout mode=subscription + trial_period_days
4. POST /api/webhooks/stripe で subscriptions 同期
5. customer.subscription.trial_will_end → Resend trial_ending

## 支払い方法

- card — 標準
- customer_balance — 日本の銀行振込・請求書寄りフロー向け（Dashboard で有効化後に追加）

## 必要な env

- STRIPE_SECRET_KEY
- STRIPE_WEBHOOK_SECRET
- NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
- STRIPE_PRICE_ID_STARTER / STRIPE_PRICE_ID_BUSINESS

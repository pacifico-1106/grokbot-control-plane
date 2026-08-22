# Architecture — Grok Bot Control Plane

## なぜ制御面か

Grok Bot の実行コンピュータはユーザー配下で共有される（画面はエージェント別、ファイル・ツール・ログインは共有）。
OS だけでは職務分離にならないため、社員証・ゲート・承認・監査で境界を張る。

## 論理構成

- Next.js App Router (UI + API)
- Supabase Auth + Postgres (supabase/schema.sql)
- Stripe Subscriptions
- Resend（welcome / approval_needed / trial_ending ほか）
- Gateway stubs: Managed / BYO Grok Bot link status machine

## 導入モード

| Mode | 説明 |
|------|------|
| Managed | 弊社が Grok Bot をセットアップし制御面に接続 |
| BYO | 顧客既存の Grok Bot にゲート / 監査のみ接続 |

## コア UX

日本語で職務説明 → 権限 Draft → 確認 → 社員証発行（一度きりの秘密）

## データ

orgs / org_members / employees / credentials / approval_requests / audit_events / subscriptions / gateway_links

## メール（Resend）

welcome / trial_started / trial_ending / approval_needed / approval_resolved / billing_receipt

## 課金（Stripe）

Checkout: /api/billing/checkout
Webhook: /api/webhooks/stripe
JP: card + customer_balance（注記）

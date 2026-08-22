# Architecture — Grok Bot Control Plane

## なぜ制御面か

Grok Bot の実行コンピュータはユーザー配下で共有される（画面はエージェント別、ファイル・ツール・ログインは共有）。
OS だけでは職務分離にならないため、社員証・ゲート・承認・監査で境界を張る。

## 論理構成

- Next.js App Router (UI + API)
- Supabase Auth + Postgres
- Stripe Subscriptions
- Resend (all transactional email)
- Future: Gateway adapters for Managed / BYO Grok Bot

## 導入モード

| Mode | 説明 |
|------|------|
| Managed | 弊社が Grok Bot をセットアップし制御面に接続 |
| BYO | 顧客既存の Grok Bot にゲート / 監査のみ接続 |

## データ（P0）

- orgs / employees / credentials
- approval_requests
- audit_events

詳細は supabase/schema.sql と lib/types.ts。

## メール（Resend）

welcome / trial_started / trial_ending / billing_receipt / approval_*

## 課金（Stripe）

Webhook: /api/webhooks/stripe
JP: card + customer_balance

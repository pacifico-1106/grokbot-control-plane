# AI社員 for Grok Bot — Control Plane

中小企業向けに、Grok Bot を「説明できる AI 社員」として運用するための制御面です。

**キャッチ:** 「AIを入れるな。AI社員を雇え。」

## スタック

| 層 | 技術 |
|----|------|
| Web | Next.js App Router + TypeScript + Tailwind CSS |
| Auth / DB | Supabase (Auth + Postgres) — supabase/schema.sql |
| Billing | Stripe Subscriptions（トライアル、カード + customer_balance） |
| Email | Resend（welcome / trial / billing / approval） |

## ルート

- `/` LP
- `/signup` トライアルスタブ
- `/app` ダッシュボード
- `/app/approvals` `/app/audit` `/app/settings` `/app/billing`
- `/api/webhooks/stripe` `/api/email` `/api/trial`

## セットアップ

1. package.json の依存関係をインストール
2. `.env.example` を `.env.local` にコピーし、Supabase / Stripe / Resend / TRIAL_DAYS を設定
3. スクリプト `dev` で開発、`build` 後 `start` で本番相当

## ドキュメント

- `docs/architecture.md`
- `docs/copy.md`
- `supabase/schema.sql`

ダッシュボード UI は Grok Bot 製品クロム寄りのダーク・ニュートラル。

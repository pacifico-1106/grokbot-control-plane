# AI社員 for Grok Bot — Control Plane

中小企業向けに、Grok Bot を「説明できる AI 社員」として運用するための制御面です。

**キャッチ:** 「AIを入れるな。AI社員を雇え。」

## スタック

| 層 | 技術 |
|----|------|
| Web | Next.js App Router + TypeScript + Tailwind CSS |
| Auth / DB | Supabase (Auth + Postgres) — supabase/schema.sql |
| Billing | Stripe Subscriptions（トライアル、カード + customer_balance 注記） |
| Email | Resend（welcome / approval_needed / trial_ending ほか） |

## 主要ルート

| Path | 内容 |
|------|------|
| `/` | LP |
| `/signup` | トライアル開始 → `/app` |
| `/app` | ダッシュボード |
| `/app/employees` | AI社員一覧 |
| `/app/employees/new` | 日本語 → Draft → 社員証発行（コア） |
| `/app/approvals` | 要対応・承認キュー |
| `/app/audit` | 監査タイムライン |
| `/app/getting-started` | オンボーディング |
| `/app/integrations` | Managed/BYO + 連携ステータス |
| `/app/billing` | Stripe Checkout スタブ |
| `/app/team` | owner/admin チーム |
| `/api/employees/interpret` | NL → Draft |
| `/api/employees/issue` | 社員証発行（デモは一度きり秘密） |
| `/api/billing/checkout` | Checkout Session |
| `/api/webhooks/stripe` | Webhook 構造 |
| `/api/gateway/*` | スリム gateway スタブ |

## Production checklist

1. **Env** — `.env.example` を `.env.local` / Vercel にコピーし、`replace_me_*` を実キーへ
2. **Supabase** — プロジェクト作成 → `supabase/schema.sql` を SQL editor で適用 → Auth 有効化 → 後で RLS ポリシーを追加
3. **Stripe** — Product/Price 作成 → `STRIPE_PRICE_ID_*` 設定 → Webhook endpoint `https://<domain>/api/webhooks/stripe`
4. **Resend** — ドメイン認証 → `EMAIL_FROM` を検証済みアドレスに
5. **Vercel** — Import（vercel.json: nextjs, hnd1）→ env 注入 → デプロイ
6. **Grok Bot 連携** — パートナー API が使えるまで `/app/integrations` はデモ状態機械

```bash
bun install
bun run build
bun run dev
```

## ドキュメント

- `docs/architecture.md`
- `docs/selection-from-sealith.md`
- `docs/agent-credential-guide.md`
- `docs/stripe-billing-notes.md`
- `docs/copy.md`

ダッシュボード UI は Grok Bot 製品クロム寄りのダーク・ニュートラル。

# AI社員 for Grok Bot — Control Plane

中小企業向けに、Grok Bot を「説明できる AI 社員」として運用するための制御面です。

**キャッチ:** 「AIを入れるな。AI社員を雇え。」

## スタック

| 層 | 技術 |
|----|------|
| Web | Next.js App Router + TypeScript + Tailwind CSS |
| Auth / DB | Supabase (Auth + Postgres) — `supabase/schema.sql` + RLS |
| Billing | Stripe Subscriptions（トライアル、カード + customer_balance 注記） |
| Email | Resend（welcome / approval_needed / trial_ending ほか） |

**Dual mode:** Supabase キーが `replace_me_*` / 未設定のあいだは **DEMO（インメモリ）**。実キー注入後は Postgres。ビルドにライブキーは不要。

## 主要ルート

| Path | 内容 |
|------|------|
| `/` | LP |
| `/signup` | トライアル開始（DEMO→/app、Prod→Auth+org） |
| `/login` | ログイン（DEMO はそのまま /app） |
| `/onboarding` | Auth のみ残った場合の組織修復（schema 未適用時も SSR クラッシュしない） |
| `/api/auth/repair-org` | ログイン中の組織自動プロビジョン（GET/POST） |
| `/app` | ダッシュボード |
| `/app/employees` | AI社員一覧 |
| `/app/employees/new` | 日本語 → Draft → 社員証発行（コア） |
| `/app/approvals` | 要対応・承認キュー |
| `/app/audit` | 監査タイムライン |
| `/app/getting-started` | オンボーディング |
| `/guides/instructions-design` | Instructions 設計ガイド（公開・ログイン不要） |
| `/app/guides/instructions-design` | 同ガイド（アプリ内） |
| `/app/integrations` | Managed/BYO + 連携ステータス |
| `/app/billing` | 請求・Checkout / Portal（キー未設定時スタブ） |
| `/app/team` | owner/admin チーム |
| `/api/employees/interpret` | NL → Draft |
| `/api/employees/issue` | 社員証発行（dual-mode） |
| `/api/billing/checkout` | Checkout Session（org metadata） |
| `/api/billing/portal` | Customer Portal |
| `/api/webhooks/stripe` | 購読同期 webhook |
| `/api/gateway/*` | スリム gateway + fail-closed invoke |
| `/api/employees/[id]/binding` ほか | 永続バインディング link/rotate/health |
| `/api/auth/*` | signup / login / logout |

## Production checklist（**実装 → キー最後**）

1. **コード** — dual-mode + schema/RLS をデプロイ（キーなしで `bun run build` 緑）
2. **Supabase** — プロジェクト作成 → SQL 適用:
   - 新規: `supabase/schema.sql`
   - 既存: `20260823_production_ready.sql` → `referral_code` → `agentmail_reservation` → **`20260824_approval_loop.sql`**
   - Auth（Email）ON（開発中 Confirm email OFF 可）
3. **Env（最後）** — 少なくとも Supabase 3 点（URL / anon / service_role）。詳細: `docs/production-cutover.md`
4. **Redeploy** → `GET /api/health` が `runtimeMode:"production"`
5. **`/signup`** — DEMO シード（`emp_sales` 等）は本番 DB に無い。雇い直し + link
6. **Stripe** — Product/Price → `STRIPE_PRICE_ID_*` → Webhook + Portal（任意・後回し可）
7. **Resend** — ドメイン認証 → `EMAIL_FROM`（任意・後回し可）
8. **Grok Bot 連携** — パートナー API が使えるまで `/app/integrations` はデモ状態機械
9. **バインディング** — `docs/binding-lifeline.md`

```bash
bun install
bun run build   # DEMO keys OK
bun run dev
```


## E2E（Playwright smoke）

DEMO モード（キーなし）で主要ページが 200 で開く最小スモークです。実キー不要。

```bash
bun install
bunx playwright install chromium   # 初回のみ
bun run build
bun run test:e2e                   # ローカル: build 済みなら next start を自動起動
```

恒久 Vercel URL に対して:

```bash
PLAYWRIGHT_BASE_URL=https://<your-project>.vercel.app bun run test:e2e
```

対象: `/` · `/login` · `/app` · `/app/employees/new`（`e2e/smoke.spec.ts`）。

## ドキュメント

- `docs/production-cutover.md` — **デモ→本番の切替・SQL・Vercel 貼り付け**
- `docs/architecture.md`
- `docs/selection-from-sealith.md`
- `docs/agent-credential-guide.md`
- `docs/stripe-billing-notes.md`
- `docs/copy.md`
- `docs/binding-lifeline.md` — employeeId 不変・再発行は generation のみ・要再連携は黙って消さない

ダッシュボード UI は Grok Bot 製品クロム寄りのダーク・ニュートラル。

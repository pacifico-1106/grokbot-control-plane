# Production cutover — implement first, keys last

このリポジトリは **デモ（インメモリ）と本番（Supabase）を dual-mode** で動かします。  
`replace_me_*` / 未設定のまま `bun run build` / `bun run dev` が可能です。実キーは最後に注入します。

## 切替条件

`lib/mode.ts` の `isDemoMode()` が次のいずれかで **true** → DEMO:

- `NEXT_PUBLIC_SUPABASE_URL` 欠落 / `YOUR_PROJECT` / placeholder
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` 欠落 / `replace_me*`
- `SUPABASE_SERVICE_ROLE_KEY` 欠落 / `replace_me*`

3つとも実値が入ると **production**（Postgres + Auth）。Stripe / Resend は個別にスタブ継続可。

## 推奨順序（キーは最後）

1. **コード** — 本ブランチを main に載せる（完了済み想定）
2. **Supabase プロジェクト作成**（まだキーを Vercel に貼らない）
3. **SQL 適用**
   - **新規プロジェクト:** SQL Editor で `supabase/schema.sql` を全文実行（approval loop 列・agentmail 予約・referral_code 含む）
   - **既存 DB（すでに core がある）:** 次を **この順** で実行  
     1. `supabase/migrations/20260823_production_ready.sql`  
     2. `supabase/migrations/20260823_referral_code.sql`  
     3. `supabase/migrations/20260823_agentmail_reservation.sql`  
     4. `supabase/migrations/20260824_approval_loop.sql` ← **承認ループ必須**（title / tool / job_id / status_token / poll_path、employees の notify/callback/routine）
     5. `supabase/migrations/20260826_telegram_revision.sql` ← Telegram通知、修正依頼、再提出の親子関係
4. **Auth 有効化** — Authentication → Providers → Email を ON。開発中は Confirm email を OFF 推奨（signup が即ログインできる）
5. **Vercel env にキーを貼る**（下記チェックリスト）— **Supabase 3 点セットが揃うまで DEMO のまま**
6. **Redeploy** → `GET /api/health` で `runtimeMode: "production"` を確認
7. **`/signup`** で本番登録（Auth user + org + owner member）。DEMO シード社員（`emp_sales` 等）は **Postgres に無い**
8. **Stripe** webhook / Price ID、**Resend** ドメイン（承認ループ検証自体には不要）

## Vercel に貼る環境変数

`.env.example` をベースに、少なくとも:

| Key | 用途 |
|-----|------|
| `NEXT_PUBLIC_APP_URL` | 本番 URL（https://…） |
| `NEXT_PUBLIC_SUPABASE_URL` | Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | anon（公開可） |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role（**秘密**・サーバーのみ） |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` / `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | 請求 |
| `STRIPE_PRICE_ID_STARTER` / `STRIPE_PRICE_ID_BUSINESS` | Checkout |
| `RESEND_API_KEY` / `EMAIL_FROM` | トランザクションメール |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_APPROVAL_CHAT_ID` | 承認専用Botとグループ |
| `TELEGRAM_WEBHOOK_SECRET` / `TELEGRAM_ALLOWED_USER_IDS` | Webhook署名と承認者制限 |
| `CRON_SECRET` | Telegram朝夕ダイジェスト |
| `TRIAL_DAYS` | 既定 14 |

**本番切替に必須（これで DEMO 解除）:**  
`NEXT_PUBLIC_SUPABASE_URL` · `NEXT_PUBLIC_SUPABASE_ANON_KEY` · `SUPABASE_SERVICE_ROLE_KEY`

`replace_me_*` を残した Stripe / Resend は該当機能だけスタブのまま（承認ループ検証は可）。

切替確認: `curl -sS https://<YOUR_DOMAIN>/api/health` → `"runtimeMode":"production"`。

## 手動 SQL（ユーザー作業）

1. Supabase Dashboard → SQL → New query
2. 新規: `schema.sql` 全文。既存: migrations を上記順に Run
3. Table Editor で確認:
   - `orgs` / `org_members` / `employees` / `employee_bindings` / `approval_requests` / `audit_events`
   - `approval_requests` に `title`, `tool`, `job_id`, `status_token`, `poll_path`, `revision_note`, `revision_count`, `telegram_ref`, `telegram_message_id`, `parent_approval_id`
   - `employees` に `approval_notify_email`, `callback_url`, `approval_routine_text`
4. Authentication → Providers → Email ON（Confirm email は開発中 OFF 可）

RLS は `org_members.user_id = auth.uid()` で組織隔離。  
Gateway / API の **service role クライアントは RLS をバイパス**（意図どおり）。

## DEMO シード vs 本番 DB

| DEMO（切替前） | 本番（切替後） |
|----------------|----------------|
| `emp_sales` / `apr_1` / `mem_1` はプロセス内メモリ | **空の Postgres**。signup で org+owner が初めて作られる |
| Upstash / GitHub `demo-store` / `DEMO_APPROVALS_*` | **不要**。承認は `approval_requests` 行が正本 |
| 承認 UI にシードチケットが出る | シードは出ない。Gateway invoke → 新規行 |

切替後に DEMO 半端ストアを残す必要はない（キーを外してよい）。

## 動作確認

| モード | 確認 |
|--------|------|
| DEMO | env 未設定で `/app`・雇い・承認・チームが動く。`GET /api/health` → `runtimeMode:"demo"` |
| Prod | `GET /api/health` → `runtimeMode:"production"`。signup → login → `/app` がセッション必須。社員発行・承認が Postgres に残る |
| 承認ループ | invoke → 402+pollUrl → UI/Telegramで承認または修正依頼 → poll → 承認時はapprovalId、修正時は同じjobId+parentApprovalIdで再 invoke |

Telegram Bot の作成、Group Privacy、setWebhook、疎通確認は
`docs/guides/telegram-approval.md` を参照。

## 関連

- README Production checklist（順序更新済み）
- `docs/binding-lifeline.md`
- `lib/data/*` — dual-mode repository
- `lib/auth/session.ts` / `middleware.ts`

## Stripe Dashboard（有料 SaaS 切替）

実装は完了済み（Checkout metadata.orgId · webhook upsert · Portal · entitlements soft-gate）。
**キーと Dashboard 設定は最後。** 価格の実額はここに書かない — Dashboard が正。

### 作成するもの

1. **Product + Price（JPY）**
   - スターター → Price ID → `STRIPE_PRICE_ID_STARTER`
   - ビジネス → Price ID → `STRIPE_PRICE_ID_BUSINESS`
   - 表示名は任意（コード側プレースホルダ: `{{STARTER_PRICE}}` / `{{BUSINESS_PRICE}}`）
2. **Webhook endpoint**  
   `https://<YOUR_DOMAIN>/api/webhooks/stripe`  
   イベント: subscription created/updated/deleted · invoice.paid · invoice.payment_failed · trial_will_end · checkout.session.completed  
   Signing secret → `STRIPE_WEBHOOK_SECRET`
3. **Customer Portal** を有効化（支払方法更新・解約・請求書）。アプリは `POST /api/billing/portal`
4. **（任意）customer_balance / 銀行振込** — Dashboard で有効化後 `STRIPE_ENABLE_CUSTOMER_BALANCE=1`
5. **API keys** — テストで確認してから Live の `STRIPE_SECRET_KEY` / `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`

### 動作確認

| モード | 期待 |
|--------|------|
| DEMO / replace_me_* | Checkout・Portal・Webhook が stub JSON。雇用・チームは制限なし |
| Prod + 実キー | Checkout が Stripe へ。webhook が `subscriptions` と `orgs.stripe_customer_id` を更新。past_due/canceled/incomplete で雇用・チームが 402（日本語メッセージ） |

参照: `docs/stripe-billing-notes.md`


## Permanent Vercel deploy（GitHub 連携・推奨）

CLI 上で `vercel whoami` が **Logged out**、かつ `VERCEL_TOKEN` が無い環境では、エージェントから恒久プロジェクトを作成できません。  
一時デプロイ（`--temporary` / claim）ではなく、**Dashboard で GitHub Import** してください。

### ユーザーがクリックする手順（正確）

1. https://vercel.com/login でログイン（GitHub アカウント推奨）
2. Dashboard → **Add New… → Project**
3. **Import** Git Repository: `https://github.com/pacifico-1106/grokbot-control-plane`
   - 初回は GitHub 連携を許可し、リポジトリへのアクセスを付与
4. Configure Project:
   - **Framework Preset:** Next.js（自動検出想定。`vercel.json` でも `framework: nextjs`）
   - **Root Directory:** `.`（そのまま）
   - **Region:** `hnd1`（Tokyo）— Project Settings → Functions / Regions、または `vercel.json` の `regions: ["hnd1"]` が効く
5. **Deploy**（この時点では env はプレースホルダのままで OK → DEMO 起動）
6. Settings → Git で **main** への push が Production に自動デプロイされることを確認
7. 後から Settings → Environment Variables に `.env.example` の実キーを貼り、**Redeploy**

### 期待される URL

- 本番: `https://grokbot-control-plane.vercel.app`（カスタムドメインは任意）
- Dashboard: `https://vercel.com/tyasakas-projects/grokbot-control-plane`

※ claim URL や一時デプロイの URL は恒久運用に使わないこと。Git 連携プロジェクトを正とする。

### CLI で恒久デプロイできる場合（ログイン済 or `VERCEL_TOKEN`）

```bash
# 要: vercel login 済み、または export VERCEL_TOKEN=…
npx vercel link          # 既存プロジェクトに紐付け、または新規作成
npx vercel --prod        # Production（--temporary は使わない）
# Git 連携は Dashboard の Import / Settings → Git が確実
```

トークン保管例（この box）: `/workspace/.secrets/` に `vercel_token.txt` を置けばエージェントが再利用可能。現状は GitHub PAT のみ。


## Recovery: Auth user exists, org missing

**Symptom:** Signup failed (often `orgs` / `org_members` table missing). Supabase Auth user was created. Later login shows opaque *Application error* / digest on `/app` because pages called `getOrgMeta(null)`.

**Fixed in app (deploy this code):**

1. `app/app/layout.tsx` — `ensureAuthenticatedOrg()` auto-provisions org+owner on first `/app` visit (same shape as signup).
2. If schema is still missing → soft redirect to `/onboarding` (no SSR crash).
3. `GET|POST /api/auth/repair-org` — explicit repair URL while logged in.
4. Signup retries: existing Auth + correct password → provision org and continue.

**What the operator / user should do after deploy:**

1. Confirm SQL applied (`supabase/schema.sql` or migrations in order).
2. **Same email/password → Login** (or open `/app` if already cookied).
3. Org is auto-created; dashboard loads.
4. If still blocked: open **`/onboarding`** or **`/api/auth/repair-org`** while logged in.
5. Do **not** need to delete the Auth user unless you want a clean re-signup; repair is preferred.

**Do not** leave production without `orgs` + `org_members` — signup will keep creating Auth-only users until schema exists.

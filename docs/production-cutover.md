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
3. **SQL 適用**（どちらか一方で可）
   - **新規:** Supabase SQL Editor で `supabase/schema.sql` を全文実行
   - **既存 DB:** `supabase/migrations/20260823_production_ready.sql` を実行  
     （employees.spend / allowed_accounts、org_members.job_*、employee_bindings、RLS）
4. **Auth 有効化** — Authentication → Providers → Email を ON。必要なら Confirm email を開発中は OFF
5. **Vercel env にキーを貼る**（下記チェックリスト）
6. **再デプロイ** → `/signup` で本番登録（Auth user + org + owner member）
7. **Stripe** webhook / Price ID、**Resend** ドメイン

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
| `TRIAL_DAYS` | 既定 14 |

`replace_me_*` を残した項目は該当機能だけスタブのままです。

## 手動 SQL（ユーザー作業）

1. Supabase Dashboard → SQL → New query
2. `schema.sql`（新規）または `migrations/20260823_production_ready.sql`（既存）を貼って Run
3. Table Editor で `orgs` / `org_members` / `employees` / `employee_bindings` が見えること
4. Authentication が有効であること

RLS は `org_members.user_id = auth.uid()` で組織隔離。  
Gateway / API の **service role クライアントは RLS をバイパス**（意図どおり）。

## 動作確認

| モード | 確認 |
|--------|------|
| DEMO | env 未設定で `/app`・雇い・承認・チームが動く |
| Prod | signup → login → `/app` がセッション必須。社員発行が Postgres に残る |

## 関連

- README Production checklist（順序更新済み）
- `docs/binding-lifeline.md`
- `lib/data/*` — dual-mode repository
- `lib/auth/session.ts` / `middleware.ts`

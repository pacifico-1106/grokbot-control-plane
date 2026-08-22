# Selection from sealith-web

参照リポジトリ: `https://github.com/pacifico-1106/sealith-web`  
方針: **パターン / UX / データモデルを選択的に参考にし、Grok Bot 制御面向けに書き直す。製品丸ごとの移植はしない。**

## Took（採用・書き換え）

| Sealith 由来 | 本リポジトリでの形 |
| --- | --- |
| `ai-settings` + `agent-tokens/interpret` + policy-draft | `/app/employees/new` — 日本語職務説明 → Draft → 確認 → 社員証発行。スコープは Grok Bot 向け（`tools:*` / `mail:*` / `commerce:*` 等）。転送・PPAP スコープは使わない。 |
| Approvals / inbox / activity UX | `/app/approvals`（要対応）+ `/app/audit`（タイムライン）。承認 API スタブ付き。 |
| `billing` + `docs/stripe-billing-strategy.md` の trial→Checkout 思考 | `/app/billing` + `/api/billing/checkout` + webhook。card + customer_balance 注記。価格・原価表そのものは移植しない。 |
| `team`（owner/admin） | `/app/team` — SME 向けシンプル名簿 + 招待スタブ。 |
| `getting-started` チェックリスト | `/app/getting-started` — Managed vs BYO を含む短手順。 |
| Agent token / MCP / OpenAPI 概念 | `docs/agent-credential-guide.md` + `/api/gateway/*` スリムスタブのみ。MCP 本番サーバは未実装。 |
| `.env.example` / `vercel.json` 衛生 | 制御面向け env と Vercel フレームワーク設定に整理（Firebase/R2/KMS/JPYC 等は載せない）。 |

## Skipped（明示的に移植しない）

- 暗号化ファイル handoff / transfers / receive / PPAP
- Chrome 拡張
- Firestore transfer ルールを製品コアにすること（DB は Supabase）
- JPYC / agent-commerce / OnePlace / Threes provider 運用
- Sealith ブランド PDF・紹介プログラム・重い ops コンソール
- Sealith クローンになる UI コピーやプラン表の丸写し

## Bar（このリポジトリの成功条件）

中小企業の社長が:

1. AI社員を権限付きで雇える  
2. 危険操作を承認できる  
3. 監査を見られる  
4. Stripe で払える導線がある  

Sealith との機能パリティは目標にしない。

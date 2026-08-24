# Staffpass ↔ Grok 承認ループ運用（DEMO〜本番）

**読者:** 導入伴走・デモ実施者・AI社員を動かす運用者  
**結論:** Partner API webhook が来るまで、**署名付き status poll URL が唯一の正式な戻りパイプ**である。メールは人間向けの副次通知。メールをクロールして承認判定してはならない。

本番: https://grokbot-control-plane.vercel.app  
公開ガイド: [/guides/approval-loop](https://grokbot-control-plane.vercel.app/guides/approval-loop)  
アプリ内: [/app/guides/approval-loop](https://grokbot-control-plane.vercel.app/app/guides/approval-loop)

---

## なぜ poll か（正直な現状）

| 経路 | 役割 | 現状 |
|------|------|------|
| **GET `/api/approvals/status?id=&token=`** | Bot が承認結果を知る正本 | **必須（DEMO でも同じ）** |
| Resend メール（人間） | 社長・管理者への通知 | 副次。未設定なら stub ログ |
| `approvalNotifyEmail` | 将来 AgentMail / 機械可読 inbox | 任意。解決時に status+approvalId を本文送信 |
| `callbackUrl` | 任意 webhook | best-effort POST。失敗しても承認自体は成功 |
| Partner API webhook | 将来の push 戻り | **未実装。偽らない。来るまで poll** |

---

## シーケンス（必須）

1. Grok Bot が Staffpass Gateway `POST /api/gateway/invoke`（confirm/send/order など）
2. Staffpass がチケット作成し **402 + `needs_approval: true`** と次を返す:
   - `approvalId`
   - `statusToken`
   - `pollUrl`（または `pollPath`）
   - `title` / `summary`（リッチ）
3. Bot は **作業を止め**、`pollUrl` を GET でポーリング（数秒〜数十秒間隔）
4. 人間が [/app/approvals](https://grokbot-control-plane.vercel.app/app/approvals) で承認または却下
5. poll が `approved` → 同じ `jobId` / `purpose` / `tool` で **`approvalId` 付き再 invoke**
6. poll が `rejected` / `expired` → ジョブ中止。別経路で確定しない

**禁止:** 承認待ちのまま confirm 完了／課金確定。チャットの「承認されたはず」は根拠にしない。

---

## DEMO で end-to-end 確認する手順

前提: デモモード（Supabase キーが `replace_me_*`）でも可。本番 DEMO も同じ UI。

1. 開く: https://grokbot-control-plane.vercel.app/app/approvals  
2. シードチケット（例: `mail.send` / `commerce.order`）に **タイトル・要約・tool・purpose・risk・employee・作成時刻** が見えること  
3. 「デモ用 poll URL をコピー」→ 別タブで開く → `status: "pending"`  
4. 同じチケットを **承認**  
5. 同じ poll URL を再読込 → `status: "approved"`、`pollHint: "reinvoke_with_approvalId"`  
6. （任意）Gateway で confirm 系を `approvalId` 付き再 invoke → 成功パス  
7. 新規: 連携済み AI社員で force-approval ツールを invoke → 新規チケット＋返却 JSON に `pollUrl`  

シードの固定 token（デモ用）はプロセス内メモリ。サーバレス再起動でリセットされることがある — その場合は Gateway で新規チケットを作る。

### curl 例（DEMO）

シード `emp_sales` は linked。confirm/send 用 scope 付き。API キー不要（DEMO）。承認は `x-member-id: mem_1`。

```bash
BASE=https://grokbot-control-plane.vercel.app
EMP=emp_sales
JOB=job_e2e_$(date +%s)

# A) invoke confirm → 402 needs_approval + pollUrl / pollPath
curl -sS -X POST "$BASE/api/gateway/invoke" \
  -H 'Content-Type: application/json' \
  -H "x-employee-id: $EMP" \
  -d "{\"employeeId\":\"$EMP\",\"tool\":\"calendar.confirm\",\"purpose\":\"sales.outreach\",\"jobId\":\"$JOB\"}"

# 応答から approvalId / statusToken / pollPath を控える。pollUrl より pollPath を
# 本番ホストに付けて使う（VERCEL_URL 由来のデプロイ URL を避けられる）。

# B) poll status（pending）
curl -sS "$BASE/api/approvals/status?id=APPROVAL_ID&token=STATUS_TOKEN"

# C) approve（UI: /app/approvals でも可）
curl -sS -X POST "$BASE/api/approvals/APPROVAL_ID/approve" \
  -H 'Content-Type: application/json' \
  -H 'x-member-id: mem_1' \
  -d '{}'

# D) re-invoke with approvalId
curl -sS -X POST "$BASE/api/gateway/invoke" \
  -H 'Content-Type: application/json' \
  -H "x-employee-id: $EMP" \
  -d "{\"employeeId\":\"$EMP\",\"tool\":\"calendar.confirm\",\"purpose\":\"sales.outreach\",\"jobId\":\"$JOB\",\"approvalId\":\"APPROVAL_ID\"}"

# E) 期待成功: HTTP 200, ok:true, result.confirmed:true, priorApprovalId, meter.billable:true
```

シード poll（UI デモ用）:
```bash
curl -sS 'https://grokbot-control-plane.vercel.app/api/approvals/status?id=apr_1&token=st_demo_apr1_status_token_aaaaaaaa'
```

新規社員から回す場合: `POST /api/employees/issue`（scopes に mail:send / calendar:confirm）→ `POST /api/employees/{id}/link`（grokBotAgentId）→ 上記 A–E。
Vercel DEMO は in-memory のため、issue→invoke→approve→reinvoke は同一ウォームインスタンス内で連続実行すること（コールドでチケットが消える）。

---

## Hire 時に貼るもの

発行完了画面に一度だけ出る:

- **Instructions スニペット** — Base「承認待ち」ルール（書き換え禁止）
- **Routine テンプレ** — needs_approval → poll → approved 再 invoke / rejected 中止

社員レコードに `approvalRoutineText` を保存（任意で後から参照）。  
詳細な三層設計は [instructions-design.md](./instructions-design.md)。

---

## フィールド早見

**ApprovalRequest:** `title`, `summary`, `tool?`, `jobId?`, `statusToken`, `pollPath`, …  
**Employee（任意）:** `approvalNotifyEmail`, `callbackUrl`, `approvalRoutineText`

---

## 運用チェックリスト

- [ ] Bot Instructions に Base 承認待ちが入っている  
- [ ] Routine / Teach に poll 手順がある  
- [ ] デモで pending → approve → poll approved を一度通した  
- [ ] Resend 未設定でも承認 UI と poll が動くことを説明できる  
- [ ] 「Partner webhook がある」と偽らない  

最終更新: 2026-08-24（JST）


## 本番（Supabase）切替後の再検証

前提: `GET /api/health` が `"runtimeMode":"production"`。signup 済み。実社員を issue + link 済み（`emp_sales` シードは無い）。

1. `POST /api/gateway/invoke`（confirm/send）→ 402 + `approvalId` / `statusToken` / `pollUrl`
2. Supabase Table Editor で `approval_requests` に行があること（`status_token` / `poll_path` / `title`）
3. `/app/approvals` で **承認**
4. 同じ `pollUrl` → `status:"approved"` / `pollHint:"reinvoke_with_approvalId"`
5. 同じ `jobId` で `approvalId` 付き再 invoke → 200 / confirmed

DEMO 用 Upstash / `DEMO_APPROVALS_*` は本番では使わない（無視してよい）。

## DEMO on Vercel (multi-isolate)

Gateway `needs_approval` tickets are written through `lib/data/demo-approvals-store.ts`.

Without a durable backend, each serverless isolate has its own in-memory copy of
`apr_1` / `apr_2` seeds — live `apr_*` tickets created on isolate A will **not**
show in Approvals UI rendered on isolate B, and Bot poll may never see approve.

Set **one** of the following on the Vercel project (Production) then **Redeploy**:

1. **Upstash Redis / Vercel KV** (preferred): `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`
   (or `KV_REST_API_URL` + `KV_REST_API_TOKEN`)
2. **GitHub Contents** on branch `demo-store` / file `approvals.json`:
   `DEMO_APPROVALS_GITHUB_TOKEN` (repo Contents read/write). Optional
   `DEMO_APPROVALS_GITHUB_REPO` (default `pacifico-1106/grokbot-control-plane`).
3. Generic HTTP JSON GET/PUT: `APPROVAL_DEMO_STORE_URL` (+ optional Bearer token)

`GET /api/approvals` returns `durable` + `demoStore` for the Approvals UI banner.

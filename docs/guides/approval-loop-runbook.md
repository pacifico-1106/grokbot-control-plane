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

```bash
# 1) ステータス（Approvals UI でコピーした URL を使う）
curl -sS 'https://grokbot-control-plane.vercel.app/api/approvals/status?id=apr_1&token=st_demo_apr1_status_token_aaaaaaaa'

# 2) 承認後に同じ URL を再 GET → status=approved
```

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

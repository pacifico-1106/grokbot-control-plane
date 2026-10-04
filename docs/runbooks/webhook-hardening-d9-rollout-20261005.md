# D9: 既存の callback・起こす webhook の強化 — 段階的な有効化の手順（2026-10-05）

対象: `employee.callbackUrl`（承認の結果の callback、`lib/approvals/resolve-side-effects.ts`）と
`employee_bindings.wake_webhook_url`（会話で起こす webhook、`lib/slack/mention-ingress.ts` の `postWake`）。
フラグ: `WEBHOOK_HARDENING_ENABLED`（既定 OFF。`true` / `1` / `on` / `yes` で ON）。全体で 1 つ（環境変数）。

> この手順はまだ実行しない。本番の migration・環境変数・テナントへの連絡は、それぞれ人の判断で行う。

## 何が変わるか

| | フラグ OFF（既定） | フラグ ON |
|---|---|---|
| 送り方 | 今と同じ `fetch`（ヘッダー・本文・タイムアウトとも同じ） | #267 の `postWebhook`: https・443 番だけ、ホスト名だけ（IP の直書き不可）、**DNS の答えがすべて公開の IP**、確認した IP に固定して接続、**リダイレクトは追わない**、応答は 64 KiB まで、全体の期限でソケットまで破棄 |
| 署名 | なし（起こす webhook は今と同じ `Authorization: Bearer <secret>`） | Standard Webhooks（`webhook-id` / `webhook-timestamp` / `webhook-signature: v1,…`）。起こす webhook は Bearer も残す |
| callback の本文 | 今と同じ（全部） | **minimal**（ID と状態だけ）。社員ごとに `legacy_full`（今と同じ全部）を選べる |
| API の応答・監査 | **失敗の種類だけ**（`http_4xx`・`timeout` など）。受け手の HTTP の状態・エラー文は出さない | 同じ |
| User-Agent | `Staffpass-ApprovalHook/1.0`・今のまま | callback は `Staffpass-ApprovalHook/1.0`、起こす webhook は `Staffpass-Wake/1.0` |

フラグ OFF で変わるのは最後から 2 行目だけ（応答の `callback.status` / `callback.error` の生の文 → `callback.error` が種類だけ。監査の `metadata.status` / `metadata.error` → `metadata.category`）。受け手に届く要求は 1 バイトも変わらない。

## 段階

### 0. マージ（#268 → #267 → D9 の順）
- フラグ OFF のまま。受け手から見える変化はない。

### 1. migration `20261005100000_employee_webhook_settings.sql` を適用
- `20261005000000`（#267）の後。追加だけ（テーブル 1・トリガー関数 1）。フラグ OFF の間、アプリはこのテーブルを読まない。
- **フラグ ON の前に必ず適用する**。未適用で ON にすると、callback は送らずに `config_unavailable` になる（fail closed）。起こす webhook はこのテーブルを使わない。

### 2. 宛先の棚卸し（読むだけ）
フラグ ON で届かなくなる宛先を先に見つける。service_role で（本番では人が実行）:

```sql
select id, org_id, callback_url from public.employees where callback_url is not null and callback_url <> '';
select employee_id, wake_webhook_url from public.employee_bindings where wake_webhook_url is not null and wake_webhook_url <> '';
```

それぞれ次を確認する（どれかに当たると、ON にした後は送らずに種類だけを記録する）:
- `http://`・443 以外のポート・IP の直書き・`user:pass@`・`#…` → `invalid_url`
- 名前が private / loopback / link-local / CGNAT / メタデータの IP に解決される（1 つでも）→ `address_blocked`
- 3xx を返す受け手 → `redirect_refused`（今は `fetch` が追っている）

当たった宛先のテナントには、ON の前に宛先の変更をお願いする（連絡は人が行う）。

### 3. 本文が全部要る受け手は `legacy_full` にする
minimal の本文は `type`・`status`・`approvalId`・`employeeId`・`tool`・`jobId`・`risk`・`resolvedAt`・`revisionCount`・`parentApprovalId`（無ければ null）と、あるときだけ `eventId`・`mcpHandoff`。
件名（`title`）・`summary`・承認者のメール・`purpose`・差し戻しのメモなどを読んでいる受け手は、ON の前に:

```
POST /api/employees/<employeeId>/webhook-signing   { "action": "set_callback_payload", "mode": "legacy_full" }
```

（owner/admin＋`hire_issue_credentials`。フラグ OFF の間は 404 なので、この段階は **ステージングで先に ON にしてから**か、ON と同時に行う。）`GET` で今の設定を確認できる（秘密は返さない）。

### 4. 署名の鍵（任意）
- callback の鍵の順: その社員の callback 用の秘密（下で作る）→ 起こす webhook の秘密（`employee_binding_secrets`）→ なし（署名なし。`webhook-id`・`webhook-timestamp` だけ付く）。
- callback 用の秘密を作る: `POST …/webhook-signing { "action": "mint_callback_secret" }` → `whsec_…` が **1 回だけ**返る（`Cache-Control: no-store`）。DB には `lib/notify/crypto.ts` の暗号文と sha256 だけ。もう一度呼ぶと作り直し（前の秘密は使われなくなる）。監査には指紋の先頭 12 文字だけ。
- 起こす webhook の秘密で署名する場合、標準のライブラリで検証するには `whsec_` + base64(秘密の UTF-8) を鍵として使う（秘密そのものが `whsec_…` ならそのまま）。
- 受け手は署名を検証しなくても動く（ヘッダーが増えるだけ）。

### 5. フラグを ON（ステージング → 本番）
1. ステージングで `WEBHOOK_HARDENING_ENABLED=true`。承認を 1 件決めて callback が届くこと、Slack でメンションして起こす webhook が届くことを確認。
2. 本番で ON。最初の 24 時間は監査を見る:
   - `agent.approval_wake`（`APPROVAL_WAKE_ACTION`）の `metadata.reason = "wake_failed"`・`metadata.hardened = true` の `metadata.category`
   - 起こす webhook の `summary = "起こす webhook の送信に失敗"` の `metadata.category`
   - `address_blocked`・`invalid_url`・`redirect_refused` が出たら、その宛先は段階 2 で見落としたもの。
3. 問題があれば **フラグを OFF にすれば即座に元の送り方に戻る**（DB はそのままでよい）。

### 6. 戻すとき
- フラグ OFF（すぐ）。
- DB も戻すなら migration 末尾の ROLLBACK か `supabase/verification/20261005100000_employee_webhook_settings_rollback.sql`（作った秘密と `legacy_full` の設定は消える）。

## #267 の eventId での重複の判定（D7）との関係

- MCP Events がこの決定のイベントを作ったとき（`MCP_EVENTS_ENABLED` ON で購読がある）、callback の `webhook-id` は **その eventId**（MCP Events の `approval.decided` の配信の `webhook-id` と同じ）。本文の `eventId` も minimal に残す。callback と MCP Events の両方を受ける受け手は、`webhook-id`（または本文の `eventId`）でまとめればよい。
- MCP Events が無いときの callback の `webhook-id` は (org, 承認, 状態, `resolvedAt`) のハッシュ。同じ決定を 2 回送っても同じ id。
- 起こす webhook の `webhook-id` は (org, 社員, Slack の event id) のハッシュ。Slack の再送でも同じ id。
- callback・起こす webhook とも再送はしない（今と同じ）。再送するのは MCP Events の配信だけ（#267 の cron）。

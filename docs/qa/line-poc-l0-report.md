# LINE PoC L0 最終報告

- 作成: 2026-10-21（森。実装 PR #419）
- 試験計画: `docs/qa/line-poc-test-plan-20261021.md`（73 件。main `b86647e5` / #420）
- 木村決定の取り込み: U-02 / U-07 / U-10 / U-11 / U-12 / U-17 / U-20 / U-21

---

## (1) Web 限定の高リスク操作（HRK-01/02）

現行コードから抜き出した **LINE では承認できない** 操作は次の 1 件だけ。一覧に無い名前は足していない。

| ID | 分類 | tool | reason | Web 経路 | ファイル:行 |
|---|---|---|---|---|---|
| HRK-HOLD-RELEASE | 停止解除 | `employee.hold.release` | `hold_release_web_only` | `/app/approvals` の『解除を承認』 / `POST /api/holds/release/approve` | `lib/safety/hold-config.ts` 35–38（`HOLD_RELEASE_SURFACES = ["web"]`）、45（`HOLD_RELEASE_TOOL`）、62–66（`isHoldReleaseTicket`）。`lib/safety/hold-release-auth.ts` 69。`lib/data/approvals.ts` 486 / 521。`lib/approvals/workflow-integration.ts` 77–79。`lib/approvals/hold-release-web.ts` 12–13 |

設計 §7 決定 9 / U-07 の「金銭・秘密（資格情報）・ポリシー変更」は、現行コードに **LINE 拒否の専用ゲートが無い**。always_human の承認は LINE postback でも通る。L0 では記録のみ。追加ゲートは該当 PR。

正本: `lib/comm/line-web-only-high-risk.ts`

---

## (2) LINE Messaging API 429 の `message`（QTA-01/06）

公式: [Messaging API reference](https://developers.line.biz/en/reference/messaging-api/)（[Status codes](https://developers.line.biz/en/reference/messaging-api/#status-codes) / [Error responses](https://developers.line.biz/en/reference/messaging-api/#error-responses)）

429 はレート制限と月間通数の両方を返す。区別は本文 `message` だけ。

| 種別 | `message` | 公式の説明（引用） | 実装 reason |
|---|---|---|---|
| 月間上限 | `You have reached your monthly limit.` | "Exceeded the number of free messages. Exceeded your maximum number of additional messages allowed to be sent." | `line_monthly_quota_exceeded` |
| レート制限 | `The API rate limit has been exceeded. Try again later.` | "Exceeded the rate limit for requests." | `line_rate_limited` |
| 判別不能 | 空・その他 | Status 429 自体: "Exceeded the rate limit for requests. Exceeded the Limit on the number of concurrent operations for requests. Exceeded the number of free messages. Exceeded your maximum number of additional messages allowed to be sent." | `line_not_sent_429`（両方「送れなかった」。リトライしない） |

正本: `lib/comm/line-429-official.ts` / `classifyLine429` in `lib/comm/line-send.ts`

---

## (3) 画面 URL・文言・連携失敗・8 割通知（UI-01 / LNK-01 / QTA-04）

定数ファイル: `lib/comm/line-poc-copy.ts`（木村レビュー用）

### 画面

- URL: `/app/employees/:employeeId`
- 見出し: `LINE 公式アカウント（会話）` / `LINE 会話の連携コード`
- 成功: `Webhook を登録しました` / `Webhook を登録しました: <url>`
- 失敗フォールバック: `接続に失敗しました`
- 接続ボタン: `接続して Webhook を登録`
- 連携発行: `連携コードを発行` / 失敗 `発行に失敗しました`
- 接続エラー詳細: `LINE_WEBHOOK_SETUP_ERRORS_JA`（`lib/comm/line-webhook-setup.ts`）

### 連携失敗（LINE）

- 成功: `✅ Staffpass の社内メンバーとして確認しました。`
- 1対1 の失敗（期限切れ・使用済み・別社員・形式不正・ロック。コードの有無は言わない）: `連携コードを確認できませんでした。Staffpass の設定画面で新しいコードを発行して、しばらくしてからもう一度送ってください。`
- グループ: `連携コードは、公式アカウントとの 1:1 トークで送ってください（グループでは受け付けません）。`

### 8 割通知（U-21。送信実装は U-05 の該当 PR）

- テナント管理者メール件名: `【Staffpass】LINE 送信通数が月間上限の 8 割に達しました`
- 本文: `このテナントの LINE 公式アカウントの送信通数が、今月の上限の 8 割に達しました。上限に達すると会話の Push は送れません。Reply は通数に含まれません。本文や秘密は記録していません。`
- 運営知らせ: `【運営】LINE 送信通数が月間上限の 8 割に達したテナントがあります。本文・token は含みません。`

---

## (4) PoC に必要な env 名（E2E-00）

値は書かない。木村は本番に載っていることだけ確認する。

`COMM_ACCOUNTS_ENABLED` `LINE_CONVERSATION_ENABLED` `COMM_ACCOUNTS_ORG_IDS` `LINE_CONVERSATION_ORG_IDS` `LINE_WEBHOOK_AUTO_SETUP_ENABLED` `LINE_APPROVER_LINK_ENABLED` `LINE_APPROVER_BINDING_MATCH` `LINE_WORKFLOW_REVISION_REPLY` `LINE_RESOLVE_FOLLOWUP_REPLY` `LINE_LINK_CODE_LIMITS_ENABLED` `EMPLOYEE_HOLD_ENABLED` `NOTIFICATION_CONFIG_ENCRYPTION_KEY` `COMM_CONVERSATION_TOKEN_SECRET` `COMM_CONVERSATION_TOKEN_SECRET_PREVIOUS` `VOTER_BINDING_SECRET` `NEXT_PUBLIC_APP_URL` `NEXT_PUBLIC_SUPABASE_URL` `NEXT_PUBLIC_SUPABASE_ANON_KEY` `SUPABASE_SERVICE_ROLE_KEY` `RESEND_API_KEY` `EMAIL_FROM` `APPROVAL_ALERT_OPS_EMAILS`

本番の会話フラグは TOKYO307（`92f3617c-33fc-4dac-b9b4-d4f42e8522ac`）だけ。グローバル ON は実機中止。

正本: `lib/comm/line-poc-env.ts`

---

## (5) 設計書 §6 — Grok Bot が `surface=line` の札を返せるか（E2E-03）

### 分かったこと

- 設計 §6 注意: Grok Bot 側に LINE を直接受ける窓口は無い。Staffpass が受け、wake Webhook で起こし、返事は `staffpass_invoke` → `comm.reply`。Grok Bot の変更は「要らない見込み」だが、**ルーチンが `conversation.surface = "line"` の札をそのまま返せるかは未確認**。
- Staffpass 側は札を返す用意がある。
  - wake 本文: `lib/comm/line-wake.ts` 94–107 行。`surface: "line"` と `conversationToken` を載せる。
  - 受信: `isLineConversationRequest`（`lib/comm/line-invoke.ts` 15–18）。フラグ ON かつ `ctx.surface === "line"` かつ会話の札があるときだけ LINE 送信に入る。
  - 札が無い / surface が line でない → `delivery_unsupported_surface`（H1 バックストップ）。
- 単体は「Grok Bot が surface=line をエコーした」前提で通る（`lib/comm/line-invoke-policy.test.ts`）。**本番の Grok Bot ルーチンがそれを返すかは L0 では未確認（U-08 / L1）。**

### 本番で確認する手順（U-08。エージェントは本番に書かない）

1. TOKYO307 だけフラグ ON。安藤の OA Webhook が `/api/webhooks/line/c/<ref>`。
2. 木村が安藤の wake webhook 先（Grok Bot）を SELECT で確認する（値はチャットに貼らない）。
3. 連携済みの 1対1 で短い文を送る（業務に影響しない内容）。
4. Grok Bot 側の invoke ログで、`comm.reply` の `conversation.surface` が `line` か、`conversationToken`（`spc1.`…）が付いているかを見る。
5. 付いていれば LP-E2E-03 に進む。付いていなければ実機の会話を中止し、Grok Bot の Routine に「wake の `surface` と `conversationToken` をそのまま `comm.reply` に返す」を足す。

---

## この PR で実装した決定 / 記録だけ

| 決定 | 扱い |
|---|---|
| U-02 unfollow | 実装。連携だけ revoke。起こし・送信停止。窓口は ACTIVE。再 follow では戻さない |
| U-07 Web 限定高リスク | 一覧をコードから抽出。実装済みゲートは停止解除のみ |
| U-10 再送 ON | 前提として記録。実機 LP-E2E-01/08 |
| U-11 社外は既定承認。confidential/verbatim は承認なしで出さない | 既存 `lib/comm/line-invoke.ts` |
| U-12 destination | 実装。欠落 400 / 不一致 403。書き込み・起こし 0 |
| U-17 社員削除で窓口 disabled | 既存 `lib/employees/retire.ts` 54–60。試験 `LP-RET-01` |
| U-20 上限メールはテナント承認者 | 記録 + 定数。送信は U-05 の該当 PR |
| U-21 8 割はテナント管理者メール + 運営知らせ | 記録 + 定数。送信は U-05 の該当 PR |

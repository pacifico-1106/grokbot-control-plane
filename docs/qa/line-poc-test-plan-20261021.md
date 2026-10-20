# LINE PoC 試験計画（QA）— 2026-10-21

- 作成: 2026-10-21（QA。実装はしない。本番環境・本番 DB には触れない）
- 対象: Staffpass の LINE PoC（AI 社員 1 人 × LINE 1対1 の会話 × LINE での承認）
- 実装担当: 森（これから）。本計画は合否の物差しであり、実装の指示書ではない
- 設計正本: `uploads` の設計書 `line-lineworks-design-20261012.md`（以下「設計」）。特に §3-1（PoC 範囲）、§5（セキュリティ）、§6（既存の穴）
- 既存保証の根拠: Slack 経路の現行コード。LINE でも同じ保証が要る点は、各試験の「根拠」にファイルパスを付けた
- 試験環境: **staging / preview / 専用の試験テナントのみ**。`staffpass.sealith.com` と本番 DB は使わない。読み取り専用 SQL も本番には向けない

---

## 0. この文書の使い方

1. 森の実装が試験環境に載ったあと、QA が本計画の ID を順に消化する。
2. 各試験は **ID / 前提 / 手順 / 期待結果 / 合否判定 / 自動化** を持つ。合否判定は「ログのキー」「DB の行」「画面または LINE の文言」のいずれか（または複数）で取る。推測で埋めない。
3. 設計に無い、設計と現行 Slack / 現行 LINE コードが食い違う、決めないと手順が書けない点は **§10 未決事項** にだけ置く。試験本文では「未決 U-xx が決まるまで保留」と書く。
4. 現行 `main`（この文書作成時点）には、会話用 LINE の部品（`lib/comm/line-ingress.ts` ほか）と承認用 LINE Webhook（`app/api/webhooks/line/[ref]/route.ts`）が既にある。森の実装がこれを使うか置き換えるかは未決（U-01）。期待結果は **設計と Slack の保証** を先に書き、現行コードは「参照実装」として根拠欄に置く。

### 0-1. PoC の範囲（設計 §3-1。これ以外は本計画の対象外）

- AI 社員 1 人。その社員の公式アカウントとの **1対1**。
- 社内の人は連携コードで紐付ける。紐付けていない相手は社外。送るかは `reply_policy`。
- 承認はその窓口で受ける。
- グループは使わない。
- 高リスクの承認（送金、設定変更など）は、パスキー（K3）が入るまで **Web で承認**する（どの tool / risk が「高リスク」かは U-07）。

### 0-2. フラグ（現行参照。試験環境の既定値は U-09）

| フラグ | 現行の既定 | 出典 |
|---|---|---|
| `COMM_ACCOUNTS_ENABLED` | OFF | `lib/comm/flags.ts` 18–20 行 |
| `LINE_CONVERSATION_ENABLED` | OFF（`COMM_ACCOUNTS_ENABLED` も要る） | 同 26–28 行 |

OFF のとき会話用 Webhook は **404**（`app/api/webhooks/line/c/[ref]/route.ts` 22 行）。フラグ OFF のまま試験すると、署名以外の会話試験は全部 404 で不合格になる。

### 0-3. 自動化の記号

| 記号 | 意味 |
|---|---|
| 単体 | ネットワーク無し。現行の `lib/comm/line-ingress.test.ts` 型。森の PR に同種を求める |
| 結合 | 試験用 DB / 試験用 LINE モック。本番 LINE API には繋がない |
| 手動 | 人の操作。実機通し（§9）はすべて手動 |

---

## 1. Slack 経路から LINE に引き継ぐ保証

LINE でも同じ合否にする。根拠は Slack の現行コード。

| 保証 | Slack での振る舞い | 根拠 | LINE での同じ保証 |
|---|---|---|---|
| 署名不正は拒否 | 欠落・改ざん・別 secret・5 分より古い timestamp → 検証失敗。受信は 401 `unauthorized` | `lib/notify/slack.ts` 60–79 行（`verifySlackSignature`）。`lib/slack/mention-ingress.ts` 1814–1821 行。試験 `lib/slack/mention-ingress.test.ts` 139–150 行、`lib/notify/slack.test.ts` 45–83 行 | `x-line-signature` 欠落・改ざん・別チャネル secret → 401。署名の前に DB 書き込み・wake をしない（設計 §5） |
| 未知の窓口 | 承認用 `[ref]`: チャネルが無いと 200 `{ignored:true}`（`app/api/webhooks/slack/[ref]/route.ts` 76–77 行）。会話: 未バインドは wake しない（`mentioned_ids_not_bound` / `im_no_route_or_self`。`lib/slack/mention-ingress.test.ts` 749–786 行） | 同上 | 設計 §5・L0: 未知の ref は **404**（Slack 承認の 200 ignored には合わせない）。未連携ユーザーは wake してよいが **社外**（設計 §3-1、§2-5） |
| 重複イベント | `slack_mention_events` に `event_id` を 1 回だけ insert。二度目は wake しない。HTTP はどちらも 200 | `lib/slack/mention-ingress.ts` 332–347 行、1537–1539 行。試験 412–438 行、515 行付近 | 同じ `webhookEventId`（`isRedelivery=true` 含む）は二重処理しない。HTTP は 200 のまま（設計 §2-6、§5） |
| 停止中は起こさない・送らない | wake は `checkOperable({phase:"wake"})`。止まっている間の wake は後で届けない。送る直前は `preSendHoldCode`。承認の再実行は `approval_held` 409 | `lib/slack/mention-ingress.ts` 499–516 行。`lib/gateway/adapters/slack.ts` 298–300 行。`lib/gateway/invoke.ts` 1388–1420 行。`lib/approvals/execution-authority.ts` 16–21 行 | 同じ関数・同じ phase。会話も承認の実行も通さない（設計 §5「停止」） |
| 送信結果の三分 | `sendState`: `sent` / `not_sent` / `unknown`。`not_sent` だけ台帳を failed にしてよい。それ以外は uncertain。空宛先は `accepted` にしない | `lib/gateway/adapters/slack.ts` 262–300 行。`lib/comm-reply-dedup/guard.ts` 98–114 行。H1: `lib/gateway/invoke.ts` 3193–3228 行、3914–3930 行。`lib/approvals/not-sent.ts` 14–79 行 | 同じ三分。Slack 以外で実際に届いていない送信を `accepted` / 成功にしない（設計 §5「送れたかどうか」、§6 H1） |
| テナント分離 | 承認は `orgId` 付きで引く。他 org は null。解決も org 必須 | `lib/data/approvals.ts` 593–616 行。`lib/data/p0-auth-idor.test.ts` 15–73 行。Slack 承認は `getApprovalByTelegramRef(action.value, channel.orgId)`（`app/api/webhooks/slack/[ref]/route.ts` 187 行） | ref → 窓口アカウント → org はサーバーの DB だけ。イベントの `destination` で org を決めない（設計 §5） |

---

## 2. 観点 1 — 署名不正（`x-line-signature`）

対象経路（PoC）:

- 会話: `POST /api/webhooks/line/c/<ref>`（`app/api/webhooks/line/c/[ref]/route.ts`）
- 承認: `POST /api/webhooks/line/<ref>`（`app/api/webhooks/line/[ref]/route.ts`）

共通の期待: 拒否は **401**、本文 `{ ok: false, error: "unauthorized" }`。署名の前に `comm_inbound_events` への insert、wake、承認解決をしない。

Slack 対比: `verifySlackSignature` は欠落・別 secret・古い timestamp を false にし、受信は 401（§1）。LINE の署名に時刻は入らない（設計 §2-6）。古いイベントは観点 3 で見る。

### LP-SIG-01 — 会話 Webhook: 署名ヘッダ欠落

| 項目 | 内容 |
|---|---|
| 前提 | 試験テナントに ACTIVE な会話用窓口アカウントがある。フラグ ON。正しい JSON 本文（`destination` = そのアカウントの bot userId、1対1 text、`webhookEventId` あり） |
| 手順 | `x-line-signature` 無しで `POST /api/webhooks/line/c/<正しい ref>` |
| 期待結果 | 401。wake しない。DB に inbound 行が増えない |
| 合否判定 | HTTP 401 かつ JSON `error` が `unauthorized`。ログに `line_account_dispatch` / wake が無い。試験 DB: `comm_inbound_events` に当該 `event_key` が無い（表: `supabase/migrations/20261013200000_employee_comm_accounts.sql` 77–84 行） |
| 自動化 | 単体（現行 `lib/comm/line-ingress.test.ts` 103–110 行が空署名を 401 にしている。ルート直も `app/api/webhooks/line/c/[ref]/route.test.ts`） |

### LP-SIG-02 — 会話 Webhook: 本文改ざん

| 項目 | 内容 |
|---|---|
| 前提 | LP-SIG-01 と同じ。正しい secret で署名したあと、本文の 1 文字だけ変える（署名は変えない） |
| 手順 | 改ざん本文 + 元の署名で POST |
| 期待結果 | 401。処理しない |
| 合否判定 | 同上。正しい本文を後から送ったときは 200 になり、そのときだけ 1 回 dispatch される（現行試験 103–110 行の「本物は後で通る」） |
| 自動化 | 単体 |

### LP-SIG-03 — 会話 Webhook: 別チャネルの secret で署名

| 項目 | 内容 |
|---|---|
| 前提 | アカウント A の ref と secret。別の 32 バイト secret で HMAC-SHA256 → base64 |
| 手順 | A の URL に、別 secret の署名を付けて POST |
| 期待結果 | 401。A の inbound / wake が無い |
| 合否判定 | HTTP 401。`comm_inbound_events` に行が無い。定数時間比較であること（現行 `lib/comm/line-ingress.ts` 105–110 行 `timingSafeEqual`。Slack は `lib/notify/slack.ts` 77–79 行） |
| 自動化 | 単体 |

### LP-SIG-04 — 会話 Webhook: 正しい署名は受け付ける（陽性対照）

| 項目 | 内容 |
|---|---|
| 前提 | LP-SIG-01 の正しい本文と、そのアカウントの channel secret |
| 手順 | 正しい `x-line-signature` で POST |
| 期待結果 | 200 `{ ok: true }`。1対1 text なら 1 回だけ wake 用に dispatch |
| 合否判定 | HTTP 200。ログに本文が無い（設計 §5「個人の情報」、C8）。`comm_inbound_events` に `event_key` だけ 1 行（本文列は無い） |
| 自動化 | 単体 |

### LP-SIG-05 — 署名の前に JSON も DB も触らない（順序）

| 項目 | 内容 |
|---|---|
| 前提 | 未知の ref、または正しい ref で悪い署名 |
| 手順 | 不正リクエストを送り、サーバー側の問い合わせ順を試験（モック）で見る |
| 期待結果 | 設計 §5: 「ref で窓口アカウントを決める → 署名（違えば 401）→ JSON → イベント」。未知 ref は署名の前に 404。悪い署名は JSON パースも inbound も wake もしない |
| 合否判定 | 未知 ref: 404 `not_found`、secret 読みも inbound も 0 回。悪い署名: secret 読みのあと 401、`recordInboundEvent` 0 回。根拠: `lib/comm/line-ingress.ts` 6–12 行、118–129 行。Slack 会話は署名のあとだけ envelope を渡す（`lib/slack/mention-ingress.ts` 1814–1835 行） |
| 自動化 | 単体 |

### LP-SIG-06 — 承認 Webhook も同じ拒否

| 項目 | 内容 |
|---|---|
| 前提 | 承認用チャネル（`org_notification_channels`）の正しい ref |
| 手順 | SIG-01〜03 を `POST /api/webhooks/line/<ref>` で繰り返す |
| 期待結果 | 401 `unauthorized`。承認解決・fulfill が走らない |
| 合否判定 | HTTP 401。`approval_requests.status` が変わらない。根拠: `app/api/webhooks/line/[ref]/route.ts` 286–288 行、`lib/notify/line.ts` 62–73 行 `verifyLineSignature` |
| 自動化 | 単体（`app/api/webhooks/line/ref-route.test.ts`） |

---

## 3. 観点 2 — 未知の ref / 未連携ユーザー / 未知の destination

設計 §5: 未知の ref は 404。org はイベントの `destination` では決めない。未連携の 1対1 は社外（§3-1）。

Slack 対比: 承認 unknown ref は 200 ignored（§1）。LINE は設計どおり **404**（L0 厳格化。`app/api/webhooks/line/[ref]/route.ts` 282–285 行）。会話の未バインドは Slack では wake しない。LINE の未連携は **社外として起こしてよい**（送るときは承認が要る）。混ぜない。

### LP-UNK-01 — 存在しない会話 ref

| 項目 | 内容 |
|---|---|
| 前提 | どの `employee_comm_accounts.webhook_ref` にも無い文字列 |
| 手順 | `POST /api/webhooks/line/c/<未知 ref>`（署名の有無は問わない） |
| 期待結果 | 404 `{ ok: false, error: "not_found" }`。本文を読まない（現行ルート 26–30 行は account 解決のあと本文。設計は「未知の ref は 404」。ルートが先に 404 なら本文未読が望ましい） |
| 合否判定 | HTTP 404。inbound / wake 0。シークレットをログに出さない |
| 自動化 | 単体（`lib/comm/line-ingress.test.ts` 97–100 行） |

### LP-UNK-02 — 改ざん・パストラバーサル風の ref

| 項目 | 内容 |
|---|---|
| 前提 | なし |
| 手順 | `../etc`、短すぎる値、43 文字のランダムなど |
| 期待結果 | 404。他アカウントを引き当てない |
| 合否判定 | すべて 404。現行試験 97–100 行 |
| 自動化 | 単体 |

### LP-UNK-03 — pending / disabled の窓口アカウント

| 項目 | 内容 |
|---|---|
| 前提 | 同じ org に pending または disabled の会話アカウントがある |
| 手順 | その webhook ref へ正しい署名で POST |
| 期待結果 | 設計・現行: ACTIVE 以外は 404（`lib/comm/line-ingress.ts` 7–8 行、118–120 行） |
| 合否判定 | 404。wake 0 |
| 自動化 | 単体 |

### LP-UNK-04 — 署名は通るが `destination` が別 bot

| 項目 | 内容 |
|---|---|
| 前提 | アカウント A（bot userId = Ua…）。本文の `destination` を Ub… にする。A の secret で署名 |
| 手順 | A の会話 Webhook へ POST |
| 期待結果 | 401 `destination_mismatch`。org を差し替えない。inbound / wake 0（設計 §5「イベントの中の値で org を決めない」。現行 138–139 行） |
| 合否判定 | HTTP 401、JSON `error` が `destination_mismatch`。`employee_comm_accounts` の org_id が変わらない |
| 自動化 | 単体（`lib/comm/line-ingress.test.ts` 112–116 行） |

### LP-UNK-05 — 紐づけの無い LINE ユーザーからの 1対1

| 項目 | 内容 |
|---|---|
| 前提 | 正しい ref・署名・destination。送信者 userId は voter binding に無い。社員は停止していない |
| 手順 | 1対1 text を送る |
| 期待結果 | Webhook 200。wake する（未知ユーザーだからといって 404 にはしない）。WHO は社外。返信は `reply_policy` が許すか人の承認が付くまで送らない（設計 §3-1、§2-5。現行 `lib/comm/line-send.ts` 112–121 行 `external_send_needs_approval`） |
| 合否判定 | `comm_inbound_events` に 1 行。wake 1 回。会話の札の counterparty はその userId。`comm.reply` を承認なしで呼ぶと `sent: false`、LINE API を呼ばない。未連携の返事文言はテナント設定依存（U-11） |
| 自動化 | 単体（送信拒否）＋ 結合（wake） |

### LP-UNK-06 — 承認 Webhook の未知 ref

| 項目 | 内容 |
|---|---|
| 前提 | 承認用に登録されていない ref |
| 手順 | `POST /api/webhooks/line/<未知 ref>` |
| 期待結果 | 404 `not_found`。本文未読（`app/api/webhooks/line/[ref]/route.ts` 282–285 行「LINE Developers の検証ボタンが失敗する」） |
| 合否判定 | HTTP 404。承認行が無い |
| 自動化 | 単体（`app/api/webhooks/line/ref-route.test.ts`） |

---

## 4. 観点 3 — 重複・再送（同じ `webhookEventId`、`isRedelivery=true`）

Slack 対比: `event_id` の unique insert。重複は wake 0、HTTP 200（§1）。

LINE: 署名に時刻が無いので、同じ署名付き本文を何度でも送り直せる（設計 §6 H10）。止めは `webhookEventId` の一意（`comm_inbound_events` PK `(account_id, event_key)`）。

### LP-DED-01 — 同じ `webhookEventId` を二度送る

| 項目 | 内容 |
|---|---|
| 前提 | LP-SIG-04 が通る本文 |
| 手順 | 同じ本文・同じ署名を連続で 2 回 POST |
| 期待結果 | どちらも 200。dispatch / wake は 1 回だけ |
| 合否判定 | `comm_inbound_events` が当該 `(account_id, event_key)` で 1 行。wake ログ 1 回。2 回目の insert は duplicate 扱い（現行 `lib/comm/accounts.ts` 369–375 行、`line-ingress.ts` 156–160 行。試験 `line-ingress.test.ts` 138–144 行） |
| 自動化 | 単体 |

### LP-DED-02 — `isRedelivery=true` の再送

| 項目 | 内容 |
|---|---|
| 前提 | 1 回目は `deliveryContext.isRedelivery=false` で処理済み |
| 手順 | 同じ `webhookEventId` で `isRedelivery=true` のイベントを POST（署名は新しい本文に対して取り直す） |
| 期待結果 | 200。二度目は処理しない（設計 §2-6「再送しても webhookEventId は同じ」） |
| 合否判定 | wake 合計 1。inbound 1 行。現行試験 138–144 行 |
| 自動化 | 単体 |

### LP-DED-03 — `webhookEventId` が無いイベント

| 項目 | 内容 |
|---|---|
| 前提 | 正しい署名。イベントに `webhookEventId` が無い |
| 手順 | POST |
| 期待結果 | 200。処理しない（設計 §6 H7。現行 `line-ingress.ts` 14 行、152–153 行） |
| 合否判定 | inbound 0、wake 0。試験 146–149 行 |
| 自動化 | 単体 |

### LP-DED-04 — 古すぎるイベント（再送印なし）

| 項目 | 内容 |
|---|---|
| 前提 | `timestamp` が現在より 1 時間以上前。`isRedelivery` が false または無し |
| 手順 | POST |
| 期待結果 | 捨てる（設計 §2-6、§5）。現行は 1 時間（`LINE_STALE_MS`、`line-ingress.ts` 47 行、157 行） |
| 合否判定 | wake 0。再送印付きの古いイベントは処理してよい（現行試験 152–157 行）。1 時間という閾値を変えるなら本試験の期待を更新する |
| 自動化 | 単体 |

### LP-DED-05 — inbound 台帳が書けないとき

| 項目 | 内容 |
|---|---|
| 前提 | `recordInboundEvent` が error を返す（試験用モック） |
| 手順 | 正しいイベントを POST |
| 期待結果 | 処理しない。Webhook は 503 を返し、LINE の再送に任せる（現行 `line-ingress.ts` 16–18 行、160 行、147 行） |
| 合否判定 | HTTP 503 `retry`。wake 0 |
| 自動化 | 単体 |

### LP-DED-06 — 承認 postback の二重押し / 再送

| 項目 | 内容 |
|---|---|
| 前提 | pending の承認カード。同じ `webhookEventId` の postback を 2 回 |
| 手順 | 承認ボタン相当の postback を 2 回送る |
| 期待結果 | 解決は 1 回。fulfill も 1 回。Slack 承認と同じく、主防御は `status !== pending` と条件付き更新（`app/api/webhooks/slack/[ref]/route.ts` 237–255 行）。LINE は `decisionId: line:${channel.id}:${webhookEventId}`（`app/api/webhooks/line/[ref]/route.ts` 208 行）。`webhookEventId` が空だと decisionId が空になり重複を止められない（設計 H7）→ DED-03 と同じく **処理しない** |
| 合否判定 | `approval_requests.status` が `approved`（または `rejected`）の 1 遷移。fulfill 監査 1 回。2 回目の LINE 返事は「対象は処理済みか見つかりません。」（`MSG_NOT_FOUND`、同ファイル 54 行、174–176 行） |
| 自動化 | 単体 |

---

## 5. 観点 4 — 停止中の社員（社員単位・組織全体）

Slack 対比: wake は `checkOperable phase:"wake"`、送る直前は `preSendHoldCode`、止まっている間の発言は後で起こさない、承認チケットが hold に触れたら `approval_held`（§1）。

設計 §5: 新しい wake / 送信は止まる。**承認カードは止まっていても出る**（S2 と同じ）。実行は `approval_held`。

現行 LINE 会話: ingress で hold を先に見る（`line-ingress.ts` 20–22 行、167–176 行）。送る直前は `lib/comm/pre-send.ts` 86–88 行。呼び出し元一覧は `lib/safety/hold-callers.test.ts` 24 行、61–66 行。

### LP-HLD-01 — 社員単位の停止で会話 wake が通らない

| 項目 | 内容 |
|---|---|
| 前提 | 対象社員が `kind=stopped`（または leave / quarantined）。org は止まっていない |
| 手順 | 連携済みユーザーから 1対1 text |
| 期待結果 | Webhook 200。wake しない。イベントキーは消費する（後で解除しても同じイベントでは起こさない） |
| 合否判定 | dispatch 0。`audit_events.action` が `employee.hold.wake_suppressed`、`purpose` が `comm.line`、`metadata.reason` が `employee_on_hold`（現行 `line-ingress.ts` 231–248 行。Slack は `mention-ingress.ts` 506–514 行で同じ action）。試験 171–178 行 |
| 自動化 | 単体 |

### LP-HLD-02 — 組織全体の停止で会話 wake が通らない

| 項目 | 内容 |
|---|---|
| 前提 | `orgs.hold_id` が開いている。社員単位の hold は無くてよい |
| 手順 | LP-HLD-01 と同じ |
| 期待結果 | wake しない。`metadata.reason` が `org_on_hold` |
| 合否判定 | 同上。Slack の org hold と同じコード（`lib/safety/hold.ts` の `HoldDenyCode`） |
| 自動化 | 単体 |

### LP-HLD-03 — hold が読めないときは fail-closed

| 項目 | 内容 |
|---|---|
| 前提 | `checkOperable` が throw、または `hold_state_unavailable` |
| 手順 | 1対1 text |
| 期待結果 | wake しない（Slack / 設計と同じ fail-stop。`lib/safety/hold.ts` 9–12 行） |
| 合否判定 | dispatch 0。現行試験 181–186 行 |
| 自動化 | 単体 |

### LP-HLD-04 — 停止中に消費したイベントは解除後も再実行しない

| 項目 | 内容 |
|---|---|
| 前提 | LP-HLD-01 のあと同じ `webhookEventId` を、hold 解除後に `isRedelivery=true` で再送 |
| 手順 | 再送 POST |
| 期待結果 | 起きない（Slack: 「止まっている間に届いた発言は後で起こさない」。設計 §5） |
| 合否判定 | wake 0。inbound は既に 1 行のまま。現行試験 171–178 行 |
| 自動化 | 単体 |

### LP-HLD-05 — 札は有効でも、送る直前の社員停止で送らない

| 項目 | 内容 |
|---|---|
| 前提 | 停止前に発行した会話の札（未期限切れ）。その後に社員を停止 |
| 手順 | `comm.reply`（または試験用の `sendLineConversationMessage`） |
| 期待結果 | LINE API を呼ばない。`sendState` は `not_sent`。理由 `employee_on_hold`（`lib/comm/pre-send.ts` 8–11 行、86–88 行。Slack `lib/gateway/adapters/slack.ts` 298–300 行） |
| 合否判定 | invoke 409、`sent: false`、`code` が `employee_on_hold`（`lib/gateway/invoke.ts` 2919–2943 行）。監査 `line.post_failed`、`sent: false`。試験 `lib/comm/line-send.test.ts` 122–128 行、`lib/comm/pre-send.test.ts` 85–101 行 |
| 自動化 | 単体 |

### LP-HLD-06 — 送る直前の組織全体停止

| 項目 | 内容 |
|---|---|
| 前提 | 札発行後に org hold |
| 手順 | LP-HLD-05 と同じ |
| 期待結果 | `not_sent`、理由 `org_on_hold`。LINE API 0 回 |
| 合否判定 | 同上（`code` が `org_on_hold`） |
| 自動化 | 単体 |

### LP-HLD-07 — 停止が触った承認チケットの再実行

| 項目 | 内容 |
|---|---|
| 前提 | 承認済みだが `metadata` に hold 印があるチケット（`heldTicketMarker`） |
| 手順 | 同じ `approvalId` で `comm.reply` / 確定系を再 invoke |
| 期待結果 | 409 `approval_held`。送らない。メッセージ「この承認は緊急停止で保留・破棄されたため、実行できません。必要なら新しく承認を依頼してください。」（`lib/gateway/invoke.ts` 1388–1420 行。試験 `lib/gateway/line-comm-reply.test.ts` 335–349 行） |
| 合否判定 | HTTP 409、`code` が `approval_held`、`sent` が無いまたは false。監査 `tool.invoke` の summary に「再実行を停止で保留されたチケットのため拒否」 |
| 自動化 | 単体 |

### LP-HLD-08 — 停止中は連携コードを消化しない

| 項目 | 内容 |
|---|---|
| 前提 | 社員または org が停止中。有効な連携コードを 1対1 で送る |
| 手順 | `SP-XXXX-XXXX` を会話 OA へ送る |
| 期待結果 | 紐付かない。コードは（実装が先に hold を見るなら）未使用のまま残る。現行 ingress は hold のあとで redeem（`line-ingress.ts` 23–24 行、178–189 行。試験 `lib/comm/line-ingress-l7.test.ts` 99 行付近） |
| 合否判定 | voter binding が増えない。wake 0。LINE に成功文言「✅ Staffpass の社内メンバーとして確認しました。」（`lib/comm/line-link.ts` 16 行）が **出ない** |
| 自動化 | 単体 |

### LP-HLD-09 — 停止中でも承認カードは出る（設計 §5）

| 項目 | 内容 |
|---|---|
| 前提 | 社員停止中。会話または承認フローが承認を要する |
| 手順 | 承認が必要な操作を起こす |
| 期待結果 | 設計: カードは出る。実行はされない。現行の承認用 LINE 送信（`lib/notify/line.ts`）に hold チェックは見当たらない（カード送付は通り得る）。**実行**は G4（`lib/approvals/execution-authority.ts` 16–21 行）で止まる |
| 合否判定 | 試験環境の LINE に Flex「🟡 承認依頼」が見える（`lib/notify/line.ts` 108 行）。ボタンを押して承認しても、fulfill / 再 invoke は `approval_held` または実行ゲートで止まる。カードが出ない実装になったら、設計 §5 との差分として記録し、U-19 を更新する |
| 自動化 | 結合（カード送信のモック）＋ 手動（実機） |

### LP-HLD-10 — LINE で承認しても、停止中は実行しない

| 項目 | 内容 |
|---|---|
| 前提 | LP-HLD-09 のカード。社員または org が停止中 |
| 手順 | LINE で［承認］を押す |
| 期待結果 | 設計 H11: 承認そのものは記録してよい。実行は S2 で止まる |
| 合否判定 | `approval_requests.status` が `approved` になり得る。fulfill の配送が LINE / Slack に実際に出ない。再 invoke は LP-HLD-07。画面 `/app/audit` に実行拒否が残る（`lib/audit/result.ts` 22 行 `approval_held`: 「緊急停止中の承認のため実行しませんでした」） |
| 自動化 | 結合＋手動 |

---

## 6. 観点 5 — unfollow（ブロック）後

設計 L1（PoC 用アダプタ）: 「`unfollow` で窓口を閉じる」。現行 `lib/comm/line-ingress.ts` 19 行は follow を dispatch しない。`unfollow` を処理する口は、この文書作成時点の `lib/comm` に無い。

**閉じ方の具体（無効化 / 連携解除 / wake だけ止める / 再 follow で戻す）は U-02。** 決まるまで LP-UNF-01 の期待は「イベントを受けて 200。本文を保存しない。未決の閉じ処理が仕様になったらその副作用を見る」までとする。推測で「アカウントを disabled にする」とは書かない。

設計 §5: LINE の Push はブロック中でも 200 が返る（公式）。**「届いた」とは書かない。** 現行 `lib/comm/line-send.ts` 161 行は Push HTTP 200 を `status: "sent"` にする。これは設計と食い違う（U-03）。

### LP-UNF-01 — unfollow イベントを受ける

| 項目 | 内容 |
|---|---|
| 前提 | 正しい署名。`type=unfollow`、1対1 の userId。U-02 が未決でも Webhook の受けは試験できる |
| 手順 | unfollow イベントを POST |
| 期待結果 | 200。本文を保存しない。wake しない（現行は text 以外を dispatch しない。試験 `line-ingress.test.ts` 160–168 行は `follow` を dispatch 0） |
| 合否判定 | HTTP 200。wake 0。inbound は `webhookEventId` があれば 1 行（キーのみ）。U-02 決定後: 仕様どおりの行（連携の status、アカウント status など）をここに追記する |
| 自動化 | 単体（受け） / 手動（実機でブロック） |

### LP-UNF-02 — ブロック後の Push を「届いた」にしない

| 項目 | 内容 |
|---|---|
| 前提 | 相手が公式アカウントをブロックしている。会話の札は残っている。U-03（200 を sent と書くか）が決まっていること。未決なら本試験は保留 |
| 手順 | `comm.reply` で Push させる（replyToken 期限切れ） |
| 期待結果 | 設計: 「届いた」とは書かない。invoke の `accepted: true` かつ相手に届いたかのような文言は不合格。Slack の `sendState` 三分に載せる |
| 合否判定 | 保留条件: U-03。決まったあとの判定例（まだ採用しない）: 監査に本文が無い。AI 向けに `sent: false` または `sendState: unknown` と「届いたとは限らない」旨。LINE 公式の 200 だけを成功にしない |
| 自動化 | 単体（モック 200）は U-03 後。手動は実機ブロック |

### LP-UNF-03 — unfollow 後の発言で起こさない

| 項目 | 内容 |
|---|---|
| 前提 | U-02。ブロック中は LINE が message を送らないことが多い。再 follow せずに message が来た場合の扱いは未決 |
| 手順 | （実機）ブロックしたまま、または再追加せずに公式アカウントへ送れないことを確認。再 follow 後に未連携のまま送る場合は LP-UNK-05 |
| 期待結果 | U-02 が「閉じる」と決めた対象（連携 / アカウント）が閉じたままなら、wake しないか社外のまま |
| 合否判定 | U-02 待ち。実機では「ブロック中に Staffpass から Push が来ても、端末に表示されない」ことを観察ログに残す（公式どおり届かない） |
| 自動化 | 手動 |

---

## 7. 観点 6 — 通数上限（月間メッセージ上限）

設計 C7・§3-1: PoC では毎日 quota を読むことと 8 割の知らせ。上限に当たったら、承認の知らせはメールに回し、会話は「送れなかった」として AI に返す。Reply は通数に数えない。Push は数える（設計 §8）。

現行 `lib/comm` に quota API クライアントは見当たらない。`line-send.ts` 171 行は HTTP 429 を `line_rate_limited` / `not_sent` にする（レート制限と月間上限を区別していない）。**月間上限時の LINE の HTTP とエラーコードは U-04。C7 を今回の実装に入れるかは U-05。**

ライトプランは上限到達後に追加できない（設計 §7 決定 8、§8）。**本番 OA や共有 OA で通数を使い切る試験はしない。** 試験用モック、または捨ててよい試験 OA のみ（U-13）。

### LP-QTA-01 — 月間上限到達で会話が送られない

| 項目 | 内容 |
|---|---|
| 前提 | U-04。モックが「月間上限」の応答を返す |
| 手順 | 内部向け（連携済み）の `comm.reply` で Push させる |
| 期待結果 | LINE API は失敗。`sendState` は `not_sent`（上限は「送れていない」が確認できる）。invoke は `accepted` にしない。`sent: false` |
| 合否判定 | HTTP 409、`code` が実装が決めた上限用コード（未決なら 429 相当の `line_rate_limited` を暫定記録し、U-04 と突き合わせる）。監査 `line.post_failed`、`sent: false`。本文をログに出さない |
| 自動化 | 単体（モック） |

### LP-QTA-02 — 上限失敗を成功扱いにしない

| 項目 | 内容 |
|---|---|
| 前提 | LP-QTA-01 |
| 手順 | 応答の `result.accepted` / `sent` / `conversationDelivery` を見る |
| 期待結果 | `accepted: true` が無い。`conversationDelivery` が成功配送にならない。H1 と同じ（`lib/approvals/not-sent.ts` 64 行「相手には届いていません。送ったと伝えないでください。」） |
| 合否判定 | JSON に `sent: false`。dedup 台帳は `not_sent` なら failed（`lib/comm-reply-dedup/guard.ts` 103–104 行）。盲目再送しない |
| 自動化 | 単体 |

### LP-QTA-03 — 上限時、承認カードをメールに回す（C7）

| 項目 | 内容 |
|---|---|
| 前提 | U-05 が「PoC に入れる」かつ、メール宛先（U-20）が決まっている |
| 手順 | 通数上限の状態で、承認が必要な操作を起こす |
| 期待結果 | 設計 C7: 承認の知らせはメール。LINE にはカードを送らない（または送って失敗したらメール） |
| 合否判定 | U-05 / U-20 待ち。決まれば: LINE Push が上限エラー、メール送信の監査、承認画面 `/app/approvals` にはチケットがある |
| 自動化 | 結合（両方モック） / 未決なら保留 |

### LP-QTA-04 — 8 割の知らせ（C7）

| 項目 | 内容 |
|---|---|
| 前提 | U-05。quota / consumption を読める試験ダブル |
| 手順 | consumption が quota の 80% 以上になる値を入れる（実通数は使わない） |
| 期待結果 | 運営とテナントに知らせる（設計 C7）。文言・チャネルは未決（U-21） |
| 合否判定 | U-05 / U-21 待ち |
| 自動化 | 結合 / 保留 |

### LP-QTA-05 — Reply は数えず、失敗時に Push へ落ちる経路だけ数える

| 項目 | 内容 |
|---|---|
| 前提 | 設計 §8。Reply 成功なら通数に入れない |
| 手順 | (a) 新しい replyToken で Reply 成功。(b) Reply 400 のあと Push 成功 |
| 期待結果 | (a) 通数 API を叩かない / 消費 0（実装が quota を読むなら増えない）。(b) Push 1 回だけ消費対象 |
| 合否判定 | LINE API 呼び出しが (a) `/v2/bot/message/reply` のみ、(b) reply のあと `/v2/bot/message/push`（現行 `line-send.ts` 136–171 行、試験 160–227 行） |
| 自動化 | 単体 |

---

## 8. 観点 7 — Slack 以外の窓口で、届いていない送信を成功にしない

設計 §6 H1: Slack 以外で宛先が空のとき、送っていないのに `ok: true` / `accepted: true` を返していた。現行ゲートウェイはこれを 409 `delivery_unsupported_surface`、`sent: false` に変えている（`lib/gateway/invoke.ts` 3193–3228 行、3914–3930 行。`lib/approvals/not-sent.ts` 67–79 行）。

会話フラグ ON かつ会話の札があるときは、`deliverLineConversation` に入る（`invoke.ts` 2866–2945 行）。成功だけ `conversationDelivery = { ok: true, delivery: "line" }`。失敗は 409 `sent: false`。不明は 502、`sent: false`、監査「LINE会話投稿の結果が不明（再送は確認後のみ）」。

Slack 対比: 空チャネルは `slack_channel_required` / `not_sent`（`lib/gateway/adapters/slack.ts` 297 行）。`sendState` が無い失敗は uncertain（`comm-reply-dedup/guard.ts` 103–104 行）。

### LP-SND-01 — 会話フラグ OFF、または札が無い LINE 宛

| 項目 | 内容 |
|---|---|
| 前提 | `LINE_CONVERSATION_ENABLED` が OFF、または body に会話の札が無い `surface: "line"` |
| 手順 | `comm.reply` / `comm.send` |
| 期待結果 | 何も送らない。`accepted: true` が無い。409 `delivery_unsupported_surface` または現行の `line_conversation_disabled`（`line-send.ts` 102 行）。メッセージ例: 「LINEへの送信には、まだ対応していません。メッセージは送信していません。」（`lib/approvals/not-sent.ts` 73–76 行） |
| 合否判定 | `sent: false`。LINE API 0。監査 `comm.not_sent`。試験 `lib/gateway/comm-not-sent.test.ts` 93–104 行（フラグ OFF 前提の既存） |
| 自動化 | 単体 |

### LP-SND-02 — LINE API が 4xx で拒否（上限以外）

| 項目 | 内容 |
|---|---|
| 前提 | フラグ ON、有効な札、連携済み。モックが Push 403 |
| 手順 | `comm.reply` |
| 期待結果 | `not_sent`。409。`accepted` なし（現行試験 `line-send.test.ts` 240–250 行、invoke 2919–2943 行） |
| 合否判定 | `code` が `line_http_4xx`（または実装の別名）。`sent: false`。監査 `line.post_failed` |
| 自動化 | 単体 |

### LP-SND-03 — 結果不明（5xx / ネットワーク）

| 項目 | 内容 |
|---|---|
| 前提 | モックが 503 または throw |
| 手順 | `comm.reply` |
| 期待結果 | `sendState: unknown`。自動で Push に落とさない（二重送信防止。`line-send.ts` 25–27 行、153–155 行）。invoke 502、`sent: false`。同じ job の再実行は台帳で止める（`lib/comm/line-invoke.ts` 107–109 行 `alreadyLineUnknown`） |
| 合否判定 | 監査 `line.post_failed`、`code: post_outcome_unknown`、summary「LINE会話投稿の結果が不明（再送は確認後のみ）」（`invoke.ts` 2895–2916 行）。AI 向け `POST_OUTCOME_UNKNOWN_MESSAGE_JA`（`lib/comm-reply-dedup/guard.ts` 71–72 行） |
| 自動化 | 単体 |

### LP-SND-04 — AI の引数で宛先を変えない（H2 / H3）

| 項目 | 内容 |
|---|---|
| 前提 | 札の相手が Ua。args に別の `lineId` / `userId` / `channel` |
| 手順 | `comm.reply` |
| 期待結果 | 送らない。理由 `conversation_target_mismatch`（`lib/comm/conversation-token.ts` 8–10 行、153–164 行。試験 `line-send.test.ts` 101–105 行） |
| 合否判定 | LINE API 0。`sent: false` |
| 自動化 | 単体 |

### LP-SND-05 — ブロック中 Push 200 を成功配送にしない

| 項目 | 内容 |
|---|---|
| 前提 | U-03。LP-UNF-02 と同じ穴 |
| 手順 | ブロック中ユーザーへの Push が 200 を返すモック |
| 期待結果 | 設計 §5: 「届いた」とは書かない。`conversationDelivery.ok` だけを見て `accepted: true` にするのは不合格 |
| 合否判定 | U-03 待ち。決まるまで「200 を観測した」ことと「端末に無い」ことを実機メモに残す |
| 自動化 | 保留 → 単体 |

### LP-SND-06 — 実際に送れたときだけ配送成功

| 項目 | 内容 |
|---|---|
| 前提 | モック Reply または Push が 200。連携済み |
| 手順 | `comm.reply` |
| 期待結果 | このときだけ `conversationDelivery.delivery === "line"`。最終 JSON の `sent: true` は配送記録がある経路だけ（`invoke.ts` 3933–3937 行、2945 行） |
| 合否判定 | `ok: true` かつ `sent: true` かつ `delivery: "line"`。本文がログに無い |
| 自動化 | 単体 |

### LP-SND-07 — 配送記録なしで invoke 末尾に落ちない（H1 バックストップ）

| 項目 | 内容 |
|---|---|
| 前提 | 会話ツールなのにどの送信分岐にも入らない合成リクエスト（試験用） |
| 手順 | invoke |
| 期待結果 | 409 `conversation_not_sent`、`sent: false`、「メッセージは送信していません。」（`invoke.ts` 3914–3930 行） |
| 合否判定 | `accepted: true` が無い。監査 `comm.not_sent` |
| 自動化 | 単体 |

---

## 9. 観点 8 — テナント分離

設計 §5: 窓口は `(org_id, employee_id)`。ref → アカウント → org は DB だけ。`destination` で org を決めない。外部アカウント ID は全テナントで一意。会話の札は org・社員を HMAC で束ねる。相手台帳・連携コード・voter binding は org_id で絞る。

Slack 対比: `getApprovalByTelegramRef(ref, orgId)`、他 org は null（`lib/data/p0-auth-idor.test.ts` 57–72 行）。Inbox 停止も `getApprovalByTelegramRef(ref, input.orgId)` かつ `approval.orgId !== input.orgId` で拒否（`lib/safety/hold-inbox.ts` 42–43 行）。

### LP-TNT-01 — 他テナントの会話 webhook ref

| 項目 | 内容 |
|---|---|
| 前提 | org A のアカウント refA。org B の secret で署名した本文、または refA に B のイベント |
| 手順 | refA へ B 向けの内容を POST。逆も行う |
| 期待結果 | 署名が A の secret と違う → 401。destination が A の bot と違う → 401。B の社員を起こさない |
| 合否判定 | org B の `comm_inbound_events` / audit が増えない。org A でも destination 不一致なら inbound 0 |
| 自動化 | 単体＋結合 |

### LP-TNT-02 — 他テナントの会話の札

| 項目 | 内容 |
|---|---|
| 前提 | org A の社員で発行した札。org B の credential で `comm.reply` |
| 手順 | B として invoke |
| 期待結果 | 拒否。`conversation_token_wrong_org`（`lib/comm/conversation-token.ts` 123 行）。別社員なら `conversation_token_wrong_employee`（124 行。試験 `line-send.test.ts` 108–111 行） |
| 合否判定 | LINE API 0。B の送信監査が成功にならない |
| 自動化 | 単体 |

### LP-TNT-03 — 他テナントの承認 ID / telegramRef

| 項目 | 内容 |
|---|---|
| 前提 | org A の pending 承認。org B の LINE 承認チャネル |
| 手順 | B の Webhook から A の telegramRef で postback |
| 期待結果 | 見つからない。返事「対象は処理済みか見つかりません。」（`getApprovalByTelegramRef(match[2], channel.orgId)`、`app/api/webhooks/line/[ref]/route.ts` 170 行） |
| 合否判定 | A の `approval_requests.status` が `pending` のまま。B に A の title が返らない |
| 自動化 | 単体 |

### LP-TNT-04 — 本文の destination / orgId でテナントを選ばない

| 項目 | 内容 |
|---|---|
| 前提 | 正しい A の署名。JSON に別 org の UUID を足す（現行試験 125–135 行が body に orgId を混ぜてもアカウント行の org を使う） |
| 手順 | POST |
| 期待結果 | org / employee / account はアカウント行だけ |
| 合否判定 | dispatch の `orgId` がアカウントの org。試験 125–135 行 |
| 自動化 | 単体 |

### LP-TNT-05 — 同じ公式アカウントを別テナントが登録できない

| 項目 | 内容 |
|---|---|
| 前提 | org A が bot Ux を登録済み。設計 §5 `unique (surface, external_account_id)` |
| 手順 | org B が同じ Ux を登録しようとする |
| 期待結果 | 失敗。A の行は残る |
| 合否判定 | 試験 DB の unique 違反または API の拒否コード。A の secrets が B から読めない（`readCommAccountSecretsForServer(orgId, accountId)` は org 付き。`lib/comm/accounts.ts`） |
| 自動化 | 結合（`tests/security/db-employee-comm-accounts.sql` が近縁） |

### LP-TNT-06 — 連携・voter binding は org で絞る

| 項目 | 内容 |
|---|---|
| 前提 | 同じ LINE userId を、A では連携済み、B では未連携 |
| 手順 | B の OA にその userId から 1対1 |
| 期待結果 | B では社外。A の binding を読まない（channel key は `comm_account:<accountId>`。`lib/comm/line-send.ts` 11–13 行、114 行） |
| 合否判定 | B の送信は `external_send_needs_approval`。A の binding 行の org_id が A のまま |
| 自動化 | 単体＋結合 |

### LP-TNT-07 — 秘密の値がログ・監査・API 応答に出ない

| 項目 | 内容 |
|---|---|
| 前提 | 署名失敗、送信失敗、設定画面の読み取り |
| 手順 | 失敗系を起こし、ログと audit と API JSON を見る |
| 期待結果 | channel secret / access token / 会話の本文が出ない（設計 §5、C8。現行 ingress 試験 275 行付近が本文非ログ） |
| 合否判定 | 応答 JSON と `audit_events.metadata` に secret 文字列が無い。画面は「入れるだけ、二度と表示しない」（設計 C5） |
| 自動化 | 単体 |

### LP-TNT-08 — 他テナントの承認 ref で緊急停止しない

| 項目 | 内容 |
|---|---|
| 前提 | org A の承認カード ref。org B の LINE チャネル |
| 手順 | B の Webhook で `s:<A の ref>` postback |
| 期待結果 | 「対象が見つかりません。」（`hold-inbox.ts` 42–43 行）。A の社員が止まらない |
| 合否判定 | A の `employee_holds` に新しい open 行が無い。B の org も誤って止まらない |
| 自動化 | 単体 |

---

## 10. 観点 9 — 実機通し（八坂さんの端末。手動）

**本番禁止。** 試験用テナントと試験用公式アカウントだけ。手順の画面 URL・成功メッセージの最終形は、森の画面実装後に U-15 で埋める。以下は設計と現行コードから言える判定だけを書く。

登場: 八坂さん（LINE 端末＋試験テナントのメンバー）、試験用 AI 社員 1 人、試験環境のダッシュボード。解除に別オーナーが要る場合は U-14。

各段階のあと、次へ進む前に合否を取る。不合格なら止める。

### LP-E2E-01 — 友だち追加

| 項目 | 内容 |
|---|---|
| 前提 | §11 の事前物が揃い、試験環境の Webhook URL が公式アカウントに設定済み。再送設定は U-10 |
| 手順 | 八坂さんの LINE で試験用 OA を友だち追加する |
| 期待結果 | LINE 上で友だちになる。Staffpass は follow では起こさない（現行。U-02 が follow 処理を足したら更新） |
| 合否判定 | 端末: トークが開ける。試験環境ログ: follow で wake が無い。inbound に follow の `webhookEventId` があっても AI に本文が渡っていない |
| 自動化 | 手動 |

### LP-E2E-02 — 紐づけ（連携コード）

| 項目 | 内容 |
|---|---|
| 前提 | 八坂さんが試験テナントにログイン中。自分用の連携コードを発行できる（設計 §5「ログイン中のメンバーが自分用に発行」）。社員は停止していない |
| 手順 | ダッシュボードでコード発行 → **1対1** でコードだけ送る（グループは不可。承認経路の文言: 「連携コードは、公式アカウントとの 1:1 トークで送ってください（グループでは受け付けません）。」`app/api/webhooks/line/[ref]/route.ts` 63 行） |
| 期待結果 | 会話 OA なら「✅ Staffpass の社内メンバーとして確認しました。」（`lib/comm/line-link.ts` 16 行）。承認 OA を兼ねるなら承認用の「✅ この LINE アカウントを Staffpass の承認者として確認しました。…」（同 route 59–60 行）。どちらを使うかは U-06 |
| 合否判定 | LINE に成功文言。試験 DB: voter binding が当該 org、provider `line`、channel key が仕様どおり。間違ったコードは 1 種類の失敗返事だけ（設計 §5）。監査に平文コードが無い |
| 自動化 | 手動 |

### LP-E2E-03 — 1対1 の会話

| 項目 | 内容 |
|---|---|
| 前提 | LP-E2E-02 合格。フラグ ON。Grok Bot が札を返せるか（U-08）が試験環境で確認済み |
| 手順 | 八坂さんが 1対1 で短い用事を送る。社外向けの内容は別ケース（未連携端末、または政策で承認が出る内容） |
| 期待結果 | 入力中表示（設計 L1）。社内なら承認なしで返信が来てよい（テナントの `reply_policy` 依存。U-11）。本文が Staffpass に残らない（設計 C8） |
| 合否判定 | 端末に返信。試験環境: wake 1、`comm.reply` の `sent: true` / `delivery: "line"`。`audit_events` に本文が無い。`comm_inbound_events` はキーのみ。同じ文の連打で二重送信しない（dedup） |
| 自動化 | 手動 |

### LP-E2E-04 — LINE での承認

| 項目 | 内容 |
|---|---|
| 前提 | 社外送信または承認必須の操作。高リスクは Web（U-07）。パスキーはまだ無い前提 |
| 手順 | 承認カードが LINE に届く →［承認］を押す |
| 期待結果 | Flex「🟡 承認依頼」（`lib/notify/line.ts` 108 行）。押したあと「承認しました。」（`app/api/webhooks/line/[ref]/route.ts` 219 行）。その後、会話返信が届く（H1 が直っていること） |
| 合否判定 | 端末: カードと「承認しました。」と、承認対象の返信。`approval_requests.status=approved`。fulfill が `slack_channel_required` や `delivery_unsupported_surface` で終わらない（設計 §6 H1。現行 `lib/approvals/fulfill.ts` 1227 行はまだ Slack 宛先検証。森が C4 を入れる前提）。同じボタンの再送は「対象は処理済みか見つかりません。」 |
| 自動化 | 手動 |

### LP-E2E-05 — 停止

| 項目 | 内容 |
|---|---|
| 前提 | 会話が通っている。停止は **試験テナントのダッシュボード**（社員単位）。組織全体停止までやるかは U-22。解除は Web のみ（`lib/safety/hold-inbox.ts` 2–3 行、60 行） |
| 手順 | 試験テナントで当該 AI 社員を緊急停止。八坂さんが LINE でもう一文送る。承認が残っていればボタンも押す |
| 期待結果 | 新しい会話は返ってこない。LINE 返事が来ても「止まっている」系の自動返信は設計に無い（来ないのが期待）。承認実行はされない（LP-HLD-09/10） |
| 合否判定 | 画面: 「緊急停止中」（`components/holds/HoldPanel.tsx` の `KIND_JA`。既存 QA `docs/qa/org-hold-retest-tokyo307-20261016.md` 39 行）。試験 DB: `employee_holds` が open、`kind=stopped`。LINE 送信後も wake 監査が `employee.hold.wake_suppressed`。端末に新しい AI 返信が無い。MCP `staffpass_whoami` を試験環境で使うなら 403 `employee_on_hold`（本番ではやらない） |
| 自動化 | 手動 |

### LP-E2E-06 — 解除

| 項目 | 内容 |
|---|---|
| 前提 | LP-E2E-05。解除は Web、5 分以内の再ログイン（既存 hold 文書 §2。`HOLD_RELEASE_FRESH_LOGIN_MAX_AGE_MS`）。申請者と承認者が同じなら `self_approval_denied` |
| 手順 | 試験テナントの `/app` で「解除を申請」→ 別のオーナーまたは指定管理者が「解除を承認」。その後 LINE で一文 |
| 期待結果 | 停止が閉じる。新しい発言にはまた返信する。停止中の古いイベントは再実行されない（LP-HLD-04） |
| 合否判定 | 画面の「緊急停止中」が消える。`employee_holds.released_at` が not null。`staffpass_whoami` が試験環境で成功。LINE に新しい返信。停止中の文の再送では起きない |
| 自動化 | 手動 |

---

## 11. 試験件数（観点ごと）

| 観点 | ID 接頭辞 | 件数 | 単体 | 結合 | 手動 | 未決で保留しうるもの |
|---|---|---|---|---|---|---|
| 1 署名不正 | LP-SIG-01〜06 | 6 | 6 | 0 | 0 | なし |
| 2 未知の ref / 未連携 / destination | LP-UNK-01〜06 | 6 | 5 | 1 | 0 | UNK-05 の社外返事（U-11） |
| 3 重複・再送 | LP-DED-01〜06 | 6 | 6 | 0 | 0 | なし |
| 4 停止 | LP-HLD-01〜10 | 10 | 8 | 2 | 2（HLD-09/10 の実機） | カード送付の最終実装（U-19） |
| 5 unfollow | LP-UNF-01〜03 | 3 | 1 | 0 | 2 | U-02, U-03 |
| 6 通数上限 | LP-QTA-01〜05 | 5 | 3 | 2 | 0 | U-04, U-05, U-13, U-20, U-21 |
| 7 送信結果 / accepted | LP-SND-01〜07 | 7 | 6 | 0 | 0 | SND-05（U-03） |
| 8 テナント分離 | LP-TNT-01〜08 | 8 | 6 | 2 | 0 | なし |
| 9 実機通し | LP-E2E-01〜06 | 6 | 0 | 0 | 6 | U-06〜U-11, U-14, U-15 |
| **合計** | | **57** | **41** | **7** | **10** | （手動の一部は単体と重複カウントしない。HLD-09/10 は結合＋手動で 2） |

手動列の 10 は UNF-01 実機 + UNF-02/03 + E2E 6 + HLD-09/10 の実機観察。HLD-09/10 は結合としても数えている。

森の PR に最低限載せる単体: LP-SIG-01〜05、UNK-01〜05、DED-01〜05、HLD-01〜08、SND-01〜04 / 06〜07、TNT-02 / 04。既存 `lib/comm/line-*.test.ts` が既に覆うものは、森が経路を変えたときだけ作り直す。

---

## 12. 未決事項

推測で埋めない。決まるまで、参照している試験は保留または「受けだけ見る」。

| ID | 内容 | 試験への影響 | 設計 / コード上の手がかり（決めない） |
|---|---|---|---|
| U-01 | 森が現行 `lib/comm/*` と `/api/webhooks/line/c/<ref>` を使うか、置き換えるか | 合否のパス・ログキーが変わる | 現行は 2026-10-12 設計のあとに main へ入っている |
| U-02 | unfollow で「窓口を閉じる」の具体（アカウント disabled、連携解除、wake 停止のみ、再 follow の扱い） | LP-UNF-01/03、E2E | 設計 L1 の一文だけ。`lib/comm` に unfollow 処理が無い |
| U-03 | ブロック中 Push が 200 のとき `sendState` を何かにするか | LP-UNF-02、SND-05 | 設計 §5「届いたとは書かない」。現行 `line-send.ts` 161 行は 200 → `sent` |
| U-04 | 月間通数上限の LINE HTTP / エラー本体。429 レート制限との区別 | LP-QTA-01/02 | 設計 §8「上限を超えるとエラー」。現行は 429 を `line_rate_limited` |
| U-05 | C7（毎日 quota、8 割知らせ、上限時承認をメールへ）を今回の PoC に入れるか | LP-QTA-03/04 | 設計 §3-1 は LINE PoC に 0.5 日と書いてある |
| U-06 | 承認 OA と会話 OA を同じにするか。Webhook を `/line/<ref>` と `/line/c/<ref>` のどちらに向けるか | E2E-02/04、SIG/UNK の対象 URL | 設計 §7 決定 15 は PoC で同じを推奨。実装は未確定 |
| U-07 | パスキー前に Web へ回す「高リスク」の tool / risk 一覧 | E2E-04 | 設計 §3-1 |
| U-08 | Grok Bot のルーチンが `conversation.surface = "line"` の札を `comm.reply` に返せるか | E2E-03 | 設計 §6「未確認」 |
| U-09 | 試験環境の URL、org、社員、フラグ ON の担当 | すべての結合・手動 | 本番は使わないことだけ決まっている |
| U-10 | 試験用 LINE Developers で Webhook 再送を ON にするか | DED の実再送、E2E | 設計 §2-6「コンソールで ON にすると使える」 |
| U-11 | 未連携（社外）への既定 `reply_policy`（試験テナントの値） | UNK-05、E2E-03 | 設計は社外＋既定承認。テナントが緩めることは可 |
| U-12 | destination 欠落と destination 不一致を HTTP で分けるか | UNK-04 | 現行はどちらも 401 `destination_mismatch` |
| U-13 | 通数試験をモックだけにするか、捨ててよい試験 OA を用意するか | QTA | ライトは上限後に戻せない（設計 §8） |
| U-14 | 実機テナント（新規 PoC 用か、既存の非本番か）。解除に二人要るか | E2E-05/06 | 本番 TOKYO307 は使わない |
| U-15 | 窓口アカウント登録画面の URL と成功／失敗文言 | E2E 前提、設定手順 | 設計 C5。文言は未確定 |
| U-16 | 会話用連携コード失敗時の LINE 文言（承認経路の `MSG_LINK_*` と揃えるか） | E2E-02 | 成功文言だけ `LINE_CONVERSATION_LINKED_REPLY` が決まっている |
| U-17 | 社員削除時に窓口アカウントを無効にする処理の試験対象か（PoC 1 人では起きない） | なし（範囲外寄り） | 設計 §2-4 |
| U-18 | 試験環境の `NOTIFICATION_CONFIG_ENCRYPTION_KEY` / `COMM_CONVERSATION_TOKEN_SECRET` / `VOTER_BINDING_SECRET` が載っているか | 結合・実機 | 設計 §6「本番の鍵は未確認」。試験環境も未確認 |
| U-19 | 停止中の承認カード送付を、現行どおり出すか、会話経路では止めるか | HLD-09 | 設計 §5 は「カードは出る」 |
| U-20 | 上限時に承認を回すメールの宛先 | QTA-03 | 設計 C7 に宛先の列が無い |
| U-21 | 8 割知らせのチャネルと文言 | QTA-04 | 設計 C7「運営とテナントに知らせる」だけ |
| U-22 | 実機通しで組織全体停止までやるか（社員単位だけか） | E2E-05 | 必須観点 4 は両方。実機は社員単位が先でよいが、組織全体は結合で必ず取る |

---

## 13. 八坂さんに事前に用意してもらう物

エージェントや QA が本番を触らなくて済むように、試験の前日までに揃える。

1. **八坂さん本人の LINE アカウント**が入った端末（友だち追加・ブロック・承認ボタンが押せる）。
2. **試験用テナント**のログイン（owner / admin と、紐づけするメンバー）。**本番テナント・本番 URL は使わない。**
3. 試験用 **AI 社員 1 人**（停止・解除してよい）。wake URL が試験環境の Grok Bot を向いていること。
4. 試験専用の **LINE 公式アカウント**（Messaging API）。チャネルシークレットと長期チャネルアクセストークン。本番や顧客の OA は使わない。
5. その OA の LINE Developers で Webhook を試験環境 URL に向ける権限。再送の ON/OFF は U-10。
6. ダッシュボードで **連携コードを自分用に発行**できること（U-15 の画面が載っていること）。
7. 解除用の **別オーナーまたは指定管理者**（一人例外を使わない。U-14）。
8. テナント分離を実 OA で見る場合のみ、**別テナント用の別公式アカウント**。同じ bot を二テナントに登録しない（LP-TNT-05）。
9. 試験環境のフラグ `COMM_ACCOUNTS_ENABLED` と `LINE_CONVERSATION_ENABLED` を ON にする人（八坂さんまたは森。本番は変えない）。
10. 試験 DB の **SELECT だけ**できる人（合否の inbound / hold / approval / audit）。本番 DB の接続情報は渡さない・使わない。
11. 通数試験用は **モック可能な環境**。実 OA で月間上限まで送らない（戻せない）。捨て OA を使うならその旨を先に決める（U-13）。
12. 社外ケース用に、**紐づけしていない別の LINE アカウント**（可能なら。無い場合は結合試験で代える）。

使わないもの: 本番 `staffpass.sealith.com`、TOKYO307 本番 org、本番の承認用 LINE、本番 MCP での `staffpass_invoke`。

---

## 14. 実施時の安全規則

- 本番への POST / UPDATE / RPC / フラグ変更をしない。
- 監査・DB の確認は試験環境の SELECT のみ。
- ログと PR コメントにチャネルシークレット、アクセストークン、連携コード、LINE 本文、個人の userId を貼らない。
- 実機で失敗しても、本番の緊急停止や顧客 OA の Webhook を「試しに」向けない。

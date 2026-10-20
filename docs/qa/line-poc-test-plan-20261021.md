# LINE PoC 試験計画（QA）— 2026-10-21

- 作成: 2026-10-21（QA。実装はしない）
- 追記: 2026-10-21（未決 U-01 / U-03 / U-04 / U-05 / U-06 / U-09 / U-14 / U-19 の決定を反映。該当試験の保留を外した）
- 追記: 2026-10-21（残りの U-02 / U-07 / U-08 / U-10 / U-11 / U-12 / U-13 / U-15 / U-16 / U-17 / U-18 / U-20 / U-21 / U-22 を決定として反映。§13 を決定済みに書き換えた）
- 対象: Staffpass の LINE PoC（AI 社員 1 人 × LINE 1対1 の会話 × LINE での承認）
- 実装担当: 森。本計画は合否の物差しであり、実装の指示書ではない
- 設計正本: `uploads` の設計書 `line-lineworks-design-20261012.md`（以下「設計」）。特に §3-1（PoC 範囲）、§5（セキュリティ）、§6（既存の穴）、§7（推奨）
- 既存保証の根拠: Slack 経路の現行コード。LINE でも同じ保証が要る点は、各試験の「根拠」にファイルパスを付けた
- 試験の書き方（U-01）: `lib/comm/*` を土台に活かし、設計 C の共通部品へ切り出す（置き換えない）。細部のファイル構成は森の判断。**合否は共通部品の振る舞い**（HTTP、JSON、DB の行、監査の action、LINE / 画面の文言）で取る。内部のファイル名や行番号に依存しない。現行パスは「参考」としてだけ書く

---

## 0. この文書の使い方

1. 森の実装が CI とローカルで単体・結合を通したあと、八坂さんの端末で実機通し（§10）を行う。
2. 各試験は **ID / 前提 / 手順 / 期待結果 / 合否判定 / 自動化** を持つ。合否判定は「ログのキー」「DB の行」「画面または LINE の文言」のいずれか（または複数）で取る。推測で埋めない。
3. 未決は残さない。決定済みは「決定」。U-11 は設計 §7 決定 5 を正とする。森／木村の作業（定数・env 名の確認・高リスク一覧の抜き出し・L1 本番の 1 回確認）は試験の前提であり、未決ではない（§13-2）。
4. 参考実装（現行 main）: 会話受信・送信の部品と、承認用 LINE Webhook。森はこれを置き換えず共通部品へ切り出す。試験は切り出し後の振る舞いが設計と Slack 保証を満たすかだけを見る。

### 0-1. PoC の範囲（設計 §3-1。これ以外は本計画の対象外）

- AI 社員 1 人。その社員の公式アカウントとの **1対1**。
- 社内の人は連携コードで紐付ける。紐付けていない相手は社外。送るかは `reply_policy`。
- 承認とその会話は **同じ公式アカウント**（決定 U-06。設計 §7 決定 15 と同じ）。
- Webhook は窓口アカウントごとの `POST /api/webhooks/line/c/<ref>`。中で承認と会話を振り分ける（決定 U-06）。
- グループは使わない。
- 高リスクの承認は、パスキー（K3）が入るまで **Web だけ** で承認する（決定 U-07）。対象は既存の Web 専用と同じ分類: **金銭・秘密（資格情報）・ポリシー変更・停止解除**。tool / risk の一覧は森が現行コードから抜き出す。試験は一覧の各件が LINE では承認できず Web へ回ることを見る。実機では高リスク操作を使わない。

### 0-2. フラグと試験環境（決定 U-09）

| フラグ | 現行のグローバル既定（参考） | 実機での扱い |
|---|---|---|
| `COMM_ACCOUNTS_ENABLED` | OFF | **TOKYO307 の org だけ** ON。他 org では効かないこと |
| `LINE_CONVERSATION_ENABLED` | OFF（accounts も要る） | 同上 |

**前提（決定）: フラグは org 単位で絞れる。** グローバルに ON にして全テナントへ広げない。org 単位で絞れない実装のまま実機に入ったら、実機通しは中止する（LP-E2E-00）。

| 層 | 環境 | 本番 DB |
|---|---|---|
| 単体 | CI。ネットワーク無し | 触れない |
| 結合 | CI と **ローカル PostgreSQL 16**。LINE API はモック | 触れない |
| 実機通し | **本番** `https://staffpass.sealith.com`。フラグは TOKYO307（`92f3617c-33fc-4dac-b9b4-d4f42e8522ac`）だけ ON | **SELECT のみ**。実行するのは **木村**。エージェントは本番に書かない |

実機のあと、フラグを TOKYO307 からも外す（LP-E2E-07）。安藤は業務中の AI 社員なので、停止時間は最短にする（§10-1）。

### 0-3. 自動化の記号

| 記号 | 意味 |
|---|---|
| 単体 | ネットワーク無し。CI |
| 結合 | ローカル PostgreSQL 16 + LINE モック。CI。本番 LINE API には繋がない |
| 手動 | 人の操作。実機通し（§10）は本番 TOKYO307、八坂さんの端末 |

### 0-4. 決定の一覧（2026-10-21）

| ID | 決定 |
|---|---|
| U-01 | `lib/comm/*` を土台に活かし、設計 C の共通部品へ切り出す。置き換えない。合否は振る舞いで取る |
| U-03 | Push の 200 は「LINE が受け付けた」として記録し、**届いたとは記録しない**（設計 §5 を正とする。現行の受付=sent は直す） |
| U-04 | 月間上限とレート制限は 429 本文の `message` で分ける想定（公式文言の確認は森）。判別できない場合は両方「送れなかった」で fail-closed |
| U-05 | PoC に入れる。毎日の quota 読み取り、8 割での知らせ、上限時は承認をメールへ回す |
| U-06 | 承認と会話は同じ公式アカウント。Webhook は `/api/webhooks/line/c/<ref>`。中で振り分ける |
| U-09 | 別の試験環境は無い。単体・結合は CI とローカル PG16。実機は本番、フラグは TOKYO307 だけ。SELECT は木村 |
| U-14 | 実機テナントは TOKYO307。AI 社員は安藤。解除は 2 人（info@ 申請、tyasaka@ 承認） |
| U-19 | 停止中も承認カードは出す。停止中の社員の送信と起こしは止める。両方を合否にする |
| U-02 | unfollow はその LINE ユーザーの連携だけ外す。起こしと送信を止める。窓口アカウントは ACTIVE のまま。再 follow では戻らない（連携コードをやり直す） |
| U-07 | 高リスクは既存の Web 専用（金銭・秘密・ポリシー変更・停止解除）を流用。一覧は森がコードから抜き出す。LINE では承認できない。Web へ回す |
| U-08 | 森が L1 の本番で Grok Bot が会話の札を `comm.reply` に返せるかを 1 回確認する。計画では実機会話（LP-E2E-03）の前提にする |
| U-10 | LINE Developers の Webhook 再送は **ON**。実機で同じ `webhookEventId` の重複排除を見る |
| U-11 | 未連携（社外）への既定は **承認**。テナントが社員ごと・役割ごとに「承認なし」に緩められる。confidential / verbatim は社外に承認なしで出さない（設計 §7 決定 5 を正とする） |
| U-12 | `destination` 欠落は **400** `destination_missing`。不一致は **403** `destination_mismatch`。どちらも inbound / wake 0 |
| U-13 | 通数試験は **モックのみ**。実 OA で月間上限まで送らない |
| U-15 | 窓口アカウント登録画面の URL と成功／失敗文言は森が定数にする。木村がレビュー。試験は定数と一致すること（文言を推測しない） |
| U-16 | 会話用連携コード失敗時の LINE 文言も森が定数、木村がレビュー。試験は定数と一致 |
| U-17 | 社員削除で窓口アカウントを `disabled` にする単体・結合を入れる（現行 `lib/employees/retire.ts` の `disableCommAccount`） |
| U-18 | 森が env 名の一覧を出す。木村は本番に載っていることだけ確認する（値は見ない・書かない）。確認は LP-E2E-00 |
| U-20 | 上限時の承認メールは、**そのテナントの承認者メール**へ。他テナントの承認者には届かない |
| U-21 | 8 割知らせは **テナント管理者メール＋既存の運営知らせ**。文言は森が定数、木村がレビュー。試験は定数と一致 |
| U-22 | 実機の停止は **安藤（社員単位）だけ**。組織全体停止は単体・結合 |

---

## 1. Slack 経路から LINE に引き継ぐ保証

LINE でも同じ合否にする。根拠は Slack の現行コード。

| 保証 | Slack での振る舞い | 根拠 | LINE での同じ保証 |
|---|---|---|---|
| 署名不正は拒否 | 欠落・改ざん・別 secret・5 分より古い timestamp → 検証失敗。受信は 401 `unauthorized` | `lib/notify/slack.ts` 60–79 行（`verifySlackSignature`）。`lib/slack/mention-ingress.ts` 1814–1821 行。試験 `lib/slack/mention-ingress.test.ts` 139–150 行 | `x-line-signature` 欠落・改ざん・別チャネル secret → 401。署名の前に DB 書き込み・wake をしない（設計 §5） |
| 未知の窓口 | 承認用 `[ref]`: チャネルが無いと 200 `{ignored:true}`（`app/api/webhooks/slack/[ref]/route.ts` 76–77 行）。会話: 未バインドは wake しない | 同上 | 未知の ref は **404**（Slack 承認の 200 ignored には合わせない）。未連携ユーザーは起こしてよいが **社外**（設計 §3-1、§2-5）。社外への既定は承認（決定 U-11） |
| 重複イベント | `slack_mention_events` に `event_id` を 1 回だけ insert。二度目は wake しない。HTTP はどちらも 200 | `lib/slack/mention-ingress.ts` 332–347 行、1537–1539 行。試験 412–438 行 | 同じ `webhookEventId`（`isRedelivery=true` 含む）は二重処理しない。HTTP は 200 のまま（設計 §2-6、§5） |
| 停止中は起こさない・送らない | wake は `checkOperable({phase:"wake"})`。止まっている間の wake は後で届けない。送る直前は `preSendHoldCode`。承認の再実行は `approval_held` 409 | `lib/slack/mention-ingress.ts` 499–516 行。`lib/gateway/adapters/slack.ts` 298–300 行。`lib/gateway/invoke.ts` 1388–1420 行。`lib/approvals/execution-authority.ts` 16–21 行 | 同じ。加えて **承認カードは停止中も出す**（決定 U-19） |
| 送信結果 | `sendState`: `sent` / `not_sent` / `unknown`。空宛先は `accepted` にしない | `lib/gateway/adapters/slack.ts` 262–300 行。`lib/comm-reply-dedup/guard.ts` 98–114 行。H1: `lib/gateway/invoke.ts` 3193–3228 行。`lib/approvals/not-sent.ts` 14–79 行 | 同じ三分に加え、Push 200 は「LINE が受け付けた」であり「届いた」ではない（決定 U-03、設計 §5） |
| テナント分離 | 承認は `orgId` 付きで引く。他 org は null | `lib/data/approvals.ts` 593–616 行。`lib/data/p0-auth-idor.test.ts` 15–73 行。`app/api/webhooks/slack/[ref]/route.ts` 187 行 | ref → 窓口アカウント → org はサーバーの DB だけ。`destination` で org を決めない（設計 §5） |

---

## 2. 観点 1 — 署名不正（`x-line-signature`）

対象経路（決定 U-06）: **`POST /api/webhooks/line/c/<ref>` のみ**（承認も会話もここ）。

共通の期待: 拒否は **401**、本文 `{ ok: false, error: "unauthorized" }`。署名の前に inbound 行の追加、wake、承認解決をしない。

Slack 対比: 欠落・別 secret・古い timestamp は 401（§1）。LINE の署名に時刻は入らない（設計 §2-6）。古いイベントは観点 3。

### LP-SIG-01 — 署名ヘッダ欠落

| 項目 | 内容 |
|---|---|
| 前提 | ACTIVE な窓口アカウント。TOKYO307 限定フラグ相当が試験ダブルで ON。正しい JSON（`destination` = そのアカウントの bot userId、1対1 text、`webhookEventId` あり） |
| 手順 | `x-line-signature` 無しで `POST /api/webhooks/line/c/<正しい ref>` |
| 期待結果 | 401。起こさない。inbound 行が増えない |
| 合否判定 | HTTP 401 かつ JSON `error` が `unauthorized`。wake 監査が無い。`comm_inbound_events` に当該 `event_key` が無い |
| 自動化 | 単体 |

### LP-SIG-02 — 本文改ざん

| 項目 | 内容 |
|---|---|
| 前提 | LP-SIG-01 と同じ。正しい secret で署名したあと、本文の 1 文字だけ変える（署名は変えない） |
| 手順 | 改ざん本文 + 元の署名で POST |
| 期待結果 | 401。処理しない |
| 合否判定 | 同上。正しい本文を後から送ったときは 200 になり、そのときだけ 1 回起こす |
| 自動化 | 単体 |

### LP-SIG-03 — 別チャネルの secret で署名

| 項目 | 内容 |
|---|---|
| 前提 | アカウント A の ref と secret。別の 32 バイト secret で HMAC-SHA256 → base64 |
| 手順 | A の URL に、別 secret の署名を付けて POST |
| 期待結果 | 401。A の inbound / wake が無い |
| 合否判定 | HTTP 401。`comm_inbound_events` に行が無い。比較は定数時間（Slack の `timingSafeEqual` と同じ保証。`lib/notify/slack.ts` 77–79 行） |
| 自動化 | 単体 |

### LP-SIG-04 — 正しい署名は受け付ける（陽性対照）

| 項目 | 内容 |
|---|---|
| 前提 | LP-SIG-01 の正しい本文と、そのアカウントの channel secret |
| 手順 | 正しい `x-line-signature` で POST |
| 期待結果 | 200 `{ ok: true }`。1対1 text なら 1 回だけ起こす |
| 合否判定 | HTTP 200。ログに本文が無い（設計 §5、C8）。`comm_inbound_events` に `event_key` だけ 1 行（本文列は無い） |
| 自動化 | 単体 |

### LP-SIG-05 — 署名の前に JSON も DB も触らない（順序）

| 項目 | 内容 |
|---|---|
| 前提 | 未知の ref、または正しい ref で悪い署名 |
| 手順 | 不正リクエストを送り、問い合わせ順を試験（モック）で見る |
| 期待結果 | 設計 §5: 「ref で窓口アカウントを決める → 署名（違えば 401）→ JSON → イベント」。未知 ref は署名の前に 404。悪い署名は JSON パースも inbound も wake もしない |
| 合否判定 | 未知 ref: 404 `not_found`、secret 読みも inbound も 0 回。悪い署名: secret 読みのあと 401、inbound 0 回。Slack 会話も署名のあとだけ envelope を渡す（`lib/slack/mention-ingress.ts` 1814–1835 行） |
| 自動化 | 単体 |

### LP-SIG-06 — 同じ URL の承認イベントも署名不正なら拒否

| 項目 | 内容 |
|---|---|
| 前提 | 同じ `/c/<ref>`。本文は postback（承認ボタン相当） |
| 手順 | SIG-01〜03 を postback 本文で繰り返す |
| 期待結果 | 401。承認解決も fulfill も走らない |
| 合否判定 | HTTP 401。`approval_requests.status` が変わらない |
| 自動化 | 単体 |

---

## 3. 観点 2 — 未知の ref / 未連携ユーザー / 未知の destination

設計 §5: 未知の ref は 404。org はイベントの `destination` では決めない。未連携の 1対1 は社外（§3-1）。社外への既定は承認（**決定 U-11**）。`destination` 欠落は 400、不一致は 403（**決定 U-12**）。どちらも inbound / wake 0。

### LP-UNK-01 — 存在しない ref

| 項目 | 内容 |
|---|---|
| 前提 | どの窓口アカウントの webhook ref にも無い文字列 |
| 手順 | `POST /api/webhooks/line/c/<未知 ref>`（署名の有無は問わない） |
| 期待結果 | 404 `{ ok: false, error: "not_found" }`。本文を読まないのが望ましい |
| 合否判定 | HTTP 404。inbound / wake 0。シークレットをログに出さない |
| 自動化 | 単体 |

### LP-UNK-02 — 改ざん・パストラバーサル風の ref

| 項目 | 内容 |
|---|---|
| 前提 | なし |
| 手順 | `../etc`、短すぎる値、43 文字のランダムなど |
| 期待結果 | 404。他アカウントを引き当てない |
| 合否判定 | すべて 404 |
| 自動化 | 単体 |

### LP-UNK-03 — pending / disabled の窓口アカウント

| 項目 | 内容 |
|---|---|
| 前提 | 同じ org に pending または disabled の窓口アカウントがある |
| 手順 | その webhook ref へ正しい署名で POST |
| 期待結果 | ACTIVE 以外は 404 |
| 合否判定 | 404。wake 0。承認も解決しない |
| 自動化 | 単体 |

### LP-UNK-04 — 署名は通るが `destination` が別 bot（決定 U-12）

| 項目 | 内容 |
|---|---|
| 前提 | アカウント A（bot userId = Ua…）。本文の `destination` を Ub… にする。A の secret で署名 |
| 手順 | A の `/c/<ref>` へ POST |
| 期待結果 | **403** `{ ok: false, error: "destination_mismatch" }`。org を差し替えない。inbound / wake 0 |
| 合否判定 | HTTP 403、JSON `error` が `destination_mismatch`。`employee_comm_accounts` の org_id が変わらない。`comm_inbound_events` に行が無い。wake 0 |
| 自動化 | 単体 |

### LP-UNK-05 — 紐づけの無い LINE ユーザーからの 1対1

| 項目 | 内容 |
|---|---|
| 前提 | 正しい ref・署名・destination。送信者 userId は連携に無い。社員は停止していない。社外への既定は承認（**決定 U-11**） |
| 手順 | 1対1 text を送る。続けて承認なしの `comm.reply` を呼ぶ |
| 期待結果 | Webhook 200。起こす（404 にはしない）。WHO は社外。承認なしでは送らない |
| 合否判定 | inbound 1 行。wake 1 回。会話の札の相手はその userId。承認なし `comm.reply` は `sent: false`、LINE API を呼ばない。失敗理由は社外承認が要る旨（語彙は実装。例: `external_send_needs_approval`） |
| 自動化 | 単体（送信拒否）＋ 結合（wake） |

### LP-UNK-06 — 別 ref の URL に届いたイベントは拒否

| 項目 | 内容 |
|---|---|
| 前提 | アカウント A と B（別 ref）。決定 U-06 |
| 手順 | (a) A 向けに正しく署名した本文を `POST /api/webhooks/line/c/<B の ref>` へ送る。(b) B の secret で署名し直した A 向け `destination` の本文を B の URL へ送る |
| 期待結果 | A としても B としても処理しない。B の社員を起こさない。A の承認も動かない |
| 合否判定 | (a) B の secret と合わなければ 401。合っても `destination` が B の bot でなければ **403** `destination_mismatch`。A / B とも wake 0、承認 status 不変、inbound 0。(b) 403 `destination_mismatch`。inbound / wake 0 |
| 自動化 | 単体 |

### LP-UNK-07 — `destination` 欠落は 400（決定 U-12）

| 項目 | 内容 |
|---|---|
| 前提 | アカウント A。正しい署名。JSON に `destination` が無い、空、または null |
| 手順 | A の `/c/<ref>` へ POST |
| 期待結果 | **400** `{ ok: false, error: "destination_missing" }`。inbound / wake 0。org を差し替えない |
| 合否判定 | HTTP 400、JSON `error` が `destination_missing`。403 / 401 にしたら不合格（不一致と欠落を分ける）。`comm_inbound_events` に行が無い。wake 0 |
| 自動化 | 単体 |

---

## 4. 観点 2b — 同じ URL での承認 / 会話の振り分け（決定 U-06）

### LP-RTE-01 — 1対1 text は会話、postback は承認

| 項目 | 内容 |
|---|---|
| 前提 | 同じ `/c/<ref>`。連携済みユーザー。pending の承認カードがある |
| 手順 | (1) 1対1 text。(2) 同じ URL に承認 postback（`a:` / `r:` 相当） |
| 期待結果 | (1) 会話として起こす。承認を解決しない。(2) 承認を解決する。本文を AI に渡して起こさない |
| 合否判定 | (1) wake 1、`approval_requests.status` 不変。(2) wake 0、status が `approved` または `rejected`。連携コード `SP-XXXX-XXXX` は AI に渡さない（起こさない） |
| 自動化 | 単体 |

### LP-RTE-02 — 旧パス `/api/webhooks/line/<ref>` を PoC の入口にしない

| 項目 | 内容 |
|---|---|
| 前提 | PoC の OA の Webhook は `/c/<ref>` に向ける（決定 U-06） |
| 手順 | 同じ ref 文字列で `POST /api/webhooks/line/<ref>` に会話 text を送る（試験ダブル） |
| 期待結果 | 会話の共通受信として処理しない。起こさない |
| 合否判定 | 会話の inbound / wake が 0。旧承認経路が残っていても、PoC の会話イベントをそこで起こさないこと。実機では LINE Developers の URL が `/c/<ref>` であること |
| 自動化 | 単体＋手動（実機は URL 確認だけ） |

### LP-HRK-01 — LINE では高リスクを承認できない（決定 U-07）

| 項目 | 内容 |
|---|---|
| 前提 | 森が現行コードから抜き出した Web 専用一覧（金銭・秘密・ポリシー変更・停止解除）。代表は既存の `hold_release_web_only`（`lib/approvals/hold-release-web.ts`、`lib/data/approvals.ts`）。一覧に無い tool を推測で足さない |
| 手順 | 一覧の各件について、(1) LINE `/c/<ref>` へ承認 postback 相当を送る。(2) 同じチケットを Web の正規経路で承認する |
| 期待結果 | LINE では承認できない。status が `approved` にならない。fulfill しない。Web では既存どおり承認できる（停止解除は「解除を承認」。汎用「承認」ではない） |
| 合否判定 | LINE: HTTP は 200 でも解決しない、または拒否。`approval_requests.status` が `pending` のまま、または `hold_release_web_only` 相当。fulfill 0。Web: 既存の Web 専用試験と同じ合否。一覧の 1 件でも LINE で `approved` にしたら不合格 |
| 自動化 | 単体（LINE 拒否）＋ 結合（Web 経路。既存 hold-release 試験を流用してよい） |

### LP-HRK-02 — 高リスクは Web へ回す（決定 U-07）

| 項目 | 内容 |
|---|---|
| 前提 | LP-HRK-01 の一覧。承認が必要な高リスク操作を試験ダブルで起こせる |
| 手順 | 高リスク操作を起こす |
| 期待結果 | LINE に承認カードを出さない（または出してもボタンが通らない）。人を Web（`/app/approvals` または停止解除の画面）へ誘導する。実機では本操作を使わない |
| 合否判定 | LINE への高リスクカード送信が 0、またはカードがあっても postback が LP-HRK-01 で拒否。画面または通知が Web へ誘導する。誘導文言は森の定数があればそれに一致（U-15）。定数がまだなら「Web へ回ったこと」だけ見る |
| 自動化 | 結合 |

---

## 5. 観点 3 — 重複・再送（同じ `webhookEventId`、`isRedelivery=true`）

Slack 対比: `event_id` の unique insert。重複は wake 0、HTTP 200（§1）。

LINE: 署名に時刻が無い（設計 §6 H10）。止めは `webhookEventId` の一意（`comm_inbound_events` PK `(account_id, event_key)`）。

### LP-DED-01 — 同じ `webhookEventId` を二度送る

| 項目 | 内容 |
|---|---|
| 前提 | LP-SIG-04 が通る本文 |
| 手順 | 同じ本文・同じ署名を連続で 2 回 POST |
| 期待結果 | どちらも 200。起こしは 1 回だけ |
| 合否判定 | `comm_inbound_events` が当該 `(account_id, event_key)` で 1 行。wake 1 回 |
| 自動化 | 単体 |

### LP-DED-02 — `isRedelivery=true` の再送

| 項目 | 内容 |
|---|---|
| 前提 | 1 回目は `deliveryContext.isRedelivery=false` で処理済み |
| 手順 | 同じ `webhookEventId` で `isRedelivery=true` のイベントを POST（署名は新しい本文に対して取り直す） |
| 期待結果 | 200。二度目は処理しない（設計 §2-6） |
| 合否判定 | wake 合計 1。inbound 1 行 |
| 自動化 | 単体 |

### LP-DED-03 — `webhookEventId` が無いイベント

| 項目 | 内容 |
|---|---|
| 前提 | 正しい署名。イベントに `webhookEventId` が無い |
| 手順 | POST |
| 期待結果 | 200。処理しない（設計 §6 H7） |
| 合否判定 | inbound 0、wake 0。承認 postback も `webhookEventId` 無しなら解決しない |
| 自動化 | 単体 |

### LP-DED-04 — 古すぎるイベント（再送印なし）

| 項目 | 内容 |
|---|---|
| 前提 | `timestamp` が現在より 1 時間以上前。`isRedelivery` が false または無し |
| 手順 | POST |
| 期待結果 | 捨てる（設計 §2-6、§5） |
| 合否判定 | wake 0。再送印付きの古いイベントは処理してよい。閾値を変えるなら本試験の期待を更新する |
| 自動化 | 単体 |

### LP-DED-05 — inbound 台帳が書けないとき

| 項目 | 内容 |
|---|---|
| 前提 | inbound 記録が error を返す（試験用モック） |
| 手順 | 正しいイベントを POST |
| 期待結果 | 処理しない。Webhook は 503 を返し、LINE の再送に任せる |
| 合否判定 | HTTP 503。wake 0 |
| 自動化 | 単体 |

### LP-DED-06 — 承認 postback の二重押し / 再送

| 項目 | 内容 |
|---|---|
| 前提 | pending の承認カード。同じ `webhookEventId` の postback を 2 回。入口は `/c/<ref>` |
| 手順 | 承認ボタン相当の postback を 2 回送る |
| 期待結果 | 解決は 1 回。fulfill も 1 回。Slack 承認と同じく、主防御は `status !== pending` と条件付き更新（`app/api/webhooks/slack/[ref]/route.ts` 237–255 行） |
| 合否判定 | `approval_requests.status` が `approved`（または `rejected`）の 1 遷移。fulfill 監査 1 回。2 回目の LINE 返事は「対象は処理済みか見つかりません。」 |
| 自動化 | 単体 |

---

## 6. 観点 4 — 停止中の社員（社員単位・組織全体）

Slack 対比: wake は `checkOperable phase:"wake"`、送る直前は `preSendHoldCode`、止まっている間の発言は後で起こさない、承認チケットが hold に触れたら `approval_held`（§1）。

**決定 U-19:** 停止中も承認カードは出す。停止中の社員の送信と起こしは止める。両方不合格なら試験は落ちる。

### LP-HLD-01 — 社員単位の停止で会話 wake が通らない

| 項目 | 内容 |
|---|---|
| 前提 | 対象社員が `kind=stopped`（または leave / quarantined）。org は止まっていない |
| 手順 | 連携済みユーザーから 1対1 text |
| 期待結果 | Webhook 200。起こさない。イベントキーは消費する（後で解除しても同じイベントでは起こさない） |
| 合否判定 | wake 0。`audit_events.action` が `employee.hold.wake_suppressed`、`metadata.reason` が `employee_on_hold`（Slack と同じ action。`lib/slack/mention-ingress.ts` 506–514 行） |
| 自動化 | 単体 |

### LP-HLD-02 — 組織全体の停止で会話 wake が通らない

| 項目 | 内容 |
|---|---|
| 前提 | org の hold が開いている。社員単位の hold は無くてよい |
| 手順 | LP-HLD-01 と同じ |
| 期待結果 | 起こさない。`metadata.reason` が `org_on_hold` |
| 合否判定 | 同上。Slack の org hold と同じコード（`lib/safety/hold.ts` の `HoldDenyCode`） |
| 自動化 | 単体 |

### LP-HLD-03 — hold が読めないときは fail-closed

| 項目 | 内容 |
|---|---|
| 前提 | 停止確認が throw、または `hold_state_unavailable` |
| 手順 | 1対1 text |
| 期待結果 | 起こさない（Slack / 設計と同じ fail-stop。`lib/safety/hold.ts` 9–12 行） |
| 合否判定 | wake 0 |
| 自動化 | 単体 |

### LP-HLD-04 — 停止中に消費したイベントは解除後も再実行しない

| 項目 | 内容 |
|---|---|
| 前提 | LP-HLD-01 のあと同じ `webhookEventId` を、hold 解除後に `isRedelivery=true` で再送 |
| 手順 | 再送 POST |
| 期待結果 | 起きない（設計 §5） |
| 合否判定 | wake 0。inbound は既に 1 行のまま |
| 自動化 | 単体 |

### LP-HLD-05 — 札は有効でも、送る直前の社員停止で送らない

| 項目 | 内容 |
|---|---|
| 前提 | 停止前に発行した会話の札（未期限切れ）。その後に社員を停止 |
| 手順 | `comm.reply` |
| 期待結果 | LINE API を呼ばない。`sendState` は `not_sent`。理由 `employee_on_hold`（Slack 送信直前と同じ。`lib/gateway/adapters/slack.ts` 298–300 行） |
| 合否判定 | invoke 409、`sent: false`、`code` が `employee_on_hold`。監査は未送信。`accepted: true` が無い |
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
| 前提 | 承認済みだが hold 印があるチケット |
| 手順 | 同じ `approvalId` で `comm.reply` / 確定系を再 invoke |
| 期待結果 | 409 `approval_held`。送らない。メッセージ「この承認は緊急停止で保留・破棄されたため、実行できません。必要なら新しく承認を依頼してください。」（`lib/gateway/invoke.ts` 1388–1420 行） |
| 合否判定 | HTTP 409、`code` が `approval_held`、`sent` が無いまたは false。監査 `tool.invoke` の summary に「再実行を停止で保留されたチケットのため拒否」 |
| 自動化 | 単体 |

### LP-HLD-08 — 停止中は連携コードを消化しない

| 項目 | 内容 |
|---|---|
| 前提 | 社員または org が停止中。有効な連携コードを 1対1 で送る |
| 手順 | `SP-XXXX-XXXX` を公式アカウントへ送る |
| 期待結果 | 紐付かない。コードは未使用のまま残る |
| 合否判定 | voter binding が増えない。wake 0。LINE に成功文言「✅ Staffpass の社内メンバーとして確認しました。」が **出ない** |
| 自動化 | 単体 |

### LP-HLD-09 — 停止中でも承認カードは出る（決定 U-19）

| 項目 | 内容 |
|---|---|
| 前提 | 社員停止中。承認が必要な操作（社外送信など。高リスクは使わない） |
| 手順 | 承認が必要な操作を起こす |
| 期待結果 | Flex カード「🟡 承認依頼」が LINE に出る。一方で会話の起こしと `comm.reply` の送信は止まっている（LP-HLD-01 と LP-HLD-05 が同時に成り立つ） |
| 合否判定 | カード送信のモックまたは監査で、停止中に承認通知が **1 通以上** 出ている。同じ時間帯に会話 wake が 0、送信 API が 0。カードが無い、または起こし／送信が通ったら不合格 |
| 自動化 | 結合（カード送信のモック）＋ 手動（実機） |

### LP-HLD-10 — LINE で承認しても、停止中は実行しない

| 項目 | 内容 |
|---|---|
| 前提 | LP-HLD-09 のカード。社員または org が停止中 |
| 手順 | LINE で［承認］を押す |
| 期待結果 | 承認そのものは記録してよい（設計 H11）。実行（fulfill の会話送信、再 invoke）は止まる |
| 合否判定 | `approval_requests.status` が `approved` になり得る。fulfill の会話が相手に出ない。再 invoke は LP-HLD-07。画面 `/app/audit` に実行拒否（`approval_held`: 「緊急停止中の承認のため実行しませんでした」） |
| 自動化 | 結合＋手動 |

---

## 7. 観点 5 — unfollow（ブロック）後

**決定 U-02:** unfollow は **その LINE ユーザーの連携だけ** 外す。起こしと送信を止める。窓口アカウントは **ACTIVE のまま**。再 follow では連携は戻らない。もう一度連携コードをやり直す。

### LP-UNF-01 — unfollow でそのユーザーの連携を外す（決定 U-02）

| 項目 | 内容 |
|---|---|
| 前提 | 正しい署名。連携済み userId。`type=unfollow` |
| 手順 | unfollow イベントを `POST /api/webhooks/line/c/<ref>` |
| 期待結果 | 200。本文を保存しない。起こさない。その userId の voter binding が消える（または無効）。窓口アカウントの status は ACTIVE のまま |
| 合否判定 | HTTP 200。wake 0。inbound は `webhookEventId` があれば 1 行（キーのみ）。当該 provider `line` の binding が無い。`employee_comm_accounts.status` が `active` |
| 自動化 | 単体（受け） / 手動（実機でブロック） |

### LP-UNF-02 — ブロック後の Push 200 は「受け付けた」であり「届いた」ではない（決定 U-03）

| 項目 | 内容 |
|---|---|
| 前提 | 相手が公式アカウントをブロックしている想定。会話の札は残っている。モックの Push が HTTP 200 |
| 手順 | `comm.reply` で Push させる（replyToken 期限切れ） |
| 期待結果 | LINE が受け付けたことは記録してよい。**届いた / delivered / 相手に届いた、とは記録しない**。invoke が「届いた」と読める `accepted: true` だけを返したら不合格 |
| 合否判定 | 応答または監査に受付（LINE が 200 を返したこと）が分かる。同じ記録に「届いた」が無い。本文がログに無い。実機では端末に表示されないことを観察してよい（公式どおり届かない） |
| 自動化 | 単体（モック 200）＋ 手動（実機ブロック） |

### LP-UNF-03 — unfollow 後は起こさない・送らない（決定 U-02）

| 項目 | 内容 |
|---|---|
| 前提 | LP-UNF-01 のあと。同じ userId の会話の札が残っていてもよい。窓口アカウントは ACTIVE |
| 手順 | (a) 同じ userId から 1対1 text（試験ダブル。実機ではブロック中は送れないことが多い）。(b) 残っている札で `comm.reply` |
| 期待結果 | (a) 起こさない（社外としても起こして送らない。連携は外れている）。(b) LINE API を呼ばない。`sendState` は `not_sent` |
| 合否判定 | wake 0。`sent: false`。LINE API 0。アカウントは ACTIVE。実機はブロック中に送れないことの観察で足りる |
| 自動化 | 単体＋手動（実機ブロック） |

### LP-UNF-04 — 再 follow では連携が戻らない（決定 U-02）

| 項目 | 内容 |
|---|---|
| 前提 | LP-UNF-01 のあと。同じ userId が公式アカウントを再 follow |
| 手順 | (1) follow イベント。(2) 1対1 text。(3) 新しい連携コードを 1対1 で送る |
| 期待結果 | follow では起こさない。再 follow だけでは社内に戻らない（LP-UNK-05）。コードをやり直したあとだけ社内 |
| 合否判定 | (1) wake 0。(2) WHO は社外。承認なし `comm.reply` は送らない。(3) 成功文言「✅ Staffpass の社内メンバーとして確認しました。」のあとだけ社内。古い binding を自動復活させたら不合格 |
| 自動化 | 単体＋手動（実機でブロック解除→再追加） |

---

## 8. 観点 6 — 通数上限とレート制限（決定 U-04、U-05）

設計 C7: 毎日 quota を読む。8 割で知らせる。上限に当たったら承認の知らせはメールに回し、会話は「送れなかった」として AI に返す。Reply は通数に数えない。Push は数える（設計 §8）。

**U-04:** 月間上限とレート制限は 429 本文の `message` で分ける想定。公式の文言は森が確認する。試験は (1) 上限と読める message (2) レート制限と読める message (3) 判別不能、の 3 分岐。判別不能は両方「送れなかった」で fail-closed。

**U-05:** 毎日の読み取り、8 割知らせ、上限時の承認メールは PoC に入れる。

**U-13:** 通数試験は **モックのみ**。捨て OA でも実上限まで送らない。本番 TOKYO307 の OA で月間上限まで送らない。

**U-20:** 上限時の承認メールは、そのテナントの承認者メールへ。他テナントの承認者には届かない。

**U-21:** 8 割知らせはテナント管理者メール＋既存の運営知らせ。文言は森が定数、木村がレビュー。試験は定数と一致。

### LP-QTA-01 — 429 本文が月間上限 → 会話は送れなかった

| 項目 | 内容 |
|---|---|
| 前提 | 連携済み。モック Push が HTTP 429。本文 `message` は森が公式から採用した「月間上限」の文字列 |
| 手順 | `comm.reply` で Push させる |
| 期待結果 | `sendState` は `not_sent`。invoke は `accepted` にしない。`sent: false`。理由は上限側（レート制限用のコードと区別できる） |
| 合否判定 | HTTP 409、`sent: false`。監査は未送信。本文をログに出さない。上限用の code / reason がレート制限用と違う |
| 自動化 | 単体（モック） |

### LP-QTA-02 — 上限失敗を成功扱いにしない

| 項目 | 内容 |
|---|---|
| 前提 | LP-QTA-01 |
| 手順 | 応答の `result.accepted` / `sent` / 配送記録を見る |
| 期待結果 | `accepted: true` が無い。配送成功にならない（`lib/approvals/not-sent.ts` 64 行「相手には届いていません。送ったと伝えないでください。」） |
| 合否判定 | JSON に `sent: false`。dedup 台帳は `not_sent` なら failed（`lib/comm-reply-dedup/guard.ts` 103–104 行）。盲目再送しない |
| 自動化 | 単体 |

### LP-QTA-03 — 上限時、承認カードをそのテナントの承認者メールへ回す（決定 U-05、U-20）

| 項目 | 内容 |
|---|---|
| 前提 | 通数が上限。承認が必要な操作。org A の承認者メールが試験ダブルで分かる |
| 手順 | 承認が必要な操作を起こす。配送記録の To を見る |
| 期待結果 | 承認の知らせは **org A の承認者メール** へ回る。LINE へのカード送信を成功扱いにしない。チケット自体は残る |
| 合否判定 | メール送信の監査または配送記録が 1 件以上。To が org A の承認者。LINE Push が上限で `not_sent`、または LINE を呼ばない。`/app/approvals` に pending がある。`accepted: true` で LINE 成功と読めたら不合格 |
| 自動化 | 結合（LINE とメールをモック） |

### LP-QTA-04 — 8 割の知らせ（決定 U-05、U-21）

| 項目 | 内容 |
|---|---|
| 前提 | quota / consumption を読める試験ダブル。consumption が quota の 80% 以上。知らせの文言は森の定数（木村レビュー）。定数がまだなら「出たこと」と宛先種別だけ見る |
| 手順 | 日次の読み取り相当を 1 回走らせる（実通数は使わない） |
| 期待結果 | **テナント管理者メール** と **既存の運営知らせ** がそれぞれ 1 回以上出る。本文や秘密は残さない |
| 合否判定 | テナント管理者向けメール 1 件以上、運営知らせ 1 件以上。同じ閾値で連打しても、実装が決めた間隔で増えすぎないこと。文言は定数と一致（定数があれば）。チャネルを Slack だけにしたら不合格 |
| 自動化 | 結合 |

### LP-QTA-05 — Reply は数えず、Push に落ちた経路だけ数える

| 項目 | 内容 |
|---|---|
| 前提 | 設計 §8。Reply 成功なら通数に入れない |
| 手順 | (a) 新しい replyToken で Reply 成功。(b) Reply 400 のあと Push が受付 200 |
| 期待結果 | (a) 通数の消費対象にならない。(b) Push 1 回だけ消費対象 |
| 合否判定 | LINE API 呼び出しが (a) Reply のみ、(b) Reply のあと Push。日次の consumption モックを使う場合、(a) で増えない |
| 自動化 | 単体 |

### LP-QTA-06 — 429 本文がレート制限 → 送れなかった（上限とは別 reason）

| 項目 | 内容 |
|---|---|
| 前提 | モック 429。`message` は森が公式から採用した「レート制限」の文字列 |
| 手順 | `comm.reply` で Push させる |
| 期待結果 | `not_sent`。`accepted` なし。reason / code が LP-QTA-01 の上限用と **違う** |
| 合否判定 | HTTP 409、`sent: false`。上限用コードを付けたら不合格。自動で送り直さない |
| 自動化 | 単体 |

### LP-QTA-07 — 429 の本文が空または不明 → 両方「送れなかった」（fail-closed）

| 項目 | 内容 |
|---|---|
| 前提 | モック 429。`message` が無い、空、または上限ともレートとも読めない |
| 手順 | `comm.reply` で Push させる |
| 期待結果 | 送れなかった。`accepted` なし。成功にも「届いた」にもしない。判別不能をレート制限としてリトライしない |
| 合否判定 | HTTP 409 または同等の失敗、`sent: false`、`sendState` が `not_sent`。dedup は failed。同じ job の自動再送が無い |
| 自動化 | 単体 |

### LP-QTA-08 — 毎日の quota 読み取り（決定 U-05）

| 項目 | 内容 |
|---|---|
| 前提 | 日次ジョブ相当を試験ダブルで 1 回実行できる。LINE quota API はモック |
| 手順 | ジョブを 1 回走らせる |
| 期待結果 | quota と consumption を読む。本文は保存しない。件数または残量が記録される |
| 合否判定 | モックが quota / consumption の取得 1 回以上。保存されるのは ID・件数・残量など（本文・token は無い）。失敗したら fail-closed（通数を「余裕あり」とみなさない） |
| 自動化 | 結合 |

### LP-QTA-09 — 上限メールは他テナントに届かない（決定 U-20）

| 項目 | 内容 |
|---|---|
| 前提 | org A が通数上限。org B にも承認者がいる。メールはモック |
| 手順 | A で承認が必要な操作を起こす。B の承認者宛の配送を見る |
| 期待結果 | A の承認者にだけ届く。B の承認者の To に入らない |
| 合否判定 | A の承認者メール 1 件以上。B の承認者アドレスが To / Cc / Bcc に無い。B の audit に当該通知が無い |
| 自動化 | 結合 |

---

## 9. 観点 7 — Slack 以外の窓口で、届いていない送信を成功にしない

設計 §6 H1: Slack 以外で送っていないのに `accepted: true` を返していた。現行ゲートウェイは 409 `delivery_unsupported_surface`、`sent: false`（`lib/gateway/invoke.ts` 3193–3228 行、`lib/approvals/not-sent.ts` 67–79 行）。

会話フラグ ON かつ会話の札があるときは LINE 送信に入る。失敗は 409 `sent: false`。不明は 502、`sent: false`。

**決定 U-03:** Push 200 は LINE の受付であり、届いたことではない。

### LP-SND-01 — 会話フラグ OFF、または札が無い LINE 宛

| 項目 | 内容 |
|---|---|
| 前提 | 会話フラグ OFF、または body に会話の札が無い `surface: "line"` |
| 手順 | `comm.reply` / `comm.send` |
| 期待結果 | 何も送らない。`accepted: true` が無い。409 `delivery_unsupported_surface` またはフラグ OFF の未送信 |
| 合否判定 | `sent: false`。LINE API 0。監査 `comm.not_sent`。メッセージ例: 「LINEへの送信には、まだ対応していません。メッセージは送信していません。」（`lib/approvals/not-sent.ts` 73–76 行） |
| 自動化 | 単体 |

### LP-SND-02 — LINE API が 4xx で拒否（429 以外）

| 項目 | 内容 |
|---|---|
| 前提 | フラグ ON、有効な札、連携済み。モックが Push 403 |
| 手順 | `comm.reply` |
| 期待結果 | `not_sent`。409。`accepted` なし |
| 合否判定 | `sent: false`。監査は未送信 |
| 自動化 | 単体 |

### LP-SND-03 — 結果不明（5xx / ネットワーク）

| 項目 | 内容 |
|---|---|
| 前提 | モックが 503 または throw |
| 手順 | `comm.reply` |
| 期待結果 | `sendState: unknown`。自動で Push に落とさない。invoke 502、`sent: false`。同じ job の再実行は台帳で止める |
| 合否判定 | 監査の summary に「結果が不明」または再送は確認後のみ。AI 向けは届いたと読まない（`lib/comm-reply-dedup/guard.ts` 71–72 行） |
| 自動化 | 単体 |

### LP-SND-04 — AI の引数で宛先を変えない（H2 / H3）

| 項目 | 内容 |
|---|---|
| 前提 | 札の相手が Ua。args に別の `lineId` / `userId` / `channel` |
| 手順 | `comm.reply` |
| 期待結果 | 送らない |
| 合否判定 | LINE API 0。`sent: false`。理由は宛先不一致（語彙は実装） |
| 自動化 | 単体 |

### LP-SND-05 — ブロック中 Push 200 を「届いた」にしない（決定 U-03）

| 項目 | 内容 |
|---|---|
| 前提 | LP-UNF-02 と同じ。モック Push 200 |
| 手順 | `comm.reply` |
| 期待結果 | 「LINE が受け付けた」記録は可。「届いた」記録は不可。`conversationDelivery` や `sent: true` を相手到達と読ませない |
| 合否判定 | 応答 / 監査に delivered / 「届いた」が無い。受付の記録がある。`accepted: true` だけを成功到達と読んだら不合格 |
| 自動化 | 単体 |

### LP-SND-06 — LINE が受け付けたときだけ受付を記録する（陽性対照）

| 項目 | 内容 |
|---|---|
| 前提 | モック Reply または Push が 200。連携済み |
| 手順 | `comm.reply` |
| 期待結果 | 受付の記録がある。配送記録なしで invoke 末尾の成功には落ちない。到達（届いた）とは書かない |
| 合否判定 | 応答に受付が分かる（実装の語彙）。本文がログに無い。H1 バックストップの `conversation_not_sent` に落ちない |
| 自動化 | 単体 |

### LP-SND-07 — 配送記録なしで invoke 末尾に落ちない（H1 バックストップ）

| 項目 | 内容 |
|---|---|
| 前提 | 会話ツールなのにどの送信分岐にも入らない合成リクエスト |
| 手順 | invoke |
| 期待結果 | 409 `conversation_not_sent`、`sent: false`、「メッセージは送信していません。」（`lib/gateway/invoke.ts` 3914–3930 行） |
| 合否判定 | `accepted: true` が無い。監査 `comm.not_sent` |
| 自動化 | 単体 |

---

## 10. 観点 8 — テナント分離

設計 §5: 窓口は `(org_id, employee_id)`。ref → アカウント → org は DB だけ。外部アカウント ID は全テナントで一意。会話の札は org・社員を HMAC で束ねる。

Slack 対比: `getApprovalByTelegramRef(ref, orgId)`、他 org は null（`lib/data/p0-auth-idor.test.ts` 57–72 行）。Inbox 停止も org 不一致で拒否（`lib/safety/hold-inbox.ts` 42–43 行）。

### LP-TNT-01 — 他テナントの webhook ref

| 項目 | 内容 |
|---|---|
| 前提 | org A の refA。org B のイベントまたは secret |
| 手順 | refA へ B 向けの内容を POST。逆も行う |
| 期待結果 | 署名不一致 → 401。destination 不一致 → **403** `destination_mismatch`（決定 U-12）。B の社員を起こさない |
| 合否判定 | org B の inbound / audit が増えない。org A でも destination 不一致なら inbound 0、wake 0 |
| 自動化 | 単体＋結合（ローカル PG16） |

### LP-TNT-02 — 他テナントの会話の札

| 項目 | 内容 |
|---|---|
| 前提 | org A の社員で発行した札。org B の credential で `comm.reply` |
| 手順 | B として invoke |
| 期待結果 | 拒否 |
| 合否判定 | LINE API 0。B の送信監査が成功にならない |
| 自動化 | 単体 |

### LP-TNT-03 — 他テナントの承認 ID / telegramRef

| 項目 | 内容 |
|---|---|
| 前提 | org A の pending 承認。org B の窓口 `/c/<ref>` |
| 手順 | B の URL から A の telegramRef で postback |
| 期待結果 | 見つからない。返事「対象は処理済みか見つかりません。」 |
| 合否判定 | A の `approval_requests.status` が `pending` のまま。B に A の title が返らない |
| 自動化 | 単体 |

### LP-TNT-04 — 本文の destination / orgId でテナントを選ばない

| 項目 | 内容 |
|---|---|
| 前提 | 正しい A の署名。JSON に別 org の UUID を足す |
| 手順 | POST |
| 期待結果 | org / employee / account はアカウント行だけ |
| 合否判定 | 起こし先の orgId がアカウントの org |
| 自動化 | 単体 |

### LP-TNT-05 — 同じ公式アカウントを別テナントが登録できない

| 項目 | 内容 |
|---|---|
| 前提 | org A が bot Ux を登録済み。設計 §5 `unique (surface, external_account_id)` |
| 手順 | org B が同じ Ux を登録しようとする |
| 期待結果 | 失敗。A の行は残る |
| 合否判定 | unique 違反または API の拒否。A の secrets が B から読めない |
| 自動化 | 結合（ローカル PG16） |

### LP-TNT-06 — 連携は org で絞る

| 項目 | 内容 |
|---|---|
| 前提 | 同じ LINE userId を、A では連携済み、B では未連携 |
| 手順 | B の OA にその userId から 1対1 |
| 期待結果 | B では社外。A の binding を読まない |
| 合否判定 | B の送信は社外承認が要る。A の binding の org_id が A のまま |
| 自動化 | 単体＋結合 |

### LP-TNT-07 — 秘密の値がログ・監査・API 応答に出ない

| 項目 | 内容 |
|---|---|
| 前提 | 署名失敗、送信失敗、設定画面の読み取り |
| 手順 | 失敗系を起こし、ログと audit と API JSON を見る |
| 期待結果 | channel secret / access token / 会話の本文が出ない（設計 §5、C8） |
| 合否判定 | 応答 JSON と `audit_events.metadata` に secret 文字列が無い。画面は「入れるだけ、二度と表示しない」（設計 C5） |
| 自動化 | 単体 |

### LP-TNT-08 — 他テナントの承認 ref で緊急停止しない

| 項目 | 内容 |
|---|---|
| 前提 | org A の承認カード ref。org B の LINE 窓口 |
| 手順 | B の `/c/<ref>` で `s:<A の ref>` postback |
| 期待結果 | 「対象が見つかりません。」（`lib/safety/hold-inbox.ts` 42–43 行）。A の社員が止まらない |
| 合否判定 | A の `employee_holds` に新しい open 行が無い。B の org も誤って止まらない |
| 自動化 | 単体 |

### LP-RET-01 — 社員削除で窓口アカウントを disabled にする（決定 U-17）

| 項目 | 内容 |
|---|---|
| 前提 | 同じ org に社員 S（LINE 窓口 ACTIVE）と社員 T（別の LINE 窓口 ACTIVE）。参考実装: `lib/employees/retire.ts` の `stopEmployeeWakeAndNotices` → `disableCommAccount`。既存試験 `lib/employees/retire.test.ts` |
| 手順 | S を契約終了（`retireEmployee` または同等のダッシュボード操作） |
| 期待結果 | S の窓口だけ `disabled`。T は ACTIVE のまま。S の `/c/<ref>` は LP-UNK-03（404）。S を起こさない |
| 合否判定 | `employee_comm_accounts` で S の status が `disabled`、T が `active`。S の Webhook が 404。T の inbound / wake が増えない。他 org の窓口が変わらない |
| 自動化 | 単体＋結合（ローカル PG16。既存 retire 試験を流用してよい） |

### LP-UI-01 — 窓口アカウント画面の URL と文言が定数と一致（決定 U-15）

| 項目 | 内容 |
|---|---|
| 前提 | 森が URL と成功／失敗文言を定数にした。木村がレビューした。定数がまだなら本試験は実施しない（未決ではない。前提待ち） |
| 手順 | 登録の成功と失敗を、定数にある各ケースで 1 回ずつ |
| 期待結果 | 画面パスと文言が定数と一致する。秘密は再表示しない（設計 C5） |
| 合否判定 | 画面のパスと文言が定数ファイル（実装が決めた場所）と文字どおり同じ。推測した文言で合格にしない |
| 自動化 | 単体（定数の参照）＋手動（画面） |

### LP-LNK-01 — 連携コード失敗の LINE 文言が定数と一致（決定 U-16）

| 項目 | 内容 |
|---|---|
| 前提 | 森が失敗文言を定数にした。木村がレビューした。成功文言は「✅ Staffpass の社内メンバーとして確認しました。」。定数がまだなら本試験は実施しない（前提待ち） |
| 手順 | 期限切れ、使用済み、別社員のコード、グループ送信、形式不正を 1対1（グループはグループ）で送る |
| 期待結果 | 各失敗の LINE 返事が定数と一致。成功時だけ成功文言。コードは未使用のまま残る失敗では binding が増えない |
| 合否判定 | LINE 応答（モック）が定数と文字どおり同じ。平文コードがログに無い |
| 自動化 | 単体＋手動（実機は代表 1 件でよい） |

---

## 11. 観点 9 — 実機通し（八坂さんの端末。本番 TOKYO307）

決定 U-09 / U-14。**別の staging は使わない。** フラグは TOKYO307 の org だけ ON。本番 DB の確認は **木村の SELECT のみ**。停止・解除・フラグ操作は八坂さん（または指定の人間）。エージェントは本番に書かない。

| 項目 | 値 |
|---|---|
| 本番 URL | `https://staffpass.sealith.com` |
| org | TOKYO307 `92f3617c-33fc-4dac-b9b4-d4f42e8522ac` |
| AI 社員 | **安藤**（業務で動いている。停止は最短。UUID は試験前に木村の SELECT で確定。推測しない） |
| 解除 | **info@ が申請、tyasaka@ が承認**（一人例外を使わない） |
| Webhook | 安藤の公式アカウント → `/api/webhooks/line/c/<ref>` |
| 画面文言 | 社員パネル見出し「緊急停止」、ボタン「緊急停止」、停止後「緊急停止中」。解除「解除を申請」「解除を承認」（`components/holds/HoldPanel.tsx`。既存 QA `docs/qa/org-hold-retest-tokyo307-20261016.md`） |

**決定 U-22:** 実機の停止は **安藤（社員単位）だけ**。組織全体は単体・結合（LP-HLD-02 / 06）で取る。実機で org 全体は止めない。

**決定 U-08:** 森が L1 の本番で、Grok Bot が会話の札を `comm.reply` に返せるかを 1 回確認する。これが通ってから LP-E2E-03 に入る。返ってこなければ実機の会話を中止する。

画面 URL と失敗文言は森の定数・木村レビュー（U-15 / U-16）。試験は定数と一致。高リスクは LP-HRK-01/02。実機では使わない（U-07）。Webhook 再送は ON（U-10）。

各段階のあと、次へ進む前に合否を取る。不合格なら止めて、安藤が止まっていれば先に解除する。

### 11-1. 安藤を止める時間を短くする

安藤は業務中の AI 社員。停止ウィンドウに入る前に、次を全部揃える。

1. LP-E2E-00（他 org フラグと必須 env の有無）が合格している。
2. info@ と tyasaka@ がすぐ再ログインできる（解除は 5 分以内のログイン。`HOLD_RELEASE_FRESH_LOGIN_MAX_AGE_MS`。既存 hold 文書 §2）。
3. 八坂さんの LINE が開いている。送る一文と、承認を出す操作の手順が決まっている。
4. 木村が SELECT をすぐ叩ける。
5. 戻し担当（八坂さん）が `docs/qa/org-hold-retest-tokyo307-20261016.md` §6 を開いている。
6. LP-E2E-08（再送の重複排除）を停止ウィンドウの前に済ませる。
7. 森の U-08（L1 本番の札）が通っている。

止まっているあいだにやること（この順、間を空けない）:

1. 停止ボタンを押す（社員単位。org 全体は押さない）。
2. LINE に一文 → 返信が来ないことを見る。
3. 承認カードが **出ること** を見る（U-19）。出たらすぐ次へ。
4. info@ が「解除を申請」→ tyasaka@ が「解除を承認」。
5. 解除後に LINE へ一文 → 返信が戻ることを見る。

停止が 10 分を超えそうなら、残りの観察を切って解除を優先する。

### 11-2. 解除が詰まったときの戻し（人間だけ。エージェントは書かない）

症状と先に試すこと（既存 hold 文書と同じ）:

| 症状 | 先に試すこと |
|---|---|
| `fresh_login_required` | ログアウト→ログインして 5 分以内に再押下 |
| `self_approval_denied` | 申請者本人。tyasaka@ で「解除を承認」 |
| `hold_release_web_only` | 汎用「承認」ではなく「解除を承認」 |
| `ops_hold_ops_only` / 画面に「運営が止めた停止です」 | テナント解除は使えない。`docs/qa/org-hold-retest-tokyo307-20261016.md` §6。実行は八坂さん。エージェントは UPDATE しない |
| パネルが消えた（フラグ OFF） | 実機を中止。安藤が hold のままなら人間が戻してからフラグを戻す |

やってはいけない: もう一度停止して上書きする、エージェントや AI による解除、org 全体を止める、安藤を止めたまま帰る。

### LP-E2E-00 — 前提: 他 org ではフラグが効いていない／必須 env が載っている

| 項目 | 内容 |
|---|---|
| 前提 | フラグが org 単位で絞れる実装が本番に載っている。TOKYO307 だけ ON にした直後。木村が SELECT できる。森が env 名の一覧を出している（決定 U-18。値は文書に書かない） |
| 手順 | (1) 木村: フラグ / allowlist が TOKYO307 の org_id だけを指すことを SELECT または設定画面で確認する。(2) TOKYO307 以外の既知テナントで、会話用 `/c/<ref>` が無い、または 404。(3) 他 org の Slack 会話と、既存の承認 LINE（別 OA）が従来どおり動く。(4) 木村: 森の一覧の env が本番に **載っていることだけ** 確認する（値は見ない・メモしない・チャットに貼らない） |
| 期待結果 | 他 org で LINE 会話の起こし・送信経路が開かない。グローバル ON になっていたら **実機中止**。必須 env が欠けていたら **実機中止**（503 で落ちる） |
| 合否判定 | 木村の確認メモ: TOKYO307 以外に会話フラグが付いていない。他 org の会話 Webhook が 404 または存在しない。他 org の Slack が止まっていない。env は「ある／無い」だけ（値なし）。出発点（現行コード。森が一覧を確定する）: `NOTIFICATION_CONFIG_ENCRYPTION_KEY`、`COMM_CONVERSATION_TOKEN_SECRET`、`VOTER_BINDING_SECRET` |
| 自動化 | 手動（本番。SELECT は木村。env の有無も木村） |

### LP-E2E-01 — 友だち追加

| 項目 | 内容 |
|---|---|
| 前提 | LP-E2E-00 合格。安藤の OA の Webhook が `https://staffpass.sealith.com/api/webhooks/line/c/<ref>`。LINE Developers の Webhook 再送が **ON**（決定 U-10）。OFF なら実機の重複試験（LP-E2E-08）を中止する |
| 手順 | 八坂さんの LINE で安藤の OA を友だち追加する。コンソールで再送 ON を確認する |
| 期待結果 | トークが開ける。follow では起こさない。再送が ON |
| 合否判定 | 端末: トークが開ける。木村 SELECT: follow の `webhookEventId` があっても wake 監査が無い。本文列が無い。再送 ON のスクショまたは設定メモ |
| 自動化 | 手動 |

### LP-E2E-02 — 紐づけ（連携コード）

| 項目 | 内容 |
|---|---|
| 前提 | 八坂さんが TOKYO307 にログイン中。自分用の連携コードを発行できる。安藤は止まっていない。失敗文言は森の定数（U-16。定数があれば LP-LNK-01 も見る。実機の本段階は成功だけ必須） |
| 手順 | ダッシュボードでコード発行 → **1対1** でコードだけ送る |
| 期待結果 | 「✅ Staffpass の社内メンバーとして確認しました。」（会話連携の成功文言）。同じ OA が承認も兼ねる |
| 合否判定 | LINE に成功文言。木村 SELECT: voter binding が TOKYO307、provider `line`。監査に平文コードが無い。グループで送った場合は受けない（承認経路の既知文言「連携コードは、公式アカウントとの 1:1 トークで送ってください（グループでは受け付けません）。」） |
| 自動化 | 手動 |

### LP-E2E-03 — 1対1 の会話

| 項目 | 内容 |
|---|---|
| 前提 | LP-E2E-02 合格。森の L1 本番確認（決定 U-08）が通っている。社内（連携済み）なので承認なし返信でよい。社外の既定は承認（決定 U-11）だが、本段階は社内だけ。U-08 が通っていなければ **ここで中止** |
| 手順 | 八坂さんが 1対1 で短い用事を送る（業務に影響しない内容） |
| 期待結果 | 返信が来る。本文が Staffpass に残らない（設計 C8、§7 決定 6） |
| 合否判定 | 端末に返信。木村 SELECT: inbound はキーのみ。`audit_events` に本文が無い。同じ文の連打で二重に送らない。応答を「届いた」とだけ書かず、端末で見えたことを人手で記録する（U-03） |
| 自動化 | 手動 |

### LP-E2E-04 — LINE での承認

| 項目 | 内容 |
|---|---|
| 前提 | 社外送信など、承認必須で **高リスクではない** 操作（決定 U-07。金銭・秘密・ポリシー変更・停止解除は使わない。それらは LP-HRK-01/02） |
| 手順 | 承認カードが LINE に届く →［承認］を押す |
| 期待結果 | Flex「🟡 承認依頼」。押したあと「承認しました。」。その後、対象の返信が端末に見える |
| 合否判定 | 端末: カードと「承認しました。」と返信。木村 SELECT: `approval_requests.status=approved`。fulfill が `slack_channel_required` や `delivery_unsupported_surface` で終わらない。同じボタンの再送は「対象は処理済みか見つかりません。」 |
| 自動化 | 手動 |

### LP-E2E-05 — 停止（安藤・最短）

| 項目 | 内容 |
|---|---|
| 前提 | §11-1 の事前が揃っている。**社員単位**。org 全体は押さない |
| 手順 | 安藤のダッシュボードで「緊急停止」。八坂さんが LINE でもう一文送る。承認が残っていればカードの有無だけ見る |
| 期待結果 | 新しい会話の返信は来ない（起こし・送信が止まる）。承認カードは出る（U-19）。実行はされない |
| 合否判定 | 画面「緊急停止中」。木村 SELECT: `employee_holds` が open、`employee_id` = 安藤、`kind=stopped`、`employee_id` が null（org 全体）ではない。wake 監査 `employee.hold.wake_suppressed`。端末に新しい AI 返信が無い。カードが出ていれば U-19 合格。10 分以内に LP-E2E-06 へ進む |
| 自動化 | 手動 |

### LP-E2E-06 — 解除（info@ 申請、tyasaka@ 承認）

| 項目 | 内容 |
|---|---|
| 前提 | LP-E2E-05。info@ が申請者、tyasaka@ が承認者。どちらも操作直前に再ログイン（5 分窓） |
| 手順 | info@ が `/app` で「解除を申請」。tyasaka@ が `/app/approvals` で「解除を承認」。詰まったら §11-2。成功したら八坂さんが LINE で一文 |
| 期待結果 | 停止が閉じる。新しい発言にはまた返信する。停止中の古いイベントは再実行されない（LP-HLD-04） |
| 合否判定 | 「緊急停止中」が消える。木村 SELECT: 当該 hold の `released_at` が not null、`released_by` が `member:<tyasaka@ の member id>`。LINE に新しい返信。停止中の文の再送では起きない |
| 自動化 | 手動 |

### LP-E2E-07 — 実機のあとフラグを戻す

| 項目 | 内容 |
|---|---|
| 前提 | LP-E2E-01〜06 のあと（合格でも中止でも）。安藤が hold のままなら先に LP-E2E-06 / §11-2 |
| 手順 | 1. 安藤が止まっていないことを画面と SELECT で確認する。2. TOKYO307 限定の会話フラグ / accounts フラグを外す（グローバル ON にはしない）。3. 木村が他 org と TOKYO307 の両方を確認する |
| 期待結果 | TOKYO307 でも会話フラグが OFF。他 org はもともと OFF のまま。安藤は業務に戻っている |
| 合否判定 | 木村 SELECT / 設定: TOKYO307 に会話フラグが残っていない。`POST /api/webhooks/line/c/<安藤の ref>` がフラグ OFF なら 404。安藤の `employee_holds` に open が無い。他 org の Slack が生きている |
| 自動化 | 手動 |

### LP-E2E-08 — 実機で同じ `webhookEventId` を二重処理しない（決定 U-10）

| 項目 | 内容 |
|---|---|
| 前提 | LP-E2E-01〜03 合格。Webhook 再送が ON。停止の前にやる（安藤は止まっていない） |
| 手順 | 八坂さんが短い一文を送る。LINE Developers の再送、または同じイベントの再送相当を 1 回起こす（コンソールの再送／検証）。無理なら、同じ文の連打ではなく **同じ webhookEventId** の再送だけを見る。再送を起こせなければ本試験は観察不能として記録し、単体 LP-DED-01/02 で代替する |
| 期待結果 | 端末の返信は 1 通。起こしは 1 回 |
| 合否判定 | 木村 SELECT: 当該 `webhookEventId` の inbound が 1 行。wake 1 回。端末に同じ返事が二重に無い |
| 自動化 | 手動 |

---

## 12. 試験件数（観点ごと）

前回 64 件 → **今回 73 件**（+9）。追加: UNK-07、HRK-01/02、UNF-04、QTA-09、RET-01、UI-01、LNK-01、E2E-08。UNK-04、UNF-01/03、QTA-03/04、E2E-00/01/03/04 は件数を増やさず中身を具体化した。

| 観点 | ID | 件数 | 単体 | 結合 | 手動 | 保留 |
|---|---|---|---|---|---|---|
| 1 署名不正 | LP-SIG-01〜06 | 6 | 6 | 0 | 0 | なし |
| 2 未知の ref / 未連携 / destination | LP-UNK-01〜07 | 7 | 7 | 1 | 0 | なし（U-12 決定済み） |
| 2b 振り分け | LP-RTE-01〜02 | 2 | 2 | 0 | 1（RTE-02 の URL 確認） | なし |
| 2c 高リスクは Web | LP-HRK-01〜02 | 2 | 1 | 2 | 0 | なし（一覧は森がコードから抜く。試験の前提） |
| 3 重複・再送 | LP-DED-01〜06 | 6 | 6 | 0 | 0 | なし |
| 4 停止 | LP-HLD-01〜10 | 10 | 8 | 2 | 2 | なし（U-19 / U-22 決定済み） |
| 5 unfollow | LP-UNF-01〜04 | 4 | 3 | 0 | 3 | なし（U-02 決定済み） |
| 6 通数・レート | LP-QTA-01〜09 | 9 | 5 | 4 | 0 | なし（文言定数は前提待ち。U-13 はモックのみ） |
| 7 送信結果 | LP-SND-01〜07 | 7 | 7 | 0 | 0 | なし |
| 8 テナント分離 | LP-TNT-01〜08 | 8 | 6 | 2 | 0 | なし |
| 8b 削除・画面定数 | LP-RET-01、LP-UI-01、LP-LNK-01 | 3 | 3 | 1 | 2 | なし（UI/LNK の定数は前提待ち） |
| 9 実機通し | LP-E2E-00〜08 | 9 | 0 | 0 | 9 | なし（U-08 は L1 の前提確認） |
| **合計** | | **73** | **54** | **12** | **17** | （手動の一部は単体と重複。HLD-09/10 は結合＋手動） |

森の PR に最低限載せる単体: SIG-01〜06、UNK-01〜07、RTE-01、HRK-01、DED-01〜06、HLD-01〜08、UNF-01/03/04、QTA-01/02/05/06/07、SND-01〜07、TNT-02/04、RET-01。結合: QTA-03/04/08/09、HLD-09、HRK-01/02、TNT-01/05、RET-01。既存試験が既に覆う振る舞いは、切り出し後も同じ合否なら作り直さない（retire の comm disable、hold-release の web-only など）。

---

## 13. 決定済み

未決は残していない。推測で文言・tool 名・env 値を埋めない。森／木村の作業は試験の前提（§13-2）であり、プロダクトの未決ではない。

### 13-1. 決定の所在

§0-4 の表が正本。初回 8 件（U-01 / U-03 / U-04 / U-05 / U-06 / U-09 / U-14 / U-19）と、今回 13 件＋ U-11（§7 決定 5 を正とする）をすべて試験に落とした。

### 13-2. 森／木村の作業（試験の前提。未決ではない）

| 作業 | 担当 | 待つ試験 | 注意 |
|---|---|---|---|
| 429 本文の公式 `message`（月間上限 / レート制限） | 森 | LP-QTA-01 / 06 | 判別不能は U-04 どおり fail-closed |
| 高リスク（金銭・秘密・ポリシー変更・停止解除）の tool / risk 一覧を現行コードから抜き出す | 森 | LP-HRK-01 / 02 | 一覧に無い名前を試験側で足さない。既存の `hold_release_web_only` を代表にしてよい |
| Grok Bot が会話の札を `comm.reply` に返せるかを L1 本番で 1 回確認 | 森 | LP-E2E-03 の前提 | 通らなければ実機会話を中止 |
| 窓口画面の URL と成功／失敗文言を定数化 | 森が書く、木村がレビュー | LP-UI-01 | 試験は定数と一致。推測しない |
| 連携コード失敗の LINE 文言を定数化 | 森が書く、木村がレビュー | LP-LNK-01 | 成功文言は既定。「✅ Staffpass の社内メンバーとして確認しました。」 |
| 8 割知らせの文言を定数化 | 森が書く、木村がレビュー | LP-QTA-04 | チャネルはテナント管理者メール＋既存の運営知らせ（U-21） |
| 本番に載せる env 名の一覧 | 森が一覧、木村が有無だけ確認 | LP-E2E-00 | 値は見ない・書かない。出発点: `NOTIFICATION_CONFIG_ENCRYPTION_KEY`、`COMM_CONVERSATION_TOKEN_SECRET`、`VOTER_BINDING_SECRET` |

---

## 14. 八坂さんに事前に用意してもらう物

1. **八坂さん本人の LINE**が入った端末（友だち追加・ブロック・承認ボタン）。
2. TOKYO307 のログイン（紐づけするメンバー）。本番 URL `https://staffpass.sealith.com`。
3. **info@**（解除申請）と **tyasaka@**（解除承認）が、停止ウィンドウ中に 5 分以内で再ログインできること。
4. 安藤の公式アカウント（Messaging API）。Webhook を `/api/webhooks/line/c/<ref>` に向ける権限。**再送は ON**（決定 U-10）。
5. ダッシュボードで **自分用の連携コード**を発行できること（画面パスは森の定数 U-15。木村レビュー後に試験）。
6. フラグを **TOKYO307 だけ** ON/OFF できる人（八坂さんまたは運用。グローバル ON にしない）。
7. **木村**が本番 DB の SELECT だけできること（inbound / hold / approval / audit / フラグ）。接続情報をチャットに貼らない。env の有無確認も木村（U-18。値は見ない）。
8. 社外ケース用に、紐づけしていない別の LINE アカウント（可能なら。無い場合は結合で代える）。
9. 通数の実上限試験はしない（決定 U-13）。本番 OA の月間通数を使い切らない。
10. 戻し手順 `docs/qa/org-hold-retest-tokyo307-20261016.md` §6 を、停止の前に開いておく。
11. 森の L1 本番確認（U-08）が通っていること。通る前に LP-E2E-03 に入らない。

安藤の UUID は文書に書かない。試験直前に木村が次を SELECT する（値は内部メモ。PR に貼らない）:

```sql
-- 木村。SELECT のみ。本番。
select id, display_name, role_label, status
from public.employees
where org_id = '92f3617c-33fc-4dac-b9b4-d4f42e8522ac'
  and (
    display_name ilike '%安藤%'
    or role_label ilike '%安藤%'
  );
```

複数行出たら、実機対象をその場で一人に確定してから止める。推測で ID を埋めない。

---

## 15. 実施時の安全規則

- 単体・結合は本番に繋がない。LINE API はモック。DB はローカル PostgreSQL 16。
- 実機は本番 TOKYO307 のみ。フラグは org 単位。他 org に広げない。終わったら LP-E2E-07 で戻す。
- 本番 DB の確認は **木村の SELECT のみ**。INSERT / UPDATE / DELETE / RPC / フラグ変更をエージェントがやらない。
- 停止・解除・フラグ操作は人間（八坂さん / info@ / tyasaka@）。
- 安藤の停止は最短。詰まったら §11-2。止めたまま帰らない。
- org 全体は実機で止めない（決定 U-22）。組織全体停止は単体・結合。
- ログと PR にチャネルシークレット、アクセストークン、連携コード、LINE 本文、個人の userId、安藤の UUID を貼らない。

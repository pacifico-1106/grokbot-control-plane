# MCP Events で「承認の結果」を AI に届ける — 設計とプロトタイプ（2026-10-05）

- 依頼: 木村（八坂 GO 2026-10-05）
- 対象: Staffpass（AIエージェントの社員証）の社員用 MCP `/api/mcp`
- 状態: **プロトタイプ（フラグ `MCP_EVENTS_ENABLED`、既定 OFF）**。本番の設定・DB は変えていない
- 改訂: 2026-10-05 木村レビュー反映（§5・§8・§9・§12・§14・§16）。再送 cron の認証は PR #264 の共通ヘルパーを使うため、**この PR は #264 に依存**する（§16）
- 仕様の出典: 調査メモ `/workspace/docs/mcp-events-2026-10/application.md`（box 内）／OpenAI「MCP Events」
  （https://developers.openai.com/plugins/build/mcp-events）／MCP「Triggers & Events」拡張の下書き
  （MCP 2026-07-28 上の拡張。OpenAI DevDay 2026-09-29 で ChatGPT が対応を発表した版）／Standard Webhooks

> この文書の言い回しは特定のエージェント製品に依存しない。「AI」は社員証（`gb_emp_`）を持つ AI 社員のこと。
> 受け手（ChatGPT など MCP Events に対応したクライアント）を「受け手」と呼ぶ。

---

## 0. 要約

| 項目 | 決めたこと |
|---|---|
| 送るイベント | `approval.decided`（承認・却下・差し戻し）／`approval.expired`（判断されずに閉じた） |
| 送り方 | MCP Events の Webhook 方式。1 リクエスト 1 イベント、256KiB まで、Standard Webhooks の HMAC 署名 |
| 中身 | **ID と状態だけ**（承認の題名・本文・差し戻しメモ・承認者・statusToken・秘密は入れない）。詳細は AI が自分の社員証で `staffpass_get_approval_status` を呼んで読む |
| 出す場所 | 判断の共通処理 `runApprovalResolveSideEffects`（Web／Slack／LINE／Telegram／代理承認がすべてここを通る）と、期限切れの共通処理 `auditApprovalClosed`、判断期限の自動却下 `decision-workflow/expiry.ts` の 3 か所だけ。**チャネル別の実装はゼロ** |
| 期限 | `refreshBefore` は**必ず有限**。通常 既定 1 時間・最大 24 時間、危険な設定は 既定 15 分・最大 1 時間、最短 5 分 |
| 権限の取り消し | **配信のたびに**社員証を確認し直す。取り消し・再発行・停止が**確実に分かったときだけ**、その AI 社員の購読を全部止め（以後の更新は `-32012`）、未送信分を捨てる。DB の読み取りエラーなどで確認できないときは止めずに延期する（§8）。ChatGPT は `terminated` 非対応なので、止めるのはサーバーの責任 |
| 監査 | 購読・更新・停止・配信・配信断念・取り消し・「配信のあと AI が最初にしたこと」（`mcp_events.triggered_action`）を audit_events に残す |
| 既存との関係 | 会話の起こす webhook・W1・W2・自動 fulfil は**そのまま**。承認結果の callback（`callbackUrl`）とメールは**共存**（同じ `eventId` を載せて重複を判定できる）。置き換えは段階的に（§10） |
| 2026-07-28 対応 | **#268（D1）は main にマージ済み、このブランチにも取り込み済み**（§16.3）。社員用 `/api/mcp` は 2026-07-28 の `_meta` の要求と `server/discover` に応答し、フラグ ON なら `server/discover` と `initialize` の両方の `capabilities` に `events: {}` が出る。§13.1 は取り込み前の main の記録 |

---

## 1. 仕様のポイント（実装が依存するところだけ）

1. **版**: MCP `2026-07-28`。ChatGPT は `server/discover` の `capabilities` に `"events": {}` があるサーバーだけで Events を使う。
2. **メソッド**（tools と同じ認証付きエンドポイント）
   - `events/list` → `{ events: [{ name, description, delivery: ["webhook"], inputSchema, payloadSchema }] }`
   - `events/subscribe` `{ name, arguments, delivery: { mode: "webhook", url, secret: "whsec_…" }, cursor, ttlMs }`
     → `{ id, refreshBefore, cursor, truncated }`（更新時は `deliveryStatus` も可）
   - `events/unsubscribe` `{ name, arguments, delivery: { url } }` → `{}`（ChatGPT は冪等を期待）
3. **購読 ID** は（認証済みの主体, 宛先 URL, イベント名, 正規化した arguments）から決まる固定値。同じ組み合わせの再送は「更新」。
4. **宛先確認**: 配信を始める前に、署名付きの `{"type":"verification","challenge":"…"}` を送り、2xx の本文で `{"challenge":"…"}` が返ること（定数時間比較）を確認する。失敗は `-32015`、`data.reason` は `connection_refused | timeout | tls_error | http_4xx | http_5xx | challenge_failed` のどれか。
5. **配信**: 本文 `{ eventId, name, timestamp, data, cursor }`、ヘッダー `webhook-id`（= eventId）・`webhook-timestamp`（Unix 秒）・`webhook-signature`（`v1,` + base64(HMAC-SHA256(鍵, id.ts.body))、鍵の切り替え中は空白区切りで複数）・`X-MCP-Subscription-Id`。再送のたびに時刻と署名を作り直す。`410`・`413` は再送しない。順番の保証なし・重複あり（受け手が eventId で重複を捨てる）。
6. **SSRF**: 配信のたびに名前解決し、グローバルでないアドレスを拒否し、確認した IP にそのまま接続（SNI／Host は元のホスト名）。リダイレクトに従わない。
7. **ChatGPT の制限**: Webhook と宛先確認のみ。poll／stream／`gap`／`terminated` は非対応。`cursor: null`（再生なし）。
8. **安全面**: 本文に AI への指示を書かない。イベントを受けたこと＝実行してよいこと、ではない。購読中も権限を確認し直し、取り消されたら止める。

---

## 2. 全体の流れ

```
 人が判断（Web / Slack / LINE / Telegram / 代理承認）
        │  どの入口も同じ関数に来る
        ▼
 resolveApproval → 自動 fulfil（サーバー側送信）→ runApprovalResolveSideEffects
        │                                         ├─ 既存: メール / callbackUrl / 通知の更新 / …
        │                                         └─ 新規: emitApprovalEvent("approval.decided")  ← ここだけ
 期限切れ（TTL・fulfil 時の期限切れ）→ auditApprovalClosed → emitApprovalEvent("approval.expired")
 判断期限の自動却下（T2）           → emitApprovalEvent("approval.expired", reason=deadline_exceeded)
        │
        ▼
 同じ org × 同じ AI 社員 × 同じイベント の、有効・確認済み・期限内の購読だけを選ぶ（arguments で絞る）
        │  mcp_event_deliveries に (購読, eventId) で 1 行（重複は入らない）
        ▼
 1 回目はその場で（バックグラウンド）送信 → 失敗なら cron が 30 秒 → 2 分 → 8 分で再送（最大 4 回・15 分）
        │  送る直前に毎回: 購読の状態 / 期限 / 社員証 / 承認がまだ同じ社員のものか を確認
        ▼
 受け手（ChatGPT など）が AI を起こす → AI は社員証で staffpass_get_approval_status / staffpass_invoke
        │
        ▼
 tools/call のとき「直前の配信」と結び付けて mcp_events.triggered_action を記録
```

---

## 3. イベントの定義

### approval.decided

| フィールド | 型 | 説明 |
|---|---|---|
| `approvalId` | string | 承認 ID |
| `employeeId` | string | AI 社員 ID（購読した社員証の持ち主と必ず同じ） |
| `jobId` | string \| null | invoke 時の jobId（英数字と `_.:/-`、128 文字以内のときだけ。それ以外は null） |
| `tool` | string \| null | ツール ID（例 `mail.send`） |
| `risk` | `low` \| `medium` \| `high` | |
| `status` | `approved` \| `rejected` \| `revision_requested` | |
| `decidedAt` | ISO 日時 \| null | |
| `fulfillment` | `server_completed` \| `server_failed` \| `not_attempted` \| `not_applicable` | 承認時に Staffpass 自身が送信まで済ませたか。`server_completed` なら AI はやり直さない |

### approval.expired

`approvalId` / `employeeId` / `jobId` / `tool` / `risk` に加えて、`status`（`expired`、判断期限の自動却下は `rejected`）、`reason`（`ttl_elapsed` | `deadline_exceeded` | `closed_at_fulfil`）、`expiredAt`。

**入れないもの**: 題名・本文（summary）・差し戻しメモ・承認者・statusToken・pollUrl・metadata・秘密・AI への指示文。
差し戻しメモは「中身」なので、AI が社員証で `staffpass_get_approval_status` を呼んで読む（読み取りにも社員証の確認がかかる）。

### arguments（絞り込み、`additionalProperties: false`）

| 名前 | approval.decided | approval.expired | 説明 |
|---|---|---|---|
| `approvalId` | ○ | ○ | その承認だけ。**購読した社員証の承認でなければ `-32012`** |
| `jobId` | ○ | ○ | その jobId の承認だけ |
| `risk` | ○ | ○ | `["low","medium"]` など。省略＝全部（high を含む＝危険な設定扱い） |
| `status` | ○ | — | `["approved"]` など |

配列は並べ替え・重複除去してから購読 ID に使う（同じ条件＝同じ ID）。

---

## 4. メソッドの動き

| メソッド | 認証 | 主な処理 | エラー |
|---|---|---|---|
| `events/list` | 社員証 | 2 種類のイベント定義を返す | 社員証なし → `-32012`（HTTP 401/403） |
| `events/subscribe` | 社員証 | 形式チェック → 社員証の再確認 → approvalId の持ち主確認 → 購読 ID 計算 → 取り消し済みなら拒否 → 上限確認 → 宛先確認（24 時間キャッシュ、ホストごとに毎分 30 回まで） → 秘密を暗号化して保存 → 期限を決めて返す | `-32602` 形式不正（https 以外・whsec_ 不正・未知の arguments など）、`-32011` 未知のイベント、`-32014` webhook 以外、`-32012` 他人の承認・取り消し済み、`-32013` 上限（`subscriptions` 20 件／`verification_rate`）、`-32015` 宛先確認の失敗（理由は固定の分類だけ）、`-32603` `{reason: "revocation_check_unavailable"}` 社員証の確認が DB エラーなどでできない（一時的。何も記録・拒否しないので、受け手はそのまま再試行できる） |
| `events/unsubscribe` | 社員証 | 有効な購読なら停止し、未送信分を捨てる | 見つからなくても `{}`（冪等。他人の購読があるかどうかも分からない） |

- 更新（同じキーでの再 subscribe）では、秘密が変わっていれば**古い秘密でも 10 分間は二重署名**する。期限は毎回決め直す。止まっていた購読も再開する（`deliveryStatus` に `lastDeliveryAt` と `lastError` を返す）。
- `id` は経路の目印にすぎず、どのメソッドも `id` を受け付けない（知っても何もできない）。
- 宛先確認の失敗・配信の失敗は**分類名だけ**を返す／保存する（受け手の応答本文・ヘッダーは返さない＝内部の調査に使わせない）。

---

## 5. 署名・大きさ・再送・期限

| 項目 | 値 | 実装 |
|---|---|---|
| 署名 | Standard Webhooks `v1,` HMAC-SHA256。鍵は受け手が渡す `whsec_` + base64（24〜64 バイト） | `lib/mcp-events/standard-webhooks.ts`（仕様のテストベクトルで確認） |
| webhook-id | `eventId` = `evt_` + sha256(org, 承認, イベント名, 状態) の先頭 32 桁。**再送でも、同じ判断をもう一度流しても同じ** | `lib/mcp-events/ids.ts` |
| 重複防止 | `mcp_event_deliveries` に unique(subscription_id, event_id)。2 回目の emit は 0 件 | migration |
| 本文 | 1 イベント 1 リクエスト、256KiB を超えるものは送らない（DB でも 262144 バイトで拒否）。再送は同じ本文 | `transport.ts` / migration |
| 再送 | 1 回目は即時、以後 30 秒 → 2 分 → 8 分（最大 4 回・15 分以内）。`410`・`413`・`3xx`、**送る時点の名前解決で公開されていないアドレスが返った場合（`address_blocked`）**は再送しない（その配信は `abandoned`、理由つきで監査） | `service.ts` / `policy.ts` / `transport.ts` |
| 打ち切り | 1 回の送信は**全体で約 5 秒**（DNS を含む）。期限が来たら応答の読み込み・リクエスト・ソケットをすべて破棄する（少しずつデータを返し続ける受け手でも止まる）。ソケットの無通信タイマーとは別 | `transport.ts` |
| 回数の数え方 | **取り出し（claim）の時点で 1 回と数える**（lease と同じ compare-and-set）。送信中に関数が落ちても、その回は使ったことになり、lease（60 秒）が切れた後の再送は次の回。上限を超えて取り出されたものは送らずに `abandoned`（`max_attempts_exceeded`）。**送る前の確認ができなかった回（延期）は数えない**（回数を戻す）。延期も 15 分の再送の枠に入り、枠を超えたら `abandoned`（`revocation_check_unavailable`） | `store.ts` `claimDelivery` / `releaseDeferredDelivery` |
| 配信の行の保持 | `delivered` / `abandoned` / `dropped` の行は、最後の更新から **7 日**（`deliveryRetentionMs`）で削除。再送 cron が毎回最大 500 行ずつ削除する。`pending` は削除しない。長期の記録は監査（`mcp_events.*`）に残る。7 日を過ぎた後に同じ eventId が再び出ても DB の unique では止まらないが、イベントは判断のときに 1 回だけ出るので実際には起きない（受け手も eventId で重複を捨てる） | `service.ts` `pruneFinishedDeliveries` / cron |
| 期限 | §7 | `policy.ts` |
| cursor | 常に `null`、`truncated: false`（再生なし。ChatGPT も gap 非対応） | |

---

## 6. 受け手・購読の設定一覧

購読 1 件ごとに `mcp_event_subscriptions` に 1 行。管理側から見る一覧は `listSubscriptionLedger(orgId)`（秘密・指紋・URL 本体は出さない）。

| 設定 | 誰が決める | 値・制限 | 保存のしかた |
|---|---|---|---|
| イベント名 | 受け手 | `approval.decided` / `approval.expired` | 平文 |
| arguments | 受け手 | §3 の 4 種類だけ | 正規化した JSON（4KB まで） |
| 宛先 URL | 受け手 | https・443 番・ユーザー情報なし・#なし・IP 直書きなし・1 語のホスト名や `.internal` `.local` などは不可・2048 文字以内 | 平文（一覧にはホスト名と URL のハッシュ先頭だけ） |
| 署名の秘密 | 受け手 | `whsec_` + 24〜64 バイト | **AES-256-GCM で暗号化**（`lib/notify/crypto.ts`、既存の起こす webhook の秘密と同じ方式・同じ鍵 `NOTIFICATION_CONFIG_ENCRYPTION_KEY`）＋ sha256 指紋。平文は保存しない（DB の check で `v1.` 形式以外を拒否） |
| 旧い秘密 | サーバー | 鍵の切り替えから 10 分だけ併用 | 暗号化 |
| 希望の期限 `ttlMs` | 受け手 | 数値／null／省略 | 実際の期限 `refresh_before` と `granted_ttl_ms` |
| 危険度 | サーバー | `standard` / `elevated` と理由 | §7 |
| 宛先確認 | サーバー | 確認日時。同じ（主体, URL）は 24 時間有効 | `verified_at` |
| 状態 | サーバー | `active` / `unsubscribed` / `revoked` / `expired` | 取り消しは戻らない |
| 配信の状態 | サーバー | 最終配信日時、最後の失敗の分類、失敗が続いている起点 | 分類名だけ（DB の check で固定値以外を拒否） |
| 主体 | サーバー | `emp:<org>:<社員>:g<世代>` ＋ 社員証の指紋・credential id | 社員証の再発行で世代が変わる＝別の主体 |

サーバー全体の設定（テナントごとではない）:

| 環境変数 | 意味 | 既定 |
|---|---|---|
| `MCP_EVENTS_ENABLED` | この機能全体 | OFF |
| `MCP_EVENTS_TRUSTED_RECEIVER_HOSTS` | 「信頼できる受け手」のホスト名（完全一致、カンマ区切り）。例: 受け手が公開している受信ホスト | なし（＝全部「危険な設定」扱い） |
| `NOTIFICATION_CONFIG_ENCRYPTION_KEY` | 秘密の暗号化（既存） | 必須。ないと subscribe は `-32603` |
| `CRON_SECRET` | 再送 cron の認証（既存）。`Authorization: Bearer <CRON_SECRET>` のみ（PR #264 の共通ヘルパー）。未設定 → 503、`replace_me…` のまま → 401 | 必須 |

上限: AI 社員 1 人あたり有効な購読 20 件、宛先確認の POST はホストごとに毎分 30 回（**全インスタンスで共有**。D11、下の「宛先確認の回数制限」）。

#### 宛先確認の回数制限（D11、2026-10-05 八坂 GO で実装）

- 数える場所: テーブル `mcp_event_verification_windows`（`host`, `window_start`, `count`、主キー `(host, window_start)`）。migration `20261005000000` に追加（新しい migration は作らない）。RLS は ON、ポリシーなし、anon / authenticated は権限なし（テーブルも関数も）、service_role だけ。
- 数え方: **固定の 1 分の窓**。`window_start` はアプリの時刻を分で切り捨てたもの（UTC）。宛先確認の POST を送る前に、RPC `mcp_events_take_verification_budget(host, window_start, 30)` を 1 回だけ呼ぶ。中身は **1 つの SQL 文** `INSERT … ON CONFLICT (host, window_start) DO UPDATE SET count = count + 1 WHERE count < 30 RETURNING count`。同時に来ても同じ行の上で順番に処理されるので、読んでから書く競合はない（40 並列で呼んで、ちょうど 30 だけ true になることを `test-db-local.py` で確認）。満杯の窓は何も更新せず false を返す。関数は security invoker、ホストは小文字・1〜253 文字、窓は分ちょうど、上限は 1〜10000 でなければ例外。
- 結果: true → POST する。false → `-32013 Verification rate limit`（今までどおり）。**テーブルや RPC に届かない・エラー・おかしな答え → POST せず `-32603` `{ reason: "verification_rate_unavailable", retryable: true }`**（fail closed。購読は作らない。エラーの中身は返さない）。インスタンスのメモリに逃げる経路はない。
- 片づけ: 再送 cron が毎回、開始から 10 分より古い窓を消す（`MCP_EVENTS_LIMITS.verificationWindowRetentionMs`、応答の `prunedVerificationWindows`）。1 行はホスト名と回数だけ。
- 固定の窓なので、窓の境目をまたぐと最大 60 回／60 秒になりうる（滑る窓より緩い）。受け手を守る目的（大量の確認 POST の防止）には十分と判断。
- デモ（Supabase なし）は同じ固定の窓をメモリで数える。

---

## 7. 危険な設定の期限を短くする

次のどれかに当たる購読を `elevated`（危険）とし、期限を短くする。

| 理由 | 当たる条件 | なぜ危険か |
|---|---|---|
| `receiver_not_allowlisted` | 宛先ホストが `MCP_EVENTS_TRUSTED_RECEIVER_HOSTS` にない | 知らない受け手に、人がいないところで AI を起こす合図が届き続ける |
| `includes_high_risk_approvals` | `risk` の絞り込みがない、または `high` を含む | お金・送信・発注など危険な承認の結果で AI が動き出す |
| `no_expiry_requested` | `ttlMs: null`（無期限の希望） | 止め忘れの影響が大きい |

| 区分 | 既定 | 最大 | 最短 |
|---|---|---|---|
| standard | 1 時間 | 24 時間 | 5 分 |
| elevated | 15 分 | **1 時間** | 5 分 |

- `ttlMs: null` でも**無期限は出さない**（区分の最大を返す）。仕様上サーバーは有限を返してよい。ChatGPT は `terminated` を受け取れないので、期限が「止める最後の手段」になる。
- 期限が切れた購読には送らない（送る直前にも確認し、切れていれば `expired` にする）。
- 期限を短くすると受け手の更新が増えるだけ（仕様も「更新のコストは小さい」としている）。

---

## 8. 権限の取り消しで即停止

ChatGPT は `terminated` 通知に対応していないので、**サーバーが自分で止めて、自分で更新を断る**。

1. **送る直前に毎回**、購読した社員証を確かめ直す（`lib/mcp-events/principal.ts`）:
   紐づけ（binding）が取り消されていない／社員証の世代と指紋が購読時と同じ（再発行されていない）／AI 社員が同じ org にいて停止されていない／（本番）credential の行が取り消し・期限切れでない。
2. 崩れていることが**確実に分かったら**（行がないと確認できた・取り消し済み・世代か指紋が違う・社員が停止中・credential が取り消し済みか期限切れ）、その AI 社員の**有効な購読を全部 `revoked`** にし、未送信の配信を捨て、`mcp_events.subscription_revoked`（理由つき）を記録する。そのイベントは送らない。
   - **確認できなかったとき**（DB の読み取りエラー、service role のクライアントがない、例外）は「行がない」とは扱わない。既存の `getBinding` / `getEmployeeById` はエラーを握りつぶして「ない」を返すので、ここでは使わず、エラーと「ない」を分けて返す専用の読み取り（`supabasePrincipalReader`）を使う。
   - そのときは**その回だけ延期**する: 送らない・取り消さない・他の配信も捨てない。回数は数えず、60 秒後（`deferMs`）にもう一度試す。配信の行に `lastError: revocation_check_unavailable` を残し、最初の延期だけ `mcp_events.delivery_deferred` を監査に記録する（毎回の延期はログ `mcp_events_delivery_deferred`）。
   - 15 分の再送の枠を超えても確認できなければ、その配信だけ `abandoned`（理由 `revocation_check_unavailable`）。購読は止めない。確認できないまま送ることはしない（fail closed）。
   - subscribe のときに確認できなければ `-32603`（`revocation_check_unavailable`）を返す。`-32012` ではないので、受け手は再試行できる。
3. `revoked` は戻らない。同じキーで更新が来ても **`-32012 Forbidden`**。社員証を再発行した後の購読は、世代が違う別の主体なので、宛先確認からやり直しになる。
4. subscribe のときも同じ確認をする（古い社員証から購読を始められない）。
5. 配信の直前に、承認がまだ同じ org・同じ社員のものであることも確かめる（購読の照合は org と社員の両方で行う）。
6. 期限（§7）が最後の歯止め。受け手が更新をやめれば、最大でも 1 時間（危険な設定）／24 時間で止まる。

---

## 9. 「何が AI を動かしたか」の監査

| action | いつ | 主な metadata（秘密・本文なし） |
|---|---|---|
| `mcp_events.subscribed` | 購読・更新 | subscriptionId, eventName, receiverHost, receiverUrlHash, arguments, risk, riskReasons, grantedTtlMs, ttlCapped, refresh, secretRotated, verification（challenge / cached） |
| `mcp_events.unsubscribed` | 停止 | subscriptionId, eventName, receiverHost |
| `mcp_events.delivered` | 配信成功 | eventId, eventName, approvalId, subscriptionId, receiverHost, attempt, status |
| `mcp_events.delivery_abandoned` | 再送をあきらめた | 上記 ＋ attempts, lastError（分類）, reason（`http_5xx` / `address_blocked` / `redirect_refused` / `max_attempts_exceeded` / `revocation_check_unavailable` など） |
| `mcp_events.delivery_deferred` | 社員証の確認ができず延期した（配信ごとに最初の 1 回） | eventId, eventName, approvalId, subscriptionId, reason（`revocation_check_unavailable` / `store_unavailable`）, detail（`binding_read_error` などの固定値）, nextAttemptAt, attemptsSoFar |
| `mcp_events.subscription_revoked` | 権限の変化で停止 | reason（binding_revoked / credential_rotated / employee_suspended / …）, subscriptionIds, droppedDeliveries |
| `mcp_events.triggered_action` | 配信のあと 30 分以内の、その社員証の**最初の** tools/call | eventId, eventName, approvalId, subscriptionId, tool, lagMs, `basis: "first_tool_call_after_delivery"` |

- `triggered_action` は「時間的に直後だった」という記録で、因果の証明ではない（`basis` に明記）。1 回の配信に 1 回だけ結び付ける。
- イベントは**許可ではない**。AI がその後に何をしても、通常どおり Gateway・承認・SoD の確認を通る。監査は「起こされた → 何をした」を後から追えるようにするためのもの。
- これで「承認の判断（既存の approval 監査）→ 配信（delivered）→ AI の最初の操作（triggered_action）→ その操作の監査」が eventId と approvalId でつながる。

---

## 10. 既存の仕組みとの関係

| 既存の仕組み | 何をしているか | MCP Events との関係 | 二重に起こさない工夫 |
|---|---|---|---|
| 会話の「起こす webhook」（binding の `wakeWebhookUrl`、Slack メンション・IM など） | 会話が来たら AI を起こす | **共存・対象外**。会話の起動であって承認の結果ではない | イベントの種類が違うので重ならない |
| 承認結果の callback（社員の `callbackUrl`、`approval.resolved`） | 判断のたびに本文つきで POST（署名なし） | **共存（将来は置き換え候補）**。MCP Events は署名・宛先確認・期限・取り消し停止つき | フラグ ON のとき callback の本文に**同じ `eventId`** を足す。受け手は eventId で 1 回にまとめられる。同じ AI に両方を向けないよう案内する。社員ごとの「どちらを使うか」は決定事項（§15） |
| 承認結果のメール（`approvalNotifyEmail`） | 機械向けの本文をメール | 共存 | 同上（メールは人も読むので残す） |
| 状態の問い合わせ（`staffpass_get_approval_status` / pollUrl） | AI が自分で見に行く | **共存（必須）**。イベントは合図だけで、詳細はこれで読む | 問い合わせは何度でも安全（読むだけ） |
| 自動 fulfil（承認時に Staffpass が送信まで行う） | approve → fulfil → 共通処理 の順 | **そのまま**。イベントは fulfil の**後**に出て、`fulfillment` で結果を伝える | `server_completed` なら AI はやり直さない。仮にやり直しても jobId と実行の claim（`claim_approval_execution`）で二重送信にならない |
| W2（承認後に送れていないものを 5 分後に再実行） | サーバー側で再実行（最大 2 回） | **そのまま**。W2 はイベントを出さない | イベントは判断 1 回につき 1 つ（eventId 固定）。W2 の再実行は AI を起こさない |
| W1（メンション未返信の見張り） | 人への通知 | **関係なし** | — |
| MCP handoff の「つながっていない」見張り | 起こした後に社員証の利用がない社員を人に知らせる | **そのまま**。数えるのは `MCP_HANDOFF_WAKE_ACTIONS`（Slack の起こす webhook 4 種類と callback 経由の `agent.approval_wake`）だけで、`mcp_events.delivered` は数えない（購読できた受け手はすでに MCP でつながっている） | — |
| 期限切れ（TTL、fulfil 時の期限切れ）／置き換え（superseded） | 送らずに閉じる | 期限切れだけ `approval.expired` を出す。置き換えは出さない（新しい返信・承認依頼が同じ会話をカバーしている。決定事項 §15） | 承認の直後に fulfil で期限切れになったものは、`approval.decided` を**出さず** `approval.expired` だけ（emit 時に承認を読み直して判定） |

置き換えの順番（案）: ① フラグ ON で共存（callback に eventId）→ ② ChatGPT 等で実運用を確認 → ③ 社員ごとに「MCP Events を使うなら callback を止める」設定を追加 → ④ callback を署名つき・SSRF 対策つきに直す（§12 の既存の指摘）。

---

## 11. Slack・LINE・Telegram で同じに動く理由

- 判断の入口（`app/api/webhooks/slack/[ref]`、Slack interactivity、`app/api/webhooks/line/[ref]`、`app/api/webhooks/telegram`、`lib/notify/telegram-channel-webhook.ts`、Web の approve/reject/revise、`lib/admin/proxy-approve.ts`）は、すべて最後に `runApprovalResolveSideEffects` を呼ぶ。イベントはここで 1 回だけ出す。
- イベントの本文に「どのチャネルで判断したか」は入れない。送り先は**受け手が購読で指定した URL**で、チャネルとは無関係。
- 期限切れは `auditApprovalClosed`（TTL の掃除・invoke 時・fulfil 時）と判断期限の自動却下の 2 経路だけで、どれもチャネルに依存しない。
- テスト `lib/mcp-events/hooks.test.ts` で、surface を `slack` / `line` / `telegram` / `web` にして同じ形のイベントが 1 件ずつ出ること、判断者の識別子が本文に入らないことを確認している。

---

## 12. セキュリティ（security-audit skill の guidance mode）

### 12.1 信頼の境目

| 境目 | 低い側 | 高い側 | 守り |
|---|---|---|---|
| events/* の呼び出し | 社員証を持つ AI（とその受け手） | Staffpass の購読データ | 社員証の解決（`resolveEmployeeCredential`）、購読キーに主体を含める、approvalId の持ち主確認、上限 |
| 受け手 URL への送信 | 受け手が指定した URL | Staffpass の実行環境のネットワーク | https/443 だけ、名前解決のたびに全アドレス確認、IP 固定、リダイレクトに従わない、応答の読み込み上限、分類だけ返す |
| 他人の URL を狙う | 攻撃者（自分の社員証で他人の URL を購読） | 第三者の受信口 | 宛先確認（challenge の往復）、ホストごとの回数制限、24 時間のキャッシュは（主体, URL）ごと |
| テナントの境目 | org A の AI | org B の承認 | 照合は org と社員の両方。DB のトリガーでも「社員は購読の org の人」「配信の org・社員＝購読の org・社員」を強制 |
| 秘密 | DB を読める人・ログ | 受け手の署名鍵 | AES-256-GCM で保存（平文は DB の check で拒否）、監査・一覧・応答に出さない、RLS on・ポリシーなし・anon/authenticated 権限なし |
| 権限の変化 | 取り消された社員証 | 以後のイベント | 配信のたびの再確認（確実に分かったときだけ取り消し、確認できないときは送らずに延期）、取り消しは戻らない、期限は必ず有限 |

### 12.2 脅威と対策（このプロトタイプで閉じたもの）

| 脅威 | 対策 | 確認 |
|---|---|---|
| SSRF（内部・ループバック・リンクローカル・メタデータ 169.254.169.254 / fd00:ec2::254 / 100.100.100.200） | `isPublicDownloadAddress`（既存）を**全**アドレスに適用。IP 直書き URL・内部向けホスト名は形式で拒否 | `transport.test.ts`（11 種類のアドレス） |
| DNS リバインディング | 送るたびに名前解決 → 確認した IP に直接接続（`hostname: IP`、`servername`/`Host` は元の名前、`agent:false`） | 「1 回目は公開 → 2 回目は内部」で 2 回目が拒否されること、接続オプションの固定 |
| リダイレクトで内部へ | `node:https` はリダイレクトしない。3xx は失敗・再送なし | テスト |
| 送る時点で内部のアドレスに解決される受け手 | `address_blocked` は恒久的な失敗。その配信は再送せず `abandoned`（理由つきで監査）。次のイベントでもまた名前解決から確認する | `resilience.test.ts`（3b）、`transport.test.ts` |
| 応答を引き延ばす受け手（slowloris 型） | 全体の期限で応答・リクエスト・ソケットを破棄。`postWebhook` 側の期限でも AbortSignal で同じ破棄をする | `transport.test.ts`（3a） |
| DB の一時的な障害で購読が消える（可用性） | 読み取りエラーは「行がない」と区別し、延期だけする。取り消しは確実なときだけ | `resilience.test.ts`、`principal-reader.test.ts` |
| 送信中に落ちた回を数えず無限に再送 | 取り出しの時点で数える。上限を超えたら送らない | `resilience.test.ts`（3c） |
| 応答を使った内部の探索 | 応答本文・ヘッダーは返さない・保存しない。分類 6 種類だけ（DB の check でも固定） | テスト（「internal detail」が漏れない） |
| 他人の URL への大量送信 | 宛先確認が通るまで送らない。確認 POST はホストごとに毎分 30 回まで | テスト |
| 署名の偽造・再生 | 受け手の秘密で HMAC。時刻を毎回付け直す。受け手は 5 分より古いものを捨て、webhook-id で重複を捨てる | 仕様のテストベクトル |
| テナントをまたぐ通知 | アプリ（org と社員で照合し、配信直前にも確認）と DB（トリガー）の二重 | `service.test.ts`（別 org の偽の行に届かない）、`db-mcp-events.sql` |
| 本文からの漏えい | ID と状態だけ。jobId / tool も安全な文字だけ | テスト（題名・本文・承認者・statusToken・whsec が入らない） |
| 取り消し後の配信 | §8 | テスト（binding 取り消し・行がない・社員証の再発行・社員の停止・credential の取り消し） |
| プロンプトインジェクション | 本文に自由文がない。説明文はスキーマの説明だけ | — |
| 購読の乗っ取り | キーに主体を含めるので、他人は同じ購読を更新・停止できない。`id` は入力にしない | `ids.test.ts` |
| 資源の食いつぶし | 社員 1 人 20 件、期限は有限、本文 256KiB、再送は 4 回 15 分まで、終わった配信の行は 7 日で削除 | テスト |
| 再送 cron の不正な呼び出し | PR #264 の共通ヘルパー（SHA-256 の digest を `timingSafeEqual` で比較、Bearer のみ、未設定 503、placeholder 401）。以前の独自実装は `x-cron-secret` も受け付け、長さの比較を先にしていた | `route.test.ts` |

### 12.3 残っている点・確認が要る点（重大度は付けない＝needs_validation）

| # | 内容 | 状態 | 確認のしかた |
|---|---|---|---|
| N1 | **既存**: 承認結果の callback（`employee.callbackUrl`、`lib/approvals/resolve-side-effects.ts`）は URL の形式チェックがなく（https 以外も入る）、名前解決後の IP 確認もなく、`fetch` の既定でリダイレクトに従う。設定できるのはテナントの管理者（社員の発行時）。approve の応答に `callback.status` / エラー文が入るため、内部向けの到達確認に使える可能性がある | needs_validation（Vercel の実行環境から内部に届くかはリポジトリの外の事実） | 実行環境のネットワーク構成の確認。直すなら `lib/mcp-events/transport.ts` の `postWebhook` を使い、応答の `callback.error` を分類だけにする |
| N2 | **既存**: 会話の起こす webhook（`lib/slack/mention-ingress.ts`）も https だけ確認し、IP 確認なし・リダイレクトに従う | 同上 | 同上 |
| N3 | **宛先確認のキャッシュは DB にある**（`isVerifiedFor`: `mcp_event_subscriptions` から、同じ主体・同じ URL で取り消されておらず、`verified_at` が 24 時間以内の行を探す）。したがってインスタンスをまたいで共有され、主体（社員証の世代）ごとに分かれている。宛先確認の POST の回数制限（ホストごとに毎分 30 回）も **DB で共有**（`mcp_event_verification_windows`、D11）。届かないときは確認を断る | 解消（D11、2026-10-05） | `test-db-local.py` の 40 並列 → 30 件、`verification-budget.test.ts` |
| N4 | 送信の 1 回目はバックグラウンド（`waitUntil`）。実行環境が止まると cron の再送まで遅れる。取り出した回は数えるので、無限には再送しない | 設計上の制限 | cron の間隔を決める（§15） |
| N7 | 延期の監査は配信ごとに最初の 1 回だけ（DB 障害中に監査も書けない可能性があるため、毎回の延期はログ）。障害が長いと、延期の監査が残らずにログだけになることがある | 設計上の制限 | 本番の監視でログ `mcp_events_delivery_deferred` を拾う |
| N5 | 秘密の暗号化鍵は既存の `NOTIFICATION_CONFIG_ENCRYPTION_KEY` を共用。鍵を替える手順は既存の秘密と同じ扱い | 既存方針に合わせた | — |
| N6 | `events/*` はまだ 2026-07-28 のヘッダー（`MCP-Protocol-Version` / `Mcp-Method`）を確認していない（§13 の別 PR） | 未対応 | 別 PR |

### 12.4 フラグ OFF のときに変わらないこと

`MCP_EVENTS_ENABLED` が OFF なら、メソッド・capabilities・callback の本文・監査・テーブルへのアクセス・外向きの通信のどれも変わらない（`events/*` は今までどおり `-32601`、cron は `skipped`）。テストで確認している。

---

## 13. 2026-07-28 への対応状況（取り込み前の main の記録。#268 を取り込んだ後は §16.3）

### 13.1 initialize の実際の応答（main 17bf560、ローカルで POST して取得）

社員用 `/api/mcp` — 要求の版が `2026-07-28` / `2025-06-18` / `2024-11-05` のどれでも**同じ**応答:

```json
{"jsonrpc":"2.0","id":1,"result":{
  "protocolVersion":"2024-11-05",
  "capabilities":{"tools":{"listChanged":true}},
  "serverInfo":{"name":"staffpass","version":"1.0.0"},
  "instructions":"Staffpass is a fail-closed AI employee control plane. …"}}
```

管理用 `/api/mcp/admin` — 同じく常に:

```json
{"jsonrpc":"2.0","id":1,"result":{
  "protocolVersion":"2024-11-05",
  "capabilities":{"tools":{"listChanged":true}},
  "serverInfo":{"name":"staffpass-admin","version":"1.0.0","title":"Staffpass Admin"},
  "instructions":"Staffpass Admin MCP is a separate mouth from the employee badge MCP. …"}}
```

- 版の交渉はしていない（要求を見ずに `2024-11-05` を返す）。
- `server/discover` → HTTP 200 で `-32601 Method not found`（2026-07-28 では必須。版違いは HTTP 400 + `-32022`、不明なメソッドは HTTP 404 のはず）。
- `MCP-Protocol-Version` / `Mcp-Method` / `Mcp-Name` ヘッダーと、リクエストごとの `_meta`（`io.modelcontextprotocol/protocolVersion` など）を見ていない。
- `events/list` → `-32601`（このプロトタイプでフラグ ON にすると社員用だけ応答。版は 2024-11-05 のまま）。
- **結論: どちらも 2026-07-28 非対応。** ChatGPT は 2026-07-28 と `server/discover` の `capabilities.events` を前提にしているので、このプロトタイプだけでは ChatGPT とつながらない。

### 13.2 古い版の記述がある場所

| 場所 | 行 | 内容 | 種類 | この PR |
|---|---|---|---|---|
| `lib/mcp/tools.ts` | 51 | `MCP_PROTOCOL_VERSION = "2024-11-05"` | コード（両 MCP の応答の元） | 変えない（版を変えるとクライアントの互換に影響。別 PR） |
| `app/api/mcp/route.ts` | 71, 130 | server card（GET）と initialize の `protocolVersion` | コード | 変えない |
| `app/api/mcp/admin/route.ts` | 63, 109 | 同上（管理用） | コード | 変えない |
| `docs/mcp.md` | 118 | curl 例の `"protocolVersion": "2024-11-05"` | ドキュメント | 例は**今の実際の応答と同じ**なので正しい。「2026-07-28 は未対応」の注記だけ追加（ドキュメントのみ） |
| `lib/mcp/unauth-init-log.test.ts` | 26, 35, 61 | `2025-06-18` | テスト（クライアントが送る値の例） | 変えない（記録する値の例なので古くてよい） |
| `docs/runbooks/mcp-unauth-initialize-observation-20261003.md` | 19 | ログ例の `2025-06-18` | ドキュメント（観測ログの例） | 変えない（実際に観測される値の例） |
| `public/.well-known/mcp/server-card.json` / `admin-server-card.json` | — | 版の記載なし。`capabilities.tools` だけ | 静的 server card | 変えない（Events は未公開のため） |
| `lib/mcp/endpoint-handoff*`、`components/mcp/McpSetupContent.tsx`、`app/docs/mcp` | — | 版の記載なし | — | — |
| CORS（両 route） | 32 / 28 | `Mcp-Session-Id` を許可・公開（2026-07-28 ではセッション廃止。`MCP-Protocol-Version` / `Mcp-Method` / `Mcp-Name` は未許可） | コード | 変えない（別 PR） |

### 13.3 2026-07-28 に対応する別 PR でやること（案）

1. `server/discover`（`supportedVersions: ["2026-07-28", "2024-11-05"]`、capabilities、`_meta.io.modelcontextprotocol/serverInfo`、instructions、ttlMs・cacheScope）。
2. リクエストごとの `_meta` の版と `MCP-Protocol-Version` / `Mcp-Method` / `Mcp-Name` ヘッダーの一致確認（不一致 `-32020`、非対応の版 `-32022` に `{supported, requested}`、HTTP 400）。不明なメソッドは HTTP 404。
3. `initialize` は旧い版のクライアント向けに残す（両方の版に答える）。
4. CORS に新しいヘッダーを追加。
5. server card・`docs/mcp.md` を更新。
6. 管理用 MCP も同じ（Events は出さない）。

---

## 14. 実装の場所

| ファイル | 役割 |
|---|---|
| `lib/feature-flags.ts` `isMcpEventsEnabled` | フラグ（既定 OFF） |
| `lib/mcp-events/catalog.ts` | イベント定義・arguments の検証と照合 |
| `lib/mcp-events/payload.ts` | 本文（ID と状態だけ） |
| `lib/mcp-events/ids.ts` | 購読 ID・eventId |
| `lib/mcp-events/standard-webhooks.ts` | whsec_ の検証・署名・検証 |
| `lib/mcp-events/transport.ts` | SSRF 対策つきの送信 |
| `lib/mcp-events/policy.ts` | 期限・危険度・上限 |
| `lib/mcp-events/principal.ts` | 社員証の再確認（エラーと「ない」を分ける専用の読み取り。結果は `ok` / `revoked` / `unavailable`） |
| `lib/mcp-events/store.ts` | 保存（デモはメモリ、本番は service_role のテーブル） |
| `lib/mcp-events/service.ts` | events/* の処理・emit・配信・監査・一覧 |
| `app/api/mcp/route.ts` | events/* の受け口（フラグ ON のときだけ）、tools/call の「直後の操作」記録 |
| `app/api/cron/mcp-events-deliver/route.ts` | 再送・保持期間の削除・回数制限の古い窓の削除の cron（`rejectUnauthorizedCron`＝PR #264 の共通ヘルパー）。`vercel.json` に毎分で登録。フラグ OFF なら `skipped` を返すだけ（service を読み込まず、Supabase のクライアントも作らない） |
| `lib/approvals/resolve-side-effects.ts` | approval.decided を出す（＋ callback に eventId） |
| `lib/comm-reply-dedup/approvals.ts` / `lib/decision-workflow/expiry.ts` | approval.expired を出す |
| `supabase/migrations/20261005000000_mcp_event_subscriptions.sql` | テーブル 3 つ（購読・配信・回数制限の窓）・トリガー・回数制限の関数（ロールバックつき）。**PR では適用しない** |
| `tests/security/db-mcp-events.sql` ほか | テスト |

### 本番で有効にする手順（この PR ではしない）

1. migration `20261005000000` を適用（追加のみ。戻すときは migration 末尾の ROLLBACK か `supabase/verification/20261005000000_mcp_event_subscriptions_rollback.sql`。先にフラグを OFF）。**フラグを ON にする前に必ず適用する**（未適用で ON にすると、回数制限のテーブルに届かないので宛先確認はすべて `-32603 verification_rate_unavailable` で断られる＝fail closed）。
2. cron はこの PR で `vercel.json` に毎分で登録済み（D6）。マージ後のデプロイから毎分呼ばれるが、フラグ OFF の間は `skipped` を返すだけで DB に触らない。
3. 必要なら `MCP_EVENTS_TRUSTED_RECEIVER_HOSTS` を設定。
4. 2026-07-28 対応は #268（D1、マージ済み）。
5. `MCP_EVENTS_ENABLED=true`。

---

## 15. 八坂の判断（2026-10-05 08:08 八坂 GO、木村経由）

| # | 内容 | 状態 | 内容 |
|---|---|---|---|
| D1 | 2026-07-28 対応（`server/discover` など）を**別 PR** にするか | **別 PR #268（マージ済み、main `face511`）** | #268 をこのブランチに通常の merge で取り込み、`app/api/mcp/route.ts` の衝突を解消した（§16.3） |
| D2 | 期限の数字（standard 1 時間／最大 24 時間、elevated 15 分／最大 1 時間、最短 5 分） | **決定（2026-10-05 八坂 GO）** | 案のとおり |
| D3 | 「危険な設定」の 3 条件（許可リスト外の受け手・high を含む・無期限の希望） | **決定（2026-10-05 八坂 GO）** | 案のとおり。許可リストは最初は空（全部 elevated） |
| D4 | 宛先は 443 番だけにするか | **決定（2026-10-05 八坂 GO）** | 443 だけ |
| D5 | 置き換え（superseded）でもイベントを出すか | **決定（2026-10-05 八坂 GO）** | 出さない（期限切れだけ） |
| D6 | 再送 cron の追加と間隔 | **決定（2026-10-05 八坂 GO）** | 毎分。**この PR で `vercel.json` に登録した**（当初案の「本番手順で追加」から変更、GO の指示どおり）。フラグ OFF の間は `skipped` で DB に触らない（`route-flag-off.test.ts`） |
| D7 | callback と MCP Events を両方使っている社員の扱い（二重に起きる可能性） | **決定（2026-10-05 八坂 GO）** | 当面は eventId で受け手がまとめる。次に「MCP Events を使うなら callback を止める」社員ごとの設定 |
| D8 | 管理用 MCP にも Events を出すか | **決定（2026-10-05 八坂 GO）** | 出さない（管理の操作は人の承認が前提で、AI を自動で起こす理由が薄い） |
| D9 | 既存の callback・起こす webhook の SSRF 対策（§12.3 N1・N2）を直すか | **GO（別 PR、この PR の上に積む）** | `postWebhook` に寄せる。ブランチ `fix/webhook-postwebhook-d9-20261005` |
| D10 | 古い版の例（§13.2）をどこまで直すか | 案（未決） | この PR は `docs/mcp.md` の注記だけ。コードの版は D1 の PR で |
| D11 | 宛先確認の POST の回数制限を共有の数え方にするか（確認のキャッシュはすでに DB） | **決定・実装済み（2026-10-05 八坂 GO）** | Upstash ではなく **Supabase のテーブル**（`mcp_event_verification_windows`）と 1 文の RPC。固定 1 分の窓、届かなければ fail closed。§6 の「宛先確認の回数制限」 |
| D12 | 配信の行の保持期間（7 日）と、延期の間隔（60 秒） | **決定（2026-10-05 八坂 GO）** | 案のとおり |

---

## 16. 他の PR との関係（2026-10-05 時点）

### 16.1 PR #264（マージ済み）

- **#264 は main にマージ済み**（main `ecb9388`、#263・#264・#266 を含む）。origin/main を通常の merge コミット `a016f32` で取り込んだので、#264 のコミットはこの PR の差分から消えた。以下は取り込み時の記録。

- 再送 cron は `lib/security/cron-secret.ts`（`rejectUnauthorizedCron`、PR #264）を使う。そのため #264 のブランチ `fix/cron-secret-constant-time-20261004`（head `38b91f4`、remote でも同じことを確認）を、この PR のブランチに**通常の merge コミット**で取り込んだ（rebase なし）。
- **#264 を先にマージする必要がある。** #264 が main に入れば、この PR の差分から #264 のコミット（9 ファイル）は消える。
- 挙動の変化: `CRON_SECRET` が未設定のとき 401 → **503 `cron_not_configured`**、`x-cron-secret` ヘッダーは受け付けない（Bearer のみ）、`replace_me…` のままなら 401。この cron は D6 で vercel.json に毎分で登録した（フラグ OFF の間は `skipped`）。

### 16.2 PR #265 と衝突する（後からマージする側が解消する）

#265（`fix/member-invite-activation-20261004`、head `7cf9b60`、#263 の上に積んである）をこのブランチに試しに merge した（使い捨ての worktree、merge 後に削除。#265 は変更していない）。衝突は 3 ファイルで、どれも「同じ場所にそれぞれ追加した」だけ。

| ファイル | 衝突する箇所 | 解消のしかた |
|---|---|---|
| `lib/feature-flags.ts` | ファイル末尾。こちらは `isMcpEventsEnabled`（`MCP_EVENTS_ENABLED`）、#265 は `isMemberInviteActivationEnabled`（`MEMBER_INVITE_ACTIVATION_ENABLED`）を同じ位置に追加 | **両方の関数を残す**（それぞれの doc コメントごと。順番はどちらでもよい） |
| `scripts/test-db-all-migrations.py` | (1) 定数の定義の位置: こちらの `ADDITIVE = [("20261005000000_", "tests/security/db-mcp-events.sql", (...))]` と #265 の `POST_APPLY_TESTS = ("tests/security/db-member-guard.sql", "tests/security/db-member-invite-activation.sql")`。(2) FIXES の PASS 表示の直後: こちらは main 側の `+ "; service_role reads/writes all.")))`（閉じ括弧 3 つ）、#265 は古い形の `...all.")` の後に `for test_file in POST_APPLY_TESTS:` のループを追加 | (1) **両方の定数を残す**。(2) **こちら（main 側）の閉じ括弧 3 つの行を残し、その後に #265 の `POST_APPLY_TESTS` のループを足す**。`ADDITIVE` のループ（全履歴の後の SQL テスト・再適用・ROLLBACK・再適用）はそのまま |
| `scripts/test-db-local.py` | `db-rls-write-holes-phase2.sql` の後: こちらは main 側の LP 2 本（`20261001000000_lp_inquiries.sql`、`20261004800000_lp_tables_server_only.sql`）と MCP Events（適用・再適用・SQL テスト・ROLLBACK・削除の確認・再適用）、#265 は招待の active 化（fail-first・適用・並列・runbook・ROLLBACK・再適用）を同じ位置に追加 | **両方のブロックを残す**（こちらのブロックの後に #265 のブロック）。#265 の側は main の LP 2 本を持っていないので、こちらの側の LP の行を消さないこと |

試しの解消（上の方針どおり）で `test-db-local.py` と `test-db-all-migrations.py` を実行し、どちらも PASS した（schema.sql ＋ 63/64 の migration、`db-member-invite-activation.sql` と `db-mcp-events.sql` の両方が全履歴の上で PASS）。ほかのファイル（`lib/types.ts`、`lib/data/index.ts`、`lib/security/tenant-table-write-paths.test.ts`）は自動で merge できた。

### 16.3 PR #268（D1、2026-07-28 対応）— **マージ済み**（main `face511`）。衝突は木村の 3 点のとおり解消

- #268 は main にマージ済み（`face511`）。その後 origin/main を通常の merge コミット `ed1428a` で取り込んだ（中身は先に取り込んだ #268 のブランチと同じなので、差分は変わらない）。以下は取り込みの記録。

- 木村の指示（2026-10-05）: #268 は承認済みで #267 より先にマージする。`git ls-remote` で `feat/mcp-protocol-2026-07-28-d1` の head が `7300679` であることを確認し、このブランチに**通常の merge コミット**で取り込んだ（rebase なし）。#268 が main に入れば、この PR の差分から #268 のコミットは消える。
- 衝突は `app/api/mcp/route.ts` の 1 ファイルだけ（`lib/feature-flags.ts`・`docs/mcp.md` は自動で merge）。解消のしかた:
  1. `events: {}`（`MCP_EVENTS_ENABLED` が ON のときだけ）を #268 の共通の `serverCapabilities()` の中に入れた。`initialize` と `server/discover`（legacy・modern とも）が同じ `capabilities` を返す。`initialize` は #268 の版の交渉（`negotiateInitializeVersion`）のまま。
  2. `events/list`・`events/subscribe`・`events/unsubscribe` の分岐は、最後の「不明なメソッド → `-32601`（modern は HTTP 404）」より**前**に置いた。不明なメソッドはその最後の分岐のまま。
  3. 2026-07-28 の `_meta` の要求（modern）では、events/* の結果も `reply()` を通す（`resultType: "complete"`、`_meta["io.modelcontextprotocol/serverInfo"]`、tools/* と同じ形）。legacy の要求の結果は今までどおり。エラーは JSON-RPC のエラーのまま。
- `events-route.test.ts` の修正: `initialize` に `2026-07-28` を送ると、#268 以降は `2025-11-25`（initialize の世代の最新）が返る。
- 追加したテスト（`events-route.test.ts`）: フラグ OFF の `server/discover` に events がない（legacy・modern）、フラグ ON の `server/discover` が `initialize` と同じ `capabilities`（`events: {}`）、modern の events/* が `reply()` の形、legacy の events/* は形が変わらない、不明なメソッドは modern で HTTP 404・legacy で HTTP 200（`-32601`）、フラグ OFF の modern の events/* は 404。
- 管理用 MCP（`/api/mcp/admin`）には events を出さない（D8）。#268 の管理用の `serverCapabilities()` は変えていない。

### 16.4 PR #269（`fix/mcp-nonstring-method-20261005`）

- 両方の MCP の route の method の読み取りの近くを 4 行ずつ変える。#267 より先に入るかもしれない。このブランチ（`ed1428a`）に試しに merge したところ（使い捨ての worktree）、**衝突なしで自動 merge できた**。#269 が先にマージされたら、main をもう一度通常の merge で取り込む。

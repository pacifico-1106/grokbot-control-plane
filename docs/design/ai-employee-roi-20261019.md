# AI 社員ごとに費用と仕事を並べ、ROI を判断できるようにする — 設計ドラフト（2026-10-19）

- **状態: ドラフト。** §8 は八坂さんの決定待ち。この PR は文書だけ
- 作成: 2026-10-19（実装・migration・設定・本番変更・マージはしていない）
- 対象コード: `pacifico-1106/grokbot-control-plane` `origin/main` `5ba18841`（`git fetch origin main` で確認）
- 読んだ参考: [Vercel AI Gateway logs now show session affinity](https://vercel.com/changelog/ai-gateway-logs-now-show-session-affinity)（2026-10-18）と [Session affinity 公式](https://vercel.com/docs/ai-gateway/models-and-providers/session-affinity)
- 既存の「費用」画面（`lib/dashboard-metrics.ts` / `lib/cost-demo.ts`）は **確定アクション（`gated_confirm_action`）の件数とプラン枠** であり、トークン代ではない。本書はそれと並べる **勤務記録** と **トークン代** の設計

> お客さんが知りたいのは「この AI 社員はいくらかかり、何をしたか」。Staffpass はいま仕事（起こし・操作・承認・送信・停止）をかなり持っている。トークン代は持っていない。先に仕事を会話単位で見せ、トークン代は取り方を決めてから足す。

---

## 0. 結論（推奨）

1. **いまのテーブルだけで、社員ごと・会話ごとに「何をしたか」は出せる。** ただし会話 ID はまだ無く、Slack の `thread_ts` / LINE の `conversationId` / `jobId` を後から束ねる。本文・宛先の生値は出さない（既存の監査マスキングと同じ）。
2. **トークン代は (a) 社員ごとの中継キー（Vercel AI Gateway 等）を本線にし、(b) MCP 自己申告は補助、(c) プロバイダ利用量 API は突合用。** Grok Bot のように顧客がモデル鍵を持たない経路は (a) か運営側の実測が要る。(b) だけでは改ざんできる。
3. **実装の優先は、緊急停止〜運営からのお知らせのあとに ① 勤務記録を差し込む。** ② トークン代は契約の自動化のあと。この設計 PR 自体は文書だけなので、実装キューを止めない。
4. **画面はテナントの owner / admin ＋ `view_audit`。** AI 社員自身の MCP からは集計を読ませない（改ざんと情報漏洩の両方）。フラグはすべて既定 OFF。
5. **集計クエリは必ず `org_id` を先に絞る。** 別 org の employee id を指定したら `not_found`（存在も漏らさない）。CSV も同じゲート。

---

## 1. 参考にした Vercel の Sessions ビュー（実読）

[Changelog 2026-10-18](https://vercel.com/changelog/ai-gateway-logs-now-show-session-affinity) と [Session affinity ドキュメント](https://vercel.com/docs/ai-gateway/models-and-providers/session-affinity) を読んだ内容。数字は作っていない。

| Vercel が会話ごとに出しているもの | Staffpass の対応 |
|---|---|
| セッション行（coding agent / アプリ名、費用、モデル、プロバイダ、入力のキャッシュ率） | 社員名・役割、トークン代（未所持）、使ったツール、承認結果。キャッシュ率は中継を入れないと出ない |
| セッションを開くとヒット率・時間・path（ターンごとのモデルとタイミング、担当プロバイダ） | 会話タイムライン（wake → invoke → 承認 → 送信 / 停止） |
| フィルタ（ターン数、client、model、provider、認証、費用）。1 ターンは最小ターン数を外すまで隠す | 期間・社員・結果（成功 / 承認待ち / 拒否 / 停止）。1 件だけの会話は既定で畳む案 |
| 明示 `sessionId`（`providerOptions.gateway.sessionId` または `x-session-id`）。無いと会話の冒頭の fingerprint | いまは明示 ID が無い。§3 で後付け束ね → 将来は wake 時点で振る |

Vercel 側の識別順（公式）: `sessionId` プロバイダオプション → `x-session-id` → `x-session-affinity` → `prompt_cache_key`（共有プレフィックス扱い） → `x-claude-code-session-id` → 冒頭メッセージ＋ツール定義の SHA-256 fingerprint（チーム ID 込み、本文は先頭 4096 文字まで）。**個人データを session ID に入れない。無関係な仕事で同じ ID を使い回さない。**

Staffpass が借りるのは「会話でまとめ、費用とキャッシュと誰が動いたかを 1 行にする」という見せ方だけ。プロンプト本文を Staffpass に置く理由にはしない（Vercel 自身も **プロンプト／応答はリクエスト完了後に保持しない**。[FAQ](https://vercel.com/docs/ai-gateway/faq)）。

---

## 2. ① 勤務記録 — いまあるデータだけで出せるもの

コードと migration を読んだ。動かしていない。本番は見ていない。

共通の読み方:

- **社員キー:** ほとんどの行に `employee_id`（uuid、`employees.id`）。無い行はテナント全体（org hold、一部の admin / billing）。
- **org キー:** 例外なく `org_id`（`orgs.id`）。無い業務テーブルは対象外（`slack_mention_events` は event_id の冪等だけ）。
- **会話キー:** 列としては無い。metadata の `thread_ts` / `channel` / `jobId` / LINE `conversationId` を後から束ねる。
- **保持日数:** `audit_events` に purge も `retention_until` も無い → **明示 retention なし（無期限）。** 画面の既定期間は 30 日、CSV も同じ。それより長い保持は八坂さん決定。

### 2-1. 項目ごとの出典

凡例: 「会話キー」は束ねに使える値。空欄は今は無い。

#### A. 起こし（wake）の回数ときっかけ

| 項目 | テーブル / イベント | 主なカラム | 出典ファイル | 社員キー | org キー | 会話キー | 保持 | 足りないもの |
|---|---|---|---|---|---|---|---|---|
| Slack メンション起こし | `audit_events.action = slack.mention_wake` | `employee_id`, `metadata.reason`（`woke` / `wake_failed`）, `channel`, `ts`, `thread_ts`, `eventId` | `lib/slack/mention-ingress.ts`（成功時 metadata は reason/channel/ts/thread_ts） | あり | あり | `thread_ts` または root の `ts` ＋ `channel` | 無期限 | 失敗行に channel/thread が無い。本文は意図的に無い |
| Slack 社内 1:1 | `slack.internal_im_wake` | 上に同じ。`purpose=slack.internal_im` | 同上 `postWake` | あり | あり | channel（D…）＋ ts | 無期限 | 相手の表示名は無い（U… も監査には載せていない） |
| Slack user-token IM | `slack.user_token_im_wake` | 上に同じ。`userTokenPath: true` | 同上 | あり | あり | 同上 | 無期限 | 同上 |
| Slack チャネル（user-token Path C） | `slack.user_token_channel_wake` / `_skipped` / `_rewake` | `buildUserChannelWakeAudit`: tokenSubject, channelId, classification, eventId, speakerId, mentionedIds, timestamp, woke, skipReason | `lib/slack/user-channel-ingress.ts`, `mention-ingress.ts` | あり（employee ブロック） | あり | channelId ＋ timestamp。thread_ts は skip/wake によって欠ける | 無期限 | skip 理由は豊富。会話の継続キーは弱い |
| LINE 1:1 | `line.conversation_wake` | `reason`, `accountId`, `eventKey`, `channel`（= conversationId）, `ts`（= eventKey） | `lib/comm/line-wake.ts`。フラグ `LINE_CONVERSATION_ENABLED` 既定 OFF | あり | あり | **`conversationId` 相当が既にある**（channel に入る） | 無期限 | 本文は wake 配送には載るが **監査には残さない**（C8） |
| 受電通知 | `inbound_notice.wake` / `sales_skipped` / `rejected` | ids ＋マスク電話。本文・要約は禁止 | `lib/inbound-notice/intake.ts`。フラグ `INBOUND_CALL_NOTICE_ENABLED` 既定 OFF | env の 1 社員 | あり | channel ＋ Slack ts（jobId もこれから生成） | 無期限 | 本番フラグ OFF |
| 承認結果で再起こし | `agent.approval_wake` | `metadata.approvalId` | `lib/mcp/endpoint-handoff.ts` `APPROVAL_WAKE_ACTION` | あり | あり | approvalId → jobId | 無期限 | 元会話への直接キーは approval 経由 |
| 停止中に起こさず | `employee.hold.wake_suppressed` | `reason`, `holdId`, `trigger` | `lib/comm/line-wake.ts`, `mention-ingress.ts`, `lib/safety/hold.ts` | あり | あり | きっかけ次第 | 無期限 | 「何件起こさなかったか」は出る。会話には属しにくい |
| Slack イベント冪等 | `slack_mention_events` | `event_id`, `received_at` | `supabase/schema.sql` | **なし** | **なし** | event_id のみ | 無期限（掃除なし） | org/社員が無いので ROI 集計に使わない |
| LINE 受信冪等 | `comm_inbound_events` | `account_id`, `org_id`, `event_key`, `received_at` | `supabase/migrations/20261013200000_employee_comm_accounts.sql` | account → employee | あり | event_key。本文なし | 無期限（掃除なし） | 回数の補助。会話本文は無い |
| スレッド既読点 | `thread_wake_points` | `org_id`, `employee_id`, `thread_key`（sha256）, `wake_micros` | `supabase/migrations/20261009150000_thread_single_flight_preflag.sql`。**30 日で掃除** | あり | あり | ハッシュのみ（channel 不明） | **30 日** | 画面のスレッド名には使えない |
| skipped Path C 再起こし台帳 | `slack_skipped_channel_wakes` | org, channel, approval, skipped_at | `supabase/migrations/20261009700000_slack_skipped_channel_wakes.sql` | あり | あり | channel | claim TTL 60s〜7 日 | 再起こしの有無だけ |
| AI 同士起こし | `ai_peer_wake_threads` / `slack.peer_wake.*` | org, team, channel, thread_ts, count | `supabase/migrations/20261016100000_ai_peer_wake_guard.sql`, `lib/slack/peer-wake-guard.ts` | 許可リストは from/to employee | あり | thread_ts。無ければ eventTs の時間窓（既定 1800s） | 無期限 | **時間窓束ねの既存実装がある**（`lib/data/ai-peer-wake.ts` `threadKeyFor`） |

W1（未返信）が見る起こし: `lib/data/audit.ts` の `STUCK_WATCH_WAKE_ACTIONS` = `slack.mention_wake`, `slack.internal_im_wake`, `slack.user_token_im_wake`, `line.conversation_wake`, `inbound_notice.wake`。**`slack.user_token_channel_wake` と `agent.approval_wake` は W1 対象外。** ROI の「起こし回数」は W1 より広く数える。

#### B. invoke の量

| 項目 | テーブル / イベント | 主なカラム | 出典ファイル | 社員キー | org キー | 会話キー | 保持 | 足りないもの |
|---|---|---|---|---|---|---|---|---|
| Gateway 完了（行為カウント） | `action_counters` | PK `(org_id, employee_id, period, tool)`, `count`, `updated_at`。`period` は JST `YYYY-MM` | `supabase/schema.sql`, `lib/data/action-counters.ts` | あり | あり | **なし** | 月次集計は残る。日次は audit 依存 | 会話・jobId が無い。ツール別月次だけ |
| 行為カウントの監査 | `audit_events` `tool.invoke` かつ `metadata.actionCounter=true` | `tool`, `jobId`, `period` | 同上 `incrementActionCounter`。確定完了と同じ境界 | あり | あり | **jobId あり** | 無期限 | 日次件数は audit を数える実装（インデックス不足） |
| invoke 全般（拒否含む） | `audit_events.action = tool.invoke` | `purpose`, `metadata.tool`, `jobId`, `code`, `approvalId`, `phase` | `lib/gateway/invoke.ts`（多数） | あり | あり | jobId。conversation はリクエストにあっても監査に必ずは残らない | 無期限 | 成功と拒否が同じ action。`code` / summary で分ける |
| MCP ツール名 | 同上 ＋ labels | `staffpass_invoke` 等 | `lib/mcp/tools.ts`, `lib/audit/labels-ja.ts` | あり | あり | jobId | 無期限 | トークン数は無い |
| 確定アクション課金 | `audit_events.metadata.type = gated_confirm_action` | `tool`, `jobId`, `billable` | `lib/billing/meter.ts`。**Grok トークン再販はしない** と明記 | あり | あり | jobId | 無期限 | トークン代ではない。プラン枠（starter 50 / business 500 / managed 2000） |
| 行為上限 | `action_limit.reached` / `action_limit.denied` | `tool`, `jobId`, `limit`, `counts` | `lib/gateway/invoke.ts` | あり | あり | jobId | 無期限 | 「上限で止まった」は成果のマイナス指標になる |
| MCP クライアント生存 | `mcp.client_seen` | credential 世代 | `lib/mcp/endpoint-handoff.ts` | あり | あり | なし | 無期限 | 仕事ではなく接続の心拍 |

`listAuditEvents` の既定 limit は **100**（`lib/data/audit.ts`）。stuck-watch は 500。ROI の月次はこれでは足りない。専用の org 絞り込みクエリが要る。`audit_events` の索引は `(org_id, created_at desc)` のみ。**`(org_id, employee_id, created_at)` は無い。**

#### C. 承認の申請と結果

| 項目 | テーブル / イベント | 主なカラム | 出典ファイル | 社員キー | org キー | 会話キー | 保持 | 足りないもの |
|---|---|---|---|---|---|---|---|---|
| チケット | `approval_requests` | `id`, `org_id`, `employee_id`（管理MCPは NULL 可）, `purpose`, `summary`, `title`, `tool`, `job_id`, `risk`, `status`, `metadata`, `created_at`, `resolved_at` | `supabase/schema.sql`, `lib/data/approvals.ts` | 社員チケットはあり | あり | **job_id**（索引 `approval_requests_job_idx`） | 無期限 | `summary` に下書き本文が入りうる。ROI 画面では出さない |
| 申請監査 | `approval.requested` | `approvalId`, `jobId`, `tool` | `lib/data/approvals.ts` | あり | あり | jobId | 無期限 | |
| 確定 / 修正 / 期限 / 置換 | `approval.resolved` / `revision_requested` / `expired` / `superseded` | status, resolved_by | 承認 resolve / fulfill | あり | あり | jobId | 無期限 | 承認者メールは表示時マスク（`lib/audit/actor.ts`） |
| 合議 | `approval_workflow_instances` / `ballots` | org, approval | `supabase/migrations/20260916_approval_workflow.sql` | 間接 | あり | approval_id | 無期限 | 会話キーは approval 経由 |
| 添付 | `approval_mail_attachments` ＋ `approval.attachment_*` | ファイル名とサイズ。本文・暗号文は公開 DTO から除去 | `20261015100000_approval_mail_attachments.sql`, `lib/data/redaction.ts` | 間接 | あり | approval | 無期限 | ROI は「添付あり」フラグまで |

#### D. 社外への送信

| 項目 | テーブル / イベント | 主なカラム | 出典ファイル | 社員キー | org キー | 会話キー | 保持 | 足りないもの |
|---|---|---|---|---|---|---|---|---|
| Slack 投稿成功 | `slack.posted` | `channel`, `thread_ts`, `ts`, `jobId`, `approvalId`, `destKind`, `phase` | `lib/approvals/fulfill.ts` | あり | あり | **channel ＋ thread_ts / ts** | 無期限 | 本文なし。宛先はチャネル ID |
| Slack / LINE 失敗・未送信 | `slack.post_failed`, `line.post_failed`, `comm.not_sent`, `line.conversation_target_mismatch` | `code`, `sent:false` | `lib/gateway/invoke.ts`, fulfill | あり | あり | jobId | 無期限 | 「送っていない」は成果から除外する |
| メール送信 | `email.sent`、ツール `mail.send` / `agentmail.send` | 宛先はポリシー判定のラベル。生メールは監査表示でマスク | `lib/audit/mask.ts`, mail-policy | あり | あり | jobId / スレッドヘッダは invoke 側 | 無期限 | ROI はドメインまたは「社外 N 通」まで |
| SNS | `sns.publish_failed` およびツール `sns.publish` | | gateway | あり | あり | jobId | 無期限 | 成功 action が独立していない。tool.invoke 成功を見る |
| Drive 社外共有 | ツール `drive.share_external` | | gateway | あり | あり | jobId | 無期限 | |
| 重複抑制 | `comm_reply.duplicate_suppressed` 等 | ハッシュのみ | `lib/comm-reply-dedup/guard.ts`。retention 最大 30 日（2592000s） | あり | あり | スレッド | 台帳は最大 30 日 | 「無駄打ちを止めた」件数 |

社外判定そのものは `lib/gateway/audience.ts` の WHO。監査に `audience` が入る行と入らない行がある。ROI の「社外送信」は **ツール ID の allowlist**（`mail.send`, `slack.post_external`, `drive.share_external`, `sns.publish`, LINE 社外）で数え、曖昧な行は「判定不能」にする（fail-closed）。

#### E. 緊急停止

| 項目 | テーブル / イベント | 主なカラム | 出典ファイル | 社員キー | org キー | 会話キー | 保持 | 足りないもの |
|---|---|---|---|---|---|---|---|---|
| 停止履歴 | `employee_holds` | `kind`（stopped/leave/quarantined）, `employee_id`（NULL なら org 全体）, `started_by/via/at`, `released_*`, `reason`（≤500、社内向け） | `supabase/migrations/20261012500000_employee_holds.sql` | 社員または org | あり | **なし** | 無期限（追記のみ） | 会話に紐づかない。タイムラインには「この時刻から停止」を重ねる |
| 監査 | `employee.hold.started` / `release_requested` / `released` / `ai_refused` / `start_failed` | holdId, via, startedBy。**reason は metadata に無い**（QA `docs/qa/org-hold-retest-tokyo307-20261016.md`） | `lib/safety/hold-actions.ts`, `hold-store.ts` | 社員停止はあり。org 停止は employee_id NULL | あり | なし | 無期限 | 画面に理由全文を出さない（社内メモ） |

#### F. そのほか（stuck / config_change / decision / 認証）

| 項目 | テーブル / イベント | 主なカラム | 出典ファイル | 社員キー | org キー | 会話キー | 保持 | 足りないもの |
|---|---|---|---|---|---|---|---|---|
| 停滞通知・再試行 | `stuck_watch.w1_notify`, `w2_retry`, `w4_notify`, `retry`, `resolve`, `audience_ledger_retry` | wake / approval id | `lib/stuck-watch/*` | あり | あり | wake の thread または approval | 無期限 | 「停滞した仕事」は ROI のマイナス |
| 設定変更依頼 | `config.change_requested` / `applied` / `rejected` / `refused` / `apply_failed` | `jobId`, conversation.slackChannelId / threadTs | `lib/config-change-request/service.ts`。本体は `approval_requests` | あり | あり | threadTs があれば使える | 無期限 | 指示文本文は approval.summary に入りうる → 画面に出さない |
| 判断（稟議） | `decision_requests` ＋ `decision.requested/resolved/expired` | `job_id`, `tier`, `amount_jpy`, `status` | `supabase/migrations/20260930000200_decision_workflow.sql`。フラグ `P1_DECISION_WORKFLOW_ENABLED` | あり（NULL 可） | あり | job_id | 無期限 | 金額は成果の候補。議事録本文は ROI に出さない |
| 社員証発行 / 失効 / 再発行 | `credentials` ＋ `credential.issued/revoked/rotated/expiry_notice` | `secret_hash` のみ。生秘密なし。`last_used_at` | `supabase/schema.sql`, `lib/employees/credential-reissue.ts` | あり | あり | なし | 無期限 | ハッシュと prefix だけ。ROI は「再発行した」件数 |
| OAuth 同意 | `oauth.consent_*`, `oauth.token_issued`, reuse 検出 | host と hash prefix | `lib/mcp-oauth/*`。migration `20261010200000_mcp_oauth.sql` | 間接 | クライアントは org | なし | トークン行は短命 | 接続の有無。会話ではない |
| MCP 認証失敗 | `mcp_auth_failures` | kind, org, employee, throttle_bucket（5 分） | `20261016400000_mcp_auth_failures.sql` | あり（NULL 可） | あり | なし | 無期限（掃除なし） | 秘密列なし |
| MCP Events 配送 | `mcp_event_deliveries` | org, employee, approval_id, status | `20261005000000_mcp_event_subscriptions.sql` | あり | あり | approval | **完了行 7 日で削除** | ROI の長期集計には使えない |
| 秘密検出 | `secret_detection.blocked` / `suspected` | 種類のみ | `lib/security/secret-detection-audit.ts` | あり | あり | jobId | 無期限 | 値は出さない |
| Webhook 秘密の発行 | `employee.webhook_secret_minted` / `payload_mode_set` | mode のみ | `app/api/employees/[id]/webhook-signing/route.ts` | あり | あり | なし | 無期限 | |

### 2-2. 会話のまとめ方（案）

いま会話の第一級 ID は無い。Vercel が sessionId → fingerprint の順で束ねるように、Staffpass も **明示キーを優先し、無ければ後付け** にする。

**後付け（① の実装。既存行を読むだけ）**

1. **Slack:** `metadata.thread_ts` があればそれを会話キー。無ければそのチャネルの root `ts`（メンション自身）。Peer wake と同じ（`lib/data/ai-peer-wake.ts` `threadKeyFor`）。
2. **LINE:** `metadata.channel`（wake が conversationId を入れている）または会話札の conversationId。
3. **メール:** 将来は `inReplyTo` / `gmailThreadId`。いまの監査には安定して残っていない → ① では jobId 単位。
4. **ジョブ:** 同じ `org_id` ＋ `employee_id` ＋ `jobId` は 1 会話に畳む（承認の親子 `parent_approval_id` も含む）。
5. **隙間:** 1〜4 がどれも無い連続した audit は、同一社員・同一 channel（無ければ tool）で **30 分空きで区切る**（peer wake の 1800s に合わせる）。1 件だけの塊は既定で一覧から畳む（Vercel の min turns）。
6. **停止:** hold は会話に属させず、タイムラインに帯で重ねる。

**将来の第一級 ID（② の前に入れるのがよい）**

- 形式: `conv_` ＋ Crockford ULID（運営お知らせの `ntc_` と同じ考え方。ES2017）。**個人データ・channel 名・メールを入れない**（Vercel の session ID 注意と同じ）。
- **振る場所:** wake 配送の直前（`postWake` / `dispatchLineConversationWake` / `agent.approval_wake`）。起こしていない手動 invoke は、Gateway が jobId と conversation コンテキストから **初回だけ** 振る。
- **伝える場所:**
  - wake JSON（既存の MCP handoff ブロックの隣）
  - `staffpass_invoke` の引数 `conversationId`（無ければサーバーが後付け。あっても **org × 社員が一致しない ID は無視して fail-closed**）
  - `approval_requests.metadata.conversationId`
  - `audit_events.metadata.conversationId`
  - 中継を使うなら同じ値を `x-session-id` に載せる（§4）
- フラグ: `ROI_CONVERSATION_ID_ENABLED`（既定 OFF）。OFF なら後付け束ねだけ。

### 2-3. テナント管理者向け画面案

既存ナビは `/app` 変更ログ、`/app/approvals` 承認、`/app/audit` 閲覧（`lib/dashboard/nav.ts`）。**新しい第一ナビは足さない。** `/app/employees` の一覧と、社員詳細にタブを足す。既存 `/app/audit`（#373/#374）は生タイムラインのまま残す。

権限: `view_audit`（`lib/team/rbac.ts`。owner / accounting / legal / ops_ai の既定パックに含まれる。sales / admin_affairs は無い）。**owner 役割だけでは足りない。** サーバーは `requireCapability("view_audit")`。フラグ OFF なら 404。

期間: 既定 7 日。選択肢 1 / 7 / 30 日（JST）。カスタムは ① ではやらない（CSV も同じ）。

#### 一覧（`/app/employees` に列を足す、または `/app/employees?tab=roi`）

```
期間 [7日 v]  社員 [全員 v]          [CSV]

社員          起こし  invoke  承認   承認OK  社外送信  停止  確定課金  トークン代
営業AI社員      42     110    18      15       4      0     12件     実測 $1.20
事務AI社員      11      40     6       6       1      1      4件     申告 $0.40（低）
────────────────────────────────────────────────────────────────
合計            53     150    24      21       5      1     16件     混在（注記）
```

| 列 | 中身 | 出さないもの |
|---|---|---|
| 起こし | reason=woke の件数。きっかけ内訳は詳細へ | 本文、発言者名 |
| invoke | `tool.invoke` ＋行為カウント。内訳はツール別 | プロンプト |
| 承認 | requested / 結果内訳 | summary 本文、宛先メール全文 |
| 社外送信 | §2-1 D のツール allowlist かつ sent | 宛先、本文 |
| 停止 | 期間中に open だった hold 時間 | 停止理由本文 |
| 確定課金 | `gated_confirm_action` 件数（既存メーター） | 円にしてトークン代と足さない |
| トークン代 | ② が来るまで「未計測」。来たら §4-4 のラベル | プロンプト |

#### 社員詳細（会話タイムライン）

```
営業AI社員  7日                         [CSV この社員]

 起こし 42  / 承認OK 15  / 社外 4  / 停止 0
 トークン代  実測 $1.20（Gateway・高）  キャッシュ 41%（Gateway）

会話（新しい順。1件だけの会話は隠す [表示]）
┌ Slack #sales  thread 1739…  2h  ターン 6  費用 $0.40  キャッシュ 62%
│  10:02  起こし  メンション
│  10:03  invoke  comm.reply     承認待ち
│  10:11  承認    承認する（a***@co.jp）
│  10:11  送信    Slack 投稿     成功
│  10:18  invoke  mail.send      拒否（社外ポリシー）
└
┌ LINE 1:1  conv_…  18m  ターン 3  費用 未計測
│  11:40  起こし  LINE
│  11:41  invoke  comm.reply     自動（社内）
│  11:41  送信    LINE           成功
└
帯: 昨日 18:00–18:12  緊急停止（組織全体）
```

ASCII ではなく表でも同じ情報。ターン = wake または invoke。Vercel の path に相当するのはこの縦の行。

#### CSV

- 一覧 CSV: 上の列。org_id は出さない（ファイルが外れても explorable なテナント ID を増やさない）。社員は display_name ＋ 内部 id。
- 会話 CSV: 会話キー（opaque）、開始/終了 JST、件数、ツール内訳、承認結果、トークン代と出典ラベル。
- **本文・宛先・statusToken・生メール・LINE userId 全文は列にしない。** 画面と同じ `sanitizeAuditDisplayText` / `maskEmail` / `opaqueAuditId`。
- 上限: 1 エクスポート 10,000 行。超えたら期間を狭める。フラグ `ROI_CSV_EXPORT_ENABLED`。

#### 個人情報をどこまで見せるか（既存方針に合わせる）

| 種類 | 既存 | ROI 画面 |
|---|---|---|
| メール | `a***@domain`（`lib/audit/mask.ts`）。1 文字ローカルは `*@domain` | 同じ。CSV も同じ |
| poll URL / statusToken | `[redacted]` | 出さない |
| 承認 summary | `/app/audit` は 80/200 文字に切ってサニタイズ | **ROI では出さない。** ツール名と結果だけ（下書き本文が入りうるため） |
| Slack 本文 | 監査に保存しない。handoff の bodyMode はメタのみ | 出さない |
| LINE 本文 | C8。audit に残さない（`line-wake.ts` コメント） | 出さない。会話 ID だけ |
| 電話 | 受電は下 4 桁または HMAC（inbound-call 設計） | 下 4 桁まで |
| チャネル ID | C… / D… は opaque として可 | 可。ワークスペース名は org 内だけ |
| 社員証・中継キー | 発行時一度きり。チャット貼付禁止 | **画面・CSV・ログに出さない** |
| プロンプト / 応答 | データ取扱い概要: 常時保存を必須としない | Staffpass に持たない |

---

## 3. ② トークン代 — 取り方 3 つ

比較の前提: Staffpass はいまトークンを数えていない（`lib/billing/meter.ts`「No Grok token resale」）。LP 相談チャットだけがターンの usage を持つ（テナントの AI 社員とは別）。

### 3-1. 比較

| 観点 | (a) 社員ごと専用キー＋中継（AI Gateway 等） | (b) エージェントが MCP で自己申告 | (c) プロバイダ利用量 API を取り込む |
|---|---|---|---|
| **安全性** | 中継キーを Staffpass が預かり、社員ごとに発行・回転・失効。漏れたときの範囲はその社員。緊急停止でキー無効化と組み合わせられる。中継が探られると **そのキー経由の全リクエストメタ**（モデル・トークン・費用）が見える。プロンプトは中継側ポリシー次第 | **改ざんできる。** 過少申告で ROI を良く見せられる。鍵はエージェント側。Staffpass に新鍵は増えない。上限と署名が無いと監査に使えない | 顧客または運営の **管理キー** が要る（通常の推論キーより権限が広い）。漏れたときの範囲はチーム全体の利用量・請求。社員単位に割るにはキーを社員ごとにするかタグが要る |
| **データの扱い** | Vercel AI Gateway は **プロンプト／応答を保持しない**（完了後削除）。ログは status / model / provider / tokens / cost / duration / 認証 / ルーティング。ルーティング詳細 **30 日**。[FAQ](https://vercel.com/docs/ai-gateway/faq)。上流プロバイダの学習・保持は別問題。ZDR はチーム広域が **$0.10 / 1,000 リクエスト**（Pro/Enterprise）。[Pricing](https://vercel.com/docs/ai-gateway/pricing) | Staffpass はトークン数・モデル・キャッシュ率・費用だけ受け取る規約にできる。本文は受け取らない（受け取ったら拒否）。エージェント側ログは Staffpass の管轄外 | 利用量 API は通常トークンと金額。プロンプトは来ない。管理コンソール側に本文ログがある製品は別（Gemini Logs は有料プロジェクトで有効化できる。[Logs](https://ai.google.dev/gemini-api/docs/logs-datasets)）— Staffpass はそれを取り込まない |
| **料金への影響** | Vercel: トークンは **プロバイダ提示価格、マークアップなし、プラットフォーム手数料なし**（BYOK も同じ）。支払い処理手数料は別。Credits は購入から 1 年で失効。[Pricing](https://vercel.com/docs/ai-gateway/pricing) [FAQ](https://vercel.com/docs/ai-gateway/faq)。キャッシュヒットはプロバイダの cache-read 単価。Custom Reporting は write **$0.075 / 1,000**、query **$5 / 1,000**。Trace Drain は **$0.05 / 1,000 traces** ＋ egress **$0.50 / GB**（プロンプトは含まない） | Staffpass 側の追加料金は無し。キャッシュ率はエージェントが正しく返せば見えるが、検証できない | API 自体の料金は各社ドキュメント上 **未確認**（無料の管理 API が多いが、呼び出し上限は未確認）。BigQuery 請求エクスポート等は GCP 側課金あり |
| **手間** | 運営が中継アカウントを持つ、または顧客 BYOK。社員発行時にキーを mint。エージェントの base URL を中継に向ける。Grok Bot は顧客がモデル鍵を持たないので **向き先を運営が指定できるか** が前提 | MCP ツール 1 本と検証ルール。エージェント実装が要る。Cursor / Claude / ChatGPT / 自社はそれぞれの拡張が要る。未対応エージェントは空欄 | プロバイダごとにコネクタ。キーの対応表。遅延（Gemini の Cloud Billing は **最大 1 日超**。[Billing](https://ai.google.dev/gemini-api/docs/billing)）。会話単位には落ちない（日次バケットが多い） |
| **Grok Bot 以外** | 中継が OpenAI 互換 / Anthropic 互換を出せば Claude Code・Cursor・Codex は base URL を向けられる（Vercel は「coding agents を向けられる」と [FAQ](https://vercel.com/docs/ai-gateway/faq)）。ChatGPT の UI 経路は **未確認**。自社エージェントは HTTP を向けられる | プロトコルさえ実装すれば誰でも。鍵をお客が持たない Grok Bot は、Bot 本体が usage を返す必要がある（Staffpass だけでは測れない） | OpenAI: 顧客が組織 Admin キーを持つ場合のみ。[Costs](https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage/methods/costs/) は `group_by=api_key_id` 可。Anthropic Admin: [Usage and Cost](https://platform.claude.com/docs/en/manage-claude/usage-cost-api)。Claude Code は別エンドポイント（日次・ユーザー単位）。[Analytics](https://platform.claude.com/docs/en/manage-claude/claude-code-analytics-api)。xAI: 応答に `usage.cost_in_usd_ticks`。[Cost Tracking](https://docs.x.ai/developers/cost-tracking)。履歴は Management API `POST /v1/billing/teams/{team_id}/usage`。[Billing](https://docs.x.ai/developers/rest-api-reference/management/billing)。**Grok Bot の裏側キーをお客が持たない場合、お客の (c) は使えない。** Cursor / ChatGPT の利用量 API は **未確認**。Gemini に専用 Billing API は無く Cloud Billing / AI Studio。[Billing](https://ai.google.dev/gemini-api/docs/billing) |

### 3-2. 公式で確かめたこと / 未確認

確かめた（URL 付き）:

- Vercel トークン無マークアップ、プロンプト非保持、ログ 30 日、session affinity の識別順と Sessions ビュー
- Vercel キーは社員（というより key）単位の budget を付けられる。[Budgets](https://vercel.com/docs/ai-gateway/observability-and-spend/budgets) [API Keys](https://vercel.com/docs/ai-gateway/authentication-and-byok/api-keys)
- OpenAI 組織 Costs API（Admin キー、日次、`api_key_id` で group）
- Anthropic Usage/Cost Admin API、Claude Code 日次 Analytics
- xAI はリクエストごとの `cost_in_usd_ticks`（1 USD = 10^10 ticks）と Management の usage
- Gemini は AI Studio Usage と Cloud Billing。専用の Gemini Billing API は公式ページに無い

未確認（数字も「ある/なし」も断定しない）:

- ChatGPT（chatgpt.com / Team）のプログラム利用量 API
- Cursor のプログラム利用量 API（フォーラム上は Cursor 課金と Anthropic 個人枠は別、という説明があるが Staffpass の根拠にはしない）
- Grok Bot が顧客テナントごとに xAI キーを分けているか、usage を返す MCP があるか
- Vercel Custom Reporting を Staffpass から呼ぶときの認証と保持期間の詳細
- 中継を「探られたとき」の SOC / 契約上の責任分界（営業資料に書かない）
- Anthropic / OpenAI Admin API の料金（呼び出し課金の有無）

### 3-3. 自己申告と実測を並べるとき

同じセルに足し算しない。列を分ける。

| 表示 | 意味 | 信頼度 |
|---|---|---|
| **実測（中継）** | Gateway ログ / Trace の cost。ラベル `source=gateway` | 高 |
| **実測（プロバイダ）** | Admin/Management API。ラベル `source=provider`。粒度が日次なら会話に按分しない | 高（ただし社員割当が雑なら「中」） |
| **申告** | MCP `staffpass_usage_report`。ラベル `source=self` | 低。改ざん可 |
| **未計測** | どれも無い | — |

ルール:

- 実測がある日は申告を **参考列** に置き、差が閾値（推奨: 申告が実測の 2 倍超、または 50% 未満）なら「ずれ」バッジ。
- 申告だけの期間は合計行に「自己申告を含む」と出す。オーナー向けの請求には使わない。
- 上限: 1 申告あたりトークン上限（推奨: input+output 2,000万、1 会話 1 日）。超えたら拒否して `usage.report_rejected`。負数・未来時刻・他社員 ID は拒否。
- 本文・completion テキストを付けてきたら **フィールドごと捨てる**（秘密検出と同じ）。

### 3-4. 推奨（段階）

1. **① 勤務記録だけ先に出す**（トークン列は「未計測」）。お客は仕事量で ROI の議論を始められる。
2. **(b) を狭い MCP で足す。** 検証と上限つき。Grok Bot / Cursor が実装してくれたら埋まる。信頼度は低のまま。
3. **(a) を本線にする。** 社員ごと Gateway キー（または同等の中継）。`conversationId` を `x-session-id` に載せる。Sessions 相当（費用・キャッシュ率・モデル）が会話行に乗る。Grok Bot は向き先を運営が指定できる場合のみ。できない場合は運営が (c) 相当の xAI Management をテナント割当する（鍵の対応表が要る。未確認な点は実装前に再調査）。
4. **(c) は突合。** お客が Admin キーを預ける経路は任意。BYO の Claude / OpenAI 顧客向け。Grok Bot 専用テナントには使わない。

中継先を Vercel に固定するかは八坂さん決定。OpenRouter 等は本 PR では調べていない（未確認）。

---

## 4. ③ 優先順と PR の分け方

与えられた今の順:

**緊急停止 → H1/H5 → #228 → LINE PoC → 運営からのお知らせ → パスキー → 契約の自動化 → 5 箇条の残り → LINE WORKS**

（#228 はマージ済み・フラグ既定 OFF。H1/H5 のコード修正 #351/#352/#357 もマージ済み。緊急停止 S1–S3 はマージ済み・`EMPLOYEE_HOLD_ENABLED` 既定 OFF。残っているのはフラグ ON・本番適用・二人解除試験・S4 運営二人解除など。）

### 4-1. どこに入れるか（推奨）

| 塊 | 入れる位置 | 理由 |
|---|---|---|
| この設計 PR | **今すぐ並列。** キューをずらさない | 文書だけ |
| ① 勤務記録（読み取り＋画面） | **運営からのお知らせの直後** | 週次ダイジェスト（`OPS_WEEKLY_DIGEST_ENABLED`、PR-A で定義のみ）と同じ「期間集計を admin が読む」面。社員台帳（5 箇条の残り）より先に、いまの `employees` で足りる |
| 会話 ID を振る | ① の次、パスキーより前 | ② の sessionId に使う。パスキーは認証の話で独立 |
| ② トークン代 (b) 自己申告 | ① の直後でも可 | 鍵を増やさない。ただし信頼度低 |
| ② トークン代 (a) 中継キー | **契約の自動化のあと** | 請求・Credits・誰が払うかが固まってから。緊急停止のキー無効化（本番 ON）が前提 |
| ② (c) 突合 | 5 箇条の残りと並行可 | BYO 顧客向け。Grok Bot 必須ではない |
| 社員台帳との重なり | 5 箇条の残りで台帳が厚くなったら、ROI 詳細の「相手」列だけ合流 | 新しい台帳を ROI のために作らない（音声設計と同じ） |

LINE WORKS より前。音声リアルタイム（LINE PoC フラグ ON 後）とも独立。ただし会話 ID の形は合わせておく。

### 4-2. 実装 PR 案（すべてフラグ既定 OFF）

日数は森の作業日数目安。レビューと手戻りは入れてない（LINE / 5 箇条メモと同じ）。

| PR | 内容 | 規模 | フラグ | 本番作業 |
|---|---|---|---|---|
| 本 PR | 本設計メモ ＋ `docs/README.md` 索引 | 文書のみ | なし | **なし。適用しない** |
| ROI-1 | 勤務記録の読み取り（org 必須の集計 SQL またはサーバー集計）。一覧列。フラグ OFF なら UI 非表示 | 3 日 | `ROI_WORKLOG_ENABLED` | migration が要るなら **未適用のままマージ**（お知らせ PR-A と同じ）。索引 `(org_id, employee_id, created_at)` を足す場合は八坂さんのカード |
| ROI-2 | 社員詳細の会話タイムライン（後付け束ね ＋ 30 分空き）。1 ターン会話の折りたたみ | 3 日 | 同じ `ROI_WORKLOG_ENABLED` または `ROI_CONVERSATION_VIEW_ENABLED` | なし（読み取り） |
| ROI-3 | CSV（上限・同じマスク）。監査 `roi.csv_exported`（誰が・期間・行数。中身は残さない） | 1.5 日 | `ROI_CSV_EXPORT_ENABLED` | なし |
| ROI-4 | `conv_` を wake / invoke / approval に載せる。OFF なら振らない | 2.5 日 | `ROI_CONVERSATION_ID_ENABLED` | なし（列を metadata に足すだけなら migration 不要。専用列にするなら未適用 migration） |
| ROI-5 | MCP 自己申告 `staffpass_usage_report`。上限・検証・信頼度ラベル | 2.5 日 | `ROI_USAGE_REPORT_ENABLED` | なし。エージェント側の実装は別リポジトリ |
| ROI-6 | 中継キー（社員ごと mint、暗号化保管、回転、hold で disable）。画面に秘密を出さない | 5 日 | `ROI_GATEWAY_KEYS_ENABLED` | 中継アカウント、Credits、KMS/暗号化キー。**本番キー発行は八坂さん GO 後** |
| ROI-7 | Gateway ログ取り込み（会話費用・キャッシュ率）。`x-session-id` = conv_id | 3 日 | `ROI_GATEWAY_INGEST_ENABLED` | 取り込み用トークン。ログ保持は中継側 30 日に依存 |
| ROI-8 | プロバイダ利用量の突合（OpenAI Admin / Anthropic Admin / xAI Management）。日次 | 4 日 | `ROI_PROVIDER_USAGE_ENABLED` | 顧客または運営の管理キー預かり。Gemini は本段階ではやらない（Billing API なし） |

ROI-1〜3 は 運営からのお知らせ の週次と **同じ集計ヘルパー** を使う（org 絞り、期間 JST、存在隠蔽）。お知らせ側の週次が遅れたら ROI-1 が先にヘルパーを置いてよい。

---

## 5. セキュリティ指針（監査報告書ではなく、作るときの守り）

形式は「こう作る」。チェックリストではない。

### 5-1. テナント分離

| 面 | 守り |
|---|---|
| 集計クエリ | **最初の WHERE は `org_id = session.org_id`。** employee_id だけでの検索禁止。service_role は RLS を迂回するので、アプリのクエリが唯一の壁（既存の `listAuditEvents` と同じ） |
| RLS | `audit_events` は `audit_select` が `is_org_member(org_id)`。**メンバーなら org 内全行が読める。** admin 限定は RLS では無い。ROI は capability で閉じる。新しい集計テーブルは RLS ON・ポリシーなし・anon/authenticated 権限なし・service_role のみ（holds / operator_notices と同じ） |
| キャッシュ | キーに org_id を入れる。共有 CDN に CSV を載せない。HTTP キャッシュしない（`force-dynamic`） |
| CSV | 生成はサーバー。署名付き短命 URL でも org を再確認。別 org のファイル名を推測できても 404 |

別 org の agent id を指定したとき: **`not_found`。** 存在するかどうかも返さない（お知らせ PR-A、credential reissue の `employee_not_found` と同じ）。デモモードは自 org のシードだけ。

### 5-2. 秘密情報（社員ごとの中継キー）

- **置き場:** `employee_binding_secrets` / `employee_comm_account_secrets` と同じ AES-256-GCM（`NOTIFICATION_CONFIG_ENCRYPTION_KEY`、AAD に employee＋org）。平文列を作らない。Admin MCP は受け取らない（H5: `secret_argument_refused`）。
- **古い鍵:** 回転は「新キー有効化 → エージェントが使い始めたら旧キー revoke」。猶予を持つなら `previous_*` ＋ `valid_until`（MCP Events 購読の形）。期限後に ciphertext を上書き（残さない）。
- **ログと画面:** prefix（例 先頭 4 文字）以外出さない。`redactMetadata` の sensitiveKeys にキー名を足す。CSV 禁止。
- **漏れたとき:** 緊急停止（その社員）と **同時に中継キー disable**。停止が成功してキー無効化が失敗したら `hold.start` は戻さない（切断失敗と同じ。知らせる）。キーだけ先に殺してもよい（推論は止まる。Staffpass の承認ゲートは別）。
- **発行 UI:** いまの社員証と同じ。人がダッシュボードで一度だけ見る。チャットに貼らない。

社員証 `gb_emp_` 自体はトークン代のキーではない。混ぜない。

### 5-3. 自己申告の上限と検証

- 認証は既存社員証。他社員への付替は拒否。
- 数値: 整数、0 以上、上限あり。モデル名は allowlist または opaque 80 文字。
- 同じ conversationId ＋ 同じ window の重複は冪等。
- 実測があるのに申告だけ大きい／小さいときは「ずれ」。自動で実測を上書きしない。
- 失敗は fail-closed（その申告を集計に入れない）。

### 5-4. 誰が読めるか

| 主体 | 勤務記録 | トークン代 |
|---|---|---|
| owner / admin で `view_audit` | 可 | 可 |
| `view_audit` だけの経理・法務 | 可（推奨: 同じ） | 可。CSV も可 |
| 一般メンバー | 不可 | 不可 |
| AI 社員（MCP） | **不可**（誰ami に件数を足さない。お知らせの未読件数とは別） | 不可。自分の申告ツールは **書くだけ** |
| 運営 `/admin` | テナント指定の既存 super-admin 経路のみ。全テナント横断の「全社 ROI」はこの設計の外 | 同じ |

AI 社員が自分の ROI を読むと、プロンプトに他会話のメタが入り、過少申告の動機にもなる。

### 5-5. fail-closed

- フラグ OFF: 新テーブルを読まない、新ツールは「無効」、画面 404。
- org が取れない / hold 状態が読めない / 中継ログが取れない: 空の成功を作らず、そのブロックを「不明」にする。トークン代の欠測を 0 円にしない。
- 会話 ID の org 不一致: 無視して新規に振り直さない（取り違え防止）。リクエストを拒否する。
- 社外送信の判定不能: 社外件数に入れない（過大に成果を盛らない）。

---

## 6. 既存コードへの影響（実装時。本 PR では触らない）

- 読み取り専用の集計を `lib/roi/` に新設する想定。`listAuditEvents(limit=100)` を流用しない。
- `/app/audit` のプレゼンテーション（#374）は維持。ROI は別ビュー。
- ダッシュボードの「費用」タブ（確定アクション）は残す。トークン代と足し算しない。ラベルを「確定アクション」のままにする。
- 音声・LINE の本文非保存（C8）を破らない。

---

## 7. この PR でやらないこと

- コード、migration、設定、フラグ追加、本番適用
- マージと force-push
- 中継アカウントの契約、Credits 購入、管理キーの預かり
- エージェント（Grok Bot / Cursor 等）側の実装
- 全テナント横断の運営ダッシュボード
- トークン単価の表を Staffpass にハードコードすること（未確認の数字を作らない）

---

## 8. 八坂さんに決めてもらうこと（推奨つき）

| # | 決めること | 推奨 |
|---|---|---|
| 1 | ① 勤務記録を、運営からのお知らせの直後に実装してよいか | **よい。** 週次集計と同じ読み取り面。緊急停止や H1/H5 の「コード」は入っている。フラグ ON は別カード |
| 2 | トークン代の本線は (a) 中継か | **(a)。** (b) は補助、(c) は BYO 突合。Grok Bot でお客が鍵を持たない経路は (a) か運営実測しか無い |
| 3 | 中継先を Vercel AI Gateway にしてよいか | **第一候補にしてよい**（無マークアップ、本文非保持、Sessions、キー予算が公式）。契約と日本のデータ所在は別途。他社は未調査 |
| 4 | Grok Bot の推論費用は誰が払うか（運営の Credits をテナント請求に乗せる / お客 BYOK / 当面出さない） | **当面 ROI 画面は「未計測」でも出す。** 請求に乗せるなら契約の自動化のあと |
| 5 | 集計を読める人 | **`view_audit` のみ。** AI 社員の MCP からは読ませない。経理パックは既に view_audit あり |
| 6 | 画面の既定期間と audit の retention | **画面 7 日既定、最大 30 日。** `audit_events` の purge はこの案件で始めない（無期限のまま）。変えるなら法務と別カード |
| 7 | CSV を出すか | **出す（フラグ OFF）。** マスクは画面と同じ。10,000 行上限 |
| 8 | 承認 summary / 宛先を ROI に出すか | **出さない。** ツールと結果と opaque ID だけ |
| 9 | 会話 ID をいつ振るか | **① の次（ROI-4）。** 中継の sessionId に使う |
| 10 | 自己申告を顧客向け合計に含めるか | **含めない。** 参考列。実測が無い社員は「未計測」 |
| 11 | 別 org の employee id | **not_found（存在も隠す）** |
| 12 | 漏えい時は緊急停止とキー無効を同時にするか | **同時。** 停止成功を優先し、キー無効化失敗は知らせる |

以上。

# 社員 Slack 再認可リンク（`setup.slackAuthorizeLink.issue`）

テナント側の作業を「承認者が人の承認を 1 回」+「社員本人が Slack で『許可する』」の 2 クリックにするための Admin MCP 経路。全テナント共通・テナント固有値のハードコードなし。

## フロー

1. 管理 AI 社員が `setup.slackDmApprovalStatus` を呼ぶ → 未連携 / `im:write` 不足の社員ごとに「`setup.slackAuthorizeLink.issue（employeeId=…）` で再認可リンクを発行」が next step に出る（フラグ ON 時のみ）。
2. 管理 AI 社員が `setup.slackAuthorizeLink.issue { employeeId }` を呼ぶ → **always_human** チケットが積まれる（人の承認 1 回）。
3. 承認されると、サーバーが
   - 社員が組織内にいること・ピン（下記）を再確認し、
   - 承認アプリ（承認口 inbox の bot token）で承認者との DM を開き（#235 の `openApprovalDeliveryDm`）、
   - 承認アプリの team と社員側の期待 team が一致することを確認し、
   - 32 byte のランダムトークンを生成して **sha256 だけ** を `slack_authorize_links` に保存し、
   - DM にリンク（`/api/slack/oauth/link?t=…`, 24 時間・1 回限り）を送る。
   - MCP 結果・監査ログには URL もトークンも出さない。返すのは「どこに届けたか」（inbox / DM channel / 受信者 U…）と期待ピンだけ（`urlReturned:false`）。
4. 承認者が社員本人に転送 or 社員本人の Slack にログインしたブラウザで開く → `/api/slack/oauth/link` が nonce cookie を立て、`linkId` 入りの署名 state で Slack authorize（`team=` 固定）へ redirect。
5. 社員本人が「許可する」→ 既存の redirect URL `/api/slack/oauth/callback` に戻る。state に `linkId` があるときだけリンク分岐に入る（セッション分岐には落ちない）。
   - リンクを原子的に `issued → consumed`（org + employee スコープ、期限内のみ）。
   - code 交換 → `auth.test`。`xoxb`（bot token）や `auth.test` 失敗は拒否。
   - **team_id がピンと違う / U… がピンと違う → 拒否・何も保存しない**（監査に `slack_authorize_link.rejected`、試行 U… を記録）。
   - 一致したら既存の連携処理（`allowedAccounts` 検査込み）で identity を保存 → `completed`。
   - 監査 `slack_authorize_link.completed`（`boundSlackUserId`, `userPinnedAtIssue`）+ 同じ承認者 DM に「連携しました（U…）」通知。
   - #234 の `after()` ジョブ（`scheduleDmAutoroute`）で DM ルートを自動作成（`SLACK_DM_AUTOROUTE_ENABLED` ON 時）。
6. 既に連携済みで `im:write` だけ足りない社員（例: ともり）も同じリンクで再認可でき、`SLACK_USER_SCOPE_IM_WRITE` ON なら新トークンに `im:write` が付く。

## ピン（乗っ取り防止）

| 状態 | 期待 user | 期待 team |
|---|---|---|
| 既存 Slack identity あり | その U… | その T… |
| identity なし・`allowedAccounts` の Slack が 1 件 | その U… | 承認アプリの team |
| identity なし・`allowedAccounts` の Slack が複数 | ピンなし（team のみ）。連携時に `allowedAccounts` 検査で絞る | 承認アプリの team |
| identity なし・`allowedAccounts` に Slack なし | **発行拒否** `slack_account_not_allowed` | — |

チケット承認時にピンが変わっていたら `pins_changed` で発行しない（承認された内容と違うものは届けない）。

## フラグ（すべて既定 OFF）

| フラグ | 意味 |
|---|---|
| `SLACK_AUTHORIZE_LINK_ENABLED` | 本機能全体（ツール・`/api/slack/oauth/link`・callback のリンク分岐・next step 文言）。OFF ならツールは `feature_disabled`、link route は 404、既存の callback は従来通り |
| `SLACK_AUTHORIZE_LINK_REISSUE_AUDIT_ONLY` | 要判断。連携済み・トークンに足りないのが `im:write` だけ・`SLACK_USER_SCOPE_IM_WRITE` ON・呼び出し元の管理 AI 社員自身ではない・scope が読める、を全部満たすときだけチケットなし（audit_only）で発行。ピンは既存 identity に固定されるので新しい人を紐付けることはできない |

関連（既存）: `SLACK_USER_SCOPE_IM_WRITE`（#234）, `SLACK_DM_AUTOROUTE_ENABLED`（#234）, `SLACK_APPROVAL_DM_AUTO_OPEN`（#235）。

## env / scope / App A

- 新しい env 名なし。
- App A（社員アプリ）の変更なし（redirect URL は既存の `/api/slack/oauth/callback` を再利用）。ただし `im:write` を付けるには #234 の前提どおり App A の User Token Scopes に `im:write` が入っていて `SLACK_USER_SCOPE_IM_WRITE=ON` であること。
- 承認アプリ: #235 と同じ `chat:write`, `im:write`, `im:read`, `users:read`（bot）。

## migration と適用順

`supabase/migrations/20261004100000_slack_authorize_links.sql`（`public.slack_authorize_links`、RLS 有効・policy なし・anon/authenticated revoke、service role のみ）。

1. merge / deploy（フラグ OFF のまま）
2. migration 適用（#234 の `20261004000000_slack_im_route_autoroute` の後）
3. `SLACK_AUTHORIZE_LINK_ENABLED=ON`

## セキュリティ

- org は常に credential（チケット承認時は approval 行）から。引数で org を受け取らない。`rejectUnsafeArgs` で未知引数拒否。
- state は既存の HMAC 署名 state（org + employee + nonce + 期限）に `linkId` を追加し、nonce cookie と突き合わせ。リンク本体は 1 回限り（原子的 consume）、期限 24h、新規発行で旧リンクは `superseded`。
- DB はトークンの sha256 のみ。URL・トークン・Slack token は MCP 結果・監査・ログに出さない。
- 不一致・期限切れ・別 org・フラグ OFF・交換失敗はすべて保存なしで終わる（fail-closed）。交換失敗でもリンクは消費済みになるので再発行が必要。
- 開始ページ・結果ページは `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, CSP `default-src 'none'`, noindex。

## 要判断

1. MCP 結果に URL を返すか — 既定は返さない（届け先だけ）。
2. `SLACK_AUTHORIZE_LINK_REISSUE_AUDIT_ONLY`（im:write 不足だけの再発行を audit_only に）— 実装済み・OFF。
3. 「U… 不明の新規社員は team のみピン」と既存の `allowedAccounts` 不変条件の衝突 — 不変条件を維持。`allowedAccounts` に Slack が 0 件なら発行拒否（承認者が自分の Slack で開いて自分を紐付ける事故を防ぐ）。新規社員は先に `allowedAccounts` に U… を入れる。
4. 届け先は承認者（承認口 inbox の allowedUserIds）のみ。上長（supervisor）宛は未実装。
5. code 交換の一時失敗でもリンクは消費（fail-closed）→ 再発行。
6. リンクを開くブラウザは社員本人の Slack アカウントでログインしている必要がある（違う人で開くと user_mismatch で拒否）。

## 本番有効化（例: 稲盛 / ともり）

1. merge → deploy（フラグ OFF）
2. migration 適用
3. App A に `im:write`（User Token Scope）があること・`SLACK_USER_SCOPE_IM_WRITE=ON`（ともりの im:write 用）
4. `SLACK_AUTHORIZE_LINK_ENABLED=ON`（DM ルート自動作成には `SLACK_DM_AUTOROUTE_ENABLED=ON` も）
5. 管理 AI 社員: `setup.slackDmApprovalStatus` → `setup.slackAuthorizeLink.issue { employeeId }`
6. 人が 1 回承認 → 承認者に承認アプリの DM でリンクが届く
7. 社員本人の Slack で開いて「許可する」
8. 連携 / im:write 付与 → DM ルート自動作成 → 監査 `slack_authorize_link.completed` + 承認者 DM に通知
9. `dmAutoroute.list` で確認

稲盛（未連携）は `allowedAccounts` に本人の Slack U… が 1 件入っていること（なければ発行拒否）。

## 追加（2026-10-04 木村指示）

### 1. `deliverTo`（既定 `employee`）

| `deliverTo` | 社員の U… | 届け先 | 承認者への通知 |
|---|---|---|---|
| 省略 / `employee` | ちょうど 1 つ（ピン済み U…） | **社員本人の Slack**（承認アプリ bot が社員 U… と DM を開く。社外・ゲスト・bot・別ワークスペースは拒否＝承認者と同じ検査） | 「社員本人（<@U…>）に再認可リンクを送りました」（URL なし） |
| 省略 / `employee` | 0 件・複数 | 承認者（`deliveryFallbackReason`: `employee_slack_user_missing` / `employee_slack_user_ambiguous`） | — |
| 省略 / `employee` | 1 つだが DM を開けない（ゲスト等） | 承認者（`employee_dm_unavailable`、監査に `employeeDmError`） | — |
| `approver` | — | 承認者（従来どおり） | — |

- 明示 `employee` で 1 つに決まらないときも承認者へフォールバックし、`deliverToExplicit: true` と理由を記録。
- MCP 結果（URL なし）: `deliveredTo.{target, deliveryUserId, approverUserId, requested, explicit, fallbackReason, approverNoticeSent}`, `deliveryTarget`, `deliveryFallbackReason`。承認後の fulfillment にも `deliveryTarget` / `deliveryFallbackReason`。
- 監査 `slack_authorize_link.issued`: `deliveredTarget`, `deliverToRequested`, `deliverToExplicit`, `deliveryFallbackReason`, `employeeDmError`, `approverUserId`, `approverChannelId`, `approverNoticeSent`。
- 連携完了通知は承認者 DM（`approver_channel_id`）へ。
- **bot token の解決は `resolveApprovalAppBotToken(orgId, inboxId)`（`lib/slack/authorize-link.ts`）の 1 か所だけ**。社員 DM・承認者 DM・完了／失敗通知すべてこれを通る。値は org の Slack 承認口（notification channel）secrets の `botToken`（`xoxb-`）。org 所有・有効な Slack チャネルでなければ空。共有承認アプリ（別 PR）も同じキーに xoxb を保存すればそのまま使える。
- migration: `slack_authorize_links` に `delivered_target`（既定 `approver`）, `approver_channel_id`, `approver_user_id` を追加（同じ migration 内、`add column if not exists` で冪等）。

### 2. `allowedAccounts` に Slack が無いときの次の手順

**既存の社員証の `allowedAccounts` を編集する管理 MCP ツールはありません**（`employees.issue` は発行時のみ、`policy.patch` は `allowedAccounts` を変更しない）。エラー `slack_account_not_allowed` と `setup.slackDmApprovalStatus` の next step に、ダッシュボードの AI 社員ページ「ブラウザ・外部アカウント」で人が Slack の U… を追加 → 保存 → `setup.slackAuthorizeLink.issue` を再実行、と出す（`nextStepJa`, `allowedAccountsAdminTool: null`）。status の社員行には `allowedSlackAccounts`（件数）。

### 3. 失敗通知

`user_mismatch` と code 交換失敗（`oauth_exchange_failed`）では、リンクは使用済みのまま、リンクを受け取った相手（社員本人 or 承認者）に承認アプリの DM で
「再認可リンクが別のアカウントで開かれた（または認可に失敗した）ため無効になりました。管理者に再発行を依頼してください。」
を送り、結果ページにも同じ文言を出す。別アカウントの U… は通知・ページに出さない（監査 `slack_authorize_link.rejected` の `attemptedSlackUserId` は従来どおり admin 監査のみ）。通知の失敗は callback の応答に影響しない（監査に `failureNoticeSent` / `failureNoticeTarget`）。

### 4. 変わらないもの

URL 平文は MCP 結果・監査に出さない。`SLACK_AUTHORIZE_LINK_REISSUE_AUDIT_ONLY` の発動条件は不変（届け先だけ `deliverTo` に従う）。どちらのフラグも既定 OFF。

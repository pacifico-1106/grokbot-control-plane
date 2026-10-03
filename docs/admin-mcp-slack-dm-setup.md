# 管理 MCP: Slack DM 自動ルート・承認口の自動設定ツール（PR-4）

管理 MCP（`/api/mcp/admin`、`gb_adm_`）専用。社員証 MCP（`/api/mcp`）には出ません。
org は**常に管理認証から**決まります（`orgId` 引数は受け付けず、渡すと `unexpected_argument`）。
token / secret は**受け取らず、返しません**（キー名・値が秘密らしければ `secret_not_accepted`）。

| ツール | 種別 | 内容 |
| --- | --- | --- |
| `setup.slackDmApprovalStatus` | read-only | フラグ、承認アプリ（App B）の Bot スコープ確認（`chat:write, im:write, im:read, users:read`）、承認口の宛先・自動オープン・「設定しました」の状態、社内 slack_user 相手数、社員ごとの Slack 連携と user token の不足スコープ（`im:write`）＋再認可 URL、`missingScopes`（スコープ名＋Slack アプリの deep link）、順番つき `nextStepsJa`。`testApprovalRequired` は常に false。 |
| `setup.slackApprover.set` | always_human | 共通承認アプリ「Staffpass承認」の承認者（Slack U… 1 人）を設定。人の承認後に承認 DM を自動で開き「設定しました」を 1 回送る。`SLACK_SHARED_APPROVAL_APP_ENABLED`（既定 OFF）。詳細は `docs/slack-shared-approval-app.md`。 |
| `dmAutoroute.list` | read-only | IM ルート一覧（フラグ ON 時は `auto_party` / `manual`）と、監査ログからの直近の自動ルート結果（created / skipped / failed / removed と reason）。 |
| `dmAutoroute.run` | dryRun=true（既定）: read-only / dryRun=false: always_human | dryRun は auth.test と users.info だけで「開く予定（would_open）」と「スキップ理由」を返す（DM を開かない・書き込まない・監査しない）。dryRun=false は人の承認後に PR-1 と同じロジックで実行（`SLACK_DM_AUTOROUTE_ENABLED` 必須）。 |
| `setup.approvalDelivery.autoResolve` | **always_human（フラグに関係なく）** | 人の承認後、承認アプリが許可 user ID の承認者と DM を開き、「設定しました」を 1 回送り、その D… を宛先に保存。`SLACK_APPROVAL_DM_AUTO_OPEN` 必須。token は人がダッシュボードで保存済みのものだけを使う。 |

## nextStepsJa に必ず出るもの
- 承認アプリの `users:read` が**確認できない**とき（承認口が無い・スコープが無い・確認できない）は、
  「承認アプリの Bot Token Scopes に users:read を追加し、Reinstall to Workspace」と Slack アプリの deep link を出します。
  （承認者が社外・ゲスト・bot でないかを users.info で確かめるのに必要。無いと DM 自動オープンは止まります。）
- 最後に「テスト承認は不要。最初の本物の承認依頼が実地確認」。

## ADMIN_MCP_DM_AUTOROUTE_AUDIT_ONLY（既定 OFF・八坂への提案）
- ON のとき、`dmAutoroute.run` の dryRun=false を**人のチケットなし**で実行し、代わりに
  `admin.channel`（event `admin_mcp.dm_autoroute.run_audit_only`、管理エージェント ID・対象社員・件数）を残します。
- 理由: 実行内容は、Slack 連携時と `parties.upsert` 承認時にすでに自動で走るのと**同じロジック**の再実行です。
  相手は人が承認した `org_parties(kind=slack_user, audience=internal)` だけで、新しい信頼は増えません。
- 例外: 管理エージェント自身にひもづく AI 社員が対象に含まれるときは、ON でも人のチケットになります（自己昇格なし）。
- `setup.approvalDelivery.autoResolve` には**適用しません**（常に人の承認）。

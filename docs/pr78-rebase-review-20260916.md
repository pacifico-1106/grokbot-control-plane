# PR #78: #80 適用後の main への rebase とレビュー引き継ぎ

> 後続対応: main `2a4e019` から、以下の未接続箇所を実装・検証した新規PRを準備。現時点の解消状況・検証・配備条件は [F8接続の引き継ぎ](f8-enforcement-handoff-20260916.md) を参照。この文書の下記は #78 rebase 時点の記録を保持している。本番F8有効化は未実施。

## 対象と統合結果

- PR: https://github.com/pacifico-1106/grokbot-control-plane/pull/78
- 更新先: `cursor/f8-approval-workflow-quorum-a70a`。Draft を維持する。
- 旧 head: `0c5593274ff1a176a268bc0ef2309e20173563f6`
- 確認した main: `c31eea17e8e8318a705a4fb0b47bd707f6540f26`（#80 マージ後）
- F8 の元コミットを rebase したコミット: `b828c820d7f380b55c05be90b1d05dac759cf372`
- 実際の競合: approve/reject API と `staffpass-situation-policy-catalog.md` の3ファイル。
- `lib/mcp/admin-tools.ts` / `lib/types.ts` は自動統合後に内容を照合した。
- 元の作業ツリーを変更せず、分離した worktree と旧 head のバックアップブランチで作業した。

## #80 の契約と追加の統合修正

- approve/reject のレスポンスは `publicApproval()` を通す。F8 の進捗情報を加えても秘密値・poll token を復活させない。
- Admin/Employee の実行は既存の fulfillment wrapper を通り、`executeApproval()` による authority 再確認と claim を維持する。
- `execution.ts` / `execution-authority.ts`、Admin secret の消費・取得権限、Employee MCP の poll、承認 metadata 更新、#80 migration は main から変更していない。
- Admin の自己承認検査を F8 の投票記録より前にも実施する。最終票だけでなく、中間票・却下票でも自己解決による変更を拒否する。
- 基底の承認更新が失敗した場合は完了・承認済みを返さず、API でも `result.ok` を確認して実行・通知を抑止する。
- MCP の参照専用ツールのテスト一覧に F8 の get/inspect を追加した。変更ツールに対する `always_human` の検査は維持した。
- 状況カタログの F8 は「実装レビュー中・Draft、本番未適用」とした。

## ローカル検証

Node 24.19.0 / Bun 1.4.2 / PostgreSQL 16。環境ファイル・実サービスの資格情報を読み込まず、テストは外部通信を遮断して実施した。

| 検証 | 結果と範囲 |
| --- | --- |
| `BUN_BIN=<bun> node scripts/test-local.mjs` | 99ファイル、974テスト成功、失敗0。既存の認可・claim・Admin secret・MCP・Slack 回帰テストを含む |
| `node node_modules/typescript/bin/tsc --noEmit` | 成功 |
| `node scripts/build-local.mjs` | 成功、47ページ生成。unused-vars 等の警告は残存。フォント取得だけネットワークを許可した |
| `python3 scripts/test-db-local.py` | 新規一時DBで #80 の後に F8 migration を適用・再適用。#80 の ACL・tenant/requester/generation/status 拒否・metadata の秘密値復活防止を検証 |
| DB 同時実行 | 12接続の claim は1件だけ取得成功。12接続の Admin secret 消費は1件だけ取得成功 |
| 追加の回帰テスト | 承認・却下APIの公開DTO、既存 fulfillment 呼び出し、権限拒否・中間票・承認更新失敗時の実行/通知抑止、自己解決による投票変更なし、別の承認者の成功 |

これは rebase と #80 の回帰検証であり、F8 全体の本番受け入れ完了ではない。本番DBへの接続・変更、実データ操作、鍵操作、Slack 等への実送信、デプロイは実施していない。

## Draft レビューで残る項目

以下は元の F8 実装から引き継いだ未接続箇所・リスク。rebase の競合解消とは分けて扱い、F8 を有効化して本番公開する前に解決・検証する。

1. **ワークフローの開始と実行制約が未接続（優先度高）**。
   `maybeInitializeWorkflow()` / `initializeWorkflowForApproval()` の実際の承認作成経路からの呼び出しがなく、テストでは明示的に初期化している。
   `canFulfillApproval()` も共通 fulfillment には未接続。Slack/Telegram/LINE webhook と代理承認は従来の解決経路のままなので、インスタンスを作成しただけでは、定足数・finalGo が全経路の実行条件になることを保証できない。
   対象: `lib/approvals/workflow-integration.ts`、`lib/approvals/execution.ts`、`lib/data/approvals.ts`、`app/api/webhooks/`、`lib/notify/telegram-channel-webhook.ts`、`lib/admin/proxy-approve.ts`。

2. **DB 読み取り障害と投票競合（優先度高）**。
   `lib/approval-workflow/data.ts` は DB エラーと「ワークフローなし」を共に `null` として返す。解決側が単独承認に戻るため、設定済みのワークフローでも読み取り障害時に制約を迂回する可能性がある。
   投票・次段の作成・進捗更新は複数の独立した書き込みで、投票更新に未投票条件がない。投票の同時実行と失敗後の復旧は今回の DB 試験対象外。基底承認の更新失敗後に完了インスタンスだけ残る場合の復旧も必要。

3. **新規テーブルの直接アクセス制御（優先度高）**。
   F8 migration の RLS は組織管理者に instance/ballot の `FOR ALL` を許す。実効 GRANT によっては承認済み状態や他者の票を直接書き換えられる。
   `approval_id` / `instance_id` と `org_id` は独立の FK で、同一組織であることを DB 制約で保証していない。本番 GRANT は未確認。ローカル試験は migration の適用互換性と #80 の回帰を対象とし、F8 の RLS・整合性の安全性を認定するものではない。

4. **Admin MCP の新ツールの実処理が未接続**。
   `approvalWorkflow.patch` / `.remind` に対応する処理が `lib/admin-mcp/fulfill-admin.ts` にない。
   `.remind` の対象 `approvalId` は、`lib/mcp/admin-tools.ts` の変更ツール共通の承認後再実行判定とも衝突する。設定・リマインドの成功と拒否の経路を通した検証が必要。

5. **Slack 等の投票者対応と進捗表示**。
   `lib/notify/slack.ts` に追加された workflow 表示オプションは実際の通知呼び出しから渡されていない。各チャットのユーザーIDとポリシーの voterUserId の対応、所属削除・無効化後の拒否を含む E2E は未検証。

## 引き継ぎ・公開条件

木村さんの合流レビュー用に Draft を維持する。新しい環境変数・署名鍵は今回導入していない。
上記の F8 未接続箇所を解決したうえで、ステージングで通常の単独承認と多段・定足数・finalGo の成功/拒否、並行投票、DB障害、MCP/各通知チャネルの経路を検証する。
本番適用時は手動適用分と migration 履歴を照合し、F8 の schema とアプリの配備順を確定する。今回の migration の適用試験だけで本番運用への無影響を保証しない。

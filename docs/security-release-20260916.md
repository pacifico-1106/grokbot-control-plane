# 配備と引継ぎ — 認可レビュー修正 2026-09-16

## 現在の状態

`codex/security-review-fixes-20260916` は `add508d14d0eb28bda2a2bb8399e2ad5a3a08ea7` から作り、PR作成時にmain `033e69f`（#79）を統合した修正版。本番には未適用。レビュー結果は [security-review-20260916.md](security-review-20260916.md)。

このブランチはアプリと追加DB関数をセットで扱う。従来版の `20260910000000_authorization_boundaries` を混ぜない。今回のmigrationは既存public権限のrevokeや既存FK追加を含まない。手動適用された列・設定を消す変更もない。

## 必要な設定・互換性の確認

| 設定・権限 | 扱いと公開条件 |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | 現行構成を継続。anonはAuth用に残す。service_roleはサーバー専用。今回の4 RPCを実行できること。新しい全権限キーfallbackは導入しない。設定不足時にDEMOへ切り替わる既存挙動は別の未解決事項 |
| `SUPER_ADMIN_USER_IDS`, `SUPER_ADMIN_EMAILS` | IDを優先して運用を確認。メール運用はAuth側の確認済みメールなら継続できる。値の共有ではなく、現運営者が有効なowner所属とAuth IDで照合されることを管理者が確認する |
| `PLATFORM_OPS_ORG_ID` | 現在の任意設定を維持。設定済みなら一致必須。未設定運用は所属DBへの直接書込み権限を含めて再評価し、運営org固定の移行要否を確認する |
| `CRON_SECRET` | 現行5 Cronを維持。認証がない/異なる要求ではDB照会・履行が起きないことを実環境相当でも確認する |
| Slack/LINE/Telegramの認証・暗号化設定 | 新しい権限や鍵は要求しない。`NOTIFICATION_CONFIG_ENCRYPTION_KEY`を変更しない。Slack OAuthの入口権限、bot/user token選択、既存の通知承認者設定を維持する |
| ファイル取得元 | HTTPS/443・公開IP・3 redirect以内・30秒以内・50MiB以下であることを現用ファイルのメタ情報で確認。署名URL自体は共有しない。内部保存先/HTTP/大容量利用がある場合は、このブランチをそのまま配備しない |
| `NOTIFICATION_APPROVER_BINDINGS` | 今回は導入しない。旧セキュリティ版で検討した別の運用移行事項 |
| 新規署名鍵 | 導入なし。発行・配布・ローテーションを伴う作業なし |

## 推奨するマージ・配備順序

1. 最新mainを再fetchし、基点から進んだ差分を確認する。進んでいれば別worktree上でこのブランチを統合し、変更された機能のテストを再実行する。元の未コミット作業をreset/stash/上書きしない。
2. 管理者が [read-only事前確認SQL](../supabase/security-review-preflight.sql) を実環境で実行する。関数の旧オーバーロード、RLS/Viewの実効権限、手動GRANT・default privilege・直接DB利用サービスを確認する。SQL結果の秘密値や個人情報は共有しない。さらにStorageのbucket公開/ポリシー/所有者、署名URLの発行元と期限を確認する。このSQLだけで安全とは判定しない。
3. #79のpoll結果から管理秘密を読むクライアントは、`resultRetrieval`の案内に従い管理MCPで一度きりの取得を行う方式へ対応する。状態と秘密以外のpoll結果は維持する。現運営者のAuth/owner照合、既存の管理MCP結果取得クライアント、`internalAudienceRule.patch`承認済み未履行チケット、世代を持たない旧チケットの処置を決める。キャンセル・再起票・失効や実キーの再発行は別途承認対象。
4. 本番と分離したDB/Storage/provider sandboxで、**追加DB migration → 新アプリ**の順に適用する。既存版でもDB拡張後にログイン/書込みが続けられること、新版で下記受入確認が通ることを確認する。外部連携のテストは許可されたsandboxのみ。
5. 本番適用の別途承認後、`20260916000000_approval_execution_security.sql` を適用して4 RPCとclaim tableのACLを確認する。アプリだけ先行するとmissing RPCで履行が停止する。設定不備時に旧ロジックへ黙ってfallbackさせない。
6. 旧バージョンの承認処理・W2・Gateway実行が残ったまま新バージョンへ切り替えない。旧コードは新claimを取得しないため、混在期間の排他は保証できない。配備担当が処理受付の保留・in-flight処理の完了・Cron切替の方法を具体化し、既存運用への影響を承認してから実施する。無停止を未検証のまま約束しない。
7. 新版への切替後、ログイン・権限・承認・管理MCP・Slack投稿/添付/設定・既存5 Cronを限定した対象で確認する。エラー率と`running/uncertain`件数を監視する。未知の既存直接DBクライアントがある場合は、別のrevoke施策を同時投入しない。

配備時は本番service_roleを開発端末・プレビュー・テストに継承しない。Cron/ワーカーも本番と検証環境を分離する。現構成でワーカーのDB権限はservice_roleのままなので、任意コード実行を許すワーカーへの委譲や新しい外部公開は行わない。

## 受入確認（本番相当の接続後に必要）

- 正常な組織ユーザーのログイン、承認一覧、承認/reject/revise、各管理者の業務権限。
- 別テナント、同一テナントviewer、所属削除、Auth停止、資格情報失効/再発行、改ざん対象ID、期限切れでデータ変更・外部実行がないこと。
- 現在の管理MCP資格情報で起票→他者の承認→同じツールにapprovalId→結果取得。秘密を返す操作は最初の1回だけ。別起票者/世代/運営権限なしでは取得も履行も拒否。
- Slack OAuthの現行権限、bot投稿、本人token投稿、files:write、署名URL経由ファイル取得。許可された添付は正常送信し、内部IP/不正URLの取得は発生しないこと。
- DB/PostgREST/Storage APIを直接使う成功・拒否ケース。アプリAPIのテストと分けて記録する。追加RPC/tableはanon/authenticatedで呼べないこと。
- 正常なW2再試行、並行要求、資格情報失効、外部timeout後の不確定状態。ファイル添付と通知の重複は別経路として確認する。

## 不確定状態・切り戻し

- `approval_execution_claims.state=running` は処理中、または実行プロセスが外部結果を保存する前に終了した状態。時刻だけで再実行してはいけない。
- `uncertain` は外部処理の有無が確定していない。Slack等の実行先・jobId・approvalId・監査を運営が照合し、完了扱いにするか、明確な未実行の場合のみ再試行を認める。claimの状態変更を自動化しない。
- `failed` はコード内で列挙した明確な送信前エラーのみ。修復後は既存W2/管理再実行でclaimを取得できる。
- アプリを旧版へ戻すだけでは、消費済み秘密の復活や旧履行経路の二重送信防止を保証できない。承認実行を保留して照合し、必要なセキュリティ修正を残したhotfixを原則とする。
- 追加table/RPCは互換性のある拡張として残す。旧アプリへ戻す目的でmigrationをDROPしない。実データ・claims・secret消費履歴を削除しない。
- 一度返した秘密を回復用にログへ残さない。取得レスポンス喪失時の新しい秘密の発行/ローテーションは明示的な承認を得て実施する。

## ローカルで再現する方法

Node 24、Bun 1.4.2、PostgreSQL 16で検証。Bun実行ファイルは`BUN_BIN`、PG16のbinは`PG_TEST_BIN`で指定できる。実サービス用環境変数を渡さない。

```sh
npm ci --ignore-scripts --no-audit --no-fund
BUN_BIN=/path/to/bun node scripts/test-local.mjs
node node_modules/typescript/bin/tsc --noEmit
PG_TEST_BIN=/path/to/postgresql@16/bin python3 scripts/test-db-local.py
node scripts/build-local.mjs
```

`test-db-local.py`は新規tempディレクトリとUnix socket専用クラスタを作成し、fixtureの終了後にそのディレクトリだけを片付ける。DATABASE_URL/PG接続設定/dotenvを読み込まない。ローカル共有メモリ制限がある環境では起動許可が必要。

`build-local.mjs`はdotenvファイルを検出すると停止し、秘密情報を継承せず本番形式のビルドを行う。既存Google Fontsのダウンロードが必要な場合がある。実DB接続や本番への配備ではない。

最終検証: 95ファイル・889テスト成功、失敗0。型検査とビルドも成功（47ページ生成）。既存の未使用変数、複数lockfileによるworkspace root推定、webpack cacheのサイズ警告は残る。テスト結果とビルドは本番の無影響の保証ではなく、配備前のローカル検証結果である。

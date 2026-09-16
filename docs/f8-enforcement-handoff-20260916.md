# F8: 合議の実行制約・DB排他制御の接続

2026-09-16 追記（本番適用後の履歴整合）: #81は `4f08846` でmainへ合流済み。依頼者の報告では、FIXED／分割版SQLとVercel Productionの配備は完了し、ポリシーは引き続き未設定。今回の追従PRは **本番適用済みのUNIQUE CONSTRAINT版への履歴整合のみ** で、本番への再migrationを要求しない。

`org_members` / `approval_requests` / `approval_workflow_instances` の `(id, org_id)` は明示的な、遅延不可のUNIQUE CONSTRAINTに統一。カタログを `IF NOT EXISTS` で確認し、同じ列の制約が既にあれば別名でも保持する。旧index・既存データは削除せず、SQLのドル引用を `$f8$` に揃える。参照boxのFIXED原本・分割版はこの作業環境から参照できず、全文照合および本番DBへの接続は未実施。

追従PRの検証: 102ファイル・987テストと型検査が成功。`python3 scripts/test-db-local.py --f8-parent-state <state>` を `fresh` / `legacy-indexes` / `mismatched-indexes` / `existing-constraints` の4状態で実行し、各一時DBで3制約の存在、既存制約・indexの保持、再適用時の非重複、#80/F8の権限・並行処理を確認した。既存FK・RLS・RPC・triggerの定義はドル引用以外に変更していない。SQL Editor上での分割実行は未検証。

この追従PRでもポリシー・voter bindingsを書き込まず、F8を有効化しない。マージは木村さんのレビュー → 安藤さん経由のユーザー確認後に判断する。以下は#81作成時点の実装・検証・配備計画の記録であり、本番再適用の指示ではない。

対象は main `2a4e01945d4f233a7f17b15cfeffd254bed400b3`（旧 #78 合流後）からの新規ブランチ。旧 #78 ブランチは更新しない。
本変更はレビュー待ちであり、本番有効化・本番 migration 適用・プリセット適用を行っていない。どのテナントにもポリシーや投票者対応表を書き込んでいない。

## 未接続箇所の解消

| 項目 | 実装と検証 |
| --- | --- |
| P0: 承認作成 | `createApproval()` が初期化を呼ぶ。DBのINSERTトリガーでも、承認作成と同じトランザクションでポリシーを確定する。初期化は冪等 |
| P0: 実行制約 | `executeApproval()` が claim 前後に `canFulfillApproval()` を確認する。DBのclaim書き込みにも検査トリガーを追加。Admin/Employee/MCP poll/再実行/代理承認に共通 |
| P0: 全承認経路 | 共通 `resolveApproval()` はF8の解決処理へ委譲。Web、Slack、Telegram（テナント別・global）、LINE、proxy が定足数・finalGoを尊重。中間票では実行・完了通知を行わない |
| P0: 障害時拒否 | 初期化RPC・インスタンス/ポリシー読み取りのエラーを「設定なし」と区別。RPC未配備、DB障害、不正な応答では単独承認に戻らない |
| P0: 並行投票 | 承認→インスタンスの順で行ロック。未投票条件と一意制約で1票だけ記録。投票・段階遷移・基底承認・投票監査を1つのDBトランザクションで更新 |
| P0: 再配送 | provider/channelに対応するdecision IDを票へ保存。以前のイベントが次段階やfinalGoの票になることを拒否。解決時に読んだstageもRPCへ渡して競合を検出 |
| P0: 復旧 | 基底承認の更新失敗時は投票を含め全体をrollback。旧実装の完了instance/未確定ticketは、現在も有効な既投票者の再操作で確定を復旧。承認側は全段階を再検証 |
| P0: DB直接アクセス | anon/authenticatedの新規テーブル権限をrevokeし、旧org-admin書き込みRLSを削除。新RPCはservice_roleのみ。approval/instance/ballotのorgを複合FKで保証 |
| P1: Admin MCP | `approvalWorkflow.patch` / `.remind` を既存の履行switchへ追加。承認後も投票者・対象の有効性を再確認。remindは対象IDと自分の承認チケットIDを分離 |
| P1: 通知・本人対応 | Slackの初回カードと中間更新に進捗/finalGo表示を接続。Telegram/LINEは途中票を「合議継続中」と応答。署名検証後にチャネル別の本人対応を使い、未登録・失効・所属無効を拒否 |

## 維持する契約・振る舞い

- ポリシー未設定の承認は従来の単独承認（W1）。作成時の「対象外」という判断も保持し、後からポリシーを設定して既存の初期化済みチケットを変更しない。
- 旧アプリで作られた未初期化チケットは初回操作時に確定する。既存instanceがあればそのsnapshotを優先する。配備中・切り戻し中は全ポリシーnullを維持する。
- requesterと承認者の分離、#80のauthority再確認、claimの排他・不明結果の自動再試行禁止、Admin secretの原子的な一度消費、公開DTO/pollからの秘密除去を維持。
- 完了済みの票も、実行時にはメンバー所属・`approve_actions`・Authユーザーの削除/停止を再確認する。失効した票で定足数を満たした扱いにしない。
- 通知の失敗は確定済みの投票を取り消さず、実行を許可する理由にもならない。進捗の正本はstatus API/DB。中間のSlack表示更新はbest effort。
- F8中の修正依頼は引き続き未対応。修正待ちの状態や通知を作る前に拒否する。ポリシーなしの既存修正依頼は維持。

## 投票者の識別と運営者の境界

`voterUserIds` / `finalGoUserId` は **Staffpassの `org_members.id`** に統一する。Authの `user_id` やSlack/Telegram/LINEのIDをそのままポリシーに入れない。
Webはセッションのmember IDを使用する。proxyは認証済みの運営者のAuth user IDを対象組織のmemberへ照合する。運営管理者であることだけでは合議の票やfinalGoを代行できない。対象組織の有効な承認者で、該当stageに割り当てられている必要がある。例外的な代理権限は業務判断が未承認のため追加していない。

チャットは `approval_workflow_voter_bindings` で、`org_id + provider + channel_key + external_user_id` をmemberへ対応付ける。
`channel_key` は署名を検証した通知チャネルのID。global Telegramだけ `telegram:global`。署名・送信元・通知deliveryの照合は既存処理を維持する。
`expires_at` / `revoked_at` を確認し、同じチャットIDでも別組織・別チャネルの登録は使わない。LINEのF8票には `webhookEventId`、Telegramにはcallback IDが必要。Slackは署名検証したbodyのハッシュを使う。

対応表はservice_role管理で、ブラウザや組織管理者による直接登録・変更は許可しない。登録UI・自動本人確認フローは本PRに含まない。実IDの照合、登録、期限、担当者による失効手順は運用レビューで確定する。未登録の利用者へ権限を推定して付与しない。対応表の削除/失効は今後のチャット投票を拒否し、メンバー無効化は投票と実行時の票評価を拒否する。

## Admin MCP の呼び出し契約

- `approvalWorkflow.patch`: 既存の人承認後に保存。組織設定と社員overrideに対応。`clearOverride`は社員のみ。保存時に全voter/finalGoの有効な所属・承認権限を検証する。
- `approvalWorkflow.remind`: 依頼作成は `{ "targetApprovalId": "対象の未完了承認ID" }`。承認後の再実行は `{ "approvalId": "リマインド依頼自身の承認ID" }`。旧F8の曖昧な`approvalId`の二重用途は使わない。
- リマインドは現在の未投票者が残る承認インボックスへカードを再送する。個人DM・ユーザー別のメンション配信は行わない。対象が完了/却下済み、別組織、有効な未投票者なしの場合は送信しない。
- 新しいポリシーは未完了instanceのsnapshotを上書きしない。ポリシー変更自身も、その作成時点で適用される合議の対象になり得る。

## ローカル検証

Node 24.19.0 / Bun 1.4.2 / PostgreSQL 16。環境ファイル・実サービスのキーを読み込まず、JSテストの外部通信は遮断し、provider応答はfixtureのみ。

- `BUN_BIN=<bun> node scripts/test-local.mjs`: 102ファイル・987テスト成功。
- `node node_modules/typescript/bin/tsc --noEmit`: 成功。
- `node scripts/build-local.mjs`: 成功、47ページ生成。既存のunused-vars等の警告は残存。最初の試行はローカル容量不足で止まったため、この会話で生成した分離コピーのビルドキャッシュのみ整理して再実行した。
- `python3 scripts/test-db-local.py`: 新規一時DBに旧F8＋追加migrationを適用・再適用。W1、多段・定足数・finalGo、却下、票/所属/バインディング失効、自己承認拒否、複合FK、DB直接アクセス拒否、途中失敗rollback、旧状態の復旧を検証。
- DBの12並行claimと12並行secret消費は各1件だけ成功。12件の同一投票も1件のみ。異なる2人の並行投票でstageは一度だけ進む。同じ通知イベントの次段階での再使用を拒否。
- 実際の署名検証を通すSlack/Telegram/LINEのルートとproxyの組み合わせで、多段・finalGoまで進めた時だけfixtureの実行処理が1回呼ばれる。未登録ID・無効メンバー・未割当proxyでは実行/完了通知0件。
- DB/RPCエラーを注入し、単独承認へのフォールバック・claim・外部処理が起きないことを検証。ポリシー作成とリマインドの承認前/後・拒否・再実行も検証。

## 配備手順（未実施・別途承認）

1. 木村さんの合流レビュー → 安藤さん経由のユーザー確認。Draftの本PRを本番へ自動マージしない。
2. 実環境のmigration履歴・手動変更を照合し、`supabase/verification/f8-preflight.sql` を承認された接続で実行する。今回の前提は全テナントのポリシーnull。想定外の設定、別orgの関連ID、独自roleへのGRANT、旧関数の別signatureがあれば適用を止めて調査する。結果は件数・権限メタ情報で共有し、秘密値は出さない。
3. ステージングで `20260916120000_f8_enforcement.sql` を適用する。旧F8は既に適用済みの前提。新migrationはトランザクションで、ロック取得に5秒の上限を設ける。既存不整合は削除・自動修復せず検証エラーとする。索引作成/FK検証の時間・ロックを実データ量相当で測定する。
4. **新migration → 新アプリ**の順。追加RPCがない状態でアプリだけを出すとfail closedで承認処理が停止するため、先行配備しない。全ポリシーnullのまま既存のWeb/MCP/各通知チャネルの単独承認・修正依頼を実環境で検証する。
5. 運用で使用するDB role/手動GRANTがrevoke対象と整合することを確認。新テーブル/RPCを使うのは既存のサーバー側service_roleのみ。新しい環境変数・署名鍵・全権限キーへのフォールバックは導入しない。
6. F8有効化は別の承認を得てから。本人対応表・承認者の対応を確認し、ステージングで所属削除、無効Auth、期限切れbinding、再配送、DB障害まで確認する。本PRではみらい社中/Space Tree/TOKYO307を含め実ポリシーを書かない。

切り戻しは全ポリシーnullの配備段階で検証する。新DB制約/RPCを残して旧アプリへ戻す方針とし、revokeの撤回、旧F8 migrationの再適用、データ削除は行わない。F8を有効化した後の旧アプリへの切り戻しは、合議を無視する経路を復活させず、別途手順をレビューする。

## 残る実環境確認と制約

本番GRANT、実メンバー/チャットID、Auth・署名検証サービス・各providerの実配送、データ量に伴うmigration時間は未検証。ローカル成功だけで本番への無影響を断定しない。
Telegram/LINEカードの継続的な数値進捗更新、個人別通知、本人対応表の管理画面は対象外。進捗の数値表示はSlackとstatus APIで確認できる。
DB管理者・BYPASSRLSを持つservice_roleは信頼する主体で、直接投票/ポリシーを書ける。新RPCの権限を絞ることは、既存service keyの漏洩に対する完全な防御ではない。キーの保管・配備は既存サーバー側設定を維持し、今回発行・閲覧・ローテーションしていない。

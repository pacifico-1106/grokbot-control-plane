# 認可レビュー修正と最新版への統合 — 2026-09-16

対象main: `add508d14d0eb28bda2a2bb8399e2ad5a3a08ea7`。修正ブランチ: `codex/security-review-fixes-20260916`。

旧セキュリティ版を上書き適用せず、最新mainから分離したworktreeで修正した。元の作業ツリー・旧セキュリティ版・既存データは保持している。本番へのpush、配備、DB変更、実通知、実キーの発行・ローテーションは行っていない。

## 最新情報と差分

- 前回レビュー `b1e616c8c3817c653c6560bc6494e8746d877347` → 今回mainは1コミット、文書2ファイルのみ（214行追加、5行削除）。アプリコードに追加差分はない。
- 追加はF8合議承認の仕様。未設定時は従来の1人承認を維持する仕様で、今回F8の実装は追加していない。
- 作業終盤の再fetchでもmainは同じSHA。
- GitHub Production deployment `6470411236` はこのSHAで `success`、記録時刻2026-09-15 23:21:16 UTC（9/16 08:21:16 JST）。これはデプロイ記録の確認であり、カスタムドメイン・環境変数・実DB・実運用の動作確認ではない。
- 旧版 `a6141f72` 基点のセキュリティパッチはそのまま適用しない。前回の比較では最新版と13ファイルが重なり4ファイルにテキスト競合があった。今回は最新main上で対象の処理を再実装した。

参照: [最新main](https://github.com/pacifico-1106/grokbot-control-plane/commit/add508d14d0eb28bda2a2bb8399e2ad5a3a08ea7)、[前回からの差分](https://github.com/pacifico-1106/grokbot-control-plane/compare/b1e616c8c3817c653c6560bc6494e8746d877347...add508d14d0eb28bda2a2bb8399e2ad5a3a08ea7)。

## PR作成時の再照合

PR作成直前にmainが `033e69f`（PR #79: Admin MCP fulfillment結果をemployee MCPのpollへ追加）へ進んでいたため、同じ修正ブランチへ統合した。`lib/mcp/tools.test.ts`のimport競合を解消し、URL取得fixtureと新しいpollテストの両方を残した。

新しいpoll経路は`oneTimeSecret`をそのまま返すため、そのまま統合するとR3/R8の保護を迂回する。状態・秘密以外の履行結果・自動履行は維持し、秘密が未取得の場合は`resultRetrieval`に管理MCPのエンドポイント・元のtool・approvalIdを返し、`pollHint=reinvoke_with_approvalId`で管理資格情報による取得を案内する。秘密は元の管理資格情報で一度だけ取得し、取得後のpollは`fulfilled`となる。

**#79で追加された「employee MCPのpollから管理秘密を受け取る」契約は変更になる。** 当該クライアントの対応を配備前に確認する。別世代の管理資格情報による取得拒否、pollの繰り返しでも秘密を返さないこと、正しい管理資格情報での一度きりの取得を統合テストで確認した。アプリ公開・migrationの適用は引き続き保留。

## 修正内容とレビュー結果

| ID | 問題・影響 | 今回の変更 | 検証・限界 |
|---|---|---|---|
| R8 / P1 | 組織内の承認一覧から社員証・管理MCPの秘密値を取得できる | API・RSCの公開境界で秘密値、暗号文、poll資格情報を除去。内部の履行データは保持 | 再帰redactionと非破壊性をテスト。DB直接SELECTの権限は別途の未適用対策が必要 |
| R1 / P1 | 編集可能なownerメールを運営本人の証明に使用 | `org_members.user_id`でAuthを取得し、不変IDまたはAuthの確認済みメールをallowlist照合。停止・削除済みAuthと無効所属は拒否 | ID・従来の確認済みメールの成功、改ざんメール・未確認メール・停止・削除・無効所属の拒否。所属行自体へのDB直接改ざんを防ぐACLは別の公開条件 |
| R2 / P2 | proxyResolveが汎用reinvokeに吸われ実行されない | 専用分岐へ通し、実際に認証されたMCP起票者で自己承認を拒否 | 専用分岐への到達、自己承認拒否、pending状態の維持、既存proxy承認テスト |
| R3 / P1 | 再実行で運営gateを飛ばし、秘密を何度も取得できる | fulfill前と結果取得時に現在のagent・組織・起票者・世代・必要な運営権限を確認。DB行ロックによる一度きりの秘密取得 | 別組織・別起票者・世代違いを拒否。12並列取得で秘密取得1件。旧チケットに存在しない世代は推定しない |
| R4 / P1 | ファイルURLによるSSRF、無制限メモリ使用、署名URLのログ保存 | HTTPS/443、ユーザー情報なし、公開IP限定、DNS回答を接続IPに固定、TLS元ホスト検証、各redirect検査、3回上限、30秒、50MiB。監査fileRefはSHA-256 | 正常な署名URL・redirect・Slack APIフロー、内部IPv4/IPv6・混在DNS・metadata宛redirect・サイズ・loopをテスト。URLの所持者とファイル所有者の関係は証明できない |
| R5 / P1 | W2等が承認時の情報のみで失効後も送信 | 実行直前に資格情報の期限・失効・結合先・現在の社員状態・scope・purpose・tool deny・trialと対象ID整合性を再確認。管理申請は現在のagentと必要な運営gateも確認 | 停止、期限切れ、失効、binding変更、scope削除、deny、trial、改ざんIDで外部処理0件・claim0件。全ポリシーの再評価を保証するものではない |
| R6 / P1 | 並行W2/承認コールバック/reinvokeで二重送信 | 共通のDB claimを使い、Gatewayの承認済み会話/SNS再実行も同じ入口へ。承認済みsnapshotで実行。秘密消費後の古いmetadata保存で秘密を復活させない | 12並列claimで1件のみ実行権取得。成功・明確な送信前エラー・不確定結果を区別。期限が過ぎたrunningを自動再取得しない。外部APIとのexactly-onceは保証しない |
| R7 / P2 | internalAudienceRule.patchが承認後も保存されない | fulfill分岐と入力検証・監査を追加。保存先は承認チケットのorg。省略項目を維持 | 承認前は未変更、承認後に保存、結果取得と拒否ケースをテスト。scheduling/reply/mail/stuckWatch等の最新版分岐を維持 |

## 維持する互換性

- Admin MCPの既存ツール名、承認→同じツールをapprovalId付きで再呼出し→結果取得を維持。戻り値のorg/owner/trial/setup等の新しい項目も残す。
- 一般の承認一覧・画面から秘密は取得できなくなる。起票資格情報での結果取得のみが一度きりの受け渡し口。レスポンス喪失後の同じ秘密の再取得はできない。
- `SUPER_ADMIN_EMAILS`を一律廃止せず、実Authの確認済みメールとして照合。`PLATFORM_OPS_ORG_ID`も既存の設定方式を維持。運用ID/所属対応の突合は配備条件。
- Slack OAuthに新たな`hire_issue_credentials`要求は追加していない。既存bot/user token選択、Slack/LINEの設定暗号化、Telegramの承認者空リスト設定、新しい5件のCron設定を維持する。空リストや共有botの権限妥当性を確認済みとはしていない。
- `internalAudienceRule.patch`にようやく実効性が生じるため、既存の承認済み未実行チケットの内容は配備前にレビューする。組織内判定を広げる既存チケットをW2が自動実行しうる。
- ブラウザでの秘密非表示は表示制御ではなくレスポンスからの除去。DB/Storage APIの認可の代替ではない。

## ローカル検証

実環境の秘密・dotenvを継承しないテストランナーを追加。個々のファイルを別プロセスで実行し、fetch/DNS/HTTPSの非fixture通信を検出する。Slack/LINEテストは実APIへ送らず明示的なfixtureを利用する。

- 修正前: 87ファイル中85ファイルが通過。2ファイルは架空tokenで非fixture通信を試みるため遮断された。テスト用通信fixtureを明示して修正。
- 修正後: 95ファイル、889テスト成功、失敗0。
- 本番形式ビルド: Node 24 / Next.js 15.5.23、コンパイル・lint/型検査・47ページ生成を完了。既存の警告は配備手順を参照。
- TypeScript: `tsc --noEmit` 成功。既存テストの不足したBun matcher宣言、旧型のfixtureも現行型に合わせた。アプリの型を緩めたりテストを型検査から除外したりしていない。
- PostgreSQL 16: 使い捨てクラスタ・Unix socketのみでschema＋既存マイグレーション＋追加migrationを適用。service_roleの正常系、anon/authenticatedの追加RPC/table拒否、対象組織・状態・世代・起票者拒否、秘密復活防止、並列claim/consume、再適用を確認。
- テストDBはローカルfixtureであり、Supabase Auth/PostgREST/Storageの実装・本番データ・手動GRANTを再現したものではない。実トークンを使った直接HTTP APIテストは未実施。

## 未解決事項・公開の条件

本変更だけで認証認可全体を「安全」とは判定しない。特に次は配備判断に関わる。

1. **DB直接アクセス**: 既存のテーブル/列/RLS/関数/View、追加default grants、旧関数、手動設定を実DBで未確認。今回のmigrationは追加claim tableと4 RPCのみを閉じる。既存`approval_requests.metadata`や`org_members.user_id`を含む直接アクセス境界は別途確認・制限が必要。service_role/DB管理者は引き続き迂回主体。
2. **旧承認チケット**: 起票時の資格情報世代がないものは現在の同じagentでの互換性を残す。旧秘密の世代間アクセスを完全に否定できない。キャンセル/再起票等の移行方針は運営が決め、無断変更しない。
3. **承認者失効・全ポリシー**: 人のresolved_byが未記録の過去承認では元の承認者の所属失効を復元できない。プロジェクト/情報資産/金額/全チャネルポリシーの現在値を全経路で再評価する修正は今回の範囲に含めていない。F8も仕様段階。
4. **署名URL・Storage**: 署名URLはbearer権限。保有者のAuth失効で発行済みURLが無効になるとは限らない。URL所有者、bucket公開/移動/削除/RLS、実発行元と期限の確認は未完了。HTTP・内部URL・443以外・50MiB超の既存利用があれば今回の取得制限と互換性がない。
5. **重複処理**: 承認本文の履行は共通claimで排他化した。独立したファイル添付のupload、通知、commerce callback、旧バージョン実行中の処理、通常の未承認auto投稿すべてをexactly-onceにしたわけではない。W2のretryCount/通知監査も厳密な並列カウンタではない。
6. **不確定結果**: 外部処理後にDB保存が失敗した場合はrunning/uncertainが残り、自動再送を止める。運営の照合が必要になる。これは既存の自動再試行動作への意図した変更。
7. **秘密・配備分離**: ワーカー/cronも現行service_roleを使う。最小権限ワーカーの別配備や署名鍵は今回導入していない。設定欠落時の既存DEMO自動切替、共有bot fallback、無指定の通知承認者は旧セキュリティ版の残件。今回新しい全権限fallbackは作っていない。
8. **周辺経路**: 本番キャッシュ/検索/exports/ログ/backupと既存ログ中の署名URL・秘密値は未調査・未削除。新しいログ出力の対策は過去ログを消さない。

具体的な配備・切り戻し・設定確認は [配備手順](security-release-20260916.md) を参照。

# Staffpass シチュエーション／補足ルール カタログ（草案）

**更新:** 2026-09-16 安藤（F8 承認ワークフロー（合議・定足数・最終Go）カタログ採用）  
**用途:** Staffpass／MCP ルールパック族の正本カタログ（八坂GO 2026-09-07 全採用）。
**次:** A1v2 + B1 shipped → 次箱 **F7 Stuck Watch + P0-ID/IN/RP** → **F8 承認ワークフロー（合議・定足数・最終Go）**。  
**共通軸:** WHO（誰に・どの口）／WHAT（何を出す）／WHEN・HOW（いつ・いくら・どの手段で確定）  
**共通天井:** フルオート可・テナント自己責任（ToS）。高リスク設定は警告＋明示承諾＋監査。権限外は不通。

---

## 実装優先（体感順・全部網羅）

数字は「Staffpassに載せたときの効きやすさ × 対外事故の大きさ × 既存Gatewayとの近さ」。後の章が遅いわけではなく、**同じイベントをこの順で製品化する**イメージ。

| 順 | ID | イベント | なぜこの順か（体感） |
|---:|----|----------|----------------------|
| 1 | A1 | 日程調整 | 済・継続。対外約束の入口 |
| 2 | F1 | 口のルーティング | 複数口前提。以降全部に刺さる |
| 3 | B2 | Slack／LINE等の返信 | ✅ 本番稼働。スレッド規則もここ |
| 4 | D1 | 添付・ファイル手渡し | ✅ 本番稼働。Sealith連携の本線 |
| 5 | B1 | メール送信／返信 | 対外定番。CC/BCC・添付 |
| 6 | D4 | 共用資格の貸与 | B1の次。外のサービスに入る鍵。設計ロック先行 |
| 7 | D2 | ナレッジ回答 | 秘匿漏洩の最重要ガード |
| 8 | B3 | 見積・提案の送付 | 金と期待値。松竹梅・出精値引き |
| 9 | C1 | 発注・課金 | Gatewayに近い。金額帯ゲート |
| 10 | A2 | 会議室・ブース確保 | オフライン日程の実用に必須 |
| 11 | A3 | 出張・訪問 | コスト・経路・負担区分 |
| 12 | B4 | 契約・NDA・請求 | Sealith＋規模別承認 |
| 13 | C2 | 値引き・キャンペーン | 履歴・整合性。クレーム予防 |
| 14 | F2 | 応答SLA／営業時間 | 横断。外向け翌営など |
| 15 | F3 | 言語・声 | 横断。丁寧下限・相手トーン |
| 16 | A4 | 電話・折り返し | AI Concier連携余地 |
| 17 | B5 | SNS／プレス | アカウント別・炎上停止 |
| 18 | C3 | 返金・クレーム対応 | 補償上限・エスカレーション |
| 19 | E3 | クレーム・炎上エスカレーション | 自動停止・指定上長 |
| 20 | B6 | 紹介・取り次ぎ | 双方同意・顧客重複 |
| 21 | D3 | 議事録・録音要約の共有 | 社外マスク／社内全文 |
| 22 | E2 | パートナー／代理店連絡 | 価格表出し分け・競合遮断 |
| 23 | E1 | 採用・スカウト | 媒体・個人情報・トーン合わせ |
| 24 | F4 | 自動の天井 | 済方針。全イベントのメタ |
| 25 | F5 | 監査ラベル | 済方針。全イベントのメタ |
| — | F6 | アイデンティティ開示 | 後パック。§F に詳細 |
| — | F7 | Stuck Watch | ✅ 実装GO。faultClass・W2・W1・audience補完・Admin MCP |
| — | F8 | 承認ワークフロー（合議・定足数・最終Go） | 実装GO。quorum/stages/finalGo、デフォルトOR維持、Admin MCP |

---

## A. 約束・枠を取る系

### A1 日程調整（v2 拡張 — P0-A1）
- **ルール例:** 場所親和／移動バッファ／オンライン詰め／指定カレンダー／指定ビデオ／自動confirm  
- **v2 追加 (2026-09-15):** 複数カレンダー union_busy / meetingMode (title_tag) / areaPolicy / travelFeasibility / org regionDictionary  
- **状態:** `scheduling.policy` v1 shipped + **v2 本 PR**  
- **メモ:** confirmはフルオートまで可＋高リスク承諾（`highRiskConsentAt/By` 必須）。空 calendarSources.ids → escalate fail-closed  
- **Admin MCP ツール:** `schedulingPolicy.get` / `schedulingPolicy.patch`（後方互換）  
- **スキーマ:** `orgs.scheduling_policy` / `employees.scheduling_policy` (オーバーライド、`regionDictionary` は policy jsonb 埋め込み)  
- **詳細:** `docs/scheduling-policy.md` / `docs/p0-ai-employee-ops-backlog-20260915.md`

### A2 会議室・ブース確保
- **ルール例:** 連続枠優先、空き散らばり禁止、社外同席可否  
- **分岐（追記採用）:**  
  - **ホスト側** … 部屋のグレード、備品、入退室、社外ゲスト可否  
  - **ゲスト側** … 先方指定場所への移動バッファ、オンライン併設可否  
- **Staffpass載せ方:** scheduling.policy の子ルール or `venue.policy`

### A3 出張・訪問
- **ルール例:** 都市圏、交通手段上限、宿泊可否、当日バッファ  
- **追記採用:**  
  - 経路種類とその**グレード**（例: 新幹線指定席まで／飛行機はエコノミーのみ）  
  - 費用負担: **実費精算** / **インクルード（こちら負担）** / 先方負担  
  - サービス案件では見積に「旅費の扱い」行を必須化など  
- **Staffpass載せ方:** travel.policy ＋ commerce／見積との接続

### A4 電話・折り返し
- **ルール例:** 営業時間、折り返しSLA、録音可否、外部番号の扱い  
- **追記採用:** 営業時間外の対応（録音メッセージ／翌営折り返し／緊急エスカレーション）  
- **参照:** [AI Concier](https://ai-concier.ai/)（役員会社サービス。ルール設計の参考＆将来連携候補）  
- **Staffpass載せ方:** phone surface（予約）＋通知口。会話口とは分離

---

## B. 文章を外に出す系

### B1 メール送信／返信
- **ステータス**: ✅ 本番稼働（P0-B1 本 PR）
- **SQL**: `20260915_mail_policy.sql`
- **ルール例:** CC必須、署名、敬語フロア、添付ルール、ドメイン別テンプレ  
- **追記採用:** BCC、添付は **Sealith連携**（機密は転送便、それ以外は方針）  
- **Staffpass載せ方:** mail.send ＋ ingress/egress ＋ Sealith handoff
- **Admin MCP ツール:** `mailPolicy.get` / `mailPolicy.patch`（always_human on mutate）
- **スキーマ:** `orgs.mail_policy` / `employees.mail_policy` (オーバーライド)
- **詳細:** `docs/mail-policy.md`

### B2 Slack／LINE等の返信（本番稼働）
- **ステータス**: ✅ 本番稼働（PR #42 マージ済み `2d7f32c`）
- **SQL**: `20260908_reply_policy.sql`（Grokbot 共有制御面に適用済み — テナントに SQL 実行を依頼しない）
- **ルール例:** 口の選択（F1連携）、営業時間外は下書きのみ、絵文字／短文可否  
- **追記採用:**  
  - 複数口があるときの**優先度**（F1 mouth-routing と連携、再発明しない）  
  - チャンネル／スレッド規則（例: **1トピック1スレッド**）
  - 営業時間外: `draft_only` / `hold_approval` / `allow_send`（高リスク承諾必須）
  - 絵文字: `allow` / `deny` / `limited`（許可リスト）
  - 短文: `allow` / `deny` / `warn` + 最小文字数
- **Staffpass載せ方:** 会話アダプタ＋口ルーティング（F1）＋相手台帳
- **Admin MCP ツール:** `replyPolicy.get` / `replyPolicy.patch`（always_human on mutate）
- **スキーマ:** `orgs.reply_policy` / `employees.reply_policy` (オーバーライド)
- **詳細:** `docs/reply-policy.md` / [tenant-slack-kickoff-rail.md](./tenant-slack-kickoff-rail.md) § 5

### B3 見積・提案の送付
- **ルール例:** 値引き上限、有効期限、承認者、PDFのみ／価格行の出し分け  
- **追記採用:** 内部確認時の**松竹梅**提示、**出精値引き**の有無  
- **Staffpass載せ方:** 将来 `quote.send` or mail/Drive に policyId。社外版と社内版の二重出し（混在ch思想と同型）

### B4 契約・NDA・請求
- **ルール例:** Sealith必須、社外共有期限、署名前の人確認、テンプレ以外禁止  
- **追記採用:** 承認工程が**契約規模・部署・ジャンル**で分岐  
- **Staffpass載せ方:** files／Sealith＋approval matrix（規模×部署）

### B5 SNS／プレス
- **ルール例:** アカウント別ポリシー、ハッシュタグ禁止、引用ルール、炎上時ストップ  
- **Staffpass載せ方:** sns.publish（八坂バッジ等）＋アカウント台帳

### B6 紹介・取り次ぎ
- **ルール例:** 双方同意まで詳細を出さない、紹介文の型  
- **追記採用:** **顧客重複**時の対応（どちらを優先／開示範囲／競合回避）  
- **Staffpass載せ方:** CRM／相手台帳と連携した intro.policy

---

## C. 金・発注・権限

### C1 発注・課金
- **ルール例:** 金額帯ごとの自動／要承認、ベンダー許可リスト、月次上限  
- **Staffpass載せ方:** commerce.order（既にゲートあり）をポリシー化

### C2 値引き・キャンペーン適用
- **ルール例:** 誰向けに何％まで、重複不可  
- **追記採用:**  
  - **過去取引履歴**に基づく判断  
  - 複数キャンペーン並行時の**整合性確認**（お得／不利のバラつき＝クレーム源）  
- **Staffpass載せ方:** pricing.policy（見積B3と密結合）

### C3 返金・クレーム対応
- **ルール例:** 謝罪範囲、補償上限、エスカレーション先  
- **Staffpass載せ方:** always_human寄りデフォルト＋補償上限のハードキャップ

---

## D. 情報の渡し方

### D1 添付・ファイル手渡し（本番稼働）
- **ステータス**: ✅ 本番稼働（PR #44 マージ済み / `acfd76e`）
- **ルール例:** 全文／要約／Sealith切替、上長承認  
- **状態:** `ingress_handoff_policy` 実装完了（型・検証・適用エンジン・Admin MCP・高リスク承諾）
- **Sealith:** off / suggest / required; required without transferId → fail-closed; audit sealithTransferId + jobId
- **Manager approval:** `attachmentApproval=manager` で fail-closed（承認後に添付を渡す）
- **高リスク承諾:** `attachment=file + sealith=off + classified_external_sensitive` は silent enable 禁止 → `highRiskConsentAt/By` 必須
- **Admin MCP ツール:** `ingressHandoff.get` / `ingressHandoff.patch`
- **スキーマ:** `orgs.ingress_handoff_policy` / `employees.ingress_handoff_policy` (jsonb、新規SQLなし)
- **詳細:** `docs/ingress-handoff-d1.md`
- **Admin MCP ツール:** `ingressHandoff.get` (read-only) / `ingressHandoff.patch` (always_human)
- **スキーマ:** `orgs.ingress_handoff_policy` / `employees.ingress_handoff_policy` (オーバーライド)
- **詳細:** `docs/ingress-handoff-d1.md`

### D2 ナレッジ回答
- **ルール例:** 社外は公開FAQのみ、社内は案件フォルダまで  
- **追記採用:** 外部扱いの相手には、どんな質問でも**内部秘匿は絶対に出さない**（fail-closed）  
- **Staffpass載せ方:** projectAccess／知識壁＋audience。WHATの最重要ガード

### D3 議事録・録音要約の共有
- **ルール例:** 社外版は固有名詞マスク、社内版は全文  
- **Staffpass載せ方:** dual disclosure（混在chと同型の出し分け）

### D4 共用資格の貸与（草案・2026-09-08 / 設計ロック 木村確認）
- **別名:** credential lease / AI社員向け共用アカウントの社員証貸与（「AI版1Password」ではない）
- **ステータス:** カタログ草案＋設計ロック中。設計ロックは B1 と並行可。実装は B1 安定後（実装 GO は別判断）
- **痛み:**
  - ChatGPT/Claude/Gemini 等の端末ごと手打ちログイン
  - 退職後残存する共有パスワード
  - どのAI社員が何を使ったか追えない
- **WHO/WHAT/HOW:**
  - WHO: org/employee + role tags
  - WHAT: vault item types — `oauth_ref` / `secret_ref` / `session_broker`
  - HOW: `never` / `on_invoke` / `cached_ttl` / `always_human`
  - 操作: lease / renew / revoke / rotate
  - org-wide revoke on exit / leak
- **高リスク:**
  - 本番決済・社外共用・管理者権限 → silent enable 禁止
  - 広い共用IDを社外口から使える／TTL無制限／LLM経由での資格利用 → 警告＋明示承諾
  - テナント自己責任＋ToS（共用ログイン規約リスク）を最初から明示
  - 監査（A1/D1同型）
- **Fail-closed:** 権限外・期限切れ・purpose不一致 → 秘密は渡さない
- **設計ロック（木村確認）:**
  1. Staffpass jsonb に**生シークレットを置かない**。当面は参照メタのみ（どの共用資格か・誰に貸せるか・TTL・用途・監査ID／ポインタ）
  2. 秘密本体の保管・短命注入は **Sealith 拡張が中長期本命**。専用 vault は Sealith が間に合わない／契約分離時のみ。注入はツールランタイムへ短命ハンドル。LLM／チャットには出さない
  3. 資格の CRUD・共有範囲変更は**管理エージェント＋人**。社員証側は lease された用途のツール invoke のみ
- **設計芯:**
  - モデルは鍵を見ない
  - ツールランタイムへ短命注入（短命ハンドル）
  - ログ/LLM文脈マスク
  - 人間のMacログイン同期は対象外（1Password/MDM）
- **Staffpass載せ方:**
  - パック名: `credential.policy`（または `credentialLease.policy`）
  - Admin MCP: `credentialLease.get` / `credentialLease.patch`（mutate always_human）
  - A1/D1 同型
- **境界:**
  - Staffpass = ゲート/監査（参照メタ・ポリシー・監査ログ）
  - Sealith/vault = 保管/注入（秘密本体・短命ハンドル生成）
  - 営業は「AI社員の共用アカウントを社員証で貸す」
  - 組織契約+公式コネクタ優先、残る共有IDだけvault

---

## E. 人・関係の扱い

### E1 採用・スカウト
- **ルール例:** 媒体、文面トーン、個人情報の扱い  
- **追記採用:** **相手のトーンに応じたトーン対応**  
- **Staffpass載せ方:** voice＋媒体別テンプレ＋個人情報egress

### E2 パートナー／代理店連絡
- **ルール例:** 価格表の出し分け、競合情報の遮断  
- **Staffpass載せ方:** 相手区分＝partner の専用マトリクス

### E3 クレーム・炎上エスカレーション
- **ルール例:** 自動返信停止、指定上長のみ  
- **Staffpass載せ方:** kill-switch＋承認者allowlist（メンション相手＝承認者にしない方針は維持）

---

## F. 横断ルール

### F1 口のルーティング（S3 本番稼働）
- **ステータス**: ✅ 本番稼働（PR #40 マージ済み）
- 「この相手はLINE、社内はSlack」など状況別既定口  
- 会話口と承認通知口は混ぜない（確定方針）  
- 優先: Slack → LINE → Chatwork → Messenger（会話）
- **S3 二重ゲート**: `dualEgress` の内部/外部判定が異なる場合、チャネル投稿は external-safe、内部向け詳細は DM / 限定スレッドへ分離配信
- **Fail-closed**: 未知 / 外部混在で解決不能な内部パーティ → 内部漏洩なし（hold / deny）
- **型**: `MouthRoutingPolicy` / `MouthRoutingDecision` / `OrgMouthRoutingPolicy`
- **Admin MCP**: `mouthRoutingPolicy.get` / `mouthRoutingPolicy.patch`（将来）
- **Wake stance（ロック）**: 社内=Bot、外部Connect=個人、混在=Bot可なら Bot else 個人（[tenant-slack-kickoff-rail.md](./tenant-slack-kickoff-rail.md) § Wake stance）
- **詳細**: `docs/egress-policy.md` § S3 / [tenant-slack-kickoff-rail.md](./tenant-slack-kickoff-rail.md)

### F2 応答SLA／営業時間
- 外向けは翌営、内向けは即時可、時間外は下書きのみ 等

### F3 言語・声
- 社外は丁寧下限、相手言語に合わせる、相手トーン追従（E1と共有）

### F4 自動の天井（済）
- フルオート可／ToS自己責任／高リスクは警告＋承諾

### F5 監査ラベル（済）
- どのルールで残ったか／落ちたか／なぜその文面かを残す

### F6 アイデンティティ開示（予約・F1隣接）
- **ステータス**: 📋 設計予約（F1と隣接だが別ポリシー族）
- **用途**: 「あなたは誰？」「AIですか？」「どの組織？」「録音してる？」への応答制御
- **WHO×WHAT 開示**: audience（internal / external）に応じて allow / deny / template を返す
- **F1との境界**: F1 は「何をどの口へ出すか」、F6 は「自己紹介・正体開示の可否」
  - F1 `MouthRoutingPolicy` は **コンテンツの配信先制御**
  - F6 `DisclosurePolicy`（仮）は **エージェント自身に関するQ&A応答**
- **例**: 
  - 社外: 「Staffpassを利用した自動返信です」（テンプレ）
  - 社内: 「AI社員 八坂です。録音は上長承諾済みです」
- **実装予定**: F1完了後の次パック。型予約のみ、本PRでは実装しない
- **拡張点**: `lib/gateway/disclosure-policy.ts`（予約）

### F7（旧採番）内部オーディエンスルール（stablo規模チャネル対応）
> **注記:** 旧F7採番・本番済み／2026-09-15以降のカタログF7は **Stuck Watch**（下記）。本節は shipped 内部オーディエンス機能の記録。

- **ステータス**: ✅ 本番稼働（旧F7採番）
- **用途**: 大規模チャネル（#stablo_tokyo307 等）で毎アカウントを parties.upsert で登録するのが破綻する問題を解決
- **ルール設計**: Internal = parties allowlist UNION emailDomains UNION slackTeamIds
- **Fail-closed**: Connect ゲスト / 未登録 → external
- **型**: `OrgInternalAudienceRule` / `lib/data/internal-audience-rule.ts`
- **Admin MCP ツール**: `internalAudienceRule.get` (read-only) / `internalAudienceRule.patch` (always_human)
- **スキーマ**: `orgs.internal_audience_rule` (jsonb)
- **例**: `#stablo_tokyo307` Connect チャネル — 自社Slackチーム `T_STABLO_307` のメンバーは自動で内部扱い、外部ゲストは fail-closed で外部扱い

### F7 Stuck Watch — 不当停止の検知と再発火
- **ステータス**: 実装GO（2026-09-15）／実装予定
- **カタログID**: F7（2026-09-15 以降の製品F7）
- **用途**: AI社員オペの不当停止（メンション未返信・承認後未fulfill・課金ゲート誤爆等）を観測し、安全な範囲で再発火。直せないものは運用口へ出す
- **faultClass（F5拡張）**: `expected_gate`（正当ゲート・再発火しない）／`ops_fault`（自動リトライ対象）／`config_drift`（通知のみ）
- **ウォッチ P0**:
  - W1 メンション未返信（デフォルト15分）
  - W2 承認後未fulfill（デフォルト5分）→ 自動reinvoke max2・auto-fulfill #53 系と統合（重複実装しない）
  - W3 ops_fault連続（K=2で停止）
  - W4 config_driftは通知のみ
- **StuckWatchPolicy**: `orgs.stuck_watch_policy` jsonb — enabled, mentionUnansweredMinutes, approvedUnfulfilledMinutes, maxAutoRetries=2, retryBackoffSeconds, autoRetryFaultClasses=["ops_fault"], notifyMouth, inferInternalAudienceFromLedger=true
- **Admin MCP ツール**: `stuckWatch.get` / `stuckWatch.patch` / `stuckWatch.list` / `stuckWatch.inspect` / `stuckWatch.retry` / `stuckWatch.resolve` / `stuckWatch.classify`（summaryJa/nextStepJa）
- **Employee MCP（任意）**: `staffpass_stuck_list` / `staffpass_stuck_retry`
- **invoke 拡張**: 失敗レスポンスに `faultClass` + `stuckHint`（`retryable` / `fix` / `wait_approval`）
- **カット順**: faultClass → W2 → W1 → audience補完 → Admin MCP → employee任意
- **詳細**: `docs/f7-stuck-watch-20260915.md`

### F8 承認ワークフロー（合議・定足数・最終Go）
- **ステータス**: 実装GO（2026-09-16）
- **カタログID**: F8（横断メタ）
- **用途**: みらい社中など「上司3人の合議 → 定足数 → 最終Go担当」が必要な組織向け。現行の1人承認（OR）はデフォルト維持
- **概念**:
  - **QuorumRule**: `any`（現行互換・1人完了）/ `count`（N人以上）/ `ratio`（例: 2/3）/ `majority`（過半数）
  - **ApprovalLane**: 合議段階。voterUserIds + quorum + onReject（`fail_closed` / `count_as_vote`）
  - **ApprovalWorkflow**: stages（順次合議）+ finalGoUserId（最終Go担当、省略可）+ match（対象tools/purposes）
- **ランタイム**: invoke → workflowInstance 作成 → stage0 全 voter にカード配信 → quorum 達成で次 stage → finalGo → fulfill
- **既存互換**: workflow 未設定 → 現行 `any`（1人承認）、allowedUserIds のみ → OR
- **Admin MCP ツール**: `approvalWorkflow.get` / `approvalWorkflow.patch`（always_human）/ `approvalWorkflow.inspect` / `approvalWorkflow.remind`（always_human）
- **Employee MCP（任意）**: `staffpass_approval_ballot_status`（自分の票と進捗）
- **AC（受け入れ条件）**:
  - W1: workflow 未設定orgでは現行どおり1人承認で通る（回帰）
  - W2: ratio 2/3 で voters=3 のとき approve 2 で stage 達成、1では未達
  - W3: majority で voters=3 のとき 2 で達成
  - W4: reject 1（fail_closed）で instance 全体が rejected、fulfill されない
  - W5: finalGoUserId 設定時、合議達成後も最終票まで外向け send されない
  - W6: 各票が監査に残る（actor, stage, vote, at）
  - W7: Admin MCP だけで patch / inspect ができる
  - W8: Slack（または設定口）に進捗付きカードが届く
- **カット順**: データ模型 → エンジン（quorum計算+fail_closed）→ finalGo → カードUI進捗 → Admin MCP → みらい社中プリセット
- **みらい社中パイロット**: org設定、AI社員1体（対外Slack/mail、対内企画・経費窓口）、上司3人合議（2/3 or majority）＋最終Go担当
- **詳細**: `docs/staffpass-approval-workflow-quorum-20260916.md`

---

## 前進方針（2026-09-08 → 2026-09-15 更新）

1. ✅ 本カタログを repo に掲載
2. ✅ **A1 `scheduling.policy`** shipped（CRUD・policyId・fail-closed・監査・高リスク承諾・フルオート天井）
   - `lib/scheduling-policy/` に実装
   - Admin MCP: `schedulingPolicy.get` / `schedulingPolicy.patch`
   - 詳細: `docs/scheduling-policy.md`
3. ✅ **F1 口ルーティング** shipped（PR #40 マージ済み・本番稼働）
   - dual-gate S3: チャネル body = external-safe、内部詳細 → DM / 限定スレッド
   - multi-mouth priority: Slack → LINE → (Chatwork/Messenger: 予約)
   - Admin MCP（将来）: `mouthRoutingPolicy.get` / `mouthRoutingPolicy.patch`
   - キックオフガイダンス: `docs/tenant-slack-kickoff-rail.md`
4. ✅ **B2 返信ポリシー**（PR #42 マージ済み `2d7f32c`・本番稼働）
   - 営業時間外動作: `draft_only` / `hold_approval` / `allow_send`（高リスク承諾必須）
   - 絵文字/短文制御: ポリシーノブ
   - スレッド親和性: `prefer_thread` / `new_thread_per_topic` / `channel_root`
   - F1 mouth-routing と連携（再発明しない）
   - Admin MCP: `replyPolicy.get` / `replyPolicy.patch`
   - SQL: `20260908_reply_policy.sql`（Staging 警告: Grokbot 共有制御面に適用済み）
   - 詳細: `docs/reply-policy.md` / [tenant-slack-kickoff-rail.md](./tenant-slack-kickoff-rail.md) § 5
5. ✅ **D1 添付・ファイル手渡し**（PR #44 マージ済み・本番稼働）
   - policyId/policyName on ingress_handoff_policy
   - 高リスク承諾: `attachment=file + sealith=off + classified_external_sensitive` → `highRiskConsentAt/By` 必須
   - Slack wake 監査: policyId/ruleId/attachmentApproval/pendingManagerApproval
   - Sealith = encryption handoff; Staffpass = behavior boundary
   - 新規SQLなし（既存 jsonb カラムを使用）
   - Admin MCP: `ingressHandoff.get` / `ingressHandoff.patch`
   - 詳細: `docs/ingress-handoff-d1.md`
6. ✅ **B1**（メール送信／返信）— shipped
7. 🔧 **次箱 F7 Stuck Watch + P0-ID/IN/RP**（F7 は faultClass+W2 から並行可）
   - faultClass（F5拡張）→ W2（#53 統合）→ W1 → audience補完 → Admin MCP → employee任意
   - 実装GO 2026-09-15／実装予定
   - 詳細: `docs/f7-stuck-watch-20260915.md`
8. 🔧 **F8 承認ワークフロー（合議・定足数・最終Go）**
   - quorum（any/count/ratio/majority）+ stages + finalGo + fail_closed
   - 現行1人承認（OR）はデフォルト維持。workflow は org/employee/tool で opt-in
   - Admin MCP: `approvalWorkflow.get` / `approvalWorkflow.patch` / `approvalWorkflow.inspect` / `approvalWorkflow.remind`
   - AC: W1–W8（回帰・quorum計算・reject・finalGo・監査・MCP・UI進捗）
   - みらい社中パイロット: 上司3人合議（2/3 or majority）＋最終Go担当
   - 実装GO 2026-09-16
   - 詳細: `docs/staffpass-approval-workflow-quorum-20260916.md`
9. 📋 **D4 共用資格の貸与**（設計ロック中・木村確認済み）
   - 設計ロックは B1 と**並行可**
   - 実装は B1 安定後（実装 GO は別判断）
   - Staffpass jsonb には参照メタのみ（生シークレット置かない）
   - 保管・注入は Sealith 拡張が中長期本命
   - パック名: `credential.policy` or `credentialLease.policy`
   - Admin MCP: `credentialLease.get` / `credentialLease.patch`（mutate always_human）
10. 📋 **F6 アイデンティティ開示** — 後パック
11. AI Concier は A4 の参考・将来連携として別枠

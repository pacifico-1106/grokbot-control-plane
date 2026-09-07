# Staffpass シチュエーション／補足ルール カタログ（草案）

**更新:** 2026-09-07 安藤（八坂ブレスト＋追記を全採用）  
**用途:** Staffpass／MCP ルールパック族の正本カタログ（八坂GO 2026-09-07 全採用）。
**次:** A1 `scheduling.policy` 本番稼働 → F1 口ルーティング 本番稼働 → B2 次箱。  
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
| 4 | D1 | 添付・ファイル手渡し | 一部済。Sealith連携の本線 |
| 5 | B1 | メール送信／返信 | 対外定番。CC/BCC・添付 |
| 6 | D2 | ナレッジ回答 | 秘匿漏洩の最重要ガード |
| 7 | B3 | 見積・提案の送付 | 金と期待値。松竹梅・出精値引き |
| 8 | C1 | 発注・課金 | Gatewayに近い。金額帯ゲート |
| 9 | A2 | 会議室・ブース確保 | オフライン日程の実用に必須 |
| 10 | A3 | 出張・訪問 | コスト・経路・負担区分 |
| 11 | B4 | 契約・NDA・請求 | Sealith＋規模別承認 |
| 12 | C2 | 値引き・キャンペーン | 履歴・整合性。クレーム予防 |
| 13 | F2 | 応答SLA／営業時間 | 横断。外向け翌営など |
| 14 | F3 | 言語・声 | 横断。丁寧下限・相手トーン |
| 15 | A4 | 電話・折り返し | AI Concier連携余地 |
| 16 | B5 | SNS／プレス | アカウント別・炎上停止 |
| 17 | C3 | 返金・クレーム対応 | 補償上限・エスカレーション |
| 18 | E3 | クレーム・炎上エスカレーション | 自動停止・指定上長 |
| 19 | B6 | 紹介・取り次ぎ | 双方同意・顧客重複 |
| 20 | D3 | 議事録・録音要約の共有 | 社外マスク／社内全文 |
| 21 | E2 | パートナー／代理店連絡 | 価格表出し分け・競合遮断 |
| 22 | E1 | 採用・スカウト | 媒体・個人情報・トーン合わせ |
| 23 | F4 | 自動の天井 | 済方針。全イベントのメタ |
| 24 | F5 | 監査ラベル | 済方針。全イベントのメタ |

---

## A. 約束・枠を取る系

### A1 日程調整（実装中 → shipped-slice）
- **ルール例:** 場所親和／移動バッファ／オンライン詰め／指定カレンダー／指定ビデオ／自動confirm  
- **状態:** `scheduling.policy` 実装完了（型・検証・適用エンジン・Admin MCP）  
- **メモ:** confirmはフルオートまで可＋高リスク承諾（`highRiskConsentAt/By` 必須）
- **Admin MCP ツール:** `schedulingPolicy.get` / `schedulingPolicy.patch`
- **スキーマ:** `orgs.scheduling_policy` / `employees.scheduling_policy` (オーバーライド)
- **詳細:** `docs/scheduling-policy.md`

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
- **ルール例:** CC必須、署名、敬語フロア、添付ルール、ドメイン別テンプレ  
- **追記採用:** BCC、添付は **Sealith連携**（機密は転送便、それ以外は方針）  
- **Staffpass載せ方:** mail.send ＋ ingress/egress ＋ Sealith handoff

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

### D1 添付・ファイル手渡し（shipped）
- **ルール例:** 全文／要約／Sealith切替、上長承認  
- **状態:** `ingress_handoff_policy` 実装完了（型・検証・適用エンジン・Admin MCP・高リスク承諾）
- **Sealith:** off / suggest / required; required without transferId → fail-closed; audit sealithTransferId + jobId
- **Manager approval:** `attachmentApproval=manager` で fail-closed（承認後に添付を渡す）
- **高リスク承諾:** `attachment=file + sealith=off + classified_external_sensitive` は silent enable 禁止 → `highRiskConsentAt/By` 必須
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

---

## 前進方針（2026-09-08）

1. ✅ 本カタログを repo に掲載
2. ✅ **A1 `scheduling.policy`** でルールパック型を固定（CRUD・policyId・fail-closed・監査・高リスク承諾・フルオート天井）
   - `lib/scheduling-policy/` に実装
   - Admin MCP: `schedulingPolicy.get` / `schedulingPolicy.patch`
   - 詳細: `docs/scheduling-policy.md`
3. ✅ **F1 口ルーティング**（PR #40 マージ済み・本番稼働）
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
5. 次箱 **D1**（添付・ファイル手渡し）→ B1
6. **F6 アイデンティティ開示** は F1 の後（予定）
7. AI Concier は A4 の参考・将来連携として別枠

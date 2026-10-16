# `/app/audit` 可読性 — 提案と見積もり（2026-10-16）

- **状態:** 提案ドラフト。**実装しない。** 本 PR は本ドキュメントのみ。
- **依頼:** オーナーフィードバック。`/app/audit` は「どの AI 社員か」は分かるが、「何をしたか」が分からない。
- **対象:** テナントダッシュボード `/app/audit`（ナビ表記は「閲覧」）。ダッシュボード先頭の変更ログ（admin クラスのみ）は対象外。ただしラベル表は共用する。
- **正本の優先:** 既存の赤消し・秘密検出・テナント境界を緩めない。監査行は追記専用（改ざんしない）。

---

## 0. 要約（先に結論）

| 項目 | 決めたこと |
|---|---|
| 行に出すもの | 行為者（人 / AI・氏名・メール）／JST 日時／日本語の操作名／対象／秘密をマスクした要約／承認の要否と承認者／結果（成功・失敗・拒否）と理由 |
| 展開 | 行を開くと詳細ドロワー。生 JSON・本文全文・payload・`statusToken` / `pollPath` は出さない |
| 既存データ | 列の大半は既にある。足りないのは**読み取り投影**と**日本語ラベル**と**対象の解決**。監査行の書き換え（backfill UPDATE）はしない |
| マイグレーション | 表示だけなら不要。フィルタ／検索の索引は必要。チャネル表示名を台帳に持つなら任意で 1 本 |
| 生 payload | **UI から落とす。** いま `JSON.stringify(metadata)` を出しており、`pollPath` や宛先メールがそのまま見える |

**推奨分割:** 下の PR-1 〜 PR-5。合計 **12 人日**。本ドキュメントは PR-0。

| PR | 内容 | 人日 | マイグレーション |
|---|---|---:|---|
| **0** | 本設計 | — | 不要 |
| **1** | 読み取り投影・日本語ラベル・結果・生 JSON 廃止・ドロワー骨格 | 3 | 不要 |
| **2** | 行為者（人/AI・氏名・メール）・承認チケット結合 | 2 | 不要 |
| **3** | 対象解決・要約（既存 redaction / secret detection） | 3 | 任意（`org_channels.display_name`） |
| **4** | 理由コード日本語・フィルタ／検索 | 3 | **必要**（索引） |
| **5** | 書き込み側の metadata 契約（新規行のみ） | 2 | 不要（列追加なし） |

実装開始は PR-1。PR-3 の任意マイグレーションは「チャネル名が ID のまま残る」を許容するなら後回し可。

---

## 1. オーナーが行に見たいもの（受け入れ条件）

各行（折りたたみ時）:

1. **行為者** — 人か AI か。氏名とメール。
2. **日時** — JST（いまの `toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })` を維持）。
3. **操作** — ツール名の日本語。例: `Slackにメッセージを送信`（生の `tool.invoke` や `comm.reply` をチップに出さない）。
4. **対象** — チャネル、宛先、社員など。
5. **内容の要約** — 秘密はマスク。本文全文は置かない。
6. **承認** — 要ったか。誰が承認したか。
7. **結果** — 成功 / 失敗 / 拒否。理由（日本語）。

行を開くと詳細（同じ情報の非短縮版 + 安全なメタ: `jobId`・`approvalId` 先頭・情報区分・拒否コード）。**生 payload は出さない。**

---

## 2. 現状調査

### 2.1 スキーマ `audit_events`

`supabase/schema.sql`（列は 2026-08 以降ほぼ不変）:

| 列 | 型 | 用途 | UI で使っているか |
|---|---|---|---|
| `id` | uuid PK | 行 ID | キーのみ |
| `org_id` | uuid NOT NULL | テナント | クエリのみ |
| `employee_id` | uuid NULL FK | AI 社員 | 表示名解決に使用 |
| `credential_id` | uuid NULL FK | 社員証 | 未表示 |
| `actor_email` | text NULL | 人の操作者 | **マッパーが捨てている** |
| `action` | text NOT NULL | 自由文字列。TS の `AuditAction` は目安 | 生の英語チップ |
| `purpose` | text NULL | 目的キー | 小さく表示 |
| `summary` | text NOT NULL | 日本語が多いがツール ID 混在 | 本文として表示 |
| `metadata` | jsonb DEFAULT `{}` | 不定形 | **生 JSON を `<pre>` に全出し** |
| `created_at` | timestamptz | 発生時刻 | JST 表示済み |

索引は `(org_id, created_at desc)` のみ。`action` / `employee_id` / `metadata` の索引なし。

RLS: `SELECT` は `is_org_member(org_id)`。INSERT/UPDATE/DELETE は authenticated から revoke 済み。追記は service role の `appendAuditEvent`（`lib/data/audit.ts`）と少数の RPC／直接 insert。

別テーブル `audit_external_contract_card_events` はカード登録専用（PAN 禁止）。本提案の `/app/audit` 対象外。カード行を混ぜない。

### 2.2 読み取り経路

- `listAuditEvents(orgId, limit=100)` — `/app/audit` がこれだけ。フィルタなし。直近 100 件。
- `mapAuditRow` は `actor_email` を **捨てる**。`AuditEvent` 型にも無い。
- ページは `view_audit` を見ていない。`/app/*` は組織メンバーなら入れる。RBAC の「監査ログ閲覧」はナビ非連動。
- 行為者は `actorLabel(employee, employeeId)`。社員があれば表示名、なければ ID か「不明」。**人か AI かの区別もメールも出ない。**
- 日時は既に JST。
- `JSON.stringify(ev.metadata)` を出す。`redactMetadata`（`lib/data/redaction.ts`）は承認の公開ビュー等では使うが、**監査ページでは未使用**。

### 2.3 書き込み経路

正本は `appendAuditEvent`。`org_id` は呼び出し側の認証済み資格情報／セッションの org。クライアント指定 org は使わない（秘密検出監査も同様）。

主な書き手:

| 系統 | 代表 action | metadata に多いキー |
|---|---|---|
| Gateway `lib/gateway/invoke.ts` | `tool.invoke`, `slack.posted`, `slack.post_failed`, `comm.not_sent`, `action_limit.denied`, `topic_gate.triggered` | `tool`, `jobId`, `destination`, `approvalId`, `code`, `sent`, `egress`, `phase` |
| 承認 `lib/data/approvals.ts` | `approval.requested` / `resolved` / `revision_requested` | `approvalId`, `tool`, `jobId`, `risk`, **`pollPath`**, `decision`, `resolvedBy` |
| Admin MCP `lib/admin-mcp/queue.ts` / `fulfill-admin.ts` | `admin.*` | `tool`, `approvalId`, `auditClass` |
| 設定変更 | `config.change_*` | 差分要約。本文全文は置かない方針 |
| 秘密検出 `lib/security/secret-detection-audit.ts` | `secret_detection.blocked` / `suspected` | `surface`, `tool`, `pattern`, `fieldPath`, `matchLength`。**値・本文・ハッシュ禁止** |
| 起動（wake） | `slack.mention_wake` 等 | チャネル ID。本文なし |
| 緊急停止 | `employee.hold.*` | 社員 ID、理由コード |
| 課金・プラン | `plan.*`, `billing.updated` | プランキー |
| 直接 insert | `approvals.ts`, `employees.ts`, 一部 SQL 関数 | `appendAuditEvent` と同じ列 |

`action` に DB 制約は無い。`AuditAction` ユニオンに無い文字列も入る。

### 2.4 フィールドの過不足（オーナー項目との対応）

| 行に出したいもの | 既にある | 足りない |
|---|---|---|
| 行為者: 人 / AI | `employee_id` があれば AI と推定可。人は `actor_email` に入ることがある | 型・マッパー・UI。AI のメール（メールボックス）は別表。両方 null のシステム行 |
| 氏名 | AI: `employees.display_name`。人: `org_members.display_name`（メールで結合） | 人の氏名を出していない |
| メール | 人: `actor_email`。AI: `employees.approval_notify_email` または identity mailbox | マッパー欠落。AI は社員表に「本人メール」列が無い |
| JST | `created_at` | なし（済み） |
| 日本語の操作 | Gateway に `labelJa`。Admin に `ADMIN_TOOL_TITLE_JA`（一部）。承認カード用の要約 | 監査は生 `action`。`tool.invoke` が大半で「何のツールか」は `metadata.tool` 側 |
| 対象 | しばしば `metadata.destination` / `channel` / 承認 `artifact` | 生 ID（`C…` / `U…` / メール全文）。`org_channels` に表示名列なし。`org_parties` は identifier のみ |
| 要約 | `summary` は日本語が多い | ツール ID 混在。長さ不定。メール本文を含む承認 artifact は監査 metadata には通常載らないが、dump すると egress 等が出る |
| 承認の要否 | `metadata.approvalId`、`action=approval.requested`、`auto: true` | 行単体では「要った／通った／不要」が正規化されていない |
| 承認者 | `actor_email` on `approval.resolved`、`metadata.resolvedBy`、`approval_requests.resolved_by` | 監査 UI は結合していない。Slack `U…` 形式のこともある |
| 結果 | action 接尾辞（`.failed` / `.denied`）と `metadata.code` / `sent` / `decision` | 成功・失敗・拒否の正規化なし |
| 理由の日本語 | 各モジュールに `messageJa` / `REASON_JA` が散在 | 監査 UI はコードを出さないか、英語コードのまま |

**結論:** 新規必須列は無い。足りないのは (1) `actor_email` を読む、(2) `metadata.tool` と action を日本語化する、(3) 対象を名前に解決する、(4) 承認行と JOIN する、(5) 結果と理由を投影する、(6) 生 JSON をやめる。

### 2.5 いまの行がオーナーにどう見えるか

典型的な Gateway 成功行:

- チップ: `tool.invoke`
- 日時: JST（可）
- 行為者: AI 表示名 + employee UUID
- 要約: `comm.reply を自動実行`
- `<pre>`: `{ "tool": "comm.reply", "destination": "C0123…", "auto": true, "egress": { … } }`

「Slack のどのチャネルに何を送ったか」「承認は要ったか」「成功したか」は、生 JSON を読まないと分からない。失敗行は `slack.post_failed` と `code` が JSON 内。承認待ちは別行 `approval.requested` で、invoke 行と並ぶ。

---

## 3. 提案: 読み取り投影

監査テーブルは追記専用のまま。**表示は Read Model**（`lib/audit/presentation.ts` 相当）で組み立てる。

```
audit_events ──► presentAuditRow(org-scoped lookups) ──► AuditRowView
approval_requests ─┘
employees / org_members / org_channels / org_parties / identity mailbox
```

`AuditRowView`（提案）:

```ts
type ActorKind = "ai" | "human" | "system";
type AuditResult = "success" | "failure" | "denied" | "pending" | "unknown";

type AuditRowView = {
  id: string;
  createdAtJst: string;          // 2026-10-16 12:34 JST
  actor: {
    kind: ActorKind;
    name: string;                // 空にしない（不明）
    emailMasked: string | null;  // リストはマスク。詳細も原則マスク
    employeeId: string | null;
  };
  action: {
    id: string;                  // metadata.tool || action
    labelJa: string;             // Slackにメッセージを送信
  };
  target: {
    kind: "slack_channel" | "slack_user" | "email" | "employee" | "member" | "sns" | "other" | "none";
    labelJa: string;             // #cs-mentions / 安藤 / a***@example.com
    rawId: string | null;        // 詳細のみ。リストには出さない
  };
  summary: string;               // 秘密検出通過済み・短文
  approval: {
    needed: boolean | null;      // null = 旧行で不明
    approvalId: string | null;
    status: "none" | "pending" | "approved" | "rejected" | "expired" | "revision_requested" | "unknown";
    approverName: string | null;
    approverEmailMasked: string | null;
  };
  result: {
    kind: AuditResult;
    reasonCode: string | null;
    reasonJa: string | null;
  };
};
```

リストは上記のみ。ドロワーは同じ型の非短縮 + 安全キー（`jobId`, `purpose`, `risk`, `informationClass`, `audience`, `approvalId` 先頭 8 文字）。`metadata` 生オブジェクトは渡さない。

### 3.1 行為者

| 条件 | kind | 氏名 | メール |
|---|---|---|---|
| `employee_id` あり | `ai` | `employees.display_name`（無ければ ID、最後に「不明」） | identity mailbox があればマスクして出す。無ければ `approval_notify_email` は**出さない**（通知先であり本人メールではない）。「メールなし」 |
| `actor_email` あり・社員なし | `human` | `org_members.display_name`（同一 org・同一メール） | `actor_email` をマスク |
| Slack/LINE プレフィックス `slack:U…` など | `human` | 承認者バインディングの表示名。無ければ「Slack 承認者」 | メンバーに解決できればマスクメール。できなければ null |
| 両方なし | `system` | 「システム」 | null |

リストも詳細も **メールはマスク**（§7.2）。オーナー文面の「メール」は「誰か識別できること」であり、監査画面で平文メールを増やす理由にはしない。人の氏名は出す。

### 3.2 操作の日本語

優先順:

1. `metadata.tool`（Gateway / Admin MCP のツール ID）
2. 無ければ `action`
3. マップに無ければ `action` をチップに出さず「その他の操作（{id}）」

Gateway の既存 `labelJa` はカード向けで長い（例: `会話返信（相手×情報区分）`）。監査行はオーナー例に合わせ **短い操作名** を別表にする。Gateway の `labelJa` はフォールバック。

`tool.invoke` という action は UI に出さない。必ず `metadata.tool` 側の日本語。

### 3.3 対象の解決

信頼の順（上ほど信頼）:

1. **自 org の台帳** — `org_channels.external_id`、`org_parties.identifier`、`employees`、`org_members`。いずれも `org_id` 必須。
2. **書き込み時に残した表示名** — `metadata.channelName` 等。秘密検出を通したものだけ。エージェント入力なので「参考」。
3. **生 ID** — `C…` / `U…` / メールマスク。ラベルは「名称不明（C0123abcd）」。

**リスト表示中に Slack `conversations.info` は呼ばない**（遅延・トークン・失敗面）。名前を安定させたい場合のみ PR-3 で `org_channels.display_name` を分類・join 時に保存（任意マイグレーション）。

| 対象 | 解決 |
|---|---|
| Slack チャネル | 台帳名 → metadata.channelName → `#` + ID 短縮 |
| Slack ユーザ / DM | 社員 Slack identity の displayName → パーティ → `U…` 短縮 |
| メール宛先 | ローカル部マスク。複数は「3 件（a***@x, b***@y, 他1）」 |
| AI 社員（雇用・停止など） | `employees.display_name` |
| メンバー（招待・権限） | `org_members.display_name` |
| SNS | `snsSurfaceLabelJa`（X / note / LinkedIn / YouTube） |
| なし | 「—」 |

メール・電話・LINE ID はリストに全文を出さない。

### 3.4 要約（秘密を出さない）

新規に本文を保存しない。既存 `summary` を短く再構成する。

規則:

1. 既存 `redactMetadata` のキー削除（`statusToken`, `pollPath`, `password`, `botToken`, …）。
2. 残テキストを `detectSecretInString`。hit / suspected → そのフィールドを `[redacted]`。値・プレフィックス・ハッシュは残さない（`secret-detection-audit.ts` と同じ）。
3. 本文・プロンプト・CoT・添付 URL は出さない。メールは件名（検出後）+ 宛先マスクまで。Slack は「#名前 に返信」まで。`ApprovalArtifact.body` は承認カード用であり監査リストに載せない。
4. 上限: リスト 80 字、ドロワー 200 字。超過は切る。
5. カード様パターンは `[CARD_DATA_REDACTED]`。

書き込み側（PR-5）は `summary` にツール ID を混ぜず、本文を入れないことをテストで固定する。既存の良い例: `秘密情報の可能性がある値を検出して拒否（aws_access_key）`。

### 3.5 承認チケット結合

`approval_requests` は同一 `org_id` のみ。

結合キー（先勝ち）:

1. `metadata.approvalId`
2. 同一 org + `metadata.jobId` + `employee_id` の最新チケット（曖昧なら結合しない）

| 投影 | 取り方 |
|---|---|
| 承認不要 | `metadata.auto === true` かつ approvalId なし、または ping/read 系 |
| 承認待ち | チケット `pending`、または action `approval.requested` |
| 承認済み | チケット `approved`。承認者は `resolved_by` → メンバー氏名、なければ `metadata.resolvedBy` |
| 却下 / 期限切れ / 差戻し | チケット status。結果は `denied`（却下・期限）または `pending`（差戻し） |
| 旧行 | `needed: null`, `status: "unknown"`。推測で「不要」にしない |

`pollPath` / `statusToken` は結合に使っても **View に出さない。** いま `approval.requested` の metadata に `pollPath` が入っており、生 JSON 表示が事故になる。

リストの N+1 を避けるため、ページ内の `approvalId` をまとめて `org_id IN (...)` で取る。

### 3.6 結果

| kind | いつ |
|---|---|
| `success` | `*.posted` / `*.sent` / fulfill 成功 / `metadata.sent === true` / 自動実行で code なし |
| `failure` | `*.failed` / `*.apply_failed` / 配信失敗（実行したが届かず） |
| `denied` | `*.denied` / `*.refused` / `egress_denied` / `secret_detection.blocked` / 承認却下 / 緊急停止で未実行 |
| `pending` | 承認待ち・差戻し |
| `unknown` | 旧行で判定不能 |

失敗と拒否を混ぜない。拒否はポリシーが止めた。失敗はプロバイダ／実装が止めた。

### 3.7 旧行

監査はイミュータブル。UPDATE で要約や表示名を書き戻さない。

| 欠けるもの | 読み取り時 |
|---|---|
| `metadata.tool` なし | `action` の日本語。無ければ「その他の操作」 |
| チャネル名なし | ID 短縮 + 「名称不明」 |
| `actor_email` なし・社員なし | システム |
| 承認 ID なし | 承認「不明」。auto フラグがあるときだけ「不要」 |
| 結果が取れない | `unknown` / 理由なし |
| summary が長い・英語 | その場で赤消し・切り詰め。原文は DB に残す |

デモデータも同じ投影を通す。

---

## 4. 日本語ラベル表

実装は `Record<string, string>` を 1 か所（`lib/audit/labels-ja.ts`）。欠ける ID はテストで落とす（Gateway 全 ID、Admin MCP 全名、`AuditAction` 全値）。

以下が提案の正本。括弧は既存コードの ID。

### 4.1 Gateway ツール（監査行用・短名）

| ID | 監査ラベル | 既存 `GATEWAY_TOOL_DEFS.labelJa`（参考） |
|---|---|---|
| `tools.ping` | ヘルス確認 | ヘルス確認 |
| `tools.read` | ツールの参照 | ツール読取 |
| `calendar.read` | カレンダーを参照 | 社内カレンダー参照 |
| `calendar.propose` | 空き枠を提案 | 空き枠の提案 |
| `calendar.confirm` | 日程を確定 | 日程の確定（invite / 承諾） |
| `calendar.allowlist.patch` | カレンダー許可リストを変更 | カレンダー参照許可リスト変更 |
| `mail.draft` | メールの下書き | メール下書き |
| `mail.send` | メールを送信 | メール送信 |
| `agentmail.draft` | AgentMail の下書き | AgentMail 下書き（P0.5予約） |
| `agentmail.send` | AgentMail を送信 | AgentMail 送信（P0.5予約） |
| `files.read` | ファイルを参照 | ファイル読取 |
| `files.write` | ファイルを更新 | ファイル書込 / マスタ更新 |
| `browser.use` | ブラウザを操作 | ブラウザ利用 |
| `commerce.quote` | 見積を作成 | 見積作成 |
| `commerce.order` | 発注する | 発注・購入 |
| `slack.post` | Slackにメッセージを送信 | Slack 投稿（エイリアス・相手解決が境界） |
| `slack.post_external` | Slackにメッセージを送信 | Slack 投稿エイリアス（ツール名は境界ではない） |
| `comm.reply` | Slackにメッセージを送信 | 会話返信（相手×情報区分） |
| `comm.send` | Slackにメッセージを送信 | 会話送信（相手×情報区分） |
| `comm.delete` | 自分の投稿を削除 | 自分の投稿の削除（記録済みの自分の投稿のみ） |
| `sns.publish` | SNSに投稿 | 個人SNS投稿（X / note / LinkedIn / YouTube） |
| `drive.share_external` | Driveの社外共有リンクを発行 | Drive 社外共有リンク発行 |
| `knowledge.search` | 社内ナレッジを検索 | 社内ナレッジ検索 |
| `approvals.request` | 承認を依頼 | 承認申請 |
| `audit.append` | 監査に追記 | 監査追記 |

`comm.reply` / `comm.send` / `slack.post*` はオーナースケッチどおり同じ「Slackにメッセージを送信」。ドロワーで reply / send とチャネル分類を出す。LINE 送信が乗った行は表面を見て「LINEにメッセージを送信」。

### 4.2 社員 MCP ツール

| ID | 監査ラベル |
|---|---|
| `staffpass_whoami` | 社員証を確認 |
| `staffpass_invoke` | 操作を実行 | ※実操作は Gateway ID を優先 |
| `staffpass_get_approval_status` | 承認状態を確認 |
| `staffpass_health` | 接続状態を確認 |
| `staffpass_stuck_list` | 停滞中の仕事を一覧 |
| `staffpass_stuck_retry` | 停滞中の仕事を再試行 |
| `staffpass_decision_request` | 判断を依頼 |
| `staffpass_config_change_request` | 設定変更を依頼 |
| `staffpass_sensitive_topics` | 機微トピックを確認 |
| `staffpass_profile` | プロフィールを確認 |

### 4.3 Admin MCP ツール

`ADMIN_TOOL_TITLE_JA` にあるものはそれを採用。無いものは下表。読み取り専用も監査に残る可能性があるので含める。

| ID | 監査ラベル |
|---|---|
| `employees.issue` | AI社員を発行 |
| `link` | AI社員を連携 |
| `policy.patch` | 権限を更新 |
| `employees.allowedAccounts.add` | 許可アカウントを追加 |
| `employees.allowedAccounts.remove` | 許可アカウントを削除 |
| `employees.allowedAccounts.list` | 許可アカウントを一覧 |
| `employees.postingIdentity.set` | 投稿名義を設定 |
| `employees.credential.reissue` | 社員証を再発行 |
| `parties.upsert` | 相手台帳を更新 |
| `parties.list` | 相手台帳を一覧 |
| `parties.remove` | 相手台帳から削除 |
| `channels.classify` | チャネルを分類 |
| `channels.list` | チャネル台帳を一覧 |
| `channels.remove` | チャネル台帳から削除 |
| `roles.propose` | 職務案を提案 |
| `setup.slackStatus` | Slack連携状態を確認 |
| `setup.slackAdapter.setBotToken` | Slack投稿Botを設定 |
| `setup.connectInternalBase` | 社内Slack基盤を設定 |
| `setup.lineApprovalStatus` | LINE承認の状態を確認 |
| `setup.lineApproval.upsert` | 承認用LINEを設定 |
| `setup.lineApproval.setEmployeeInbox` | AI社員のLINE承認先を設定 |
| `setup.lineApproval.demoteTelegram` | Telegram承認を無効化 |
| `ingressHandoff.get` | 受信の渡し方を確認 |
| `ingressHandoff.patch` | 受信の渡し方を更新 |
| `schedulingPolicy.get` | 予定ポリシーを確認 |
| `schedulingPolicy.patch` | 予定ポリシーを更新 |
| `replyPolicy.get` | 返信ポリシーを確認 |
| `replyPolicy.patch` | 返信ポリシーを更新 |
| `mailPolicy.get` | メールポリシーを確認 |
| `mailPolicy.patch` | メールポリシーを更新 |
| `internalAudienceRule.get` | 社内相手ルールを確認 |
| `internalAudienceRule.patch` | 社内相手ルールを更新 |
| `stuckWatch.get` | 停滞監視の設定を確認 |
| `stuckWatch.patch` | 停滞監視の設定を更新 |
| `stuckWatch.list` | 停滞中の仕事を一覧 |
| `stuckWatch.inspect` | 停滞中の仕事を確認 |
| `stuckWatch.retry` | 停滞中の仕事を再試行 |
| `stuckWatch.resolve` | 停滞中の仕事を解決 |
| `stuckWatch.classify` | 停滞の分類を更新 |
| `approvalWorkflow.get` | 承認ワークフローを確認 |
| `approvalWorkflow.patch` | 承認ワークフローを更新 |
| `approvalWorkflow.inspect` | 承認ワークフローを点検 |
| `approvalWorkflow.remind` | 承認者に再通知 |
| `approvalWorkflow.bindVoter` | 承認者を登録 |
| `approvalWorkflow.unbindVoter` | 承認者登録を解除 |
| `approvalWorkflow.resendVoterVerification` | 承認者確認を再送 |
| `approvalWorkflow.listVoterBindings` | 承認者登録を一覧 |
| `setup.approverBindingStatus` | 承認者登録の状態を確認 |
| `approvalRoutes.get` | 承認ルートを確認 |
| `approvalRoutes.patch` | 承認ルートを更新 |
| `orgs.create` | テナントを作成 |
| `orgs.status` | テナント状態を確認 |
| `orgs.patch` | テナント名を変更 |
| `orgs.issueAdminCredential` | 管理認証を発行 |
| `approvals.proxyResolve` | 承認を代理で確定 |
| `employeeIdentity.status` | AI社員の身元を確認 |
| `employeeIdentity.upsert` | AI社員の身元を設定 |
| `employeeIdentity.bindMailbox` | AI社員のメールボックスを設定 |
| `setup.slackDmApprovalStatus` | Slack DM承認の状態を確認 |
| `dmAutoroute.list` | DM自動経路を一覧 |
| `dmAutoroute.run` | DM自動経路を実行 |
| `setup.approvalDelivery.autoResolve` | 承認配送を自動解決 |
| `setup.slackApprover.set` | Slack承認者を設定 |
| `setup.slackAuthorizeLink.issue` | Slack認可リンクを発行 |
| `approvers.designatedAdmins.get` | 指定管理者を確認 |
| `approvers.designatedAdmins.set` | 指定管理者を更新 |
| `members.promoteOwner` | オーナーに昇格 |

### 4.4 `AuditAction`（ツール ID が無い行）

| action | 監査ラベル |
|---|---|
| `tool.invoke` | （`metadata.tool` のラベル。無ければ「操作を実行」） |
| `credential.issued` | 社員証を発行 |
| `credential.revoked` | 社員証を失効 |
| `credential.rotated` | 社員証を再発行 |
| `credential.expiry_notice` | 社員証の期限を通知 |
| `oauth.consent_granted` | AI接続を許可 |
| `oauth.consent_denied` | AI接続を拒否 |
| `oauth.grant_revoked` | AI接続を取り消し |
| `oauth.token_issued` | 接続トークンを発行 |
| `oauth.code_reuse_detected` | 認可コードの再利用を検出 |
| `oauth.refresh_reuse_detected` | 更新トークンの再利用を検出 |
| `oauth.refresh_replay_in_grace` | 更新トークンの再送（猶予） |
| `oauth.dcr_global_cap_reached` | クライアント登録が上限 |
| `comm.link_code_account_locked` | 連携コードをロック |
| `comm.link_code_account_locked_repeat` | 連携コードのロックが継続 |
| `comm.account.created` | 通信アカウントを作成 |
| `comm.account.secrets_set` | 通信シークレットを設定 |
| `comm.account.disabled` | 通信アカウントを停止 |
| `lp.setup_fee.email_hash_key_missing` | 初期費用通知の鍵なし |
| `lp.setup_fee.notice_record_failed` | 初期費用通知の記録に失敗 |
| `employee.hold.state_unavailable` | 緊急停止の状態を確認できず |
| `employee.hold.not_installed` | 緊急停止が未導入 |
| `employee.hold.wake_suppressed` | 停止中のため起動せず |
| `employee.hold.started` | 緊急停止を開始 |
| `employee.hold.start_failed` | 緊急停止を開始できず |
| `employee.hold.release_requested` | 緊急停止の解除を申請 |
| `employee.hold.released` | 緊急停止を解除 |
| `employee.hold.release_refused` | 緊急停止の解除を拒否 |
| `employee.hold.ai_refused` | 停止中の操作を拒否 |
| `comm.delete.succeeded` | 自分の投稿を削除 |
| `comm.delete.already_deleted` | 投稿は既に削除済み |
| `comm.delete.refused` | 投稿の削除を拒否 |
| `comm.delete.failed` | 投稿の削除に失敗 |
| `comm.delete.approval_requested` | 投稿削除の承認を依頼 |
| `approval.requested` | 承認を依頼 |
| `approval.resolved` | 承認が確定 |
| `approval.revision_requested` | 修正を依頼 |
| `approval.superseded` | 承認を置き換え |
| `approval.expired` | 承認が期限切れ |
| `approval.telegram_error` | Telegram承認の通知に失敗 |
| `approval.snapshot_missing_attachment` | 承認時の添付が無い |
| `approval.attachment_upload_in_progress` | 添付の送信中 |
| `approval.attachment_upload_uncertain` | 添付の送信結果が不明 |
| `approval.attachment_not_sent` | 添付を送っていない |
| `approval.attachment_reconciled` | 添付の状態を照合 |
| `approval.attachment_request_ignored` | 添付依頼を無視 |
| `approval.attachment_upload_capped` | 添付の再送が上限 |
| `approval.callback_config_unavailable` | 承認コールバック設定なし |
| `approval.cancelled_by_plan_change` | プラン変更で承認を取消 |
| `comm_reply.duplicate_suppressed` | 重複送信を抑制 |
| `comm_reply.dedup_unavailable` | 重複チェックが使えない |
| `comm_reply.cross_employee_duplicate` | 他のAI社員と重複 |
| `comm_reply.post_outcome_unknown` | 投稿結果が不明 |
| `comm_reply.uncertain_released` | 不明だった投稿を解除 |
| `thread_guard.busy` | スレッドが処理中 |
| `thread_guard.moved_on` | スレッドが先に進んだ |
| `thread_guard.unavailable` | スレッドガードが使えない |
| `thread_guard.read_point_unknown` | 既読位置が不明 |
| `setup.tool_succeeded` | セットアップ操作が成功 |
| `notification.channel_updated` | 通知チャネルを更新 |
| `notification.test_sent` | 通知テストを送信 |
| `notification.delivery_failed` | 通知の配送に失敗 |
| `channel_classify.proposed` | チャネル分類を提案 |
| `channel_classify.proposal_failed` | チャネル分類の提案に失敗 |
| `channel_classify.wake_skip_suppressed` | 分類スキップ通知を抑制 |
| `channel_classify.join_ignored` | 参加イベントを無視 |
| `channel_stuck.notice` | チャネル停滞を通知 |
| `channel_stuck.notice_suppressed` | チャネル停滞通知を抑制 |
| `conversation.adapter_updated` | 会話アダプタを更新 |
| `conversation.adapter_installed` | 会話アダプタを導入 |
| `slack.posted` | Slackにメッセージを送信 |
| `slack.post_failed` | Slackへの送信に失敗 |
| `line.posted` | LINEにメッセージを送信 |
| `line.post_failed` | LINEへの送信に失敗 |
| `line.conversation_target_mismatch` | LINEの相手が一致せず |
| `line.conversation_wake` | LINEの会話で起動 |
| `comm.not_sent` | メッセージを送っていない |
| `slack.file_uploaded` | Slackにファイルを添付 |
| `slack.file_upload_failed` | Slackファイル添付に失敗 |
| `slack.file_egress_denied` | Slackファイル添付を拒否 |
| `sns.publish_failed` | SNS投稿に失敗 |
| `slack.mention_wake` | Slackのメンションで起動 |
| `slack.internal_im_wake` | Slackの社内DMで起動 |
| `slack.user_token_im_wake` | SlackのユーザDMで起動 |
| `slack.im_wake_skipped` | Slack DM起動をスキップ |
| `slack.user_token_channel_wake` | Slackチャネルで起動 |
| `slack.user_token_channel_wake_skipped` | Slackチャネル起動をスキップ |
| `slack.user_token_channel_rewake` | 分類後にチャネルで再起動 |
| `slack.user_token_channel_rewake_skipped` | 分類後の再起動をスキップ |
| `employee.sod_forced` | 職務分離で人承認に変更 |
| `employee.sod_override` | 職務分離の上書き |
| `employee.project_access_refused` | プロジェクト範囲外を拒否 |
| `information_asset.project_refused` | 情報資産のプロジェクトを拒否 |
| `action_limit.reached` | 操作回数の上限に到達 |
| `action_limit.denied` | 操作回数の上限で拒否 |
| `gateway.conversation_org_mismatch` | 会話の組織が一致せず |
| `gateway.conversation_channel_mismatch` | 会話のチャネルが一致せず |
| `gateway.session_org_mismatch` | セッションの組織が一致せず |
| `billing.updated` | 請求情報を更新 |
| `email.sent` | メールを送信 |
| `gateway.link_changed` | Gateway連携を変更 |
| `employee.created` | AI社員を作成 |
| `employee.updated` | AI社員を更新 |
| `employee.terminated` | AI社員を失効 |
| `member.invited` | メンバーを招待 |
| `member.updated` | メンバーを更新 |
| `member.change_denied` | メンバー変更を拒否 |
| `commerce.projection_received` | 取引イベントを受信 |
| `authority.event_delivery` | 権限イベントを配送 |
| `admin.hire` | AI社員を発行 |
| `admin.link` | AI社員を連携 |
| `admin.policy` | 権限・ポリシーを更新 |
| `admin.parties` | 相手台帳を更新 |
| `admin.channel` | チャネルを分類 |
| `admin.role` | 職務案を提案 |
| `admin.ingressHandoff` | 受信の渡し方を更新 |
| `admin.conversationAdapter` | 会話アダプタを更新 |
| `admin.notificationChannel` | 通知チャネルを更新 |
| `admin.create_org` | テナントを作成 |
| `admin.issue_admin_credential` | 管理認証を発行 |
| `admin.proxy_approve` | 承認を代理で確定 |
| `admin.org_patch` | テナント名を変更 |
| `admin.billing` | 請求設定を更新 |
| `admin.external_contract_card` | 外部契約カードを操作 |
| `admin.portal` | 管理ポータルを操作 |
| `stuck_watch.w2_retry` | 未完了の仕事を再試行 |
| `stuck_watch.w1_notify` | 未返信を通知 |
| `stuck_watch.audience_ledger_retry` | 相手台帳の再試行 |
| `stuck_watch.w4_notify` | 停滞を通知 |
| `stuck_watch.attachment_uncertain_notify` | 添付不明を通知 |
| `stuck_watch.retry` | 停滞中の仕事を再試行 |
| `stuck_watch.resolve` | 停滞中の仕事を解決 |
| `mcp.client_seen` | MCPクライアントを確認 |
| `mcp_events.subscribed` | イベント購読を開始 |
| `mcp_events.unsubscribed` | イベント購読を解除 |
| `mcp_events.delivered` | イベントを配送 |
| `mcp_events.delivery_abandoned` | イベント配送を断念 |
| `mcp_events.delivery_deferred` | イベント配送を延期 |
| `mcp_events.subscription_revoked` | イベント購読を取り消し |
| `mcp_events.triggered_action` | イベント後の最初の操作 |
| `employee.webhook_secret_minted` | Webhook秘密を発行 |
| `employee.webhook_payload_mode_set` | Webhookの内容モードを設定 |
| `mcp_handoff.not_connected_notify` | MCP未接続を通知 |
| `agent.approval_wake` | 承認結果で起動 |
| `calendar.freebusy_read` | 空き状況を参照 |
| `calendar.allowlist_patch` | カレンダー許可リストを変更 |
| `google.identity_connected` | Googleアカウントを接続 |
| `google.identity_revoked` | Googleアカウントを切断 |
| `voter_binding.resend_rate_limited` | 承認者確認の再送が上限 |
| `voter_binding.resend_failed` | 承認者確認の再送に失敗 |
| `voter_binding.resend_success` | 承認者確認を再送 |
| `voter_binding.unlock_via_resend` | 再送で承認者ロックを解除 |
| `approval_routes.patch` | 承認ルートを更新 |
| `approval_routes.patch_conflict` | 承認ルートの更新が衝突 |
| `topic_gate.triggered` | 機微トピックで承認が必要 |
| `decision.requested` | 判断を依頼 |
| `decision.vote_recorded` | 判断の票を記録 |
| `decision.resolved` | 判断が確定 |
| `decision.expired` | 判断が期限切れ |
| `decision.deputy_activated` | 代理判断者が有効 |
| `plan.downgrade_scheduled` | ダウングレードを予約 |
| `plan.downgrade_applied` | ダウングレードを適用 |
| `plan.downgrade_cancelled` | ダウングレードを取消 |
| `plan.billing_status_narrowed` | 請求状態が制限 |
| `plan.changed` | プランを変更 |
| `plan.upgrade_requested` | アップグレードを依頼 |
| `plan.upgrade_applied` | アップグレードを適用 |
| `plan.upgrade_rejected` | アップグレードを拒否 |
| `plan.fulfill_blocked` | 承認後の実行をプランで停止 |
| `config.change_requested` | 設定変更を依頼 |
| `config.change_refused` | 設定変更の依頼を拒否 |
| `config.change_applied` | 設定変更を反映 |
| `config.change_apply_failed` | 設定変更の反映に失敗 |
| `config.change_rejected` | 設定変更を却下 |
| `secret_detection.blocked` | 秘密情報の送信を拒否 |
| `secret_detection.suspected` | 鍵に似た文字列を検出 |

マップに無い新しい `action` / `tool` は「その他の操作（{id}）」＋実装 PR で表を足すテスト。

---

## 5. 理由コード → 日本語

既存の `messageJa` / `REASON_JA` / `NotSentInfo.messageJa` を集約する。監査は短文（1 文）。詳細な nextStep はドロワー。

| reasonCode / code | 結果 | 日本語 |
|---|---|---|
| `needs_approval` | pending | 人の承認待ち |
| `approved` | success | 承認されて実行しました |
| `rejected` | denied | 承認者が却下しました |
| `expired` | denied | 承認期限が切れました |
| `revision_requested` | pending | 修正依頼です。まだ実行していません |
| `egress_denied` | denied | 相手先または情報区分のルールで送れません |
| `secret_detected_in_payload` | denied | 秘密情報の可能性がある値を検出して拒否しました |
| `approval_held` | denied | 緊急停止中の承認のため実行しませんでした |
| `action_limit.denied` / `action_limit` | denied | 操作回数の上限です |
| `topic_gate` | pending | 機微トピックのため承認が必要です |
| `duplicate_reply_suppressed` | denied | 同じ内容の重複送信を止めました |
| `cross_employee_duplicate` | success（警告） | 他のAI社員の投稿と似ています（送信はしています） |
| `post_outcome_unknown` | failure | 投稿できたか確認できません |
| `duplicate_check_unavailable` | failure | 重複チェックが使えず送信していません |
| `thread_busy` | failure | 同じスレッドで別の返信が処理中です |
| `thread_moved_on` | denied | このスレッドは既に返信済みです |
| `slack_channel_required` | failure | Slackチャネルが無く送信していません |
| `delivery_unsupported_surface` / `channel_not_supported` | denied | この窓口への送信には未対応です |
| `conversation_not_sent` | failure | メッセージは送信していません |
| `conversation_org_mismatch` | denied | 会話の組織が一致しません |
| `conversation_channel_mismatch` | denied | 会話のチャネルが一致しません |
| `conversation_target_mismatch` | denied | LINEの相手が一致しません |
| `session_org_mismatch` | denied | セッションの組織が一致しません |
| `provider_rate_limited` | failure | 先方の利用上限です。時間をおいてください |
| `slack_post_failed` / `line_post_failed` / `sns_publish_failed` | failure | 送信に失敗しました |
| `file_egress_denied` | denied | ファイル添付がルールで拒否されました |
| `admin_policy_required` | denied | 管理操作の承認者が未設定です |
| `approver_is_requester` | denied | 申請者本人は承認できません |
| `approver_not_authorized` | denied | この操作を承認できる人ではありません |
| `approver_identity_unverified` | denied | 承認者の本人確認ができません |
| `no_approver_resolvable` | denied | 届け先の承認者が見つかりません |
| `project_access` 系 | denied | 担当プロジェクトの外の情報は扱えません |
| `feature_disabled` | denied | この機能は現在オフです |
| `stale_base` | failure | 元の設定が変わったため反映しませんでした |
| `plan.fulfill_blocked` | denied | 承認後にプランが変わり実行できません |

未登録コードは「理由コード: {code}」。値や本文をコードの代わりに出さない。`lib/approver-authority/reply.ts` の長文はドロワーの「次の手順」にだけ使う。

---

## 6. フィルタ・検索・ドロワー

### 6.1 フィルタ（PR-4）

初期セット（すべて自 org のみ）:

- 期間（JST 日。サーバは timestamptz）
- 行為者: AI 社員 / 人 / システム
- AI 社員（セレクト）
- 操作（日本語ラベル、内部は tool/action）
- 結果: 成功 / 失敗 / 拒否 / 待ち
- 承認: 要った / 不要 / 待ち

クエリは `listAuditEvents` を拡張。デフォルト 50 件 + カーソル（`created_at, id`）。いまの固定 100 件切りはやめる。

### 6.2 検索

`summary` の部分一致（`ilike`、サニタイズ、最短 2 文字、最大 80 文字）。本文・metadata 全走査はしない（秘密と負荷）。ヒットは投影後の要約だけ見せる。

必要なら後続で `summary` trigram。初期は btree 索引で足りるか見る。

### 6.3 索引（PR-4 のマイグレーション）

```sql
create index audit_events_org_action_created_idx
  on audit_events (org_id, action, created_at desc);

create index audit_events_org_employee_created_idx
  on audit_events (org_id, employee_id, created_at desc)
  where employee_id is not null;
```

`metadata->>'tool'` の expression index はフィルタ実測のあと。GIN 全 metadata は機密がインデックスに残るので **採用しない。**

### 6.4 詳細ドロワー（PR-1 で骨格、以降で中身）

行クリックで右または下に展開。同じページ（別ルート不要）。出すもの:

- 行為者（人/AI、氏名、マスクメール、employeeId 短縮）
- JST 日時（秒まで）
- 操作（日本語 + 小さい ID）
- 対象（名前 + 詳細でのみ短縮 ID）
- 要約（200 字、赤消し済み）
- 承認（要否、状態、承認者、チケット先頭 8 文字。リンクは同一 org の `/app/approvals`）
- 結果と理由
- 安全メタ: purpose, jobId, risk, informationClass, audience

出さないもの:

- `metadata` 生 JSON
- メッセージ本文、プロンプト、添付 URL、`statusToken`, `pollPath`, 認証ヘッダ、カード番号
- 他 org の ID

キーボードで閉じる。詳細用の追加 fetch は同一投影。クライアントに raw row を渡さない。

---

## 7. セキュリティ

### 7.1 テナント分離

- 読み取りは必ず `org_id = session.orgId`。`listAuditEvents` の org 無し全件はダッシュボードから呼ばない（stuck-watch 用ヘルパーは `/app/audit` と共有しない）。
- 承認・社員・チャネル・メンバーの JOIN も同じ `org_id`。
- RLS の `is_org_member` は残す。ページは **`view_audit` を要求**（いま未チェック）。メンバーなら誰でも生 JSON を見られる状態をやめる。
- 書き込みは service role のまま。authenticated insert を戻さない。

### 7.2 PII 最小化

| データ | リスト | ドロワー | DB |
|---|---|---|---|
| 人の氏名 | 出す | 出す | 既存 |
| 人のメール | マスク `a***@example.com` | 同じマスク | `actor_email` は既存のまま。新規に平文を増やさない |
| AI 氏名 | 出す | 出す | 既存 |
| AI メール | バインド済み mailbox のみマスク。通知用メールは出さない | 同左 | 既存 |
| 宛先メール | マスク | マスク | 既存 metadata は触らない |
| Slack 表示名 | 出す | 出す | 台帳に任意で display_name |
| Slack / LINE 生 ID | 出さない | 短縮 | 既存 |
| 本文 | 出さない | 出さない | 新規 write で入れない |

マスク: ローカル部が 1 文字なら `*@domain`、2 文字以上は先頭 1 + `***` + `@domain`。`detectSecretInString` がヒットしたメールは `[redacted]`。

### 7.3 生 payload を UI から落とすか

**落とす。** 必須。

理由:

- `approval.requested` の metadata に `pollPath`（`redactMetadata` の削除対象）がある。
- `destination` にメール全文やチャネル ID。
- `egress` オブジェクトが大きい。
- ページ副題は既に「プロンプト全文ではない」だが、JSON dump がそれを破っている。

サーバ投影だけを描画する。開発者向け raw ビューは super-admin にも出さない（別の運用 SQL）。DB の metadata は Troubleshoot 用に残してよいが、ダッシュボード契約からは外す。

PCI: カード監査は別表のまま。`/app/audit` に混ぜない。detector の `[CARD_DATA_REDACTED]` を維持。

---

## 8. PR 分割と見積もり

人日は実装 + テスト（投影の単体、ページの描画、秘密が JSON に出ないこと）。レビュー待ちは含まない。カレンダー週数ではない。

### PR-0 本設計（この PR）

- ドキュメントのみ。
- **マイグレーション: 不要。**

### PR-1 読み取り投影・ラベル・JSON 廃止・ドロワー骨格 — 3 人日

- `AuditEvent.actorEmail` をマッパーに追加（表示はマスク）。
- `presentAuditRow` + §4 ラベル。未知 ID のテスト。
- `/app/audit`: チップを日本語化。結果・要約。`<pre>` 削除。
- ドロワー骨格（対象・承認はプレースホルダ可）。
- `view_audit` ゲート。
- **マイグレーション: 不要。**

受け入れ: 直近行で「誰が（AI 名）・何時（JST）・何を（日本語）・結果」が JSON 無しで読める。`pollPath` が HTML に出ない。

### PR-2 行為者の人/AI・承認結合 — 2 人日

- §3.1 の行為者。
- `approvalId` バッチ JOIN。承認の要否・承認者（マスク）。
- **マイグレーション: 不要。**

受け入れ: 人の操作は氏名+マスクメール。AI は「AI」バッジ+氏名。承認済み送信は承認者名。旧行は「不明」で落ちない。

### PR-3 対象解決・要約の赤消し — 3 人日

- チャネル / 社員 / マスク宛先。
- `redactMetadata` + `detectSecretInString` / `safeEcho`。本文なし。80/200 字。
- 任意: `org_channels.display_name text`。分類・join の承認履行時だけ書く。Slack API をリストで呼ばない。
- **マイグレーション: 任意。** display_name 無しなら ID +「名称不明」。

受け入れ: Slack 行にチャネル名または「名称不明（C…）」. メール宛先がマスク。secret パターンが要約に出ない。

### PR-4 理由日本語・フィルタ／検索 — 3 人日

- §5 のコード表。未登録は安全フォールバック。
- 期間・社員・操作・結果・承認フィルタ。summary `ilike`。
- §6.3 の索引 2 本。
- **マイグレーション: 必要**（索引のみ。既存行の書き換えなし）。ロールバックは `DROP INDEX`。

受け入れ: 「失敗だけ」「この AI 社員だけ」が org 内で動く。他 org の行は出ない。

### PR-5 書き込み側 metadata 契約 — 2 人日

新規行だけ（旧行 UPDATE なし）:

```ts
metadata: {
  tool: string | null,
  jobId: string | null,
  approvalId: string | null,
  targetKind: string | null,
  targetId: string | null,      // チャネル ID 等。メール全文は入れない
  targetLabel: string | null,   // 秘密検出済みの表示名
  result: "success" | "failure" | "denied" | "pending",
  reasonCode: string | null,
  sent?: boolean,
}
```

- `pollPath` / `statusToken` / 本文を audit metadata に足さない（承認テーブル側の既存は残す）。
- `appendAuditEvent` のテストで禁キーを検査。
- **マイグレーション: 不要。** 列追加しない。検索が metadata 依存のまま厳しければ別提案（generated column）とする。

受け入れ: 新規 `comm.reply` 成功行が、投影なしでも tool / targetLabel / result を持つ。禁キーが無い。

### やらないこと（この一連）

- 監査行の backfill UPDATE
- metadata GIN
- カード監査テーブルの統合
- 変更ログ（ダッシュボード先頭）のレイアウト変更（ラベル関数の共用は可）
- Slack API を一覧のたびに叩くこと
- 監査 UI に本文全文を出すこと

---

## 9. ロールアウト

フラグは不要（表示改善。書き込み契約は追加フィールドのみ）。PR-1 から順に main へ。PR-4 の索引はメンテウィンドウ不要（concurrent 可なら `CREATE INDEX CONCURRENTLY` を運用判断）。

ロールバック: 各 PR は UI / 投影の差し戻しで戻る。索引は残してよい。PR-5 の追加キーは旧投影が無視できる。

---

## 10. テスト観点

- 投影: AI 行・人行・システム行・旧行（tool なし）・承認 JOIN・JOIN 失敗。
- 秘密: `pollPath` / `statusToken` / AWS キー様 / カード様が HTML に出ない。`redactPayloadForAudit` と同じ定数プレビュー。
- テナント: org A の承認 ID を org B の行に載せて結合しない。
- ラベル: Gateway 全 ID・Admin 全ツール・`AuditAction` 全値がマップに存在する。
- `view_audit` なしで 403。
- フィルタ SQL が `org_id` を外さない。

---

## 11. オープン（実装時に固定）

1. **`view_audit` をページに必須にするか。** 提案は必須。オーナーが「全員が見えてよい」ならナビは出したまま中身だけマスクでもよいが、生 JSON をやめた後でも宛先は PII。
2. **`org_channels.display_name` を今やるか。** 名称不明が多いなら PR-3 でやる。少なければ ID 表示で出荷。
3. **LINE 送信行のラベル。** 表面が line なら「LINEにメッセージを送信」。
4. **同じ仕事の複数行**（invoke + approval.requested + slack.posted）を 1 行に畳むか。提案は畳まない（監査の時系列を保つ）。UI で `jobId` の視覚グループは PR-4 以降の任意。

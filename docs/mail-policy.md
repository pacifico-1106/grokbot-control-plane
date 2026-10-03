# B1 Mail Policy

**更新:** 2026-09-15（Yasaka GO）  
**ステータス:** 本番稼働（P0-B1）

## 概要

メール送信/返信ポリシー。`mail.send` / `mail.draft` の Gateway 呼び出し時に適用されます。

## デフォルト動作

ポリシー未設定時: **外部宛 ≈ `draft_only`** — 実送信なし。`mail.send` は明示的に `mail.draft` に降格（コード `mail_send_demoted_to_draft` + 監査）。

## sendMode

| 値 | 動作 |
|----|------|
| `draft_only` | `mail.send` → `mail.draft` 降格（silent demotion 禁止） |
| `needs_approval` | 承認カード表示後に fulfill |
| `auto` | 高リスク承諾（`highRiskConsentAt/By`）必須 |

## フォールバック順序

employee override → org policy → default（外部 draft_only）

## スキーマ

- `orgs.mail_policy` / `employees.mail_policy` (jsonb)
- Migration: `supabase/migrations/20260915_mail_policy.sql`

## Admin MCP

- `mailPolicy.get` — 読み取り専用
- `mailPolicy.patch` — always_human（承認後 fulfill）

## D1 添付

`attachmentPolicyRef`: `inherit_d1` | `forbid`。D1 と競合時は **厳しい側が勝つ**（forbid / Sealith required）。

## 承認カード

宛先（to 系の全項目） / CC / BCC / 件名 / 本文先頭 / 添付あり / sendMode を表示。

- CC・BCC は、値があるときだけ宛先の直後に1行ずつ表示する（2026-10-04〜）。
- 表示面: Web の承認一覧・代理承認パネル・MCP / poll の `summary`（全件）、Slack・Telegram のカード（1行 500 文字で打ち切り、打ち切ったときは `CC（N件）:` と件数を表示）、LINE のカード（`summary` を表示するため、先頭 500 文字に含まれる範囲）。
- 宛先・件名の改行や制御文字は空白にまとめて表示する（偽の「BCC:」行などを作らせないため）。

## 判定の詳細（2026-10-03 hardening、厳しくなる方向のみ）

- **全宛先を判定**: `to` / `cc` / `bcc` の全宛先を判定する（カンマ・セミコロン区切りの複数宛先も1件ずつ分解）。宛先ごとの判定のうち最も厳しいものを採用する（拒否 > 下書き降格 > 承認 > 自動）。1件でも外部宛があればメール全体を外部扱いにし、社内宛も外部向けルールで追加判定する。
- **宛先の形式**: `local@domain.tld` の単純な形式だけを受け付ける。ドメインが取れない宛先、表示名付き（`Name <addr>`）、空要素（末尾カンマなど）、文字列以外の `cc` / `bcc` / `to` は **拒否**（`mail_recipient_invalid`）。
- **一致するルールがない場合**: 先頭ルールの auto は流用しない。最低でも承認必須とし、従来の先頭ルールの結果のほうが厳しい（下書き降格・拒否）ときはそちらを採用する。
- **`requireHumanFinalSend: true`**: `sendMode: auto` でも承認必須（`requireHumanFinalSend:true` 監査ラベル）。
- **ツール設定 `toolApprovalDefaults["mail.send"] = "deny"`**: Gateway で即拒否（403 `mail_send_denied_by_tool_setting`）。承認カード・下書き降格にはしない。

## 判定の詳細（2026-10-03 follow-up、厳しくなる方向のみ）

- **主宛先の全項目を判定**: `args.to` / `args.recipient` / `args.email` / `body.email` / `conversation.email` のうち、値があるものを**すべて**判定対象にする（従来は最初の1項目だけ）。最も厳しい結果を採用する。承認カードの宛先にも全項目を表示する。文字列以外の `body.email` / `conversation.email` は拒否（`mail_recipient_invalid`）。
- **拒否リストはサブドメインにも一致**: `toDomainDenylist: ["example.com"]` は `example.com` と `mail.example.com`・`a.b.example.com` を拒否する。ラベル境界で完全一致させるため、`badexample.com` や `example.com.evil` は一致しない。エントリの大文字小文字、先頭の `@` / `*.` / `.`、末尾の `.` は無視する。**許可リストは従来どおり完全一致**（サブドメインに広げると緩くなるため）。
- **承認済み案件の実行直前の再確認**: 承認ボタン・Slack / LINE / Telegram の承認・代理承認・W2 再実行・`approvalId` 付きの再 invoke のいずれでも、実行（fulfill）の直前に現在のツール設定とメールポリシーで再判定する。
  - ツール設定が `deny` → 停止（`fulfill_blocked_tool_denied`）
  - メールポリシーが拒否・下書き降格 → 停止（`fulfill_blocked_mail_policy`、再 invoke では 409 `approved_send_blocked_by_policy`）
  - 社員を読み込めない → 停止（`fulfill_blocked_employee_unavailable`）
  - 停止は承認の `metadata.fulfillment.error` と監査ログ（`phase: approval.fulfill`、`code`・`reason`）に残る。送信は一切しない。設定を戻せば同じ承認から再実行できる。
  - 承認時のスナップショットに `cc` / `bcc`（文字列配列）・添付の有無・`sealithTransferId` も保存し、再判定に使う（この変更より前に作られた承認は `to` 系だけで再判定）。
- **ツール設定 `deny` は送信系ツールすべてで即拒否**: 対象は `mail.send`・`agentmail.send`・`slack.post`・`slack.post_external`・`comm.reply`・`comm.send`・`sns.publish`・`drive.share_external`（`lib/gateway/tools.ts` の `OUTBOUND_SEND_TOOL_IDS`）。`mail.send` 以外のコードは 403 `tool_denied_by_tool_setting`。
  - `deny` は保存・読み込み時に捨てられなくなった（従来は `normalizeToolApprovalDefaults` が落として always_human 扱いになっていた）。送信系以外の選択可能ツール（`calendar.confirm` など）の `deny` は、invoke では従来どおり承認強制、承認済み案件の実行は停止される。

## 承認済み送信の内容固定（2026-10-04、厳しくなる方向のみ）

`approvalId` 付きで mail.send を再実行するとき、**承認された内容と完全に同じ**でなければ送信しない。

- 承認作成時に `metadata.mailSendPin`（`v: 1`、項目ごとの SHA-256 ダイジェストのみ。宛先や本文の平文は持たない）を保存する。
- 固定する項目: `args` のすべてのキー（`to` / `recipient` / `email` / `cc` / `bcc` / `subject` / `title` / `body` / `text` / `message` / `content` / `from` / `replyTo` / `attachments` などを含む）、トップレベルの `email`、`conversation.email`。
  - 値は完全一致（大文字小文字・空白も区別）。オブジェクトのキー順は問わない。配列（cc / bcc など）は順序も含めて一致が必要。`null` と未指定は同じ扱い。
  - 本文はスナップショットの切り詰め（10万文字）に関係なく全体を照合する。
- 項目の追加・削除・値の変更・別キーへの移し替え（`body` → `text` など）は、すべて **409 `approved_send_content_mismatch`**。応答と監査ログ（`phase: reinvoke`）には一致しなかった**項目名だけ**（`mismatchedFields`、最大50件と総数 `mismatchCount`）を残し、値は残さない。
- メールの項目を何も含まない再実行（`tool` / `purpose` / `jobId` / `approvalId` だけ）は、「承認された内容をそのまま実行する」として許可する（新しい内容を持ち込めないため）。現在のメールポリシーでの再判定は従来どおり行う。
- **照合情報のない承認**（この変更より前に作られた承認。#232 以前の承認を含む）は、内容が同じでも **409 `approved_send_pin_missing`**（fail-closed）。承認を取り直す。
- 照合は現在のメールポリシーの再判定（409 `approved_send_blocked_by_policy`）より先に行う。
- 承認ボタン・Slack / LINE / Telegram 承認・W2 再実行の fulfill は、リクエストではなく承認時のスナップショットを使うため対象外（持ち込める内容がない）。

## AC

| ID | 内容 |
|----|------|
| B1-1 | デフォルト外部は実送信なし |
| B1-2 | needs_approval でカード項目表示 |
| B1-3 | approve fulfill + audit approvalId+sendMode |
| B1-4 | auto without consent cannot patch |
| B1-5 | denylist fail-closed |
| B1-6 | D1 conflict stricter wins |

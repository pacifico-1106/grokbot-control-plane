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

to / subject / body summary / 添付あり / sendMode を表示。

## 判定の詳細（2026-10-03 hardening、厳しくなる方向のみ）

- **全宛先を判定**: `to` / `cc` / `bcc` の全宛先を判定する（カンマ・セミコロン区切りの複数宛先も1件ずつ分解）。宛先ごとの判定のうち最も厳しいものを採用する（拒否 > 下書き降格 > 承認 > 自動）。1件でも外部宛があればメール全体を外部扱いにし、社内宛も外部向けルールで追加判定する。
- **宛先の形式**: `local@domain.tld` の単純な形式だけを受け付ける。ドメインが取れない宛先、表示名付き（`Name <addr>`）、空要素（末尾カンマなど）、文字列以外の `cc` / `bcc` / `to` は **拒否**（`mail_recipient_invalid`）。
- **一致するルールがない場合**: 先頭ルールの auto は流用しない。最低でも承認必須とし、従来の先頭ルールの結果のほうが厳しい（下書き降格・拒否）ときはそちらを採用する。
- **`requireHumanFinalSend: true`**: `sendMode: auto` でも承認必須（`requireHumanFinalSend:true` 監査ラベル）。
- **ツール設定 `toolApprovalDefaults["mail.send"] = "deny"`**: Gateway で即拒否（403 `mail_send_denied_by_tool_setting`）。承認カード・下書き降格にはしない。

## AC

| ID | 内容 |
|----|------|
| B1-1 | デフォルト外部は実送信なし |
| B1-2 | needs_approval でカード項目表示 |
| B1-3 | approve fulfill + audit approvalId+sendMode |
| B1-4 | auto without consent cannot patch |
| B1-5 | denylist fail-closed |
| B1-6 | D1 conflict stricter wins |

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

## AC

| ID | 内容 |
|----|------|
| B1-1 | デフォルト外部は実送信なし |
| B1-2 | needs_approval でカード項目表示 |
| B1-3 | approve fulfill + audit approvalId+sendMode |
| B1-4 | auto without consent cannot patch |
| B1-5 | denylist fail-closed |
| B1-6 | D1 conflict stricter wins |

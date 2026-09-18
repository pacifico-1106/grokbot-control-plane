# P0 AI Employee Ops Backlog

**更新:** 2026-09-15（Yasaka GO）  
**正本:** Staffpass P0 実装バックログ

---

## P0-A1: scheduling.policy v2

**状態:** ✅ 完了（PR #63 マージ済み `25e7905`）  
**担当:** Yasaka implementation GO 2026-09-15

### スコープ

既存 `OrgSchedulingPolicy` / `SchedulingRule` を **非破壊** 拡張（全フィールド optional）。

| フィールド | 型 | 説明 |
|-----------|-----|------|
| `calendarSources` | `{ ids: string[]; freeBusyMerge: "union_busy" }` | 複数カレンダー free/busy マージ。空 ids → escalate fail-closed |
| `meetingMode` | `title_tag \| explicit_only` | `onlineTitleTags`, `defaultMode`, `onUnspecified: drop\|escalate` |
| `areaPolicy` | allow/deny countries/regions | ISO optional, `onUnknownRegion` |
| `travelFeasibility` | `maxOneWayMinutes`, `requireBuffer` | 静的バッファのみ（routing API なし） |
| `regionDictionary` | `OrgRegionDictionary` v1 | org jsonb 埋め込み。`defaultCountry` (default JP), `regions[{code,labelJa,aliases?,country?}]` |

### フロー

- `calendar.propose`: freebusy → v2 ルール適用 → 外向き候補のみ（dropped は egress しない）
- `calendar.confirm`: 既存 `confirmAutomation`（regression: `always_human`）
- 監査ラベル: `kept` / `droppedByRules` / `meetingMode` / `region` / `calendarSourcesUsed`
- Admin MCP: `schedulingPolicy.get/patch` 後方互換。`summaryJa` に複数カレンダー / オンラインタグ / 地域許可
- 未知フィールド → 明示的 validation error

### AC

| ID | 内容 |
|----|------|
| A1-1 | 2カレンダー union_busy: どちらかで busy ならスロット除外 |
| A1-2 | title_tag: オンラインタグ vs default in_person |
| A1-3 | denyRegions: 対面を理由付きで除外（audit/card） |
| A1-4 | confirm always_human regression |
| A1-5 | 空 calendarSources.ids → escalate（候補を広げない） |
| A1-6 | full_auto without consent cannot patch (regression) |

### Out of scope (次 PR)

- P0-B1 mail.policy
- Routing API travel times
- A2 venues
- LINE conversation

---

## P0-B1: mail.policy

**状態:** 実装中（本 PR）  
**担当:** Yasaka implementation GO 2026-09-15

### スコープ

| フィールド | 型 | 説明 |
|-----------|-----|------|
| `sendMode` | `draft_only` \| `needs_approval` \| `auto` | 送信モード |
| `audience` | `internal` \| `external` \| `any` | 宛先オーディエンス |
| `toDomainAllowlist` / `toDomainDenylist` | string[] | ドメイン許可/拒否 |
| `attachmentPolicyRef` | `inherit_d1` \| `forbid` | D1 添付継承 |

### ロック動作

- デフォルト（ポリシーなし）: 外部 ≈ `draft_only` — 実送信なし
- `draft_only` on mail.send → `mail.draft` 降格 + `mail_send_demoted_to_draft` + 監査
- 純粋 reject は denylist / ハード違反のみ
- `auto` は `highRiskConsentAt/By` 必須
- D1 添付: 厳しい側が勝つ

### AC

| ID | 内容 |
|----|------|
| B1-1 | デフォルト外部は実送信なし |
| B1-2 | needs_approval でカード項目表示 |
| B1-3 | approve fulfill + audit approvalId+sendMode |
| B1-4 | auto without consent cannot patch |
| B1-5 | denylist fail-closed |
| B1-6 | D1 conflict stricter wins |

### Out of scope

- P0-ID, IN, RP, full mailer UI, BCC legal forks

---

## G7: Cross-Team Wake Routing（Connect / 他ワークスペース受信）

**状態:** 設計ロック待ち  
**設計メモ:** [g7-connect-wake-routing-design-20260918.md](./g7-connect-wake-routing-design-20260918.md)  
**担当:** Yasaka / Ando ロック

### スコープ

相手方 Slack Connect / 他ワークスペースでのメンションから、自テナント AI 社員への wake routing を可能にする。

### 背景

- 現状: `resolveWakeTargets` は event team_id にスコープ。Tomori (Miraishachu `T0C24UVNJJF`) は 307 Connect `#aitest` (`T40CKLB5Z`) からは wake されない（H1 修正後の意図された動作）
- G7: explicit bind により cross-team wake を許可

### ロック待ち項目

| # | 項目 | 選択肢 | 推奨 |
|---|------|--------|------|
| 1 | Bind テーブル構造 | Option A（新テーブル `cross_team_wake_bindings`）/ Option B（既存 `employee_slack_identities` 拡張） | **A** |
| 2 | First smoke | Option A（307 `#aitest` 受信 → Tomori wake）/ Option B（Mirai 側 Connect main battlefield） | **A** |

### Production enable

- フラグ OFF default
- 本設計ロック + security review 完了後に別 GO

詳細は [g7-connect-wake-routing-design-20260918.md](./g7-connect-wake-routing-design-20260918.md) を参照。

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

**状態:** ✅ 設計ロック完了  
**設計メモ:** [g7-connect-wake-routing-design-20260918.md](./g7-connect-wake-routing-design-20260918.md)  
**担当:** Ando ロック完了

### スコープ

相手方 Slack Connect / 他ワークスペースでのメンションから、自テナント AI 社員への wake routing を可能にする。

### 背景

- 現状: `resolveWakeTargets` は event team_id にスコープ。Tomori (Miraishachu `T0C24UVNJJF`) は 307 Connect `#aitest` (`T40CKLB5Z`) からは wake されない（H1 修正後の意図された動作）
- G7: explicit bind により cross-team wake を許可

### ロック状況（全項目完了）

| # | 項目 | ステータス | 決定 |
|---|------|------------|------|
| 1 | **Bind テーブル構造** | ✅ **ロック済み**（Ando 2026-09-19） | **Option A: `cross_team_wake_bindings`**（Option B rejected） |
| 2 | **First smoke** | ✅ **ロック済み**（Ando 2026-09-18） | **(a) 307 `#aitest`** — canonical test path |
| 3 | **Tomori = 内外窓口** | ✅ **ロック済み**（Ando 2026-09-19） | 外部 Connect WS からも G7 explicit bind で wake |

- **(b) Mirai / Uehara Connect** は production intent として First smoke 後に移行

### Production enable

- フラグ OFF default
- Security review 完了後に別 GO

詳細は [g7-connect-wake-routing-design-20260918.md](./g7-connect-wake-routing-design-20260918.md) を参照。

---

## P0-UM1: User Mention Channel Ingress（個人メンション起こし）

**状態:** 🔒 DESIGN LOCK IN PROGRESS  
**担当:** Ando product lock 2026-09-19  
**優先度:** P0（短期実装必須）

### 概要

外部 Slack Connect チャネルで AI社員の個人アカウントへのメンション（`@tando`）で wake する機能。
相手方ワークスペースに Staffpass アプリのインストールを **要求しない**。

### Design Lock（プロダクト制約 — 非交渉）

> User-token channel listen のリスク（スコープ、信頼境界、Connect ID スキュー、漏洩時ブラスト半径）を乗り越えることが **Staffpass の価値**。理想を放棄しない。

| ID | 制約 | 状態 |
|----|------|------|
| **DL-1** | 最小スコープ + クレデンシャル・リース（常駐 god-token 禁止） | 🔒 LOCKED |
| **DL-2** | テナント分離 + 明示マップのみ（fuzzy マッチ禁止）+ fail-closed | 🔒 LOCKED |
| **DL-3** | 監査: token subject / channel / employee / event / wake outcome | 🔒 LOCKED |
| **DL-4** | Connect: team_id とゲスト ID の明示的ハンドリング | 🔒 LOCKED |
| **DL-5** | Revoke / 再OAuth / オフボーディング フロー | 🔒 LOCKED |
| **DL-6** | G7 Bot = fallback のみ。**正規 external mouth = User ingress** | 🔒 LOCKED |

技術オプション（Events vs Socket 等）は上記ロック下でのエンジニアリング選択として open。

### 設計ドキュメント

→ [`docs/p0-user-mention-ingress-design-20260919.md`](./p0-user-mention-ingress-design-20260919.md)

### オープンロック

| ID | 担当 | 内容 | DL 関連 |
|----|------|------|---------|
| L1 | Yasaka | User OAuth スコープ拡大承認 | DL-1 |
| L2 | Ando | Connect 相手方検証（Stablo 側でイベント受信確認） | DL-4 |
| L3 | Yasaka | 社員 OAuth 再フロー UX 設計承認 | DL-5 |
| L4 | Yasaka | 監査フィールド仕様承認 | DL-3 |
| L5 | Ando | ロールアウト戦略（feature flag vs 一括） | — |

### Out of scope

- Bot 経由の外部 Connect wake（**DL-6**: 正規パスは User ingress）
- Channel history バッチ取得（**DL-1**: god-token 禁止）
- Display name / email マッチ（**DL-2**: 明示マップのみ）
- DM ingress の変更（既存 Path A/B は維持）

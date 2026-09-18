# G7 Connect Wake Routing — 設計ロックメモ

**作成日:** 2026-09-18  
**ステータス:** 一部ロック済み（First smoke ロック完了 / Bind 構造ロック待ち）  
**関連:** [tenant-slack-kickoff-rail.md](./tenant-slack-kickoff-rail.md) · [multi-tenant-org-boundary-audit.md](./multi-tenant-org-boundary-audit.md) · [p0-ai-employee-ops-backlog-20260915.md](./p0-ai-employee-ops-backlog-20260915.md)

### ロック状況サマリ

| 項目 | ステータス | ロック内容 |
|------|------------|------------|
| **First smoke** | ✅ **ロック済み**（Ando 2026-09-18） | **(a) 307 `#aitest`** が canonical test path |
| **Bind テーブル構造** | 🔒 ロック待ち | Option A（新テーブル）/ Option B（既存拡張）|

---

## 1. 概要

### 1-1. 背景（現状）

現在の `resolveWakeTargets` は **イベント team_id にスコープされた社員のみ** を wake 対象として解決します。

- Tomori（Mirai）は Miraishachu team `T0C24UVNJJF` にのみリンク
- 307 Connect `#aitest`（team `T40CKLB5Z`）でメンションしても Tomori は wake されない
- これは H1 修正（2026-09-05）以降の **意図された動作**（cross-org leak 防止）

### 1-2. G7 スコープ

G7 は **受信テナント（Connect の相手方ホスト）** から **自テナントの AI 社員** への wake routing を可能にします。

```
[相手方 WS でのメンション] → [Staffpass ingress] → [explicit bind 検索] → [自社 AI 社員 wake]
```

**本 PR は設計ロックのみ。ランタイム変更なし。**

---

## 2. 受信 org vs Wake org（オーナーシップ）

### 2-1. イベント claim / audit オーナー

| 項目 | オーナー | 理由 |
|------|----------|------|
| **イベント claim** | 受信 org（相手方 WS ホスト） | `slack_mention_events` の idempotency は event_id で。team_id は受信側 |
| **audit 記録** | wake 対象 org（自社） | wake された AI 社員の org が監査対象 |

### 2-2. Wake webhook オーナー

| 項目 | オーナー | 理由 |
|------|----------|------|
| **wake webhook URL** | wake 対象 org（自社） | `employee_bindings.wake_webhook_url` は社員証に紐付き |
| **wake webhook secret** | wake 対象 org（自社） | `employee_binding_secrets` も同様 |

**結論:** イベントは相手方が claim し、wake は自社 org が受け取る。cross-org routing の明示的許可が必要。

---

## 3. Explicit Bind Only（明示的紐付けのみ）

### 3-1. 設計原則

**ファジーマッチ禁止**: 表示名・メールアドレス・類似 Slack user_id での推測マッチは行わない。

### 3-2. 提案テーブル / キー構造

> **🔒 ロック選択（Yasaka / Ando）**: 以下の A/B から選択

#### Option A: 受信側 team_id + mentioned slack_user_id → employeeId / orgId

```sql
-- Option A: 新テーブル
create table if not exists cross_team_wake_bindings (
  id uuid primary key default gen_random_uuid(),
  receiving_team_id text not null,           -- 相手方 WS team_id（例: T40CKLB5Z）
  mentioned_slack_user_id text not null,     -- 相手方での mention 対象（例: U_TOMORI_307）
  wake_org_id uuid not null references orgs(id),
  wake_employee_id uuid not null references employees(id),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by text,                           -- 設定者メール
  unique(receiving_team_id, mentioned_slack_user_id)
);

create index idx_cross_team_wake_receiving on cross_team_wake_bindings(receiving_team_id, mentioned_slack_user_id) where enabled = true;
```

**Pros:**
- receiving_team_id 単位で明示的制御
- 1 mention → 1 employee の直接マッピング

**Cons:**
- 相手方でのゲスト Slack user_id を事前に把握する必要あり

#### Option B: Home team slack_user_id マッピング（自社 U... → 自社 employee）

```sql
-- Option B: employee_slack_identities 拡張
alter table employee_slack_identities
  add column if not exists allow_cross_team_wake boolean not null default false;

-- allow_cross_team_wake = true の場合:
-- 任意の team_id からのメンションで home team の employee を wake 可能
```

**Pros:**
- 既存テーブル拡張のみ
- 自社 Slack user_id から employee への既存マッピングを再利用

**Cons:**
- 相手方での Slack user_id と自社 Slack user_id が異なる場合に対応できない
- Connect ゲストは別 user_id を持つことがある

#### 推奨（Yasaka / Ando ロック待ち）

**Option A** を推奨: Connect では相手方 WS でのゲスト user_id が自社 user_id と異なるケースが多い。明示的 bind テーブルでの管理が安全。

---

## 4. Fail-Closed（ゼロ / 曖昧 → no wake）

### 4-1. 挙動定義

| 条件 | 結果 | 監査理由 |
|------|------|----------|
| bind 見つからない | no wake | `cross_team_wake_no_bind` |
| 複数 bind が返る（異常） | no wake | `cross_team_wake_ambiguous` |
| bind.enabled = false | no wake | `cross_team_wake_disabled` |
| wake_employee がアクティブでない | no wake | `cross_team_wake_employee_inactive` |

### 4-2. 監査記録

```typescript
await appendAuditEvent({
  orgId: wakeOrgId,           // bind で解決した wake 対象 org
  employeeId: wakeEmployeeId, // bind で解決した wake 対象 employee（null 可）
  credentialId: null,
  action: "slack.cross_team_wake_skipped",
  purpose: "slack.mention",
  summary: "Cross-team wake スキップ: ${reason}",
  metadata: {
    reason,
    receivingTeamId,
    mentionedSlackUserId,
    channelId,
    eventId,
  },
});
```

---

## 5. Egress — 返信の配信経路

### 5-1. Path B 制約（Connect 共有チャネル）

Connect 共有チャネルへの返信は以下の制約を維持:

| 項目 | 制約 |
|------|------|
| **posting_as** | `user`（Bot は相手方 WS には配布しない） |
| **トークン** | 自社 AI 社員の User Token (`xoxp-...`) |
| **チャネルアクセス** | 自社側から見た共有チャネル ID |
| **dual-gate** | `dualEgress` で external-safe を維持 |

### 5-2. conversation adapter 選択

```
resolvePreferredMouth() → Slack (posting_as: user) → Connect 共有チャネルへ投稿
```

**重要:** 相手方 WS のアプリトークンは**使用しない**。自社 User Token で自社から見た Connect チャネルに投稿。

### 5-3. オーディエンス解決

Connect 共有チャネルは `shared_external` 分類。dual-audience 評価:

- 自社メンバー → `internal` parties
- 相手方メンバー → `external` parties（`parties.upsert` または `internalAudienceRule` で管理）
- 未登録 → fail-closed `external`

---

## 6. First Smoke — ✅ ロック済み

> **✅ ロック完了（Ando 2026-09-18）**: **(a) 307 `#aitest`** が canonical test path

### 6-1. Test/Smoke Lock: (a) 307 `#aitest`

**ロック決定:** 307 Connect `#aitest` を G7 の canonical test path として使用。

```
【First Smoke フロー】
1. 307 Connect `#aitest` (T40CKLB5Z) で @[Tomori ゲスト] をメンション
2. Staffpass ingress が event を受信
3. cross_team_wake_bindings で検索:
   - receiving_team_id = T40CKLB5Z
   - mentioned_slack_user_id = U_TOMORI_307
4. Tomori (Miraishachu) を wake
5. 返信は Tomori の User Token で T40CKLB5Z 側の共有チャネルへ投稿
```

**選定理由:**
- 307 側で既存の `#aitest` を使用可能
- 短いフィードバックループ
- Tomori の 307 側ゲスト user_id を事前取得して bind 登録

### 6-2. Production Intent: (b) Mirai / Uehara Connect（後続）

**本番運用では Mirai 側 Connect main battlefield を想定**（Uehara Connect 等）。First smoke 完了後に移行。

```
【Production-shaped フロー（後続）】
1. Miraishachu が 307 と Connect 共有チャネルを作成（または既存 Connect を使用）
2. Miraishachu 側で @Tomori をメンション（home team wake）
3. 307 側メンバーの投稿は cross_team bind で Tomori wake
```

**Production intent の理由:**
- Mirai 側がホストで制御しやすい
- Home team wake と cross-team wake を両方活用
- 実運用に近い形でのオペレーション

**移行タイミング:** First smoke (a) 完了 + 基本動作確認後

---

## 7. Security / Tenant Isolation — Trust Boundary チェックリスト

### 7-1. 信頼境界

| 境界 | 確認項目 | 対策 |
|------|----------|------|
| **受信 org → wake org** | 明示的 bind 必須 | `cross_team_wake_bindings` に登録がなければ no wake |
| **wake org 内部** | RLS 維持 | wake webhook は employee binding から取得（org-scoped） |
| **監査分離** | wake org に記録 | `appendAuditEvent` は wake_org_id を使用 |

### 7-2. 攻撃シナリオと対策

| シナリオ | リスク | 対策 |
|----------|--------|------|
| 悪意ある org が bind を作成して他 org 社員を wake | 高 | **bind 作成は wake_org_id の権限者のみ**（受信 org からは作成不可） |
| bind の receiving_team_id を偽装 | 中 | event envelope の `team_id` と照合 |
| 無関係なチャネルからの wake | 中 | チャネル分類 + audience 評価は wake 後も適用 |

### 7-3. Admin MCP 権限モデル（提案）

```
tools/call: crossTeamWake.bind
arguments: {
  "receivingTeamId": "T40CKLB5Z",
  "mentionedSlackUserId": "U_TOMORI_307",
  "employeeId": "emp_xxx",   // 自 org の社員のみ指定可
  "enabled": true,
  "jobId": "job_xxx"
}
承認: always_human
```

**制約:** `employeeId` は現在の org 内の社員のみ。他 org の社員への bind は作成不可。

---

## 8. Rollout — フラグ管理

### 8-1. フラグ定義

```typescript
// lib/feature-flags.ts
export function isCrossTeamWakeEnabled(orgId: string): boolean {
  // Phase 1: org 単位のフラグ
  // デフォルト: false
  return getOrgFeatureFlag(orgId, "cross_team_wake_enabled");
}
```

### 8-2. ロールアウトフェーズ

| フェーズ | 対象 | 条件 |
|----------|------|------|
| **Phase 0** | OFF（本 PR） | 設計ロックのみ |
| **Phase 1** | Miraishachu / 307 のみ | explicit enable + security review 完了 |
| **Phase 2** | 希望テナント | Admin MCP で `always_human` 承認 |
| **Phase 3** | 全テナント opt-in | ドキュメント整備後 |

### 8-3. 有効化の前提条件

- [x] First smoke ロック完了（Ando 2026-09-18: (a) 307 `#aitest`）
- [ ] Bind テーブル構造ロック完了（Yasaka / Ando）
- [ ] Security review（本メモ §7 チェックリスト）
- [ ] `cross_team_wake_bindings` テーブルマイグレーション
- [ ] resolveWakeTargets への cross-team 分岐追加
- [ ] Admin MCP ツール実装（`crossTeamWake.bind` / `crossTeamWake.list`）
- [ ] 監査イベント追加
- [ ] First smoke 完了: (a) 307 `#aitest` → Tomori wake
- [ ] Production intent へ移行: (b) Mirai / Uehara Connect

**Production enable は本 PR とは別 GO。**

---

## 9. Non-Goals（スコープ外）

| 項目 | 理由 |
|------|------|
| **G6 ダッシュボード classify self-serve** | 別チケット。本 PR は bind のみ |
| **F8** | enforcement auto / manual 切り替えは別スコープ |
| **prefer_thread 変更** | B2 reply policy 側。本 PR では触れない |
| **Public Distribution 変更** | App Directory 非公開を維持 |
| **相手方 WS へのアプリ配布** | Wake stance ロック通り。相手方にはアプリを配布しない |

---

## 10. 用語集

| 用語 | 定義 |
|------|------|
| **receiving_team_id** | イベントが発生した Slack team_id（相手方 WS） |
| **home_team_id** | AI 社員が本来所属する Slack team_id（自社 WS） |
| **cross_team_wake** | receiving_team_id ≠ home_team_id の場合の wake routing |
| **explicit bind** | 明示的に登録された routing ルール |

---

## 11. ロック状況まとめ

### ✅ ロック済み

| # | 項目 | ロック | 決定者 |
|---|------|--------|--------|
| 2 | **First smoke** | **(a) 307 `#aitest`** — canonical test path | Ando 2026-09-18 |

### 🔒 ロック待ち（Yasaka / Ando 承認待ち）

| # | 項目 | 選択肢 | 推奨 |
|---|------|--------|------|
| 1 | Bind テーブル構造 | Option A（新テーブル `cross_team_wake_bindings`）/ Option B（既存 `employee_slack_identities` 拡張） | **A** |

### ロック後のアクション

1. Bind テーブル構造ロック完了
2. 本メモをマージ
3. SQL マイグレーション PR 作成
4. resolveWakeTargets 拡張 PR 作成
5. Admin MCP ツール PR 作成
6. First smoke (a) 307 `#aitest` 実施
7. Production intent (b) Mirai Connect へ移行
8. Production enable（別 GO）

---

## 変更履歴

| 日付 | 変更 |
|------|------|
| 2026-09-18 | 初版作成（設計ロック待ち） |
| 2026-09-18 | **First smoke ロック**: (a) 307 `#aitest` を canonical test path に決定（Ando）。(b) Mirai Connect は production intent として後続。|

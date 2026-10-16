# TOKYO307 組織全体停止（ORG_HOLD）再テスト手順 — 2026-10-16

対象 org: `92f3617c-33fc-4dac-b9b4-d4f42e8522ac`（TOKYO307 / トーキョーサンマルナナ株式会社）  
本番: https://staffpass.sealith.com  
この文書は **手順と読み取り専用 SQL だけ**。停止・解除・UPDATE/RPC は八坂さんが実行する。エージェントは本番へ書き込まない。

---

## 0. 前提（#377 が本番に載っていること）

判定は GitHub Production デプロイの commit SHA が merge commit `be7ec2b12da63e0ce7e037083b9cd803f0ed3457`（#377、2026-10-15 17:35:03 UTC merge）以降を含むか。

| 根拠 | 値 |
|---|---|
| #377 merge SHA | `be7ec2b12da63e0ce7e037083b9cd803f0ed3457` |
| その Production デプロイ | GitHub deployment **7099833716**、2026-10-15 17:36:27 UTC、status success、Vercel `https://vercel.com/tyasakas-projects/grokbot-control-plane/CWYSYZhSL1kKRyeJvL53QnEJBeNB` |
| 現行 Production（この文書作成時点） | GitHub deployment **7109167072**、SHA `700452d65031d524da5b4263575fe52fa3d9057c`、2026-10-16 02:14:54 UTC、status success、Vercel `https://vercel.com/tyasakas-projects/grokbot-control-plane/DWUt9j7FzLSVsdzLd1nWndn5dsUv` |
| SHA 包含 | `700452d` の親は `fba1ae1`、その親は `be7ec2b`（docs のみ 2 commit 先行。hold コードは #377 のまま） |

`staffpass.sealith.com` は Vercel（`server: Vercel`）。`staffpass_health` は `runtimeMode=production` / `publicOrigin=https://staffpass.sealith.com`。

**結論: #377 は本番反映済み。** デプロイ後に #377 より古い SHA が Production に載ったら中止。

#377 の中身（`lib/safety/hold-actions.ts` `actorForAdminStop`）: `/admin` 停止で、対象 org の **active owner かつ Auth `userId` 一致** なら `startedVia=web` / `startedBy=member:<id>`。本物の運営（その org の owner でない super-admin）は従来どおり `ops_console`。既存 hold の identity はデプロイだけでは直らない。

---

## 1. 画面・API・文言（コードから。推測しない）

| 用途 | URL / 経路 | 文言 | 出典 |
|---|---|---|---|
| ログイン | `/login`（未ログイン `/admin` は `/login?next=/admin&reason=session`） | 見出し「管理画面」、ボタン「ログイン」 | `app/login/page.tsx`, `app/admin/layout.tsx`, `components/LoginForm.tsx` |
| ログアウト | `POST /api/auth/logout` | ボタン「ログアウト」 | `components/AppShell.tsx`, `components/admin/AdminShell.tsx` |
| 運営管理 | `/admin`（sidebar「運営管理」、`session.superAdmin` のときだけ） | 「運営管理」 | `components/AppShell.tsx` |
| 組織ページ | `/admin/organizations/92f3617c-33fc-4dac-b9b4-d4f42e8522ac` | セクション「緊急停止（運営）」 | `app/admin/organizations/[id]/page.tsx` + `components/admin/OpsHoldStopForm.tsx` |
| 組織全体を止める | ボタン「組織全体を停止」→ `POST /api/admin/holds/stop` `{ orgId, scope: "org", reason }` | 成功 `via=web`: 「停止しました（解除はダッシュボードで別のオーナーが承認します）」。成功 `via=ops_console`: 「停止しました（解除は S4 の二人承認で行います）」 | `OpsHoldStopForm.tsx`, `app/api/admin/holds/stop/route.ts` |
| テナントダッシュボード | `/app`（nav「変更ログ」） | パネル見出し「緊急停止（組織全体）」 | `lib/dashboard/nav.ts`, `app/app/page.tsx` `<HoldPanel scope="org" />` |
| 停止中表示 | HoldPanel `kind=stopped` | **「緊急停止中」**（「停止中」ではない）＋開始時刻 JST | `components/holds/HoldPanel.tsx` `KIND_JA` |
| 解除申請ボタン | 同上、`opsHold===false` かつ未申請 | **「解除を申請」**（「解除申請」ではない） | `HoldPanel.tsx` |
| 解除申請 API | `POST /api/holds/release/request` `{ holdId, reason }` | 成功メッセージ「解除を申請しました。別の人の承認を待っています。」 | `HoldPanel.tsx`, `app/api/holds/release/request/route.ts` |
| ops hold のとき | `opsHold===true` | 「運営が止めた停止です。解除を申請は出せません（運営のみ）。誤って「運営管理」から止めた場合は運営に連絡してください。」 | `HoldPanel.tsx` |
| 承認画面 | `/app/approvals`（nav「承認」） | hold 行のボタン **「解除を承認」**（汎用は「承認」） | `lib/dashboard/nav.ts`, `components/ApprovalsClient.tsx` |
| 解除承認 API | `POST /api/holds/release/approve` `{ holdId }` | パネル成功「解除しました」。案内「緊急停止の解除です。申請した本人は承認できません。ログインし直して5分以内に『解除を承認』を押してください。」 | `HoldPanel.tsx`, `ApprovalsClient.tsx`, `lib/approvals/hold-release-web.ts` |
| 状態 GET | `GET /api/holds/status?scope=org` | `hold.startedVia`, `hold.opsHold`（`startedVia === "ops_console"`）, `me`（`member:<id>`） | `app/api/holds/status/route.ts` |
| 監査 UI | `/app/audit`（nav「閲覧」） | 詳細のラベルは「実行者」。要約は `summary`。注記用の独立列 `note` は無い | `lib/dashboard/nav.ts`, `components/audit/AuditTimeline.tsx` |

フラグ: `EMPLOYEE_HOLD_ENABLED` かつ `ORG_HOLD_ENABLED` が ON でないと org パネルは出ない（`lib/safety/hold-config.ts`, `lib/safety/hold-display.ts`）。前回 hold が存在するので本番は ON 想定。パネルが消えたら中止。

---

## 2. 5分以内再ログインの根拠

解除の申請・承認は **web のみ** かつ **このセッション自身の認証が 5 分以内**。

| 定数 / 判定 | 値 | 出典 |
|---|---|---|
| 窓 | `HOLD_RELEASE_FRESH_LOGIN_MAX_AGE_MS = 5 * 60_000`（5分） | `lib/safety/hold-config.ts` |
| 計測 | 検証済み JWT の `amr[].timestamp`（秒）の最新。`iat` でも「別端末の sign-in」でもない | `lib/safety/hold-release-auth.ts` |
| 面 | `HOLD_RELEASE_SURFACES = ["web"]` | `lib/safety/hold-config.ts` |
| 失敗コード | `fresh_login_required` → 「解除にはログインし直してください（5分以内のログインが必要です）。」 | `hold-release-auth.ts`, `lib/approvals/hold-release-web.ts` |
| トークン更新 | refresh は再認証にならない（`iat` を使わない） | `hold-release-auth.ts` ファイル先頭コメント |

手順: 操作の直前に「ログアウト」→ `/login` で「ログイン」。そのあと 5 分以内に「解除を申請」または「解除を承認」。ダッシュボードを開いたまま放置してから押すと落ちる。

---

## 3. 事前確認（読み取りのみ）— 既存 hold `efcfe065-566d-43af-9255-ddf2af03d5fe`

#377 本文: この hold は当時 `startedVia=ops_console` / `opsHold=true`。テナントの `POST /api/holds/release/request` は **403 `ops_hold_ops_only`**。デプロイだけでは identity は変わらない。

2026-10-16 02:21 UTC 前後、本番 MCP（org `92f3617c-…`）の `staffpass_whoami` / `staffpass_profile` / `staffpass_health` は **成功**した。`checkOperable` が org hold なら whoami は 403 `org_on_hold` になる（`lib/auth/employee-credential.ts`, `lib/mcp-oauth/resource-server.ts`, `app/api/mcp/route.ts`）。よって **今は org 全体は止まっていない**（`efcfe065` は解除済みか、`orgs.hold_id` から外れている）。再テスト前に下の SQL で確定する。

### 未解除だった場合の影響（再テスト禁止）

`start_employee_hold` は既存 open hold と同等以下の rank なら **新しい行を作らず既存を返す**（`supabase/migrations/20261012500000_employee_holds.sql`）。rank は ops_console=4 > web stopped=2（同ファイル `employee_hold_rank`、`lib/safety/hold-store.ts` `holdRank`）。

- owner が `/admin` から止めても `started_via` は `ops_console` のまま。
- `/app` は `opsHold=true`、「解除を申請」は出ない。
- 申請しても 403 `ops_hold_ops_only`。
- 再テストの合否は取れない。先に §8 で戻してからやり直す。

### 事前 SQL（SELECT のみ）

```sql
-- A. 既存 hold と org ポインタ
select
  h.id,
  h.org_id,
  h.employee_id,
  h.kind,
  h.reason,
  h.started_by,
  h.started_via,
  h.started_at,
  h.release_requested_by,
  h.release_requested_at,
  h.release_reason,
  h.release_approval_id,
  h.released_by,
  h.released_at,
  h.superseded_by,
  h.superseded_at,
  o.hold_id   as orgs_hold_id,
  o.hold_state as orgs_hold_state
from public.employee_holds h
join public.orgs o on o.id = h.org_id
where h.id = 'efcfe065-566d-43af-9255-ddf2af03d5fe';

-- B. TOKYO307 のいま開いている org hold（employee_id is null）
select h.id, h.started_via, h.started_by, h.kind, h.released_at, h.superseded_at,
       o.hold_id, o.hold_state
from public.orgs o
left join public.employee_holds h
  on h.id = o.hold_id and h.org_id = o.id
where o.id = '92f3617c-33fc-4dac-b9b4-d4f42e8522ac';

-- C. 二人承認できる人（info@ 申請、tyasaka@ 承認）
select m.id, m.user_id, m.email, m.display_name, m.role, m.status,
       (m.id = any(o.designated_admin_member_ids)) as designated_admin
from public.org_members m
join public.orgs o on o.id = m.org_id
where m.org_id = '92f3617c-33fc-4dac-b9b4-d4f42e8522ac'
  and m.status = 'active'
  and (m.role = 'owner' or m.id = any(o.designated_admin_member_ids))
order by m.role, m.email;
```

合否:

- `orgs.hold_id` が null かつ `efcfe065.released_at` または `superseded_at` が not null → 再テスト可。
- `orgs.hold_id = efcfe065` かつ `started_via = 'ops_console'` → **再テスト中止**（§8）。
- `tyasaka@` が owner / 指定管理者でない → 承認できない。中止。
- `info@` の `user_id` が空、または role が owner でない → `/admin` 停止が `ops_console` になる。中止。

---

## 4. 再テスト本体

登場人物: **info@**（TOKYO307 owner かつ SUPER_ADMIN allowlist。`/admin` から止める） / **tyasaka@**（別の owner または指定管理者。`/app/approvals` で承認）。  
一人オーナー例外（`singleOwnerSelfRelease`）は使わない。TOKYO307 は二人がいる前提。

各段階の SQL は **SELECT のみ**。値は走ったあとに埋める。

### 段階 1 — info@ が管理画面から組織全体を停止

1. info@ で https://staffpass.sealith.com/login?next=/admin にログイン。
2. 「運営管理」→ https://staffpass.sealith.com/admin/organizations/92f3617c-33fc-4dac-b9b4-d4f42e8522ac
3. 「緊急停止（運営）」で理由（任意、社内向け、≤500）を入れ、「組織全体を停止」を押す。

**画面合否**

- 成功メッセージが **「停止しました（解除はダッシュボードで別のオーナーが承認します）」**（`via=web`）。
- **失敗（即中止）**: 「停止しました（解除は S4 の二人承認で行います）」→ `ops_console`。§8。

**API 合否**（DevTools）: `POST /api/admin/holds/stop` が 200、`via: "web"`、`created: true`。`via: "ops_console"` なら中止。

**DB 合否**

```sql
select h.id, h.employee_id, h.kind, h.started_via, h.started_by, h.started_at, h.reason,
       o.hold_id, o.hold_state
from public.orgs o
join public.employee_holds h on h.id = o.hold_id and h.org_id = o.id
where o.id = '92f3617c-33fc-4dac-b9b4-d4f42e8522ac';
```

| 列 | 期待 |
|---|---|
| `employee_id` | `null`（org 全体） |
| `kind` | `stopped` |
| `started_via` | **`web`**（`ops_console` なら不合格） |
| `started_by` | **`member:<info@ の org_members.id>`**（`ops:` で始まったら不合格） |
| `orgs.hold_state` | `stopped` |
| `orgs.hold_id` | 新しい hold UUID（`efcfe065` ではない） |

**監査合否**（`appendAuditEvent` in `lib/safety/hold-actions.ts` `startHold`）

```sql
select id, created_at, action, actor_email, employee_id, purpose, summary, metadata
from public.audit_events
where org_id = '92f3617c-33fc-4dac-b9b4-d4f42e8522ac'
  and action = 'employee.hold.started'
  and created_at > now() - interval '30 minutes'
order by created_at desc;
```

| 列 | 期待 |
|---|---|
| `action` | `employee.hold.started` |
| `actor_email` | info@ のメンバーメール |
| `employee_id` | `null` |
| `summary` | 新規なら「緊急停止しました」 |
| `metadata->>'via'` | `web` |
| `metadata->>'startedBy'` | `member:<info@ の member id>` |
| `metadata->>'scope'` | `org` |
| `metadata->>'holdId'` | 上の hold id |
| `metadata->>'auditClass'` | `admin` |

`/app/audit`（#373/#374）: org 行は `employee_id` なし + `actor_email` あり → 実行者は **人**、氏名＋マスクメール（`lib/audit/actor.ts` `resolveAuditActor`）。操作ラベル「緊急停止を開始」（`lib/audit/labels-ja.ts`）。独立した note 列は無く、注記は `summary`。

**MCP 合否（この段階ではまだ「止まっている」こと）**: まだ押さない。段階 2 のあと。

**失敗時の戻し**: 止まらなかった（503 `hold_start_failed`）→ 再押下可。`via=ops_console` で止まってしまった → **テナント解除を試さない**。§8。

---

### 段階 2 — `/app` に「緊急停止中」と「解除を申請」が出る

1. 同じ info@ で https://staffpass.sealith.com/app を開く。
2. パネル「緊急停止（組織全体）」を見る。

**画面合否**

- 「緊急停止中」＋ JST 時刻。
- **「解除を申請」** と必須欄「解除の理由（必須）」がある。
- ops 文言（「運営が止めた停止です…」）が **無い**。

**API 合否**: `GET /api/holds/status?scope=org`

| フィールド | 期待 |
|---|---|
| `state` | `held` |
| `hold.startedVia` | `web` |
| `hold.opsHold` | **`false`** |
| `hold.releaseRequested` | `false` |
| `me` | `member:<ログイン中の member id>` |

**MCP 合否（ここで見る）**: TOKYO307 の社員 MCP で `staffpass_whoami`（または任意の gated 呼び出し）。認証の `checkOperable` が先に走るので whoami 本体は届かない。

期待:

- HTTP **403**
- JSON-RPC `error.code` = **-32001**
- `error.message` = `organization is on emergency stop`
- `error.data.code` = **`org_on_hold`**

出典: `lib/auth/employee-credential.ts` `holdRefusal`、`lib/mcp-oauth/resource-server.ts`、`app/api/mcp/route.ts`（`tools/call` 失敗時に `data.code = auth.code`）。

**失敗時の戻し**: 「解除を申請」が無く ops 文言 → `opsHold=true`。§8。whoami が成功したまま → org が止まっていない。段階 1 の SQL を再実行。フラグ OFF でパネル非表示 → 中止（設定は変えない）。

---

### 段階 3 — 5分以内に再ログインして解除申請（info@）

1. `/app` で「ログアウト」。
2. すぐ `/login?next=/app` で info@ 再ログイン。
3. 5 分以内に「解除の理由（必須）」を入れて「解除を申請」。

**画面合否**: 「解除を申請しました。別の人の承認を待っています。」本人には「解除を申請済みです。別のオーナーか指定管理者の承認を待っています…」。

**API 合否**: `POST /api/holds/release/request` 200、`singleOwnerSelfRelease: false`（TOKYO307 は二人いる前提）。`true` なら一人例外になっており、本シナリオの意図と違う。

**DB 合否**

```sql
select h.id, h.started_via, h.started_by,
       h.release_requested_by, h.release_requested_at, h.release_reason, h.release_approval_id
from public.employee_holds h
join public.orgs o on o.hold_id = h.id
where o.id = '92f3617c-33fc-4dac-b9b4-d4f42e8522ac';
```

| 列 | 期待 |
|---|---|
| `started_via` | まだ `web` |
| `release_requested_by` | `member:<info@ の member id>` |
| `release_reason` | 画面に書いた理由 |
| `release_approval_id` | not null（`approval_requests.id`） |

チケット:

```sql
select id, title, purpose, tool, status, metadata
from public.approval_requests
where org_id = '92f3617c-33fc-4dac-b9b4-d4f42e8522ac'
  and coalesce(metadata->>'adminTool', tool, '') = 'employee.hold.release'
  and created_at > now() - interval '30 minutes'
order by created_at desc;
```

期待: `title` = 「緊急停止の解除（組織全体）」、`purpose` / `tool` = `employee.hold.release`、`status` = `pending`（`lib/safety/hold-actions.ts` `requestHoldRelease`）。

**監査合否**

```sql
select id, created_at, action, actor_email, employee_id, summary, metadata
from public.audit_events
where org_id = '92f3617c-33fc-4dac-b9b4-d4f42e8522ac'
  and action = 'employee.hold.release_requested'
  and created_at > now() - interval '30 minutes'
order by created_at desc;
```

| 列 | 期待 |
|---|---|
| `action` | `employee.hold.release_requested` |
| `actor_email` | info@ |
| `employee_id` | `null` |
| `summary` | 「緊急停止の解除申請」 |
| `metadata->>'requestedBy'` | `member:<info@ member id>` |
| `metadata->>'via'` | `web` |
| `metadata->>'holdId'` | 当該 hold |
| `metadata->>'approvalId'` | チケット id |

`/app/audit` ラベル: 「緊急停止の解除を申請」。実行者は人（info@）。理由の本文は audit ではなく `employee_holds.release_reason`。

**MCP**: まだ `org_on_hold` のまま（申請だけでは解除しない）。

**失敗時の戻し**

| 症状 | 戻し |
|---|---|
| `fresh_login_required` | ログアウト→ログインして 5 分以内に再押下。チケットはまだ無い |
| `ops_hold_ops_only` | テナント解除不可。§8 |
| `release_already_requested` | 二重申請。既存チケットを tyasaka@ が承認する |
| `release_reason_required` | 理由を入れて再押下 |

---

### 段階 4 — tyasaka@ が `/app/approvals` で承認＝解除

`approveHoldRelease` は承認と `release_employee_hold` を続けて呼ぶ。ボタンは「解除を承認」で、成功すると hold は閉じる（段階 5 と同操作）。

1. tyasaka@ でログアウト→ログイン（5 分窓）。info@ のセッションでは承認しない（`self_approval_denied`）。
2. https://staffpass.sealith.com/app/approvals
3. 行「緊急停止の解除（組織全体）」で **「解除を承認」**（汎用の「承認」ではない。汎用は `hold_release_web_only`）。

**画面合否**: エラー無し。HoldPanel の「緊急停止中」が消える（`/app` 再読み込み）。

**API 合否**: `POST /api/holds/release/approve` 200。

**失敗時の戻し**

| 症状 | 戻し |
|---|---|
| `fresh_login_required` | 再ログインして 5 分以内。チケットは pending のまま |
| `self_approval_denied` | 申請者本人。tyasaka@ でやり直す |
| `hold_release_web_only` | 汎用「承認」を押した。『解除を承認』を使う |
| `ops_hold_ops_only` | §8 |
| `release_approver_not_allowed` | owner / 指定管理者ではない |

承認に成功したら段階 5 の SQL を取る。失敗して hold が残っていたら、チケットを pending に戻す実装がある（`hold-actions.ts` `approveHoldRelease` の catch）。同じチケットで再試行。

---

### 段階 5 — 解除の確定

**DB 合否**

```sql
select o.hold_id, o.hold_state,
       h.id, h.started_via, h.started_by, h.released_by, h.released_at,
       h.release_requested_by, h.release_approval_id
from public.orgs o
left join public.employee_holds h
  on h.org_id = o.id
 and h.employee_id is null
 and h.started_at > now() - interval '2 hours'
where o.id = '92f3617c-33fc-4dac-b9b4-d4f42e8522ac'
order by h.started_at desc nulls last;
```

| 列 | 期待 |
|---|---|
| `orgs.hold_id` / `hold_state` | **両方 null** |
| `released_at` | not null |
| `released_by` | `member:<tyasaka@ の member id>`（制約は `member:` のみ。`ops:` 不可） |
| `started_via` | 履歴行は `web` のまま |

**監査合否**（`release_employee_hold` が **同じトランザクション** で insert。`supabase/migrations/20261012500000_employee_holds.sql`。アプリの `appendAuditEvent` ではない）

```sql
select id, created_at, action, actor_email, employee_id, purpose, summary, metadata
from public.audit_events
where org_id = '92f3617c-33fc-4dac-b9b4-d4f42e8522ac'
  and action = 'employee.hold.released'
  and created_at > now() - interval '30 minutes'
order by created_at desc;
```

| 列 | 期待（書き込み設計） | `/app/audit` 投影（#373/#374） |
|---|---|---|
| `action` | `employee.hold.released` | ラベル「緊急停止を解除」 |
| `summary` | 「緊急停止を解除しました」（`approveHoldRelease` の `auditSummary`） | 同じ要約 |
| `actor_email` | **SQL insert は `actor_email` を書かない → null** | org 行は `employee_id` も null なので実行者は **「システム」**（`resolveAuditActor`）。人は `metadata.approverEmail` / `releasedBy` に残る |
| `employee_id` | `null` | AI 扱いにしない |
| `metadata->>'releasedBy'` | `member:<tyasaka@ member id>` | 投影の実行者欄には出ない |
| `metadata->>'requestedBy'` | `member:<info@ member id>` | 同上 |
| `metadata->>'via'` | `web` | 同上 |
| `metadata->>'approverEmail'` | tyasaka@ | 生 JSON は出さない |
| `metadata->>'freshLogin'` | `true` | 同上 |
| `metadata->>'holdId'` / `approvalId` | 当該 id | 承認票は prefix のみ |

**MCP 合否**: `staffpass_whoami` が再び **200 / `ok: true`**。`org_on_hold` が消える。

**GET** `/api/holds/status?scope=org` → `state: "none"`、`hold: null`。パネルは停止ボタン「緊急停止」に戻る。

---

## 5. 段階横断チェックリスト

| 段階 | `started_via` | `opsHold` | `started_by` | MCP | audit `action` |
|---|---|---|---|---|---|
| 1 停止 | `web` | （status は 2 で見る） | `member:<info@>` | （2 で見る） | `employee.hold.started` |
| 2 表示 | `web` | `false` | 同上 | `org_on_hold` | （1 の行） |
| 3 申請 | `web` | `false` | 同上 | まだ `org_on_hold` | `employee.hold.release_requested` |
| 4–5 承認＝解除 | 履歴は `web` | ポインタ消滅 | 同上 | whoami 成功 | `employee.hold.released` |

---

## 6. `ops_console` で詰まったときの戻し（実行は八坂さん。エージェントは書かない）

S4（運営二人承認）の画面は無い。`app/api/admin/holds/` に release ルートは無い（#377）。テナント RPC `request_employee_hold_release` / `release_employee_hold` は `started_via = 'ops_console'` または `started_by like 'ops:%'` で `ops_hold_ops_only`（同 migration）。`released_by` 制約も `member:` のみ。

identity（`started_via` / `started_by`）は trigger `employee_holds_guard` で **不変**（`hold_write` でも変更不可）。#377 の「先に経路を tenant に直す」は、ガードを外すか、ガードを通る専用関数が必要。

**やってはいけない**

- テナントの「解除を申請」（403）。
- もう一度 `/admin` 停止で上書き（ops rank 4 ＞ web 2 なので既存が残る）。
- エージェントや AI 社員による解除。

**戻し（書き込み。本番でやるのは人間だけ）**

1. 下の READ で対象 hold を確定。
2. ガードを **短時間だけ** 無効化し、`started_via='web'` と `started_by='member:<owner uuid>'` を **同時に** 更新する（`employee_holds_ops_route`: ops_console ⇔ `ops:` が対）。すぐガードを戻す。
3. そのあと通常の申請→ tyasaka@ 承認→ `release_employee_hold`（監査は RPC が `employee.hold.released` を書く）。
4. 失敗したらガードが有効なことを確認して止まる。org を「止まっていない」ことにする直接 UPDATE は、`hold_columns_guard` / `employee_holds_function_only` に当たる。

```sql
-- READ ONLY（実行してよい）
select h.id, h.started_via, h.started_by, h.released_at, h.superseded_at,
       o.hold_id, o.hold_state
from public.orgs o
left join public.employee_holds h on h.id = o.hold_id
where o.id = '92f3617c-33fc-4dac-b9b4-d4f42e8522ac';

-- WRITE（この文書のエージェントは実行しない。コメントのまま）
-- begin;
--   alter table public.employee_holds disable trigger employee_holds_guard;
--   update public.employee_holds
--      set started_via = 'web',
--          started_by  = 'member:<TOKYO307-owner-member-uuid>'
--    where id = '<stuck-hold-id>'
--      and org_id = '92f3617c-33fc-4dac-b9b4-d4f42e8522ac'
--      and released_at is null and superseded_at is null
--      and started_via = 'ops_console';
--   alter table public.employee_holds enable trigger employee_holds_guard;
-- commit;
-- 続けて UI で request → approve（release_employee_hold）。
```

`efcfe065` がまだ open なら、同じ手順で tenant 化してから通常解除する。**再テスト用の新しい停止は、open ops hold が消えてから。**

---

## 7. 監査ログ本番確認用 SQL（#373 / #374）— SELECT のみ

#373/#374 は `audit_events` を書き換えない。読み取り投影だけ。DB の期待は hold の書き込み経路。`/app/audit` の期待は `presentAuditRow` / `resolveAuditActor`。

注記: テーブルに `note` 列は無い。見るのは `summary` と `metadata`（`reason` は started の audit には入らない。理由は `employee_holds.reason` / `release_reason`）。

### 7a. 購買AI社員の停止と解除（2026-10-16 00:46 JST ± = 2026-10-15 15:46 UTC ±）

```sql
-- 購買AI社員の特定（display_name / role_label。ID は推測しない）
select id, display_name, role_label, status
from public.employees
where org_id = '92f3617c-33fc-4dac-b9b4-d4f42e8522ac'
  and (
    display_name ilike '%購買%'
    or role_label ilike '%購買%'
  );

-- 当該時刻の hold 監査 3 行
select
  e.id,
  e.created_at,
  e.created_at at time zone 'Asia/Tokyo' as created_at_jst,
  e.action,
  e.actor_email,
  e.employee_id,
  emp.display_name as employee_display_name,
  e.purpose,
  e.summary,
  e.metadata
from public.audit_events e
left join public.employees emp
  on emp.id = e.employee_id and emp.org_id = e.org_id
where e.org_id = '92f3617c-33fc-4dac-b9b4-d4f42e8522ac'
  and e.action in (
    'employee.hold.started',
    'employee.hold.release_requested',
    'employee.hold.released'
  )
  and e.created_at >= '2026-10-15 15:30:00+00'
  and e.created_at <  '2026-10-15 16:10:00+00'
order by e.created_at;

-- 同時刻の employee hold 行（理由はこっち）
select id, employee_id, kind, reason, started_by, started_via, started_at,
       release_requested_by, release_reason, released_by, released_at
from public.employee_holds
where org_id = '92f3617c-33fc-4dac-b9b4-d4f42e8522ac'
  and employee_id is not null
  and started_at >= '2026-10-15 15:30:00+00'
  and started_at <  '2026-10-15 16:10:00+00'
order by started_at;
```

書き込みの期待（コード）:

| action | `actor_email` | `employee_id` | `summary` | metadata の要点 |
|---|---|---|---|---|
| `employee.hold.started` | 止めた人のメール | 購買AI社員 UUID | 「緊急停止しました」 | `via`, `startedBy`, `scope=employee`, `holdId`。**reason は metadata に無い** |
| `employee.hold.release_requested` | 申請者メール | 同じ UUID | 「緊急停止の解除申請」 | `requestedBy`, `via`, `approvalId`, `holdId`。理由は `employee_holds.release_reason` |
| `employee.hold.released` | **null**（SQL が列を埋めていない） | 同じ UUID | 「緊急停止を解除しました」 | `releasedBy`, `requestedBy`, `via`, `approverEmail`, `freshLogin`, `holdId`, `approvalId` |

`/app/audit` 投影の期待（#374: `employee_id` 優先で AI）:

| action | 実行者 kind | 実行者名 | メール | 注記として見えるもの |
|---|---|---|---|---|
| 3 行とも | **AI** | 購買AI社員の `displayName` | バインド mailbox があればマスク。人の `actor_email` は出さない | リストは `summary`。詳細「実行者」は AI 名。人の操作者は投影では隠れる |

これは「人が止めた／解除した」という運用感覚とずれる。#373/#374 の仕様どおり（`lib/audit/actor.ts`, `lib/audit/actor.test.ts`）。不一致として記録する。

### 7b. TOKYO307 組織解除 hold `efcfe065`（2026-10-16 02:33 JST = 2026-10-15 17:33 UTC ±）

#377 merge（17:35 UTC）の **直前**。当時は ops_console だった。

```sql
select
  e.id,
  e.created_at,
  e.created_at at time zone 'Asia/Tokyo' as created_at_jst,
  e.action,
  e.actor_email,
  e.employee_id,
  e.purpose,
  e.summary,
  e.metadata
from public.audit_events e
where e.org_id = '92f3617c-33fc-4dac-b9b4-d4f42e8522ac'
  and (
    e.metadata->>'holdId' = 'efcfe065-566d-43af-9255-ddf2af03d5fe'
    or e.action in (
      'employee.hold.started',
      'employee.hold.release_requested',
      'employee.hold.released',
      'employee.hold.release_refused'
    )
  )
  and e.created_at >= '2026-10-15 16:00:00+00'
  and e.created_at <  '2026-10-15 18:00:00+00'
order by e.created_at;

select id, employee_id, kind, reason, started_by, started_via, started_at,
       release_requested_by, release_requested_at, release_reason,
       release_approval_id, released_by, released_at, superseded_at
from public.employee_holds
where id = 'efcfe065-566d-43af-9255-ddf2af03d5fe';
```

通常 RPC 解除なら `employee.hold.released` が 17:33 UTC 前後に 1 行。`actor_email` は null、`employee_id` は null、`summary` は「緊急停止を解除しました」。`/app/audit` では実行者「システム」。`started` が ops 経路なら `metadata.via` / `startedBy` は `ops_console` / `ops:…`。SQL バイパスで閉じた場合は `released` 行が無い可能性があり、それ自体が設計（RPC と同トランザクション）からのずれ。

---

## 8. このエージェントが本番でやったこと / やらなかったこと

やった（読み取り）:

- GitHub deployments / commit status / `git merge-base` 相当の祖先確認。
- コード読取。
- 本番 MCP `staffpass_profile` / `staffpass_whoami` / `staffpass_health`（TOKYO307、2026-10-16 02:21 UTC 前後、whoami 成功 → 当時 org は hold されていない）。
- `GET https://staffpass.sealith.com`（ヘッダのみ）。

やらなかった:

- INSERT/UPDATE/DELETE/RPC/マイグレーション/hold 操作/設定変更。
- `staffpass_invoke`（gated で副作用があり得る）。
- 本番 `audit_events` / `employee_holds` の SELECT（この環境に Supabase 接続情報も、動く Admin MCP も無い）。

`audit_events` の実値はこの文書では埋めない。§7 を SQL Editor に貼る。

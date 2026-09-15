# Admin Proxy Approval — プラットフォーム運用によるテナント承認代行

**日付:** 2026-09-15  
**起案:** 木村（Yasaka GO）  
**状態:** 実装GO（2026-09-15）  
**関連:** Admin MCP / `/admin/organizations/[id]` / スペースツリー・LINE承認受信口セットアップ  

---

## 0. 問題

新テナントの初期設定時、LINE / Telegram 承認インボックスが空（未設定）のため、セットアップ代行で `roles.propose` / `employees.issue` を承認できない。通常の承認フロー（`POST /api/approvals/[id]/approve`）は `getCurrentOrgId()` からログインセッションの org を取得するため、**別テナントのチケットを解決できない**。

## 1. 方針ロック

1. Super Admin は **任意のテナント org の pending 承認チケット** をプラットフォーム運用として解決できる。
2. 必須 **名目（mandate）**: `setup`（セットアップ代行） | `support`（サポート対応）。拡張可能。
3. 任意 **メモ（note）**: 自由記述。
4. 監査（`admin.proxy_approve`）: `targetOrgId`, `approvalId`, `mandate`, `note`, `actorEmail`, `actorUserId`, `decision`, `timestamp`。テナント監査ログに「プラットフォーム代行」として記録。
5. **自己承認拒否**: 管理エージェントは自身のリクエストを承認できない（既存ルール踏襲）。
6. 承認後の実行（fulfill）パスは既存と同一（`fulfillApprovedAdmin` / `fulfillApprovedInvoke`）。
7. 提供面:
   - **UI**: `/admin/organizations/[id]` に pending approvals リスト + 承認/却下パネル
   - **Admin MCP**: `approvals.proxyResolve`（プラットフォームゲート必須、`always_human` 二重ラップなし）

## 2. UI: `/admin/organizations/[id]`

`pendingApprovals > 0` のときにパネル表示。

- GET `/api/admin/organizations/[orgId]/approvals` — 対象 org の pending 承認リスト
- POST `/api/admin/organizations/[orgId]/approvals/[approvalId]/resolve` — プロキシ解決

### リクエストボディ（resolve）

```json
{
  "decision": "approved" | "rejected",
  "mandate": "setup" | "support",
  "note": "任意のメモ"
}
```

### レスポンス（成功）

```json
{
  "ok": true,
  "approval": { /* 更新後の ApprovalRequest */ },
  "sideEffects": { /* 通知結果等 */ },
  "decision": "approved",
  "mandate": "setup",
  "actorEmail": "superadmin@example.com"
}
```

## 3. Admin MCP: `approvals.proxyResolve`

### 入力

| フィールド | 必須 | 備考 |
|------------|------|------|
| `orgId` | yes | 対象テナント org UUID |
| `approvalId` | yes | 解決する承認チケット UUID |
| `decision` | yes | `approved` \| `rejected` |
| `mandate` | yes | `setup` \| `support` |
| `note` | no | 監査メモ |
| `jobId` | no | 相関 job ID |

### 出力（成功）

```json
{
  "ok": true,
  "decision": "approved",
  "mandate": "setup",
  "approvalId": "apr_xxx",
  "status": "approved",
  "resolvedBy": "admin@platform-ops.example",
  "resolvedAt": "2026-09-15T10:00:00.000Z",
  "tool": "employees.issue",
  "jobId": "job_123",
  "sideEffectsRan": true,
  "summaryJa": "承認しました（プラットフォーム代行・setup）"
}
```

### ゲート

- `assertPlatformOpsFromAdminCred` と同じ（SUPER_ADMIN allowlist + optional PLATFORM_OPS_ORG_ID）
- 通常テナント `gb_adm_` では `platform_ops_forbidden`

### always_human ではない理由

このツールは **プラットフォーム運用者がテナントの代わりに承認する行為そのもの**。二重に承認チケットを作ると鶏卵問題になる。ゲート（SUPER_ADMIN + PLATFORM_OPS_ORG_ID）で制限し、監査で重点記録。

## 4. 監査

### アクション

`admin.proxy_approve`

### メタデータ

```json
{
  "proxyApproval": true,
  "mandate": "setup",
  "note": "Space Tree初期設定のため",
  "decision": "approved",
  "actorEmail": "admin@platform-ops.example",
  "actorUserId": "user_xxx",
  "approvalId": "apr_xxx",
  "tool": "employees.issue",
  "jobId": "job_123"
}
```

### テナント監査ログ表示（日本語）

```
【プラットフォーム代行承認】セットアップ代行: 稲盛 の社員証発行 / メモ: Space Tree初期設定のため
```

## 5. AC

| ID | 内容 |
|----|------|
| P1 | Super Admin は `/admin/organizations/[id]` で対象 org の pending approvals を一覧できる |
| P2 | UI から mandate 選択 + 確認で承認/却下できる |
| P3 | Admin MCP `approvals.proxyResolve` で同等の操作ができる（platform-ops gate 必須） |
| P4 | mandate 必須。未指定は validation error |
| P5 | 監査に `admin.proxy_approve` が記録される（mandate, note, actorEmail, actorUserId 含む） |
| P6 | 自己承認は引き続き拒否（既存ルール） |
| P7 | 承認後の fulfill は既存パスと同一 |
| P8 | reject 時も通知メッセージ更新（既存の resolve side effects 踏襲） |

## 6. スペースツリー実証での利用例

1. `orgs.create` でテナント作成（承認待ち）
2. Admin MCP で `roles.propose` / `employees.issue`（承認待ち）
3. LINE 承認口が未設定なので通常承認不可
4. Super Admin が `/admin/organizations/6d134a38-a0ab-4a8e-aba7-3202650ff523` を開く
5. 承認待ちリストから対象チケットを選択
6. mandate: `setup` + note: 「Space Tree 初期セットアップ代行」で承認
7. 監査ログに「プラットフォーム代行承認」として記録
8. または Admin MCP で `approvals.proxyResolve { orgId, approvalId, decision: "approved", mandate: "setup", note }`

## 7. Out of scope

- 自動承認（人間の Super Admin / platform-ops actor 必須）
- テナントオーナーへのメール通知ルーティング変更
- LINE OA セットアップ自体

## 8. 実装場所

- `lib/admin/proxy-approve.ts` — プロキシ承認ロジック
- `lib/types.ts` — `AuditAction` に `admin.proxy_approve` 追加
- `lib/admin-mcp/audit-class.ts` — admin audit actions に追加
- `app/api/admin/organizations/[orgId]/approvals/route.ts` — GET（リスト）
- `app/api/admin/organizations/[orgId]/approvals/[approvalId]/resolve/route.ts` — POST（解決）
- `components/admin/ProxyApprovalPanel.tsx` — UI コンポーネント
- `app/admin/organizations/[id]/page.tsx` — パネル表示
- `lib/mcp/admin-tools.ts` — `approvals.proxyResolve` ツール定義・ハンドラ
- `lib/mcp/admin-public.ts` — ツール名登録
- `public/.well-known/mcp/admin-server-card.json` — server card 更新

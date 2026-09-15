# Admin MCP — super admin によるテナント作成

**日付:** 2026-09-15  
**起案:** 安藤／依頼: 八坂  
**状態:** 実装GO（2026-09-15）  
**関連:** signup（`/api/auth/signup`）／Admin MCP／スペースツリー実証  

---

## 0. 問題

スペースツリー実証など、セルフ signup を待たずに **運用側（super admin）がテナントを先に作る**必要がある。P0 はダッシュボード UI 必須ではなく、**Admin MCP で完走**できればよい。

## 1. 方針ロック

1. Admin MCP 必須: `orgs.create`（**always_human**）。任意: `orgs.status`。
2. 中身は **signup と同じパイプライン**: Auth user + org + owner member + trial。
3. 監査アクション `create_org`。**パスワード平文を監査・レスポンス・ログに出さない**。
4. UI はあればよい。P0 は MCP で完走。
5. AI社員（例: 稲盛）は **作成後** に `employees.issue`。本ツールでは org+owner まで。

## 2. 入力

| フィールド | 必須 | 既定 | 備考 |
|------------|------|------|------|
| `orgName` | yes | — | 例: 株式会社スペースツリー |
| `ownerEmail` | yes | — | 人間オーナー推奨。例: k.nogi@spacetree.jp |
| `integrationMode` | no | `managed` | `managed` \| `byo` |
| `trialDays` | no | `14` | max `365` |
| `invite` | no | — | 招待フロー有無（signup 既存に合わせる） |
| `ownerDisplayName` | no | — | 任意 |
| `ownerPassword` | 条件付き | — | Auth 新規時。平文は監査禁止。invite のみなら生成／招待に委譲可 |

## 3. 出力（成功）

- `orgId`, `ownerUserId`, `ownerEmail`, `trialEndsAt`, `integrationMode`, `summaryJa`, `nextStepJa`
- パスワードは返さない

## 4. 監査

- `create_org`（admin change log クラス）
- メタ: orgId, orgName, ownerEmail, integrationMode, trialDays, actor
- **never** password / refresh tokens

## 5. AC

| ID | 内容 |
|----|------|
| C1 | `orgs.create` は always_human。未承認では org が作られない |
| C2 | 成功時 Auth + org + owner + trial が揃う（signup 相当） |
| C3 | trialDays 既定14・上限365。不正値は validation error |
| C4 | 監査に create_org。パスワード平文なし |
| C5 | 既存 email の回復／重複は signup と同方針（fail 明示 or repair パス） |
| C6 | 任意 `orgs.status` で orgId の trial/status を読める |

## 6. スペースツリー実証の想定値（運用メモ）

- orgName: 株式会社スペースツリー
- ownerEmail: k.nogi@spacetree.jp（人間）
- AI社員 稲盛（k.inamori@spacetree.jp）は作成後 `employees.issue`
- Staffpass は 307 trial OK（別途）

## 7. Out of scope

- employees.issue 本体
- フルダッシュボード UI（任意）
- 課金プラン強制変更

## 8. プラットフォームゲート（fail-closed）

Admin MCP はテナントスコープ（`gb_adm_` → `org_admin_agents.org_id`）。`orgs.create` / `orgs.status` は **プラットフォーム運用者のみ**。

ゲート条件（**いずれかを満たすこと。未設定・不一致は拒否**）:

1. **呼び出し元 org の active owner** が `SUPER_ADMIN_USER_IDS` / `SUPER_ADMIN_EMAILS` に一致（`/admin` ダッシュボードと同じ allowlist）
2. **かつ** 任意で `PLATFORM_OPS_ORG_ID` が設定されている場合、呼び出し元 `cred.orgId` が一致（TOKYO307 運用 org などの明示ピン留め）

通常テナントの `gb_adm_` では `platform_ops_forbidden` で拒否される。

## 9. 実装メモ

- パイプライン: `createOrgWithOwner` / `provisionOrgForUser`（`lib/auth/session.ts`）を再利用。`trialDays` は引数で上書き可。
- 承認キュー: `ownerPassword` は平文を `adminMutation` に残さない。暗号化して `ownerPasswordCiphertext` のみ保存。
- `invite=true` かつ password 省略時は履行時にランダム生成（監査・レスポンス・ログに出さない）。
- **承認後の再呼び出し:** ステータス poll が `pollHint: reinvoke_with_approvalId` を返したら、同じ `orgs.create` を `approvalId` 付きで再呼び出す（`arguments.approvalId` / `_meta.approvalId` / トップレベル `approvalId` のいずれか）。承認済みなら `fulfillApprovedAdmin` を一度だけ実行し、`orgId` / `ownerEmail` / `trialEndsAt` / `summaryJa` / `nextStepJa` を返す。新しい承認チケットは作らない。

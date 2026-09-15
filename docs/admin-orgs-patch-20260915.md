# Admin MCP — プラットフォーム運用者による組織名変更

**日付:** 2026-09-15  
**起案:** ops依頼  
**状態:** 実装完了  
**関連:** `orgs.create` / `orgs.status` / Super Admin ダッシュボード  

---

## 0. 問題

TOKYO307 など、運用側がテナントの組織表示名を変更する必要がある。  
セットアップ代行時に「新しい組織」から正式社名へのリネームなど。

## 1. 方針ロック

1. Admin MCP: `orgs.patch` — **NOT always_human**（プラットフォーム運用者が人として判断済み）
2. Super Admin UI: `/admin/organizations/[id]` に `OrgRenameForm` 追加（TrialExtensionForm と同パターン）
3. プラットフォームゲート（fail-closed）: `orgs.create` / `orgs.status` と同じ `assertPlatformOpsFromAdminCred`
4. 監査: `admin.org_patch` アクション、メタに `previousName`, `newName`, `actorEmail`, `adminAction: rename_org`

## 2. なぜ always_human にしないか

- Trial延長と同じ理由: プラットフォーム運用者（Super Admin allowlist 上の org owner）がすでに人として判断している
- 承認チケットを挟むと二重確認になり、運用フローが煩雑化する
- UI パスは Super Admin セッション（`getSuperAdminAccess`）で保護
- MCP パスはプラットフォームゲート（`assertPlatformOpsFromAdminCred`）で保護

## 3. 入力

| フィールド | 必須 | 備考 |
|------------|------|------|
| `orgId` | yes | 対象テナントの UUID |
| `name` | yes | 新しい組織表示名（trim、非空、最大200文字） |

## 4. 出力（成功）

```json
{
  "ok": true,
  "orgId": "...",
  "previousName": "新しい組織",
  "newName": "トーキョーサンマルサンマルナナ株式会社",
  "summaryJa": "新しい組織 → トーキョーサンマルサンマルナナ株式会社 に名称変更しました"
}
```

## 5. 監査

- アクション: `admin.org_patch`
- メタ: `previousName`, `newName`, `actorEmail`, `actorUserId`, `adminAction: rename_org`
- Super Admin UI 経由の場合は `adminEmail` を使用

## 6. AC

| ID | 内容 |
|----|------|
| C1 | `orgs.patch` はプラットフォームゲート通過時のみ実行可能（`platform_ops_forbidden` で拒否） |
| C2 | 変更成功時に監査ログ `admin.org_patch` が記録される |
| C3 | Super Admin UI `/admin/organizations/[id]` に組織名変更フォーム表示 |
| C4 | 空の名前、200文字超は validation error |
| C5 | 同一名への変更は `noChange: true` で即座に返却（冪等） |

## 7. UI パス

- `/admin/organizations/[id]` に `OrgRenameForm` コンポーネント追加
- API: `POST /api/admin/org-rename`
- Super Admin セッション（`getSuperAdminAccess`）で保護

## 8. TOKYO307 リネーム運用メモ

デプロイ後に ops が実行:

```
orgId: 92f3617c-33fc-4dac-b9b4-d4f42e8522ac
現在の名前: 新しい組織 (要確認)
新しい名前: トーキョーサンマルサンマルナナ株式会社
```

MCP または Super Admin UI どちらでも実行可能。

## 9. Out of scope

- owner email 変更
- org 削除
- billing フィールド変更

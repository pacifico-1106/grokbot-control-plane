# D1 添付・ファイル手渡し + Sealith 連携

**更新:** 2026-09-07  
**状態:** shipped  
**カタログ位置:** D1（B2 Slack返信 の次）

---

## 概要

Slack/外部からのメッセージ受信時に、AI社員にどのように情報を渡すかを制御するルールパック。
A1 scheduling.policy / F1 口ルーティング / B2 Slack返信 と同じ設計思想で実装。

### 主要機能

1. **本文の渡し方 (body):** `full` | `prefix` | `none`
2. **添付の渡し方 (attachment):** `file` | `meta` | `none`
3. **添付承認 (attachmentApproval):** `none` | `manager` (fail-closed)
4. **Sealith暗号化受け渡し (sealith):** `off` | `suggest` | `required`
5. **高リスク承諾:** external+file+sealith=off は明示的承諾が必要

---

## Admin MCP ツール

### `ingressHandoff.get` (read-only)

読み取り専用。承認不要。

```json
{
  "employeeId": "optional-employee-id"
}
```

**レスポンス:**
- `policy` - 有効なポリシー (policyId, policyName, rules, highRiskConsentAt/By)
- `source` - ポリシーの出所 (`employee` | `org` | `default`)
- `layers.employeeOverride` - AI社員のオーバーライド（nullなら組織ポリシーを継承）
- `layers.orgPolicy` - 組織ポリシー
- `hasHighRiskAutomation` - 高リスク設定の有無
- `highRiskConsentRecorded` - 高リスク承諾の記録有無

### `ingressHandoff.patch` (always_human)

ポリシーの更新。人間の承認が必要。

**パラメータ:**

| 名前 | 型 | 必須 | 説明 |
|------|------|------|------|
| `employeeId` | string | - | AI社員ID（指定でオーバーライド、省略で組織ポリシー） |
| `clearOverride` | boolean | - | `true` で社員オーバーライドをクリア（employeeId必須） |
| `policyName` | string | - | ポリシー名（人が読みやすいラベル） |
| `rules` | array | ✓ | ルール配列（clearOverride=true 以外） |
| `highRiskConsentAt` | string | - | ISO timestamp（高リスク設定時に必須） |
| `highRiskConsentBy` | string | - | 承諾者名/メール（高リスク設定時に必須） |
| `jobId` | string | - | ジョブ相関ID |

**ルール定義:**

```json
{
  "applyTo": "classified_external_sensitive",
  "channelIds": ["C123", "C456"],
  "body": "prefix",
  "bodyPrefixChars": 500,
  "attachment": "file",
  "attachmentApproval": "manager",
  "sealith": "required",
  "sealithRequiredHints": ["contract", "nda"],
  "sealithRequiredOtherText": "見積書",
  "audit": {
    "jobId": true,
    "sealithTransferId": true
  }
}
```

---

## Fail-Closed 挙動

### 1. `attachmentApproval=manager`

添付が `file` または `meta` で `attachmentApproval=manager` の場合：
- 添付は渡されない（`attachment=none` と同等）
- `pendingManagerApproval=true` を設定
- 監査ログに記録

**将来:** manager承認フローが実装されたら、承認後に添付を渡す。

### 2. `sealith=required` + transferId なし

`sealith=required` で Sealith transferId がない場合：
- ファイル本体は渡されない（`attachment=meta` にダウングレード）
- 監査ログに記録

### 3. 高リスク設定

`applyTo=classified_external_sensitive` + `attachment=file` + `sealith=off`:
- `highRiskConsentAt/By` がないと検証エラー
- silent enable 禁止（F4 自動の天井）
- 監査に設定を残す（F5 監査ラベル）

---

## スキーマ

### orgs テーブル

```sql
ingress_handoff_policy jsonb
```

### employees テーブル

```sql
ingress_handoff_policy jsonb
-- NULL = 組織ポリシーを継承
```

### ポリシー JSON 形状

```typescript
interface OrgIngressHandoffPolicy {
  version: 1;
  policyId: string;      // "ihp_..."
  policyName: string;    // 人が読みやすいラベル
  rules: IngressHandoffRule[];
  highRiskConsentAt?: string;
  highRiskConsentBy?: string;
  updatedAt: string;
  updatedBy: "admin_mcp";
}
```

---

## Slack Ingress パス連携

`lib/slack/mention-ingress.ts` で wake payload に以下を含める:

```typescript
ingressHandoff: {
  policyId: string;
  ruleId: string;
  bodyMode: "full" | "prefix" | "none";
  attachmentMode: "file" | "meta" | "none";
  attachmentApproval?: "none" | "manager";
  bodyTruncated?: boolean;
  sealithHandoff: "off" | "suggest" | "required";
  sealithTransferId?: string;
  pendingManagerApproval?: boolean;
  channelClassification: ChannelClassification;
}
```

---

## 便利設定（デフォルト）

新規テナントはデフォルトの便利設定で開始:

- `applyTo: "all"`
- `body: "full"` - 本文を全文渡す
- `attachment: "meta"` - 添付はメタ情報のみ（ファイル本体は渡さない）
- `sealith: "off"` - Sealith連携なし
- `attachmentApproval: "none"` - 承認なしで渡す

外部/機密チャネルにはルールを追加することを推奨。

---

## 関連ドキュメント

- `docs/staffpass-situation-policy-catalog.md` - ポリシーカタログ
- `docs/tenant-slack-kickoff-rail.md` - Slack設定ガイド
- `lib/ingress-handoff/` - 実装コード

---

## オペレーション SQL（新規カラムのみ）

**注意:** `orgs.ingress_handoff_policy` と `employees.ingress_handoff_policy` は既存マイグレーションで追加済み。

追加のスキーマ変更はありません。policyId/policyName/highRiskConsent は JSON 内のフィールドです。

# プラン別MCP許可リスト・承認ルート設計メモ

**日付:** 2026-10-01  
**起案:** Design Memo (Cloud Agent)  
**ステータス:** Draft v2  
**関連PR:** #148–#156 (approval-kind-routes 作業)

---

## 1. 背景と目的

AI社員LP (`app/lp/ai-employee`) では 3つのプラン（Intern / Proper / Executive）を販売している。各テナントに対し、プランに応じた：

1. **MCP操作の許可リスト**（どのツールが利用可能か）
2. **承認ルートのデフォルト**（誰が承認するか）

をテンプレートとして提供し、**テナント自己セットアップ**と**オペレーター伴走セットアップ**の両方で、プランが許可する範囲を案内しながら環境構築を行う。

**重要な原則:**
- **プランはツールの利用可否のみを決定**する。承認をスキップする権限は与えない。
- `send` / `confirm` / `order` / `pay` は**全プランで always_human** である。
- テナントは承認ルートを**狭める**ことのみ可能。プラン範囲を超えて**広げる**ことは不可。

---

## 2. プラン定義（ビジネスオーナー指定）

| プラン | 業務キャパ | 対象業務 |
|--------|-----------|---------|
| **Intern** | ≈1業務 | 定型・一般事務（日報/議事録下書き、定型メール下書き、社内案内下書き、予定空き確認、FAQ一次返答案） |
| **Proper** | ≈3業務 | 営業・顧客対応（Intern全て＋問い合わせ一次返信下書き、見積/提案メモ、商談日程候補、対応ログ要約、フォローアップリマインド） |
| **Executive** | 高度運用 | 経営補佐・開発保守（Proper全て＋高度な権限設計、高度な承認ルール運用、監査ログ詳細出力、開発・保守） |

参照: `app/lp/ai-employee/PricingSection.tsx` L46–L120

---

## 3. テンプレートの管理方針

### 3.1 コード内定義（Source of Truth）

プラン→スコープ/ルートのマッピングは**コード内に固定**。ツール→kind マッピングと同様、テナントによる変更は不可。

```typescript
// lib/billing/plan-scopes.ts (新規)
export const PLAN_GATEWAY_SCOPES: Record<PlanKey, GatewayToolId[]> = {
  intern: ["calendar.read", "calendar.propose", "mail.draft", ...],
  proper: ["calendar.confirm", "mail.send", "comm.send", ...],
  executive: ["files.write", "browser.use", "commerce.order", ...],
};

export const PLAN_ADMIN_SCOPES: Record<PlanKey, AdminMcpToolName[]> = {
  intern: [...],
  proper: [...],
  executive: [...],
};
```

### 3.2 既存 org の扱い

- `orgs.plan_key = NULL` は**レガシー扱い**。現行動作と完全に同一（フィルタリングなし）。
- **FK default は設けない**。`NULL` のままで動作継続。
- 既存 org へのプラン割当は**明示的な always_human admin アクション**（`orgs.patch` + 承認）。
- マイグレーションで `COALESCE(..., 'intern')` のような自動変換は**行わない**。

### 3.3 表示用テーブル（オプション）

UI表示のためにテーブルを設ける場合、**読み取り専用のスナップショット**として扱う。真実の源はコード。

```sql
-- plan_template_snapshots: 表示用のみ（Source of Truth ではない）
CREATE TABLE plan_template_snapshots (
  plan_key TEXT PRIMARY KEY,
  gateway_scopes TEXT[] NOT NULL,
  admin_scopes TEXT[] NOT NULL,
  display_name_ja TEXT NOT NULL,
  description_ja TEXT,
  synced_at TIMESTAMPTZ DEFAULT NOW()
);
-- RLS: read-only for all authenticated
```

---

## 4. Per-Plan MCP許可リスト

### 4.1 Gatewayツール→プランマッピング

参照: `lib/gateway/tools.ts` (GATEWAY_TOOL_DEFS)

**注意:** プランはツールの**利用可否**のみを決定。`forceNeedsApproval` / `always_human` はプランに関係なく**常に適用**される。

| Gatewayツール | kind | always_human | Intern | Proper | Executive | 業務項目 |
|--------------|------|--------------|--------|--------|-----------|---------|
| `calendar.read` | read | ✗ | ✓ | ✓ | ✓ | 予定の空き確認 |
| `calendar.propose` | propose | ✗ | ✓ | ✓ | ✓ | 予定の空き確認と候補提示 |
| `calendar.confirm` | confirm | **✓** | ✗ | ✓ | ✓ | 日程確定（always_human） |
| `mail.draft` | draft | ✗ | ✓ | ✓ | ✓ | 定型メール/日報/議事録の下書き |
| `mail.send` | send | **✓** | ✗ | ✓ | ✓ | メール送信（always_human） |
| `comm.reply` | mutate | audience-gated | ✓ | ✓ | ✓ | FAQ一次返答案、社内案内下書き |
| `comm.send` | mutate | audience-gated | ✗ | ✓ | ✓ | フォローアップのリマインド |
| `slack.post` | mutate | audience-gated | ✓ | ✓ | ✓ | 社内案内の投稿準備 |
| `commerce.quote` | propose | ✗ | ✗ | ✓ | ✓ | 見積・提案メモの整理 |
| `commerce.order` | order | **✓** | ✗ | ✗ | ✓ | 発注（always_human） |
| `files.read` | read | ✗ | ✓ | ✓ | ✓ | 顧客対応ログの要約 |
| `files.write` | mutate | **✓** | ✗ | ✗ | ✓ | マスタ更新（always_human） |
| `browser.use` | mutate | **✓** | ✗ | ✗ | ✓ | ブラウザ利用（always_human） |
| `knowledge.search` | read | ✗ | ✓ | ✓ | ✓ | FAQ一次返答案の検索 |
| `audit.append` | mutate | ✗ | ✗ | ✗ | ✓ | 監査ログ詳細出力 |
| `drive.share_external` | send | **✓** | ✗ | ✗ | ✓ | 社外共有（always_human） |
| `sns.publish` | send | **✓** | ✗ | ✗ | ✓ | SNS投稿（always_human） |

### 4.2 Admin MCPツール→プランマッピング

参照: `lib/mcp/admin-public.ts` (ADMIN_MCP_TOOL_NAMES)

**原則:**
- **読み取り専用ツール（`*.get`, `*.list`, `*.status`, `*.inspect`）はプランゲートしない**
- プラン機能に関連する**変更系ツール（`*.patch`, `*.upsert` 等）のみゲート**
- `orgs.create` はオペレーター側操作（テナント自己セットアップには含めない）
- Intern は「メール/LINE/Slack承認」を含むため、voter binding ツールは利用可能

| Admin MCPツール | 種別 | Intern | Proper | Executive | 備考 |
|----------------|------|--------|--------|-----------|------|
| **基本セットアップ** |
| `employees.issue` | mutation | ✓ | ✓ | ✓ | AI社員証発行 |
| `link` | mutation | ✓ | ✓ | ✓ | Grok Bot紐付け |
| `roles.propose` | mutation | ✓ | ✓ | ✓ | 役割提案 |
| **承認チャネル設定（Intern含む）** |
| `setup.slackStatus` | read | ✓ | ✓ | ✓ | Slack診断 |
| `setup.slackAdapter.setBotToken` | mutation | ✓ | ✓ | ✓ | Slackアダプタ設定 |
| `setup.lineApprovalStatus` | read | ✓ | ✓ | ✓ | LINE診断 |
| `setup.lineApproval.upsert` | mutation | ✓ | ✓ | ✓ | LINE承認チャネル設定 |
| `setup.lineApproval.setEmployeeInbox` | mutation | ✓ | ✓ | ✓ | 社員別LINE設定 |
| `setup.lineApproval.demoteTelegram` | mutation | ✓ | ✓ | ✓ | Telegram無効化 |
| `setup.approverBindingStatus` | read | ✓ | ✓ | ✓ | 承認者バインディング診断 |
| `approvalWorkflow.get` | read | ✓ | ✓ | ✓ | 承認ワークフロー参照 |
| `approvalWorkflow.bindVoter` | mutation | ✓ | ✓ | ✓ | 承認者バインド |
| `approvalWorkflow.unbindVoter` | mutation | ✓ | ✓ | ✓ | 承認者アンバインド |
| `approvalWorkflow.resendVoterVerification` | mutation | ✓ | ✓ | ✓ | 検証再送 |
| `approvalWorkflow.listVoterBindings` | read | ✓ | ✓ | ✓ | バインディング一覧 |
| `approvalWorkflow.inspect` | read | ✓ | ✓ | ✓ | ワークフロー詳細 |
| `approvalWorkflow.remind` | mutation | ✓ | ✓ | ✓ | リマインド |
| `channels.classify` | mutation | ✓ | ✓ | ✓ | 基本チャネル分類 |
| **ポリシー変更（Proper以上）** |
| `policy.patch` | mutation | ✗ | ✓ | ✓ | カスタム承認フロー |
| `parties.upsert` | mutation | ✗ | ✓ | ✓ | 相手台帳（複数チャネル） |
| `approvalWorkflow.patch` | mutation | ✗ | ✓ | ✓ | ワークフロー変更 |
| `schedulingPolicy.get` | read | ✓ | ✓ | ✓ | 日程調整ポリシー参照 |
| `schedulingPolicy.patch` | mutation | ✗ | ✓ | ✓ | 日程調整ポリシー変更 |
| `replyPolicy.get` | read | ✓ | ✓ | ✓ | 返信ポリシー参照 |
| `replyPolicy.patch` | mutation | ✗ | ✓ | ✓ | 返信ポリシー変更 |
| `mailPolicy.get` | read | ✓ | ✓ | ✓ | メールポリシー参照 |
| `mailPolicy.patch` | mutation | ✗ | ✓ | ✓ | メールポリシー変更 |
| `internalAudienceRule.get` | read | ✓ | ✓ | ✓ | 内部ルール参照 |
| `internalAudienceRule.patch` | mutation | ✗ | ✓ | ✓ | 内部ルール変更 |
| **高度運用（Executive）** |
| `ingressHandoff.get` | read | ✓ | ✓ | ✓ | 権限設計参照 |
| `ingressHandoff.patch` | mutation | ✗ | ✗ | ✓ | 高度な権限設計 |
| `stuckWatch.get` | read | ✓ | ✓ | ✓ | スタック監視参照 |
| `stuckWatch.list` | read | ✓ | ✓ | ✓ | スタック一覧 |
| `stuckWatch.inspect` | read | ✓ | ✓ | ✓ | スタック詳細 |
| `stuckWatch.patch` | mutation | ✗ | ✗ | ✓ | スタック監視設定 |
| `stuckWatch.retry` | mutation | ✗ | ✗ | ✓ | スタック再試行 |
| `stuckWatch.resolve` | mutation | ✗ | ✗ | ✓ | スタック解決 |
| `stuckWatch.classify` | mutation | ✗ | ✗ | ✓ | スタック分類 |
| `employeeIdentity.status` | read | ✓ | ✓ | ✓ | ID状態参照 |
| `employeeIdentity.upsert` | mutation | ✗ | ✗ | ✓ | IDバインド |
| `employeeIdentity.bindMailbox` | mutation | ✗ | ✗ | ✓ | メールボックスバインド |
| **オペレーター専用（テナントセットアップ外）** |
| `orgs.create` | mutation | — | — | — | オペレーター専用 |
| `orgs.status` | read | ✓ | ✓ | ✓ | org状態参照 |
| `orgs.patch` | mutation | ✓ | ✓ | ✓ | org更新（plan_key変更含む） |
| `orgs.issueAdminCredential` | mutation | ✓ | ✓ | ✓ | admin credential発行 |
| `approvals.proxyResolve` | mutation | ✓ | ✓ | ✓ | 承認代理 |
| `setup.connectInternalBase` | read | ✓ | ✓ | ✓ | Connect診断 |

### 4.3 ギャップ分析（既存ツールなし）

| 業務項目 | 必要な機能 | ギャップ |
|---------|-----------|---------|
| 週次レポート（Proper機能） | 自動要約・定期配信 | **要実装**: `report.weekly` ツールまたは cron job |
| 週次論点整理（Executive） | 経営向けサマリー生成 | **要実装**: 上記の拡張 |
| 開発・保守の調査と実装案 | コード分析・PR作成 | **外部連携**: Cursor Agent / GitHub MCP（スコープ外） |

---

## 5. デフォルト承認ルート（per-plan）

### 5.1 承認種別（approval kind）とルートの対応

参照: PR #148 `lib/approval-kind-routes/types.ts`

| kind | 説明 | 対象ツール |
|------|------|-----------|
| `post` | Slack/LINE投稿 | `slack.post`, `comm.reply`, `comm.send` (audience-gated) |
| `mail` | メール送信 | `mail.send` (always_human) |
| `account` | org/admin操作 | admin tools with always_human |
| `decision` | 稟議（D1–D4対応） | `commerce.order`, high-value operations |
| `other` | その他confirm/send/order | `calendar.confirm`, `files.write`, etc. |

### 5.2 共通セキュリティ不変条件

PR #148–#156 より、**全プラン共通**:

1. **`send` / `confirm` / `order` / `pay` は常に always_human**。プランはこれを緩和できない。
2. **AI approver は禁止** (`ai_approver_forbidden`)
3. **self-approval は禁止** (`self_approval_forbidden`)
4. **`account` kind は owner/admin のみ承認可能**
5. **ツール→kind マッピングはコード固定**（テナント変更不可）
6. **空の approvers は不可**。すべてのルートに最低1名の承認者を指定。

### 5.3 共通デフォルト値（全プラン）

| パラメータ | デフォルト値 |
|-----------|-------------|
| `amountThresholdJpy` | 500,000 JPY（税抜） |
| `remindEveryDays` | 3 |
| `onExpire` | `fail_closed` |
| `sensitiveTopics` | `["金額", "支払", "請求", "口座", "予算", "決算", "税務", "報酬", "契約条件", "個人情報", "役員人事", "定款"]` |

### 5.4 プラン別デフォルトルート

**注意:** テナントは `approvalRoutes.patch`（always_human）を通じてルートを**狭める**ことのみ可能。プラン範囲を超えて広げることは不可。

#### 全プラン共通ルート構造

```typescript
// lib/billing/plan-approval-routes.ts (新規)
const COMMON_ROUTE_DEFAULTS = {
  quorum: { type: "any" },
  onExpire: "fail_closed",
  remindEveryDays: 3,
};

const SENSITIVE_TOPICS = [
  "金額", "支払", "請求", "口座", "予算", "決算",
  "税務", "報酬", "契約条件", "個人情報", "役員人事", "定款"
];
```

#### Intern プラン

```typescript
{
  version: 1,
  policyId: "plan_intern_default",
  policyName: "Intern デフォルト承認ルート",
  routes: [
    {
      kind: "post",
      approverUserIds: ["{{owner}}"],
      quorum: { type: "any" },
      onExpire: "fail_closed",
      remindEveryDays: 3,
      // 内部 non-confidential は egress/audience gate で自動
      // 外部・機密は承認必須
    },
    {
      kind: "mail",
      approverUserIds: ["{{owner}}"],
      quorum: { type: "any" },
      onExpire: "fail_closed",
      remindEveryDays: 3,
    },
    {
      kind: "account",
      approverUserIds: ["{{owner}}"],
      quorum: { type: "any" },
      onExpire: "fail_closed",
      remindEveryDays: 3,
    },
    {
      kind: "other",
      approverUserIds: ["{{owner}}"],
      quorum: { type: "any" },
      onExpire: "fail_closed",
      remindEveryDays: 3,
    },
  ],
  topicGate: {
    enabled: true,
    sensitiveTopics: SENSITIVE_TOPICS,
    mainBoardChannelIds: [],
  },
}
```

#### Proper プラン

```typescript
{
  version: 1,
  policyId: "plan_proper_default",
  policyName: "Proper デフォルト承認ルート",
  routes: [
    {
      kind: "post",
      approverUserIds: ["{{owner}}", "{{admins}}"],
      quorum: { type: "any" },
      onExpire: "fail_closed",
      remindEveryDays: 3,
    },
    {
      kind: "mail",
      approverUserIds: ["{{owner}}", "{{admins}}"],
      quorum: { type: "any" },
      onExpire: "fail_closed",
      remindEveryDays: 3,
    },
    {
      kind: "account",
      approverUserIds: ["{{owner}}"],
      quorum: { type: "any" },
      onExpire: "fail_closed",
      remindEveryDays: 3,
    },
    {
      kind: "decision",
      approverUserIds: ["{{owner}}", "{{admins}}"],
      quorum: { type: "any" },
      onExpire: "fail_closed",
      remindEveryDays: 3,
      decisionWorkflow: {
        amountThresholdJpy: 500000,
        tiers: [...DEFAULT_DECISION_TIERS],
      },
    },
    {
      kind: "other",
      approverUserIds: ["{{owner}}", "{{admins}}"],
      quorum: { type: "any" },
      onExpire: "fail_closed",
      remindEveryDays: 3,
    },
  ],
  topicGate: {
    enabled: true,
    sensitiveTopics: SENSITIVE_TOPICS,
    mainBoardChannelIds: [],
  },
}
```

#### Executive プラン

```typescript
{
  version: 1,
  policyId: "plan_executive_default",
  policyName: "Executive デフォルト承認ルート",
  routes: [
    // Proper と同様の構造
    // finalGoUserId, deadlineHours, voterWeights が設定可能
  ],
  topicGate: {
    enabled: true,
    sensitiveTopics: SENSITIVE_TOPICS,
    mainBoardChannelIds: [], // テナント設定可能
  },
  decisionWorkflow: {
    enabled: true,
    amountThresholdJpy: 500000,
    tiers: [...FULL_DECISION_TIERS], // T1/T2/T3 + 稟議
  },
}
```

---

## 6. セットアップ案内順序

### 6.1 テナント自己セットアップ（セルフサービス）

**注意:** `orgs.create` はオペレーター側操作。テナント自己セットアップには含めない。

#### Intern

1. `roles.propose` → AI社員の役割定義
2. `employees.issue` → AI社員証発行（scopes制限: Internスコープのみ）
3. `link` → Grok Bot紐付け
4. `setup.slackStatus` → Slack連携診断
5. `setup.slackAdapter.setBotToken` → Slackアダプタ設定
6. `channels.classify` → 基本チャネル分類
7. `setup.lineApprovalStatus` → LINE承認チャネル診断（オプション）
8. `setup.lineApproval.upsert` → LINE承認チャネル設定（オプション）
9. `approvalWorkflow.bindVoter` → 承認者バインド
10. **完了**: 基本運用開始

#### Proper

1–10: Intern と同様  
11. `parties.upsert` → 相手台帳登録  
12. `schedulingPolicy.patch` → 日程調整ポリシー  
13. `replyPolicy.patch` → 返信ポリシー  
14. `approvalWorkflow.patch` → カスタム承認フロー  
15. **完了**: 週次レポート設定案内

#### Executive

1–14: Proper と同様  
15. `ingressHandoff.patch` → 高度な権限設計  
16. `stuckWatch.patch` → スタック監視設定  
17. `employeeIdentity.upsert` → ID管理設定  
18. **完了**: 監査ログ出力設定案内

### 6.2 オペレーター伴走セットアップ

Admin MCPを使用し、上記順序に従って案内。各ステップで：

1. **プランの許可範囲を表示**: 「このプランでは X が使用可能です」
2. **スコープ超過を警告**: 「この操作は上位プランが必要です。アップグレードをご検討ください」
3. **推奨設定を提案**: 「〇〇業務には△△の設定をお勧めします」

---

## 7. プラン変更

### 7.1 基本原則

| 変更種別 | トリガー | スコープ変更 | 承認要否 |
|---------|---------|-------------|---------|
| **ダウングレード** | Stripe webhook (verified) | 即時縮小 (fail-closed) | 不要（webhook自動） |
| **キャンセル** | Stripe webhook (verified) | 即時縮小 (fail-closed) | 不要（webhook自動） |
| **停止 (suspension)** | Stripe webhook (verified) | 即時縮小 (fail-closed) | 不要（webhook自動） |
| **アップグレード** | Stripe webhook (verified) | always_human 承認後に適用 | **必須** |

### 7.2 ダウングレード・キャンセル・停止（fail-closed）

Stripe webhook で検証済みイベントを受信後、**即時**にスコープを縮小。

```typescript
// lib/billing/plan-change.ts (新規)
export async function handlePlanNarrowing(
  orgId: string,
  oldPlanKey: PlanKey | null,
  newPlanKey: PlanKey | null, // null = cancelled/suspended
  stripeEventId: string
): Promise<PlanChangeResult> {
  // 1. イベント冪等性チェック (event.id で重複排除)
  if (await isEventProcessed(stripeEventId)) {
    return { skipped: true, reason: "already_processed" };
  }

  // 2. スコープ差分計算
  const oldScopes = oldPlanKey ? PLAN_SCOPES[oldPlanKey] : ALL_SCOPES;
  const newScopes = newPlanKey ? PLAN_SCOPES[newPlanKey] : [];
  const revokedScopes = oldScopes.filter(s => !newScopes.includes(s));

  // 3. 保留中の承認を取り消し
  await cancelPendingApprovals(orgId, revokedScopes, "plan_downgrade_scope_revoked");

  // 4. 既存オーバーライドの無効化
  await disableOutOfPlanOverrides(orgId, newScopes);

  // 5. 監査ログ
  await appendAuditLog({
    orgId,
    event: newPlanKey ? "plan_downgraded" : "plan_cancelled",
    metadata: { oldPlanKey, newPlanKey, revokedScopes, stripeEventId },
  });

  // 6. イベント処理済みマーク
  await markEventProcessed(stripeEventId);

  return { success: true, revokedScopes };
}
```

### 7.3 アップグレード（always_human 承認必須）

Stripe webhook を受信しても**自動適用しない**。always_human admin チケットを作成し、owner 承認後に適用。

```typescript
export async function handlePlanUpgradeRequest(
  orgId: string,
  oldPlanKey: PlanKey | null,
  newPlanKey: PlanKey,
  stripeEventId: string
): Promise<PlanUpgradeTicketResult> {
  // 1. イベント冪等性チェック
  if (await isEventProcessed(stripeEventId)) {
    return { skipped: true, reason: "already_processed" };
  }

  // 2. always_human admin 承認チケット作成
  const ticket = await createApprovalTicket({
    orgId,
    kind: "account",
    tool: "orgs.patch",
    purpose: "plan_upgrade",
    metadata: { oldPlanKey, newPlanKey, stripeEventId },
    // owner のみ承認可
    approverFilter: { roles: ["owner"] },
  });

  // 3. イベント処理済みマーク
  await markEventProcessed(stripeEventId);

  return { ticketId: ticket.id, awaitingApproval: true };
}

// 承認後の適用
export async function applyPlanUpgrade(
  approvalId: string
): Promise<PlanChangeResult> {
  const approval = await getApproval(approvalId);
  if (approval.status !== "approved") {
    throw new Error("plan_upgrade_requires_approval");
  }

  const { orgId, oldPlanKey, newPlanKey } = approval.metadata;

  // スコープ拡張
  const addedScopes = PLAN_SCOPES[newPlanKey].filter(
    s => !PLAN_SCOPES[oldPlanKey]?.includes(s)
  );

  // org.plan_key 更新
  await updateOrgPlanKey(orgId, newPlanKey);

  // 監査ログ
  await appendAuditLog({
    orgId,
    event: "plan_upgraded",
    metadata: { oldPlanKey, newPlanKey, addedScopes, approvalId },
  });

  return { success: true, addedScopes };
}
```

### 7.4 保留中の承認の処理

```typescript
async function cancelPendingApprovals(
  orgId: string,
  revokedScopes: string[],
  reason: string
): Promise<void> {
  const pendingApprovals = await listPendingApprovals(orgId);

  for (const approval of pendingApprovals) {
    const toolDef = resolveGatewayTool(approval.tool);
    if (toolDef.ok && revokedScopes.some(s => toolDef.def.requiredScopes.includes(s))) {
      await cancelApproval(approval.id, reason);
    }
  }
}
```

### 7.5 fulfill 時のプラン再チェック

承認済みでも fulfill 実行時にプランを再確認。停止・ダウングレード後は拒否。

```typescript
// lib/gateway/invoke.ts 内
async function runGatewayInvoke(req: GatewayInvokeRequest) {
  // ... existing logic ...

  // fulfill 時のプラン再チェック
  const org = await getOrg(employee.orgId);
  if (!isToolAvailableForPlan(toolDef.id, org.planKey, org.status)) {
    return {
      ok: false,
      code: "plan_scope_revoked",
      message: "このツールはご契約プランでは利用できません",
    };
  }

  // ... proceed with fulfill ...
}
```

---

## 8. Suspension（支払い失敗後の猶予期間超過）

### 8.1 挙動

**停止時にブロックするもの:**
- プランゲートされたすべてのツール実行
- **承認済みの fulfill も含む**（再チェックで拒否）

**停止時も利用可能:**
- 読み取り系ツール（`*.get`, `*.list`, `*.status`）
- セットアップ系ツール（billing 修正のため）
- ダッシュボードアクセス

```typescript
// lib/billing/suspension.ts (新規)
export function isToolBlockedDuringSuspension(
  toolId: string,
  toolType: "gateway" | "admin"
): boolean {
  if (toolType === "gateway") {
    const def = GATEWAY_TOOL_DEFS[toolId];
    // read 以外はすべてブロック
    return def?.kind !== "read";
  }

  if (toolType === "admin") {
    // read-only ツールと billing 関連はブロックしない
    const readOnlyTools = [
      "setup.slackStatus", "setup.lineApprovalStatus", "orgs.status",
      "schedulingPolicy.get", "replyPolicy.get", "mailPolicy.get",
      "ingressHandoff.get", "stuckWatch.get", "stuckWatch.list",
      "stuckWatch.inspect", "approvalWorkflow.get", "approvalWorkflow.inspect",
      "approvalWorkflow.listVoterBindings", "setup.approverBindingStatus",
      "employeeIdentity.status", "internalAudienceRule.get",
      "setup.connectInternalBase",
    ];
    return !readOnlyTools.includes(toolId);
  }

  return true;
}
```

---

## 9. Stripe連携

### 9.1 現状の実装

参照:
- `app/api/lp/ai-employee/checkout/route.ts` — チェックアウトセッション作成
- `app/api/webhooks/stripe/route.ts` — webhook処理
- `lib/data/subscriptions.ts` — subscription upsert

### 9.2 真実の源（Source of Truth）

| データ | Source of Truth |
|--------|----------------|
| `planKey` | Stripe subscription metadata |
| `status` | Stripe subscription status (mapped) |
| `trialEndsAt` | Stripe `trial_end` |
| `currentPeriodEnd` | Stripe `current_period_end` |

### 9.3 冪等性キー

**修正必要:** `Date.now()` は冪等性を破壊する。安定したキーを使用。

```typescript
// app/api/lp/ai-employee/checkout/route.ts
const checkoutAttemptId = crypto.randomUUID(); // クライアント側で生成して渡す

const session = await stripe.checkout.sessions.create({
  // ...existing config
}, {
  idempotencyKey: `checkout_${orgId}_${plan}_${checkoutAttemptId}`,
});
```

### 9.4 webhook 冪等性

```typescript
// app/api/webhooks/stripe/route.ts
export async function POST(req: Request) {
  // ... existing signature verification ...

  // event.id で重複排除
  if (await isStripeEventProcessed(event.id)) {
    return NextResponse.json({ received: true, skipped: "already_processed" });
  }

  // ... process event ...

  await markStripeEventProcessed(event.id);

  return NextResponse.json({ received: true, type: event.type });
}
```

### 9.5 webhook 拡張（プラン変更検知）

```typescript
case "customer.subscription.updated": {
  const sub = event.data.object as Stripe.Subscription;
  const previousPlanKey = event.data.previous_attributes?.metadata?.planKey;
  const currentPlanKey = sub.metadata?.planKey;

  if (previousPlanKey !== currentPlanKey) {
    const isUpgrade = isPlanUpgrade(previousPlanKey, currentPlanKey);
    if (isUpgrade) {
      await handlePlanUpgradeRequest(orgId, previousPlanKey, currentPlanKey, event.id);
    } else {
      await handlePlanNarrowing(orgId, previousPlanKey, currentPlanKey, event.id);
    }
  }

  // ... existing sync logic ...
}
```

---

## 10. ゲーティング対象（MCP以外）

### 10.1 Web UI

```typescript
// lib/billing/plan-gate-ui.ts (新規)
export function isPlanFeatureAvailable(
  planKey: PlanKey | null,
  feature: string
): boolean {
  if (planKey === null) return true; // レガシー: 制限なし
  return PLAN_UI_FEATURES[planKey]?.includes(feature) ?? false;
}
```

ダッシュボードの各セクションでプランゲートを適用:
- 設定変更フォーム（Proper以上の機能）
- 高度な権限設計セクション（Executive）
- 監査ログ詳細出力ボタン（Executive）

### 10.2 API

```typescript
// lib/billing/plan-gate-api.ts (新規)
export function assertPlanAllowsApi(
  planKey: PlanKey | null,
  apiPath: string,
  method: string
): void {
  if (planKey === null) return; // レガシー: 制限なし

  const gatedApis = PLAN_GATED_APIS[planKey];
  if (gatedApis && !gatedApis.includes(`${method} ${apiPath}`)) {
    throw new ApiError(403, "plan_feature_unavailable");
  }
}
```

---

## 11. データモデルとマイグレーション

### 11.1 orgs テーブル変更

```sql
-- 20261001_plan_rails.sql
-- plan_key カラム追加 (NULL = レガシー、デフォルトなし)
ALTER TABLE orgs ADD COLUMN plan_key TEXT;
-- FK は設けない（コードが Source of Truth）

-- status カラム追加 (subscription status のミラー)
ALTER TABLE orgs ADD COLUMN billing_status TEXT;

-- Stripe イベント重複排除
CREATE TABLE stripe_processed_events (
  event_id TEXT PRIMARY KEY,
  processed_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_stripe_events_processed_at ON stripe_processed_events(processed_at);
```

### 11.2 既存 org のマイグレーション

**自動変換は行わない。** 既存 org は `plan_key = NULL` のままレガシー動作を維持。

プラン割当は以下のいずれかで実施:
1. オペレーターが `orgs.patch` で明示的に設定（always_human 承認）
2. テナントがダッシュボードからプラン選択（Stripe checkout → webhook）

---

## 12. フィーチャーフラグ

参照: `lib/feature-flags.ts`

```typescript
/**
 * P1-PLAN-RAILS: Plan-based MCP allowlists and approval route templates.
 *
 * When ON:
 * - Gateway tools are filtered by org.plan_key → code-defined scopes
 * - Admin MCP tools are filtered by org.plan_key → code-defined scopes
 * - New orgs from Stripe checkout get plan_key from subscription metadata
 * - Plan changes trigger scope audit and pending approval cancellation
 * - Fulfill re-checks plan at execution time
 *
 * When OFF (default):
 * - Existing behavior preserved (byte-identical)
 * - All scopes available to all orgs (including plan_key = NULL)
 */
export function isPlanRailsEnabled(): boolean {
  return parseFlag(process.env.P1_PLAN_RAILS_ENABLED);
}
```

---

## 13. テスト要件

| テストカテゴリ | 内容 |
|--------------|------|
| **フラグ OFF 同一性** | `P1_PLAN_RAILS_ENABLED=false` で既存動作と byte-identical |
| **ダウングレード fail-closed** | スコープ縮小、pending 承認取消、fulfill 拒否 |
| **アップグレード承認必須** | webhook だけでは適用されない、owner 承認後に適用 |
| **オーバーライドで拡張不可** | テナントがプラン外スコープを追加しようとしたら拒否 |
| **レガシー org 互換** | `plan_key = NULL` は従来通り全スコープ利用可能 |
| **停止時ブロック** | 承認済み fulfill も含めて実行ブロック |
| **webhook 冪等性** | 同一 event.id の再処理をスキップ |

---

## 14. PR 分割と工数見積もり

| PR# | 内容 | 工数 | 依存 |
|-----|------|------|------|
| **PR-A** | `lib/billing/plan-scopes.ts` (コード内定義) + feature flag | 4h | - |
| **PR-B** | `orgs.plan_key` / `billing_status` カラム追加 + `stripe_processed_events` | 3h | PR-A |
| **PR-C** | Gateway scope filtering (MCP) | 4h | PR-B |
| **PR-D** | Admin MCP scope filtering | 4h | PR-C |
| **PR-E** | Web UI plan gating | 4h | PR-D |
| **PR-F** | API plan gating | 3h | PR-D |
| **PR-G** | Plan change handlers (downgrade/cancel/suspend: fail-closed) | 6h | PR-D |
| **PR-H** | Plan upgrade handler (always_human ticket + apply) | 4h | PR-G |
| **PR-I** | Stripe webhook拡張 (plan change detection, event.id dedupe, idempotency key) | 4h | PR-H |
| **PR-J** | Fulfill-time plan re-check | 3h | PR-G |
| **PR-K** | Setup guidance (plan-aware messaging) | 4h | PR-D |
| **PR-L** | 週次レポート機能（ギャップ実装） | 8h | PR-D |
| **PR-M** | 監査ログ詳細出力（Executive機能） | 4h | PR-D |
| **PR-N** | テスト (flag OFF同一性, downgrade fail-closed, no widening, legacy compat) | 6h | PR-J |
| **PR-O** | ドキュメント更新 | 2h | PR-N |

### 合計: 63時間

### リスク

1. **レガシー org との互換性**: `plan_key = NULL` の動作が意図通りか慎重にテスト。
2. **approval-kind-routes との統合**: PR #148–#156 が merge 前のため、依存関係に注意。
3. **Stripe webhook の信頼性**: 署名検証 + event.id 重複排除で対応。

---

## 15. オープンクエスチョン（ビジネスオーナー確認事項）

1. **週次レポートの配信先**: Slack / メール / 両方？Executive は経営向けにカスタマイズ可能？
2. **ダウングレード猶予期間**: Stripe webhook 受信後に即時スコープ剥奪か、X日間の移行期間を設けるか？
3. **Custom プランの扱い**: コード内に定義するか、完全に個別設定（`plan_key = 'custom'` + per-org override）か？
4. **Intern の LINE 承認**: ローンチ時に LINE 承認を含むか？（現状の設計では含む）
5. **Stripe Price ID マッピング**: 各 `plan_key` に対応する `STRIPE_PRICE_ID_*` 環境変数の一覧は？

---

## 16. 参照ファイル

- `app/lp/ai-employee/PricingSection.tsx` — プラン定義UI
- `lib/gateway/tools.ts` — Gateway tool allowlist
- `lib/mcp/admin-tools.ts` — Admin MCP tools
- `lib/mcp/admin-public.ts` — Admin tool names
- `lib/approval-kind-routes/types.ts` (PR #148) — Approval kind routes
- `lib/data/subscriptions.ts` — Subscription data layer
- `app/api/webhooks/stripe/route.ts` — Stripe webhook
- `lib/feature-flags.ts` — Feature flags

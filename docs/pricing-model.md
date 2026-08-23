# Staffpass 価格モデル（Ando BM P0 / P0.5）

コピー核: Grok Bot＝手足／Staffpass＝**就業規則と日報**（社員証・承認ポリシー＝就業規則、構造化監査＝日報）。

Grok Bot / Cursor の席代・トークンは再販しない。曖昧な「AI実行時間」も売らない。

表示額はすべて **税別・仮決め／事業確定前**。Checkout 実課金は Stripe Dashboard の Price が正。

## 1. 収益の3本柱（混ぜない）

| 柱 | 対価 | 顧客への言い方 | 実装 |
|----|------|----------------|------|
| **A. 制御面月額** | 就業規則を敷く固定費 | 「AI社員を雇う土台」 | Subscription `starter` / `business` / `managed` |
| **B. 導入・運用代行** | 速さ・伴走・保守 | 「キックオフ代行／日々の整備」 | Business＝初回一式（任意）／Managed＝Care 月額に含む |
| **C. ゲート従量** | 日報が残る・確定した仕事 | 「通した仕事の分」 | `gated_confirm_action` |

## 2. プラン表（税別・仮決め）

| planKey | 表示 | 月額（税別） | 仮枠（確定アクション/月） | 超過単価（税別） | 導入 |
|---------|------|--------------|---------------------------|------------------|------|
| `starter` | スターター | **¥12,000** | **50**（仮枠） | **¥80** / 件 | — |
| `business` | ビジネス | **¥39,800** | **500**（仮枠） | **¥40** / 件 | **¥150,000** 初回一式（税別） |
| `managed` | Managed（Care） | **¥128,000** | **2000**（仮枠） | **¥25** / 件 | 月額に含む |

コード定数: `lib/billing/plans.ts`（`PLAN_DISPLAY_YEN` / `PLAN_OVERAGE_YEN` / `PLAN_ONBOARDING_YEN` / `PLAN_CONFIRM_QUOTAS`）。

- Stripe Price ID: `STRIPE_PRICE_ID_STARTER` / `_BUSINESS` / `_MANAGED` / `_BUSINESS_ONBOARDING`（一式・任意）
- UI に「税別・仮決め／事業確定前」と明示。枠は **仮枠**。
- **超過の Metered Price 配線は P0.5 スタブ**（表示・ドキュメントのみ。Stripe 従量報告は未実装）。

## 3. メーター規則

**イベント名（固定）:** `gated_confirm_action`

| イベント | billable | 理由 |
|----------|----------|------|
| `mail.send` / `calendar.confirm` / `commerce.order` 等 **confirm / send / order** | **true** | Gateway **成功完了**時のみ |
| `*.propose` / `mail.draft` / 参照系 | **false**（記録しない or 非課金） | 提案は使わせる |
| 拒否・fail-closed・`needs_approval` | 課金しない | 安全側を罰しない |
| 承認 UI の Approve / Deny クリック単体 | 課金しない | 「ボタン代」にしない。課金は再 invoke 成功に寄せる |

実装:

- `lib/billing/meter.ts` — `recordGatedConfirmAction` / `countGatedConfirmsThisMonth`
- `lib/gateway/tools.ts` — `isConfirmClassTool`（kind ∈ confirm | send | order）
- `app/api/gateway/invoke` — 成功パスでのみ meter。`approvalId` 付き再 invoke で確定系が完了し得る

## 4. ハイブリッド正直さ（Hybrid honesty）

Partner API 不在のため、**Gateway 経由で成功した確定アクションだけ**を数える。

- 「全部の操作をプロキシできている」前提の従量は約束しない
- ブラウザ直操作・Gateway 外の行動はメーター外（監査ポリシーで別途扱う）
- ダッシュボードの「今月の確定アクション vs プラン枠」は Gateway 成功分のみ

## 5. P0.5 — 超過 Metered Price（スタブ）

| 項目 | 状態 |
|------|------|
| UI / docs の超過単価表示 | 済（仮決め） |
| Stripe Metered Price / Usage Records | **未配線** — Dashboard 登録はキー投入後のユーザー作業 |
| 枠超過時の自動請求 | 後続（P1） |

## 6. 参照

- 元案: 社内 staffpass-pricing-model（安藤）
- Stripe フロー: `docs/stripe-billing-notes.md`
- エンタイトルメント: `lib/billing/entitlements.ts`

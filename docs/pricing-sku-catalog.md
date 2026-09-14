# Staffpass SKU カタログ（Yasaka Two-Layer, 2026-09-13）

**更新:** 2026-09-13 (pack-first pricing simplify)  
**表示額:** 顧客向けは **税抜**。Stripe Dashboard Prices (env) が正。  

**二層構造:**
- 顧客向け: `lib/billing/packs.ts` — AI社員 Lite / Standard / Kickoff / Care
- バックエンド: `lib/billing/plans.ts` — starter / business / managed (Stripe/コスト用、顧客非表示)

関連: [`pricing-model.md`](./pricing-model.md) · [`stripe-billing-notes.md`](./stripe-billing-notes.md)

---

## 1. 顧客向けパック（Customer-facing）

### 月額パック

| パックID | 表示名 | 月額（税抜） | バックエンドSKU | 対象規模 |
|---------|--------|-------------|----------------|----------|
| `lite` | AI社員 Lite | ¥98,000 | `business` | 1名〜 |
| `standard` | AI社員 Standard | ¥198,000 | `managed` | 〜3名 |

**手足込み:** 顧客向けコピーでは手足（Grok Bot）はパックに含まれると表示。Stripe Price は分離可能。

### オプション

| オプションID | 表示名 | 価格（税抜） | 請求 |
|-------------|--------|-------------|------|
| `kickoff` | 導入（キックオフ） | ¥300,000 | 一式 |
| `care` | Care | +¥80,000 | 月額 |

コード: `lib/billing/packs.ts`

---

## 2. バックエンドSKU（Stripe/コスト用）

**IMPORTANT:** これらのSKU名（Starter/Business/Managed）は顧客に表示しない。

| skuKey | Stripe Product 命名（推奨） | env |
|--------|---------------------------|-----|
| `starter` | `Staffpass Starter` | `STRIPE_PRICE_ID_STARTER` |
| `business` | `Staffpass Business` | `STRIPE_PRICE_ID_BUSINESS` |
| `managed` | `Staffpass Managed` | `STRIPE_PRICE_ID_MANAGED` |

パックとSKUのマッピング:
- AI社員 Lite → `business` SKU
- AI社員 Standard → `managed` SKU

コード: `lib/billing/plans.ts`

---

## 3. キックオフ（¥300,000）

一式 **¥300,000（税抜）・任意**。

| # | line key | 内容 | 税抜（包装分割） |
|---|----------|------|-----------------|
| 1 | `kickoff_setup` | 初期設定・就業規則テンプレ適用 | ¥150,000 |
| 2 | `kickoff_companion` | キックオフ伴走（連携チェック・テスト承認・日報導線） | ¥150,000 |
| | | **合計** | **¥300,000** |

### 手足パススルー

手足（Grok Bot）席代は顧客向けコピーでパックに含まれると表示。Stripe 請求で分離管理可能だが、顧客への追加課金なし。

### 二重請求回避（パック初月）

- キックオフに **パック（Lite/Standard）のサブスク初月を含めない。**
- 月額は常に recurring で別請求。

コード: `lib/billing/skus.ts`

---

## 4. 削除した顧客向け要素

以下は顧客向け `/app` から削除（adminは保持可）:

| 要素 | 状態 |
|------|------|
| 三層プランセレクター（Starter/Business/Managed） | 削除 |
| 補助金バナー・ブロック | 削除 |
| Quota scare bars / 超過単価テーブル | 削除（顧客向け） |

---

## 5. 補助金関連（内部のみ）

補助金関連SKU（`subsidy_2y_business` / `subsidy_2y_managed` / `year3_extension`）は顧客向けUIから削除。内部プレースホルダとしてのみ保持。

**コンプライアンス:**
- 採択・交付・金額を保証する表現禁止
- 顧客向けUIには表示しない

---

## 6. メーター（変更なし）

- イベント名: **`gated_confirm_action`**
- 確定系 Gateway 成功完了のみ billable
- キックオフ／月額パックの件数には含めない（別柱）

詳細: [`pricing-model.md`](./pricing-model.md) · `lib/billing/meter.ts`

---

## 7. Stripe Dashboard チェックリスト

1. 既存: Starter / Business / Managed recurring — バックエンドSKUとして維持
2. **Kickoff** one-time ¥300,000 → `STRIPE_PRICE_ID_KICKOFF_PACK`
3. 補助金系: 顧客UIから削除済み。Stripe 設定は任意
4. Webhook / Portal / Tax は [`stripe-billing-notes.md`](./stripe-billing-notes.md) に従う

---

## 8. 変更履歴

| 日付 | 決定 | 内容 |
|------|------|------|
| 2026-09-13 | Yasaka | パックファースト: Lite ¥98,000 / Standard ¥198,000（税抜）|
| 2026-09-13 | Yasaka | キックオフ ¥300,000 に簡素化（旧 ¥398,000）|
| 2026-09-13 | Yasaka | Care +¥80,000/月 オプション |
| 2026-09-13 | Yasaka | バックエンドSKU (starter/business/managed) 維持、顧客非表示 |
| 2026-09-13 | Yasaka | 顧客UIから三層セレクター・補助金ブロック・quota scare 削除 |
| 2026-08-24 | Kimura / user | 表示・Stripe Price を **税込** に揃え — **2026-09-13に税抜へ変更** |

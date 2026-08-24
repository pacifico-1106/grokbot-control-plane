# Staffpass SKU カタログ（Ando BM + Kimura 追加決定）

**更新:** 2026-08-24  
**表示額:** すべて **税込・仮決め／事業確定前**（同じ円数字＝顧客向け税込。×1.1 しない）。Checkout 実課金は Stripe Dashboard の Price（env）が正。  
**表示・Stripe Price は税込。仮決め／事業確定前。**  

**コード定数:** `lib/billing/plans.ts`（月額プラン）· `lib/billing/skus.ts`（キックオフ／補助金プレースホルダ）  
**従量メーター:** 常に `gated_confirm_action` のみ。パック SKU と混ぜない。

関連: [`pricing-model.md`](./pricing-model.md) · [`stripe-billing-notes.md`](./stripe-billing-notes.md) · [`partner/referral-tracking.md`](./partner/referral-tracking.md)

---

## 1. 収益の柱と SKU の対応

| 柱 | SKU 群 | 備考 |
|----|--------|------|
| **A. 制御面月額** | `starter` / `business` / `managed` | サブスク |
| **B. 導入・運用** | `business_onboarding`（軽量一式）· `kickoff_pack`（任意・透明3行）· Managed Care（月額内） | 一式は任意 |
| **C. ゲート従量** | `gated_confirm_action` 超過 | パックと分離 |
| **D. 補助金関連（準備）** | `subsidy_2y_business` / `subsidy_2y_managed` / `year3_extension` | カタログ＋env のみ。**保証表現禁止** |

---

## 2. フル SKU 表

| skuKey | 種別 | 表示名 | 税込（仮決め） | Stripe Product 命名（推奨） | Stripe Price 命名（推奨） | env |
|--------|------|--------|----------------|-----------------------------|---------------------------|-----|
| `starter` | recurring / month | スターター | ¥12,000 | `Staffpass Starter` | `staffpass_starter_jpy_month` | `STRIPE_PRICE_ID_STARTER` |
| `business` | recurring / month | ビジネス | ¥39,800 | `Staffpass Business` | `staffpass_business_jpy_month` | `STRIPE_PRICE_ID_BUSINESS` |
| `managed` | recurring / month | Managed（Care）コア | ¥128,000 | `Staffpass Managed (Care)` | `staffpass_managed_jpy_month` | `STRIPE_PRICE_ID_MANAGED` |
| `business_onboarding` | one-time | Business 導入一式（軽量） | ¥150,000 | `Staffpass Business Onboarding` | `staffpass_business_onboarding_jpy_once` | `STRIPE_PRICE_ID_BUSINESS_ONBOARDING` |
| `kickoff_pack` | one-time · **optional** | キックオフパック | **¥398,000** | `Staffpass Kickoff Pack` | `staffpass_kickoff_pack_jpy_once` | `STRIPE_PRICE_ID_KICKOFF_PACK` |
| `overage_*` | metered（P0.5 stub） | 確定アクション超過 | starter ¥80 / business ¥40 / managed ¥25 | `Staffpass Overage …` | `staffpass_overage_*_jpy_gated_confirm` | 後続（未配線） |
| `subsidy_2y_business` | placeholder | 補助金パック Business・2年想定 | （未定・Dashboard 後） | `Staffpass Subsidy 2Y Business` | `staffpass_subsidy_2y_business_jpy` | `STRIPE_PRICE_ID_SUBSIDY_2Y_BUSINESS` |
| `subsidy_2y_managed` | placeholder | 補助金パック Managed・2年想定 | （未定・Dashboard 後） | `Staffpass Subsidy 2Y Managed` | `staffpass_subsidy_2y_managed_jpy` | `STRIPE_PRICE_ID_SUBSIDY_2Y_MANAGED` |
| `year3_extension` | placeholder | 3年目延長オプション | （未定・Dashboard 後） | `Staffpass Year3 Extension` | `staffpass_year3_extension_jpy` | `STRIPE_PRICE_ID_YEAR3_EXTENSION` |

**Managed 包装メモ（非 SKU）:** コアは ¥128,000 / 月。営業提示用の任意バンドル表示として **¥168,000** をメモしうる（`MANAGED_BUNDLE_PACKAGING_YEN`）。Checkout の正はコア月額。別 Price を作るまで env 不要。

---

## 3. `kickoff_pack` — 透明3行（Kimura）

一式 **¥398,000（税込・仮決め）・任意**。請求・提案時は中身を3行で開示する。

| # | line key | 内容 | 税込（包装分割・仮） |
|---|----------|------|---------------------|
| 1 | `staffpass_kickoff_setup` | Staffpass キックオフ設定・就業規則テンプレ適用 | ¥198,000 |
| 2 | `grok_seat_passthrough` | **Grok Bot 席代パススルー（Pro+/Teams 帯）** | ¥60,000 |
| 3 | `kickoff_companion` | キックオフ伴走（連携チェック・テスト承認・日報導線） | ¥140,000 |
| | | **合計** | **¥398,000** |

### Grok パススルー規則

- 帯は **Pro+/Teams**。**Premium（$120）帯は使わない。**
- Staffpass は Grok 席を再販マージンで売らない方針を崩さない（パススルー／実費寄せ）。為替・公式価格変動で分割額は見直しうる。合計の一式表示は仮決め。

### 二重請求回避（Business 初月）

- キックオフに **Business（または他プラン）のサブスク初月を含めない。**
- 月額は常に `STRIPE_PRICE_ID_BUSINESS`（等）の recurring で別請求。
- `business_onboarding`（¥150,000）と `kickoff_pack`（¥398,000）はどちらも任意。同時購入時は中身の重複を営業で説明し、自動で両方を足し込まない運用を推奨（Checkout 配線は Price ID 設定後）。

現状の実装: 表示定数＋ Billing UI カード。Checkout への自動 line 追加は **Price ID 設定後**（キーが `replace_me_*` のあいだ API create しない）。

---

## 4. 補助金関連 — コンプライアンス

対象 skuKey: `subsidy_2y_business` · `subsidy_2y_managed` · `year3_extension`

| やってよい | やってはいけない |
|------------|------------------|
| 「カタログ上の候補」「申請支援の相談可」「準備中」 | 「採択される」「必ず交付される」「満額出る」 |
| 制度名は顧客側確認前提と明記 | 当社が補助金を保証・代行採択すると読める文 |
| Price ID を env プレースホルダで用意 | 金額未定のまま「公式価格」と断定 |

**定型文（UI / 営業）:**

> 補助金関連パッケージはカタログ準備中です。採択・交付・金額を保証するものではありません。制度要件・申請は顧客（または認定支援機関等）の責任です。詳細はお問い合わせください。

コード: `SUBSIDY_COMPLIANCE_NOTE_JA` / `SUBSIDY_COMING_SOON_JA`（`lib/billing/skus.ts`）。

---

## 5. メーター（変更なし）

- イベント名: **`gated_confirm_action`**
- 確定系 Gateway 成功完了のみ billable
- キックオフ／補助金／月額パックの件数には含めない（別柱）

詳細: [`pricing-model.md`](./pricing-model.md) §3 · `lib/billing/meter.ts`

---

## 6. Stripe Dashboard チェックリスト（キー投入後・ユーザー作業）

`STRIPE_SECRET_KEY` が `replace_me_*` のあいだ **Product/Price の API 作成はしない。**

1. 既存: Starter / Business / Managed recurring +（任意）Business Onboarding one-time  
2. **Kickoff Pack** one-time ¥398,000 → `STRIPE_PRICE_ID_KICKOFF_PACK`  
   - 将来: 透明3行を各 one-time Price に分ける場合は line env を追加（現時点は一式 Price で可）  
3. 補助金3種: 金額・条件が事業確定してから Product/Price 作成 → 各 `STRIPE_PRICE_ID_SUBSIDY_*` / `_YEAR3_EXTENSION`  
4. Overage Metered は従来どおり P0.5 スタブ  
5. Webhook / Portal / Tax は [`stripe-billing-notes.md`](./stripe-billing-notes.md) に従う

---

## 7. 変更履歴（決定メモ）

| 日付 | 決定 | 内容 |
|------|------|------|
| 2026-08-23 | Kimura | `kickoff_pack` ¥398,000 任意・透明3行・Grok は Pro+/Teams パススルー（非 Premium $120） |
| 2026-08-23 | Kimura | `subsidy_2y_business` / `subsidy_2y_managed` / `year3_extension` — カタログ＋env。保証言語なし |
| 2026-08-23 | Kimura | Managed コア ¥128,000。任意バンドル包装 ¥168,000 はメモのみ |
| 2026-08-23 | Kimura | メーターは `gated_confirm_action` のまま。キックオフに Business 初月を入れない |
| 2026-08-24 | Kimura / user | 表示・Stripe Price を **税込** に揃え（円数字は据え置き・×1.1 しない。Sealith 風） |
| 2026-08-23 | Kimura | 紹介コード thin tracking（`AIC-XXXX` → `orgs.referral_code`）。kickoff+monthly のみ・手動月次・Connect なし → [`partner/referral-tracking.md`](./partner/referral-tracking.md) |

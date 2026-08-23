# 紹介コード追跡（Kimura stage 2 · thin）

**更新:** 2026-08-23  
**スコープ:** 薄いトラッキングのみ。パートナーポータル・Stripe Connect・自動送金は **まだ作らない**。

関連: [`../pricing-sku-catalog.md`](../pricing-sku-catalog.md) · [`../stripe-billing-notes.md`](../stripe-billing-notes.md)

---

## 1. 何を記録するか

| 項目 | 内容 |
|------|------|
| フィールド | `orgs.referral_code`（`text` · **nullable**） |
| コード形式 | **`AIC-XXXX`**（例: `AIC-0001`）。大文字・ハイフン付き。未入力は `null` |
| 紐付け | **Org 単位**（顧客組織1件に紹介コード1つ）。会員や Checkout Session 単体には載せない |
| 入力箇所 | サインアップ（任意）および／または Billing Checkout 前の一行（任意） |
| 上書き | 本番: 空でなければ `orgs` に persist。既存値が空のときのみ埋める運用を推奨（強制上書きしない） |

DEMO: `DEMO_ORG` にメモリ保持してよい／スキップしてもよい。本番 DB へは書かない。

---

## 2. 報酬対象（kickoff + monthly のみ）

紹介報酬の対象は次の柱だけとする。

| 対象 | 例 |
|------|----|
| **月額（recurring）** | `starter` / `business` / `managed` |
| **キックオフ（one-time · 任意）** | `kickoff_pack` |

**対象外（この stage）**

- 補助金プレースホルダ（`subsidy_*` / `year3_extension`）
- ゲート従量超過（`gated_confirm_action` overage）
- Grok 席そのもの／席の再販マージン（パススルー方針はカタログどおり。**Grok 再販なし**）
- 銀行振込手数料・税・為替差額

料率・契約条件は営業／契約書側。本ドキュメントとコードは **コードを org に残すこと**まで。コード内に自動 % 計算は入れない。

### 仮・紹介料率（調整可 · 契約ではない）

| 期間 | 料率（仮） | 対象 |
|------|------------|------|
| **Year 1** | **10%** | Staffpass の **kickoff + monthly のみ**（**Grok 席は対象外**） |
| **Year 2+** | **なし（当面）** | — |

- **仮・調整可**。パートナー／案件ごとに変動しうる。本表は社内メモであり **契約書ではない**。
- 支払いは **月次・人手**（セクション 3）。コード／Billing に自動 %・自動送金は **入れない**。

---

## 3. 支払い運用（手動・月次）

| 項目 | stage 2 |
|------|---------|
| 集計 | 月次で `orgs.referral_code` 付き org の対象売上を手動 or 社内クエリで洗い出す |
| 送金 | **手動月次 payout**（振込・請求書など）。Connect / Express / 自動 Transfer は **未導入** |
| ポータル | パートナー向けダッシュボード・残高・請求 UI **なし** |
| Stripe | Customer / Subscription / Checkout は従来どおり。**Stripe Connect は使わない** |

P0 カタログ金額・Billing 表示額は変更しない。

---

## 4. 実装メモ

| 場所 | 役割 |
|------|------|
| `supabase/schema.sql` · `migrations/20260823_referral_code.sql` | `orgs.referral_code` |
| `POST /api/auth/signup` · `/signup` | 任意 `referral_code` → `createOrgWithOwner` |
| `POST /api/billing/checkout` · `BillingClient` | 任意一行「紹介コード（任意）」→ 本番で org に persist |
| UI 文言 | `紹介コード（任意）` |

Checkout metadata へのコピーは任意（将来の照合用）。報酬計算の正は当面 **`orgs.referral_code`**。

---

## 5. やらないこと（明示）

- Stripe Connect / パートナーアカウント作成
- 紹介クレジットの自動付与・クーポン自動発行
- Grok Bot 席の再販・マージン上乗せ
- パートナー向けポータル・公開ランキング
- P0 月額／キックオフ表示額の変更

---

## 6. 変更履歴

| 日付 | 決定 | 内容 |
|------|------|------|
| 2026-08-23 | Kimura | stage 2 thin: `AIC-XXXX` を org に記録。kickoff+monthly のみ。手動月次。Connect/ポータルなし |
| 2026-08-23 | Kimura | 仮料率メモ: Y1 10%（kickoff+monthly・Grok 除外）/ Y2+ なし。調整可・非契約。コードに自動 % なし |

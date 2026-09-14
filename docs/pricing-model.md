# Staffpass 価格モデル（Yasaka Two-Layer Pricing, 2026-09-13）

コピー核: Grok Bot＝手足／Staffpass＝**就業規則と日報**（社員証・承認ポリシー＝就業規則、構造化監査＝日報）。

Grok Bot / Cursor の席代・トークンは再販しない。曖昧な「AI実行時間」も売らない。

## 価格体系の二層構造

| レイヤー | 対象 | 内容 |
|---------|------|------|
| **顧客向け（Customer-facing）** | Billing UI / ダッシュボード | AI社員 Lite / Standard / Kickoff / Care |
| **バックエンド（Internal）** | Stripe / コスト管理 | starter / business / managed SKU |

**重要:** バックエンドSKU名（Starter/Business/Managed）は顧客に表示しない。

## 1. 顧客向けパック（税抜）

| パック | 月額（税抜） | 対象規模 | 特徴 |
|--------|-------------|----------|------|
| **AI社員 Lite** | ¥98,000 | 1名〜 | セルフオンボーディング |
| **AI社員 Standard** | ¥198,000 | 〜3名 | 月次レビュー・伴走サポート |

### オプション

| オプション | 価格（税抜） | 請求 | 内容 |
|-----------|-------------|------|------|
| **導入（キックオフ）** | ¥300,000 | 一式 | 初期設定代行・就業規則テンプレ適用・伴走 |
| **Care** | +¥80,000 | 月額 | 継続的運用サポート・要再連携一次対応・週次ヘルス |

**手足（Grok Bot）込み:** 顧客向けコピーでは手足はパックに含まれると表示。Stripe 請求では管理上分離するが顧客追加課金なし。

コード定数: `lib/billing/packs.ts`

## 2. バックエンドSKU（Stripe/コスト用、顧客非表示）

| planKey | 対応パック | 用途 |
|---------|-----------|------|
| `business` | AI社員 Lite | Stripe Price ID マッピング |
| `managed` | AI社員 Standard | Stripe Price ID マッピング |
| `starter` | （旧・未使用） | 既存データ互換 |

**注意:** これらのSKU名は顧客UIに表示しない。`lib/billing/plans.ts` 参照。

## 3. 削除した顧客向け要素

以下は顧客向け `/app` Billing / ダッシュボードから削除:

- 三層プランセレクター（Starter/Business/Managed ラベル）
- 補助金バナー・ブロック
- Quota scare bars / 超過単価テーブル（adminは保持可）

## 4. メーター（内部）

**イベント名（固定）:** `gated_confirm_action`

| イベント | billable | 理由 |
|----------|----------|------|
| `mail.send` / `calendar.confirm` / `commerce.order` 等 **confirm / send / order** | **true** | Gateway **成功完了**時のみ |
| `*.propose` / `mail.draft` / 参照系 | **false** | 提案は使わせる |
| 拒否・fail-closed・`needs_approval` | 課金しない | 安全側を罰しない |
| 承認 UI の Approve / Deny クリック単体 | 課金しない | 「ボタン代」にしない |

実装: `lib/billing/meter.ts`

## 5. Stripe Price分離

顧客への表示はパック単位だが、Stripe Price は分離可能:
- パック月額 Price
- キックオフ一式 Price
- 手足パススルー Price（内部管理用）

## 6. 参照

- パック定義: `lib/billing/packs.ts`
- バックエンドSKU: `lib/billing/plans.ts`
- SKU カタログ: `docs/pricing-sku-catalog.md`
- Stripe フロー: `docs/stripe-billing-notes.md`
- エンタイトルメント: `lib/billing/entitlements.ts`

## 7. 変更履歴

| 日付 | 決定 | 内容 |
|------|------|------|
| 2026-09-13 | Yasaka | パックファースト価格体系（Lite ¥98,000 / Standard ¥198,000）|
| 2026-09-13 | Yasaka | キックオフ ¥300,000 に簡素化 |
| 2026-09-13 | Yasaka | Care +¥80,000/月 オプション追加 |
| 2026-09-13 | Yasaka | 顧客向けUI から三層プランセレクター・補助金ブロック・quota scare 削除 |
| 2026-09-13 | Yasaka | バックエンドSKU (starter/business/managed) は Stripe/コスト用に維持、顧客非表示 |

# P1 外部契約カード登録 設計メモ

**更新:** 2026-09-23（Yasaka design lock）  
**状態:** 🔒 DESIGN LOCK — 実装 GO は別途セキュリティ監査ゲート後  
**関連:** [stripe-billing-notes.md](./stripe-billing-notes.md) · [ai-employee-pack-setup-playbook.md](./ai-employee-pack-setup-playbook.md) · [agent-commerce/cross-product-commerce-event-contract-v1.md](./agent-commerce/cross-product-commerce-event-contract-v1.md)

---

## 概要

外部契約のカード登録フローを Staffpass に追加する設計メモ。**Stripe-hosted のみ**（SAQ A 指向）。本ドキュメントはロック済み設計決定を記録する。**実装コード・マイグレーション・API ルート・本番有効化は含まない**。

---

## ロック済み決定（LOCKED — 非交渉）

| # | 決定 | 詳細 |
|---|------|------|
| **L1** | **Raw card forbidden** | PAN / CVV / expiry をチャット、エージェント limbs、Staffpass DB、ログ、tool args、env に**絶対に置かない** |
| **L2** | **Env forbidden** | カード関連 secrets をエージェント/VM/Connector env に置かない（「limbs にカード登録 API キー」もスコープ外） |
| **L3** | **Stripe-hosted only** | Checkout `mode=setup`（支払い方法アタッチ用）+ Customer Portal（変更/削除）。Mouths（Slack/LINE）は P0-A 形式の短命ディープリンク + `nextStepJa` のみ発行 — **チャット内カードフォームは禁止** |
| **L4** | **Staffpass 保存可** | `customer_id`, `payment_method_id`（トークン参照のみ）、契約メタデータ、監査（誰がいつ開いた/完了/失敗）。**生カードデータは Stripe に留まる** |
| **L5** | **Mouth×secrets 拡張** | チャット OK = リンク + ステータス。**NEVER** = カード / 銀行口座 / 秘密鍵 |
| **L6** | **PCI / SAQ** | カードデータが Staffpass/エージェントに触れない場合のみ **SAQ A 指向**。本番監査前の宣言ではなく、監査時の検証対象として記録 |
| **L7** | **カード所有者** | デフォルトモデル = **Org (tenant) Customer** on Stripe。個人カード・307 代行（proxy）は **v1 スコープ外**・別リスクトラック |
| **L8** | **AI社員パック Checkout と分離** | 既存パック初期費用 Checkout を setup 用に再利用しない — 別プロダクト/フロー/セッション |
| **L9** | **承認** | 支払い方法 bind / change = **always_human**（risk_based 不可） |
| **L10** | **P0-A ディープリンク + 検出器** | P0-A 短命リンクパターンに接続。secret detector をカード様文字列（PAN-ish パターン）へ拡張 — 一致 secret 自体はログしない |

---

## 非目標（v1 スコープ外）

- 個人カード登録（employee が自分の財布を紐づける）
- 307 代行（proxy）カード登録
- SAQ A 認定の主張（監査完了前）
- mint/webhook/Portal の実装
- 本番有効化

---

## P1 バックログ順序（実装は別 GO・ゲート後）

| # | 項目 | 備考 |
|---|------|------|
| 1 | 本設計メモ | — |
| 2 | データモデル | `customer_id`, `payment_method_id`, 契約メタ, 監査列（**PAN なし**） |
| 3 | Mint deep link | 短命・Staffpass サーバ発行 → Stripe Checkout setup session |
| 4 | Stripe Webhook | setup 完了/失敗 → 監査 + 状態更新 |
| 5 | Customer Portal link mint | 同じ mouth パターン（リンク + `nextStepJa`） |
| 6 | Detector 拡張 | カード様文字列検出（PAN-ish） |
| 7 | 完全セキュリティ監査 | **本番有効化前に必須** |

---

## 信頼境界（セキュリティガイダンス — 監査前）

本節はガイダンスモードであり、完全な監査結論ではない。

### 境界マップ

```
┌───────────────────────────────────────────────────────────────────────┐
│                        Stripe（PCI DSS Level 1）                       │
│   ┌─────────────────┐   ┌─────────────────┐   ┌─────────────────┐     │
│   │ Checkout Setup  │   │ Customer Portal │   │ Webhook送信     │     │
│   │ (mode=setup)    │   │ (変更/削除)     │   │ (署名付き)      │     │
│   └────────┬────────┘   └────────┬────────┘   └────────┬────────┘     │
│            │                     │                     │              │
└────────────┼─────────────────────┼─────────────────────┼──────────────┘
             │ short-lived URL      │ short-lived URL     │ signed POST
             │ (setup session)      │ (portal session)    │
             ▼                      ▼                     ▼
┌───────────────────────────────────────────────────────────────────────┐
│                     Staffpass サーバ                                   │
│   ┌─────────────────────────────────────────────────────────────────┐ │
│   │ STRIPE_SECRET_KEY（サーバ側のみ）                                │ │
│   │ - Checkout/Portal セッション作成                                 │ │
│   │ - Webhook 署名検証                                               │ │
│   │ - customer_id / payment_method_id 保存（トークンのみ）           │ │
│   │ - 監査ログ                                                       │ │
│   └─────────────────────────────────────────────────────────────────┘ │
│                                                                       │
│   ❌ PAN / CVV / expiry / card fingerprint echo を禁止                │
│   ✓  last4 / brand（Stripe が表示用に提供する場合のみ・最小限）       │
└───────────────────────────────────────────────────────────────────────┘
             │ deep link + nextStepJa
             │ (リンク + ステータスのみ)
             ▼
┌───────────────────────────────────────────────────────────────────────┐
│                     Mouths（Slack / LINE）                            │
│                                                                       │
│   ✓  短命ディープリンク発行                                           │
│   ✓  ステータス表示（成功/失敗/期限切れ）                             │
│   ✓  nextStepJa                                                       │
│   ❌ カードフォーム、入力フィールド、PAN/CVV 表示                     │
│   ❌ Stripe secrets                                                   │
└───────────────────────────────────────────────────────────────────────┘
             │
             │ ❌ NEVER
             ▼
┌───────────────────────────────────────────────────────────────────────┐
│                     Limbs（Agent / VM / Connector）                    │
│                                                                       │
│   ❌ STRIPE_SECRET_KEY                                                │
│   ❌ カード関連 API キー                                              │
│   ❌ PAN / CVV / expiry                                               │
│   ❌ カード登録 tool args にカード情報                                │
└───────────────────────────────────────────────────────────────────────┘
```

### 制御ポイント

| ポイント | 制御 |
|----------|------|
| Slack/LINE | Stripe secrets を見ない。Staffpass サーバのみが Checkout/Portal セッションを作成 |
| Limbs | Stripe secret を保持しない。カード登録ツールは「リンクを発行」のみ、カード情報を引数に取らない |
| Webhook | `STRIPE_WEBHOOK_SECRET` で署名検証必須。未検証ペイロードは処理しない |
| Tenant isolation | `customer_id` は org 単位。cross-org 参照を禁止 |
| Link expiry | fail-closed — リンク期限切れは登録不可（再発行を促す） |
| Chat echo | Stripe オブジェクトのうち card fingerprint / full PAN を chat に echo しない。表示が必要なら last4/brand のみ（Stripe が提供する場合）、それも最小限 |

---

## データモデル概要（実装前ドラフト）

```
org_external_contracts (既存または新規)
├── id: uuid
├── org_id: uuid (FK → orgs)
├── stripe_customer_id: text            -- Stripe Customer ID
├── stripe_payment_method_id: text      -- Stripe PaymentMethod ID (トークン)
├── setup_status: text                  -- pending | completed | failed
├── setup_completed_at: timestamptz
├── setup_completed_by: uuid            -- 承認した人間
├── created_at: timestamptz
├── updated_at: timestamptz
└── metadata: jsonb                     -- 契約メタ（PAN なし）

audit_card_setup_events (監査専用)
├── id: uuid
├── org_id: uuid
├── action: text                        -- link_opened | setup_completed | setup_failed | portal_opened | method_changed | method_removed
├── actor_user_id: uuid                 -- 操作した人間
├── approval_id: uuid                   -- always_human 承認 ID
├── stripe_session_id: text             -- Checkout/Portal session ID（秘密ではない）
├── outcome: text                       -- success | failure | expired
├── created_at: timestamptz
└── metadata: jsonb                     -- エラー理由等（PAN/CVV なし）
```

**禁止カラム:** `card_number`, `cvv`, `expiry`, `card_fingerprint`（Stripe が返す fingerprint も保存しない — 必要なら API で都度取得）

---

## Mouth 出力例

### Slack（リンク発行時）

```json
{
  "text": "支払い方法の登録が必要です。以下のリンクから登録してください。",
  "blocks": [
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "*支払い方法の登録*\n有効期限: 15分"
      }
    },
    {
      "type": "actions",
      "elements": [
        {
          "type": "button",
          "text": { "type": "plain_text", "text": "カードを登録する" },
          "url": "https://staffpass.sealith.com/card-setup/abc123...",
          "style": "primary"
        }
      ]
    }
  ],
  "nextStepJa": "リンクをクリックして Stripe のページでカード情報を入力してください。"
}
```

**禁止:** カード入力フィールド、PAN/CVV のテキスト入力、Stripe API キーの露出

---

## AI社員パック Checkout との分離

既存の AI社員パック初期費用 Checkout（[ai-employee-pack-setup-playbook.md](./ai-employee-pack-setup-playbook.md) § 7）は `mode=payment` または `mode=subscription` でワンタイム/定期支払いに使用。

本機能の Checkout は `mode=setup` で **支払い方法のアタッチのみ**（即時課金なし）。

| 項目 | AI社員パック Checkout | 外部契約カード登録 |
|------|------------------------|-------------------|
| Stripe mode | `payment` / `subscription` | `setup` |
| 目的 | 初期費用・月額の支払い | 支払い方法のアタッチ |
| 課金タイミング | 即時 | なし（将来の請求用） |
| Price ID | `STRIPE_PRICE_ID_AI_EMP_SETUP_*` | なし（setup には不要） |
| セッション | 別 | 別 |
| Customer | 同一 org に紐づく Customer でも可 | 同一 Customer |

**混在禁止:** 初期費用支払い Checkout セッションでカード登録も兼ねる実装は行わない。フローを分離し、監査を明確にする。

---

## 検出器拡張

既存の secret detector（Staffpass DB/ログへの secret 流出防止）を拡張し、カード様文字列（PAN-ish パターン）を検出する。

### パターン例（実装詳細は別 PR）

- 16桁連続数字（スペース/ハイフン区切り含む）
- Luhn チェックサム合格文字列
- `4[0-9]{12}(?:[0-9]{3})?` (Visa)
- `5[1-5][0-9]{14}` (Mastercard)
- `3[47][0-9]{13}` (Amex)

### 検出時の動作

- ログに「PAN-like string detected」のみ記録（**一致した文字列自体はログしない**）
- 該当メッセージを chat に送信しない（fail-closed）
- 監査に `card_like_string_blocked` イベントを記録

---

## 承認フロー

支払い方法の bind / change は **always_human** 固定。

```
1. Admin MCP or Dashboard で「カード登録リンク発行」を要求
2. Staffpass が needs_approval を返す（always_human）
3. 人間が承認（Slack/LINE/Web の承認インボックス）
4. 承認後、Staffpass サーバが Stripe Checkout setup session を作成
5. 短命ディープリンクを mouth に発行
6. 人間がリンクをクリックし、Stripe ページでカード入力
7. Stripe Webhook が setup_intent.succeeded を POST
8. Staffpass が署名検証 → customer_id / payment_method_id を保存 → 監査記録
```

---

## 関連ドキュメント

- [stripe-billing-notes.md](./stripe-billing-notes.md) — Stripe Checkout / Webhook / Customer Portal の既存実装メモ
- [ai-employee-pack-setup-playbook.md](./ai-employee-pack-setup-playbook.md) — AI社員パックの Checkout フロー（本機能とは分離）
- [agent-commerce/cross-product-commerce-event-contract-v1.md](./agent-commerce/cross-product-commerce-event-contract-v1.md) — `card PAN/CVC` を forbidden data として明記
- [tenant-slack-kickoff-rail.md](./tenant-slack-kickoff-rail.md) — `nextStepJa` パターン
- [guides/telegram-approval.md](./guides/telegram-approval.md) — always_human と秘密管理

---

---

## 実装状況

**実装完了:** 2026-09-23  
**フラグ名:** `EXTERNAL_CONTRACT_CARD_SETUP`  
**デフォルト:** `0`（OFF）

### 実装コンポーネント

| コンポーネント | ファイル | 状態 |
|--------------|---------|------|
| マイグレーション | `supabase/migrations/20260923_external_contract_card_setup.sql` | ✅ 完了 |
| フィーチャーフラグ | `lib/external-contract-card/feature-flag.ts` | ✅ 完了 |
| カード検出器拡張 | `lib/security/secret-detector.ts` | ✅ 完了 |
| データアクセス層 | `lib/external-contract-card/data.ts` | ✅ 完了 |
| Checkout セッション | `lib/external-contract-card/checkout-setup.ts` | ✅ 完了 |
| Webhook ハンドラ | `lib/external-contract-card/webhook-handler.ts` | ✅ 完了 |
| Portal リンク | `lib/external-contract-card/portal-link.ts` | ✅ 完了 |
| テスト | `lib/external-contract-card/external-contract-card.test.ts` | ✅ 完了 |

### 本番有効化の前提条件

⚠️ **本番環境では `EXTERNAL_CONTRACT_CARD_SETUP=0`（デフォルト）を維持してください。**

本番有効化には以下が**必須**です：

1. **完全なセキュリティ監査**
   - PCI DSS SAQ A 準拠の確認
   - Stripe-hosted フローのみ使用の確認
   - PAN/CVV/expiry がログ・DB・env に一切保存されないことの確認

2. **別途の本番有効化 GO**
   - セキュリティチームからの承認
   - 運用チームからの承認

3. **監査ログ確認**
   - `audit_external_contract_card_events` テーブルに PAN 関連データがないこと

**SAQ A 達成を宣言しないでください** — 監査完了時の検証対象として記録されています。

---

## 変更履歴

| 日付 | 担当 | 内容 |
|------|------|------|
| 2026-09-23 | Yasaka | Design lock |
| 2026-09-23 | Cloud Agent | Implementation (flag OFF, pending security audit) |

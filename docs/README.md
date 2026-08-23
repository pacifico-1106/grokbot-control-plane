# Staffpass / grokbot-control-plane — ドキュメント索引

**リポジトリ:** [pacifico-1106/grokbot-control-plane](https://github.com/pacifico-1106/grokbot-control-plane)  
**本番:** https://grokbot-control-plane.vercel.app  
**正本の優先順位:** `internal-share/00` / `01` → 価格は `pricing-sku-catalog` → LP コピーは `copy.md`

相対パスは本ディレクトリ（`docs/`）基準。GitHub で開く場合は `blob/main/docs/` 配下。

---

## 正本・展開デフォルト

| 文書 | 相対 | 備考 |
|------|------|------|
| ミニマム・デフォルト（P0） | [internal-share/00-minimum-defaults.md](./internal-share/00-minimum-defaults.md) | 製品・展開の正本 |
| エンジニア要件 | [internal-share/01-engineer-requirements.md](./internal-share/01-engineer-requirements.md) | 実装・レビュー正本 |

---

## 顧客向けガイド（公開）

| 文書 | 相対 | 本番 |
|------|------|------|
| 指示文の設計ガイド | [guides/instructions-design.md](./guides/instructions-design.md) | [/guides/instructions-design](https://grokbot-control-plane.vercel.app/guides/instructions-design) · [/app/guides/instructions-design](https://grokbot-control-plane.vercel.app/app/guides/instructions-design) |

---

## 営業・セキュリティ

| 文書 | 相対 |
|------|------|
| 営業イネーブルメント | [internal-share/03-sales-enablement.md](./internal-share/03-sales-enablement.md) |
| 営業・セキュリティ FAQ | [internal-share/04-sales-security-faq.md](./internal-share/04-sales-security-faq.md) |
| Staffpass でセキュリティ説明がどう変わるか | [internal-share/05-staffpass-changes-security-story.md](./internal-share/05-staffpass-changes-security-story.md) |
| 提案資料パック（PDF / HTML / MD） | [sales-pack/](./sales-pack/) |
| LP・UI コピー一覧 | [copy.md](./copy.md) |

---

## 設計・制御

| 文書 | 相対 |
|------|------|
| アーキテクチャ概要 | [architecture.md](./architecture.md) |
| 強制（Auto vs Manual） | [enforcement-auto-vs-manual.md](./enforcement-auto-vs-manual.md) |
| Gateway vs Auto-review | [gateway-vs-auto-review.md](./gateway-vs-auto-review.md) |
| 紐づけライフライン | [binding-lifeline.md](./binding-lifeline.md) |
| 支出委任 | [spend-delegation.md](./spend-delegation.md) |
| エージェント資格情報ガイド | [agent-credential-guide.md](./agent-credential-guide.md) |
| Commerce プロバイダメモ | [commerce-provider-notes.md](./commerce-provider-notes.md) |
| Sealith からの選定メモ | [selection-from-sealith.md](./selection-from-sealith.md) |

---

## 価格・課金

| 文書 | 相対 |
|------|------|
| 価格モデル | [pricing-model.md](./pricing-model.md) |
| **SKU カタログ（商用の最新）** | [pricing-sku-catalog.md](./pricing-sku-catalog.md) |
| Stripe 請求メモ | [stripe-billing-notes.md](./stripe-billing-notes.md) |
| パートナー紹介トラッキング | [partner/referral-tracking.md](./partner/referral-tracking.md) |

---

## 法務

| 文書 | 相対 |
|------|------|
| 法務インデックス | [legal/README.md](./legal/README.md) |
| データ取扱いサマリ | [legal/data-handling-summary.md](./legal/data-handling-summary.md) |
| 利用規約テンプレート | [legal/terms-of-service-template.md](./legal/terms-of-service-template.md) |

---

## パートナー・JPYC

| 文書 | 相対 |
|------|------|
| JPYC 打合せパック | [partner/jpyc-meeting/](./partner/jpyc-meeting/) |
| アジェンダ（PDF） | [partner/jpyc-meeting/agenda-one-pager.pdf](./partner/jpyc-meeting/agenda-one-pager.pdf) |
| アーキ概要（PDF） | [partner/jpyc-meeting/architecture-overview.pdf](./partner/jpyc-meeting/architecture-overview.pdf) |
| 打合せ README | [partner/jpyc-meeting/README.md](./partner/jpyc-meeting/README.md) |

---

## 本番切替

| 文書 | 相対 | 本番 URL |
|------|------|----------|
| Production cutover | [production-cutover.md](./production-cutover.md) | https://grokbot-control-plane.vercel.app |

---

## 古い／補助

| 文書 | 相対 | 扱い |
|------|------|------|
| デザインブリーフ（初期） | [internal-share/02-design-brief.md](./internal-share/02-design-brief.md) | **初期ブリーフ**。現行製品は **00 / 01** を優先 |
| 提案 PDF（sales-pack / internal-share） | [sales-pack/staffpass-proposal.pdf](./sales-pack/staffpass-proposal.pdf) | **提案 PDF は LP / 価格より遅れる場合あり**。最新の商用は [pricing-sku-catalog.md](./pricing-sku-catalog.md) と本番 LP（https://grokbot-control-plane.vercel.app）を参照 |
| 社内共有用コピー（提案スライド等） | [internal-share/](./internal-share/) | sales-pack と重複あり。顧客配布は sales-pack 側を優先 |

---

## クイックリンク（GitHub blob）

ベース: `https://github.com/pacifico-1106/grokbot-control-plane/blob/main/docs/`

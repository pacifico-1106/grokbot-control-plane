# 法務ドキュメント（雛形）— Staffpass / AI社員 for Grok Bot

> **【雛形・要弁護士レビュー】**  
> ここに置く文書は **法的助言ではありません（Not legal advice）**。顧客提示・サイト掲載・契約添付の前に弁護士レビュー必須です。  
> 会社の登記番号・実在住所・実在電話などを捏造して埋めないこと。未確定は `{{PLACEHOLDER}}` または【】のまま残し、公開前に置換してください。

## ファイル一覧

| ファイル | 用途 |
|----------|------|
| [terms-of-service-template.md](./terms-of-service-template.md) | B2B SaaS 利用規約の全文雛形（第1条〜、別紙A 付き） |
| [data-handling-summary.md](./data-handling-summary.md) | データ取扱い概要の1枚もの（営業説明用。フル DPA ではない） |

## 使い方（公開までの手順）

1. **プレースホルダを置換する**  
   最低限、次を実値または暫定値に置き換える。
   - `{{PROVIDER_LEGAL_NAME}}` … 運営会社の正式名称
   - `{{PROVIDER_ADDRESS}}` … 本店所在地等
   - `{{PROVIDER_CONTACT_EMAIL}}` … 問合せメール
   - `{{SERVICE_NAME}}` … 既定は「Staffpass」（別名: AI社員 for Grok Bot）
   - `{{SITE_URL}}` … 公開サイト URL
   - `{{GOVERNING_COURT}}` … 既定想定は「東京地方裁判所」
   - `{{EFFECTIVE_DATE}}` … 施行日
   - `{{REFUND_POLICY}}` / `{{DATA_EXPORT_PERIOD}}` / `{{DATA_DELETION_PERIOD}}` / `{{BACKUP_RETENTION}}` / `{{CONFIDENTIALITY_SURVIVAL_PERIOD}}` / `{{INFRASTRUCTURE_REGION_NOTE}}`
2. **プロダクト実態と突合する**  
   共有 PC、承認ゲート、社員証の一度きり秘密、監査が構造化ログ中心、Stripe 課金、外部 Bot 非保証など、現行仕様と矛盾がないか確認する（`docs/architecture.md`、`docs/internal-share/04-sales-security-faq.md` 等）。
3. **弁護士レビュー**  
   特に第15条（免責・責任制限）、返金、個人情報・越境、反社条項、消費者契約法の適用有無を重点確認。
4. **プライバシーポリシー／正式 DPA を別途用意**  
   本リポジトリの別紙Aおよび `data-handling-summary.md` は **営業説明用の簡易版**。フル DPA・SCC・再委託一覧は別契約として後日作成する。
5. **公開場所**  
   - 推奨: `{{SITE_URL}}/legal/terms`（または `/terms`）に HTML／MD を掲載  
   - 申込・Checkout・サインアップ画面から常時リンク  
   - 注文書・申込書の「本規約に同意」チェックと版数・日付を残す  
   - PDF が必要な場合はレビュー確定版から書き出し、版管理する
6. **版管理**  
   変更時は施行日・改訂履歴を更新し、既存契約者への通知方法（メール／管理画面／サイト掲示）を第18条どおり運用する。

## 営業・社内ドキュメントからの参照

- 社内共有: `docs/internal-share/`（セキュリティ FAQ・提案資料）
- 営業パック: `docs/sales-pack/`
- 本ディレクトリへの誘導は各 README／enablement に1行リンクを追加してよい。

## やってはいけないこと

- プレースホルダ未置換のまま顧客送付・サイト公開
- 実在しない登記番号・住所・資格の記載
- 「完全隔離を保証」「外部 LLM の学習オフを保証」「○○％ SLA」など、製品が保証していない約束の追加
- 別紙Aだけを「DPA 締結済み」と説明すること

## 問合せ（雛形運用）

法務・規約ドラフトの社内問合せ先はプロジェクトのオーナーが指定する。対外問合せ先は規約本文の `{{PROVIDER_CONTACT_EMAIL}}` に統一する。

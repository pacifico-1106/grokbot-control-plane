# エンジニア向け — 要件・仕様書（ドラフト）

**プロダクト仮称:** AI社員 制御面（Grok Bot × 制御プレーン）  
**リポジトリ:** https://github.com/pacifico-1106/grokbot-control-plane  
**対象読者:** 実装・レビュー・オンボーディングするエンジニア  
**ステータス:** 骨格〜本番寄せ実装中（ブラッシュアップ前提の社内ドラフト）  
**更新:** 2026-08-23

---

## 1. プロダクト一文

日本の中小・零細向けに、Grok Bot 上の AI を「社員証・承認・監査付きの AI社員」として運用する制御面 SaaS。モデルや財布は持たず、**許可 → 実行 → 証跡（必要なら承認）** を担う。

---

## 2. リポジトリと参照方針

| 項目 | 内容 |
|------|------|
| 本番候補リポ | `pacifico-1106/grokbot-control-plane` |
| 参考リポ | `pacifico-1106/sealith-web`（**厳選参照のみ**） |
| 取り込んでよい | AI社員証 UX（Draft→発行）、承認／監査、Billing、チーム、オンボーディング、ゲート API の型 |
| 取り込まない | 機密ファイル受け渡し、Chrome拡張、JPYC／Provider Ops、Sealith 全体の機能パリティ |

---

## 3. 技術スタック（確定方針）

| 層 | 選定 | 備考 |
|----|------|------|
| App | Next.js App Router + TypeScript + Tailwind | Sealith-web と同系統 |
| Hosting | Vercel | 初弾デプロイ済み／claim 済み想定 |
| DB / Auth | Supabase (Postgres + Auth) | |
| Billing | Stripe | クレカ + 銀行振込（`customer_balance` 等 JP 向け） |
| Email | Resend | 歓迎・承認依頼・トライアル終了など |
| 実行エージェント | Grok Bot | Managed（こちらが連携巻き取り）/ BYO（顧客が自前 Bot） |

ローカルメモ（社内）にも P0 仕様あり: `P0-audit-spec.md`

---

## 4. 中核ドメイン

```
Org
 └─ Employee（AI社員）
      └─ Credential（社員証: scopes / allowedPurposes / approvalPolicy / expiry）
 └─ Job / Action（ゲートウェイ経由の実行）
 └─ Approval（要対応）
 └─ AuditEvent（構造化証跡）
 └─ Subscription（trial / paid）
 └─ WorkOrder（将来: eSIM 等の取引台帳。P0 は型予約）
```

### Credential 制約（実行時 fail-closed）
- `scopes[]`, `allowedPurposes[]`
- `approvalPolicy`: `auto` | `always_human` | `risk_based`
- `expiresAt` / `revokedAt`
- 実行コンテキスト必須: `purpose`, `jobId`

### AuditEvent 原則
- プロンプト全文・CoT は保存しない
- 構造化サマリ + 参照 ID のみ
- attempt / result / deny / approve を残す

---

## 5. 実行アーキテクチャ

```
Grok Bot / MCP Client
  → Control Plane Gateway（Bearer 社員証）
    → Policy Engine
      → [要承認] Approval Queue
      → Tool Adapter（許可ツールのみ）
    → Audit Writer（常時）
```

**重要前提:** Grok Bot の実行コンピュータはユーザー配下で共有（画面はエージェント別）。OS 権限では職務分離できない → **制御面が必須**。共有ログインは「環境の能力」であり「職務権限」ではない。

---

## 6. 画面・ルート（目標 IA）

| パス | 役割 | 現状目安 |
|------|------|----------|
| `/` | 中小向け LP | あり（骨格） |
| `/signup` | トライアル登録 | あり（スタブ） |
| `/app` | ダッシュボード | あり |
| `/app/employees` | AI社員一覧 | 実装中／要充実 |
| `/app/employees/[id]` | 社員証・権限詳細・発行 | 要実装（本丸） |
| `/app/approvals` | 承認キュー | あり（デモデータ） |
| `/app/audit` | 監査タイムライン | あり（デモデータ） |
| `/app/getting-started` | はじめに | 要追加 |
| `/app/settings` | Managed / BYO・連携ステータス | あり（スタブ） |
| `/app/billing` | 請求・プラン | あり（スタブ） |
| `/app/team` | 人間メンバー（オーナー等） | 要追加 |

---

## 7. API（方針）

- `POST /api/trial` — トライアル org 発行
- `POST /api/v1/actions` — ゲート経由実行（本番の核）
- `GET/POST /api/v1/approvals/*`
- `GET /api/v1/audit/events` (+ export)
- `POST /api/webhooks/stripe`
- `POST /api/email` またはサーバ内 Resend ヘルパ
- MCP: 将来 `invoke_tool` / `get_job_audit` 等（Sealith MCP の薄い互換ではなく自前契約で可）

認証: ダッシュボードは Supabase Auth。エージェント実行は Employee Credential Bearer。

---

## 8. Grok Bot 連携モード

| モード | 挙動 |
|--------|------|
| **Managed（中小デフォルト）** | 当社が Bot セットアップ・接続。顧客はダッシュボード中心 |
| **BYO** | 顧客が自前 Grok Bot を用意し、接続情報を登録 |

「当社アプリ → Grok Bot 契約 → return_url で戻る」は、公式 Partner API が無い間はディープリンク + ステータス（未連携／連携中／利用中）で先行。API が来たら差し替え。

---

## 9. 環境変数（本番チェックリスト）

```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=
RESEND_API_KEY=
EMAIL_FROM=
TRIAL_DAYS=14
NEXT_PUBLIC_APP_URL=
```

- Supabase: `supabase/schema.sql` 適用
- Stripe: Checkout + Webhook エンドポイント登録（card / customer_balance）
- Resend: 送信ドメイン認証
- Vercel: 上記を Production env に設定

---

## 10. 非機能

- Fail-closed ポリシー
- 社員証シークレットは発行時一回表示、保存はハッシュのみ
- 監査ログ追記専用
- 管理操作も監査対象
- カード番号・秘密鍵をエージェント文脈に入れない

---

## 11. フェーズ

| Phase | 内容 |
|-------|------|
| P0 | 社員証・ゲート・監査・承認最小、LP、trial |
| P1 | エクスポート、通知（Resend）、チーム、オンボーディング完成 |
| P2 | eSIM WorkOrder（決済検証縦）、デモ脚本の本実装 |
| P3 | SSO、他 Provider、Partner API 連携 |

---

## 12. 受け入れ（本番の最低ライン）

1. トライアル登録 → ダッシュボード到達
2. AI社員を発行し、権限（purpose/scope/承認ポリシー）が保存・表示できる
3. 要承認アクションが承認前に進まない（少なくともデモ／統合テストで証明）
4. 監査タイムラインで1ジョブを追える
5. Stripe の Checkout または Customer Portal が実キーで動く（or 明確な sandbox 手順）
6. Resend で少なくとも1通（welcome または approval）が送れる
7. シークレットがリポジトリに含まれない

---

## 13. 既知のギャップ（正直に）

- 社員証 UI・ゲート本番実装は Sealith 比で未完成／進行中
- Grok Bot 公式の契約 API なし → Managed は運用プロセス依存
- 仮デプロイ／claim 後も、本番キー未設定なら「見た目本番・中身スタブ」になりうる

---

## 14. 関連ドキュメント

- 社内: `02-design-brief.md` / `03-sales-enablement.md`
- 仕様メモ: `../P0-audit-spec.md`
- 提案1枚: `../proposal-one-pager.md`
- デモ脚本: `../demo-script-esim-approval.md`


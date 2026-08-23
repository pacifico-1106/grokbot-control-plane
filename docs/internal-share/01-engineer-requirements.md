# エンジニア向け — 要件・仕様書（ドラフト）

**プロダクト仮称:** AI社員 制御面（Grok Bot × 制御プレーン）  
**リポジトリ:** https://github.com/pacifico-1106/grokbot-control-plane  
**対象読者:** 実装・レビュー・オンボーディングするエンジニア  
**ステータス:** P0 スプリント（A/D 採択反映）— 骨格〜本番寄せ実装中  
**更新:** 2026-08-23

---

## 1. プロダクト一文

日本の中小・零細向けに、Grok Bot 上の AI を「社員証・承認・監査付きの AI社員」として運用する制御面 SaaS。モデルや財布は持たず、**許可 → 実行 → 証跡（必要なら承認）** を担う。

### 1.1 用語一行定義（固定）

| 語 | 定義 |
|----|------|
| **Staffpass** | 本プロダクト。AI社員の社員証・承認・監査を提供する制御面 SaaS |
| **制御面** | 許可 → 実行 → 証跡（必要なら承認）のゲート層。LLM や決済財布そのものは持たない |
| **AI社員** | Org 配下の Employee。実行体は Grok Bot、権限境界は Credential（社員証） |

### 1.2 木村 P0 決定（安藤提案 A / D 採択）

| 提案 | 決定 |
|------|------|
| **A** | ツールを提案と確定に二分: `calendar.propose` / `calendar.confirm`、`mail.draft` / `mail.send`。**confirm・send は常に always_human**。propose・draft は auto / risk_based 可。**未登録ツールは fail-closed 拒否**。Gateway invoke に **purpose + jobId（または job_id）必須** |
| **D** | 企業 DB のデフォルト正本は **Supabase のみ**。Google Drive はファイル／添付のみ。DB 代替にしない。GCP 等は例外顧客のみ |

B〜F（テンプレ3枚 / AgentMail は P0.5予約+P1 / 承認UI第一はダッシュボード / 週次FB）は異論なし・本スプリントでは予約または後続。

### 1.3 公式前提 — 共有コンピュータ（C1・P0 / 安藤分析→木村採択）

x.ai Grok Bot 公式 Docs（概念引用。断定は最新公式で確認）:

| 公式メッセージ | Staffpass への含意 |
|----------------|-------------------|
| 同一ユーザー配下の **Shared computer**（ファイル・ブラウザ・CLI資格情報が共有） | OS 権限では職務分離できない → **制御面必須** |
| 画面は Bot 別でも **セキュリティ境界ではない** | 画面分離を売り文句にしない（Won't と整合） |
| **Do not use separate Bots as a security boundary.** | Bot分け ≠ 安全。境界は Credential（社員証） |

ポジション固定: Grok Bot＝共有コンピュータ上の手足＋個人向け承認ネット。Staffpass＝会社の社員証・職務ポリシー・監査台帳。関係図: [`../gateway-vs-auto-review.md`](../gateway-vs-auto-review.md)。

### 1.4 木村追記決定（C2〜C5 / 2026-08-23）

| ID | 決定 |
|----|------|
| **C2** | Gateway vs Auto-review: 組織の正本は **Staffpass**。Auto-review は個人／Bot側ネット |
| **C3** | Bot間ハンドオフ監査型は **P1 予約のみ**（本スプリント実装なし）— AuditAction に将来 `bot.handoff` 等を足しうる |
| **C4** | **Routines / Teach** 経由の確定系（confirm / send / order）も Staffpass ゲート必須（always_human）。実行フックは Partner API 不在で限定的 → Managed 補完 |
| **C5** | `browser:use` で `allowedAccounts` 欠落／不一致は **fail-closed**（ソフト警告のみにしない）。ライブセッション照合の限界は正直に残す |
| **Hybrid** | 確定系は必須プロキシ。迂回経路は Managed＋事後突合。「全部プロキシ」とは言わない |

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
| DB / Auth | **Supabase のみ（デフォルト正本）** | Drive / GCP は DB にしない（決定 D） |
| Billing | Stripe | **Staffpass SaaS サブスク**（クレカ + 銀行振込）。AI社員の `commerce:order` とは別物 |
| Email（制御面） | Resend | 歓迎・承認依頼・トライアル終了など（層 C） |
| Email（AI社員） | AgentMail | **P0.5 スキーマ／ポリシー予約のみ**。本送信・inbox プロビジョニングは P1 |
| Email（人間） | Gmail / Workspace | 人が読む・決裁。エージェントに丸ごと渡さない（層 A） |
| ファイル | Google Drive 等 | 添付・共有ドキュメントのみ |
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
- 実行コンテキスト必須: `purpose`, `jobId`（`job_id` 可）
- スコープ例: `mail:draft` / `mail:send` / `calendar:propose` / `calendar:confirm` / `commerce:order` / `browser:use`
- 隣接: `allowedAccounts[]`（共有PC向け・サービス可変。browser:use とセット）

### AuditEvent 原則
- プロンプト全文・CoT は保存しない
- 構造化サマリ + 参照 ID のみ
- attempt / result / deny / approve を残す
- **P1予約（C3）:** Bot間ハンドオフ（公式の相互メッセージ／グループ調整）を説明できる監査型（例: `bot.handoff`）— 本スプリントでは実装しない

### 人間 RBAC と AI 承認プリセットは別層

| 層 | 何を決めるか | 置き場 |
|----|--------------|--------|
| **人間チーム RBAC** | 誰が承認ボタンを押せるか・雇えるか・課金を触れるか | `OrgMember.role` / `jobRole` / `capabilities` |
| **AI社員の承認プリセット** | どのツール／アクションが要承認か | Credential `approvalPolicy` + ツール別デフォルト（Ando §3） |

混同しない。社長が「承認者」でも、AI の `mail.send` は別途 always_human。

---

## 5. 実行アーキテクチャ

```
Grok Bot / MCP Client
  → Control Plane Gateway（Bearer 社員証）
    → Policy Engine
      → [要承認] Approval Queue
      → Tool Adapter（許可ツールのみ・未登録拒否）
    → Audit Writer（常時）
```

**重要前提（公式と同型）:** Grok Bot の実行コンピュータはユーザー配下で**共有**（画面はエージェント別でもセキュリティ境界ではない）。公式 FAQ: *Do not use separate Bots as a security boundary.* OS 権限では職務分離できない → **制御面が必須**。共有ログインは「環境の能力」であり「職務権限」ではない。

### 5.1 メール3層（絶対に混ぜない）

| 層 | 箱 | 用途 | Staffpass の関わり |
|----|-----|------|-------------------|
| **A. Human Gmail** | 社長・実務の Workspace | 顧客折衝・決裁 | 原則エージェント直操作しない |
| **B. AgentMail** | 企業×Employee 専用 inbox | AI社員の送受信 | 送信はゲート対象。**P0 は予約のみ（P0.5）** |
| **C. Staffpass Resend** | プロダクト送信ドメイン | 歓迎・承認依頼・トライアル・請求 | 制御面アプリ自身。AI の営業メールに流用しない |

> Resend は Staffpass の通知。AgentMail は AI社員の名刺メール。Gmail は人間の仕事机。

### 5.2 Gateway 契約（P0 固定）

- **Endpoint:** `POST /api/gateway/invoke`
- **必須:** `employeeId`, `tool`, `purpose`, `jobId`（または `job_id`）
- **Allowlist:** `lib/gateway/tools.ts`（例: `calendar.propose` / `calendar.confirm` / `mail.draft` / `mail.send` / `commerce.order` …）
- **未登録ツール:** `403 unknown_tool`（fail-closed）
- **confirm / send / order:** 常に `402 needs_approval`（always_human デフォルト）。**Routines / Teach 由来でも同じ**（C4）
- **browser.use + allowedAccounts:** 未設定またはクレーム不一致 → `403` fail-closed（C5）。一致しても always_human。ライブID照合は `browserIdentityCheck: "partial"`
- **propose / draft / read:** employee ポリシーに応じ auto 可
- **AgentMail ツール:** `501 tool_reserved`（ライブ統合なし）

### 5.3 承認 must-list（JP SME 厳格・Managed 初期値）

必須承認（`always_human`）: 社外メール送信、日程**確定**、課金・購入、顧客マスタ更新／エクスポート、Drive 社外共有、browser:use、Slack 社外投稿、および **Routines/Teach がそれらの確定系を踏む場合** など。  
自動可: 空き枠**提案**、メール下書き、社内カレンダー参照、ナレッジ検索、Resend 通知。  
禁止デフォルト: 許可外アカウント操作、社員証の自己変更、監査ログ削除。

実装: `lib/employees/approval-presets.ts` → hire / policy-draft 初期値。

### 5.4 Won't（約束しない）

- OS 完全分離
- 学習の絶対停止保証
- マスキング 100%
- Drive = DB
- AgentMail 本送信を P0 で完成させること

### 5.5 Stripe SaaS vs commerce:order

| | Staffpass Stripe | AI社員 commerce:order |
|--|------------------|----------------------|
| 誰の金か | 顧客 → Staffpass への SaaS 料金 | 顧客の業務発注・購入 |
| ゲート | Billing / Subscription | Gateway + spend-gate + 承認 |

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
- `POST /api/gateway/invoke` — **ゲート経由実行（P0 の核）**。purpose + jobId 必須、ツール allowlist
- `GET /api/gateway/health` — 契約ヒント（allowlist / requirePurpose 等）
- `GET/POST /api/approvals/*`
- `GET` 監査系 (+ export は P1)
- `POST /api/webhooks/stripe` — **SaaS サブスク**用（commerce:order ではない）
- `POST /api/email` またはサーバ内 Resend ヘルパ（層 C のみ）
- MCP: 将来 `invoke_tool` / `get_job_audit` 等（自前契約）

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
| P0 | 社員証・ゲート契約（propose/confirm・draft/send）・監査・承認プリセット、LP、trial、AgentMail **予約** |
| P0.5 | AgentMail 契約・スキーマ確定（inbox 1:1）。本送信はまだ |
| P1 | AgentMail 本送信、エクスポート、Resend 充実、チーム、オンボーディング完成 |
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

## 13.5 バインディング・ライフライン（MUST）

`employeeId` 不変・トークンは初回手渡しのみ・再発行は `credentialGeneration++`・破綻は `needs_reauth`（要再連携）で可視化し黙って消さない・gateway は fail-closed。 詳細: [`../binding-lifeline.md`](../binding-lifeline.md)

## 14. 関連ドキュメント

- ミニマム1枚: `00-minimum-defaults.md`（A/D 採択後）
- 社内: `02-design-brief.md` / `03-sales-enablement.md`
- 仕様メモ: `../P0-audit-spec.md`
- 提案1枚: `../proposal-one-pager.md`
- デモ脚本: `../demo-script-esim-approval.md`
- バインディング: `../binding-lifeline.md`
- 強制 vs 手動: `../enforcement-auto-vs-manual.md`
- Gateway vs Auto-review: `../gateway-vs-auto-review.md`
- 安藤対応表（ワークスペース）: `/workspace/docs/staffpass-minimum-map.md`


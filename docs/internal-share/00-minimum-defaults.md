# Staffpass ミニマム・デフォルト（P0・A/D 採択後）

**読者:** 木村 / 安藤 / 実装  
**更新:** 2026-08-23（木村: A/D 採択＋公式共有コンピュータ前提 C1〜C5）  
**詳細表:** `/workspace/docs/staffpass-minimum-map.md`（社内原本）／本リポ `01-engineer-requirements.md`

---

## 一文定義

| 語 | 定義 |
|----|------|
| **Staffpass** | AI社員の社員証・承認・監査を担う制御面プロダクト（本リポ） |
| **制御面** | 許可 → 実行 → 証跡（必要なら承認）のゲート。モデルや財布は持たない |
| **AI社員** | Org 配下の Employee。手足は Grok Bot、権限は Credential |

---

## 公式前提 — 共有コンピュータ（C1・P0）

x.ai Grok Bot Docs（概念引用）より、実行環境は **同一ユーザー配下で共有**される。

| 事実 | 含意 |
|------|------|
| ファイル・ブラウザセッション・CLI資格情報は Bot 間で共有されうる | OS だけでは職務分離できない |
| 画面（デスクトップ）は Bot 別でも **セキュリティ境界ではない** | 「画面が分かれている＝安全」と約束しない |
| **Do not use separate Bots as a security boundary.** | Bot を増やしても境界にならない → **Staffpass 社員証が必須** |

> Bot分け ≠ 安全。公式も共有コンピュータ前提。境界は社員証・承認・監査へ移す。

参照（概念）: docs.x.ai `computer-and-apps` / `approvals-security-and-privacy` / FAQ。断定は最新公式で確認。

---

## 採択決定

| 提案 | 内容 |
|------|------|
| **A** | ツール二分: `calendar.propose` / `calendar.confirm`、`mail.draft` / `mail.send`。confirm・send = **always_human**。propose・draft は auto 可。未登録ツールは拒否。invoke に **purpose + jobId** 必須 |
| **D** | 企業DB正本は **Supabase のみ**。Drive = ファイル／添付のみ（DB代替禁止） |

---

## メール3層（混ぜない）

| 層 | 役割 |
|----|------|
| Human Gmail | 人が読む・決裁する机 |
| AI AgentMail | AI社員の名刺メール（**P0.5 予約**・本送信は P1） |
| Staffpass Resend | 制御面のシステム通知 |

---

## 承認 must / won't

**Must（初期 always_human）:** mail.send / calendar.confirm / commerce.order / browser.use / Drive社外共有 / 顧客マスタ更新・エクスポート / Slack社外投稿 など（Ando §3）。**Routines / Teach 経由の確定系（confirm / send / order）も同様に Staffpass ゲート必須**（C4）。実行フックは Partner API 不在のため限定的 → **Managed** で危険直結を外し補完。

**Won't（約束しない）:** OS完全分離、学習絶対停止、マスキング100%、Drive=DB

**別層メモ:** 人間RBAC（誰が承認ボタンを押せるか）≠ AI承認プリセット（どのアクションが要承認か）。`allowedAccounts` は P0隣接・**browser:use で欠落／不一致は fail-closed**（C5・ソフト警告のみにしない）。Stripe SaaS 課金 ≠ `commerce:order`。

**正本の二段:** Grok Auto-review＝個人／Bot側ネット。Staffpass Gateway＝組織の社員証・監査台帳（詳細: `../gateway-vs-auto-review.md`）。

---

## Managed 生命線（デモ文言）

> employeeId は不変。トークンは初回手渡しのみ。切れても黙って消さず **要再連携**。Gateway 外に危険ツールを載せない。

## ハイブリッド実行（木村確定）

1. パスに載せられる確定系（commerce / mail.send / calendar.confirm / 明示 invoke）→ Gateway **必須プロキシ**・fail-closed  
2. 迂回しうる経路（Bot内蔵・ブラウザ等）→ Managed で危険直結を外す＋ポリシー／教育＋事後ヘルス・監査突合  
3. 「全部プロキシできている」とは言わない。組織の正本と説明責任は Staffpass  

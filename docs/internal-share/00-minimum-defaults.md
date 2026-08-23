# Staffpass ミニマム・デフォルト（P0・A/D 採択後）

**読者:** 木村 / 安藤 / 実装  
**更新:** 2026-08-23（木村: 提案 A・D 採択）  
**詳細表:** `/workspace/docs/staffpass-minimum-map.md`（社内原本）／本リポ `01-engineer-requirements.md`

---

## 一文定義

| 語 | 定義 |
|----|------|
| **Staffpass** | AI社員の社員証・承認・監査を担う制御面プロダクト（本リポ） |
| **制御面** | 許可 → 実行 → 証跡（必要なら承認）のゲート。モデルや財布は持たない |
| **AI社員** | Org 配下の Employee。手足は Grok Bot、権限は Credential |

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

**Must（初期 always_human）:** mail.send / calendar.confirm / commerce.order / browser.use / Drive社外共有 / 顧客マスタ更新・エクスポート / Slack社外投稿 など（Ando §3）

**Won't（約束しない）:** OS完全分離、学習絶対停止、マスキング100%、Drive=DB

**別層メモ:** 人間RBAC（誰が承認ボタンを押せるか）≠ AI承認プリセット（どのアクションが要承認か）。`allowedAccounts` は P0隣接。Stripe SaaS 課金 ≠ `commerce:order`。

---

## Managed 生命線（デモ文言）

> employeeId は不変。トークンは初回手渡しのみ。切れても黙って消さず **要再連携**。Gateway 外に危険ツールを載せない。

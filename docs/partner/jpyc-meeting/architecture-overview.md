# JPYC × Sealith / lifetime-esim — アーキテクチャ概要

相手方共有用（NDA締結済）。技術の専門家以外の経営者にも読める平易な説明を心がけています。  
**秘密情報（APIキー・シード・個人鍵）は含みません。**

| 項目 | 内容 |
|------|------|
| 版 | 2026-08-27（JPYC社書面回答反映） |
| 対象 | JPYC株式会社 様 / 当社（TOKYO307 / Sealith） |
| 関連 | 近接PoC：lifetime-esim.com の商品決済（JPYC ＋ 既存 Stripe） |

---

## 0. ひとことで言うと

お客さまが eSIM を買うとき、**クレジットカード（Stripe）か JPYC** で支払えるようにする、というのが直近の PoC です。

JPYCを手元に用意する手順は、Sealithから**JPYC EX公式サイトへ通常の外部リンク**で案内します。人が公式サイト上で手続きを行い、当社はJPYC EXを埋め込み・自動操作しません。当社はお客さまのコインや鍵を預かりません。

AI社員（Staffpass）は、将来「AIが買い物を提案する」ときに社長が止められるための仕組みで、今回の JPYC 連携の主役ではありません（任意のガバナンス層）。

---

## 1. 登場人物（役割）

| 役割 | 誰 | 何をするか | 何をしないか |
|------|-----|------------|--------------|
| **JPYC** | JPYC株式会社 | KYC、発行／償還の最終確定、JPYC EX公式サイトの提供 | 当社の商品フルフィルメント |
| **当社（接続・加盟店）** | TOKYO307 / Sealith | 購入導線・UX、lifetime-esim の手配、受取ウォレット（Safe想定）、台帳・監査 | 利用者資産のカストディ、無人S2Sミント |
| **利用者** | 購入者（個人／法人） | 自己管理ウォレット、購入意思、JPYC画面での確認 | — |
| **AI社員（Staffpass）** | Grok Bot 上の制御プレーン | （任意）発注提案の承認・上限・監査 | JPYC送金、入金確定、EX操作 |

---

## 2. 全体像（ハイレベル）

購入から eSIM お渡しまでの大きな流れです。

```mermaid
flowchart LR
  Buyer[購入者]
  SP[Staffpass承認<br/>任意]
  Rail{決済レール}
  Stripe[Stripe]
  JPYC[JPYC]
  Fulfill[lifetime-esim<br/>フルフィルメント]
  eSIM[eSIM納品]
  Ledger[Sealith<br/>台帳・監査]

  Buyer --> SP
  SP --> Rail
  Rail --> Stripe
  Rail --> JPYC
  Stripe --> Fulfill
  JPYC --> Fulfill
  Fulfill --> eSIM
  SP -.-> Ledger
  Rail -.-> Ledger
  Fulfill -.-> Ledger
```

**読み方（平易）**

1. 購入者が商品を選ぶ。  
2. （将来・任意）AI社員経由なら Staffpass で上限・承認を見る。人の購入ならスキップ可。  
3. 支払い方法を選ぶ：Stripe または JPYC。  
4. 支払いが確認できたら lifetime-esim が eSIM を手配・お渡し。  
5. 誰が何を承認し、どのレールで払ったかを台帳に残す（説明責任用）。

---

## 3. JPYC入手案内 → コマース決済（シーケンス）

「コインを用意してから、加盟店（当社 Safe）へ支払う」までの順序です。

```mermaid
sequenceDiagram
  actor U as 利用者
  participant App as 当社アプリ/サイト
  participant EX as JPYC EX公式サイト
  participant Watcher as Sealith Watcher<br/>Polygon
  participant Safe as 加盟店 Safe<br/>（受取）
  participant ES as lifetime-esim

  U->>App: JPYC入手ガイドを開く
  App-->>U: JPYC EX公式サイトへの外部リンク
  U->>EX: 人がKYC・発行手続きを行う
  Note over EX: Sealith/Staffpassは操作・状態取得しない
  U->>Safe: コマース支払い（JPYC）
  Watcher->>Safe: Transferログを検知・確認
  Watcher-->>App: Sealith正本の入金確定
  App->>ES: フルフィルメント指示
  ES-->>U: eSIM 納品
```

**ポイント**

- **JPYC EXは公式外部リンクだけ。** iframe、WebView、RPA、スクレイピング、status APIは使いません。
- JPYC社回答により、直接送金＋Watcher＋Safe受取にEX連携API、個別契約、個別許諾、実装費用は不要です。
- 商品代金の送金は利用者ウォレットからmerchant Safeへ直接行い、Sealith Watcherだけがアプリ上の入金確定を行います。
- 受取は **当社の Safe（マルチシグ想定）**。利用者鍵は当社が持たない。

---

## 4. ノンカストディの整理

```
[利用者の自己管理ウォレット] --支払--> [当社 受取 Safe（想定）]
         ↑ 鍵は利用者のみ                    ↑ 加盟店オペレーション
         Sealith は預からない
```

- 当社は「つなぐ・見せる・記録する・商品を渡す」側。  
- コインの発行者としての最終判断は JPYC。  
- したがって、利用者のシードや秘密鍵を当社サーバーに置く設計にはしない。

---

## 5. Staffpass の位置（軽量）

```mermaid
flowchart TB
  Agent[AI社員が購入を提案]
  Gate{Staffpass<br/>社員証・予算・承認}
  Human[人が承認]
  Pay[決済レールへ<br/>Stripe or JPYC]

  Agent --> Gate
  Gate -->|未承認| Human
  Human --> Pay
  Gate -->|ポリシー内| Pay
```

- PoC の最小構成では **人がサイトから直接購入**でも成立する。  
- Staffpass は「AIが勝手に買えない」ためのゲートであり、**JPYC 接続仕様の本体ではない**。

---

## 6. ロードマップ（山のイメージ）

```mermaid
flowchart LR
  A[① 国内 eSIM PoC<br/>JPYC決済 + Stripe併存] --> B[② 自社プロダクト連携強化<br/>eSIM + Staffpass 制御]
  B --> C[③ グローバルも視野<br/>決済レールは地域最適化]
```

| 段階 | 内容 | 注意 |
|------|------|------|
| ① いま | lifetime-esim で JPYC 支払いを試す | 無人発行しない・カストディしない |
| ② 次 | 承認・監査と決済のつなぎを厚くする | 契約・ライセンス論点を並行 |
| ③ 将来 | 海外展開も視野 | **決済レールは地域ごとに最適化**。JPYC の海外展開を当社が約束しない |

---

## 7. PoCでやること / やらないこと（再掲）

| やる | やらない |
|------|----------|
| eSIM 商品の JPYC 決済（Stripe 併存） | 無人 S2S ミント／発行 |
| JPYC EX公式サイトへの外部リンク | 利用者 JPYC・鍵のカストディ |
| Sealith Watcherによる直接送金確認 | JPYC EXの埋め込み・自動操作・status API |
| Safe 受取・台帳・監査 | 本資料範囲外の新規金融商品組成 |

---

## 8. 用語のやさしい対応表

| 用語 | 意味 |
|------|------|
| eSIM | スマホに通信プランを後から入れる仕組み。lifetime-esim の商品。 |
| JPYC | 円に連動するステーブルコイン（詳細は JPYC 公式）。 |
| 外部リンク | JPYC EX公式サイトを通常のブラウザ遷移で開く導線。 |
| オンランプ | 円などから JPYC を手元に用意する流れ。 |
| Safe | 複数人承認などを想定した受取用ウォレット。 |
| ノンカストディ | 会社がお客さまの鍵・資産を預からないこと。 |
| Staffpass | AI社員の「社員証・承認・記録」プロダクト。 |

---

## 9. 次の技術確認（宿題候補）

1. PoC 対象ネットワークとテスト手順  
2. 直接送金のWatcher確認とpayment event identity
3. Safe アドレスの管理・ローテーション方針  
4. ユーザー向け画面文言（誰が何を確定するか）  
5. 障害時の切り分け（公式リンク案内 vs Polygon Watcher）

---

*TOKYO307 / Sealith — 相手方共有可*  
*本資料は設計意図の共有であり、契約条件そのものではありません。*

# Commerce provider notes（Staffpass × 発注）

Staffpass は **commerce:order（発注）をゲートする側**です。AI社員が発注できるかどうか・いくらまで・誰が承認するか・何が記録に残るかを、社員証・承認・監査の同じレールで扱います。

## 役割の分け方

| 役割 | 誰がやるか | いまの意図 |
|------|------------|------------|
| ゲート（許可・上限・承認・監査） | **Staffpass** | `commerce:order` を許可していない／予算未設定／未承認なら **実行しない** |
| フルフィルメント（実商品の手配・決済） | **外部 Provider** | 例: lifetime-esim.com（Stripe） |
| commerce台帳・JPYC入金正本（任意） | Sealith | Staffpassとは`jobId`・namespaced approval・orderIdで接続。単体利用には必須でない |

## eSIM の位置づけ

- lifetime-esim.com は、承認と上限を通ったあとの **手配・課金 Provider** になり得る、という整理です。
- Staffpass の LP・ダッシュボードは「発注も承認と上限の内側」とだけ述べ、特定商品のハードセルはしません。
- Sealithは任意の決済・台帳モジュールであり、Staffpass単体の発注制御には必須ではありません。併用時だけ署名イベントで監査範囲をつなぎます。

## 共通パス

どの Provider でも、流れは同じです。

1. AI社員が発注を提案（または人が依頼）
2. Staffpass が社員証・予算・リスクを見る
3. 要対応なら人が承認（**承認されるまで実行しません**）
4. 通ったものだけ Provider に渡し、結果を監査に残す

## いま実装しないこと

- lifetime-esimやJPYCへ送金・発注するProvider接続コードは **このリポジトリでは未実装**です。
- Sealithとの`external_reference`イベント送受信は実装済みですが既定で無効です。Staffpass承認はSealithのAgent Token、Action Manifest、Human Approvalを迂回しません。
- StaffpassはJPYC EXを自動操作せず、入金・返金・履行を独自確定しません。Sealith由来の状態は`sourceSystem=sealith`付き投影としてだけ保持します。

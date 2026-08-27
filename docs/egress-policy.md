# 相手 × 情報区分の出域制御

Staffpass は **会話アダプタ**（誰に何を出すか）と **通知チャネル**（Telegram / LINE で人間へ承認を届ける）を混ぜません。

| 面 | 役割 | 例 |
|----|------|----|
| 会話アダプタ | AI社員が相手へ情報を出す | `comm.send` / `comm.reply` / `slack.post`（エイリアス） |
| 通知チャネル | 人間の承認ループ | `org_notification_channels`（Telegram / LINE） |

Slack を通知プロバイダとして足すことは将来の拡張点ですが、**Slack Bot トークンは不要**ですし、会話の境界にもしません。LINE / Jurin（電話）アダプタは予約です。

## ツール名は境界ではない

モデルが `slack.post` を選んでも社内、`slack.post_external` を選んでも社外、にはなりません。どちらも **同じ audience resolver** を通ります。宛先が無い `comm.*` / `slack.*` は unknown = 社外（fail-closed）。

正本ツールは `comm.send` / `comm.reply`（surface + 宛先識別子が必須）です。

## 相手（WHO）

- `internal` | `external` | `unknown`
- unknown は **external** として扱う
- 混在 / ゲスト / `shared_external` の Slack チャネルは egress 上 **external**
- 入域と出域の audience は独立

台帳: `org_parties`（ドメイン・Slack ID など）と `org_channels`（チャネル分類）。未登録は社外。

## 情報区分（WHAT）— ちょうど4つ

`public` | `internal` | `confidential` | `verbatim`

未分類アセットは `confidential`。開示の粒度は `summary` | `source`。

ツール既定:

- `calendar.read` の busy/free → internal + summary
- タイトル / 出席者などの詳細（`disclosure=source`）→ internal + source
- `knowledge.search` / `files.read` → タグが無ければ confidential
- `mail.send` / Slack 本文 → 含むアセットの区分を継承。不明なら confidential

## マトリクス（4決定）

`allow` | `summarize` | `needs_approval` | `deny`

- 社外 × public → allow
- 社外 × internal + summary → summarize（詳細/source は deny）
- 社外 × confidential → deny
- 社外 × verbatim → deny
- 社内 × public または internal（summary） → allow
- 社内 × confidential summary → needs_approval
- 社内 × verbatim → 宛先が指名されていなければ deny。指名があれば needs_approval

`needs_approval` は既存の poll 契約（`approvalId` / `statusToken` / `pollUrl` / `pollHint`）。社員に上長がいればチケットへ `managerId` を付けます。

## 既存ゲートとの合成

順序: スコープ → SoD → 行為上限 → always_human（mail.send / calendar.confirm / commerce.order / drive.share_external / files.write / browser.use）→ **egress** → スタブ実行。

SoD `force_human` や行為上限の needs_approval / deny は **スキップしません**（マトリクスが allow でも勝ちます）。

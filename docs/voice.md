# 話し方（HOW）— 社員証の voice

Staffpass の出域は **WHO × WHAT × HOW** です。HOW は社員証の character / register（`employees.voice`）。相手ごとのペルソナ（party directory）は対象外です。

モデルは毎回ペルソナを自称しません。`staffpass_whoami` の `voice` に従います。

## WHO / WHAT / HOW

| 軸 | 正本 | 何をするか |
|----|------|------------|
| WHO | 相手（audience） | 社内 / 社外。unknown は社外 |
| WHAT | 情報区分 | public / internal / confidential / verbatim |
| HOW | **voice**（この文書） | 丁寧 / 率直 / カスタム。社外は丁寧が下限 |

WHO × WHAT の 4 決定マトリクスは [egress-policy.md](./egress-policy.md) が正本です。ここは上書きしません。

## 社員証テンプレート

| template | 用途 | register | endings | forbidden 既定 | signOff |
|----------|------|----------|---------|----------------|---------|
| `polite` | 丁寧（対外向け） | polite | desumasu | 了解, ぶっちゃけ, ヤバい, マジで, ごめん | 何卒よろしくお願いいたします |
| `frank` | 率直（社内） | frank | either | 空 | null |
| `custom` | カスタム | 選択可 | 選択可 | 利用者が設定 | 利用者が設定 |

`externalFloor` は常に `polite`。新規雇用で省略したときは polite。

禁止語リストは小さく、コードとこの表に書いてあります。

## `effectiveVoice(badge, audience)`

- 有効 audience が **external**（unknown 含む）: `register=polite`, `endings=desumasu`, `forbidden = union(badge.forbidden, polite forbidden)`, `signOff = badge.signOff || polite signOff`, `floorApplied=true`
- **internal**: バッジをそのまま。`floorApplied=false`

率直テンプレートの社員が社外へ話すときも丁寧に引き上げます。

## 禁止語スキャンは DLP ではない

会話出域（`comm.send` / `comm.reply` / `slack.post*`）の本文（`args.text` / `body` / `message`）に対する **安い単語一致** です。

- 大文字小文字は変えません（日本語文字列の trim のみ）
- ヒットしたら HTTP 403 `voice_forbidden_phrase`。Slack には投稿しません
- 言い切り検出・文体 NLP・ファイル DLP ではありません
- `calendar.read` など会話出域でないツールではスキャンしません

## whoami

`staffpass_whoami` は **バッジの voice** を常に返します。会話コンテキストは無いので floor は適用しません。注記: 宛先が社外のときは Gateway が丁寧に引き上げます。

# 相手 × 情報区分の出域制御

（第四軸 WHICH＝プロジェクト範囲は [project-scope.md](./project-scope.md)。このマトリクスは上書きしません。）

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
- 入域と出域の audience は独立

台帳: `org_parties`（ドメイン・Slack ID など）と `org_channels`（チャネル分類）。未登録は社外。

### S1: 混在チャネル dual-audience（メンバーレベル解決）

混在 / ゲスト / `shared_external` / Slack Connect チャネルでは、チャネル単位ではなく **宛先パーティごと** に audience を解決します。

**返却値**:
- `effectiveAudience`: 後方互換。常にチャネル全体の fail-closed（external-safe）値
- `dualAudience`: 新規 S1 構造体
  - `internalFacing`: 内部パーティのみ宛ての場合の判定（内部 vs 外部）
  - `externalFacing`: 外部／未知パーティ含む場合の判定（常に external）
  - `channelMixed`: 混在チャネルかどうか
  - `partySignals`: パーティごとの解決詳細（kind / identifier / audience / resolved）
  - `hasInternalParty`: 内部パーティが存在
  - `hasExternalParty`: 外部／未知パーティが存在

**ルール**:
1. 純内部チャネル（`classification=internal` かつ `mixed=false`）→ 従来通り内部扱い
2. 混在チャネル → パーティ個別解決、`effectiveAudience` は external を維持
3. 未登録パーティ → fail-closed external
4. ext-shared 自動検出 (`shared_external` + Connect) → S1 でもパーティ信号と**合成**（検出自体は維持）

**例**: `#stablo_tokyo307` Connect チャネル
- Yasaka 社員 (`U_YAMADA`) → `partySignals[{internal, resolved}]`
- Uehara/Stablo 外部ゲスト → `partySignals[{external, resolved}]` または `{unknown, !resolved}`
- `dualAudience.hasInternalParty = true`, `hasExternalParty = true`
- `dualAudience.internalFacing = "external"` (外部パーティがいるため)
- `dualAudience.externalFacing = "external"`

後続スライスでこの dual 判定を使い、WHO×WHAT マトリクスを内部向け・外部向けで二度適用し、ルーティングを分岐します（S3: チャネル投稿=external-safe、内部詳細=DM/限定スレッド）。

### S2: 二重マトリクス評価と監査記録

S1 の `dualAudience` を使い、混在チャネルでは WHO×WHAT マトリクスを **内部向け・外部向けで二度評価** します。

**返却値**:
- `dualEgress`: S2 構造体
  - `internalDecision`: 内部パーティ向けの決定（internal audience で評価）
  - `externalDecision`: 外部パーティ向けの決定（external audience で評価）
  - `dualEvaluated`: 二重評価が適用されたか（`channelMixed` かつパーティ存在時に `true`）
  - `effectiveDecision`: チャネル投稿に適用する決定（常に `externalDecision` = external-safe）

**動作**:
1. `dualAudience.channelMixed = true` かつパーティ存在 → 二重評価
2. 純内部チャネル or `dualAudience = null` → 単一パス（`dualEvaluated = false`）
3. チャネル投稿は常に `effectiveDecision`（external-safe）を使用
4. 両決定は監査イベントに記録（`metadata.dualEgress`）

**例**: 混在チャネルで機密情報 (`confidential`) を送信

| パス | audience | 決定 | 理由 |
|------|----------|------|------|
| 内部向け | internal | `needs_approval` | 機密情報の社内開示には上長承認 |
| 外部向け | external | `deny` | 機密情報の社外開示は拒否 |
| 実効 | external | `deny` | チャネル投稿は external-safe |

**監査**:
- `tool.invoke` 監査イベントの `metadata.dualEgress` に両決定を記録
- 承認リクエストの `metadata.dualEgress` にも同様に記録
- `dualDecisionsDiffer()` で内部・外部パスの決定が異なるかを判定可能

S3 では `effectiveDecision` の結果に基づき、チャネル本文は external-safe、内部詳細は DM / 限定スレッドへルーティングします（本 PR の範囲外）。

> **オペレータ向けガイダンス**: テナント管理エージェント向けの kickoff rail は [tenant-slack-kickoff-rail.md](./tenant-slack-kickoff-rail.md) を参照。混在chは相手台帳必須（`parties.upsert`）。S1/S2/S3 の進捗もそちらに記載。

## 情報区分（WHAT）— ちょうど4つ

`public` | `internal` | `confidential` | `verbatim`

未分類アセットは `confidential`。開示の粒度は `summary` | `source`。モデルは区分を自称できない（より厳しい区分への引き上げのみ）。

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

順序: スコープ → SoD → 行為上限 → always_human（mail.send / calendar.confirm / commerce.order / drive.share_external / files.write / browser.use）→ **プロジェクト壁（WHICH）** → **egress** → **voice（HOW）** → 会話投稿 / スタブ実行。

第四軸 WHICH（プロジェクト）は社員証の `projectAccess`。既定は会社全般のみ。範囲外は `project_scope_denied`（社内宛でも拒否）。詳細は [project-scope.md](./project-scope.md)。マトリクス自体は変えません。

SoD `force_human` や行為上限の needs_approval / deny は **スキップしません**（マトリクスが allow でも勝ちます）。

## 話し方（HOW）

WHO × WHAT のあとに、社員証の **voice** が載ります（丁寧 / 率直 / カスタム）。社外（unknown 含む）は丁寧が下限です。禁止語は会話本文の安い単語スキャンであり、DLP ではありません。詳細は [voice.md](./voice.md)。

イベント別の補足ルール（日程調整・口ルーティング・添付など）は [staffpass-situation-policy-catalog.md](./staffpass-situation-policy-catalog.md) を参照。

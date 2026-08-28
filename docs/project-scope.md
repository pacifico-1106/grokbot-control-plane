# プロジェクト範囲（WHICH）

Staffpass の出域は **WHO × WHAT × HOW × WHICH** です。WHICH は社員証のプロジェクト範囲（`employees.project_access`）。

1 ボディ = 1 AI社員。新規雇用の既定ナレッジは **会社全般** のみです。指名プロジェクト（例: 新規事業A）は Staffpass が社員証に刻みます。SNS/日程の汎用社員は他案件を見ません。プロジェクト外のナレッジは社内向け要約でも出しません。

この文書は [egress-policy.md](./egress-policy.md) の相手×情報区分マトリクスと [voice.md](./voice.md) を上書きしません。合成します。

## アクセスモデル（fail-closed）

`org_projects`: 組織ごとのプロジェクト。必ず既定が 1 件あります。

| 項目 | 値 |
|------|----|
| slug | `company` |
| name | 会社全般 |
| isDefault | true |

既定プロジェクトは削除できません。

アセット（`information_assets.project_id`）が未設定 / null のときは、その組織の会社全般として扱います（会社アクセスがあれば見える）。

社員の `projectAccess`:

```
{ mode: "company" | "selected" | "all", projectIds: string[] }
```

| mode | 意味 |
|------|------|
| `company`（新規雇用の既定） | 会社全般のみ。他プロジェクトのアセットは読めない・開示できない |
| `selected` | チェックしたプロジェクトの和。UI では会社全般を初期オン（オフにできる） |
| `all` | 組織の全プロジェクト（強力。稀な全社ボット向け）。情報区分の出域は別途適用 |

`employeeCanAccessProject` / `employeeCanAccessAsset` が正本です。

不明なアセット参照は、従来どおり情報区分では confidential。加えてプロジェクト壁では、`company` / `selected` は拒否（`project_scope_denied`）。`all` はプロジェクト壁を通過し、機密出域に当たることがあります。

## 強制ポイント

`knowledge.search` / `files.read` / 相手ゲート付き会話（`comm.send` / `comm.reply` / `slack.post*`）:

1. 情報区分と同じヘルパーでアセット参照を集める
2. どれか 1 件でも社員のプロジェクト範囲外 → HTTP 403 `project_scope_denied`（`この社員のプロジェクト範囲外のナレッジです。`）
3. Slack 投稿の前。クラス/話し方が allow でもプロジェクト拒否が勝つ
4. 社内宛先でも壁は Bypass しない

`knowledge.search` でアセット参照が無いときは、ヒットを捏造せずスタブに `projectAccess` を載せて壁を知らせます。

`staffpass_whoami` は `projectAccess`（安ければ解決済みプロジェクト名）を返します。

## ギャップ

- ライブのナレッジ索引はまだ無い（検索はスタブ。壁は参照アセットと whoami で伝える）
- Google Drive 等のファイル単位 ACL は対象外（Staffpass のアセットタグ + 社員証が正本）

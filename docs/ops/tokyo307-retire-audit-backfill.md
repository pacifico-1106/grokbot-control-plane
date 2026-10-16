# TOKYO307 退職監査の事後記入

社員証を REST（Supabase 直書き）で先に失効したあと、監査を正規の `audit_events` に揃えるための確認・記入 SQL。

- SQL: [`supabase/verification/20261017100000_tokyo307_retire_audit_backfill.sql`](../../supabase/verification/20261017100000_tokyo307_retire_audit_backfill.sql)
- 対象社員証 ID の先頭: `9e9bfc80` / `53d551f3` / `43b63187` / `0fd2f410`
- このエージェントは本番に流さない。人間が変数を埋めて、まず `BEGIN` … `ROLLBACK` で確認する。

## 手順

1. SQL 先頭の一時テーブル `retire_backfill_params` を埋める。
   - `actor_email`: 八坂さんの実メール（`actor` は human）
   - `org_id`: 分かっていれば TOKYO307。不明なら `null` のまま prefix で探す
   - 完全な UUID が分かったら `credential_ids` に入れる（prefix より優先）
2. ファイル全体を実行する（末尾は `ROLLBACK`）。
3. 確認クエリを見る。
   - 対象社員証の `revoked_at`
   - 既存の `credential.revoked` / `employee.terminated`
   - 同じ従業員に残っている有効な社員証・OAuth grant / token・MCP Events 購読
4. `backfill_preview` の件数を確認する。
5. 本番適用はレビュー後、同じ文の末尾を `COMMIT` に変えて人間が流す。

二重挿入は `metadata.backfill = true` の有無で抑止する。

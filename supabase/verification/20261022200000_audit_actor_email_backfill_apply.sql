-- PR-6 本番適用。八坂 GO が出るまで実行しない。
-- このファイルはオートコミットで実行すること（PROCEDURE がバッチごとに COMMIT する）。
-- BEGIN の中では動かない。
--
-- 配列を空のまま呼ぶと 0 件（fail-closed。全 org には広がらない）。
-- ADMIN_AUDIT_ACTOR_EMAIL_BACKFILL_ORG_IDS に書いた UUID だけを入れる。
-- 既存の actor_email は上書きしない。印は metadata.backfill = 'actor_email_pr6'。

call public.backfill_audit_actor_email_pr6_orgs(
  array[
    -- 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'::uuid
  ]::uuid[],
  500
);

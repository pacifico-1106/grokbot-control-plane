-- PR-6 本番適用。八坂 GO が出るまで実行しない。
-- 1 回の実行は最大 500 行（関数側で 2000 まで）。戻り値が 0 になるまで繰り返す。
-- 一時テーブルが空なら 0 件（fail-closed。全 org には広がらない）。
-- ADMIN_AUDIT_ACTOR_EMAIL_BACKFILL_ORG_IDS に書いた UUID だけを入れる。
-- 既存の actor_email は上書きしない。印は metadata.backfill = 'actor_email_pr6'。

create temporary table if not exists pr6_apply_orgs (
  org_id uuid primary key
);
delete from pr6_apply_orgs;
-- insert into pr6_apply_orgs(org_id) values ('xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx');

select
  o.org_id,
  public.backfill_audit_actor_email_pr6_batch(o.org_id, 500) as updated
from pr6_apply_orgs o
order by o.org_id;

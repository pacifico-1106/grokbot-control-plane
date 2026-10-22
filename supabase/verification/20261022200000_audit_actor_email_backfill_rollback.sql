-- PR-6 データ rollback。metadata.backfill = 'actor_email_pr6' の行だけ
-- actor_email を NULL に戻し、印を外す。既存値や他の backfill は触らない。
-- 一時テーブルが空なら 0 件（fail-closed）。戻り値が 0 になるまで繰り返す。
--
-- 関数の DROP はデータを戻したあと、下のコメントを外して別途実行する。

create temporary table if not exists pr6_rollback_orgs (
  org_id uuid primary key
);
delete from pr6_rollback_orgs;
-- insert into pr6_rollback_orgs(org_id) values ('xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx');

select
  o.org_id,
  public.rollback_audit_actor_email_pr6_batch(o.org_id, 500) as updated
from pr6_rollback_orgs o
order by o.org_id;

-- 印が残っていないこと（対象 org。テーブルが空なら 0 行）
select
  'remaining_marks' as check_name,
  a.org_id,
  count(*) as rows
from public.audit_events a
join pr6_rollback_orgs o on o.org_id = a.org_id
where a.metadata->>'backfill' = 'actor_email_pr6'
group by a.org_id
order by a.org_id;

-- 関数 DROP（データ rollback を確認してから。このファイルでは実行しない）
-- begin;
-- drop function if exists public.rollback_audit_actor_email_pr6_batch(uuid, integer);
-- drop function if exists public.backfill_audit_actor_email_pr6_batch(uuid, integer);
-- drop function if exists public.audit_pr6_actor_email_empty(text);
-- drop function if exists public.audit_pr6_is_rfc_email(text);
-- drop function if exists public.audit_pr6_approval_uuid(jsonb);
-- commit;

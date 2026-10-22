-- PR-6 データ rollback。metadata.backfill = 'actor_email_pr6' の行だけ
-- actor_email を NULL に戻し、印を外す。既存値や他の backfill は触らない。
-- オートコミットで実行すること。配列が空なら 0 件（fail-closed）。
--
-- 関数の DROP はデータを戻したあと、下のコメントを外して別途実行する。

call public.rollback_audit_actor_email_pr6_orgs(
  array[
    -- 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'::uuid
  ]::uuid[],
  500
);

-- 印が残っていないこと
select
  'remaining_marks' as check_name,
  a.org_id,
  count(*) as rows
from public.audit_events a
where a.metadata->>'backfill' = 'actor_email_pr6'
group by a.org_id
order by a.org_id;

-- 関数 DROP（データ rollback を確認してから。このファイルでは実行しない）
-- begin;
-- drop procedure if exists public.rollback_audit_actor_email_pr6_orgs(uuid[], integer);
-- drop procedure if exists public.backfill_audit_actor_email_pr6_orgs(uuid[], integer);
-- drop procedure if exists public.rollback_audit_actor_email_pr6_org(uuid, integer);
-- drop procedure if exists public.backfill_audit_actor_email_pr6_org(uuid, integer);
-- drop function if exists public.rollback_audit_actor_email_pr6_batch(uuid, integer);
-- drop function if exists public.backfill_audit_actor_email_pr6_batch(uuid, integer);
-- drop function if exists public.audit_pr6_actor_email_empty(text);
-- drop function if exists public.audit_pr6_is_rfc_email(text);
-- drop function if exists public.audit_pr6_approval_uuid(jsonb);
-- commit;

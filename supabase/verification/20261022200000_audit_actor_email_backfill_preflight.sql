-- PR-6 適用前の件数（読み取り専用）。migration 適用後に実行する。
-- 本番への書き込みはしない。八坂 GO の前に org ごとの候補数を見る。
-- metadata の印は 'actor_email_pr6'。生メール / ハッシュ / 秘密は出さない。

-- (1) org ごとの「空 actor_email を埋められる行」
select
  'fillable' as check_name,
  a.org_id,
  count(*) as rows
from public.audit_events a
join public.approval_requests r
  on r.id = public.audit_pr6_approval_uuid(a.metadata)
 and r.org_id = a.org_id
join public.org_members m
  on m.id = r.resolved_by
 and m.org_id = a.org_id
where public.audit_pr6_actor_email_empty(a.actor_email)
  and coalesce(a.metadata->>'backfill', '') <> 'actor_email_pr6'
  and public.audit_pr6_is_rfc_email(m.email)
group by a.org_id
order by a.org_id;

-- (2) 全体の候補件数
select
  'fillable_total' as check_name,
  count(*) as rows
from public.audit_events a
join public.approval_requests r
  on r.id = public.audit_pr6_approval_uuid(a.metadata)
 and r.org_id = a.org_id
join public.org_members m
  on m.id = r.resolved_by
 and m.org_id = a.org_id
where public.audit_pr6_actor_email_empty(a.actor_email)
  and coalesce(a.metadata->>'backfill', '') <> 'actor_email_pr6'
  and public.audit_pr6_is_rfc_email(m.email);

-- (3) 既にこの backfill で印が付いている行（再実行しても増えないはず）
select
  'already_marked' as check_name,
  a.org_id,
  count(*) as rows
from public.audit_events a
where a.metadata->>'backfill' = 'actor_email_pr6'
group by a.org_id
order by a.org_id;

-- (4) 空だが埋められない行（合成ラベル・approvalId 欠落・他 org 参照）
select
  'empty_not_fillable' as check_name,
  count(*) as rows
from public.audit_events a
where public.audit_pr6_actor_email_empty(a.actor_email)
  and coalesce(a.metadata->>'backfill', '') <> 'actor_email_pr6'
  and not exists (
    select 1
    from public.approval_requests r
    join public.org_members m
      on m.id = r.resolved_by
     and m.org_id = r.org_id
    where r.id = public.audit_pr6_approval_uuid(a.metadata)
      and r.org_id = a.org_id
      and public.audit_pr6_is_rfc_email(m.email)
  );

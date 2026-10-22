-- PR-6 適用後の確認（読み取り専用）。生メール / ハッシュ / 秘密は出さない。

-- (1) この backfill で印を付けた行。actor_email が空のままなら異常。
select
  'marked' as check_name,
  a.org_id,
  count(*) as rows,
  count(*) filter (where public.audit_pr6_actor_email_empty(a.actor_email)) as still_empty
from public.audit_events a
where a.metadata->>'backfill' = 'actor_email_pr6'
group by a.org_id
order by a.org_id;

-- (2) まだ埋められる行（再実行で 0 になること）
select
  'still_fillable' as check_name,
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

-- (3) 印付き行の metadata.backfill 以外に、この更新で秘密キーを足していないこと
select
  'marked_secret_keys' as check_name,
  count(*) as rows
from public.audit_events a
where a.metadata->>'backfill' = 'actor_email_pr6'
  and (
    a.metadata ? 'status_token'
    or a.metadata ? 'statusToken'
    or a.metadata ? 'poll_path'
    or a.metadata ? 'pollPath'
    or a.metadata ? 'pollUrl'
  );

-- (4) 印付き行の metadata.backfill 値は固定ラベルのみ
select
  'marked_backfill_values' as check_name,
  a.metadata->>'backfill' as backfill_mark,
  count(*) as rows
from public.audit_events a
where a.metadata ? 'backfill'
  and a.metadata->>'backfill' = 'actor_email_pr6'
group by a.metadata->>'backfill';

-- (5) テナント越え: 印付き行の承認 / 会員が他 org なら 0 件であること
select
  'cross_org_marked' as check_name,
  count(*) as rows
from public.audit_events a
left join public.approval_requests r
  on r.id = public.audit_pr6_approval_uuid(a.metadata)
left join public.org_members m
  on m.id = r.resolved_by
where a.metadata->>'backfill' = 'actor_email_pr6'
  and (
    (r.id is not null and r.org_id is distinct from a.org_id)
    or (m.id is not null and m.org_id is distinct from a.org_id)
  );

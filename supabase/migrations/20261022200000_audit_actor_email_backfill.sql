-- PR-6: empty audit_events.actor_email backfill helpers.
-- Functions / procedures only. This migration does NOT write data.
-- Production apply waits for 八坂 GO + explicit org list
-- (supabase/verification/20261022200000_audit_actor_email_backfill_apply.sql).
-- Empty org list = 0 updates (fail-closed; never "all orgs").
-- ADMIN_AUDIT_ACTOR_EMAIL_BACKFILL_ENABLED stays OFF until then.
--
-- Writes empty actor_email only (null / blank). Existing values —
-- including synthetic org_owner / slack_* / approval_delivery_alert —
-- are not overwritten. Joins stay inside one org. Batches COMMIT so
-- large tables do not hold a long lock. metadata.backfill is the
-- rollback mark 'actor_email_pr6' only — no email, hash, or secret.
--
-- Rollback (data): supabase/verification/20261022200000_audit_actor_email_backfill_rollback.sql
begin;

create or replace function public.audit_pr6_approval_uuid(meta jsonb)
returns uuid
language sql
immutable
parallel safe
set search_path = pg_catalog, public
as $fn$
  select case
    when meta->>'approvalId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then (meta->>'approvalId')::uuid
    when meta->>'approval_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then (meta->>'approval_id')::uuid
    else null
  end;
$fn$;

create or replace function public.audit_pr6_is_rfc_email(v text)
returns boolean
language sql
immutable
parallel safe
set search_path = pg_catalog, public
as $fn$
  select v is not null
     and btrim(v) = v
     and v !~ '[[:space:]]'
     and v ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     and v <> 'org_owner'
     and v <> 'approval_delivery_alert'
     and v not like 'slack_%';
$fn$;

create or replace function public.audit_pr6_actor_email_empty(v text)
returns boolean
language sql
immutable
parallel safe
set search_path = pg_catalog, public
as $fn$
  select v is null or btrim(v) = '';
$fn$;

create or replace function public.backfill_audit_actor_email_pr6_batch(
  p_org_id uuid,
  p_limit integer default 500
) returns integer
language plpgsql
security invoker
set search_path = pg_catalog, public
as $fn$
declare
  v_limit integer;
  n integer;
begin
  if p_org_id is null then
    raise exception 'org_id_required';
  end if;
  v_limit := case
    when p_limit is null or p_limit < 1 then 500
    when p_limit > 2000 then 2000
    else p_limit
  end;

  with candidates as (
    select a.id
      from public.audit_events a
      join public.approval_requests r
        on r.id = public.audit_pr6_approval_uuid(a.metadata)
       and r.org_id = a.org_id
       and r.org_id = p_org_id
      join public.org_members m
        on m.id = r.resolved_by
       and m.org_id = a.org_id
       and m.org_id = p_org_id
     where a.org_id = p_org_id
       and public.audit_pr6_actor_email_empty(a.actor_email)
       and coalesce(a.metadata->>'backfill', '') <> 'actor_email_pr6'
       and public.audit_pr6_is_rfc_email(m.email)
     order by a.created_at, a.id
     limit v_limit
     for update of a skip locked
  )
  update public.audit_events a
     set actor_email = src.email,
         metadata = coalesce(a.metadata, '{}'::jsonb)
                    || jsonb_build_object('backfill', 'actor_email_pr6')
    from (
      select a2.id, m.email
        from candidates c
        join public.audit_events a2
          on a2.id = c.id
         and a2.org_id = p_org_id
        join public.approval_requests r
          on r.id = public.audit_pr6_approval_uuid(a2.metadata)
         and r.org_id = p_org_id
        join public.org_members m
          on m.id = r.resolved_by
         and m.org_id = p_org_id
       where public.audit_pr6_actor_email_empty(a2.actor_email)
         and public.audit_pr6_is_rfc_email(m.email)
    ) src
   where a.id = src.id
     and a.org_id = p_org_id
     and public.audit_pr6_actor_email_empty(a.actor_email);

  get diagnostics n = row_count;
  return n;
end
$fn$;

create or replace function public.rollback_audit_actor_email_pr6_batch(
  p_org_id uuid,
  p_limit integer default 500
) returns integer
language plpgsql
security invoker
set search_path = pg_catalog, public
as $fn$
declare
  v_limit integer;
  n integer;
begin
  if p_org_id is null then
    raise exception 'org_id_required';
  end if;
  v_limit := case
    when p_limit is null or p_limit < 1 then 500
    when p_limit > 2000 then 2000
    else p_limit
  end;

  with candidates as (
    select a.id
      from public.audit_events a
     where a.org_id = p_org_id
       and a.metadata->>'backfill' = 'actor_email_pr6'
     order by a.created_at, a.id
     limit v_limit
     for update of a skip locked
  )
  update public.audit_events a
     set actor_email = null,
         metadata = coalesce(a.metadata, '{}'::jsonb) - 'backfill'
    from candidates c
   where a.id = c.id
     and a.org_id = p_org_id
     and a.metadata->>'backfill' = 'actor_email_pr6';

  get diagnostics n = row_count;
  return n;
end
$fn$;

create or replace procedure public.backfill_audit_actor_email_pr6_org(
  p_org_id uuid,
  p_limit integer default 500
)
language plpgsql
security invoker
set search_path = pg_catalog, public
as $proc$
declare
  n integer;
begin
  if p_org_id is null then
    raise exception 'org_id_required';
  end if;
  loop
    n := public.backfill_audit_actor_email_pr6_batch(p_org_id, p_limit);
    commit;
    exit when n = 0;
  end loop;
end
$proc$;

create or replace procedure public.rollback_audit_actor_email_pr6_org(
  p_org_id uuid,
  p_limit integer default 500
)
language plpgsql
security invoker
set search_path = pg_catalog, public
as $proc$
declare
  n integer;
begin
  if p_org_id is null then
    raise exception 'org_id_required';
  end if;
  loop
    n := public.rollback_audit_actor_email_pr6_batch(p_org_id, p_limit);
    commit;
    exit when n = 0;
  end loop;
end
$proc$;

create or replace procedure public.backfill_audit_actor_email_pr6_orgs(
  p_org_ids uuid[],
  p_limit integer default 500
)
language plpgsql
security invoker
set search_path = pg_catalog, public
as $proc$
declare
  oid uuid;
  n integer;
begin
  if p_org_ids is null or cardinality(p_org_ids) = 0 then
    return;
  end if;
  foreach oid in array p_org_ids loop
    if oid is null then
      continue;
    end if;
    loop
      n := public.backfill_audit_actor_email_pr6_batch(oid, p_limit);
      commit;
      exit when n = 0;
    end loop;
  end loop;
end
$proc$;

create or replace procedure public.rollback_audit_actor_email_pr6_orgs(
  p_org_ids uuid[],
  p_limit integer default 500
)
language plpgsql
security invoker
set search_path = pg_catalog, public
as $proc$
declare
  oid uuid;
  n integer;
begin
  if p_org_ids is null or cardinality(p_org_ids) = 0 then
    return;
  end if;
  foreach oid in array p_org_ids loop
    if oid is null then
      continue;
    end if;
    loop
      n := public.rollback_audit_actor_email_pr6_batch(oid, p_limit);
      commit;
      exit when n = 0;
    end loop;
  end loop;
end
$proc$;

revoke all on function public.audit_pr6_approval_uuid(jsonb) from public, anon, authenticated;
revoke all on function public.audit_pr6_is_rfc_email(text) from public, anon, authenticated;
revoke all on function public.audit_pr6_actor_email_empty(text) from public, anon, authenticated;
revoke all on function public.backfill_audit_actor_email_pr6_batch(uuid, integer) from public, anon, authenticated;
revoke all on function public.rollback_audit_actor_email_pr6_batch(uuid, integer) from public, anon, authenticated;
revoke all on procedure public.backfill_audit_actor_email_pr6_org(uuid, integer) from public, anon, authenticated;
revoke all on procedure public.rollback_audit_actor_email_pr6_org(uuid, integer) from public, anon, authenticated;
revoke all on procedure public.backfill_audit_actor_email_pr6_orgs(uuid[], integer) from public, anon, authenticated;
revoke all on procedure public.rollback_audit_actor_email_pr6_orgs(uuid[], integer) from public, anon, authenticated;

grant execute on function public.audit_pr6_approval_uuid(jsonb) to service_role;
grant execute on function public.audit_pr6_is_rfc_email(text) to service_role;
grant execute on function public.audit_pr6_actor_email_empty(text) to service_role;
grant execute on function public.backfill_audit_actor_email_pr6_batch(uuid, integer) to service_role;
grant execute on function public.rollback_audit_actor_email_pr6_batch(uuid, integer) to service_role;
grant execute on procedure public.backfill_audit_actor_email_pr6_org(uuid, integer) to service_role;
grant execute on procedure public.rollback_audit_actor_email_pr6_org(uuid, integer) to service_role;
grant execute on procedure public.backfill_audit_actor_email_pr6_orgs(uuid[], integer) to service_role;
grant execute on procedure public.rollback_audit_actor_email_pr6_orgs(uuid[], integer) to service_role;

commit;

-- ROLLBACK (down)
--   begin;
--   drop procedure if exists public.rollback_audit_actor_email_pr6_orgs(uuid[], integer);
--   drop procedure if exists public.backfill_audit_actor_email_pr6_orgs(uuid[], integer);
--   drop procedure if exists public.rollback_audit_actor_email_pr6_org(uuid, integer);
--   drop procedure if exists public.backfill_audit_actor_email_pr6_org(uuid, integer);
--   drop function if exists public.rollback_audit_actor_email_pr6_batch(uuid, integer);
--   drop function if exists public.backfill_audit_actor_email_pr6_batch(uuid, integer);
--   drop function if exists public.audit_pr6_actor_email_empty(text);
--   drop function if exists public.audit_pr6_is_rfc_email(text);
--   drop function if exists public.audit_pr6_approval_uuid(jsonb);
--   commit;
-- Roll back filled rows first with the verification rollback SQL
-- (metadata.backfill = 'actor_email_pr6' only). Then drop helpers.
-- END ROLLBACK

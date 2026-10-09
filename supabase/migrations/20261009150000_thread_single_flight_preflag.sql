-- Thread single-flight: fixes required before THREAD_SINGLE_FLIGHT_ENABLED goes
-- ON (木村 2026-10-09 #286 review, items 2 and 5). Additive and re-applicable.
-- Apply AFTER 20261009100000_thread_single_flight.sql and BEFORE the flag goes ON.
--
-- 1. thread_self_posts.job_first_micros: the time of the job's FIRST post in
--    the thread. The application exempts the caller's own same-job post from
--    "the thread moved on" only within 10 minutes of it, so reusing a jobId
--    cannot switch the check off. record_thread_self_post (same signature)
--    keeps it while the same job key posts again; a different job key or no
--    job key re-anchors it to the new post. Rows written before this
--    migration have NULL = never exempt (stricter).
-- 2. close_approval_without_send(id, org, from[], to, patch) → jsonb row | null:
--    pending|approved → superseded|expired in ONE UPDATE that also merges
--    metadata.closedWithoutSend = patch + {status, at = resolved_at}. Either
--    both land or neither does (the two separate writes before could leave
--    "superseded" with no reason). Conditional on org + current status; null
--    when the status moved or the id belongs to another org.
-- 3. thread_send_leases.job_key + acquire_thread_send_lease(org, key, employee,
--    lease, ttl, job_key) (6 args; #286's 5-arg version is left as is): a held
--    lease is busy, except for the SAME job (same employee + job key) re-entering
--    its own lease while that job's first post in the thread
--    (thread_self_posts.job_first_micros) is at most 10 minutes old (木村 #293
--    decision 1: caller-delivered replies hold the lease for its TTL; a
--    multi-part reply of the same job must not wait). Re-entry replaces the
--    lease id and restarts the TTL.
-- Functions: security invoker, fixed search_path, EXECUTE for service_role only.
begin;

-- 1 ----------------------------------------------------------------------------
alter table public.thread_self_posts add column if not exists job_first_micros bigint;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'thread_self_posts_job_first_micros_check'
                 and conrelid = 'public.thread_self_posts'::regclass) then
    alter table public.thread_self_posts add constraint thread_self_posts_job_first_micros_check
      check (job_first_micros is null or job_first_micros > 0);
  end if;
end $$;

create or replace function public.record_thread_self_post(
  p_org uuid, p_employee uuid, p_thread_key text, p_message_micros bigint, p_job_key text)
returns boolean language plpgsql security invoker set search_path = pg_catalog, public as $$
begin
  if p_org is null or p_employee is null
    or p_thread_key is null or p_thread_key !~ '^[0-9a-f]{64}$'
    or p_message_micros is null or p_message_micros <= 0
    or (p_job_key is not null and p_job_key !~ '^[0-9a-f]{64}$') then
    return false;
  end if;
  if not exists (select 1 from public.employees e where e.id = p_employee and e.org_id = p_org) then
    return false;
  end if;
  delete from public.thread_self_posts
    where org_id = p_org and updated_at < now() - interval '30 days';
  insert into public.thread_self_posts as p (org_id, employee_id, thread_key, message_micros, job_key, job_first_micros, updated_at)
    values (p_org, p_employee, p_thread_key, p_message_micros, p_job_key, p_message_micros, now())
    on conflict (org_id, employee_id, thread_key) do update
      set message_micros = excluded.message_micros,
          job_key = excluded.job_key,
          job_first_micros = case
            when excluded.job_key is not null and p.job_key = excluded.job_key
              then coalesce(p.job_first_micros, p.message_micros)
            else excluded.message_micros
          end,
          updated_at = now()
      where p.message_micros < excluded.message_micros;
  return true;
end $$;

-- 2 ----------------------------------------------------------------------------
create or replace function public.close_approval_without_send(
  p_id uuid, p_org uuid, p_from text[], p_to text, p_patch jsonb)
returns jsonb language plpgsql security invoker set search_path = pg_catalog, public as $$
declare
  a public.approval_requests;
  t timestamptz := now();
begin
  if p_id is null or p_org is null or p_from is null or cardinality(p_from) = 0
    or not (p_from <@ array['pending', 'approved']::text[])
    or p_to is null or p_to not in ('superseded', 'expired')
    or p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    return null;
  end if;
  update public.approval_requests r
    set status = p_to,
        resolved_at = t,
        metadata = coalesce(r.metadata, '{}'::jsonb) || jsonb_build_object(
          'closedWithoutSend', p_patch || jsonb_build_object('status', p_to, 'at', t))
    where r.id = p_id and r.org_id = p_org and r.status = any (p_from)
    returning * into a;
  if not found then return null; end if;
  return to_jsonb(a);
end $$;

-- 3 ----------------------------------------------------------------------------
alter table public.thread_send_leases add column if not exists job_key text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'thread_send_leases_job_key_check'
                 and conrelid = 'public.thread_send_leases'::regclass) then
    alter table public.thread_send_leases add constraint thread_send_leases_job_key_check
      check (job_key is null or job_key ~ '^[0-9a-f]{64}$');
  end if;
end $$;

create or replace function public.acquire_thread_send_lease(
  p_org uuid, p_thread_key text, p_employee uuid, p_lease uuid, p_ttl_seconds integer, p_job_key text)
returns jsonb language plpgsql security invoker set search_path = pg_catalog, public as $$
declare
  r public.thread_send_leases;
  now_micros bigint := (extract(epoch from clock_timestamp()) * 1000000)::bigint;
begin
  if p_org is null or p_employee is null or p_lease is null
    or p_thread_key is null or p_thread_key !~ '^[0-9a-f]{64}$'
    or p_ttl_seconds is null or p_ttl_seconds < 5 or p_ttl_seconds > 600
    or (p_job_key is not null and p_job_key !~ '^[0-9a-f]{64}$') then
    return jsonb_build_object('state', 'denied');
  end if;
  if not exists (select 1 from public.employees e where e.id = p_employee and e.org_id = p_org) then
    return jsonb_build_object('state', 'denied');
  end if;
  delete from public.thread_send_leases
    where org_id = p_org and expires_at < now() - interval '1 hour';
  insert into public.thread_send_leases as l (org_id, thread_key, lease_id, employee_id, acquired_at, expires_at, job_key)
    values (p_org, p_thread_key, p_lease, p_employee, now(), now() + make_interval(secs => p_ttl_seconds), p_job_key)
    on conflict (org_id, thread_key) do update
      set lease_id = excluded.lease_id, employee_id = excluded.employee_id,
          acquired_at = excluded.acquired_at, expires_at = excluded.expires_at, job_key = excluded.job_key
      where l.expires_at <= now()
         or (excluded.job_key is not null
             and l.employee_id = excluded.employee_id
             and l.job_key = excluded.job_key
             and exists (
               select 1 from public.thread_self_posts p
               where p.org_id = l.org_id and p.employee_id = l.employee_id and p.thread_key = l.thread_key
                 and p.job_key = excluded.job_key
                 and p.job_first_micros is not null
                 and now_micros - p.job_first_micros <= 600000000))
    returning * into r;
  if found and r.lease_id = p_lease then
    return jsonb_build_object('state', 'acquired', 'expires_at', r.expires_at);
  end if;
  select * into r from public.thread_send_leases where org_id = p_org and thread_key = p_thread_key;
  return jsonb_build_object(
    'state', 'busy',
    'expires_at', r.expires_at,
    'retry_after_seconds', greatest(1, ceil(extract(epoch from (coalesce(r.expires_at, now()) - now())))::integer));
end $$;

revoke all on function public.acquire_thread_send_lease(uuid, text, uuid, uuid, integer, text) from public, anon, authenticated;
grant execute on function public.acquire_thread_send_lease(uuid, text, uuid, uuid, integer, text) to service_role;
revoke all on function public.record_thread_self_post(uuid, uuid, text, bigint, text) from public, anon, authenticated;
grant execute on function public.record_thread_self_post(uuid, uuid, text, bigint, text) to service_role;
revoke all on function public.close_approval_without_send(uuid, uuid, text[], text, jsonb) from public, anon, authenticated;
grant execute on function public.close_approval_without_send(uuid, uuid, text[], text, jsonb) to service_role;

-- #293 review item 2: the latest wake Staffpass DELIVERED to an employee in a
-- thread is that employee's read point when a reply carries no readThroughTs
-- and no inbound ts. Hash-only thread key (no channel id / text), per org ×
-- employee × thread, forward-only, 30-day cleanup like thread_self_posts.
create table if not exists public.thread_wake_points (
  org_id uuid not null references public.orgs(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  thread_key text not null check (thread_key ~ '^[0-9a-f]{64}$'),
  wake_micros bigint not null check (wake_micros > 0),
  updated_at timestamptz not null default now(),
  primary key (org_id, employee_id, thread_key)
);
create index if not exists thread_wake_points_updated_idx on public.thread_wake_points (org_id, updated_at);
alter table public.thread_wake_points enable row level security;
revoke all on table public.thread_wake_points from public, anon, authenticated;
grant select, insert, update, delete on table public.thread_wake_points to service_role;

create or replace function public.record_thread_wake_point(
  p_org uuid, p_employee uuid, p_thread_key text, p_wake_micros bigint)
returns boolean language plpgsql security invoker set search_path = pg_catalog, public as $$
begin
  if p_org is null or p_employee is null
    or p_thread_key is null or p_thread_key !~ '^[0-9a-f]{64}$'
    or p_wake_micros is null or p_wake_micros <= 0 then
    return false;
  end if;
  if not exists (select 1 from public.employees e where e.id = p_employee and e.org_id = p_org) then
    return false;
  end if;
  delete from public.thread_wake_points
    where org_id = p_org and updated_at < now() - interval '30 days';
  insert into public.thread_wake_points as w (org_id, employee_id, thread_key, wake_micros, updated_at)
    values (p_org, p_employee, p_thread_key, p_wake_micros, now())
    on conflict (org_id, employee_id, thread_key) do update
      set wake_micros = excluded.wake_micros, updated_at = now()
      where w.wake_micros < excluded.wake_micros;
  return true;
end $$;
revoke all on function public.record_thread_wake_point(uuid, uuid, text, bigint) from public, anon, authenticated;
grant execute on function public.record_thread_wake_point(uuid, uuid, text, bigint) to service_role;

commit;

-- ROLLBACK (down) — turn THREAD_SINGLE_FLIGHT_ENABLED off first (with the flag
-- ON and this rolled back, every guarded post fails closed: the app calls the
-- 6-arg acquire). The app falls
-- back to one PostgREST UPDATE for the close when the RPC is missing; with the
-- flag ON and the column gone the thread guard fails closed. Restores #286's
-- record_thread_self_post. Same statements as
-- supabase/verification/20261009150000_thread_single_flight_preflag_rollback.sql:
--   begin;
--   drop function if exists public.record_thread_wake_point(uuid, uuid, text, bigint);
--   drop table if exists public.thread_wake_points;
--   drop function if exists public.close_approval_without_send(uuid, uuid, text[], text, jsonb);
--   drop function if exists public.acquire_thread_send_lease(uuid, text, uuid, uuid, integer, text);
--   alter table public.thread_send_leases drop constraint if exists thread_send_leases_job_key_check;
--   alter table public.thread_send_leases drop column if exists job_key;
--   create or replace function public.record_thread_self_post(
--     p_org uuid, p_employee uuid, p_thread_key text, p_message_micros bigint, p_job_key text)
--   returns boolean language plpgsql security invoker set search_path = pg_catalog, public as $f$
--   begin
--     if p_org is null or p_employee is null
--       or p_thread_key is null or p_thread_key !~ '^[0-9a-f]{64}$'
--       or p_message_micros is null or p_message_micros <= 0
--       or (p_job_key is not null and p_job_key !~ '^[0-9a-f]{64}$') then
--       return false;
--     end if;
--     if not exists (select 1 from public.employees e where e.id = p_employee and e.org_id = p_org) then
--       return false;
--     end if;
--     delete from public.thread_self_posts
--       where org_id = p_org and updated_at < now() - interval '30 days';
--     insert into public.thread_self_posts as p (org_id, employee_id, thread_key, message_micros, job_key, updated_at)
--       values (p_org, p_employee, p_thread_key, p_message_micros, p_job_key, now())
--       on conflict (org_id, employee_id, thread_key) do update
--         set message_micros = excluded.message_micros, job_key = excluded.job_key, updated_at = now()
--         where p.message_micros < excluded.message_micros;
--     return true;
--   end $f$;
--   revoke all on function public.record_thread_self_post(uuid, uuid, text, bigint, text) from public, anon, authenticated;
--   grant execute on function public.record_thread_self_post(uuid, uuid, text, bigint, text) to service_role;
--   alter table public.thread_self_posts drop constraint if exists thread_self_posts_job_first_micros_check;
--   alter table public.thread_self_posts drop column if exists job_first_micros;
--   commit;
-- END ROLLBACK

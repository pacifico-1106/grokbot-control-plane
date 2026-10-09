-- Thread single-flight (木村 2026-10-09 A, 八坂 GO; triage #2). Additive and
-- re-applicable. Apply BEFORE setting THREAD_SINGLE_FLIGHT_ENABLED=true; with
-- the flag OFF the application never touches anything added here.
--
-- 1. thread_send_leases: one row per org × thread key while a conversation post
--    to that thread is in flight. thread_key = keyed HMAC (64 hex) of the
--    org-scoped conversation; no channel / thread id, no text. RLS on, no
--    policy; anon / authenticated have no access; service_role only.
-- 2. thread_self_posts: per org × employee × thread key, the AI employee's latest
--    post time in µs (Slack ts precision) + keyed job hash. Same access rules.
--    The application reads all AI employees of the SAME org for one thread key
--    (other AI employees' posts count; human posts are never recorded).
-- 3. acquire_thread_send_lease(org, thread_key, employee, lease, ttl) → jsonb
--    {state: acquired | busy | denied, expires_at, retry_after_seconds}.
--    Atomic: inserts, or takes over ONLY an expired row of the same org × key
--    (INSERT … ON CONFLICT … DO UPDATE … WHERE expired). The employee must
--    belong to the org (denied otherwise). Expired leases of the org older than
--    1 h are deleted opportunistically.
-- 4. release_thread_send_lease(org, thread_key, lease) → boolean: deletes only
--    the holder's row (org + key + lease id), so an old holder can never
--    release a lease someone else re-took after expiry.
-- 5. record_thread_self_post(org, employee, thread_key, micros, job_key) →
--    boolean: upsert that only moves forward; employee must belong to the org.
--    Rows of the org not updated for 30 days are deleted opportunistically.
-- All functions: security invoker, fixed search_path, EXECUTE for service_role only.
begin;

-- 1 ----------------------------------------------------------------------------
create table if not exists public.thread_send_leases (
  org_id uuid not null references public.orgs(id) on delete cascade,
  thread_key text not null check (thread_key ~ '^[0-9a-f]{64}$'),
  lease_id uuid not null,
  employee_id uuid not null references public.employees(id) on delete cascade,
  acquired_at timestamptz not null default now(),
  expires_at timestamptz not null,
  primary key (org_id, thread_key)
);
create index if not exists thread_send_leases_expires_idx on public.thread_send_leases (org_id, expires_at);
alter table public.thread_send_leases enable row level security;
revoke all on table public.thread_send_leases from public, anon, authenticated;
grant select, insert, update, delete on table public.thread_send_leases to service_role;

-- 2 ----------------------------------------------------------------------------
create table if not exists public.thread_self_posts (
  org_id uuid not null references public.orgs(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  thread_key text not null check (thread_key ~ '^[0-9a-f]{64}$'),
  message_micros bigint not null check (message_micros > 0),
  job_key text check (job_key is null or job_key ~ '^[0-9a-f]{64}$'),
  updated_at timestamptz not null default now(),
  primary key (org_id, employee_id, thread_key)
);
create index if not exists thread_self_posts_updated_idx on public.thread_self_posts (org_id, updated_at);
-- "Already replied after the read point" reads every AI employee of the org in one
-- thread (木村 #286 decision 4): org × thread key, newest first.
create index if not exists thread_self_posts_thread_idx on public.thread_self_posts (org_id, thread_key, message_micros desc);
alter table public.thread_self_posts enable row level security;
revoke all on table public.thread_self_posts from public, anon, authenticated;
grant select, insert, update, delete on table public.thread_self_posts to service_role;

-- 3 ----------------------------------------------------------------------------
create or replace function public.acquire_thread_send_lease(
  p_org uuid, p_thread_key text, p_employee uuid, p_lease uuid, p_ttl_seconds integer)
returns jsonb language plpgsql security invoker set search_path = pg_catalog, public as $$
declare
  r public.thread_send_leases;
begin
  if p_org is null or p_employee is null or p_lease is null
    or p_thread_key is null or p_thread_key !~ '^[0-9a-f]{64}$'
    or p_ttl_seconds is null or p_ttl_seconds < 5 or p_ttl_seconds > 600 then
    return jsonb_build_object('state', 'denied');
  end if;
  if not exists (select 1 from public.employees e where e.id = p_employee and e.org_id = p_org) then
    return jsonb_build_object('state', 'denied');
  end if;
  delete from public.thread_send_leases
    where org_id = p_org and expires_at < now() - interval '1 hour';
  insert into public.thread_send_leases as l (org_id, thread_key, lease_id, employee_id, acquired_at, expires_at)
    values (p_org, p_thread_key, p_lease, p_employee, now(), now() + make_interval(secs => p_ttl_seconds))
    on conflict (org_id, thread_key) do update
      set lease_id = excluded.lease_id, employee_id = excluded.employee_id,
          acquired_at = excluded.acquired_at, expires_at = excluded.expires_at
      where l.expires_at <= now()
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

-- 4 ----------------------------------------------------------------------------
create or replace function public.release_thread_send_lease(p_org uuid, p_thread_key text, p_lease uuid)
returns boolean language plpgsql security invoker set search_path = pg_catalog, public as $$
begin
  if p_org is null or p_lease is null or p_thread_key is null then return false; end if;
  delete from public.thread_send_leases
    where org_id = p_org and thread_key = p_thread_key and lease_id = p_lease;
  return found;
end $$;

-- 5 ----------------------------------------------------------------------------
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
  insert into public.thread_self_posts as p (org_id, employee_id, thread_key, message_micros, job_key, updated_at)
    values (p_org, p_employee, p_thread_key, p_message_micros, p_job_key, now())
    on conflict (org_id, employee_id, thread_key) do update
      set message_micros = excluded.message_micros, job_key = excluded.job_key, updated_at = now()
      where p.message_micros < excluded.message_micros;
  return true;
end $$;

revoke all on function public.acquire_thread_send_lease(uuid, text, uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.release_thread_send_lease(uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.record_thread_self_post(uuid, uuid, text, bigint, text) from public, anon, authenticated;
grant execute on function public.acquire_thread_send_lease(uuid, text, uuid, uuid, integer) to service_role;
grant execute on function public.release_thread_send_lease(uuid, text, uuid) to service_role;
grant execute on function public.record_thread_self_post(uuid, uuid, text, bigint, text) to service_role;

commit;

-- ROLLBACK (down) — turn THREAD_SINGLE_FLIGHT_ENABLED off first (with the flag
-- ON and this rolled back every guarded post fails closed with
-- thread_guard_unavailable). Same statements as
-- supabase/verification/20261009100000_thread_single_flight_rollback.sql:
--   begin;
--   drop function if exists public.record_thread_self_post(uuid, uuid, text, bigint, text);
--   drop function if exists public.release_thread_send_lease(uuid, text, uuid);
--   drop function if exists public.acquire_thread_send_lease(uuid, text, uuid, uuid, integer);
--   drop table if exists public.thread_self_posts;
--   drop table if exists public.thread_send_leases;
--   commit;
-- END ROLLBACK

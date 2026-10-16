-- AI→AI Slack wake allowlist + per-thread cap/stop (八坂 GO 2026-10-16).
-- Additive. Not applied to production by this PR. Flags default OFF:
--   AI_PEER_WAKE_ALLOWLIST_ENABLED
--   AI_PEER_WAKE_THREAD_GUARD_ENABLED
-- With both flags OFF nothing here is read or written.
--
-- 1. ai_peer_wake_allowlist: org-scoped A→B pairs (optional channel; '' = all).
--    Both employees must belong to the same org (trigger). created_by is a
--    human member only. RLS on, no policy, service_role only.
-- 2. ai_peer_wake_threads: cap counter + human stop per org × channel ×
--    (thread_ts | root window). stop_ref is the Slack-button token (org-scoped).
-- 3. claim_ai_peer_wake / stop_ai_peer_wake_thread / resume_ai_peer_wake_thread
--    — the only writers of the thread table. EXECUTE service_role only.
-- security invoker, search_path = pg_catalog, public.
begin;
set local lock_timeout = '5s';

create table if not exists public.ai_peer_wake_allowlist (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  from_employee_id uuid not null references public.employees(id) on delete cascade,
  to_employee_id uuid not null references public.employees(id) on delete cascade,
  slack_channel_id text not null default '' check (
    slack_channel_id = '' or slack_channel_id ~ '^[CGD][A-Za-z0-9_]{1,32}$'),
  enabled boolean not null default true,
  created_by text not null check (created_by ~ '^member:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ai_peer_wake_allowlist_no_self check (from_employee_id <> to_employee_id),
  constraint ai_peer_wake_allowlist_pair_uidx unique (org_id, from_employee_id, to_employee_id, slack_channel_id)
);
create index if not exists ai_peer_wake_allowlist_org_idx
  on public.ai_peer_wake_allowlist (org_id);

alter table public.ai_peer_wake_allowlist enable row level security;
revoke all on table public.ai_peer_wake_allowlist from public, anon, authenticated;
grant select, insert, update, delete on table public.ai_peer_wake_allowlist to service_role;

create or replace function public.ai_peer_wake_allowlist_guard() returns trigger
language plpgsql security invoker set search_path = pg_catalog, public as $g$
begin
  if tg_op = 'DELETE' then
    if pg_trigger_depth() > 1 then return old; end if;
  end if;
  if tg_op = 'INSERT' or tg_op = 'UPDATE' then
    if not exists (select 1 from public.employees e where e.id = new.from_employee_id and e.org_id = new.org_id) then
      raise exception 'ai_peer_wake_allowlist_cross_org';
    end if;
    if not exists (select 1 from public.employees e where e.id = new.to_employee_id and e.org_id = new.org_id) then
      raise exception 'ai_peer_wake_allowlist_cross_org';
    end if;
  end if;
  return coalesce(new, old);
end $g$;
drop trigger if exists ai_peer_wake_allowlist_guard on public.ai_peer_wake_allowlist;
create trigger ai_peer_wake_allowlist_guard
  before insert or update or delete on public.ai_peer_wake_allowlist
  for each row execute function public.ai_peer_wake_allowlist_guard();
revoke all on function public.ai_peer_wake_allowlist_guard() from public, anon, authenticated;
grant execute on function public.ai_peer_wake_allowlist_guard() to service_role;

create table if not exists public.ai_peer_wake_threads (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  slack_team_id text not null check (slack_team_id ~ '^[TE][A-Za-z0-9_]{1,32}$'),
  slack_channel_id text not null check (slack_channel_id ~ '^[CGD][A-Za-z0-9_]{1,32}$'),
  thread_ts text check (thread_ts is null or thread_ts ~ '^[0-9]{9,12}\.[0-9]{1,8}$'),
  window_start timestamptz,
  thread_key text not null check (char_length(thread_key) between 1 and 80),
  wake_count integer not null default 0 check (wake_count >= 0 and wake_count <= 10000),
  cap integer not null default 4 check (cap >= 1 and cap <= 20),
  stop_ref text not null check (stop_ref ~ '^[0-9a-f]{16}$'),
  stopped_at timestamptz,
  stopped_by text check (stopped_by is null or stopped_by ~ '^member:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  capped_notified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ai_peer_wake_threads_key_check check (
    (thread_ts is not null and window_start is null)
    or (thread_ts is null and window_start is not null)
  ),
  constraint ai_peer_wake_threads_stop_shape check (
    (stopped_at is null) = (stopped_by is null)
  ),
  constraint ai_peer_wake_threads_org_key unique (org_id, slack_channel_id, thread_key)
);
create unique index if not exists ai_peer_wake_threads_stop_ref_uidx
  on public.ai_peer_wake_threads (org_id, stop_ref);
create index if not exists ai_peer_wake_threads_org_updated_idx
  on public.ai_peer_wake_threads (org_id, updated_at desc);

alter table public.ai_peer_wake_threads enable row level security;
revoke all on table public.ai_peer_wake_threads from public, anon, authenticated;
grant select, insert, update, delete on table public.ai_peer_wake_threads to service_role;

create or replace function public.claim_ai_peer_wake(
  p_org uuid, p_team text, p_channel text, p_thread_ts text, p_event_ts text, p_cap integer, p_window_seconds integer
) returns jsonb
language plpgsql security invoker set search_path = pg_catalog, public as $$
declare
  r public.ai_peer_wake_threads%rowtype;
  v_window timestamptz;
  v_key text;
  v_ref text;
begin
  if p_org is null
    or p_team is null or p_team !~ '^[TE][A-Za-z0-9_]{1,32}$'
    or p_channel is null or p_channel !~ '^[CGD][A-Za-z0-9_]{1,32}$'
    or (p_thread_ts is not null and p_thread_ts !~ '^[0-9]{9,12}\.[0-9]{1,8}$')
    or p_event_ts is null or p_event_ts !~ '^[0-9]{9,12}\.[0-9]{1,8}$'
    or p_cap is null or p_cap < 1 or p_cap > 20
    or p_window_seconds is null or p_window_seconds < 60 or p_window_seconds > 86400 then
    return jsonb_build_object('state', 'denied');
  end if;
  if not exists (select 1 from public.orgs o where o.id = p_org) then
    return jsonb_build_object('state', 'denied');
  end if;
  if p_thread_ts is not null then
    v_key := p_thread_ts;
    v_window := null;
  else
    v_window := to_timestamp((split_part(p_event_ts, '.', 1)::bigint / p_window_seconds) * p_window_seconds);
    v_key := 'w:' || (extract(epoch from v_window))::bigint::text;
  end if;

  select * into r from public.ai_peer_wake_threads
    where org_id = p_org and slack_channel_id = p_channel and thread_key = v_key
    for update;
  if not found then
    v_ref := encode(gen_random_bytes(8), 'hex');
    insert into public.ai_peer_wake_threads as t (
      org_id, slack_team_id, slack_channel_id, thread_ts, window_start, thread_key,
      wake_count, cap, stop_ref)
    values (p_org, p_team, p_channel, p_thread_ts, v_window, v_key, 1, p_cap, v_ref)
    on conflict (org_id, slack_channel_id, thread_key) do nothing
    returning * into r;
    if found then
      return jsonb_build_object('state', 'allowed', 'count', 1, 'threadId', r.id, 'stopRef', r.stop_ref, 'notify', false);
    end if;
    select * into r from public.ai_peer_wake_threads
      where org_id = p_org and slack_channel_id = p_channel and thread_key = v_key
      for update;
    if not found then
      return jsonb_build_object('state', 'denied');
    end if;
  end if;

  if r.stopped_at is not null then
    return jsonb_build_object('state', 'stopped', 'count', r.wake_count, 'threadId', r.id, 'stopRef', r.stop_ref, 'notify', false);
  end if;
  if r.wake_count >= r.cap then
    if r.capped_notified_at is null then
      update public.ai_peer_wake_threads
        set capped_notified_at = now(), updated_at = now()
        where id = r.id and capped_notified_at is null;
      return jsonb_build_object('state', 'capped', 'count', r.wake_count, 'threadId', r.id, 'stopRef', r.stop_ref, 'notify', true);
    end if;
    return jsonb_build_object('state', 'capped', 'count', r.wake_count, 'threadId', r.id, 'stopRef', r.stop_ref, 'notify', false);
  end if;

  update public.ai_peer_wake_threads
    set wake_count = wake_count + 1, cap = p_cap, slack_team_id = p_team, updated_at = now()
    where id = r.id
    returning * into r;
  return jsonb_build_object('state', 'allowed', 'count', r.wake_count, 'threadId', r.id, 'stopRef', r.stop_ref, 'notify', false);
end;
$$;

create or replace function public.stop_ai_peer_wake_thread(p_org uuid, p_id uuid, p_stopped_by text)
returns jsonb
language plpgsql security invoker set search_path = pg_catalog, public as $$
declare
  r public.ai_peer_wake_threads%rowtype;
begin
  if p_org is null or p_id is null
    or p_stopped_by is null
    or p_stopped_by !~ '^member:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return jsonb_build_object('state', 'denied', 'reason', 'actor_not_member');
  end if;
  select * into r from public.ai_peer_wake_threads
    where id = p_id and org_id = p_org
    for update;
  if not found then
    return jsonb_build_object('state', 'not_found');
  end if;
  if r.stopped_at is not null then
    return jsonb_build_object('state', 'already_stopped', 'thread', to_jsonb(r));
  end if;
  update public.ai_peer_wake_threads
    set stopped_at = now(), stopped_by = p_stopped_by, updated_at = now()
    where id = r.id
    returning * into r;
  return jsonb_build_object('state', 'stopped', 'thread', to_jsonb(r));
end;
$$;

create or replace function public.resume_ai_peer_wake_thread(p_org uuid, p_id uuid, p_resumed_by text)
returns jsonb
language plpgsql security invoker set search_path = pg_catalog, public as $$
declare
  r public.ai_peer_wake_threads%rowtype;
begin
  if p_org is null or p_id is null
    or p_resumed_by is null
    or p_resumed_by !~ '^member:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return jsonb_build_object('state', 'denied', 'reason', 'actor_not_member');
  end if;
  select * into r from public.ai_peer_wake_threads
    where id = p_id and org_id = p_org
    for update;
  if not found then
    return jsonb_build_object('state', 'not_found');
  end if;
  if r.stopped_at is null then
    return jsonb_build_object('state', 'not_stopped', 'thread', to_jsonb(r));
  end if;
  update public.ai_peer_wake_threads
    set stopped_at = null, stopped_by = null, wake_count = 0, capped_notified_at = null, updated_at = now()
    where id = r.id
    returning * into r;
  return jsonb_build_object('state', 'resumed', 'thread', to_jsonb(r));
end;
$$;

revoke all on function public.claim_ai_peer_wake(uuid, text, text, text, text, integer, integer) from public, anon, authenticated;
revoke all on function public.stop_ai_peer_wake_thread(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.resume_ai_peer_wake_thread(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.claim_ai_peer_wake(uuid, text, text, text, text, integer, integer) to service_role;
grant execute on function public.stop_ai_peer_wake_thread(uuid, uuid, text) to service_role;
grant execute on function public.resume_ai_peer_wake_thread(uuid, uuid, text) to service_role;

comment on table public.ai_peer_wake_allowlist is
  'Org-scoped AI→AI Slack wake allowlist (A→B, optional channel). Fail-closed when the flag is ON. Human member created_by only.';
comment on table public.ai_peer_wake_threads is
  'Per-thread AI→AI wake cap + human stop. stop_ref is the Slack-button token (org-scoped).';

commit;

-- ROLLBACK (down) — turn AI_PEER_WAKE_ALLOWLIST_ENABLED and
-- AI_PEER_WAKE_THREAD_GUARD_ENABLED off first. Drops the three RPCs and the
-- two tables only. Same statements as
-- supabase/verification/20261016100000_ai_peer_wake_guard_rollback.sql.
-- Run as one transaction:
--   begin;
--   drop function if exists public.resume_ai_peer_wake_thread(uuid, uuid, text);
--   drop function if exists public.stop_ai_peer_wake_thread(uuid, uuid, text);
--   drop function if exists public.claim_ai_peer_wake(uuid, text, text, text, text, integer, integer);
--   drop table if exists public.ai_peer_wake_threads;
--   drop table if exists public.ai_peer_wake_allowlist;
--   drop function if exists public.ai_peer_wake_allowlist_guard();
--   commit;
-- END ROLLBACK

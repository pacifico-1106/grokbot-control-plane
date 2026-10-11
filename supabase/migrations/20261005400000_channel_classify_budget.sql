-- PR-B follow-up H1 (木村 2026-10-05): per-org hourly budget for automatic
-- channel-classification proposals and stuck notices. Additive and
-- re-applicable; depends on 20261005200000 only through the same flags.
-- Apply BEFORE setting CHANNEL_CLASSIFY_PROPOSALS_ENABLED /
-- CHANNEL_STUCK_NOTIFY_ENABLED. With both flags OFF nothing here is touched.
--
-- 1. channel_classify_budget_windows: one row per org × budget key
--    ('proposals' | 'notices'). Counts only: org id, key, window start,
--    used / overflow counters, whether the one summary notice was sent.
--    No channel id, no content. RLS on, no policy, service_role only.
-- 2. take_channel_classify_budget(org, key, window_seconds, max) → jsonb
--    {state: allowed | over_first | over | denied, used, overflow}.
--    Atomic per row (row lock); over_first is returned exactly once per
--    window so the caller sends exactly one summary notice.
--    security invoker, service_role only (anon / authenticated: no EXECUTE).
begin;

-- 1 ----------------------------------------------------------------------------
create table if not exists public.channel_classify_budget_windows (
  org_id uuid not null references public.orgs(id) on delete cascade,
  budget_key text not null check (budget_key ~ '^[a-z_]{2,40}$'),
  window_start timestamptz not null,
  used integer not null default 0 check (used >= 0),
  overflow integer not null default 0 check (overflow >= 0),
  summary_sent boolean not null default false,
  primary key (org_id, budget_key)
);
alter table public.channel_classify_budget_windows enable row level security;
revoke all on table public.channel_classify_budget_windows from public, anon, authenticated;
grant select, insert, update, delete on table public.channel_classify_budget_windows to service_role;

-- 2 ----------------------------------------------------------------------------
create or replace function public.take_channel_classify_budget(
  p_org uuid, p_key text, p_window_seconds integer, p_max integer)
returns jsonb language plpgsql security invoker set search_path = pg_catalog, public as $$
declare
  r public.channel_classify_budget_windows;
begin
  if p_org is null or p_key is null or p_key !~ '^[a-z_]{2,40}$'
    or p_window_seconds is null or p_window_seconds < 60 or p_window_seconds > 86400
    or p_max is null or p_max < 1 or p_max > 1000 then
    return jsonb_build_object('state', 'denied');
  end if;
  insert into public.channel_classify_budget_windows (org_id, budget_key, window_start)
    values (p_org, p_key, now())
    on conflict (org_id, budget_key) do nothing;
  select * into r from public.channel_classify_budget_windows
    where org_id = p_org and budget_key = p_key
    for update;
  if r.window_start <= now() - make_interval(secs => p_window_seconds) then
    update public.channel_classify_budget_windows
      set window_start = now(), used = 1, overflow = 0, summary_sent = false
      where org_id = p_org and budget_key = p_key;
    return jsonb_build_object('state', 'allowed', 'used', 1, 'overflow', 0);
  end if;
  if r.used < p_max then
    update public.channel_classify_budget_windows set used = used + 1
      where org_id = p_org and budget_key = p_key;
    return jsonb_build_object('state', 'allowed', 'used', r.used + 1, 'overflow', r.overflow);
  end if;
  update public.channel_classify_budget_windows set overflow = overflow + 1, summary_sent = true
    where org_id = p_org and budget_key = p_key;
  return jsonb_build_object(
    'state', case when r.summary_sent then 'over' else 'over_first' end,
    'used', r.used, 'overflow', r.overflow + 1);
end $$;

revoke all on function public.take_channel_classify_budget(uuid, text, integer, integer) from public, anon, authenticated;
grant execute on function public.take_channel_classify_budget(uuid, text, integer, integer) to service_role;

commit;

-- ROLLBACK (down) — turn CHANNEL_CLASSIFY_PROPOSALS_ENABLED and
-- CHANNEL_STUCK_NOTIFY_ENABLED off first (with the flags ON and this rolled
-- back, the application falls back to a per-instance budget; nothing fails
-- open). Drops the RPC and the table only; the PR-B tables stay. Same
-- statements as supabase/verification/20261005400000_channel_classify_budget_rollback.sql.
-- Run as one transaction:
--   begin;
--   drop function if exists public.take_channel_classify_budget(uuid, text, integer, integer);
--   drop table if exists public.channel_classify_budget_windows;
--   commit;
-- END ROLLBACK

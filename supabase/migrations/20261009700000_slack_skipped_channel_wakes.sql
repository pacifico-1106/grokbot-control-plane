-- Path C follow-up (木村 2026-10-09): one-time re-wake of a user-token channel
-- mention that was skipped because the channel was unclassified, once a human
-- approves the channel's classification. Used ONLY with
-- PATHC_REWAKE_ON_CLASSIFY_ENABLED (default OFF). Additive and re-applicable.
-- Apply BEFORE setting the flag; with the flag OFF nothing here is touched.
--
-- 1. slack_skipped_channel_wakes: one row per org × employee × channel = the
--    LATEST skipped mention. Ids and timestamps only (channel / event / Slack
--    ts / speaker + subscriber user and team ids, skipped/claimed times and the
--    claiming approval). No message text, no names, no tokens.
--    RLS on, no policy, service_role only.
-- 2. record_slack_skipped_channel_wake(...) → jsonb {state: recorded|kept|denied}
--    upsert; the employee must belong to the org; an older (out-of-order)
--    event never replaces a newer one, claimed or not; a newer skip replaces the
--    row and reopens it.
-- 3. claim_slack_skipped_channel_wakes(org, channel, approval, ttl_seconds)
--    → jsonb {state: ok, rows: [...]} | {state: denied}
--    ONE UPDATE … WHERE claimed_at IS NULL … RETURNING, scoped to the org, and
--    only for an APPROVED approval_requests row of the same org that is THIS
--    channel's classification ticket (tool + externalId). Concurrent
--    claims: the row lock + re-check of claimed_at gives exactly one winner.
-- security invoker, service_role only (anon / authenticated: no EXECUTE).
begin;

-- 1 ----------------------------------------------------------------------------
create table if not exists public.slack_skipped_channel_wakes (
  org_id uuid not null references public.orgs(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  channel_id text not null check (channel_id ~ '^[CG][A-Z0-9]{2,30}$'),
  event_ts text not null check (event_ts ~ '^[0-9]{9,11}\.[0-9]{1,8}$'),
  thread_ts text check (thread_ts is null or thread_ts ~ '^[0-9]{9,11}\.[0-9]{1,8}$'),
  event_id text not null check (event_id ~ '^[A-Za-z0-9_.:-]{1,64}$'),
  speaker_slack_user_id text not null check (speaker_slack_user_id ~ '^[UWB][A-Z0-9]{2,31}$'),
  speaker_team_id text check (speaker_team_id is null or speaker_team_id ~ '^[TE][A-Z0-9]{2,31}$'),
  subscriber_slack_user_id text not null check (subscriber_slack_user_id ~ '^[UWB][A-Z0-9]{2,31}$'),
  subscriber_team_id text not null check (subscriber_team_id ~ '^[TE][A-Z0-9]{2,31}$'),
  skipped_at timestamptz not null default now(),
  claimed_at timestamptz,
  claimed_approval_id uuid references public.approval_requests(id) on delete set null,
  primary key (org_id, employee_id, channel_id)
);
create index if not exists slack_skipped_channel_wakes_org_channel_idx
  on public.slack_skipped_channel_wakes (org_id, channel_id) where claimed_at is null;
alter table public.slack_skipped_channel_wakes enable row level security;
revoke all on table public.slack_skipped_channel_wakes from public, anon, authenticated;
grant select, insert, update, delete on table public.slack_skipped_channel_wakes to service_role;

-- 2 ----------------------------------------------------------------------------
create or replace function public.record_slack_skipped_channel_wake(
  p_org uuid, p_employee uuid, p_channel text, p_event_ts text, p_thread_ts text, p_event_id text,
  p_speaker text, p_speaker_team text, p_subscriber text, p_subscriber_team text)
returns jsonb language plpgsql security invoker set search_path = pg_catalog, public as $$
declare
  ok boolean;
begin
  if p_org is null or p_employee is null
    or p_channel is null or p_channel !~ '^[CG][A-Z0-9]{2,30}$'
    or p_event_ts is null or p_event_ts !~ '^[0-9]{9,11}\.[0-9]{1,8}$'
    or (p_thread_ts is not null and p_thread_ts !~ '^[0-9]{9,11}\.[0-9]{1,8}$')
    or p_event_id is null or p_event_id !~ '^[A-Za-z0-9_.:-]{1,64}$'
    or p_speaker is null or p_speaker !~ '^[UWB][A-Z0-9]{2,31}$'
    or (p_speaker_team is not null and p_speaker_team !~ '^[TE][A-Z0-9]{2,31}$')
    or p_subscriber is null or p_subscriber !~ '^[UWB][A-Z0-9]{2,31}$'
    or p_subscriber_team is null or p_subscriber_team !~ '^[TE][A-Z0-9]{2,31}$' then
    return jsonb_build_object('state', 'denied');
  end if;
  if not exists (select 1 from public.employees e where e.id = p_employee and e.org_id = p_org) then
    return jsonb_build_object('state', 'denied');
  end if;
  insert into public.slack_skipped_channel_wakes as w (
      org_id, employee_id, channel_id, event_ts, thread_ts, event_id,
      speaker_slack_user_id, speaker_team_id, subscriber_slack_user_id, subscriber_team_id, skipped_at)
    values (p_org, p_employee, p_channel, p_event_ts, p_thread_ts, p_event_id,
      p_speaker, p_speaker_team, p_subscriber, p_subscriber_team, now())
    on conflict (org_id, employee_id, channel_id) do update set
      event_ts = excluded.event_ts, thread_ts = excluded.thread_ts, event_id = excluded.event_id,
      speaker_slack_user_id = excluded.speaker_slack_user_id, speaker_team_id = excluded.speaker_team_id,
      subscriber_slack_user_id = excluded.subscriber_slack_user_id, subscriber_team_id = excluded.subscriber_team_id,
      skipped_at = now(), claimed_at = null, claimed_approval_id = null
      where w.event_ts::numeric < excluded.event_ts::numeric
    returning true into ok;
  if ok then
    return jsonb_build_object('state', 'recorded');
  end if;
  return jsonb_build_object('state', 'kept');
end $$;

-- 3 ----------------------------------------------------------------------------
create or replace function public.claim_slack_skipped_channel_wakes(
  p_org uuid, p_channel text, p_approval uuid, p_ttl_seconds integer)
returns jsonb language plpgsql security invoker set search_path = pg_catalog, public as $$
declare
  claimed jsonb;
begin
  if p_org is null or p_approval is null
    or p_channel is null or p_channel !~ '^[CG][A-Z0-9]{2,30}$'
    or p_ttl_seconds is null or p_ttl_seconds < 60 or p_ttl_seconds > 604800 then
    return jsonb_build_object('state', 'denied');
  end if;
  -- Only an APPROVED ticket of the same org that classifies THIS channel:
  -- channels.classify with adminMutation.surface = slack and externalId = the
  -- channel, or a config.change_request channel_classification for it
  -- (21:53 review (2)). Any other approved ticket is refused.
  if not exists (select 1 from public.approval_requests ar
                 where ar.id = p_approval and ar.org_id = p_org and ar.status = 'approved'
                   and (
                     (ar.tool = 'channels.classify'
                       and ar.metadata->'adminMutation'->>'surface' = 'slack'
                       and ar.metadata->'adminMutation'->>'externalId' = p_channel)
                     or
                     (ar.tool = 'config.change_request'
                       and ar.metadata->'configChange'->'proposal'->>'kind' = 'channel_classification'
                       and ar.metadata->'configChange'->'proposal'->>'surface' = 'slack'
                       and ar.metadata->'configChange'->'proposal'->>'externalId' = p_channel)
                   )) then
    return jsonb_build_object('state', 'denied');
  end if;
  with c as (
    update public.slack_skipped_channel_wakes w
      set claimed_at = now(), claimed_approval_id = p_approval
      where w.org_id = p_org and w.channel_id = p_channel and w.claimed_at is null
        and w.skipped_at > now() - make_interval(secs => p_ttl_seconds)
      returning w.*
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'org_id', c.org_id, 'employee_id', c.employee_id, 'channel_id', c.channel_id,
      'event_ts', c.event_ts, 'thread_ts', c.thread_ts, 'event_id', c.event_id,
      'speaker_slack_user_id', c.speaker_slack_user_id, 'speaker_team_id', c.speaker_team_id,
      'subscriber_slack_user_id', c.subscriber_slack_user_id, 'subscriber_team_id', c.subscriber_team_id,
      'skipped_at', c.skipped_at, 'claimed_at', c.claimed_at, 'claimed_approval_id', c.claimed_approval_id)), '[]'::jsonb)
    into claimed from c;
  return jsonb_build_object('state', 'ok', 'rows', claimed);
end $$;

revoke all on function public.record_slack_skipped_channel_wake(uuid, uuid, text, text, text, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.claim_slack_skipped_channel_wakes(uuid, text, uuid, integer) from public, anon, authenticated;
grant execute on function public.record_slack_skipped_channel_wake(uuid, uuid, text, text, text, text, text, text, text, text) to service_role;
grant execute on function public.claim_slack_skipped_channel_wakes(uuid, text, uuid, integer) to service_role;

commit;

-- ROLLBACK (down) — turn PATHC_REWAKE_ON_CLASSIFY_ENABLED off first (with the
-- flag ON and this rolled back, recording and claiming return "unavailable":
-- nothing is re-woken, nothing fails open). Drops the two RPCs and the table
-- only. Same statements as
-- supabase/verification/20261009700000_slack_skipped_channel_wakes_rollback.sql.
-- Run as one transaction:
--   begin;
--   drop function if exists public.claim_slack_skipped_channel_wakes(uuid, text, uuid, integer);
--   drop function if exists public.record_slack_skipped_channel_wake(uuid, uuid, text, text, text, text, text, text, text, text);
--   drop table if exists public.slack_skipped_channel_wakes;
--   commit;
-- END ROLLBACK

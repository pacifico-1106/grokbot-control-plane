-- PR-B channel classification proposals + stuck notices (八坂 2026-10-05).
-- Additive and re-applicable. Apply BEFORE setting
-- CHANNEL_CLASSIFY_PROPOSALS_ENABLED / CHANNEL_STUCK_NOTIFY_ENABLED; with both
-- flags OFF the application never touches anything added here.
--
-- 1. org_channels.surface gains 'telegram' (Telegram groups can be classified;
--    every existing surface is kept).
-- 2. channel_classify_proposals: one row per org × proposal key
--    ("channel:<surface>:<id>" / "party:<kind>:<id>") holding the facts hash and
--    the approval ticket it opened. No message content, no tokens.
-- 3. channel_stuck_notice_windows: per org × notice key rate-limit window.
--    Keys are reason codes + channel ids only.
-- 4. RPCs (security invoker, service_role only; anon / authenticated have no
--    access to the tables or the functions):
--    claim_channel_classify_proposal(org, key, facts_hash, stale_seconds)
--      → denied     invalid input
--        claimed    caller may open a ticket now (new key, facts changed after a
--                   decided ticket, ticket row gone, or a stale unattached claim)
--        in_flight  another caller claimed it < stale_seconds ago (no ticket yet)
--        pending    the attached ticket is still pending / revision_requested
--        decided    the attached ticket was decided and the facts are unchanged
--      atomic per org × key (transaction advisory lock): two concurrent joins
--      cannot both open a ticket.
--    attach_channel_classify_proposal(org, key, approval) — only an approval of
--      the same org, only onto an unattached claim.
--    release_channel_classify_proposal(org, key) — drops an unattached claim
--      (ticket creation failed → the next join may retry).
--    take_channel_stuck_notice(org, key, window_seconds) → allowed once per
--      window per org × key (atomic upsert), otherwise suppressed (counted).
begin;

-- 1 ----------------------------------------------------------------------------
alter table public.org_channels drop constraint if exists org_channels_surface_check;
alter table public.org_channels add constraint org_channels_surface_check
  check (surface in ('slack','line','mail','phone','web','telegram'));

-- 2 ----------------------------------------------------------------------------
create table if not exists public.channel_classify_proposals (
  org_id uuid not null references public.orgs(id) on delete cascade,
  proposal_key text not null check (proposal_key ~ '^(channel|party):[a-z_]{2,20}:[A-Za-z0-9_.:@+-]{1,128}$'),
  facts_hash text not null check (facts_hash ~ '^[0-9a-f]{64}$'),
  approval_id uuid references public.approval_requests(id) on delete set null,
  claimed_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, proposal_key)
);
alter table public.channel_classify_proposals enable row level security;
revoke all on table public.channel_classify_proposals from public, anon, authenticated;
grant select, insert, update, delete on table public.channel_classify_proposals to service_role;

-- 3 ----------------------------------------------------------------------------
create table if not exists public.channel_stuck_notice_windows (
  org_id uuid not null references public.orgs(id) on delete cascade,
  notice_key text not null check (notice_key ~ '^[A-Za-z0-9_.:@+|-]{1,200}$'),
  window_start timestamptz not null,
  suppressed integer not null default 0 check (suppressed >= 0),
  primary key (org_id, notice_key)
);
alter table public.channel_stuck_notice_windows enable row level security;
revoke all on table public.channel_stuck_notice_windows from public, anon, authenticated;
grant select, insert, update, delete on table public.channel_stuck_notice_windows to service_role;

-- 4 ----------------------------------------------------------------------------
create or replace function public.claim_channel_classify_proposal(
  p_org uuid, p_key text, p_facts_hash text, p_stale_seconds integer)
returns jsonb language plpgsql security invoker set search_path = pg_catalog, public as $$
declare
  r public.channel_classify_proposals;
  a_status text;
begin
  if p_org is null or p_key is null
    or p_key !~ '^(channel|party):[a-z_]{2,20}:[A-Za-z0-9_.:@+-]{1,128}$'
    or p_facts_hash is null or p_facts_hash !~ '^[0-9a-f]{64}$'
    or p_stale_seconds is null or p_stale_seconds < 1 or p_stale_seconds > 86400 then
    return jsonb_build_object('state', 'denied');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('channel_classify:' || p_org::text || ':' || p_key, 0));
  select * into r from public.channel_classify_proposals where org_id = p_org and proposal_key = p_key;
  if not found then
    insert into public.channel_classify_proposals (org_id, proposal_key, facts_hash) values (p_org, p_key, p_facts_hash);
    return jsonb_build_object('state', 'claimed');
  end if;
  if r.approval_id is not null then
    select ar.status into a_status from public.approval_requests ar where ar.id = r.approval_id and ar.org_id = p_org;
    if found then
      if a_status in ('pending', 'revision_requested') then
        return jsonb_build_object('state', 'pending', 'approval_id', r.approval_id);
      end if;
      if r.facts_hash = p_facts_hash then
        return jsonb_build_object('state', 'decided', 'approval_id', r.approval_id, 'status', a_status);
      end if;
    end if;
  elsif r.claimed_at > now() - make_interval(secs => p_stale_seconds) and r.facts_hash = p_facts_hash then
    return jsonb_build_object('state', 'in_flight');
  end if;
  update public.channel_classify_proposals
    set facts_hash = p_facts_hash, approval_id = null, claimed_at = now(), updated_at = now()
    where org_id = p_org and proposal_key = p_key;
  return jsonb_build_object('state', 'claimed');
end $$;

create or replace function public.attach_channel_classify_proposal(p_org uuid, p_key text, p_approval uuid)
returns boolean language plpgsql security invoker set search_path = pg_catalog, public as $$
begin
  update public.channel_classify_proposals p set approval_id = p_approval, updated_at = now()
    where p.org_id = p_org and p.proposal_key = p_key and p.approval_id is null
      and exists (select 1 from public.approval_requests ar where ar.id = p_approval and ar.org_id = p_org);
  return found;
end $$;

create or replace function public.release_channel_classify_proposal(p_org uuid, p_key text)
returns boolean language plpgsql security invoker set search_path = pg_catalog, public as $$
begin
  delete from public.channel_classify_proposals where org_id = p_org and proposal_key = p_key and approval_id is null;
  return found;
end $$;

create or replace function public.take_channel_stuck_notice(p_org uuid, p_key text, p_window_seconds integer)
returns jsonb language plpgsql security invoker set search_path = pg_catalog, public as $$
declare
  ok boolean;
begin
  if p_org is null or p_key is null or p_key !~ '^[A-Za-z0-9_.:@+|-]{1,200}$'
    or p_window_seconds is null or p_window_seconds < 60 or p_window_seconds > 604800 then
    return jsonb_build_object('state', 'denied');
  end if;
  insert into public.channel_stuck_notice_windows as w (org_id, notice_key, window_start, suppressed)
    values (p_org, p_key, now(), 0)
    on conflict (org_id, notice_key) do update set window_start = now(), suppressed = 0
      where w.window_start < now() - make_interval(secs => p_window_seconds)
    returning true into ok;
  if ok then
    return jsonb_build_object('state', 'ok', 'allowed', true);
  end if;
  update public.channel_stuck_notice_windows set suppressed = suppressed + 1
    where org_id = p_org and notice_key = p_key;
  return jsonb_build_object('state', 'ok', 'allowed', false);
end $$;

revoke all on function public.claim_channel_classify_proposal(uuid, text, text, integer) from public, anon, authenticated;
revoke all on function public.attach_channel_classify_proposal(uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.release_channel_classify_proposal(uuid, text) from public, anon, authenticated;
revoke all on function public.take_channel_stuck_notice(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.claim_channel_classify_proposal(uuid, text, text, integer) to service_role;
grant execute on function public.attach_channel_classify_proposal(uuid, text, uuid) to service_role;
grant execute on function public.release_channel_classify_proposal(uuid, text) to service_role;
grant execute on function public.take_channel_stuck_notice(uuid, text, integer) to service_role;

commit;

-- ROLLBACK (down) — turn CHANNEL_CLASSIFY_PROPOSALS_ENABLED and
-- CHANNEL_STUCK_NOTIFY_ENABLED off first. Drops the 4 RPCs and 2 tables
-- (open tickets stay as ordinary admin tickets; approving one still applies
-- through fulfillment, except a telegram one, which then fails closed on the
-- restored surface check). Telegram rows in org_channels are deleted (they are
-- external for egress anyway: Telegram is not a conversation surface) and the
-- previous surface check is restored. Same statements as
-- supabase/verification/20261005200000_channel_classify_proposals_rollback.sql.
-- Run as one transaction:
--   begin;
--   drop function if exists public.claim_channel_classify_proposal(uuid, text, text, integer);
--   drop function if exists public.attach_channel_classify_proposal(uuid, text, uuid);
--   drop function if exists public.release_channel_classify_proposal(uuid, text);
--   drop function if exists public.take_channel_stuck_notice(uuid, text, integer);
--   drop table if exists public.channel_classify_proposals;
--   drop table if exists public.channel_stuck_notice_windows;
--   delete from public.org_channels where surface = 'telegram';
--   alter table public.org_channels drop constraint if exists org_channels_surface_check;
--   alter table public.org_channels add constraint org_channels_surface_check
--     check (surface in ('slack','line','mail','phone','web'));
--   commit;
-- END ROLLBACK

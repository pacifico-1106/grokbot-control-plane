-- LP setup-fee payment record (木村 2026-10-12, design PR3 in dry-run mode).
-- Used ONLY with LP_AUTO_PROVISION_MODE=dry_run (default off). Additive and
-- re-applicable; with the flag off nothing here is touched. Apply BEFORE
-- setting the flag. No tenant is created from these rows (PR4).
--
-- lp_provisioning_events: one row per Stripe event id (UNIQUE) that reached the
--   LP branch: outcome paid / ignored (+ reason code). Ids and codes only.
-- lp_provisionings: one row per Checkout Session (UNIQUE) whose re-fetched
--   Session was paid. Re-validated values only: lp_page allowlist, lp_ref /
--   AIC- / uuid regex, or the marker '(invalid)'. The customer email is never
--   stored: sha256 of the normalised address + the domain only.
-- Notice once per Session: claim_lp_provisioning_notice (conditional UPDATE,
--   claim token, stale takeover) → send → finish_lp_provisioning_notice
--   ('sent' / 'no_destination' records it; 'failed' releases the claim).
-- RLS on, no policy; tables and functions service_role only.
begin;

create table if not exists public.lp_provisioning_events (
  id uuid primary key default gen_random_uuid(),
  stripe_event_id text not null unique check (stripe_event_id ~ '^evt_[A-Za-z0-9_]{1,255}$'),
  stripe_checkout_session_id text check (stripe_checkout_session_id ~ '^cs_(test|live)_[A-Za-z0-9]{1,255}$'),
  event_type text not null check (event_type in (
    'checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed')),
  outcome text not null check (outcome in ('paid', 'ignored')),
  reason text check (reason ~ '^[a-z_]{1,64}$'),
  payment_status text check (payment_status in ('paid', 'unpaid', 'no_payment_required')),
  livemode boolean,
  received_at timestamptz not null default now()
);
create index if not exists lp_provisioning_events_session_idx
  on public.lp_provisioning_events (stripe_checkout_session_id);

create table if not exists public.lp_provisionings (
  id uuid primary key default gen_random_uuid(),
  stripe_checkout_session_id text not null unique check (stripe_checkout_session_id ~ '^cs_(test|live)_[A-Za-z0-9]{1,255}$'),
  first_stripe_event_id text not null check (first_stripe_event_id ~ '^evt_[A-Za-z0-9_]{1,255}$'),
  livemode boolean not null,
  mode text not null default 'dry_run' check (mode in ('dry_run')),
  step text not null default 'recorded' check (step in ('recorded')),
  amount_total bigint not null check (amount_total >= 0),
  currency text not null check (currency ~ '^[a-z]{3}$'),
  plan text not null check (plan in ('intern', 'proper', 'executive', '(invalid)')),
  lp_page text not null check (lp_page in ('ai-employee', 'ai-employee-corp', '(invalid)')),
  lp_ref text check (lp_ref ~ '^[A-Za-z0-9_-]{1,32}$' or lp_ref = '(invalid)'),
  referral_code text check (referral_code ~ '^AIC-[A-Z0-9]{4,16}$' or referral_code = '(invalid)'),
  lp_order_id text check (lp_order_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' or lp_order_id = '(invalid)'),
  customer_email_sha256 text check (customer_email_sha256 ~ '^[0-9a-f]{64}$'),
  customer_email_domain text check (customer_email_domain ~ '^[a-z0-9.-]{1,253}$' or customer_email_domain = '(invalid)'),
  notice_claim_token text,
  notice_claimed_at timestamptz,
  notice_result text check (notice_result in ('sent', 'no_destination')),
  notified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.lp_provisioning_events enable row level security;
alter table public.lp_provisionings enable row level security;
revoke all on table public.lp_provisioning_events from public, anon, authenticated;
revoke all on table public.lp_provisionings from public, anon, authenticated;
grant select, insert, update, delete on table public.lp_provisioning_events to service_role;
grant select, insert, update, delete on table public.lp_provisionings to service_role;

create or replace function public.claim_lp_provisioning_notice(p_session text, p_token text, p_stale_seconds integer)
returns boolean language plpgsql security invoker set search_path = pg_catalog, public as $lpc$
declare n integer;
begin
  if p_token is null or length(p_token) < 16 then raise exception 'invalid_claim_token'; end if;
  update public.lp_provisionings
     set notice_claim_token = p_token, notice_claimed_at = now(), updated_at = now()
   where stripe_checkout_session_id = p_session
     and notified_at is null
     and (notice_claim_token is null
          or notice_claimed_at < now() - make_interval(secs => greatest(coalesce(p_stale_seconds, 600), 0)));
  get diagnostics n = row_count;
  return n = 1;
end $lpc$;

create or replace function public.finish_lp_provisioning_notice(p_session text, p_token text, p_result text)
returns boolean language plpgsql security invoker set search_path = pg_catalog, public as $lpf$
declare n integer;
begin
  if p_result not in ('sent', 'no_destination', 'failed') then raise exception 'invalid_notice_result'; end if;
  if p_token is null or p_token = '' then return false; end if;
  if p_result = 'failed' then
    update public.lp_provisionings
       set notice_claim_token = null, notice_claimed_at = null, updated_at = now()
     where stripe_checkout_session_id = p_session and notified_at is null and notice_claim_token = p_token;
  else
    update public.lp_provisionings
       set notice_result = p_result, notified_at = now(), notice_claim_token = null, updated_at = now()
     where stripe_checkout_session_id = p_session and notified_at is null and notice_claim_token = p_token;
  end if;
  get diagnostics n = row_count;
  return n = 1;
end $lpf$;

revoke all on function public.claim_lp_provisioning_notice(text, text, integer) from public, anon, authenticated;
revoke all on function public.finish_lp_provisioning_notice(text, text, text) from public, anon, authenticated;
grant execute on function public.claim_lp_provisioning_notice(text, text, integer) to service_role;
grant execute on function public.finish_lp_provisioning_notice(text, text, text) to service_role;

commit;

-- ROLLBACK (down) — set LP_AUTO_PROVISION_MODE off first (drops the record:
-- a re-delivered event would notify again once re-applied). Same statements as
-- supabase/verification/20261012400000_lp_provisionings_rollback.sql:
--   begin;
--   drop function if exists public.claim_lp_provisioning_notice(text, text, integer);
--   drop function if exists public.finish_lp_provisioning_notice(text, text, text);
--   drop table if exists public.lp_provisionings;
--   drop table if exists public.lp_provisioning_events;
--   commit;
-- END ROLLBACK

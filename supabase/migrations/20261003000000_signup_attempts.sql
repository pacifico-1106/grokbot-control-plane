-- 20261003000000_signup_attempts.sql
-- Signup attempt log for POST /api/auth/signup (spam-sample-20261003 follow-up).
-- Written only when SIGNUP_ATTEMPT_LOG_ENABLED / SIGNUP_RATE_LIMIT_ENABLED /
-- SIGNUP_DOMAIN_CHECK_ENABLED are ON (all default OFF). Service role only.
-- Privacy: no raw IP / UA / email. ip_hash, ua_hash, email_norm_hash are keyed
-- SHA-256 (IP_HASH_KEY) truncated hex. email_domain is kept for disposable-domain stats.
-- Retention: 90 days (purge_signup_attempts, called by the spam-sweep cron when enabled).

create table if not exists public.signup_attempts (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  ip_hash text check (ip_hash is null or ip_hash ~ '^[0-9a-f]{16,64}$'),
  ua_hash text check (ua_hash is null or ua_hash ~ '^[0-9a-f]{16,64}$'),
  email_domain text check (email_domain is null or char_length(email_domain) <= 255),
  email_norm_hash text check (email_norm_hash is null or email_norm_hash ~ '^[0-9a-f]{16,64}$'),
  outcome text not null check (outcome in (
    'created', 'rejected_guard', 'rate_limited', 'rejected_domain',
    'duplicate_normalized', 'error'
  )),
  reason text check (reason is null or reason ~ '^[a-z0-9_:.-]{1,64}$'),
  turnstile_ok boolean,
  honeypot_filled boolean not null default false,
  signals text[] not null default '{}',
  -- No FK on purpose: rows must survive org/user deletion for forensics.
  org_id uuid,
  user_id uuid
);

create index if not exists signup_attempts_ip_created_idx
  on public.signup_attempts (ip_hash, created_at desc);
create index if not exists signup_attempts_email_created_idx
  on public.signup_attempts (email_norm_hash, created_at desc);
create index if not exists signup_attempts_created_idx
  on public.signup_attempts (created_at desc);
create index if not exists signup_attempts_org_idx
  on public.signup_attempts (org_id) where org_id is not null;

alter table public.signup_attempts enable row level security;
-- No policies: anon / authenticated get nothing; service role bypasses RLS.
revoke all on public.signup_attempts from anon, authenticated;

comment on table public.signup_attempts is
  'Signup attempt log (hashed IP/UA/email only). Service role only. Retention 90d via purge_signup_attempts().';

create or replace function public.purge_signup_attempts(p_days integer default 90)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted integer;
begin
  if p_days is null or p_days < 30 then
    raise exception 'retention must be >= 30 days';
  end if;
  delete from public.signup_attempts where created_at < now() - make_interval(days => p_days);
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function public.purge_signup_attempts(integer) from public, anon, authenticated;
grant execute on function public.purge_signup_attempts(integer) to service_role;

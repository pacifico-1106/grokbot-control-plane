-- 20261003000100_spam_sweep.sql
-- Recurring spam sweep (spam-sample-20261003 follow-up). All behaviour is behind
-- SPAM_ADMIN_TOOLS_ENABLED / SPAM_SWEEP_ENABLED (default OFF). Service role only.
-- Depends on 20261003000000_signup_attempts.sql.

-- 1) Sweep reports (masked candidate list; no full emails).
create table if not exists public.spam_sweep_reports (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  trigger text not null check (trigger in ('cron', 'admin_mcp')),
  window_days integer not null check (window_days between 1 and 180),
  candidate_count integer not null default 0 check (candidate_count >= 0),
  watch_count integer not null default 0 check (watch_count >= 0),
  report jsonb not null default '{}'::jsonb,
  proposal_approval_id uuid
);
create index if not exists spam_sweep_reports_created_idx on public.spam_sweep_reports (created_at desc);

-- 2) Account actions ledger (suspend / unsuspend / delete). No FK on org_id:
--    rows must survive org deletion; this is also the source for the 7-day rule.
create table if not exists public.spam_account_actions (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  action text not null check (action in ('suspend', 'unsuspend', 'delete')),
  org_id uuid not null,
  user_ids uuid[] not null default '{}',
  approval_id uuid,
  approver text,
  requested_by text,
  preview_hash text check (preview_hash is null or preview_hash ~ '^[0-9a-f]{64}$'),
  reason text check (reason is null or char_length(reason) <= 500),
  details jsonb not null default '{}'::jsonb
);
create index if not exists spam_account_actions_org_created_idx
  on public.spam_account_actions (org_id, created_at desc);

alter table public.spam_sweep_reports enable row level security;
alter table public.spam_account_actions enable row level security;
revoke all on public.spam_sweep_reports from anon, authenticated;
revoke all on public.spam_account_actions from anon, authenticated;

-- 3) Read-only facts for scoring. SECURITY DEFINER only to read auth.users;
--    STABLE, no writes. Scoring itself is in lib/spam/score.ts.
create or replace function public.spam_scan_facts(p_days integer default 30)
returns table (
  org_id uuid,
  org_name text,
  org_created_at timestamptz,
  referral_code text,
  stripe_customer_id text,
  has_stripe_subscription boolean,
  member_count integer,
  employee_count integer,
  same_name_24h integer,
  owner_member_id uuid,
  owner_user_id uuid,
  owner_member_status text,
  owner_email text,
  user_created_at timestamptz,
  last_sign_in_at timestamptz,
  banned_until timestamptz,
  signup_signals text[],
  signup_ip_reuse integer
)
language plpgsql
stable
security definer
set search_path = public, auth
as $$
begin
  if p_days is null or p_days < 1 or p_days > 180 then
    raise exception 'p_days must be between 1 and 180';
  end if;
  return query
  select
    o.id,
    o.name,
    o.created_at,
    o.referral_code,
    o.stripe_customer_id,
    exists (select 1 from public.subscriptions s where s.org_id = o.id and s.stripe_subscription_id is not null),
    (select count(*)::int from public.org_members m2 where m2.org_id = o.id),
    (select count(*)::int from public.employees e where e.org_id = o.id),
    (select count(*)::int from public.orgs o2 where o2.name = o.name
        and o2.created_at between o.created_at - interval '24 hours' and o.created_at + interval '24 hours'),
    m.id,
    m.user_id,
    m.status,
    coalesce(u.email::text, m.email),
    u.created_at,
    u.last_sign_in_at,
    u.banned_until,
    coalesce((select sa.signals from public.signup_attempts sa
               where sa.org_id = o.id and sa.outcome = 'created'
               order by sa.created_at desc limit 1), '{}'::text[]),
    coalesce((select count(*)::int from public.signup_attempts sa2
               where sa2.ip_hash is not null
                 and sa2.ip_hash = (select sa3.ip_hash from public.signup_attempts sa3
                                     where sa3.org_id = o.id and sa3.outcome = 'created'
                                     order by sa3.created_at desc limit 1)
                 and sa2.created_at > now() - interval '7 days'), 0)
  from public.orgs o
  left join lateral (
    select mm.* from public.org_members mm
    where mm.org_id = o.id and mm.role = 'owner'
    order by mm.created_at asc limit 1
  ) m on true
  left join auth.users u on u.id = m.user_id
  where o.created_at > now() - make_interval(days => p_days)
  order by o.created_at desc;
end;
$$;

revoke all on function public.spam_scan_facts(integer) from public, anon, authenticated;
grant execute on function public.spam_scan_facts(integer) to service_role;

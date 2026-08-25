-- AI社員 for Grok Bot — control plane schema (Supabase Postgres)
-- Apply via Supabase SQL editor or `supabase db push`.
-- Fresh apply includes production-ready columns + RLS.
-- Existing projects: also apply supabase/migrations/20260823_production_ready.sql

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Organizations
-- ---------------------------------------------------------------------------
create table if not exists orgs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  integration_mode text not null default 'managed'
    check (integration_mode in ('managed', 'byo')),
  gateway_status text not null default 'pending'
    check (gateway_status in ('linked', 'pending', 'disconnected')),
  trial_ends_at timestamptz,
  stripe_customer_id text,
  referral_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists org_members (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  user_id uuid, -- supabase auth.users.id when wired
  email text not null,
  display_name text not null default '',
  role text not null default 'member'
    check (role in ('owner', 'admin', 'member')),
  job_role text not null default 'custom',
  job_label text,
  capabilities text[] not null default '{}',
  status text not null default 'active'
    check (status in ('active', 'invited', 'disabled')),
  invited_at timestamptz,
  created_at timestamptz not null default now(),
  unique (org_id, email)
);

create index if not exists org_members_org_idx on org_members (org_id, role);
create index if not exists org_members_user_idx on org_members (user_id)
  where user_id is not null;

-- ---------------------------------------------------------------------------
-- AI employees + credentials (社員証)
-- ---------------------------------------------------------------------------
create table if not exists employees (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  display_name text not null,
  role_label text not null,
  job_description text not null default '',
  status text not null default 'active'
    check (status in ('active', 'suspended', 'draft')),
  scopes text[] not null default '{}',
  allowed_purposes text[] not null default '{}',
  approval_policy text not null default 'risk_based'
    check (approval_policy in ('auto', 'always_human', 'risk_based')),
  spend jsonb,
  allowed_accounts jsonb not null default '[]'::jsonb,
  approval_notify_email text,
  callback_url text,
  approval_routine_text text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists employees_org_idx on employees (org_id, status);

create table if not exists credentials (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete cascade,
  secret_hash text not null,
  secret_prefix text not null default 'gb_emp_',
  scopes text[] not null default '{}',
  allowed_purposes text[] not null default '{}',
  approval_policy text not null default 'risk_based'
    check (approval_policy in ('auto', 'always_human', 'risk_based')),
  spend jsonb,
  allowed_accounts jsonb not null default '[]'::jsonb,
  expires_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists credentials_employee_idx on credentials (employee_id);
create index if not exists credentials_org_active_idx
  on credentials (org_id) where revoked_at is null;

-- ---------------------------------------------------------------------------
-- Approvals (要対応)
-- ---------------------------------------------------------------------------
create table if not exists approval_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  employee_id uuid not null references employees(id),
  credential_id uuid not null references credentials(id),
  purpose text not null,
  summary text not null,
  title text,
  tool text,
  job_id text,
  revision_note text,
  revision_count integer not null default 0,
  telegram_message_id bigint,
  telegram_ref text not null default encode(gen_random_bytes(6), 'hex'),
  parent_approval_id uuid references approval_requests(id) on delete set null,
  status_token text,
  poll_path text,
  risk text not null check (risk in ('low', 'medium', 'high')),
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'expired', 'revision_requested')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid
);

create index if not exists approval_requests_org_status_idx
  on approval_requests (org_id, status, created_at desc);

create index if not exists approval_requests_status_token_idx
  on approval_requests (id, status_token);

create unique index if not exists approval_requests_telegram_ref_idx
  on approval_requests (telegram_ref);
create index if not exists approval_requests_telegram_msg_idx
  on approval_requests (telegram_message_id);
create index if not exists approval_requests_job_idx
  on approval_requests (org_id, job_id);

create table if not exists org_notification_channels (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  provider text not null check (provider in ('telegram','line')),
  label text not null,
  enabled boolean not null default false,
  config jsonb not null default '{}'::jsonb,
  webhook_ref text not null default encode(gen_random_bytes(6), 'hex'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, provider),
  unique (webhook_ref)
);

create table if not exists org_notification_channel_secrets (
  channel_id uuid primary key references org_notification_channels(id) on delete cascade,
  credentials_ciphertext text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists approval_notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  approval_id uuid not null references approval_requests(id) on delete cascade,
  org_id uuid not null references orgs(id) on delete cascade,
  channel_id uuid not null references org_notification_channels(id) on delete cascade,
  provider text not null check (provider in ('telegram','line')),
  external_message_id text,
  context jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (approval_id, channel_id)
);

create index if not exists notification_channels_org_enabled_idx
  on org_notification_channels (org_id, enabled);
create index if not exists notification_deliveries_external_idx
  on approval_notification_deliveries (channel_id, external_message_id);

-- ---------------------------------------------------------------------------
-- Audit timeline
-- ---------------------------------------------------------------------------
create table if not exists audit_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  employee_id uuid references employees(id),
  credential_id uuid references credentials(id),
  actor_email text,
  action text not null,
  purpose text,
  summary text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists audit_events_org_created_idx
  on audit_events (org_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Subscriptions (Stripe)
-- ---------------------------------------------------------------------------
create table if not exists subscriptions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  plan_key text not null default 'business'
    check (plan_key in ('starter', 'business', 'managed')),
  status text not null default 'trialing'
    check (status in ('trialing', 'active', 'past_due', 'canceled', 'incomplete', 'unpaid')),
  stripe_subscription_id text,
  stripe_price_id text,
  trial_ends_at timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id)
);

create table if not exists gateway_links (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  mode text not null check (mode in ('managed', 'byo')),
  status text not null default 'pending'
    check (status in ('linked', 'pending', 'disconnected')),
  workspace_ref text,
  last_handshake_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id)
);

-- ---------------------------------------------------------------------------
-- Durable Grok Bot ↔ AI-employee bindings (lifeline)
-- employee_id is stable forever; rotate bumps credential_generation only.
-- Fail-closed: gateway refuses unbound / revoked / needs_reauth.
-- ---------------------------------------------------------------------------
create table if not exists employee_bindings (
  employee_id uuid primary key references employees(id) on delete cascade,
  org_id uuid not null references orgs(id) on delete cascade,
  grok_bot_agent_id text,
  grok_bot_workspace_id text,
  credential_generation integer not null default 0,
  credential_fingerprint text,
  status text not null default 'unlinked'
    check (status in ('unlinked', 'linked', 'degraded', 'needs_reauth', 'revoked')),
  last_success_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists employee_bindings_org_status_idx
  on employee_bindings (org_id, status);

create index if not exists employee_bindings_needs_reauth_idx
  on employee_bindings (org_id)
  where status = 'needs_reauth';

-- ---------------------------------------------------------------------------
-- RLS: org isolation via org_members.user_id = auth.uid()
-- Service role bypasses RLS (gateway / admin API).
-- ---------------------------------------------------------------------------
create or replace function public.is_org_member(check_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from org_members m
    where m.org_id = check_org_id
      and m.user_id = auth.uid()
      and m.status = 'active'
  );
$$;

create or replace function public.is_org_admin(check_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from org_members m
    where m.org_id = check_org_id
      and m.user_id = auth.uid()
      and m.status = 'active'
      and m.role in ('owner', 'admin')
  );
$$;

alter table orgs enable row level security;
alter table org_members enable row level security;
alter table employees enable row level security;
alter table credentials enable row level security;
alter table approval_requests enable row level security;
alter table org_notification_channels enable row level security;
alter table org_notification_channel_secrets enable row level security;
alter table approval_notification_deliveries enable row level security;
alter table audit_events enable row level security;
alter table subscriptions enable row level security;
alter table gateway_links enable row level security;
alter table employee_bindings enable row level security;

drop policy if exists orgs_select_member on orgs;
drop policy if exists orgs_update_admin on orgs;
create policy orgs_select_member on orgs
  for select using (public.is_org_member(id));
create policy orgs_update_admin on orgs
  for update using (public.is_org_admin(id));

drop policy if exists org_members_select on org_members;
drop policy if exists org_members_write_admin on org_members;
create policy org_members_select on org_members
  for select using (public.is_org_member(org_id));
create policy org_members_write_admin on org_members
  for all using (public.is_org_admin(org_id));

drop policy if exists employees_select on employees;
drop policy if exists employees_write_admin on employees;
create policy employees_select on employees
  for select using (public.is_org_member(org_id));
create policy employees_write_admin on employees
  for all using (public.is_org_admin(org_id));

drop policy if exists credentials_select on credentials;
drop policy if exists credentials_write_admin on credentials;
create policy credentials_select on credentials
  for select using (public.is_org_member(org_id));
create policy credentials_write_admin on credentials
  for all using (public.is_org_admin(org_id));

drop policy if exists approvals_select on approval_requests;
drop policy if exists approvals_write_member on approval_requests;
create policy approvals_select on approval_requests
  for select using (public.is_org_member(org_id));
create policy approvals_write_member on approval_requests
  for all using (public.is_org_member(org_id));

drop policy if exists notification_channels_select on org_notification_channels;
drop policy if exists notification_channels_write_admin on org_notification_channels;
create policy notification_channels_select on org_notification_channels
  for select using (public.is_org_member(org_id));
create policy notification_channels_write_admin on org_notification_channels
  for all using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));

drop policy if exists notification_deliveries_select on approval_notification_deliveries;
create policy notification_deliveries_select on approval_notification_deliveries
  for select using (public.is_org_member(org_id));

drop policy if exists audit_select on audit_events;
drop policy if exists audit_insert_member on audit_events;
create policy audit_select on audit_events
  for select using (public.is_org_member(org_id));
create policy audit_insert_member on audit_events
  for insert with check (public.is_org_member(org_id));

drop policy if exists subscriptions_select on subscriptions;
drop policy if exists subscriptions_write_admin on subscriptions;
create policy subscriptions_select on subscriptions
  for select using (public.is_org_member(org_id));
create policy subscriptions_write_admin on subscriptions
  for all using (public.is_org_admin(org_id));

drop policy if exists gateway_select on gateway_links;
drop policy if exists gateway_write_admin on gateway_links;
create policy gateway_select on gateway_links
  for select using (public.is_org_member(org_id));
create policy gateway_write_admin on gateway_links
  for all using (public.is_org_admin(org_id));

drop policy if exists bindings_select on employee_bindings;
drop policy if exists bindings_write_admin on employee_bindings;
create policy bindings_select on employee_bindings
  for select using (public.is_org_member(org_id));
create policy bindings_write_admin on employee_bindings
  for all using (public.is_org_admin(org_id));

-- ---------------------------------------------------------------------------
-- AgentMail reservation (P0.5) — schema/policy only; no live provider wiring in P0.
-- Email layers: human_gmail | agentmail | staffpass_resend — never mix.
-- ---------------------------------------------------------------------------
create table if not exists agentmail_inboxes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete cascade,
  inbox_id text, -- provider inbox id when provisioned (P1)
  status text not null default 'reserved'
    check (status in ('reserved', 'provisioning', 'active', 'disabled')),
  layer text not null default 'agentmail'
    check (layer = 'agentmail'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, employee_id)
);

create index if not exists agentmail_inboxes_org_idx
  on agentmail_inboxes (org_id, status);

alter table agentmail_inboxes enable row level security;

drop policy if exists agentmail_select on agentmail_inboxes;
drop policy if exists agentmail_write_admin on agentmail_inboxes;
create policy agentmail_select on agentmail_inboxes
  for select using (public.is_org_member(org_id));
create policy agentmail_write_admin on agentmail_inboxes
  for all using (public.is_org_admin(org_id));

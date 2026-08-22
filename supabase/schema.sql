-- AI社員 for Grok Bot — control plane schema (Supabase Postgres)
-- Apply via Supabase SQL editor or `supabase db push`.

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
  status text not null default 'active'
    check (status in ('active', 'invited', 'disabled')),
  invited_at timestamptz,
  created_at timestamptz not null default now(),
  unique (org_id, email)
);

create index if not exists org_members_org_idx on org_members (org_id, role);

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
  risk text not null check (risk in ('low', 'medium', 'high')),
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'expired')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid
);

create index if not exists approval_requests_org_status_idx
  on approval_requests (org_id, status, created_at desc);

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
    check (plan_key in ('starter', 'business', 'enterprise')),
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

-- RLS placeholders (enable after Auth wiring)
-- alter table orgs enable row level security;
-- alter table org_members enable row level security;
-- alter table employees enable row level security;
-- alter table credentials enable row level security;
-- alter table approval_requests enable row level security;
-- alter table audit_events enable row level security;
-- alter table subscriptions enable row level security;

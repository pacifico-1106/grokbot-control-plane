-- AI社員 control plane — initial schema (Supabase Postgres)
-- Apply via Supabase SQL editor or migration tooling.

create extension if not exists "pgcrypto";

create table if not exists orgs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  integration_mode text not null check (integration_mode in ('managed', 'byo')),
  trial_ends_at timestamptz,
  stripe_customer_id text,
  created_at timestamptz not null default now()
);

create table if not exists employees (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  display_name text not null,
  role_label text not null,
  status text not null default 'active' check (status in ('active', 'suspended')),
  created_at timestamptz not null default now()
);

create table if not exists credentials (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete cascade,
  secret_hash text not null,
  scopes text[] not null default '{}',
  allowed_purposes text[] not null default '{}',
  approval_policy text not null default 'risk_based'
    check (approval_policy in ('auto', 'always_human', 'risk_based')),
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

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
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid
);

create table if not exists audit_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  employee_id uuid references employees(id),
  credential_id uuid references credentials(id),
  action text not null,
  purpose text,
  summary text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists audit_events_org_created_idx
  on audit_events (org_id, created_at desc);

create index if not exists approval_requests_org_status_idx
  on approval_requests (org_id, status, created_at desc);

-- RLS placeholders (enable after Auth wiring)
-- alter table orgs enable row level security;

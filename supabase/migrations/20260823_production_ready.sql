-- Additive migration: production-ready columns + RLS scaffolding
-- Safe to re-run (IF NOT EXISTS / DO blocks). Apply after base schema.sql
-- or alone on an existing project that already has core tables.

-- ---------------------------------------------------------------------------
-- employees: spend + allowed_accounts
-- ---------------------------------------------------------------------------
alter table employees
  add column if not exists spend jsonb,
  add column if not exists allowed_accounts jsonb not null default '[]'::jsonb;

-- ---------------------------------------------------------------------------
-- credentials: same policy columns for badge engraving
-- ---------------------------------------------------------------------------
alter table credentials
  add column if not exists spend jsonb,
  add column if not exists allowed_accounts jsonb not null default '[]'::jsonb;

-- ---------------------------------------------------------------------------
-- org_members: job role + capability flags
-- ---------------------------------------------------------------------------
alter table org_members
  add column if not exists job_role text not null default 'custom',
  add column if not exists job_label text,
  add column if not exists capabilities text[] not null default '{}';

create index if not exists org_members_user_idx on org_members (user_id)
  where user_id is not null;

-- ---------------------------------------------------------------------------
-- employee_bindings (create if missing — mirrors lib/bindings.ts)
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
-- RLS helper: org isolation via org_members.user_id = auth.uid()
-- Service role bypasses RLS (gateway / API admin client).
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
alter table audit_events enable row level security;
alter table subscriptions enable row level security;
alter table gateway_links enable row level security;
alter table employee_bindings enable row level security;

-- Drop+recreate named policies so migration is idempotent
do $$
declare
  pol text;
  pols text[] := array[
    'orgs_select_member', 'orgs_update_admin',
    'org_members_select', 'org_members_write_admin',
    'employees_select', 'employees_write_admin',
    'credentials_select', 'credentials_write_admin',
    'approvals_select', 'approvals_write_member',
    'audit_select', 'audit_insert_member',
    'subscriptions_select', 'subscriptions_write_admin',
    'gateway_select', 'gateway_write_admin',
    'bindings_select', 'bindings_write_admin'
  ];
begin
  foreach pol in array pols loop
    execute format('drop policy if exists %I on orgs', pol);
  end loop;
exception when others then
  null;
end $$;

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

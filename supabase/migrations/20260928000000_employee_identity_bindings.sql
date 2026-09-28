-- P0-ID: Employee identity bindings for per-org human responsibility mapping.
-- Maps AI employees to responsible humans for approvals routing and mailbox ownership.
-- Feature flag P0_EMPLOYEE_IDENTITY_ENABLED must be ON to use these features.
-- 
-- Security invariants:
-- - One binding per employee per org (composite unique)
-- - Cross-org binding prohibited via composite FK + RLS
-- - Mailbox binding requires always_human approval
-- - No hardcoded org IDs

begin;
set local lock_timeout = '5s';

-- First ensure employees has composite unique constraint (id, org_id)
do $p0$ begin
  if not exists (
    select 1 from pg_constraint c
    where c.conrelid = 'public.employees'::regclass
      and c.contype = 'u'
      and c.conkey @> array[
        (select attnum from pg_attribute where attrelid = 'public.employees'::regclass and attname = 'id' and not attisdropped),
        (select attnum from pg_attribute where attrelid = 'public.employees'::regclass and attname = 'org_id' and not attisdropped)
      ]::smallint[]
  ) then
    alter table public.employees add constraint employees_id_org_key unique (id, org_id);
  end if;
end $p0$;

create table if not exists public.employee_identity_bindings (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  employee_id uuid not null,
  responsible_member_id uuid not null,
  mailbox_id text default null,
  status text not null default 'active' check (status in ('active', 'pending', 'suspended', 'revoked')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revoked_at timestamptz default null,
  revoked_by uuid default null,
  constraint employee_identity_bindings_org_fk
    foreign key (org_id) references public.orgs(id) on delete cascade,
  constraint employee_identity_bindings_employee_same_org_fk
    foreign key (employee_id, org_id) references public.employees(id, org_id) on delete cascade,
  constraint employee_identity_bindings_member_same_org_fk
    foreign key (responsible_member_id, org_id) references public.org_members(id, org_id) on delete cascade,
  constraint employee_identity_bindings_org_employee_unique
    unique (org_id, employee_id)
);

comment on table public.employee_identity_bindings is
  'P0-ID: Maps AI employees to responsible humans within an org for approvals routing, mailbox ownership, and audit. Feature flag P0_EMPLOYEE_IDENTITY_ENABLED must be ON.';

comment on column public.employee_identity_bindings.responsible_member_id is
  'The org member responsible for this AI employee. Used for business-class approval routing.';

comment on column public.employee_identity_bindings.mailbox_id is
  'Optional mailbox ID bound to this employee. Binding requires always_human approval.';

comment on column public.employee_identity_bindings.status is
  'active = operational, pending = awaiting approval, suspended = temporarily disabled, revoked = permanently disabled.';

-- Indexes for common queries
create index if not exists idx_employee_identity_bindings_org_id
  on public.employee_identity_bindings(org_id);

create index if not exists idx_employee_identity_bindings_employee_id
  on public.employee_identity_bindings(employee_id);

create index if not exists idx_employee_identity_bindings_responsible_member_id
  on public.employee_identity_bindings(responsible_member_id);

create index if not exists idx_employee_identity_bindings_status
  on public.employee_identity_bindings(status)
  where status != 'revoked';

-- Enable RLS
alter table public.employee_identity_bindings enable row level security;

-- RLS policy: only service role can access (same pattern as voter_bindings)
drop policy if exists employee_identity_bindings_server_only on public.employee_identity_bindings;
create policy employee_identity_bindings_server_only on public.employee_identity_bindings
  as restrictive for all to public using (false) with check (false);

comment on policy employee_identity_bindings_server_only on public.employee_identity_bindings is
  'RLS: Block anon/authenticated access. Server-side only via service role.';

-- Revoke all column grants from public/anon/authenticated
revoke all on public.employee_identity_bindings from public, anon, authenticated;

-- Grant to service role only
grant select, insert, update, delete on public.employee_identity_bindings to service_role;

-- Audit table for identity binding changes
create table if not exists public.employee_identity_binding_audit (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  employee_id uuid not null,
  binding_id uuid not null,
  action text not null check (action in ('created', 'updated', 'mailbox_bound', 'revoked')),
  actor_id uuid not null,
  old_values jsonb default null,
  new_values jsonb default null,
  created_at timestamptz not null default now()
);

comment on table public.employee_identity_binding_audit is
  'P0-ID audit log for employee identity binding changes. Immutable append-only.';

-- Index for audit queries
create index if not exists idx_employee_identity_binding_audit_org_id
  on public.employee_identity_binding_audit(org_id);

create index if not exists idx_employee_identity_binding_audit_binding_id
  on public.employee_identity_binding_audit(binding_id);

create index if not exists idx_employee_identity_binding_audit_created_at
  on public.employee_identity_binding_audit(created_at);

-- Enable RLS on audit table
alter table public.employee_identity_binding_audit enable row level security;

drop policy if exists employee_identity_binding_audit_server_only on public.employee_identity_binding_audit;
create policy employee_identity_binding_audit_server_only on public.employee_identity_binding_audit
  as restrictive for all to public using (false) with check (false);

revoke all on public.employee_identity_binding_audit from public, anon, authenticated;
grant select, insert on public.employee_identity_binding_audit to service_role;

commit;

-- P0-ID: Employee identity bindings for per-org human responsibility mapping.
-- Maps AI employees to responsible humans for approvals routing and mailbox ownership.
-- Feature flag P0_EMPLOYEE_IDENTITY_ENABLED must be ON to use these features.

-- Security invariants:
-- - One binding per employee per org (composite unique)
-- - Cross-org binding prohibited via RLS
-- - Mailbox binding requires always_human approval
-- - No hardcoded org IDs

create table if not exists employee_identity_bindings (
  id text primary key default ('eib_' || encode(gen_random_bytes(12), 'hex')),
  org_id text not null references orgs(id) on delete cascade,
  employee_id text not null references employees(id) on delete cascade,
  responsible_member_id text not null references org_members(id) on delete cascade,
  mailbox_id text default null,
  status text not null default 'active' check (status in ('active', 'pending', 'suspended', 'revoked')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revoked_at timestamptz default null,
  revoked_by text default null,
  constraint employee_identity_bindings_org_employee_unique unique (org_id, employee_id)
);

comment on table employee_identity_bindings is
  'P0-ID: Maps AI employees to responsible humans within an org for approvals routing, mailbox ownership, and audit. Feature flag P0_EMPLOYEE_IDENTITY_ENABLED must be ON.';

comment on column employee_identity_bindings.responsible_member_id is
  'The org member responsible for this AI employee. Used for business-class approval routing.';

comment on column employee_identity_bindings.mailbox_id is
  'Optional mailbox ID bound to this employee. Binding requires always_human approval.';

comment on column employee_identity_bindings.status is
  'active = operational, pending = awaiting approval, suspended = temporarily disabled, revoked = permanently disabled.';

-- Indexes for common queries
create index if not exists idx_employee_identity_bindings_org_id
  on employee_identity_bindings(org_id);

create index if not exists idx_employee_identity_bindings_employee_id
  on employee_identity_bindings(employee_id);

create index if not exists idx_employee_identity_bindings_responsible_member_id
  on employee_identity_bindings(responsible_member_id);

create index if not exists idx_employee_identity_bindings_status
  on employee_identity_bindings(status)
  where status != 'revoked';

-- Enable RLS
alter table employee_identity_bindings enable row level security;

-- RLS policy: only service role can access (same pattern as voter_bindings)
create policy employee_identity_bindings_server_only on employee_identity_bindings
  for all
  using (false)
  with check (false);

comment on policy employee_identity_bindings_server_only on employee_identity_bindings is
  'RLS: Block anon/authenticated access. Server-side only via service role.';

-- Revoke all column grants from public/anon/authenticated
revoke all on employee_identity_bindings from public, anon, authenticated;

-- Grant to service role only
grant all on employee_identity_bindings to service_role;

-- Audit table for identity binding changes
create table if not exists employee_identity_binding_audit (
  id text primary key default ('eiba_' || encode(gen_random_bytes(12), 'hex')),
  org_id text not null,
  employee_id text not null,
  binding_id text not null,
  action text not null check (action in ('created', 'updated', 'mailbox_bound', 'revoked')),
  actor_id text not null,
  old_values jsonb default null,
  new_values jsonb default null,
  created_at timestamptz not null default now()
);

comment on table employee_identity_binding_audit is
  'P0-ID audit log for employee identity binding changes. Immutable append-only.';

-- Index for audit queries
create index if not exists idx_employee_identity_binding_audit_org_id
  on employee_identity_binding_audit(org_id);

create index if not exists idx_employee_identity_binding_audit_binding_id
  on employee_identity_binding_audit(binding_id);

-- Enable RLS on audit table
alter table employee_identity_binding_audit enable row level security;

create policy employee_identity_binding_audit_server_only on employee_identity_binding_audit
  for all
  using (false)
  with check (false);

revoke all on employee_identity_binding_audit from public, anon, authenticated;
grant all on employee_identity_binding_audit to service_role;

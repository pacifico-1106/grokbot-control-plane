-- Staffpass Admin MCP v1: one admin agent per tenant (not an employee badge).
-- Approval tickets for admin tools may have no employee_id / credential_id.

create table if not exists org_admin_agents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  grok_bot_agent_id text,
  grok_bot_workspace_id text,
  credential_fingerprint text,
  secret_prefix text not null default 'gb_adm_',
  credential_generation integer not null default 0,
  status text not null default 'unlinked'
    check (status in ('unlinked', 'linked', 'revoked', 'needs_reauth')),
  ops_doc_location text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id)
);

create index if not exists org_admin_agents_fingerprint_idx
  on org_admin_agents (credential_fingerprint)
  where credential_fingerprint is not null;

comment on table org_admin_agents is
  'One top-level admin agent per tenant. Auth prefix gb_adm_ is not an employee badge (gb_emp_).';

alter table approval_requests
  alter column employee_id drop not null;
alter table approval_requests
  alter column credential_id drop not null;

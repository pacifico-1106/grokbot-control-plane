-- P0.5 AgentMail schema reservation (no live send).
-- Email layers: human_gmail / agentmail / staffpass_resend — never mix.

create table if not exists agentmail_inboxes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete cascade,
  inbox_id text,
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

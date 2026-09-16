-- F8 Approval Workflow: org/employee policy + workflow instances + ballots
-- Enables quorum-based multi-approver workflows with sequential stages and optional finalGo

-- Org-level approval workflow policy (opt-in; null = current OR / single-approver)
alter table orgs
  add column if not exists approval_workflow_policy jsonb default null;

comment on column orgs.approval_workflow_policy is
  'F8 approval workflow policy: stages with quorum (any/count/ratio/majority), finalGoUserId, onReject=fail_closed. Null = current 1-approver OR.';

-- Optional per-employee override (same shape as org)
alter table employees
  add column if not exists approval_workflow_policy jsonb default null;

comment on column employees.approval_workflow_policy is
  'F8 optional per-employee approval workflow policy override. Null = inherit org policy.';

-- Workflow instances: one per approval_request when workflow applies
create table if not exists approval_workflow_instances (
  id uuid primary key default gen_random_uuid(),
  approval_id uuid not null references approval_requests(id) on delete cascade,
  org_id uuid not null references orgs(id) on delete cascade,
  policy_id text not null,
  policy_snapshot jsonb not null,
  current_stage_index integer not null default 0,
  status text not null default 'active'
    check (status in ('active', 'approved', 'rejected', 'expired')),
  final_go_pending boolean not null default false,
  final_go_user_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (approval_id)
);

create index if not exists workflow_instances_approval_idx
  on approval_workflow_instances (approval_id);
create index if not exists workflow_instances_org_status_idx
  on approval_workflow_instances (org_id, status);

comment on table approval_workflow_instances is
  'F8 workflow instance per approval ticket. Tracks current stage and finalGo status.';

-- Ballots: individual votes in a workflow stage
create table if not exists approval_workflow_ballots (
  id uuid primary key default gen_random_uuid(),
  instance_id uuid not null references approval_workflow_instances(id) on delete cascade,
  org_id uuid not null references orgs(id) on delete cascade,
  stage_id text not null,
  stage_index integer not null,
  voter_user_id text not null,
  vote text check (vote in ('approve', 'reject', null)),
  voted_at timestamptz,
  is_final_go boolean not null default false,
  created_at timestamptz not null default now(),
  unique (instance_id, stage_id, voter_user_id)
);

create index if not exists workflow_ballots_instance_idx
  on approval_workflow_ballots (instance_id, stage_index);
create index if not exists workflow_ballots_voter_idx
  on approval_workflow_ballots (voter_user_id, vote)
  where vote is null;

comment on table approval_workflow_ballots is
  'F8 individual votes: actor, stage, vote (approve/reject/null=pending), at. Audit trail for quorum decisions.';

-- RLS policies
alter table approval_workflow_instances enable row level security;
alter table approval_workflow_ballots enable row level security;

drop policy if exists workflow_instances_select on approval_workflow_instances;
drop policy if exists workflow_instances_write_admin on approval_workflow_instances;
create policy workflow_instances_select on approval_workflow_instances
  for select using (public.is_org_member(org_id));
create policy workflow_instances_write_admin on approval_workflow_instances
  for all using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));

drop policy if exists workflow_ballots_select on approval_workflow_ballots;
drop policy if exists workflow_ballots_write_admin on approval_workflow_ballots;
create policy workflow_ballots_select on approval_workflow_ballots
  for select using (public.is_org_member(org_id));
create policy workflow_ballots_write_admin on approval_workflow_ballots
  for all using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));

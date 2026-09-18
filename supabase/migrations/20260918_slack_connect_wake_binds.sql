-- G7 Slack Connect→own-tenant employee wake routing (stub/scaffold).
-- Explicit bind table for cross-org wake when a Connect guest is mentioned.
-- Feature flag G7_CONNECT_WAKE_ROUTING=1 (default OFF — this is scaffold only).
--
-- SMOKE TARGET (Design Lock 2026-09-18):
-- First smoke path: TOKYO307 #aitest → explicit bind → Mirai Tomori wake.
-- Channel IDs NOT hardcoded; smoke fixture TBD in admin MCP tooling PR.
--
-- SECURITY DESIGN:
-- - Tenant isolation: binds are scoped to (receiving_org, target_org) pairs.
-- - Fail-closed: missing or ambiguous (>1) binds do NOT wake.
-- - No cross-org guessing by display name; explicit admin bind only.
-- - Service-role only (same pattern as slack_im_employee_routes).

create table if not exists slack_connect_wake_binds (
  id uuid primary key default gen_random_uuid(),

  -- The org/team where the mention is received (Connect host workspace)
  receiving_org_id uuid not null references orgs(id) on delete cascade,
  receiving_team_id text not null,

  -- The Connect guest's Slack user ID that was mentioned
  mentioned_slack_user_id text not null,

  -- The target employee's home org and employee id to wake
  target_org_id uuid not null references orgs(id) on delete cascade,
  target_employee_id uuid not null references employees(id) on delete cascade,

  -- Soft enable/disable without deleting the bind
  enabled boolean not null default true,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Unique constraint: one bind per (receiving context, mentioned user).
-- Prevents ambiguous doubles — exactly 0 or 1 row should match any lookup.
create unique index if not exists slack_connect_wake_binds_uniq_idx
  on slack_connect_wake_binds (receiving_org_id, receiving_team_id, mentioned_slack_user_id)
  where enabled = true;

-- Lookup index: fast path for resolveWakeTargets query
create index if not exists slack_connect_wake_binds_lookup_idx
  on slack_connect_wake_binds (receiving_team_id, mentioned_slack_user_id)
  where enabled = true;

-- Employee cascade index for FK performance
create index if not exists slack_connect_wake_binds_employee_idx
  on slack_connect_wake_binds (target_employee_id);

-- Target org index for admin listing
create index if not exists slack_connect_wake_binds_target_org_idx
  on slack_connect_wake_binds (target_org_id);

comment on table slack_connect_wake_binds is
  'G7 explicit binds for Slack Connect cross-org wake routing. Admin-created only; service-role access. Feature flag G7_CONNECT_WAKE_ROUTING must be ON for wake path to use this table.';
comment on column slack_connect_wake_binds.receiving_org_id is
  'Org that owns the receiving Slack workspace (Connect host).';
comment on column slack_connect_wake_binds.receiving_team_id is
  'Slack team/workspace ID where the mention event arrives.';
comment on column slack_connect_wake_binds.mentioned_slack_user_id is
  'Connect guest Slack user ID (U…/W…) that was @-mentioned.';
comment on column slack_connect_wake_binds.target_org_id is
  'Home org of the employee to wake (may differ from receiving_org_id in Connect scenarios).';
comment on column slack_connect_wake_binds.target_employee_id is
  'Employee to wake when this bind matches. Must be active at wake time (runtime check).';
comment on column slack_connect_wake_binds.enabled is
  'Soft toggle. Disabled binds are excluded from lookup (unique constraint + index filter).';

-- RLS: service-role only (same pattern as slack_im_employee_routes / slack_mention_events).
-- No browser-accessible policy — admin MCP tooling will manage binds.
alter table slack_connect_wake_binds enable row level security;

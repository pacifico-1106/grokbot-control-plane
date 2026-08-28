-- Slack conversation posting identity: org bot (xoxb) vs employee user (xoxp via Staffpass Slack OAuth).
-- Apply this in the production Supabase SQL editor (same as 20260828 audience migrations).
-- Secrets never go to the dashboard: employee_slack_identity_secrets is service-role only.

alter table employees
  add column if not exists posting_as text not null default 'bot';

alter table employees
  drop constraint if exists employees_posting_as_check;
alter table employees
  add constraint employees_posting_as_check
  check (posting_as in ('bot', 'user'));

comment on column employees.posting_as is
  'Conversation posting identity on the employee badge: bot = org xoxb adapter; user = OAuth-bound xoxp. Not org-wide.';

create table if not exists employee_slack_identities (
  employee_id uuid primary key references employees(id) on delete cascade,
  org_id uuid not null references orgs(id) on delete cascade,
  slack_user_id text not null,
  slack_team_id text not null default '',
  display_name text not null default '',
  status text not null default 'linked'
    check (status in ('linked', 'needs_reauth', 'revoked')),
  updated_at timestamptz not null default now()
);

create index if not exists employee_slack_identities_org_idx
  on employee_slack_identities (org_id, status);

create table if not exists employee_slack_identity_secrets (
  employee_id uuid primary key references employees(id) on delete cascade,
  credentials_ciphertext text not null,
  updated_at timestamptz not null default now()
);

comment on table employee_slack_identities is
  'Public Slack user binding for postingAs=user. Dashboard may select this; never join secrets.';
comment on table employee_slack_identity_secrets is
  'Service-role-only encrypted Slack user tokens (NOTIFICATION_CONFIG_ENCRYPTION_KEY). Intentionally inaccessible via browser RLS.';

alter table employee_slack_identities enable row level security;
alter table employee_slack_identity_secrets enable row level security;

drop policy if exists employee_slack_identities_select on employee_slack_identities;
drop policy if exists employee_slack_identities_write_admin on employee_slack_identities;
create policy employee_slack_identities_select on employee_slack_identities
  for select using (public.is_org_member(org_id));
create policy employee_slack_identities_write_admin on employee_slack_identities
  for all using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));

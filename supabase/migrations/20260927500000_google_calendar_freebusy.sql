-- Google Calendar free/busy read integration tables.
-- IMPORTANT: Apply this migration BEFORE merging the feature PR.
-- Feature flag GOOGLE_CALENDAR_READ_ENABLED must remain OFF until security audit complete.

-- ---------------------------------------------------------------------------
-- Employee Google Identities (public binding — no secrets)
-- ---------------------------------------------------------------------------
create table if not exists employee_google_identities (
  employee_id uuid primary key references employees(id) on delete cascade,
  org_id uuid not null references orgs(id) on delete cascade,
  google_sub text not null,
  google_email text not null,
  granted_scopes text not null,
  status text not null default 'linked'
    check (status in ('linked', 'needs_reauth', 'revoked')),
  connected_at timestamptz not null default now(),
  revoked_at timestamptz,
  updated_at timestamptz not null default now()
);

comment on table employee_google_identities is
  'Public Google account binding for calendar.freebusy read. Dashboard may select this; never join secrets.';
comment on column employee_google_identities.google_sub is
  'Google user ID (sub claim from ID token). Stable identifier.';
comment on column employee_google_identities.google_email is
  'Google account email. May change if user updates their email.';
comment on column employee_google_identities.granted_scopes is
  'Space-separated OAuth scopes granted at connect time. Validated at callback.';
comment on column employee_google_identities.status is
  'linked = active, needs_reauth = token refresh failed, revoked = user disconnected.';

create index if not exists employee_google_identities_org_idx
  on employee_google_identities (org_id, status);

create index if not exists employee_google_identities_sub_idx
  on employee_google_identities (google_sub)
  where status = 'linked';

-- ---------------------------------------------------------------------------
-- Employee Google Identity Secrets (service_role only — encrypted refresh tokens)
-- ---------------------------------------------------------------------------
create table if not exists employee_google_identity_secrets (
  employee_id uuid primary key references employees(id) on delete cascade,
  credentials_ciphertext text not null,
  updated_at timestamptz not null default now()
);

comment on table employee_google_identity_secrets is
  'Service-role-only encrypted Google refresh tokens (NOTIFICATION_CONFIG_ENCRYPTION_KEY). Intentionally inaccessible via browser RLS.';

-- ---------------------------------------------------------------------------
-- Calendar Read Grants (allowlist for which calendars an employee may query)
-- ---------------------------------------------------------------------------
create table if not exists calendar_read_grants (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  employee_id uuid references employees(id) on delete cascade,
  calendar_id text not null,
  label text not null default '',
  created_by uuid references org_members(id) on delete set null,
  approval_id uuid references approval_requests(id) on delete set null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

comment on table calendar_read_grants is
  'Allowlist for Google Calendar IDs that AI employees may read free/busy data from.';
comment on column calendar_read_grants.employee_id is
  'NULL = org-wide grant (any employee in org). Non-null = per-employee grant.';
comment on column calendar_read_grants.calendar_id is
  'Google Calendar ID (email format, e.g. user@example.com or resource calendar).';
comment on column calendar_read_grants.approval_id is
  'Approval that authorized this grant. calendar.allowlist.patch is forceNeedsApproval.';

create index if not exists calendar_read_grants_org_idx
  on calendar_read_grants (org_id, employee_id)
  where revoked_at is null;

create index if not exists calendar_read_grants_calendar_idx
  on calendar_read_grants (org_id, calendar_id)
  where revoked_at is null;

create unique index if not exists calendar_read_grants_unique_active
  on calendar_read_grants (org_id, coalesce(employee_id, '00000000-0000-0000-0000-000000000000'::uuid), calendar_id)
  where revoked_at is null;

-- ---------------------------------------------------------------------------
-- RLS Policies
-- ---------------------------------------------------------------------------
alter table employee_google_identities enable row level security;
alter table employee_google_identity_secrets enable row level security;
alter table calendar_read_grants enable row level security;

-- Google identities: members can SELECT only. Writes via service_role (OAuth callback).
drop policy if exists google_identities_select on employee_google_identities;
drop policy if exists google_identities_write_admin on employee_google_identities;
create policy google_identities_select on employee_google_identities
  for select using (public.is_org_member(org_id));
-- No write policy for browser — only service_role bypasses RLS for writes.

-- Google identity secrets: service_role only (no browser access at all)
-- No RLS policies for anon/authenticated — only service_role bypasses RLS
revoke all on employee_google_identity_secrets from anon, authenticated;

-- Calendar read grants: members can SELECT only. Writes via service_role (approved allowlist.patch).
drop policy if exists calendar_read_grants_select on calendar_read_grants;
drop policy if exists calendar_read_grants_write_admin on calendar_read_grants;
create policy calendar_read_grants_select on calendar_read_grants
  for select using (public.is_org_member(org_id));
-- No write policy for browser — only service_role bypasses RLS for writes.

-- Revoke insert/update/delete from browser roles (they can only SELECT via policy above)
revoke insert, update, delete on employee_google_identities from anon, authenticated;
revoke insert, update, delete on calendar_read_grants from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Audit log for calendar reads (append-only, no secrets)
-- ---------------------------------------------------------------------------
-- Calendar read audit is recorded in the existing audit_events table
-- with action = 'calendar.freebusy_read'.
-- Metadata includes: calendar_ids requested, calendar_ids allowed, timeMin, timeMax,
-- busy_interval_count, errors (per-calendar), but NEVER tokens or event contents.

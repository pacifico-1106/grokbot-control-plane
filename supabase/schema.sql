-- AI社員 for Grok Bot — control plane schema (Supabase Postgres)
-- Apply via Supabase SQL editor or `supabase db push`.
-- Fresh apply includes production-ready columns + RLS.
-- Existing projects: also apply supabase/migrations/20260823_production_ready.sql

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Organizations
-- ---------------------------------------------------------------------------
create table if not exists orgs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  integration_mode text not null default 'managed'
    check (integration_mode in ('managed', 'byo')),
  gateway_status text not null default 'pending'
    check (gateway_status in ('linked', 'pending', 'disconnected')),
  trial_ends_at timestamptz,
  stripe_customer_id text,
  referral_code text,
  sod_warn_policy jsonb not null default '{
    "domains": ["comm_external", "money", "destructive", "commit"]
  }'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists org_members (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  user_id uuid, -- supabase auth.users.id when wired
  email text not null,
  display_name text not null default '',
  role text not null default 'member'
    check (role in ('owner', 'admin', 'member')),
  job_role text not null default 'custom',
  job_label text,
  capabilities text[] not null default '{}',
  status text not null default 'active'
    check (status in ('active', 'invited', 'disabled')),
  invited_at timestamptz,
  created_at timestamptz not null default now(),
  unique (org_id, email)
);

create index if not exists org_members_org_idx on org_members (org_id, role);
create index if not exists org_members_user_idx on org_members (user_id)
  where user_id is not null;

-- ---------------------------------------------------------------------------
-- AI employees + credentials (社員証)
-- ---------------------------------------------------------------------------
create table if not exists employees (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  display_name text not null,
  role_label text not null,
  job_description text not null default '',
  status text not null default 'active'
    check (status in ('active', 'suspended', 'draft')),
  scopes text[] not null default '{}',
  allowed_purposes text[] not null default '{}',
  approval_policy text not null default 'risk_based'
    check (approval_policy in ('auto', 'always_human', 'risk_based')),
  sod_level text not null default 'ok'
    check (sod_level in ('ok', 'warn', 'force_human')),
  action_limits jsonb not null default '{}'::jsonb,
  tool_approval_defaults jsonb not null default '{
    "mail.send": "always_human",
    "calendar.confirm": "always_human",
    "commerce.order": "always_human",
    "files.write": "always_human",
    "drive.share_external": "always_human",
    "browser.use": "always_human"
  }'::jsonb,
  spend jsonb,
  allowed_accounts jsonb not null default '[]'::jsonb,
  approval_notify_email text,
  callback_url text,
  approval_routine_text text,
  manager_id uuid references org_members(id) on delete set null,
  voice jsonb not null default '{
    "template": "polite",
    "register": "polite",
    "endings": "desumasu",
    "forbidden": ["了解", "ぶっちゃけ", "ヤバい", "マジで", "ごめん"],
    "signOff": "何卒よろしくお願いいたします",
    "externalFloor": "polite"
  }'::jsonb,
  project_access jsonb not null default '{"mode":"company","projectIds":[]}'::jsonb,
  posting_as text not null default 'bot'
    check (posting_as in ('bot', 'user')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on column employees.voice is
  'AI employee badge character/register (polite/frank/custom). External audience cannot drop below polite.';
comment on column employees.project_access is
  'Badge project wall: {mode: company|selected|all, projectIds: string[]}. Default company = 会社全般 only.';
comment on column employees.posting_as is
  'Conversation posting identity on the employee badge: bot = org xoxb adapter; user = OAuth-bound xoxp.';

create index if not exists employees_org_idx on employees (org_id, status);
create index if not exists employees_manager_idx on employees (org_id, manager_id)
  where manager_id is not null;

create or replace function public.employees_manager_same_org()
returns trigger
language plpgsql
as $$
begin
  if new.manager_id is null then
    return new;
  end if;
  if not exists (
    select 1 from org_members m
    where m.id = new.manager_id and m.org_id = new.org_id
  ) then
    raise exception 'manager_org_mismatch';
  end if;
  return new;
end;
$$;

drop trigger if exists employees_manager_same_org on employees;
create trigger employees_manager_same_org
  before insert or update of manager_id, org_id on employees
  for each row execute function public.employees_manager_same_org();

create table if not exists credentials (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete cascade,
  secret_hash text not null,
  secret_prefix text not null default 'gb_emp_',
  scopes text[] not null default '{}',
  allowed_purposes text[] not null default '{}',
  approval_policy text not null default 'risk_based'
    check (approval_policy in ('auto', 'always_human', 'risk_based')),
  action_limits jsonb not null default '{}'::jsonb,
  spend jsonb,
  allowed_accounts jsonb not null default '[]'::jsonb,
  expires_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists credentials_employee_idx on credentials (employee_id);
create index if not exists credentials_org_active_idx
  on credentials (org_id) where revoked_at is null;

create table if not exists action_counters (
  org_id uuid not null references orgs(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete cascade,
  period text not null check (period ~ '^[0-9]{4}-[0-9]{2}$'),
  tool text not null,
  count integer not null default 0 check (count >= 0),
  updated_at timestamptz not null default now(),
  primary key (org_id, employee_id, period, tool)
);

create index if not exists action_counters_employee_period_idx
  on action_counters (employee_id, period);

-- ---------------------------------------------------------------------------
-- Approvals (要対応)
-- ---------------------------------------------------------------------------
create table if not exists approval_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  employee_id uuid not null references employees(id),
  credential_id uuid not null references credentials(id),
  purpose text not null,
  summary text not null,
  title text,
  tool text,
  job_id text,
  revision_note text,
  revision_count integer not null default 0,
  telegram_message_id bigint,
  telegram_ref text not null default encode(gen_random_bytes(6), 'hex'),
  parent_approval_id uuid references approval_requests(id) on delete set null,
  status_token text,
  poll_path text,
  risk text not null check (risk in ('low', 'medium', 'high')),
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'expired', 'revision_requested')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid
);

create index if not exists approval_requests_org_status_idx
  on approval_requests (org_id, status, created_at desc);

create index if not exists approval_requests_status_token_idx
  on approval_requests (id, status_token);

create unique index if not exists approval_requests_telegram_ref_idx
  on approval_requests (telegram_ref);
create index if not exists approval_requests_telegram_msg_idx
  on approval_requests (telegram_message_id);
create index if not exists approval_requests_job_idx
  on approval_requests (org_id, job_id);

create table if not exists org_notification_channels (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  provider text not null check (provider in ('telegram','line','slack')),
  label text not null,
  enabled boolean not null default false,
  config jsonb not null default '{}'::jsonb,
  webhook_ref text not null default encode(gen_random_bytes(6), 'hex'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, provider),
  unique (webhook_ref)
);

create table if not exists org_notification_channel_secrets (
  channel_id uuid primary key references org_notification_channels(id) on delete cascade,
  credentials_ciphertext text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists approval_notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  approval_id uuid not null references approval_requests(id) on delete cascade,
  org_id uuid not null references orgs(id) on delete cascade,
  channel_id uuid not null references org_notification_channels(id) on delete cascade,
  provider text not null check (provider in ('telegram','line','slack')),
  external_message_id text,
  context jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (approval_id, channel_id)
);

create index if not exists notification_channels_org_enabled_idx
  on org_notification_channels (org_id, enabled);
create index if not exists notification_deliveries_external_idx
  on approval_notification_deliveries (channel_id, external_message_id);


create table if not exists org_conversation_adapters (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  surface text not null check (surface in ('slack','line','mail','phone','web')),
  label text not null default 'Slack',
  enabled boolean not null default false,
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, surface)
);

create table if not exists org_conversation_adapter_secrets (
  adapter_id uuid primary key references org_conversation_adapters(id) on delete cascade,
  credentials_ciphertext text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists conversation_adapters_org_enabled_idx
  on org_conversation_adapters (org_id, enabled);

create table if not exists org_sns_adapters (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  surface text not null check (surface in ('x','note','linkedin','youtube')),
  label text not null default 'SNS',
  enabled boolean not null default false,
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, surface)
);

create table if not exists org_sns_adapter_secrets (
  adapter_id uuid primary key references org_sns_adapters(id) on delete cascade,
  credentials_ciphertext text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists sns_adapters_org_enabled_idx
  on org_sns_adapters (org_id, enabled);

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

create index if not exists employee_slack_identities_user_status_idx
  on employee_slack_identities (slack_user_id, status);

create index if not exists employee_slack_identities_team_user_idx
  on employee_slack_identities (slack_team_id, slack_user_id)
  where status = 'linked';

create table if not exists employee_binding_secrets (
  employee_id uuid primary key references employees(id) on delete cascade,
  credentials_ciphertext text not null,
  updated_at timestamptz not null default now()
);

comment on table employee_binding_secrets is
  'Service-role-only encrypted wake webhook sender key (NOTIFICATION_CONFIG_ENCRYPTION_KEY). Intentionally inaccessible via browser RLS.';

create table if not exists slack_mention_events (
  event_id text primary key,
  received_at timestamptz not null default now()
);

comment on table slack_mention_events is
  'Idempotency for Slack Event Subscriptions retries (PK event_id). Service-role only.';

-- ---------------------------------------------------------------------------
-- Audit timeline
-- ---------------------------------------------------------------------------
create table if not exists audit_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  employee_id uuid references employees(id),
  credential_id uuid references credentials(id),
  actor_email text,
  action text not null,
  purpose text,
  summary text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists audit_events_org_created_idx
  on audit_events (org_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Subscriptions (Stripe)
-- ---------------------------------------------------------------------------
create table if not exists subscriptions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  plan_key text not null default 'business'
    check (plan_key in ('starter', 'business', 'managed')),
  status text not null default 'trialing'
    check (status in ('trialing', 'active', 'past_due', 'canceled', 'incomplete', 'unpaid')),
  stripe_subscription_id text,
  stripe_price_id text,
  trial_ends_at timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id)
);

create table if not exists gateway_links (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  mode text not null check (mode in ('managed', 'byo')),
  status text not null default 'pending'
    check (status in ('linked', 'pending', 'disconnected')),
  workspace_ref text,
  last_handshake_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id)
);

-- ---------------------------------------------------------------------------
-- Durable Grok Bot ↔ AI-employee bindings (lifeline)
-- employee_id is stable forever; rotate bumps credential_generation only.
-- Fail-closed: gateway refuses unbound / revoked / needs_reauth.
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
  wake_webhook_url text,
  has_wake_webhook boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists employee_bindings_org_status_idx
  on employee_bindings (org_id, status);

create index if not exists employee_bindings_needs_reauth_idx
  on employee_bindings (org_id)
  where status = 'needs_reauth';

-- ---------------------------------------------------------------------------
-- Audience / information-class directory (conversation adapters, not notify)
-- ---------------------------------------------------------------------------
create table if not exists org_parties (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  kind text not null check (kind in ('email_domain','slack_channel','slack_user','phone','line','mail_address')),
  identifier text not null,
  audience text not null check (audience in ('internal','external')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, kind, identifier)
);

create index if not exists org_parties_org_kind_idx on org_parties (org_id, kind);

create table if not exists org_channels (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  surface text not null check (surface in ('slack','line','mail','phone','web')),
  external_id text not null,
  classification text not null default 'unknown'
    check (classification in ('internal','shared_external','unknown')),
  mixed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, surface, external_id)
);

create index if not exists org_channels_org_surface_idx on org_channels (org_id, surface);

create table if not exists org_projects (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  slug text not null,
  name text not null,
  description text not null default '',
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, slug)
);

create unique index if not exists org_projects_one_default_per_org
  on org_projects (org_id)
  where is_default;

create index if not exists org_projects_org_idx on org_projects (org_id, slug);

create table if not exists information_assets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  ref text not null,
  class text not null check (class in ('public','internal','confidential','verbatim')),
  project_id uuid references org_projects(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, ref)
);

create index if not exists information_assets_org_idx on information_assets (org_id, ref);
create index if not exists information_assets_project_idx on information_assets (org_id, project_id);

-- ---------------------------------------------------------------------------
-- RLS: org isolation via org_members.user_id = auth.uid()
-- Service role bypasses RLS (gateway / admin API).
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
alter table action_counters enable row level security;
alter table approval_requests enable row level security;
alter table org_notification_channels enable row level security;
alter table org_notification_channel_secrets enable row level security;
alter table approval_notification_deliveries enable row level security;
alter table org_conversation_adapters enable row level security;
alter table org_conversation_adapter_secrets enable row level security;
alter table org_sns_adapters enable row level security;
alter table org_sns_adapter_secrets enable row level security;
alter table employee_slack_identities enable row level security;
alter table employee_binding_secrets enable row level security;
alter table slack_mention_events enable row level security;
alter table employee_slack_identity_secrets enable row level security;
alter table audit_events enable row level security;
alter table subscriptions enable row level security;
alter table gateway_links enable row level security;
alter table employee_bindings enable row level security;
alter table org_parties enable row level security;
alter table org_channels enable row level security;
alter table information_assets enable row level security;
alter table org_projects enable row level security;

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

drop policy if exists action_counters_select on action_counters;
create policy action_counters_select on action_counters
  for select using (public.is_org_member(org_id));

drop policy if exists approvals_select on approval_requests;
drop policy if exists approvals_write_member on approval_requests;
create policy approvals_select on approval_requests
  for select using (public.is_org_member(org_id));
create policy approvals_write_member on approval_requests
  for all using (public.is_org_member(org_id));

drop policy if exists notification_channels_select on org_notification_channels;
drop policy if exists notification_channels_write_admin on org_notification_channels;
create policy notification_channels_select on org_notification_channels
  for select using (public.is_org_member(org_id));
create policy notification_channels_write_admin on org_notification_channels
  for all using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));

drop policy if exists notification_deliveries_select on approval_notification_deliveries;
create policy notification_deliveries_select on approval_notification_deliveries
  for select using (public.is_org_member(org_id));

drop policy if exists conversation_adapters_select on org_conversation_adapters;
drop policy if exists conversation_adapters_write_admin on org_conversation_adapters;
create policy conversation_adapters_select on org_conversation_adapters
  for select using (public.is_org_member(org_id));
create policy conversation_adapters_write_admin on org_conversation_adapters
  for all using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));

drop policy if exists sns_adapters_select on org_sns_adapters;
drop policy if exists sns_adapters_write_admin on org_sns_adapters;
create policy sns_adapters_select on org_sns_adapters
  for select using (public.is_org_member(org_id));
create policy sns_adapters_write_admin on org_sns_adapters
  for all using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));

drop policy if exists employee_slack_identities_select on employee_slack_identities;
drop policy if exists employee_slack_identities_write_admin on employee_slack_identities;
create policy employee_slack_identities_select on employee_slack_identities
  for select using (public.is_org_member(org_id));
create policy employee_slack_identities_write_admin on employee_slack_identities
  for all using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));

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

drop policy if exists org_parties_select on org_parties;
drop policy if exists org_parties_write_admin on org_parties;
create policy org_parties_select on org_parties
  for select using (public.is_org_member(org_id));
create policy org_parties_write_admin on org_parties
  for all using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));

drop policy if exists org_channels_select on org_channels;
drop policy if exists org_channels_write_admin on org_channels;
create policy org_channels_select on org_channels
  for select using (public.is_org_member(org_id));
create policy org_channels_write_admin on org_channels
  for all using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));

drop policy if exists information_assets_select on information_assets;
drop policy if exists information_assets_write_admin on information_assets;
create policy information_assets_select on information_assets
  for select using (public.is_org_member(org_id));
create policy information_assets_write_admin on information_assets
  for all using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));

drop policy if exists org_projects_select on org_projects;
drop policy if exists org_projects_write_admin on org_projects;
create policy org_projects_select on org_projects
  for select using (public.is_org_member(org_id));
create policy org_projects_write_admin on org_projects
  for all using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));

create or replace function public.increment_action_counter(
  p_org_id uuid,
  p_employee_id uuid,
  p_period text,
  p_tool text
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  next_count integer;
begin
  if p_period !~ '^[0-9]{4}-[0-9]{2}$' or trim(p_tool) = '' then
    raise exception 'invalid_action_counter_input';
  end if;
  if not exists (
    select 1 from employees where id = p_employee_id and org_id = p_org_id
  ) then
    raise exception 'employee_org_mismatch';
  end if;
  insert into action_counters (org_id, employee_id, period, tool, count, updated_at)
  values (p_org_id, p_employee_id, p_period, p_tool, 1, now())
  on conflict (org_id, employee_id, period, tool)
  do update set count = action_counters.count + 1, updated_at = now()
  returning count into next_count;
  return next_count;
end;
$$;

revoke all on function public.increment_action_counter(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.increment_action_counter(uuid, uuid, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- AgentMail reservation (P0.5) — schema/policy only; no live provider wiring in P0.
-- Email layers: human_gmail | agentmail | staffpass_resend — never mix.
-- ---------------------------------------------------------------------------
create table if not exists agentmail_inboxes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete cascade,
  inbox_id text, -- provider inbox id when provisioned (P1)
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

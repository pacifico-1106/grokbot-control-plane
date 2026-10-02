-- P1 Channel Scope (CS1 data layer): per-AI-employee channel coverage.
-- Design: channel-scope-design-20261002.md §2 / §3 / §11.
-- Feature flags (default OFF): P1_CHANNEL_SCOPE_ENABLED, P1_CHANNEL_SCOPE_CONNECT_ENABLED.
-- With the flags OFF nothing reads or writes these columns/tables (byte-identical behavior).
-- Safe to re-run (IF NOT EXISTS / DROP ... IF EXISTS / guarded DO blocks).
--
-- Security invariants:
-- - Policy columns (orgs.channel_scope_policy / employees.channel_scope_override) are written
--   only by the server (service_role) after owner approval (channelScope.patch, CS2).
--   A trigger rejects writes from anon/authenticated even though orgs/employees have
--   admin-writable RLS policies (an org admin JWT must not widen scope without approval).
-- - employee_channel_memberships: RLS on, deny-by-default (restrictive false policy),
--   no grants to anon/authenticated, service_role only.
-- - Membership rows are tenant-bound: composite FK (employee_id, org_id) -> employees(id, org_id).
-- - Exactly one PRIMARY KEY per table (table-level PK is NOT combined with a column PK).
-- - No reference to the nonexistent "members" table; org members live in public.org_members.

begin;
set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1) Policy columns: org default + per-employee override (JSON, validated in app code)
-- ---------------------------------------------------------------------------
alter table public.orgs
  add column if not exists channel_scope_policy jsonb default null;

comment on column public.orgs.channel_scope_policy is
  'P1 channel scope tenant default {version:1, mode: registered_only|all_joined, includeSlackConnect, surfaces, connect{egress, notifyApproverOnInvite, allowedExternalTeamIds}}. NULL = safe default registered_only. Written only via owner-approved channelScope.patch. Flag P1_CHANNEL_SCOPE_ENABLED.';

alter table public.employees
  add column if not exists channel_scope_override jsonb default null;

comment on column public.employees.channel_scope_override is
  'P1 per-employee channel scope override (same shape as orgs.channel_scope_policy). NULL = inherit org policy. Resolution: employee > org > registered_only. Flag P1_CHANNEL_SCOPE_ENABLED.';

-- JSON shape guard (cheap structural check; full validation is in lib/channel-scope/validate.ts)
alter table public.orgs drop constraint if exists orgs_channel_scope_policy_shape;
alter table public.orgs add constraint orgs_channel_scope_policy_shape check (
  channel_scope_policy is null
  or (jsonb_typeof(channel_scope_policy) = 'object'
      and channel_scope_policy->>'mode' in ('registered_only', 'all_joined'))
);

alter table public.employees drop constraint if exists employees_channel_scope_override_shape;
alter table public.employees add constraint employees_channel_scope_override_shape check (
  channel_scope_override is null
  or (jsonb_typeof(channel_scope_override) = 'object'
      and channel_scope_override->>'mode' in ('registered_only', 'all_joined'))
);

-- Writes to the policy columns are server-only (service_role / migration owner).
create or replace function public.channel_scope_policy_server_only()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  changed boolean;
begin
  if current_user not in ('anon', 'authenticated') then
    return new;
  end if;
  if tg_table_name = 'orgs' then
    changed := (tg_op = 'INSERT' and new.channel_scope_policy is not null)
      or (tg_op = 'UPDATE' and new.channel_scope_policy is distinct from old.channel_scope_policy);
  else
    changed := (tg_op = 'INSERT' and new.channel_scope_override is not null)
      or (tg_op = 'UPDATE' and new.channel_scope_override is distinct from old.channel_scope_override);
  end if;
  if changed then
    raise exception 'channel_scope_policy_server_only' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.channel_scope_policy_server_only() from public, anon, authenticated;

drop trigger if exists orgs_channel_scope_policy_server_only on public.orgs;
create trigger orgs_channel_scope_policy_server_only
  before insert or update on public.orgs
  for each row execute function public.channel_scope_policy_server_only();

drop trigger if exists employees_channel_scope_override_server_only on public.employees;
create trigger employees_channel_scope_override_server_only
  before insert or update on public.employees
  for each row execute function public.channel_scope_policy_server_only();

-- ---------------------------------------------------------------------------
-- 2) org_channels: provenance + Connect metadata (strictening is tracked here)
-- ---------------------------------------------------------------------------
-- Existing rows default to source='manual' (they were registered by channels.classify
-- or the existing egress lazy-inspect path; registered_only keeps today's behavior).
alter table public.org_channels
  add column if not exists source text not null default 'manual';
alter table public.org_channels drop constraint if exists org_channels_source_check;
alter table public.org_channels add constraint org_channels_source_check
  check (source in ('manual', 'auto_join', 'egress_inspect', 'reconcile'));

alter table public.org_channels
  add column if not exists slack_team_id text;            -- context_team_id (home team)
alter table public.org_channels
  add column if not exists external_team_ids text[] not null default '{}'; -- Connect peer teams
alter table public.org_channels
  add column if not exists human_confirmed_at timestamptz; -- set when a human confirms via channels.classify
alter table public.org_channels
  add column if not exists last_inspected_at timestamptz;

alter table public.org_channels drop constraint if exists org_channels_external_team_ids_max;
alter table public.org_channels add constraint org_channels_external_team_ids_max
  check (coalesce(array_length(external_team_ids, 1), 0) <= 100);

comment on column public.org_channels.source is
  'P1 channel scope provenance: manual (human/channels.classify, legacy rows) | auto_join | egress_inspect | reconcile. Automatic sources only ever make classification stricter.';
comment on column public.org_channels.human_confirmed_at is
  'P1 channel scope: time a human confirmed the classification (channels.classify). Auto paths may only make a confirmed row stricter.';

-- ---------------------------------------------------------------------------
-- 3) employee_channel_memberships: AI employee x channel membership ledger
-- ---------------------------------------------------------------------------
do $cs1$ begin
  if not exists (
    select 1 from pg_constraint c
    where c.conrelid = 'public.employees'::regclass
      and c.contype in ('u', 'p')
      and c.conkey @> array[
        (select attnum from pg_attribute where attrelid = 'public.employees'::regclass and attname = 'id' and not attisdropped),
        (select attnum from pg_attribute where attrelid = 'public.employees'::regclass and attname = 'org_id' and not attisdropped)
      ]::smallint[]
      and array_length(c.conkey, 1) = 2
  ) then
    alter table public.employees add constraint employees_id_org_key unique (id, org_id);
  end if;
end $cs1$;

create table if not exists public.employee_channel_memberships (
  id uuid not null default gen_random_uuid(),
  org_id uuid not null,
  employee_id uuid not null,
  surface text not null default 'slack',
  external_id text not null,                 -- C... / G...
  via text not null,                         -- user = employee's Slack user joined; bot = Staffpass app joined
  state text not null default 'member',
  inviter_slack_user_id text,
  inviter_team_id text,
  joined_at timestamptz,
  left_at timestamptz,
  last_event_id text,                        -- idempotency / audit trail
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint employee_channel_memberships_pkey primary key (id),
  constraint employee_channel_memberships_org_fk
    foreign key (org_id) references public.orgs(id) on delete cascade,
  constraint employee_channel_memberships_employee_same_org_fk
    foreign key (employee_id, org_id) references public.employees(id, org_id) on delete cascade,
  constraint employee_channel_memberships_surface_check check (surface in ('slack')),
  constraint employee_channel_memberships_via_check check (via in ('user', 'bot')),
  constraint employee_channel_memberships_state_check
    check (state in ('member', 'left', 'removed', 'out_of_scope')),
  constraint employee_channel_memberships_external_id_check
    check (external_id ~ '^[A-Z0-9]{2,64}$'),
  constraint employee_channel_memberships_unique
    unique (employee_id, surface, external_id, via)
);

comment on table public.employee_channel_memberships is
  'P1 channel scope: which channels each AI employee (user or bot path) has joined. Metadata only, never message bodies. Service-role only (RLS deny-by-default). Flag P1_CHANNEL_SCOPE_ENABLED.';

create index if not exists ecm_org_idx
  on public.employee_channel_memberships (org_id, surface, external_id);
create index if not exists ecm_employee_state_idx
  on public.employee_channel_memberships (org_id, employee_id, state);

alter table public.employee_channel_memberships enable row level security;

drop policy if exists employee_channel_memberships_server_only on public.employee_channel_memberships;
create policy employee_channel_memberships_server_only on public.employee_channel_memberships
  as restrictive for all to public using (false) with check (false);

comment on policy employee_channel_memberships_server_only on public.employee_channel_memberships is
  'RLS: Block anon/authenticated access. Server-side only via service role.';

revoke all on public.employee_channel_memberships from public, anon, authenticated;
grant select, insert, update, delete on public.employee_channel_memberships to service_role;

commit;

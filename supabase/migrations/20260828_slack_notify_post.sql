-- Slack approval notify (org_notification_channels) + conversation posting adapters.
-- Planes stay separate: notify inbox vs comm.send / slack.post after egress.

alter table org_notification_channels
  drop constraint if exists org_notification_channels_provider_check;
alter table org_notification_channels
  add constraint org_notification_channels_provider_check
  check (provider in ('telegram','line','slack'));

alter table approval_notification_deliveries
  drop constraint if exists approval_notification_deliveries_provider_check;
alter table approval_notification_deliveries
  add constraint approval_notification_deliveries_provider_check
  check (provider in ('telegram','line','slack'));

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

-- Service-role only encrypted credentials (same AES helper as notify).
-- Intentionally no browser RLS select policy.
create table if not exists org_conversation_adapter_secrets (
  adapter_id uuid primary key references org_conversation_adapters(id) on delete cascade,
  credentials_ciphertext text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists conversation_adapters_org_enabled_idx
  on org_conversation_adapters (org_id, enabled);

alter table org_conversation_adapters enable row level security;
alter table org_conversation_adapter_secrets enable row level security;

drop policy if exists conversation_adapters_select on org_conversation_adapters;
drop policy if exists conversation_adapters_write_admin on org_conversation_adapters;
create policy conversation_adapters_select on org_conversation_adapters
  for select using (public.is_org_member(org_id));
create policy conversation_adapters_write_admin on org_conversation_adapters
  for all using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));

comment on table org_conversation_adapter_secrets is
  'Service-role-only encrypted conversation adapter credentials. Intentionally inaccessible via browser RLS.';
comment on table org_conversation_adapters is
  'Live conversation posting (comm.send / slack.post) after egress. Separate from org_notification_channels.';

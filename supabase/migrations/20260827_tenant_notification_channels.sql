-- Tenant-scoped Telegram / LINE notification channels.

create table if not exists org_notification_channels (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  provider text not null check (provider in ('telegram','line')),
  label text not null,
  enabled boolean not null default false,
  config jsonb not null default '{}'::jsonb,
  webhook_ref text not null default encode(gen_random_bytes(6), 'hex'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, provider),
  unique (webhook_ref)
);

-- Kept in a separate, service-role-only table so even an authenticated browser
-- with direct Supabase access can never select encrypted provider credentials.
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
  provider text not null check (provider in ('telegram','line')),
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

alter table org_notification_channels enable row level security;
alter table org_notification_channel_secrets enable row level security;
alter table approval_notification_deliveries enable row level security;

drop policy if exists notification_channels_select on org_notification_channels;
drop policy if exists notification_channels_write_admin on org_notification_channels;
create policy notification_channels_select on org_notification_channels
  for select using (public.is_org_member(org_id));
create policy notification_channels_write_admin on org_notification_channels
  for all using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));

-- Intentionally no anon/authenticated policy for org_notification_channel_secrets.
-- Server-side service_role bypasses RLS.

drop policy if exists notification_deliveries_select on approval_notification_deliveries;
create policy notification_deliveries_select on approval_notification_deliveries
  for select using (public.is_org_member(org_id));

comment on table org_notification_channel_secrets is
  'Service-role-only encrypted credentials. Intentionally inaccessible via browser RLS.';

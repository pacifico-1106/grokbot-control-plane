-- sns.publish adapters + per-employee approval inboxes.
-- User applies this in the production SQL editor. Do not rewrite existing rows.
--
-- Slice A: org_sns_adapters / org_sns_adapter_secrets (service-role secrets, not browser RLS).
-- Official APIs first. Cursor X MCP has no tweet.write — do not use it.
-- Env stubs (do not invent live tokens):
--   X_USER_ACCESS_TOKEN / X_BEARER_TOKEN / SNS_X_BEARER_TOKEN
--     X API v2 POST https://api.x.com/2/tweets (OAuth 2.0 user token with tweet.write)
--     Next step: X Developer Portal → user OAuth 2.0 (PKCE) or OAuth 1.0a with tweet.write.
--
-- Slice B: an org may have several 「承認を受け取る」 rows (Telegram DM / group, later Slack / LINE).
-- Drop unique (org_id, provider). One is_default per org (partial unique index).
-- employees.approval_channel_id unset → org default inbox (安藤 compatible).
-- Do not mix with org_conversation_adapters (「チャンネルに書き込む」).

-- Personal SNS posting adapters for sns.publish (X / note / LinkedIn / YouTube).
-- Separate from org_conversation_adapters (slack/line/mail) and org_notification_channels.
-- Official APIs first; browser posting is last-resort and not wired in this slice.
--
-- Env stubs (do not invent live tokens; paste org-owned credentials later):
--   X_USER_ACCESS_TOKEN / X_BEARER_TOKEN
--     X API v2 user-context token with tweet.write. Next step: X Developer Portal
--     → OAuth 2.0 (PKCE) user token, POST https://api.x.com/2/tweets.
--     Do NOT use Cursor X MCP tweet.write.
--   NOTE_API_TOKEN
--   LINKEDIN_ACCESS_TOKEN / LINKEDIN_AUTHOR_URN
--   YOUTUBE_ACCESS_TOKEN
--   SNS_PUBLISH_STUB=1  -- test-only; records stub delivery without calling APIs
-- Adapter secrets JSON (encrypted, same AES helper as notify):
--   { "bearerToken": "...", "accessToken": "...", "userAccessToken": "...", "stub": "1" }

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

-- Service-role only encrypted credentials (same AES helper as notify).
-- Intentionally no browser RLS select policy.
create table if not exists org_sns_adapter_secrets (
  adapter_id uuid primary key references org_sns_adapters(id) on delete cascade,
  credentials_ciphertext text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists sns_adapters_org_enabled_idx
  on org_sns_adapters (org_id, enabled);

alter table org_sns_adapters enable row level security;
alter table org_sns_adapter_secrets enable row level security;

drop policy if exists sns_adapters_select on org_sns_adapters;
drop policy if exists sns_adapters_write_admin on org_sns_adapters;
create policy sns_adapters_select on org_sns_adapters
  for select using (public.is_org_member(org_id));
create policy sns_adapters_write_admin on org_sns_adapters
  for all using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));

comment on table org_sns_adapter_secrets is
  'Service-role-only encrypted SNS adapter credentials. Intentionally inaccessible via browser RLS. Env stubs: SNS_X_BEARER_TOKEN (X tweet.write user token), SNS_NOTE_ACCESS_TOKEN, SNS_LINKEDIN_ACCESS_TOKEN, SNS_YOUTUBE_ACCESS_TOKEN. Do not store Cursor MCP tokens.';
comment on table org_sns_adapters is
  'Live personal SNS posting (sns.publish) after Staffpass approval. Separate from conversation adapters and notification channels.';


-- ---------------------------------------------------------------------------
-- B) Multiple approval inboxes + per-employee routing
-- ---------------------------------------------------------------------------
alter table org_notification_channels
  drop constraint if exists org_notification_channels_org_id_provider_key;
drop index if exists org_notification_channels_org_id_provider_key;

alter table org_notification_channels
  add column if not exists is_default boolean not null default false;

update org_notification_channels c
set is_default = true
where c.id in (
  select distinct on (org_id) id
  from org_notification_channels
  order by org_id, created_at asc, id asc
)
and not exists (
  select 1 from org_notification_channels d
  where d.org_id = c.org_id and d.is_default
);

create unique index if not exists org_notification_channels_one_default_per_org
  on org_notification_channels (org_id)
  where is_default;

alter table employees
  add column if not exists approval_channel_id uuid references org_notification_channels(id) on delete set null;

alter table employees
  add column if not exists approver_user_ids text[] not null default '{}';

create index if not exists employees_approval_channel_idx
  on employees (org_id, approval_channel_id)
  where approval_channel_id is not null;

comment on column employees.approval_channel_id is
  'Optional approval inbox (org_notification_channels). Unset falls back to the org default inbox.';
comment on column employees.approver_user_ids is
  'Optional extra Telegram/Slack/LINE user ids allowed to resolve this employee tickets (AND with channel allowedUserIds).';
comment on column org_notification_channels.is_default is
  'Exactly one default approval inbox per org. Unset employee.approval_channel_id uses this row.';

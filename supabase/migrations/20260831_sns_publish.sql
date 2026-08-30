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

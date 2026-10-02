-- MCP OAuth 2.1 Authorization Server tables (design: mcp-oauth-design-20261003 §8).
-- Additive only. Feature flags MCP_OAUTH_ENABLED / MCP_OAUTH_DCR_ENABLED (default OFF).
-- All tables: RLS enabled, NO policies → service role only (same as *_secrets).
-- Secrets are never stored: tokens / codes are SHA-256 hashes (hex).
-- Production apply requires a separate GO. Rollback: supabase/rollbacks/20261003100000_mcp_oauth.rollback.sql (kept OUT of migrations/ so the CLI never runs it)

create table if not exists oauth_clients (
  id uuid primary key default gen_random_uuid(),
  client_id text not null unique,                 -- CIMD URL / DCR generated id / static
  registration_type text not null check (registration_type in ('cimd','dcr','static')),
  client_name text not null default '',
  client_uri text,
  logo_uri text,
  redirect_uris text[] not null default '{}',
  token_endpoint_auth_method text not null default 'none'
    check (token_endpoint_auth_method in ('none')),
  metadata jsonb not null default '{}'::jsonb,
  metadata_fetched_at timestamptz,
  metadata_expires_at timestamptz,
  status text not null default 'active' check (status in ('active','blocked')),
  created_ip_hash text,
  last_used_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists oauth_clients_dcr_created_idx
  on oauth_clients (registration_type, created_at desc);

create table if not exists oauth_authorization_requests (
  id text primary key,                            -- 32B random base64url (unguessable)
  client_id text not null references oauth_clients(client_id) on delete cascade,
  redirect_uri text not null,
  state text,
  code_challenge text not null,
  resource text not null,
  scope text[] not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists oauth_grants (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete cascade,
  client_id text not null references oauth_clients(client_id) on delete cascade,
  credential_id_at_grant uuid references credentials(id) on delete set null,
  granted_by_member_id uuid references org_members(id) on delete set null,
  granted_by_email text not null,
  resource text not null,
  scope text[] not null,
  status text not null default 'active' check (status in ('active','revoked')),
  expires_at timestamptz not null,                -- absolute cap (≤90d, ≤credential expiry)
  revoked_at timestamptz,
  revoked_by_email text,
  revoke_reason text,
  last_used_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists oauth_grants_employee_idx
  on oauth_grants (employee_id) where status = 'active';
create index if not exists oauth_grants_org_idx
  on oauth_grants (org_id, created_at desc);

create table if not exists oauth_authorization_codes (
  code_hash text primary key,                     -- sha256 hex
  grant_id uuid not null references oauth_grants(id) on delete cascade,
  client_id text not null,
  redirect_uri text not null,
  code_challenge text not null,
  resource text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists oauth_access_tokens (
  token_hash text primary key,
  grant_id uuid not null references oauth_grants(id) on delete cascade,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists oauth_access_tokens_grant_idx on oauth_access_tokens (grant_id);

create table if not exists oauth_refresh_tokens (
  token_hash text primary key,
  grant_id uuid not null references oauth_grants(id) on delete cascade,
  parent_hash text,
  expires_at timestamptz not null,
  rotated_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists oauth_refresh_tokens_grant_idx on oauth_refresh_tokens (grant_id);

create table if not exists oauth_rate_limits (
  bucket_key text not null,                       -- e.g. token:<ip_hash>; never raw IP
  window_start timestamptz not null,
  count integer not null default 0,
  primary key (bucket_key, window_start)
);

alter table oauth_clients enable row level security;
alter table oauth_authorization_requests enable row level security;
alter table oauth_grants enable row level security;
alter table oauth_authorization_codes enable row level security;
alter table oauth_access_tokens enable row level security;
alter table oauth_refresh_tokens enable row level security;
alter table oauth_rate_limits enable row level security;
-- No policies on purpose: anon / authenticated roles cannot read or write.

-- Atomic fixed-window counter (DB-backed; per-instance memory limits do not work on Vercel).
create or replace function oauth_rate_limit_hit(p_key text, p_window_start timestamptz)
returns integer
language sql
security definer
set search_path = public
as $$
  insert into oauth_rate_limits (bucket_key, window_start, count)
  values (p_key, p_window_start, 1)
  on conflict (bucket_key, window_start)
  do update set count = oauth_rate_limits.count + 1
  returning count;
$$;
revoke all on function oauth_rate_limit_hit(text, timestamptz) from public, anon, authenticated;
grant execute on function oauth_rate_limit_hit(text, timestamptz) to service_role;

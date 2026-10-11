-- Rollback for 20261010200000_mcp_oauth.sql (drops ALL MCP OAuth state: grants/tokens/clients).
-- Turn MCP_OAUTH_ENABLED OFF first. Separate GO required before running in production.
begin;
drop function if exists oauth_rate_limit_hit(text, timestamptz);
drop table if exists oauth_rate_limits;
drop table if exists oauth_refresh_tokens;
drop table if exists oauth_access_tokens;
drop table if exists oauth_authorization_codes;
drop table if exists oauth_grants;
drop table if exists oauth_authorization_requests;
drop table if exists oauth_clients;
drop function if exists public.oauth_grants_same_org();
commit;

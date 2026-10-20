-- Rollback for 20261016400000_mcp_auth_failures.sql (same statements as
-- the migration's ROLLBACK block).
begin;
drop function if exists public.record_mcp_auth_failure(text, uuid, uuid, uuid, text);
drop function if exists public.touch_credential_last_used(uuid);
drop table if exists public.mcp_auth_failures;
commit;

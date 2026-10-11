-- Rollback for 20261012200000_credential_reissue_claim.sql. Turn
-- ADMIN_MCP_CREDENTIAL_REISSUE_ENABLED off first. Claim marks already written
-- in approval_requests.metadata stay (harmless; they only mean "picked up").
begin;
drop function if exists public.claim_credential_reissue(uuid, uuid, text, text, timestamptz);
drop function if exists public.release_credential_reissue(uuid, uuid, text);
commit;

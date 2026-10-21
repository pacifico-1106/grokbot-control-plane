-- Rollback for 20261021120000_auth_link_send_claim.sql.
-- Keep SECRET_AUTH_ACTION_LINK_ENABLED off first. Metadata marks already
-- written in approval_requests.metadata stay (harmless; they only mean
-- "this auth-link ticket already tried to send").
begin;
drop function if exists public.claim_auth_link_send(uuid, uuid, text, timestamptz);
drop function if exists public.release_auth_link_send(uuid, uuid, text);
drop function if exists public.consume_auth_link_send(uuid, uuid, text, timestamptz);
drop function if exists public.mark_auth_link_send_uncertain(uuid, uuid, text, timestamptz);
commit;

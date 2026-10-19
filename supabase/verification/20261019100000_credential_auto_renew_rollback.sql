-- Rollback for 20261019100000_credential_auto_renew.sql. Turn
-- CREDENTIAL_AUTO_RENEW_ENABLED off first. Drops the table (and its
-- trigger) plus the RPCs and the same-org trigger function.
begin;
drop function if exists public.expire_stale_credential_renewals(uuid, timestamptz);
drop function if exists public.claim_credential_renewal(uuid, uuid, uuid, text, timestamptz);
drop function if exists public.release_credential_renewal(uuid, uuid, text);
drop function if exists public.revoke_overlapped_old_credential(uuid, uuid, uuid, uuid);
drop function if exists public.credential_renewal_operable(uuid, uuid, boolean);
drop table if exists public.credential_renewals;
drop function if exists public.credential_renewals_same_org();
commit;

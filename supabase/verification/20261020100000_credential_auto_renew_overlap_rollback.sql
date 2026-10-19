-- Rollback for 20261020100000_credential_auto_renew_overlap.sql.
-- Leaves 20261019100000 (credential_renewals + claim/release/revoke) in place.
begin;
drop function if exists public.revoke_expired_overlapped_old_credential(uuid, uuid, uuid, uuid, timestamptz);
drop function if exists public.attach_overlapped_new_credential(uuid, uuid, text, uuid, timestamptz);
commit;

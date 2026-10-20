-- Rollback for 20261020200000_credential_auto_renew_gen1_http.sql.
-- Leaves 20261019100000 + 20261020100000 (table + overlap RPCs) in place.
begin;
drop function if exists public.claim_credential_renewal_gen1_http(uuid, uuid, uuid, text, timestamptz);
commit;

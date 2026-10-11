-- Rollback for 20261012100000_credential_expiry_notices.sql (same statements as
-- the migration's ROLLBACK block). Turn CREDENTIAL_EXPIRY_NOTICE_ENABLED off first.
begin;
drop table if exists public.credential_expiry_notices;
drop function if exists public.credential_expiry_notices_same_org();
commit;

-- Rollback for 20261005100000_employee_webhook_settings.sql (same statements
-- as the migration's ROLLBACK block). Turn WEBHOOK_HARDENING_ENABLED off first.
begin;
drop table if exists public.employee_webhook_settings;
drop function if exists public.employee_webhook_settings_same_org();
commit;

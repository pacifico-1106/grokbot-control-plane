-- Rollback for 20261012400000_lp_provisionings.sql. Set LP_AUTO_PROVISION_MODE
-- off first. Drops the LP setup-fee payment record (export it first if needed).
begin;
drop function if exists public.claim_lp_provisioning_notice(text, text, integer);
drop function if exists public.finish_lp_provisioning_notice(text, text, text);
drop table if exists public.lp_provisionings;
drop table if exists public.lp_provisioning_events;
commit;

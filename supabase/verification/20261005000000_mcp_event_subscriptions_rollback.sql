-- Rollback for 20261005000000_mcp_event_subscriptions.sql (same statements as
-- the migration's ROLLBACK block). Turn MCP_EVENTS_ENABLED off first.
begin;
drop table if exists public.mcp_event_deliveries;
drop table if exists public.mcp_event_subscriptions;
drop function if exists public.mcp_events_same_org();
commit;

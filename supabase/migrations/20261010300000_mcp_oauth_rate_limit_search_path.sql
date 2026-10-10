-- #315 follow-up (木村 2026-10-10): oauth_rate_limit_hit is SECURITY DEFINER;
-- pin its search_path to pg_catalog, public (catalog first, so no object in
-- another schema can shadow a built-in inside the definer function) and
-- schema-qualify the table. Same body, same signature, same grants
-- (CREATE OR REPLACE keeps the ACL; re-asserted below). Re-applicable.
begin;

create or replace function public.oauth_rate_limit_hit(p_key text, p_window_start timestamptz)
returns integer
language sql
security definer
set search_path = pg_catalog, public
as $$
  insert into public.oauth_rate_limits (bucket_key, window_start, count)
  values (p_key, p_window_start, 1)
  on conflict (bucket_key, window_start)
  do update set count = public.oauth_rate_limits.count + 1
  returning count;
$$;
revoke all on function public.oauth_rate_limit_hit(text, timestamptz) from public, anon, authenticated;
grant execute on function public.oauth_rate_limit_hit(text, timestamptz) to service_role;

commit;

-- ROLLBACK (down) — restores the 20261010200000 definition (search_path =
-- public). Same statements as
-- supabase/verification/20261010300000_mcp_oauth_rate_limit_search_path_rollback.sql.
-- Run as one transaction:
--   begin;
--   create or replace function public.oauth_rate_limit_hit(p_key text, p_window_start timestamptz)
--   returns integer
--   language sql
--   security definer
--   set search_path = public
--   as $$
--     insert into oauth_rate_limits (bucket_key, window_start, count)
--     values (p_key, p_window_start, 1)
--     on conflict (bucket_key, window_start)
--     do update set count = oauth_rate_limits.count + 1
--     returning count;
--   $$;
--   revoke all on function public.oauth_rate_limit_hit(text, timestamptz) from public, anon, authenticated;
--   grant execute on function public.oauth_rate_limit_hit(text, timestamptz) to service_role;
--   commit;
-- END ROLLBACK

-- Rollback for 20261010300000_mcp_oauth_rate_limit_search_path.sql: restores the
-- 20261010200000 definition of oauth_rate_limit_hit (search_path = public).
-- Data is untouched. Separate GO required before running in production.
begin;
create or replace function public.oauth_rate_limit_hit(p_key text, p_window_start timestamptz)
returns integer
language sql
security definer
set search_path = public
as $$
  insert into oauth_rate_limits (bucket_key, window_start, count)
  values (p_key, p_window_start, 1)
  on conflict (bucket_key, window_start)
  do update set count = oauth_rate_limits.count + 1
  returning count;
$$;
revoke all on function public.oauth_rate_limit_hit(text, timestamptz) from public, anon, authenticated;
grant execute on function public.oauth_rate_limit_hit(text, timestamptz) to service_role;
commit;

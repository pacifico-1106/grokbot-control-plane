-- #315 follow-up (migration 20261010300000): oauth_rate_limit_hit is SECURITY
-- DEFINER, so its search_path is pinned to pg_catalog first, then public (a
-- caller-created object can never shadow a catalog name inside it). Runs in
-- scripts/test-db-local.py and scripts/test-db-all-migrations.py.
--  (1) proconfig is exactly {search_path=pg_catalog, public}; still SECURITY DEFINER
--  (2) EXECUTE: service_role only (anon / authenticated / PUBLIC cannot)
--  (3) the counter still counts atomically per (bucket, window)
\set ON_ERROR_STOP 1
reset role;
do $$
declare
  cfg text[];
  definer boolean;
begin
  select p.proconfig, p.prosecdef into cfg, definer
    from pg_proc p where p.oid = 'public.oauth_rate_limit_hit(text,timestamptz)'::regprocedure;
  if cfg is distinct from array['search_path=pg_catalog, public'] then
    raise exception 'mcp oauth search_path: oauth_rate_limit_hit proconfig is % (expected {search_path=pg_catalog, public})', cfg;
  end if;
  if not definer then
    raise exception 'mcp oauth search_path: oauth_rate_limit_hit must stay SECURITY DEFINER';
  end if;
  if has_function_privilege('anon', 'public.oauth_rate_limit_hit(text,timestamptz)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.oauth_rate_limit_hit(text,timestamptz)', 'EXECUTE') then
    raise exception 'mcp oauth search_path: a session role can execute oauth_rate_limit_hit';
  end if;
  if not has_function_privilege('service_role', 'public.oauth_rate_limit_hit(text,timestamptz)', 'EXECUTE') then
    raise exception 'mcp oauth search_path: service_role lost EXECUTE on oauth_rate_limit_hit';
  end if;
  if public.oauth_rate_limit_hit('fixture:sp', '2026-01-01T00:00:00Z') <> 1
     or public.oauth_rate_limit_hit('fixture:sp', '2026-01-01T00:00:00Z') <> 2
     or public.oauth_rate_limit_hit('fixture:sp', '2026-01-01T00:01:00Z') <> 1 then
    raise exception 'mcp oauth search_path: counter broken';
  end if;
  delete from public.oauth_rate_limits where bucket_key = 'fixture:sp';
end $$;

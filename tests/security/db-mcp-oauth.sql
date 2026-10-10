-- MCP OAuth AS tables (migration 20261010200000). Synthetic fixtures only
-- (ids ab000000-…); cleans up after itself. Self-contained helpers so it runs
-- in scripts/test-db-local.py and after every migration in
-- scripts/test-db-all-migrations.py.
--  (1) anon / authenticated: no SELECT / INSERT / UPDATE / DELETE on any of the
--      7 tables, and cannot EXECUTE oauth_rate_limit_hit
--  (2) RLS on, no policy; service_role reads / writes (BYPASSRLS)
--  (3) tenant isolation: a grant whose employee / credential / granting member
--      belongs to another org is rejected (oauth_grant_cross_org)
--  (4) tokens / codes are stored only as 64-hex hashes in this fixture (the
--      app never writes raw values; columns are named *_hash)
--  (5) oauth_rate_limit_hit counts atomically per (bucket, window)
\set ON_ERROR_STOP 1
reset role;

create or replace function security_test.oauth_denied(command text) returns void language plpgsql as $$
begin
  begin
    execute command;
  exception when insufficient_privilege then return;
  end;
  raise exception 'mcp oauth: session access not denied: %', command;
end $$;
create or replace function security_test.oauth_rejects(command text, expected text) returns void language plpgsql as $$
begin
  begin
    execute command;
  exception when others then
    if position(expected in sqlerrm) > 0 then return; end if;
    raise exception 'mcp oauth: % failed with "%" (expected "%")', command, sqlerrm, expected;
  end;
  raise exception 'mcp oauth: not rejected: %', command;
end $$;
grant execute on function security_test.oauth_denied(text), security_test.oauth_rejects(text, text) to anon, authenticated, service_role;

-- (2) RLS on, no policy
do $$
declare t text;
begin
  foreach t in array array['oauth_clients','oauth_authorization_requests','oauth_grants','oauth_authorization_codes',
                           'oauth_access_tokens','oauth_refresh_tokens','oauth_rate_limits'] loop
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then
      raise exception 'mcp oauth: RLS off on %', t;
    end if;
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = t) then
      raise exception 'mcp oauth: unexpected policy on %', t;
    end if;
  end loop;
end $$;

insert into public.orgs(id, name) values
 ('ab000000-0000-4000-8000-0000000000a1', 'mcp-oauth-fixture-a'),
 ('ab000000-0000-4000-8000-0000000000a2', 'mcp-oauth-fixture-b');
insert into public.employees(id, org_id, display_name, role_label) values
 ('ab100000-0000-4000-8000-000000000001', 'ab000000-0000-4000-8000-0000000000a1', 'OAuth A1', 'fixture'),
 ('ab100000-0000-4000-8000-000000000002', 'ab000000-0000-4000-8000-0000000000a2', 'OAuth B1', 'fixture');

set role service_role;
insert into public.oauth_clients (client_id, registration_type, client_name, redirect_uris)
values ('https://client.example.com/oauth/meta.json', 'cimd', 'Fixture', array['https://client.example.com/cb']);
insert into public.oauth_grants (id, org_id, employee_id, client_id, granted_by_email, resource, scope, expires_at)
values ('ab200000-0000-4000-8000-000000000001', 'ab000000-0000-4000-8000-0000000000a1', 'ab100000-0000-4000-8000-000000000001',
        'https://client.example.com/oauth/meta.json', 'owner@a.example', 'https://staffpass.example/api/mcp',
        array['staffpass.employee'], now() + interval '1 day');
insert into public.oauth_access_tokens (token_hash, grant_id, expires_at)
values (repeat('a', 64), 'ab200000-0000-4000-8000-000000000001', now() + interval '1 hour');
insert into public.oauth_refresh_tokens (token_hash, grant_id, expires_at)
values (repeat('b', 64), 'ab200000-0000-4000-8000-000000000001', now() + interval '30 days');

-- (3) cross-org grant rejected (employee of org B under org A; update moving the employee)
select security_test.oauth_rejects($q$insert into public.oauth_grants (org_id, employee_id, client_id, granted_by_email, resource, scope, expires_at)
  values ('ab000000-0000-4000-8000-0000000000a1', 'ab100000-0000-4000-8000-000000000002', 'https://client.example.com/oauth/meta.json',
          'x@a.example', 'https://staffpass.example/api/mcp', array['staffpass.employee'], now() + interval '1 day')$q$, 'oauth_grant_cross_org');
select security_test.oauth_rejects($q$update public.oauth_grants set employee_id = 'ab100000-0000-4000-8000-000000000002'
  where id = 'ab200000-0000-4000-8000-000000000001'$q$, 'oauth_grant_cross_org');
select security_test.oauth_rejects($q$update public.oauth_grants set org_id = 'ab000000-0000-4000-8000-0000000000a2'
  where id = 'ab200000-0000-4000-8000-000000000001'$q$, 'oauth_grant_cross_org');

-- (5) atomic counter
do $$
begin
  if public.oauth_rate_limit_hit('fixture:ab', '2026-01-01T00:00:00Z') <> 1
     or public.oauth_rate_limit_hit('fixture:ab', '2026-01-01T00:00:00Z') <> 2
     or public.oauth_rate_limit_hit('fixture:ab', '2026-01-01T00:01:00Z') <> 1 then
    raise exception 'mcp oauth: rate limit counter wrong';
  end if;
end $$;
reset role;

-- (1) sessions: nothing
do $$
declare r text; t text;
begin
  foreach r in array array['anon','authenticated'] loop
    foreach t in array array['oauth_clients','oauth_authorization_requests','oauth_grants','oauth_authorization_codes',
                             'oauth_access_tokens','oauth_refresh_tokens','oauth_rate_limits'] loop
      if has_table_privilege(r, 'public.' || t, 'SELECT') or has_table_privilege(r, 'public.' || t, 'INSERT')
         or has_table_privilege(r, 'public.' || t, 'UPDATE') or has_table_privilege(r, 'public.' || t, 'DELETE') then
        raise exception 'mcp oauth: % holds a privilege on %', r, t;
      end if;
    end loop;
    if has_function_privilege(r, 'public.oauth_rate_limit_hit(text,timestamptz)', 'EXECUTE') then
      raise exception 'mcp oauth: % can execute oauth_rate_limit_hit', r;
    end if;
  end loop;
end $$;
set role authenticated;
select security_test.oauth_denied('select token_hash from public.oauth_access_tokens');
select security_test.oauth_denied('select * from public.oauth_grants');
select security_test.oauth_denied($q$insert into public.oauth_clients (client_id, registration_type) values ('x', 'dcr')$q$);
select security_test.oauth_denied($q$update public.oauth_grants set status = 'active'$q$);
select security_test.oauth_denied('delete from public.oauth_refresh_tokens');
select security_test.oauth_denied($q$select public.oauth_rate_limit_hit('x', now())$q$);
set role anon;
select security_test.oauth_denied('select * from public.oauth_refresh_tokens');
select security_test.oauth_denied('select * from public.oauth_clients');
reset role;

-- cleanup
delete from public.oauth_rate_limits where bucket_key = 'fixture:ab';
delete from public.oauth_grants where id::text like 'ab2%';
delete from public.oauth_clients where client_id = 'https://client.example.com/oauth/meta.json';
delete from public.employees where id::text like 'ab1%';
delete from public.orgs where id::text like 'ab0%';
drop function security_test.oauth_denied(text);
drop function security_test.oauth_rejects(text, text);

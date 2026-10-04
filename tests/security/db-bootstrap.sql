create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
-- Subset of Supabase's auth.users (email / email_confirmed_at / invited_at are
-- read by public.claim_member_invites, migration 20261004900000).
create table auth.users(id uuid primary key, banned_until timestamptz, deleted_at timestamptz,
  email text, email_confirmed_at timestamptz, invited_at timestamptz, last_sign_in_at timestamptz);
create role authenticator nologin;
create function auth.uid() returns uuid language sql stable as
$$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema public, auth to anon, authenticated, service_role;
-- Supabase's auth.role(): JWT role claim (used by service-role-only policies).
create function auth.role() returns text language sql stable as
$$ select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''),
                   nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role') $$;
grant execute on function auth.uid() to anon, authenticated, service_role;
grant execute on function auth.role() to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;

create schema security_test;
grant usage on schema security_test to anon, authenticated, service_role;
create function security_test.denied(command text) returns void language plpgsql as $$
begin
  begin
    execute command;
    raise exception 'expected permission denial: %', command;
  exception when insufficient_privilege then null;
  end;
end $$;
create function security_test.bad_relation(command text) returns void language plpgsql as $$
begin
  begin
    execute command;
    raise exception 'expected FK denial: %', command;
  exception when foreign_key_violation then null;
  end;
end $$;

create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create table auth.users(id uuid primary key, banned_until timestamptz, deleted_at timestamptz);
create role authenticator nologin;
create function auth.uid() returns uuid language sql stable as
$$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema public, auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
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

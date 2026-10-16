-- /api/mcp auth-failure audit + last_used_at touch (migration 20261016400000).
-- Synthetic fixtures only (ids af000000-…); cleans up after itself.
--  (1) RLS on, no policy; anon / authenticated hold no privilege and cannot EXECUTE
--  (2) service_role inserts via record_mcp_auth_failure; kind limited
--  (3) throttle: second row of the same kind × identity in the 5-minute bucket is refused
--  (4) no token / hash / prefix columns
--  (5) touch_credential_last_used: conditional UPDATE, at most once per 5 minutes
\set ON_ERROR_STOP 1
reset role;

create or replace function security_test.maf_denied(command text) returns void language plpgsql as $$
begin
  begin
    execute command;
  exception when insufficient_privilege then return;
  end;
  raise exception 'mcp auth failures: session access not denied: %', command;
end $$;
create or replace function security_test.maf_rejects(command text, expected text) returns void language plpgsql as $$
begin
  begin
    execute command;
  exception when others then
    if position(expected in sqlerrm) > 0 or sqlstate = expected then return; end if;
    raise exception 'mcp auth failures: % failed with "%" / % (expected "%")', command, sqlerrm, sqlstate, expected;
  end;
  raise exception 'mcp auth failures: not rejected: %', command;
end $$;
grant execute on function security_test.maf_denied(text), security_test.maf_rejects(text, text) to anon, authenticated, service_role;

-- (1) RLS on, no policy, no session privilege
do $$
declare r text;
begin
  if not (select relrowsecurity from pg_class where oid = 'public.mcp_auth_failures'::regclass) then
    raise exception 'mcp auth failures: RLS off';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'mcp_auth_failures') then
    raise exception 'mcp auth failures: unexpected policy';
  end if;
  foreach r in array array['anon','authenticated'] loop
    if has_table_privilege(r, 'public.mcp_auth_failures', 'SELECT') or has_table_privilege(r, 'public.mcp_auth_failures', 'INSERT')
       or has_table_privilege(r, 'public.mcp_auth_failures', 'UPDATE') or has_table_privilege(r, 'public.mcp_auth_failures', 'DELETE') then
      raise exception 'mcp auth failures: % holds a privilege', r;
    end if;
    if has_function_privilege(r, 'public.record_mcp_auth_failure(text,uuid,uuid,uuid,text)', 'EXECUTE')
       or has_function_privilege(r, 'public.touch_credential_last_used(uuid)', 'EXECUTE') then
      raise exception 'mcp auth failures: % can execute RPCs', r;
    end if;
  end loop;
end $$;

-- (4) no secret columns; throttle_bucket is a 5-minute epoch (not a secret)
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'mcp_auth_failures'
      and column_name in ('token', 'secret', 'secret_hash', 'secret_prefix', 'fingerprint', 'presented', 'hash')
  ) then
    raise exception 'mcp auth failures: secret-shaped column present';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'mcp_auth_failures'
      and column_name = 'throttle_bucket' and is_nullable = 'NO' and data_type = 'bigint'
  ) then
    raise exception 'mcp auth failures: throttle_bucket bigint NOT NULL missing';
  end if;
end $$;

insert into public.orgs(id, name) values
 ('af000000-0000-4000-8000-0000000000a1', 'mcp-auth-fail-a');
insert into public.employees(id, org_id, display_name, role_label) values
 ('af100000-0000-4000-8000-000000000001', 'af000000-0000-4000-8000-0000000000a1', 'AuthFail A1', 'fixture');
insert into public.credentials(id, org_id, employee_id, secret_hash, secret_prefix) values
 ('af200000-0000-4000-8000-000000000001', 'af000000-0000-4000-8000-0000000000a1', 'af100000-0000-4000-8000-000000000001', repeat('a', 64), 'gb_emp_aabbcc1');

set role service_role;

-- (2) kinds; bad kind refused
do $$
begin
  if public.record_mcp_auth_failure('missing_credential', null, null, null, 'tools/list') is not true then
    raise exception 'mcp auth failures: missing_credential not inserted';
  end if;
  if public.record_mcp_auth_failure('nope', null, null, null, 'tools/list') is not false then
    raise exception 'mcp auth failures: bad kind was inserted';
  end if;
end $$;

-- (3) throttle same kind × null identity
do $$
begin
  if public.record_mcp_auth_failure('missing_credential', null, null, null, 'tools/call') is not false then
    raise exception 'mcp auth failures: throttle did not refuse the second missing_credential';
  end if;
  if (select count(*) from public.mcp_auth_failures where failure_kind = 'missing_credential') <> 1 then
    raise exception 'mcp auth failures: throttle left extra rows';
  end if;
end $$;

-- different kind / identity still inserts
do $$
begin
  if public.record_mcp_auth_failure('expired', 'af000000-0000-4000-8000-0000000000a1',
       'af100000-0000-4000-8000-000000000001', 'af200000-0000-4000-8000-000000000001', 'tools/list') is not true then
    raise exception 'mcp auth failures: expired with identity not inserted';
  end if;
  if public.record_mcp_auth_failure('invalid', null, null, null, 'tools/list') is not true then
    raise exception 'mcp auth failures: invalid not inserted';
  end if;
end $$;

-- (5) last_used_at conditional UPDATE
-- now() is transaction-stable, so a second touch in this DO block returns the
-- same timestamptz as the first; compare against the backdated value instead.
do $$
declare
  first timestamptz;
  second timestamptz;
  backdated timestamptz;
  third timestamptz;
begin
  first := public.touch_credential_last_used('af200000-0000-4000-8000-000000000001');
  if first is null then
    raise exception 'mcp auth failures: first touch did not set last_used_at';
  end if;
  second := public.touch_credential_last_used('af200000-0000-4000-8000-000000000001');
  if second is not null then
    raise exception 'mcp auth failures: second touch within 5 minutes must no-op';
  end if;
  if (select last_used_at from public.credentials where id = 'af200000-0000-4000-8000-000000000001') <> first then
    raise exception 'mcp auth failures: last_used_at changed inside the throttle window';
  end if;
  update public.credentials
    set last_used_at = now() - interval '6 minutes'
    where id = 'af200000-0000-4000-8000-000000000001'
    returning last_used_at into backdated;
  if backdated is null or backdated >= first then
    raise exception 'mcp auth failures: could not backdate last_used_at for throttle test';
  end if;
  third := public.touch_credential_last_used('af200000-0000-4000-8000-000000000001');
  if third is null or third <= backdated then
    raise exception 'mcp auth failures: touch after 5 minutes did not update';
  end if;
  if public.touch_credential_last_used(null) is not null then
    raise exception 'mcp auth failures: null id must no-op';
  end if;
end $$;

reset role;

-- (1) sessions denied
set role authenticated;
select security_test.maf_denied('select * from public.mcp_auth_failures');
select security_test.maf_denied($q$select public.record_mcp_auth_failure('invalid', null, null, null, 'tools/list')$q$);
select security_test.maf_denied($q$select public.touch_credential_last_used('af200000-0000-4000-8000-000000000001')$q$);
set role anon;
select security_test.maf_denied('select * from public.mcp_auth_failures');
reset role;

-- cleanup
delete from public.mcp_auth_failures where org_id is null or org_id = 'af000000-0000-4000-8000-0000000000a1';
delete from public.credentials where id = 'af200000-0000-4000-8000-000000000001';
delete from public.employees where id = 'af100000-0000-4000-8000-000000000001';
delete from public.orgs where id = 'af000000-0000-4000-8000-0000000000a1';
drop function security_test.maf_denied(text);
drop function security_test.maf_rejects(text, text);

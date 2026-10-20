-- HOLD_DENIAL_AUDIT_ENABLED MCP hold 403 rows (migration 20261020400000).
-- Synthetic fixtures only (ids hd000000-…); cleans up after itself.
--  (1) kinds org_on_hold / employee_on_hold accepted; others refused
--  (2) org_id required (tenant-separated)
--  (3) 1-minute throttle per kind × org × employee (unique; 2nd row false)
--  (4) other org is independent
--  (5) anon / authenticated cannot EXECUTE; no secret columns
\set ON_ERROR_STOP 1
reset role;

create or replace function security_test.hda_denied(command text) returns void language plpgsql as $$
begin
  begin
    execute command;
  exception when insufficient_privilege then return;
  end;
  raise exception 'hold denial audit: session access not denied: %', command;
end $$;
grant execute on function security_test.hda_denied(text) to anon, authenticated, service_role;

insert into public.orgs(id, name) values
 ('hd000000-0000-4000-8000-0000000000a1', 'hold-denial-a'),
 ('hd000000-0000-4000-8000-0000000000b1', 'hold-denial-b');
insert into public.employees(id, org_id, display_name, role_label) values
 ('hd100000-0000-4000-8000-000000000001', 'hd000000-0000-4000-8000-0000000000a1', 'HoldDenial A1', 'fixture'),
 ('hd100000-0000-4000-8000-000000000002', 'hd000000-0000-4000-8000-0000000000b1', 'HoldDenial B1', 'fixture');

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'mcp_auth_failures' and column_name = 'hold_id'
  ) then
    raise exception 'hold denial audit: hold_id column missing';
  end if;
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'mcp_auth_failures'
      and column_name in ('token', 'secret', 'secret_hash', 'secret_prefix', 'fingerprint', 'presented', 'hash')
  ) then
    raise exception 'hold denial audit: secret-shaped column present';
  end if;
end $$;

do $$
declare def text;
begin
  def := pg_get_functiondef('public.record_hold_mcp_denial(text,uuid,uuid,uuid,text)'::regprocedure);
  if position('60.0' in def) = 0 and position('/ 60' in def) = 0 then
    raise exception 'hold denial audit: 1-minute bucket missing';
  end if;
  if position('secret' in def) > 0 or position('token' in def) > 0 or position('hash' in def) > 0 then
    raise exception 'hold denial audit: function mentions a secret';
  end if;
end $$;

set role service_role;

-- (1) (2) kinds; org required; bad kind refused
do $$
begin
  if public.record_hold_mcp_denial('employee_on_hold', 'hd000000-0000-4000-8000-0000000000a1',
       'hd100000-0000-4000-8000-000000000001', 'hd400000-0000-4000-8000-0000000000h1', 'tools/list') is not true then
    raise exception 'hold denial audit: employee_on_hold not inserted';
  end if;
  if public.record_hold_mcp_denial('expired', 'hd000000-0000-4000-8000-0000000000a1',
       'hd100000-0000-4000-8000-000000000001', null, 'tools/list') is not false then
    raise exception 'hold denial audit: expired kind was inserted';
  end if;
  if public.record_hold_mcp_denial('employee_on_hold', null,
       'hd100000-0000-4000-8000-000000000001', 'hd400000-0000-4000-8000-0000000000h1', 'tools/list') is not false then
    raise exception 'hold denial audit: null org was inserted';
  end if;
end $$;

-- (3) throttle same kind × org × employee in the 1-minute bucket
do $$
begin
  if public.record_hold_mcp_denial('employee_on_hold', 'hd000000-0000-4000-8000-0000000000a1',
       'hd100000-0000-4000-8000-000000000001', 'hd400000-0000-4000-8000-0000000000h1', 'tools/call') is not false then
    raise exception 'hold denial audit: throttle did not refuse the second employee_on_hold';
  end if;
  if (select count(*) from public.mcp_auth_failures
        where failure_kind = 'employee_on_hold'
          and org_id = 'hd000000-0000-4000-8000-0000000000a1') <> 1 then
    raise exception 'hold denial audit: throttle left extra rows';
  end if;
end $$;

-- (4) other org / other kind still inserts
do $$
begin
  if public.record_hold_mcp_denial('org_on_hold', 'hd000000-0000-4000-8000-0000000000a1',
       'hd100000-0000-4000-8000-000000000001', 'hd400000-0000-4000-8000-0000000000h2', 'tools/list') is not true then
    raise exception 'hold denial audit: org_on_hold not inserted';
  end if;
  if public.record_hold_mcp_denial('employee_on_hold', 'hd000000-0000-4000-8000-0000000000b1',
       'hd100000-0000-4000-8000-000000000002', 'hd400000-0000-4000-8000-0000000000h3', 'tools/list') is not true then
    raise exception 'hold denial audit: other org not inserted';
  end if;
end $$;

reset role;

set role authenticated;
select security_test.hda_denied($q$select public.record_hold_mcp_denial('employee_on_hold', 'hd000000-0000-4000-8000-0000000000a1', 'hd100000-0000-4000-8000-000000000001', null, 'tools/list')$q$);
set role anon;
select security_test.hda_denied($q$select public.record_hold_mcp_denial('org_on_hold', 'hd000000-0000-4000-8000-0000000000a1', 'hd100000-0000-4000-8000-000000000001', null, 'tools/list')$q$);
reset role;

delete from public.mcp_auth_failures where org_id in (
  'hd000000-0000-4000-8000-0000000000a1', 'hd000000-0000-4000-8000-0000000000b1');
delete from public.employees where id in (
  'hd100000-0000-4000-8000-000000000001', 'hd100000-0000-4000-8000-000000000002');
delete from public.orgs where id in (
  'hd000000-0000-4000-8000-0000000000a1', 'hd000000-0000-4000-8000-0000000000b1');
drop function security_test.hda_denied(text);

-- org_members capability guard (migration 20261004200000). Fixture data only.
-- 1) authenticated owner/admin JWT can no longer write org_members directly (PostgREST bypass).
-- 2) the last active owner cannot be demoted / disabled / deleted, even by service_role.
\set ON_ERROR_STOP 1
reset role;
insert into public.orgs (id, name) values ('70000000-0000-4000-8000-0000000000a1', 'member-guard-fixture');
insert into public.org_members (id, org_id, user_id, email, role, capabilities, status) values
 ('70000000-0000-4000-8000-000000000001','70000000-0000-4000-8000-0000000000a1','71000000-0000-4000-8000-000000000001','mg-owner@fixture.invalid','owner','{view_dashboard,approve_actions,manage_team,manage_billing}','active'),
 ('70000000-0000-4000-8000-000000000002','70000000-0000-4000-8000-0000000000a1','71000000-0000-4000-8000-000000000002','mg-admin@fixture.invalid','admin','{view_dashboard,manage_team}','active');

-- (1) admin session self-escalation via direct table write
set role authenticated;
select set_config('request.jwt.claim.sub','71000000-0000-4000-8000-000000000002',false);
do $$
declare n integer;
begin
  update public.org_members set capabilities = capabilities || '{approve_actions}'::text[], role = 'owner'
   where id = '70000000-0000-4000-8000-000000000002';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'admin JWT could still update org_members directly (% rows)', n; end if;
  begin
    insert into public.org_members (org_id, user_id, email, role, capabilities)
    values ('70000000-0000-4000-8000-0000000000a1','71000000-0000-4000-8000-000000000002','mg-admin2@fixture.invalid','owner','{approve_actions}');
    raise exception 'admin JWT could still insert org_members directly';
  exception when insufficient_privilege then null;
  end;
  if (select count(*) from public.org_members where org_id = '70000000-0000-4000-8000-0000000000a1') <> 2 then
    raise exception 'select policy for members must be kept';
  end if;
end $$;
reset role;
select set_config('request.jwt.claim.sub','',false);
do $$
begin
  if exists (select 1 from public.org_members where id = '70000000-0000-4000-8000-000000000002' and (role <> 'admin' or 'approve_actions' = any(capabilities))) then
    raise exception 'admin row was escalated';
  end if;
end $$;

-- (2) last active owner
do $$
declare stmt text;
begin
  foreach stmt in array array[
    'update public.org_members set role = ''admin'' where id = ''70000000-0000-4000-8000-000000000001''',
    'update public.org_members set status = ''disabled'' where id = ''70000000-0000-4000-8000-000000000001''',
    'delete from public.org_members where id = ''70000000-0000-4000-8000-000000000001'''
  ] loop
    begin
      execute stmt;
      raise exception 'last owner removable: %', stmt;
    exception when check_violation then
      if sqlerrm <> 'last_owner_required' then raise; end if;
    end;
  end loop;
  -- with a second active owner, one may step down
  update public.org_members set role = 'owner' where id = '70000000-0000-4000-8000-000000000002';
  update public.org_members set role = 'admin' where id = '70000000-0000-4000-8000-000000000001';
  if (select count(*) from public.org_members where org_id = '70000000-0000-4000-8000-0000000000a1' and role = 'owner' and status = 'active') <> 1 then
    raise exception 'expected exactly one owner after hand-over';
  end if;
  -- non-owner edits are untouched by the trigger
  update public.org_members set capabilities = '{view_dashboard}' where id = '70000000-0000-4000-8000-000000000001';
end $$;
-- org deletion cascades through the trigger
delete from public.orgs where id = '70000000-0000-4000-8000-0000000000a1';
do $$ begin
  if exists (select 1 from public.org_members where org_id = '70000000-0000-4000-8000-0000000000a1') then
    raise exception 'cascade delete blocked';
  end if;
end $$;

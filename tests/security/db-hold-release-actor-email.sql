-- Hold-release audit actor_email (migration 20261016300000). Synthetic fixtures
-- only (ids e6…); cleans up after itself. Runs in scripts/test-db-local.py and
-- scripts/test-db-all-migrations.py after 20261012500000.
--  (1) release audit row.actor_email is org_members.email of resolved_by
--  (2) p_audit_metadata.actorEmail / actor_email / approverEmail cannot forge it
--  (3) stored metadata does not keep those caller keys
--  (4) EXECUTE remains service_role only
\set ON_ERROR_STOP 1
reset role;

do $$
begin
  if has_function_privilege('anon', 'public.release_employee_hold(uuid,uuid,text,jsonb,timestamptz)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.release_employee_hold(uuid,uuid,text,jsonb,timestamptz)', 'EXECUTE') then
    raise exception 'hold release actor_email: a session role can execute release_employee_hold';
  end if;
  if not has_function_privilege('service_role', 'public.release_employee_hold(uuid,uuid,text,jsonb,timestamptz)', 'EXECUTE') then
    raise exception 'hold release actor_email: service_role lost EXECUTE';
  end if;
  if position('actor_email_from_member' in pg_get_functiondef('public.release_employee_hold(uuid,uuid,text,jsonb,timestamptz)'::regprocedure)) = 0 then
    raise exception 'hold release actor_email: function is not the 20261016300000 body';
  end if;
end $$;

insert into public.orgs(id, name) values
  ('e6000000-0000-4000-8000-000000000001', 'eh actor-email org')
on conflict (id) do nothing;
update public.orgs set designated_admin_member_ids = array['e6300000-0000-4000-8000-000000000003']::uuid[]
 where id = 'e6000000-0000-4000-8000-000000000001';
insert into public.org_members(id, org_id, email, role, status) values
  ('e6300000-0000-4000-8000-000000000001', 'e6000000-0000-4000-8000-000000000001', 'eh-ae-owner@eh.invalid', 'owner', 'active'),
  ('e6300000-0000-4000-8000-000000000003', 'e6000000-0000-4000-8000-000000000001', 'eh-ae-admin@eh.invalid', 'admin', 'active')
on conflict (id) do nothing;
insert into public.employees(id, org_id, display_name, role_label) values
  ('e6100000-0000-4000-8000-000000000001', 'e6000000-0000-4000-8000-000000000001', 'eh ae emp', 'r')
on conflict (id) do nothing;

do $$
declare hid uuid; r jsonb;
begin
  set role service_role;
  r := public.start_employee_hold('e6000000-0000-4000-8000-000000000001','e6100000-0000-4000-8000-000000000001','stopped',null,
        'member:e6300000-0000-4000-8000-000000000001','web',null,now());
  hid := (r->>'holdId')::uuid;
  reset role;
  insert into public.approval_requests(id, org_id, purpose, summary, tool, risk, status, metadata) values
    ('e6200000-0000-4000-8000-0000000000a1', 'e6000000-0000-4000-8000-000000000001', 'admin.policy', 'ae release', 'employee.hold.release', 'high', 'pending',
     jsonb_build_object('holdId', hid, 'requestedBy', 'member:e6300000-0000-4000-8000-000000000001', 'adminTool', 'employee.hold.release'));
  set role service_role;
  perform public.request_employee_hold_release('e6000000-0000-4000-8000-000000000001', hid,
    'member:e6300000-0000-4000-8000-000000000001', 'false positive', 'e6200000-0000-4000-8000-0000000000a1', now());
  reset role;
  update public.approval_requests set status = 'approved', resolved_by = 'e6300000-0000-4000-8000-000000000003', resolved_at = now()
   where id = 'e6200000-0000-4000-8000-0000000000a1';
  set role service_role;
  r := public.release_employee_hold(
    'e6000000-0000-4000-8000-000000000001', hid, 'eh ae release',
    jsonb_build_object('via','web','actorEmail','forged@evil.invalid','actor_email','forged@evil.invalid','approverEmail','forged@evil.invalid'),
    now());
  if (r->>'released')::boolean is not true then raise exception 'hold release actor_email: release failed %', r; end if;
  reset role;
end $$;

do $$
declare row public.audit_events%rowtype;
begin
  select * into row from public.audit_events
   where org_id = 'e6000000-0000-4000-8000-000000000001' and action = 'employee.hold.released'
     and metadata->>'holdId' = (select id::text from public.employee_holds where org_id = 'e6000000-0000-4000-8000-000000000001' limit 1);
  if not found then raise exception 'hold release actor_email: no audit row'; end if;
  if row.actor_email is distinct from 'eh-ae-admin@eh.invalid' then
    raise exception 'hold release actor_email: got % (expected approver email)', row.actor_email;
  end if;
  if row.metadata ? 'actorEmail' or row.metadata ? 'actor_email' or row.metadata ? 'approverEmail' then
    raise exception 'hold release actor_email: caller actor keys leaked into metadata %', row.metadata;
  end if;
  if row.metadata->>'releasedBy' is distinct from 'member:e6300000-0000-4000-8000-000000000003' then
    raise exception 'hold release actor_email: releasedBy %', row.metadata->>'releasedBy';
  end if;
  if position('forged@evil.invalid' in row.metadata::text) > 0 then
    raise exception 'hold release actor_email: forged email stored in metadata';
  end if;
end $$;

alter table public.employee_holds disable trigger employee_holds_guard;
alter table public.employees disable trigger employees_hold_guard;
alter table public.orgs disable trigger orgs_hold_guard;
update public.employees set hold_state = null, hold_id = null where id::text like 'e61%';
update public.orgs set hold_state = null, hold_id = null where id::text like 'e60%';
delete from public.audit_events where org_id::text like 'e60%';
delete from public.employee_holds where org_id::text like 'e60%';
alter table public.employee_holds enable trigger employee_holds_guard;
alter table public.employees enable trigger employees_hold_guard;
alter table public.orgs enable trigger orgs_hold_guard;
delete from public.approval_requests where org_id::text like 'e60%';
delete from public.orgs where id::text like 'e60%';

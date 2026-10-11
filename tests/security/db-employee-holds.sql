-- 緊急停止 (hold) schema + functions (migration 20261012500000, S1 of the
-- ai-safety-5rules design §2 / §10). Synthetic fixtures only (ids e5…); cleans
-- up after itself. Runs in scripts/test-db-local.py (plus 12-way concurrent
-- start / release there) and after every migration in test-db-all-migrations.py.
--  (1) anon / authenticated: no access to employee_holds, cannot execute any
--      hold function, cannot write employees / orgs hold columns
--  (2) employee_holds: RLS on, no policy
--  (3) service_role cannot write hold columns / history directly (only via
--      the functions); history is append-only (no delete, identity columns fixed)
--  (4) start: another org's employee refused (BOLA); idempotent; pending and
--      approved-but-unexecuted tickets of that employee get heldByHoldId,
--      executed / other employees' / other orgs' tickets untouched
--  (5) release request: own org's open hold + pending employee.hold.release
--      ticket for that hold only; member requester only
--  (6) release: needs an approved ticket for that hold; approver must be an
--      active owner / designated admin of the SAME org; approver ≠ requester
--      (2-person rule); writes the audit row in the same transaction; held
--      tickets get holdOutcome=closed_by_hold (default discard); one release only
--  (7) audit insert fails → release fails, the hold stays
--  (8) single-owner exception: only when the org has exactly one eligible
--      approver, the ticket says singleOwnerSelfRelease, and a reason is given
--  (9) an ops-console hold cannot be released by a tenant member
-- (10) org-wide hold: kind 'stopped' only; sets orgs.hold_state
\set ON_ERROR_STOP 1
reset role;

create or replace function security_test.eh_denied(command text) returns void language plpgsql as $$
begin
  begin
    execute command;
  exception when insufficient_privilege then return;
  end;
  raise exception 'employee holds: session access not denied: %', command;
end $$;
create or replace function security_test.eh_raises(command text, needle text) returns void language plpgsql as $$
begin
  begin
    execute command;
  exception when others then
    if position(needle in sqlerrm) > 0 then return; end if;
    raise exception 'employee holds: expected "%" but got "%" for: %', needle, sqlerrm, command;
  end;
  raise exception 'employee holds: expected "%" but the command succeeded: %', needle, command;
end $$;
grant execute on function security_test.eh_denied(text) to anon, authenticated, service_role;
grant execute on function security_test.eh_raises(text, text) to anon, authenticated, service_role;

insert into public.orgs(id, name) values
  ('e5000000-0000-4000-8000-000000000001', 'eh org a'),
  ('e5000000-0000-4000-8000-000000000002', 'eh org b'),
  ('e5000000-0000-4000-8000-000000000003', 'eh org single owner')
on conflict (id) do nothing;
update public.orgs set designated_admin_member_ids = array['e5300000-0000-4000-8000-000000000003']::uuid[]
 where id = 'e5000000-0000-4000-8000-000000000001';
insert into public.org_members(id, org_id, email, role, status) values
  ('e5300000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-000000000001', 'eh-owner@eh.invalid', 'owner', 'active'),
  ('e5300000-0000-4000-8000-000000000002', 'e5000000-0000-4000-8000-000000000001', 'eh-member@eh.invalid', 'member', 'active'),
  ('e5300000-0000-4000-8000-000000000003', 'e5000000-0000-4000-8000-000000000001', 'eh-admin@eh.invalid', 'admin', 'active'),
  ('e5300000-0000-4000-8000-000000000004', 'e5000000-0000-4000-8000-000000000002', 'eh-owner-b@eh.invalid', 'owner', 'active'),
  ('e5300000-0000-4000-8000-000000000005', 'e5000000-0000-4000-8000-000000000003', 'eh-solo@eh.invalid', 'owner', 'active'),
  ('e5300000-0000-4000-8000-000000000006', 'e5000000-0000-4000-8000-000000000001', 'eh-owner2@eh.invalid', 'owner', 'active')
on conflict (id) do nothing;
insert into public.employees(id, org_id, display_name, role_label) values
  ('e5100000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-000000000001', 'eh emp a1', 'r'),
  ('e5100000-0000-4000-8000-000000000002', 'e5000000-0000-4000-8000-000000000001', 'eh emp a2', 'r'),
  ('e5100000-0000-4000-8000-000000000003', 'e5000000-0000-4000-8000-000000000002', 'eh emp b1', 'r'),
  ('e5100000-0000-4000-8000-000000000004', 'e5000000-0000-4000-8000-000000000003', 'eh emp solo', 'r')
on conflict (id) do nothing;
insert into public.approval_requests(id, org_id, employee_id, purpose, summary, tool, risk, status, metadata) values
  ('e5200000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-000000000001', 'e5100000-0000-4000-8000-000000000001', 'p', 'pending a1', 'slack.post', 'low', 'pending', '{}'),
  ('e5200000-0000-4000-8000-000000000002', 'e5000000-0000-4000-8000-000000000001', 'e5100000-0000-4000-8000-000000000001', 'p', 'approved a1', 'slack.post', 'low', 'approved', '{}'),
  ('e5200000-0000-4000-8000-000000000003', 'e5000000-0000-4000-8000-000000000001', 'e5100000-0000-4000-8000-000000000001', 'p', 'executed a1', 'slack.post', 'low', 'approved', '{"fulfillment":{"ok":true}}'),
  ('e5200000-0000-4000-8000-000000000004', 'e5000000-0000-4000-8000-000000000001', 'e5100000-0000-4000-8000-000000000002', 'p', 'pending a2', 'slack.post', 'low', 'pending', '{}'),
  ('e5200000-0000-4000-8000-000000000005', 'e5000000-0000-4000-8000-000000000002', 'e5100000-0000-4000-8000-000000000003', 'p', 'pending b1', 'slack.post', 'low', 'pending', '{}'),
  ('e5200000-0000-4000-8000-000000000006', 'e5000000-0000-4000-8000-000000000001', 'e5100000-0000-4000-8000-000000000001', 'p', 'rejected a1', 'slack.post', 'low', 'rejected', '{}');

-- (1)
set role anon;
select security_test.eh_denied($q$select * from public.employee_holds$q$);
select security_test.eh_denied($q$select public.start_employee_hold('e5000000-0000-4000-8000-000000000001','e5100000-0000-4000-8000-000000000001','stopped',null,'member:e5300000-0000-4000-8000-000000000002','web',null,now())$q$);
reset role;
set role authenticated;
select security_test.eh_denied($q$select * from public.employee_holds$q$);
select security_test.eh_denied($q$insert into public.employee_holds(org_id, kind, started_by, started_via) values ('e5000000-0000-4000-8000-000000000001','stopped','member:e5300000-0000-4000-8000-000000000002','web')$q$);
select security_test.eh_denied($q$update public.employees set hold_state = null where id = 'e5100000-0000-4000-8000-000000000001'$q$);
select security_test.eh_denied($q$update public.orgs set hold_state = null where id = 'e5000000-0000-4000-8000-000000000001'$q$);
select security_test.eh_denied($q$select public.start_employee_hold('e5000000-0000-4000-8000-000000000001','e5100000-0000-4000-8000-000000000001','stopped',null,'member:e5300000-0000-4000-8000-000000000002','web',null,now())$q$);
select security_test.eh_denied($q$select public.request_employee_hold_release('e5000000-0000-4000-8000-000000000001','e5400000-0000-4000-8000-000000000001','member:e5300000-0000-4000-8000-000000000002','r','e5200000-0000-4000-8000-000000000001',now())$q$);
select security_test.eh_denied($q$select public.release_employee_hold('e5000000-0000-4000-8000-000000000001','e5400000-0000-4000-8000-000000000001','s','{}'::jsonb,now())$q$);
reset role;

-- (2)
do $$ begin
  if not (select relrowsecurity from pg_class where oid = 'public.employee_holds'::regclass) then
    raise exception 'employee holds: RLS is off'; end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'employee_holds') then
    raise exception 'employee holds: unexpected policy'; end if;
end $$;

set role service_role;
-- (3) direct writes refused
select security_test.eh_raises($q$update public.employees set hold_state = 'stopped' where id = 'e5100000-0000-4000-8000-000000000001'$q$, 'hold_columns_function_only');
select security_test.eh_raises($q$update public.orgs set hold_state = 'stopped' where id = 'e5000000-0000-4000-8000-000000000001'$q$, 'hold_columns_function_only');
select security_test.eh_raises($q$insert into public.employee_holds(org_id, employee_id, kind, started_by, started_via) values ('e5000000-0000-4000-8000-000000000001','e5100000-0000-4000-8000-000000000001','stopped','member:e5300000-0000-4000-8000-000000000002','web')$q$, 'employee_holds_function_only');

-- (4) start
select security_test.eh_raises($q$select public.start_employee_hold('e5000000-0000-4000-8000-000000000001','e5100000-0000-4000-8000-000000000003','stopped',null,'member:e5300000-0000-4000-8000-000000000002','web',null,now())$q$, 'employee_not_found');
select security_test.eh_raises($q$select public.start_employee_hold('e5000000-0000-4000-8000-000000000001','e5100000-0000-4000-8000-000000000001','stopped',null,'ai:agent','web',null,now())$q$, 'employee_holds_started_by_check');
select security_test.eh_raises($q$select public.start_employee_hold('e5000000-0000-4000-8000-000000000001','e5100000-0000-4000-8000-000000000001','paused',null,'member:e5300000-0000-4000-8000-000000000002','web',null,now())$q$, 'employee_holds_kind_check');
do $$
declare r jsonb; r2 jsonb; hid uuid;
begin
  r := public.start_employee_hold('e5000000-0000-4000-8000-000000000001','e5100000-0000-4000-8000-000000000001','stopped','test stop',
        'member:e5300000-0000-4000-8000-000000000002','web',null,now());
  hid := (r->>'holdId')::uuid;
  if (r->>'created')::boolean is not true or (r->>'heldTickets')::int <> 2 then raise exception 'employee holds: start result %', r; end if;
  if (select hold_state from public.employees where id = 'e5100000-0000-4000-8000-000000000001') is distinct from 'stopped'
     or (select hold_id from public.employees where id = 'e5100000-0000-4000-8000-000000000001') is distinct from hid then
    raise exception 'employee holds: employee not on hold'; end if;
  r2 := public.start_employee_hold('e5000000-0000-4000-8000-000000000001','e5100000-0000-4000-8000-000000000001','stopped',null,
        'member:e5300000-0000-4000-8000-000000000003','slack',null,now());
  if (r2->>'created')::boolean is not false or (r2->>'holdId')::uuid <> hid then raise exception 'employee holds: start not idempotent %', r2; end if;
  if (select count(*) from public.employee_holds where employee_id = 'e5100000-0000-4000-8000-000000000001') <> 1 then
    raise exception 'employee holds: second history row'; end if;
  if (select count(*) from public.approval_requests where metadata->>'heldByHoldId' = hid::text) <> 2
     or not exists (select 1 from public.approval_requests where id = 'e5200000-0000-4000-8000-000000000001' and metadata->>'heldByHoldId' = hid::text)
     or not exists (select 1 from public.approval_requests where id = 'e5200000-0000-4000-8000-000000000002' and metadata->>'heldByHoldId' = hid::text) then
    raise exception 'employee holds: wrong tickets held'; end if;
  if exists (select 1 from public.approval_requests where id in ('e5200000-0000-4000-8000-000000000003','e5200000-0000-4000-8000-000000000004',
             'e5200000-0000-4000-8000-000000000005','e5200000-0000-4000-8000-000000000006') and metadata ? 'heldByHoldId') then
    raise exception 'employee holds: executed / other employee / other org / closed ticket held'; end if;
  -- (3) append-only, identity columns fixed even inside the function context
  perform set_config('staffpass.hold_write', 'on', true);
  begin
    update public.employee_holds set started_by = 'member:e5300000-0000-4000-8000-000000000001' where id = hid;
    raise exception 'employee holds: identity column changed';
  exception when others then
    if position('employee_holds_immutable' in sqlerrm) = 0 then raise; end if;
  end;
  perform set_config('staffpass.hold_write', '', true);
  begin
    delete from public.employee_holds where id = hid;
    raise exception 'employee holds: history row deleted';
  exception when others then
    if position('employee_holds_append_only' in sqlerrm) = 0 then raise; end if;
  end;
end $$;
select security_test.eh_raises($q$update public.employees set hold_state = null, hold_id = null where id = 'e5100000-0000-4000-8000-000000000001'$q$, 'hold_columns_function_only');

-- release ticket fixtures (created by S3 with employee_id null so G4 never blocks it)
do $$
declare hid uuid := (select hold_id from public.employees where id = 'e5100000-0000-4000-8000-000000000001');
begin
  insert into public.approval_requests(id, org_id, purpose, summary, tool, risk, status, metadata) values
    ('e5200000-0000-4000-8000-0000000000a1', 'e5000000-0000-4000-8000-000000000001', 'admin.policy', 'release', 'employee.hold.release', 'high', 'pending',
     jsonb_build_object('holdId', hid, 'holdEmployeeId', 'e5100000-0000-4000-8000-000000000001')),
    ('e5200000-0000-4000-8000-0000000000a2', 'e5000000-0000-4000-8000-000000000001', 'admin.policy', 'other tool', 'policy.patch', 'high', 'pending',
     jsonb_build_object('holdId', hid)),
    ('e5200000-0000-4000-8000-0000000000a3', 'e5000000-0000-4000-8000-000000000002', 'admin.policy', 'other org', 'employee.hold.release', 'high', 'pending',
     jsonb_build_object('holdId', hid));
end $$;

-- (5) release request
select security_test.eh_raises(format($q$select public.request_employee_hold_release('e5000000-0000-4000-8000-000000000002', %L, 'member:e5300000-0000-4000-8000-000000000004', 'r', 'e5200000-0000-4000-8000-0000000000a3', now())$q$,
  (select hold_id from public.employees where id = 'e5100000-0000-4000-8000-000000000001')), 'hold_not_found');
select security_test.eh_raises(format($q$select public.request_employee_hold_release('e5000000-0000-4000-8000-000000000001', %L, 'member:e5300000-0000-4000-8000-000000000002', 'r', 'e5200000-0000-4000-8000-0000000000a2', now())$q$,
  (select hold_id from public.employees where id = 'e5100000-0000-4000-8000-000000000001')), 'release_ticket_invalid');
select security_test.eh_raises(format($q$select public.request_employee_hold_release('e5000000-0000-4000-8000-000000000001', %L, 'member:e5300000-0000-4000-8000-000000000002', 'r', 'e5200000-0000-4000-8000-0000000000a3', now())$q$,
  (select hold_id from public.employees where id = 'e5100000-0000-4000-8000-000000000001')), 'release_ticket_invalid');
select security_test.eh_raises(format($q$select public.request_employee_hold_release('e5000000-0000-4000-8000-000000000001', %L, 'system:anomaly', 'r', 'e5200000-0000-4000-8000-0000000000a1', now())$q$,
  (select hold_id from public.employees where id = 'e5100000-0000-4000-8000-000000000001')), 'release_requester_invalid');
select security_test.eh_raises(format($q$select public.request_employee_hold_release('e5000000-0000-4000-8000-000000000001', %L, 'member:e5300000-0000-4000-8000-000000000002', '  ', 'e5200000-0000-4000-8000-0000000000a1', now())$q$,
  (select hold_id from public.employees where id = 'e5100000-0000-4000-8000-000000000001')), 'release_reason_required');
do $$
declare hid uuid := (select hold_id from public.employees where id = 'e5100000-0000-4000-8000-000000000001');
begin
  if not public.request_employee_hold_release('e5000000-0000-4000-8000-000000000001', hid, 'member:e5300000-0000-4000-8000-000000000002',
       'checked the logs', 'e5200000-0000-4000-8000-0000000000a1', now()) then
    raise exception 'employee holds: release request failed'; end if;
end $$;

-- (6) release: ticket still pending → refused
select security_test.eh_raises(format($q$select public.release_employee_hold('e5000000-0000-4000-8000-000000000001', %L, 'release', '{}'::jsonb, now())$q$,
  (select hold_id from public.employees where id = 'e5100000-0000-4000-8000-000000000001')), 'release_not_approved');
-- approver = requester → refused (2-person rule)
update public.approval_requests set status = 'approved', resolved_by = 'e5300000-0000-4000-8000-000000000002', resolved_at = now() where id = 'e5200000-0000-4000-8000-0000000000a1';
select security_test.eh_raises(format($q$select public.release_employee_hold('e5000000-0000-4000-8000-000000000001', %L, 'release', '{}'::jsonb, now())$q$,
  (select hold_id from public.employees where id = 'e5100000-0000-4000-8000-000000000001')), 'release_approver_not_allowed');
-- approver is another org's owner → refused
update public.approval_requests set resolved_by = 'e5300000-0000-4000-8000-000000000004' where id = 'e5200000-0000-4000-8000-0000000000a1';
select security_test.eh_raises(format($q$select public.release_employee_hold('e5000000-0000-4000-8000-000000000001', %L, 'release', '{}'::jsonb, now())$q$,
  (select hold_id from public.employees where id = 'e5100000-0000-4000-8000-000000000001')), 'release_approver_not_allowed');
-- wrong org asks → hold not found (BOLA)
select security_test.eh_raises(format($q$select public.release_employee_hold('e5000000-0000-4000-8000-000000000002', %L, 'release', '{}'::jsonb, now())$q$,
  (select hold_id from public.employees where id = 'e5100000-0000-4000-8000-000000000001')), 'hold_not_found');
-- (7) audit insert fails → no release
reset role;
create or replace function security_test.eh_audit_fail() returns trigger language plpgsql as $$
begin raise exception 'eh audit unavailable'; end $$;
create trigger eh_audit_fail before insert on public.audit_events for each row
  when (new.action = 'employee.hold.released') execute function security_test.eh_audit_fail();
set role service_role;
update public.approval_requests set resolved_by = 'e5300000-0000-4000-8000-000000000003' where id = 'e5200000-0000-4000-8000-0000000000a1';
select security_test.eh_raises(format($q$select public.release_employee_hold('e5000000-0000-4000-8000-000000000001', %L, 'release', '{}'::jsonb, now())$q$,
  (select hold_id from public.employees where id = 'e5100000-0000-4000-8000-000000000001')), 'eh audit unavailable');
do $$ begin
  if (select hold_state from public.employees where id = 'e5100000-0000-4000-8000-000000000001') is distinct from 'stopped'
     or exists (select 1 from public.employee_holds where employee_id = 'e5100000-0000-4000-8000-000000000001' and released_at is not null) then
    raise exception 'employee holds: released although the audit row failed'; end if;
end $$;
reset role;
drop trigger eh_audit_fail on public.audit_events;
set role service_role;
-- designated admin (≠ requester) approves → released, audit row, tickets closed_by_hold
do $$
declare hid uuid := (select hold_id from public.employees where id = 'e5100000-0000-4000-8000-000000000001'); r jsonb;
begin
  r := public.release_employee_hold('e5000000-0000-4000-8000-000000000001', hid, 'eh release', jsonb_build_object('via','web'), now());
  if (r->>'released')::boolean is not true or (r->>'closedTickets')::int <> 2 then raise exception 'employee holds: release result %', r; end if;
  if (select hold_state from public.employees where id = 'e5100000-0000-4000-8000-000000000001') is not null then
    raise exception 'employee holds: still on hold after release'; end if;
  if (select released_by from public.employee_holds where id = hid) <> 'member:e5300000-0000-4000-8000-000000000003' then
    raise exception 'employee holds: released_by is not the approver'; end if;
  if not exists (select 1 from public.audit_events where org_id = 'e5000000-0000-4000-8000-000000000001' and action = 'employee.hold.released'
                 and employee_id = 'e5100000-0000-4000-8000-000000000001' and metadata->>'holdId' = hid::text
                 and metadata->>'approvalId' = 'e5200000-0000-4000-8000-0000000000a1') then
    raise exception 'employee holds: no audit row'; end if;
  if (select count(*) from public.approval_requests where metadata->>'heldByHoldId' = hid::text and metadata->>'holdOutcome' = 'closed_by_hold') <> 2 then
    raise exception 'employee holds: held tickets not closed_by_hold'; end if;
  begin
    perform public.release_employee_hold('e5000000-0000-4000-8000-000000000001', hid, 'again', '{}'::jsonb, now());
    raise exception 'employee holds: released twice';
  exception when others then
    if position('hold_not_found' in sqlerrm) = 0 then raise; end if;
  end;
end $$;

-- (8) single-owner exception
do $$
declare r jsonb; hid uuid;
begin
  r := public.start_employee_hold('e5000000-0000-4000-8000-000000000003','e5100000-0000-4000-8000-000000000004','stopped',null,
        'member:e5300000-0000-4000-8000-000000000005','web',null,now());
  hid := (r->>'holdId')::uuid;
  insert into public.approval_requests(id, org_id, purpose, summary, tool, risk, status, metadata, resolved_by, resolved_at) values
    ('e5200000-0000-4000-8000-0000000000b1', 'e5000000-0000-4000-8000-000000000003', 'admin.policy', 'solo release', 'employee.hold.release', 'high', 'pending',
     jsonb_build_object('holdId', hid), null, null);
  perform public.request_employee_hold_release('e5000000-0000-4000-8000-000000000003', hid, 'member:e5300000-0000-4000-8000-000000000005',
    'false positive', 'e5200000-0000-4000-8000-0000000000b1', now());
  update public.approval_requests set status = 'approved', resolved_by = 'e5300000-0000-4000-8000-000000000005', resolved_at = now()
   where id = 'e5200000-0000-4000-8000-0000000000b1';
  begin
    perform public.release_employee_hold('e5000000-0000-4000-8000-000000000003', hid, 'solo', '{}'::jsonb, now());
    raise exception 'employee holds: self-release without the single-owner flag';
  exception when others then
    if position('release_approver_not_allowed' in sqlerrm) = 0 then raise; end if;
  end;
  update public.approval_requests set metadata = metadata || '{"singleOwnerSelfRelease":true}' where id = 'e5200000-0000-4000-8000-0000000000b1';
  r := public.release_employee_hold('e5000000-0000-4000-8000-000000000003', hid, 'solo', '{}'::jsonb, now());
  if (r->>'released')::boolean is not true then raise exception 'employee holds: single-owner release failed'; end if;
end $$;
-- the flag does not help in an org with more than one eligible approver (org a: 2 owners + designated admin)
do $$
declare r jsonb; hid uuid;
begin
  r := public.start_employee_hold('e5000000-0000-4000-8000-000000000001','e5100000-0000-4000-8000-000000000002','stopped',null,
        'member:e5300000-0000-4000-8000-000000000001','web',null,now());
  hid := (r->>'holdId')::uuid;
  insert into public.approval_requests(id, org_id, purpose, summary, tool, risk, status, metadata) values
    ('e5200000-0000-4000-8000-0000000000c1', 'e5000000-0000-4000-8000-000000000001', 'admin.policy', 'self release', 'employee.hold.release', 'high', 'pending',
     jsonb_build_object('holdId', hid, 'singleOwnerSelfRelease', true));
  perform public.request_employee_hold_release('e5000000-0000-4000-8000-000000000001', hid, 'member:e5300000-0000-4000-8000-000000000001',
    'mine', 'e5200000-0000-4000-8000-0000000000c1', now());
  update public.approval_requests set status = 'approved', resolved_by = 'e5300000-0000-4000-8000-000000000001', resolved_at = now()
   where id = 'e5200000-0000-4000-8000-0000000000c1';
  begin
    perform public.release_employee_hold('e5000000-0000-4000-8000-000000000001', hid, 'self', '{}'::jsonb, now());
    raise exception 'employee holds: self-release in a multi-approver org';
  exception when others then
    if position('release_approver_not_allowed' in sqlerrm) = 0 then raise; end if;
  end;
  -- a plain member (not owner / designated) approving → refused
  update public.approval_requests set resolved_by = 'e5300000-0000-4000-8000-000000000002' where id = 'e5200000-0000-4000-8000-0000000000c1';
  begin
    perform public.release_employee_hold('e5000000-0000-4000-8000-000000000001', hid, 'member', '{}'::jsonb, now());
    raise exception 'employee holds: plain member released';
  exception when others then
    if position('release_approver_not_allowed' in sqlerrm) = 0 then raise; end if;
  end;
  -- another owner approves → released
  update public.approval_requests set resolved_by = 'e5300000-0000-4000-8000-000000000006' where id = 'e5200000-0000-4000-8000-0000000000c1';
  r := public.release_employee_hold('e5000000-0000-4000-8000-000000000001', hid, 'other owner', '{}'::jsonb, now());
  if (r->>'released')::boolean is not true then raise exception 'employee holds: second owner could not release'; end if;
end $$;

-- (9) ops-console hold: a tenant member cannot release it
do $$
declare r jsonb; hid uuid;
begin
  r := public.start_employee_hold('e5000000-0000-4000-8000-000000000002','e5100000-0000-4000-8000-000000000003','stopped','ops',
        'ops:ops-fixture','ops_console',null,now());
  hid := (r->>'holdId')::uuid;
  insert into public.approval_requests(id, org_id, purpose, summary, tool, risk, status, metadata) values
    ('e5200000-0000-4000-8000-0000000000d1', 'e5000000-0000-4000-8000-000000000002', 'admin.policy', 'ops release', 'employee.hold.release', 'high', 'pending',
     jsonb_build_object('holdId', hid));
  begin
    perform public.request_employee_hold_release('e5000000-0000-4000-8000-000000000002', hid, 'member:e5300000-0000-4000-8000-000000000004',
      'please', 'e5200000-0000-4000-8000-0000000000d1', now());
    raise exception 'employee holds: member requested release of an ops hold';
  exception when others then
    if position('ops_hold_ops_only' in sqlerrm) = 0 then raise; end if;
  end;
end $$;

-- (10) org-wide hold
select security_test.eh_raises($q$select public.start_employee_hold('e5000000-0000-4000-8000-000000000003', null, 'leave', null, 'member:e5300000-0000-4000-8000-000000000005', 'web', null, now())$q$, 'employee_holds_org_kind_check');
do $$
declare r jsonb;
begin
  r := public.start_employee_hold('e5000000-0000-4000-8000-000000000003', null, 'stopped', 'org stop', 'member:e5300000-0000-4000-8000-000000000005', 'web', null, now());
  if (select hold_state from public.orgs where id = 'e5000000-0000-4000-8000-000000000003') is distinct from 'stopped'
     or (select hold_id from public.orgs where id = 'e5000000-0000-4000-8000-000000000003') is distinct from (r->>'holdId')::uuid then
    raise exception 'employee holds: org hold not set'; end if;
end $$;
reset role;

-- cleanup (history is append-only: drop the guard for the fixture cleanup only)
alter table public.employee_holds disable trigger employee_holds_guard;
alter table public.employees disable trigger employees_hold_guard;
alter table public.orgs disable trigger orgs_hold_guard;
update public.employees set hold_state = null, hold_id = null where id::text like 'e51%';
update public.orgs set hold_state = null, hold_id = null where id::text like 'e50%';
delete from public.audit_events where org_id::text like 'e50%';
delete from public.employee_holds where org_id::text like 'e50%';
alter table public.employee_holds enable trigger employee_holds_guard;
alter table public.employees enable trigger employees_hold_guard;
alter table public.orgs enable trigger orgs_hold_guard;
delete from public.approval_requests where org_id::text like 'e50%';
delete from public.orgs where id::text like 'e50%';  -- cascades employees / members (last-owner guard allows the org cascade)
drop function security_test.eh_audit_fail();

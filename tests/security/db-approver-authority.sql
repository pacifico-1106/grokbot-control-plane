-- PR-D approver authority (migration 20261005200000). Fixture data only.
-- Org A: owner O, designated admin D, admin N (not designated), member M, disabled admin X (designated).
-- Org B: admin only (no owner).
-- Org C: two owners C1 / C2 + designated admin CD (multiple owners, 八坂 2026-10-05).
-- Org D: one owner DO (the requester) + designated admin DD.
\set ON_ERROR_STOP 1
reset role;
insert into public.orgs (id, name) values
 ('7d000000-0000-4000-8000-0000000000a1', 'approver-authority-a'),
 ('7d000000-0000-4000-8000-0000000000b1', 'approver-authority-b-no-owner'),
 ('7d000000-0000-4000-8000-0000000000c1', 'approver-authority-c-two-owners'),
 ('7d000000-0000-4000-8000-0000000000d1', 'approver-authority-d-owner-is-requester');
insert into public.org_members (id, org_id, user_id, email, role, capabilities, status) values
 ('7d000000-0000-4000-8000-000000000001','7d000000-0000-4000-8000-0000000000a1','7e000000-0000-4000-8000-000000000001','aa-owner@fixture.invalid','owner','{approve_actions}','active'),
 ('7d000000-0000-4000-8000-000000000002','7d000000-0000-4000-8000-0000000000a1','7e000000-0000-4000-8000-000000000002','aa-dadmin@fixture.invalid','admin','{}','active'),
 ('7d000000-0000-4000-8000-000000000003','7d000000-0000-4000-8000-0000000000a1','7e000000-0000-4000-8000-000000000003','aa-admin@fixture.invalid','admin','{}','active'),
 ('7d000000-0000-4000-8000-000000000004','7d000000-0000-4000-8000-0000000000a1','7e000000-0000-4000-8000-000000000004','aa-member@fixture.invalid','member','{}','active'),
 ('7d000000-0000-4000-8000-000000000005','7d000000-0000-4000-8000-0000000000a1','7e000000-0000-4000-8000-000000000005','aa-disabled@fixture.invalid','admin','{}','disabled'),
 ('7d000000-0000-4000-8000-000000000006','7d000000-0000-4000-8000-0000000000b1','7e000000-0000-4000-8000-000000000006','bb-admin@fixture.invalid','admin','{}','active'),
 ('7d000000-0000-4000-8000-000000000011','7d000000-0000-4000-8000-0000000000c1','7e000000-0000-4000-8000-000000000011','cc-owner1@fixture.invalid','owner','{}','active'),
 ('7d000000-0000-4000-8000-000000000012','7d000000-0000-4000-8000-0000000000c1','7e000000-0000-4000-8000-000000000012','cc-owner2@fixture.invalid','owner','{}','active'),
 ('7d000000-0000-4000-8000-000000000013','7d000000-0000-4000-8000-0000000000c1','7e000000-0000-4000-8000-000000000013','cc-dadmin@fixture.invalid','admin','{}','active'),
 ('7d000000-0000-4000-8000-000000000021','7d000000-0000-4000-8000-0000000000d1','7e000000-0000-4000-8000-000000000021','dd-owner@fixture.invalid','owner','{}','active'),
 ('7d000000-0000-4000-8000-000000000022','7d000000-0000-4000-8000-0000000000d1','7e000000-0000-4000-8000-000000000022','dd-dadmin@fixture.invalid','admin','{}','active');
update public.orgs set designated_admin_member_ids = array[
  '7d000000-0000-4000-8000-000000000002','7d000000-0000-4000-8000-000000000005','7d000000-0000-4000-8000-000000000004']::uuid[]
 where id = '7d000000-0000-4000-8000-0000000000a1';
update public.orgs set designated_admin_member_ids = array['7d000000-0000-4000-8000-000000000006']::uuid[]
 where id = '7d000000-0000-4000-8000-0000000000b1';
update public.orgs set designated_admin_member_ids = array['7d000000-0000-4000-8000-000000000013']::uuid[]
 where id = '7d000000-0000-4000-8000-0000000000c1';
update public.orgs set designated_admin_member_ids = array['7d000000-0000-4000-8000-000000000022']::uuid[]
 where id = '7d000000-0000-4000-8000-0000000000d1';

insert into public.approval_requests (id, org_id, purpose, summary, risk, status, tool, required_approver_kind, metadata) values
 ('7f000000-0000-4000-8000-000000000001','7d000000-0000-4000-8000-0000000000a1','admin.policy','std','high','pending','policy.patch','owner_or_designated_admin','{}'),
 ('7f000000-0000-4000-8000-000000000002','7d000000-0000-4000-8000-0000000000a1','admin.policy','owner','high','pending','employees.spend.set','owner','{}'),
 ('7f000000-0000-4000-8000-000000000003','7d000000-0000-4000-8000-0000000000a1','admin.policy','flag-off','high','pending','policy.patch','owner','{}'),
 ('7f000000-0000-4000-8000-000000000004','7d000000-0000-4000-8000-0000000000a1','mail.send','non-target','medium','pending','mail.send',null,'{}'),
 ('7f000000-0000-4000-8000-000000000005','7d000000-0000-4000-8000-0000000000b1','admin.policy','no-owner','high','pending','policy.patch','owner_or_designated_admin','{}'),
 ('7f000000-0000-4000-8000-000000000006','7d000000-0000-4000-8000-0000000000a1','admin.policy','reject','high','pending','policy.patch','owner','{}'),
 ('7f000000-0000-4000-8000-000000000007','7d000000-0000-4000-8000-0000000000a1','admin.policy','f8','high','pending','policy.patch','owner','{}'),
 ('7f000000-0000-4000-8000-000000000011','7d000000-0000-4000-8000-0000000000c1','admin.policy','two-owners','high','pending','plan.upgrade','owner','{"requesterMemberId":"7d000000-0000-4000-8000-000000000011"}'),
 ('7f000000-0000-4000-8000-000000000021','7d000000-0000-4000-8000-0000000000d1','admin.policy','owner-is-requester','high','pending','plan.upgrade','owner','{"requesterMemberId":"7d000000-0000-4000-8000-000000000021"}'),
 ('7f000000-0000-4000-8000-000000000022','7d000000-0000-4000-8000-0000000000d1','admin.policy','owner-is-requester-std','high','pending','policy.patch','owner_or_designated_admin','{"requesterMemberId":"7d000000-0000-4000-8000-000000000021"}');

set role service_role;
do $$
declare
  a constant uuid := '7d000000-0000-4000-8000-0000000000a1';
  b constant uuid := '7d000000-0000-4000-8000-0000000000b1';
  o constant uuid := '7d000000-0000-4000-8000-000000000001';
  d constant uuid := '7d000000-0000-4000-8000-000000000002';
  n constant uuid := '7d000000-0000-4000-8000-000000000003';
  m constant uuid := '7d000000-0000-4000-8000-000000000004';
  x constant uuid := '7d000000-0000-4000-8000-000000000005';
  bx constant uuid := '7d000000-0000-4000-8000-000000000006';
  oc1 constant uuid := '7d000000-0000-4000-8000-000000000011';
  oc2 constant uuid := '7d000000-0000-4000-8000-000000000012';
  dc constant uuid := '7d000000-0000-4000-8000-000000000013';
  od constant uuid := '7d000000-0000-4000-8000-000000000021';
  dd constant uuid := '7d000000-0000-4000-8000-000000000022';
  cc constant uuid := '7d000000-0000-4000-8000-0000000000c1';
  dorg constant uuid := '7d000000-0000-4000-8000-0000000000d1';
  r jsonb;
  t_row public.approval_requests;
  c record;
begin
  -- (1) decision table (same cases as lib/approver-authority/decide.test.ts)
  for c in select * from (values
    (a, o, 'owner_or_designated_admin', 'allow', 'owner'),
    (a, o, 'owner', 'allow', 'owner'),
    (a, d, 'owner_or_designated_admin', 'allow', 'designated_admin'),
    (a, d, 'owner', 'endorse', 'owner_approval_required'),
    (a, n, 'owner_or_designated_admin', 'deny', 'approver_not_authorized'),
    (a, m, 'owner_or_designated_admin', 'deny', 'approver_not_authorized'),
    (a, x, 'owner_or_designated_admin', 'deny', 'approver_inactive'),
    (a, bx, 'owner_or_designated_admin', 'deny', 'approver_not_found'),
    (a, null, 'owner', 'deny', 'approver_member_required'),
    (a, o, 'admin', 'deny', 'invalid_required_kind'),
    (b, bx, 'owner_or_designated_admin', 'deny', 'org_has_no_owner')
  ) t(org_id, member_id, kind, outcome, detail) loop
    r := public.approver_authority_check(c.org_id, c.member_id, c.kind);
    if r->>'outcome' is distinct from c.outcome
       or coalesce(case when c.outcome = 'allow' then r->>'approver_role' else r->>'reason' end, '') <> c.detail then
      raise exception 'approver_authority_check(%, %, %) = %, expected % / %', c.org_id, c.member_id, c.kind, r, c.outcome, c.detail;
    end if;
  end loop;

  -- (2) flag OFF: the 7 named arguments call keeps today's behaviour (no check, nothing stored)
  r := public.resolve_approval_w1_checked(p_id => '7f000000-0000-4000-8000-000000000003', p_org => a, p_member_id => n,
         p_decision => 'approved', p_actor => 'test', p_revision_note => null, p_decision_id => 'd-off');
  select * into t_row from public.approval_requests where id = '7f000000-0000-4000-8000-000000000003';
  if not (r->>'ok')::boolean or t_row.status <> 'approved' or t_row.approver_member_id is not null then
    raise exception 'flag OFF call changed behaviour: % / % / %', r, t_row.status, t_row.approver_member_id;
  end if;

  -- (3) flag ON, standard ticket: non-designated admin refused, designated admin stored
  r := public.resolve_approval_w1_checked('7f000000-0000-4000-8000-000000000001', a, n, 'approved', 'test', null, 'd1', true);
  if (r->>'ok')::boolean or r->>'reason' <> 'approver_not_authorized'
     or (select status from public.approval_requests where id = '7f000000-0000-4000-8000-000000000001') <> 'pending' then
    raise exception 'non-designated admin approved a standard ticket: %', r;
  end if;
  r := public.resolve_approval_w1_checked('7f000000-0000-4000-8000-000000000001', a, d, 'approved', 'test', null, 'd2', true);
  select * into t_row from public.approval_requests where id = '7f000000-0000-4000-8000-000000000001';
  if not (r->>'ok')::boolean or t_row.status <> 'approved' or t_row.approver_member_id <> d or t_row.approver_role <> 'designated_admin'
     or t_row.approver_authority->>'verifiedMemberId' <> d::text or r->>'approver_role' <> 'designated_admin' then
    raise exception 'designated admin approval not stored: % / %', r, t_row;
  end if;

  -- (4) flag ON, owner ticket: designated admin → endorsement, stays pending (twice = one endorsement); owner → approved
  for i in 1..2 loop
    r := public.resolve_approval_w1_checked('7f000000-0000-4000-8000-000000000002', a, d, 'approved', 'test', null, 'd3', true);
    if (r->>'ok')::boolean or r->>'reason' <> 'owner_approval_required' or not (r->>'endorsed')::boolean then
      raise exception 'designated admin on owner ticket: %', r;
    end if;
  end loop;
  select * into t_row from public.approval_requests where id = '7f000000-0000-4000-8000-000000000002';
  if t_row.status <> 'pending' or t_row.approver_member_id is not null or t_row.resolved_at is not null
     or jsonb_array_length(t_row.approver_authority->'endorsements') <> 1
     or t_row.approver_authority->'endorsements'->0->>'memberId' <> d::text then
    raise exception 'owner ticket not kept pending with one endorsement: %', t_row;
  end if;
  r := public.resolve_approval_w1_checked('7f000000-0000-4000-8000-000000000002', a, null, 'approved', 'test', null, 'd4', true);
  if (r->>'ok')::boolean or r->>'reason' <> 'approver_member_required' then raise exception 'null member: %', r; end if;
  r := public.resolve_approval_w1_checked('7f000000-0000-4000-8000-000000000002', a, o, 'approved', 'test', null, 'd5', true);
  select * into t_row from public.approval_requests where id = '7f000000-0000-4000-8000-000000000002';
  if not (r->>'ok')::boolean or t_row.status <> 'approved' or t_row.approver_member_id <> o or t_row.approver_role <> 'owner'
     or jsonb_array_length(t_row.approver_authority->'endorsements') <> 1 then
    raise exception 'owner approval not stored: % / %', r, t_row;
  end if;

  -- (5) zero owners → stop
  r := public.resolve_approval_w1_checked('7f000000-0000-4000-8000-000000000005', b, bx, 'approved', 'test', null, 'd6', true);
  if (r->>'ok')::boolean or r->>'reason' <> 'org_has_no_owner'
     or (select status from public.approval_requests where id = '7f000000-0000-4000-8000-000000000005') <> 'pending' then
    raise exception 'org without owner approved: %', r;
  end if;

  -- (6) reject is not gated; non-target ticket is not gated
  r := public.resolve_approval_w1_checked('7f000000-0000-4000-8000-000000000006', a, n, 'rejected', 'test', null, 'd7', true);
  if not (r->>'ok')::boolean then raise exception 'reject was gated: %', r; end if;
  r := public.resolve_approval_w1_checked('7f000000-0000-4000-8000-000000000004', a, n, 'approved', 'test', null, 'd8', true);
  if not (r->>'ok')::boolean
     or (select approver_member_id from public.approval_requests where id = '7f000000-0000-4000-8000-000000000004') is not null then
    raise exception 'non-target ticket was gated: %', r;
  end if;

  -- (7) record_approver_authority (F8 vote path)
  r := public.record_approver_authority('7f000000-0000-4000-8000-000000000007', a, d, 'endorse');
  if not (r->>'ok')::boolean then raise exception 'endorse failed: %', r; end if;
  r := public.record_approver_authority('7f000000-0000-4000-8000-000000000007', a, o, 'endorse');
  if (r->>'ok')::boolean or r->>'reason' <> 'approver_already_sufficient' then raise exception 'owner endorse: %', r; end if;
  r := public.record_approver_authority('7f000000-0000-4000-8000-000000000007', a, o, 'verified');
  if (r->>'ok')::boolean or r->>'reason' <> 'not_approved' then raise exception 'verified on pending: %', r; end if;
  update public.approval_requests set status = 'approved', resolved_at = now() where id = '7f000000-0000-4000-8000-000000000007';
  r := public.record_approver_authority('7f000000-0000-4000-8000-000000000007', a, d, 'verified');
  if (r->>'ok')::boolean or r->>'reason' <> 'owner_approval_required' then raise exception 'designated admin verified on owner ticket: %', r; end if;
  r := public.record_approver_authority('7f000000-0000-4000-8000-000000000007', a, n, 'verified');
  if (r->>'ok')::boolean or r->>'reason' <> 'approver_not_authorized' then raise exception 'unauthorized verified: %', r; end if;
  r := public.record_approver_authority('7f000000-0000-4000-8000-000000000007', a, o, 'verified');
  select * into t_row from public.approval_requests where id = '7f000000-0000-4000-8000-000000000007';
  if not (r->>'ok')::boolean or t_row.approver_member_id <> o or t_row.approver_role <> 'owner' then
    raise exception 'owner verified not stored: % / %', r, t_row;
  end if;
  r := public.record_approver_authority('7f000000-0000-4000-8000-000000000004', a, o, 'verified');
  if (r->>'ok')::boolean or r->>'reason' <> 'not_target' then raise exception 'non-target record: %', r; end if;
  r := public.record_approver_authority('7f000000-0000-4000-8000-000000000007', b, o, 'verified');
  if (r->>'ok')::boolean or r->>'reason' <> 'not_found' then raise exception 'cross-org record: %', r; end if;

  -- (9) multiple owners: any one owner other than the requester suffices
  if public.approver_authority_requester_ids('{"adminRequester":{"actorId":" ag "},"requesterMemberId":"m1"}'::jsonb) <> array['ag','m1']
     or public.approver_authority_requester_ids('{"adminRequester":"x","requesterMemberId":5}'::jsonb) <> '{}'::text[]
     or public.approver_authority_requester_ids(null) <> '{}'::text[] then
    raise exception 'approver_authority_requester_ids mismatch';
  end if;
  r := public.resolve_approval_w1_checked('7f000000-0000-4000-8000-000000000011', cc, oc1, 'approved', 'test', null, 'm1', true);
  if (r->>'ok')::boolean or r->>'reason' <> 'approver_is_requester' then raise exception 'requesting owner approved: %', r; end if;
  r := public.resolve_approval_w1_checked('7f000000-0000-4000-8000-000000000011', cc, dc, 'approved', 'test', null, 'm2', true);
  if r->>'reason' <> 'owner_approval_required' then raise exception 'designated admin with 2 owners: %', r; end if;
  r := public.resolve_approval_w1_checked('7f000000-0000-4000-8000-000000000011', cc, oc2, 'approved', 'test', null, 'm3', true);
  select * into t_row from public.approval_requests where id = '7f000000-0000-4000-8000-000000000011';
  if not (r->>'ok')::boolean or t_row.status <> 'approved' or t_row.approver_member_id <> oc2 or t_row.approver_role <> 'owner' then
    raise exception 'other owner approval not stored: % / %', r, t_row;
  end if;
  -- the re-check before fulfil sees the same rule
  r := public.approver_authority_check(cc, oc2, 'owner', public.approver_authority_requester_ids(t_row.metadata));
  if r->>'outcome' <> 'allow' then raise exception 'recheck other owner: %', r; end if;
  -- (10) sole owner (確定仕様 10:11): the requester's own approval counts — one tap, both kinds
  r := public.resolve_approval_w1_checked('7f000000-0000-4000-8000-000000000021', dorg, dd, 'approved', 'test', null, 'n1', true);
  if r->>'reason' <> 'owner_approval_required' then raise exception 'sole owner: designated admin should only endorse: %', r; end if;
  r := public.resolve_approval_w1_checked('7f000000-0000-4000-8000-000000000021', dorg, od, 'approved', 'test', null, 'n2', true);
  select * into t_row from public.approval_requests where id = '7f000000-0000-4000-8000-000000000021';
  if not (r->>'ok')::boolean or t_row.status <> 'approved' or t_row.approver_member_id <> od or t_row.approver_role <> 'owner' then
    raise exception 'sole owner self-approval not stored: % / %', r, t_row;
  end if;
  r := public.resolve_approval_w1_checked('7f000000-0000-4000-8000-000000000022', dorg, od, 'approved', 'test', null, 'n3', true);
  if not (r->>'ok')::boolean or r->>'approver_role' <> 'owner' then raise exception 'sole owner standard: %', r; end if;
  r := public.approver_authority_check(dorg, null, 'owner', array[od::text]);
  if r->>'reason' <> 'approver_member_required' then raise exception 'sole owner filing must not stop: %', r; end if;
  -- several owners, all requesters → stop; a requesting designated admin cannot approve
  r := public.approver_authority_check(cc, null, 'owner', array[oc1::text, oc2::text]);
  if r->>'reason' <> 'no_owner_other_than_requester' then raise exception 'all owners requesters: %', r; end if;
  r := public.approver_authority_check(cc, null, 'owner_or_designated_admin', array[oc1::text, oc2::text, dc::text]);
  if r->>'reason' <> 'no_owner_other_than_requester' then raise exception 'standard nobody else: %', r; end if;
  r := public.approver_authority_check(cc, dc, 'owner_or_designated_admin', array[oc1::text, oc2::text]);
  if r->>'outcome' <> 'allow' then raise exception 'standard designated admin other than requesters: %', r; end if;
  r := public.approver_authority_check(cc, dc, 'owner_or_designated_admin', array[dc::text]);
  if r->>'reason' <> 'approver_is_requester' then raise exception 'requesting designated admin: %', r; end if;
end $$;
reset role;

-- (8) shape: one RPC overload; constraints; EXECUTE only for service_role
do $$
declare fn text;
begin
  if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'resolve_approval_w1_checked') <> 1 then
    raise exception 'resolve_approval_w1_checked must have exactly one overload';
  end if;
  if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'approver_authority_check') <> 1 then
    raise exception 'approver_authority_check must have exactly one overload';
  end if;
  foreach fn in array array[
    'public.resolve_approval_w1_checked(uuid,uuid,uuid,text,text,text,text,boolean)',
    'public.approver_authority_check(uuid,uuid,text,text[])',
    'public.approver_authority_requester_ids(jsonb)',
    'public.record_approver_authority(uuid,uuid,uuid,text)',
    'public.approver_authority_with_endorsement(jsonb,uuid,timestamptz)'] loop
    if has_function_privilege('anon', fn, 'execute') or has_function_privilege('authenticated', fn, 'execute') then
      raise exception 'session role can execute %', fn;
    end if;
    if not has_function_privilege('service_role', fn, 'execute') then
      raise exception 'service_role cannot execute %', fn;
    end if;
  end loop;
  begin
    update public.approval_requests set required_approver_kind = 'anyone' where id = '7f000000-0000-4000-8000-000000000004';
    raise exception 'invalid required_approver_kind accepted';
  exception when check_violation then null;
  end;
  begin
    update public.approval_requests set approver_role = 'member' where id = '7f000000-0000-4000-8000-000000000004';
    raise exception 'invalid approver_role accepted';
  exception when check_violation then null;
  end;
end $$;

delete from public.approval_requests where org_id in ('7d000000-0000-4000-8000-0000000000a1','7d000000-0000-4000-8000-0000000000b1',
  '7d000000-0000-4000-8000-0000000000c1','7d000000-0000-4000-8000-0000000000d1');
delete from public.orgs where id in ('7d000000-0000-4000-8000-0000000000a1','7d000000-0000-4000-8000-0000000000b1',
  '7d000000-0000-4000-8000-0000000000c1','7d000000-0000-4000-8000-0000000000d1');

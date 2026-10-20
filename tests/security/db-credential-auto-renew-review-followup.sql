-- 社員証 auto-renew review follow-up (migration 20261020300000).
-- Synthetic fixtures only (ids cd000000-…); cleans up after itself.
-- (1) unused new after overlap → unused_new_revoked, old stays, binding stays
-- (2) used new (last_used_at set) → switched
-- (3) start_employee_hold turns claimable into held_blocked
-- (4) release while held (own token, null new_id) → held_blocked
-- (5) claim / gen1 claim function defs pin approved + unheld + live old
-- (6) abort_minted revokes new and returns to claimable
\set ON_ERROR_STOP 1
reset role;

do $$
begin
  if to_regnamespace('security_test') is null or current_user is distinct from 'test_admin' then
    raise exception 'db-credential-auto-renew-review-followup: refuse outside disposable test cluster';
  end if;
end $$;

insert into public.orgs(id, name) values
 ('cd000000-0000-4000-8000-0000000000a1', 'car rv org a')
on conflict (id) do nothing;
insert into public.employees(id, org_id, display_name, role_label) values
 ('cd100000-0000-4000-8000-000000000001', 'cd000000-0000-4000-8000-0000000000a1', 'CarRv A1', 'fixture')
on conflict (id) do nothing;
insert into public.credentials(id, org_id, employee_id, secret_hash, expires_at) values
 ('cd200000-0000-4000-8000-000000000001', 'cd000000-0000-4000-8000-0000000000a1', 'cd100000-0000-4000-8000-000000000001', repeat('p', 64), now() + interval '90 days'),
 ('cd200000-0000-4000-8000-000000000011', 'cd000000-0000-4000-8000-0000000000a1', 'cd100000-0000-4000-8000-000000000001', repeat('q', 64), now() + interval '90 days'),
 ('cd200000-0000-4000-8000-000000000021', 'cd000000-0000-4000-8000-0000000000a1', 'cd100000-0000-4000-8000-000000000001', repeat('r', 64), now() + interval '90 days'),
 ('cd200000-0000-4000-8000-000000000022', 'cd000000-0000-4000-8000-0000000000a1', 'cd100000-0000-4000-8000-000000000001', repeat('s', 64), now() + interval '90 days'),
 ('cd200000-0000-4000-8000-000000000031', 'cd000000-0000-4000-8000-0000000000a1', 'cd100000-0000-4000-8000-000000000001', repeat('t', 64), now() + interval '90 days'),
 ('cd200000-0000-4000-8000-000000000041', 'cd000000-0000-4000-8000-0000000000a1', 'cd100000-0000-4000-8000-000000000001', repeat('u', 64), now() + interval '90 days')
on conflict (id) do nothing;
insert into public.approval_requests(id, org_id, purpose, summary, tool, risk, status, metadata) values
 ('cd300000-0000-4000-8000-000000000001', 'cd000000-0000-4000-8000-0000000000a1', 'admin.policy', 'car rv unused', 'employees.credential.auto_renew', 'high', 'approved',
  '{"adminTool":"employees.credential.auto_renew"}'),
 ('cd300000-0000-4000-8000-000000000002', 'cd000000-0000-4000-8000-0000000000a1', 'admin.policy', 'car rv used', 'employees.credential.auto_renew', 'high', 'approved',
  '{"adminTool":"employees.credential.auto_renew"}'),
 ('cd300000-0000-4000-8000-000000000003', 'cd000000-0000-4000-8000-0000000000a1', 'admin.policy', 'car rv hold', 'employees.credential.auto_renew', 'high', 'approved',
  '{"adminTool":"employees.credential.auto_renew"}'),
 ('cd300000-0000-4000-8000-000000000004', 'cd000000-0000-4000-8000-0000000000a1', 'admin.policy', 'car rv rel', 'employees.credential.auto_renew', 'high', 'approved',
  '{"adminTool":"employees.credential.auto_renew"}'),
 ('cd300000-0000-4000-8000-000000000005', 'cd000000-0000-4000-8000-0000000000a1', 'admin.policy', 'car rv abort', 'employees.credential.auto_renew', 'high', 'approved',
  '{"adminTool":"employees.credential.auto_renew"}')
on conflict (id) do nothing;
insert into public.employee_bindings (employee_id, org_id, credential_generation, credential_fingerprint, status) values
 ('cd100000-0000-4000-8000-000000000001', 'cd000000-0000-4000-8000-0000000000a1', 1, repeat('p', 64), 'unlinked')
on conflict (employee_id) do nothing;

set role service_role;

-- (5) CAS defs pin approved / unheld / live old
do $$
declare def text;
begin
  def := pg_get_functiondef('public.claim_credential_renewal(uuid,uuid,uuid,text,timestamptz)'::regprocedure);
  if def not like '%a.status = ''approved''%' or def not like '%hold_state is null%' or def not like '%c.revoked_at is null%' then
    raise exception 'review followup: claim CAS missing approved/hold/revoked guards';
  end if;
  def := pg_get_functiondef('public.claim_credential_renewal_gen1_http(uuid,uuid,uuid,text,timestamptz)'::regprocedure);
  if def not like '%a.status = ''approved''%' or def not like '%hold_state is null%' or def not like '%c.revoked_at is null%' then
    raise exception 'review followup: gen1 claim CAS missing approved/hold/revoked guards';
  end if;
end $$;

-- (1) unused new
insert into public.credential_renewals (
  id, org_id, employee_id, old_credential_id, new_credential_id, approval_id, threshold, state, mode, overlap_until
) values (
  'cd400000-0000-4000-8000-000000000001',
  'cd000000-0000-4000-8000-0000000000a1',
  'cd100000-0000-4000-8000-000000000001',
  'cd200000-0000-4000-8000-000000000001',
  'cd200000-0000-4000-8000-000000000011',
  'cd300000-0000-4000-8000-000000000001',
  'now', 'claimed', 'gen2', now() - interval '1 second'
) on conflict (id) do nothing;
do $$
begin
  if public.revoke_expired_overlapped_old_credential(
       'cd400000-0000-4000-8000-000000000001',
       'cd000000-0000-4000-8000-0000000000a1',
       'cd200000-0000-4000-8000-000000000001',
       'cd200000-0000-4000-8000-000000000011',
       now()
     ) is distinct from 'unused_new_revoked' then
    raise exception 'review followup: unused new was not revoked';
  end if;
  if (select revoked_at is not null from public.credentials where id = 'cd200000-0000-4000-8000-000000000001') then
    raise exception 'review followup: unused path revoked the old badge';
  end if;
  if (select revoked_at is null from public.credentials where id = 'cd200000-0000-4000-8000-000000000011') then
    raise exception 'review followup: unused new stayed live';
  end if;
  if (select state from public.credential_renewals where id = 'cd400000-0000-4000-8000-000000000001') is distinct from 'expired' then
    raise exception 'review followup: unused path did not expire the renewal';
  end if;
  if (select credential_fingerprint from public.employee_bindings where employee_id = 'cd100000-0000-4000-8000-000000000001') is distinct from repeat('p', 64) then
    raise exception 'review followup: unused path moved the binding';
  end if;
end $$;

-- (2) used new → switchover
insert into public.credential_renewals (
  id, org_id, employee_id, old_credential_id, new_credential_id, approval_id, threshold, state, mode, overlap_until
) values (
  'cd400000-0000-4000-8000-000000000002',
  'cd000000-0000-4000-8000-0000000000a1',
  'cd100000-0000-4000-8000-000000000001',
  'cd200000-0000-4000-8000-000000000021',
  'cd200000-0000-4000-8000-000000000022',
  'cd300000-0000-4000-8000-000000000002',
  '7d', 'claimed', 'gen2', now() - interval '1 second'
) on conflict (id) do nothing;
update public.credentials set last_used_at = now() where id = 'cd200000-0000-4000-8000-000000000022';
update public.employee_bindings
   set credential_fingerprint = repeat('r', 64)
 where employee_id = 'cd100000-0000-4000-8000-000000000001';
do $$
begin
  if public.revoke_expired_overlapped_old_credential(
       'cd400000-0000-4000-8000-000000000002',
       'cd000000-0000-4000-8000-0000000000a1',
       'cd200000-0000-4000-8000-000000000021',
       'cd200000-0000-4000-8000-000000000022',
       now()
     ) is distinct from 'switched' then
    raise exception 'review followup: used new did not switchover';
  end if;
  if (select revoked_at is null from public.credentials where id = 'cd200000-0000-4000-8000-000000000021') then
    raise exception 'review followup: used path left old live';
  end if;
end $$;

-- (3) hold start blocks claimable
insert into public.credential_renewals (
  id, org_id, employee_id, old_credential_id, approval_id, threshold, state, mode, claimable_until
) values (
  'cd400000-0000-4000-8000-000000000003',
  'cd000000-0000-4000-8000-0000000000a1',
  'cd100000-0000-4000-8000-000000000001',
  'cd200000-0000-4000-8000-000000000031',
  'cd300000-0000-4000-8000-000000000003',
  'now', 'claimable', 'gen2', now() + interval '24 hours'
) on conflict (id) do nothing;
select public.start_employee_hold(
  'cd000000-0000-4000-8000-0000000000a1',
  'cd100000-0000-4000-8000-000000000001',
  'stopped', 'rv hold', 'ops:ops-rv', 'ops_console', null, now());
do $$
begin
  if (select state from public.credential_renewals where id = 'cd400000-0000-4000-8000-000000000003') is distinct from 'held_blocked' then
    raise exception 'review followup: hold start left claimable open';
  end if;
end $$;

-- (4) release while held
insert into public.credential_renewals (
  id, org_id, employee_id, old_credential_id, approval_id, threshold, state, mode, claimable_until, claimed_at, claim_token
) values (
  'cd400000-0000-4000-8000-000000000004',
  'cd000000-0000-4000-8000-0000000000a1',
  'cd100000-0000-4000-8000-000000000001',
  'cd200000-0000-4000-8000-000000000041',
  'cd300000-0000-4000-8000-000000000004',
  '7d', 'claimed', 'gen2', now() + interval '24 hours', now(), 'tok_rv_release_012345'
) on conflict (id) do nothing;
do $$
begin
  if not public.release_credential_renewal(
       'cd400000-0000-4000-8000-000000000004',
       'cd000000-0000-4000-8000-0000000000a1',
       'tok_rv_release_012345'
     ) then
    raise exception 'review followup: release while held failed';
  end if;
  if (select state from public.credential_renewals where id = 'cd400000-0000-4000-8000-000000000004') is distinct from 'held_blocked' then
    raise exception 'review followup: release while held did not held_blocked';
  end if;
end $$;

-- (6) abort minted
insert into public.credentials(id, org_id, employee_id, secret_hash, expires_at) values
 ('cd200000-0000-4000-8000-000000000051', 'cd000000-0000-4000-8000-0000000000a1', 'cd100000-0000-4000-8000-000000000001', repeat('v', 64), now() + interval '90 days'),
 ('cd200000-0000-4000-8000-000000000052', 'cd000000-0000-4000-8000-0000000000a1', 'cd100000-0000-4000-8000-000000000001', repeat('w', 64), now() + interval '90 days')
on conflict (id) do nothing;
insert into public.credential_renewals (
  id, org_id, employee_id, old_credential_id, new_credential_id, approval_id, threshold, state, mode, claimed_at, claim_token, overlap_until
) values (
  'cd400000-0000-4000-8000-000000000005',
  'cd000000-0000-4000-8000-0000000000a1',
  'cd100000-0000-4000-8000-000000000001',
  'cd200000-0000-4000-8000-000000000051',
  'cd200000-0000-4000-8000-000000000052',
  'cd300000-0000-4000-8000-000000000005',
  'now', 'claimed', 'gen1_http', now(), 'tok_rv_abort___012345', now() + interval '24 hours'
) on conflict (id) do nothing;
do $$
begin
  if not public.abort_minted_credential_renewal(
       'cd400000-0000-4000-8000-000000000005',
       'cd000000-0000-4000-8000-0000000000a1',
       'tok_rv_abort___012345',
       'cd200000-0000-4000-8000-000000000052'
     ) then
    raise exception 'review followup: abort minted failed';
  end if;
  if (select revoked_at is null from public.credentials where id = 'cd200000-0000-4000-8000-000000000052') then
    raise exception 'review followup: abort left new live';
  end if;
  if (select state from public.credential_renewals where id = 'cd400000-0000-4000-8000-000000000005') is distinct from 'held_blocked' then
    raise exception 'review followup: abort while held did not held_blocked';
  end if;
  if (select new_credential_id from public.credential_renewals where id = 'cd400000-0000-4000-8000-000000000005') is not null then
    raise exception 'review followup: abort left new_credential_id';
  end if;
end $$;

reset role;
do $$
begin
  perform set_config('staffpass.hold_write', 'on', true);
  update public.employees set hold_state = null, hold_id = null where id::text like 'cd100000-%';
  update public.orgs set hold_state = null, hold_id = null where id::text like 'cd000000-%';
end $$;
delete from public.credential_renewals where id::text like 'cd400000-%';
delete from public.approval_requests where id::text like 'cd300000-%';
delete from public.employee_bindings where employee_id::text like 'cd100000-%';
delete from public.credentials where id::text like 'cd200000-%';
delete from public.employees where id::text like 'cd100000-%';
delete from public.orgs where id::text like 'cd000000-%';

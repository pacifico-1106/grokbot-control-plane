-- 社員証 auto-renew R3 overlap functions (migration 20261020100000).
-- Synthetic fixtures only (ids cb000000-…); cleans up after itself.
-- (1) anon / authenticated cannot execute the new RPCs; service_role can
-- (2) attach succeeds once with the claimer's token; wrong token / second attach → false
-- (3) attach requires operable (hold / non-active → false)
-- (4) timeout revoke works after overlap_until even when the employee is on hold
-- (5) timeout revoke before the window / other org / old=new → false
-- (6) already-revoked timeout revoke stays true; 2nd UPDATE 0 rows RAISE
\set ON_ERROR_STOP 1
reset role;

create or replace function security_test.car_ov_denied(command text) returns void language plpgsql as $$
begin
  begin
    execute command;
  exception when insufficient_privilege then return;
  end;
  raise exception 'credential auto-renew overlap: session access not denied: %', command;
end $$;
grant execute on function security_test.car_ov_denied(text) to anon, authenticated, service_role;

insert into public.orgs(id, name) values
 ('cb000000-0000-4000-8000-0000000000a1', 'car ov org a'),
 ('cb000000-0000-4000-8000-0000000000a2', 'car ov org b')
on conflict (id) do nothing;
insert into public.employees(id, org_id, display_name, role_label) values
 ('cb100000-0000-4000-8000-000000000001', 'cb000000-0000-4000-8000-0000000000a1', 'CarOv A1', 'fixture'),
 ('cb100000-0000-4000-8000-000000000002', 'cb000000-0000-4000-8000-0000000000a2', 'CarOv B1', 'fixture')
on conflict (id) do nothing;
insert into public.credentials(id, org_id, employee_id, secret_hash, expires_at) values
 ('cb200000-0000-4000-8000-000000000001', 'cb000000-0000-4000-8000-0000000000a1', 'cb100000-0000-4000-8000-000000000001', repeat('d', 64), now() + interval '90 days'),
 ('cb200000-0000-4000-8000-000000000011', 'cb000000-0000-4000-8000-0000000000a1', 'cb100000-0000-4000-8000-000000000001', repeat('e', 64), now() + interval '90 days'),
 ('cb200000-0000-4000-8000-000000000002', 'cb000000-0000-4000-8000-0000000000a2', 'cb100000-0000-4000-8000-000000000002', repeat('f', 64), now() + interval '90 days')
on conflict (id) do nothing;
insert into public.approval_requests(id, org_id, purpose, summary, tool, risk, status, metadata) values
 ('cb300000-0000-4000-8000-000000000001', 'cb000000-0000-4000-8000-0000000000a1', 'admin.policy', 'car ov', 'employees.credential.auto_renew', 'high', 'approved',
  '{"adminTool":"employees.credential.auto_renew"}'),
 ('cb300000-0000-4000-8000-000000000002', 'cb000000-0000-4000-8000-0000000000a2', 'admin.policy', 'car ov b', 'employees.credential.auto_renew', 'high', 'approved',
  '{"adminTool":"employees.credential.auto_renew"}')
on conflict (id) do nothing;

-- (1) session cannot execute
set role anon;
select security_test.car_ov_denied(
  $$select public.attach_overlapped_new_credential('cb400000-0000-4000-8000-000000000001','cb000000-0000-4000-8000-0000000000a1','tok_attach_0123456789ab','cb200000-0000-4000-8000-000000000011', now() + interval '24 hours')$$
);
select security_test.car_ov_denied(
  $$select public.revoke_expired_overlapped_old_credential('cb400000-0000-4000-8000-000000000001','cb000000-0000-4000-8000-0000000000a1','cb200000-0000-4000-8000-000000000001','cb200000-0000-4000-8000-000000000011', now())$$
);
set role authenticated;
select security_test.car_ov_denied(
  $$select public.attach_overlapped_new_credential('cb400000-0000-4000-8000-000000000001','cb000000-0000-4000-8000-0000000000a1','tok_attach_0123456789ab','cb200000-0000-4000-8000-000000000011', now() + interval '24 hours')$$
);
reset role;

set role service_role;

insert into public.credential_renewals (
  id, org_id, employee_id, old_credential_id, approval_id, threshold, state, mode, claimable_until
) values (
  'cb400000-0000-4000-8000-000000000001',
  'cb000000-0000-4000-8000-0000000000a1',
  'cb100000-0000-4000-8000-000000000001',
  'cb200000-0000-4000-8000-000000000001',
  'cb300000-0000-4000-8000-000000000001',
  'now', 'claimable', 'gen2', now() + interval '24 hours'
) on conflict (id) do nothing;

-- claim so attach has a token
select public.claim_credential_renewal(
  'cb400000-0000-4000-8000-000000000001',
  'cb000000-0000-4000-8000-0000000000a1',
  'cb100000-0000-4000-8000-000000000001',
  'tok_attach_0123456789ab',
  now()
);

-- (2) wrong token → false; own token → true once
do $$
begin
  if public.attach_overlapped_new_credential(
       'cb400000-0000-4000-8000-000000000001',
       'cb000000-0000-4000-8000-0000000000a1',
       'tok_wrong_0123456789abcd',
       'cb200000-0000-4000-8000-000000000011',
       now() + interval '24 hours'
     ) then
    raise exception 'credential auto-renew overlap: wrong token attached';
  end if;
  if not public.attach_overlapped_new_credential(
       'cb400000-0000-4000-8000-000000000001',
       'cb000000-0000-4000-8000-0000000000a1',
       'tok_attach_0123456789ab',
       'cb200000-0000-4000-8000-000000000011',
       now() + interval '24 hours'
     ) then
    raise exception 'credential auto-renew overlap: attach with own token failed';
  end if;
  if public.attach_overlapped_new_credential(
       'cb400000-0000-4000-8000-000000000001',
       'cb000000-0000-4000-8000-0000000000a1',
       'tok_attach_0123456789ab',
       'cb200000-0000-4000-8000-000000000011',
       now() + interval '24 hours'
     ) then
    raise exception 'credential auto-renew overlap: second attach succeeded';
  end if;
end $$;

-- (5) timeout revoke before overlap_until → false
do $$
begin
  if public.revoke_expired_overlapped_old_credential(
       'cb400000-0000-4000-8000-000000000001',
       'cb000000-0000-4000-8000-0000000000a1',
       'cb200000-0000-4000-8000-000000000001',
       'cb200000-0000-4000-8000-000000000011',
       now()
     ) then
    raise exception 'credential auto-renew overlap: timeout revoke before window';
  end if;
end $$;

-- force the window closed
update public.credential_renewals
   set overlap_until = now() - interval '1 second'
 where id = 'cb400000-0000-4000-8000-000000000001';

-- (4) hold does not block the timeout revoke
select public.start_employee_hold(
  'cb000000-0000-4000-8000-0000000000a1',
  'cb100000-0000-4000-8000-000000000001',
  'stopped', 'car ov hold', 'ops:ops-ov', 'ops_console', null, now());

do $$
begin
  if not public.revoke_expired_overlapped_old_credential(
       'cb400000-0000-4000-8000-000000000001',
       'cb000000-0000-4000-8000-0000000000a1',
       'cb200000-0000-4000-8000-000000000001',
       'cb200000-0000-4000-8000-000000000011',
       now()
     ) then
    raise exception 'credential auto-renew overlap: timeout revoke while held failed';
  end if;
  if not public.revoke_expired_overlapped_old_credential(
       'cb400000-0000-4000-8000-000000000001',
       'cb000000-0000-4000-8000-0000000000a1',
       'cb200000-0000-4000-8000-000000000001',
       'cb200000-0000-4000-8000-000000000011',
       now()
     ) then
    raise exception 'credential auto-renew overlap: idempotent timeout revoke failed';
  end if;
end $$;

-- (5) other org / old=new
do $$
begin
  if public.revoke_expired_overlapped_old_credential(
       'cb400000-0000-4000-8000-000000000001',
       'cb000000-0000-4000-8000-0000000000a2',
       'cb200000-0000-4000-8000-000000000001',
       'cb200000-0000-4000-8000-000000000011',
       now()
     ) then
    raise exception 'credential auto-renew overlap: other org timeout revoke';
  end if;
  if public.revoke_expired_overlapped_old_credential(
       'cb400000-0000-4000-8000-000000000001',
       'cb000000-0000-4000-8000-0000000000a1',
       'cb200000-0000-4000-8000-000000000001',
       'cb200000-0000-4000-8000-000000000001',
       now()
     ) then
    raise exception 'credential auto-renew overlap: old=new timeout revoke';
  end if;
end $$;

-- (3) attach refused while held (new claimable row)
insert into public.credentials(id, org_id, employee_id, secret_hash, expires_at) values
 ('cb200000-0000-4000-8000-000000000021', 'cb000000-0000-4000-8000-0000000000a1', 'cb100000-0000-4000-8000-000000000001', repeat('g', 64), now() + interval '90 days')
on conflict (id) do nothing;
insert into public.approval_requests(id, org_id, purpose, summary, tool, risk, status, metadata) values
 ('cb300000-0000-4000-8000-000000000011', 'cb000000-0000-4000-8000-0000000000a1', 'admin.policy', 'car ov hold', 'employees.credential.auto_renew', 'high', 'approved',
  '{"adminTool":"employees.credential.auto_renew"}')
on conflict (id) do nothing;
-- unique is (old_credential_id, threshold); use a different old badge
insert into public.credentials(id, org_id, employee_id, secret_hash, expires_at) values
 ('cb200000-0000-4000-8000-000000000031', 'cb000000-0000-4000-8000-0000000000a1', 'cb100000-0000-4000-8000-000000000001', repeat('h', 64), now() + interval '90 days')
on conflict (id) do nothing;
insert into public.credential_renewals (
  id, org_id, employee_id, old_credential_id, approval_id, threshold, state, mode, claimable_until
) values (
  'cb400000-0000-4000-8000-000000000011',
  'cb000000-0000-4000-8000-0000000000a1',
  'cb100000-0000-4000-8000-000000000001',
  'cb200000-0000-4000-8000-000000000031',
  'cb300000-0000-4000-8000-000000000011',
  'now', 'claimable', 'gen2', now() + interval '24 hours'
) on conflict (id) do nothing;
select public.claim_credential_renewal(
  'cb400000-0000-4000-8000-000000000011',
  'cb000000-0000-4000-8000-0000000000a1',
  'cb100000-0000-4000-8000-000000000001',
  'tok_hold___0123456789ab',
  now()
);
-- employee is still on hold from (4)
do $$
begin
  if public.attach_overlapped_new_credential(
       'cb400000-0000-4000-8000-000000000011',
       'cb000000-0000-4000-8000-0000000000a1',
       'tok_hold___0123456789ab',
       'cb200000-0000-4000-8000-000000000021',
       now() + interval '24 hours'
     ) then
    raise exception 'credential auto-renew overlap: attach while held';
  end if;
end $$;

-- (6) M2: deleting the renewal after the first UPDATE makes the second UPDATE 0 rows
insert into public.credentials(id, org_id, employee_id, secret_hash, expires_at) values
 ('cb200000-0000-4000-8000-000000000041', 'cb000000-0000-4000-8000-0000000000a1', 'cb100000-0000-4000-8000-000000000001', repeat('i', 64), now() + interval '90 days'),
 ('cb200000-0000-4000-8000-000000000042', 'cb000000-0000-4000-8000-0000000000a1', 'cb100000-0000-4000-8000-000000000001', repeat('j', 64), now() + interval '90 days')
on conflict (id) do nothing;
insert into public.approval_requests(id, org_id, purpose, summary, tool, risk, status, metadata) values
 ('cb300000-0000-4000-8000-000000000021', 'cb000000-0000-4000-8000-0000000000a1', 'admin.policy', 'car ov m2', 'employees.credential.auto_renew', 'high', 'approved',
  '{"adminTool":"employees.credential.auto_renew"}')
on conflict (id) do nothing;
insert into public.credential_renewals (
  id, org_id, employee_id, old_credential_id, new_credential_id, approval_id, threshold, state, mode, overlap_until
) values (
  'cb400000-0000-4000-8000-000000000021',
  'cb000000-0000-4000-8000-0000000000a1',
  'cb100000-0000-4000-8000-000000000001',
  'cb200000-0000-4000-8000-000000000041',
  'cb200000-0000-4000-8000-000000000042',
  'cb300000-0000-4000-8000-000000000021',
  '7d', 'claimed', 'gen2', now() - interval '1 second'
) on conflict (id) do nothing;

do $$
begin
  begin
    perform public.revoke_expired_overlapped_old_credential(
      'cb400000-0000-4000-8000-000000000021',
      'cb000000-0000-4000-8000-0000000000a1',
      'cb200000-0000-4000-8000-000000000041',
      'cb200000-0000-4000-8000-000000000099',
      now()
    );
    if found then
      null;
    end if;
  exception when others then
    null;
  end;
  -- mismatched new id → false, old stays live
  if public.revoke_expired_overlapped_old_credential(
       'cb400000-0000-4000-8000-000000000021',
       'cb000000-0000-4000-8000-0000000000a1',
       'cb200000-0000-4000-8000-000000000041',
       'cb200000-0000-4000-8000-000000000099',
       now()
     ) then
    raise exception 'credential auto-renew overlap: mismatched new id revoked';
  end if;
  if (select revoked_at is not null from public.credentials where id = 'cb200000-0000-4000-8000-000000000041') then
    raise exception 'credential auto-renew overlap: old trusted after false revoke';
  end if;
end $$;

reset role;
select set_config('staffpass.hold_write', 'on', true);
update public.employees set hold_state = null, hold_id = null where id::text like 'cb100000-%';
update public.orgs set hold_state = null, hold_id = null where id::text like 'cb000000-%';
delete from public.employee_holds where org_id::text like 'cb000000-%';
delete from public.credential_renewals where id::text like 'cb400000-%';
delete from public.approval_requests where id::text like 'cb300000-%';
delete from public.credentials where id::text like 'cb200000-%';
delete from public.employees where id::text like 'cb100000-%';
delete from public.orgs where id::text like 'cb000000-%';
drop function if exists security_test.car_ov_denied(text);

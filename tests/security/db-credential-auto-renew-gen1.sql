-- 社員証 auto-renew R8 gen1 HTTP claim (migration 20261020200000).
-- Synthetic fixtures only (ids cc000000-…); cleans up after itself.
-- (1) anon / authenticated cannot execute; service_role can
-- (2) claim succeeds once and pins mode=gen1_http; second claim false
-- (3) pending / window-expired / other org / other employee → false
-- (4) hold (employee or org) → false (fail-closed via credential_renewal_operable)
-- (5) no secret / prefix / hash / public-key columns added
\set ON_ERROR_STOP 1
reset role;

do $$
begin
  if to_regnamespace('security_test') is null or current_user is distinct from 'test_admin' then
    raise exception 'db-credential-auto-renew-gen1: refuse outside disposable test cluster';
  end if;
end $$;

create or replace function security_test.car_g1_denied(command text) returns void language plpgsql as $$
begin
  begin
    execute command;
  exception when insufficient_privilege then return;
  end;
  raise exception 'credential auto-renew gen1: session access not denied: %', command;
end $$;
grant execute on function security_test.car_g1_denied(text) to anon, authenticated, service_role;

insert into public.orgs(id, name) values
 ('cc000000-0000-4000-8000-0000000000a1', 'car g1 org a'),
 ('cc000000-0000-4000-8000-0000000000a2', 'car g1 org b')
on conflict (id) do nothing;
insert into public.employees(id, org_id, display_name, role_label) values
 ('cc100000-0000-4000-8000-000000000001', 'cc000000-0000-4000-8000-0000000000a1', 'CarG1 A1', 'fixture'),
 ('cc100000-0000-4000-8000-000000000002', 'cc000000-0000-4000-8000-0000000000a2', 'CarG1 B1', 'fixture')
on conflict (id) do nothing;
insert into public.credentials(id, org_id, employee_id, secret_hash, expires_at) values
 ('cc200000-0000-4000-8000-000000000001', 'cc000000-0000-4000-8000-0000000000a1', 'cc100000-0000-4000-8000-000000000001', repeat('j', 64), now() + interval '90 days'),
 ('cc200000-0000-4000-8000-000000000011', 'cc000000-0000-4000-8000-0000000000a1', 'cc100000-0000-4000-8000-000000000001', repeat('k', 64), now() + interval '90 days'),
 ('cc200000-0000-4000-8000-000000000002', 'cc000000-0000-4000-8000-0000000000a2', 'cc100000-0000-4000-8000-000000000002', repeat('m', 64), now() + interval '90 days')
on conflict (id) do nothing;
insert into public.approval_requests(id, org_id, purpose, summary, tool, risk, status, metadata) values
 ('cc300000-0000-4000-8000-000000000001', 'cc000000-0000-4000-8000-0000000000a1', 'admin.policy', 'car g1', 'employees.credential.auto_renew', 'high', 'approved',
  '{"adminTool":"employees.credential.auto_renew"}'),
 ('cc300000-0000-4000-8000-000000000002', 'cc000000-0000-4000-8000-0000000000a2', 'admin.policy', 'car g1 b', 'employees.credential.auto_renew', 'high', 'approved',
  '{"adminTool":"employees.credential.auto_renew"}'),
 ('cc300000-0000-4000-8000-000000000003', 'cc000000-0000-4000-8000-0000000000a1', 'admin.policy', 'car g1 pending', 'employees.credential.auto_renew', 'high', 'pending',
  '{"adminTool":"employees.credential.auto_renew"}')
on conflict (id) do nothing;

-- (1) session cannot execute
set role anon;
select security_test.car_g1_denied(
  $$select public.claim_credential_renewal_gen1_http('cc400000-0000-4000-8000-000000000001','cc000000-0000-4000-8000-0000000000a1','cc100000-0000-4000-8000-000000000001','tok_gen1_0123456789abcd', now())$$
);
set role authenticated;
select security_test.car_g1_denied(
  $$select public.claim_credential_renewal_gen1_http('cc400000-0000-4000-8000-000000000001','cc000000-0000-4000-8000-0000000000a1','cc100000-0000-4000-8000-000000000001','tok_gen1_0123456789abcd', now())$$
);
reset role;

set role service_role;

insert into public.credential_renewals (
  id, org_id, employee_id, old_credential_id, approval_id, threshold, state, mode, claimable_until
) values (
  'cc400000-0000-4000-8000-000000000001',
  'cc000000-0000-4000-8000-0000000000a1',
  'cc100000-0000-4000-8000-000000000001',
  'cc200000-0000-4000-8000-000000000001',
  'cc300000-0000-4000-8000-000000000001',
  'now', 'claimable', 'gen2', now() + interval '24 hours'
) on conflict (id) do nothing;
insert into public.credential_renewals (
  id, org_id, employee_id, old_credential_id, approval_id, threshold, state, mode, claimable_until
) values (
  'cc400000-0000-4000-8000-000000000003',
  'cc000000-0000-4000-8000-0000000000a1',
  'cc100000-0000-4000-8000-000000000001',
  'cc200000-0000-4000-8000-000000000011',
  'cc300000-0000-4000-8000-000000000003',
  '7d', 'pending_approval', 'gen2', now() + interval '24 hours'
) on conflict (id) do nothing;
insert into public.credential_renewals (
  id, org_id, employee_id, old_credential_id, approval_id, threshold, state, mode, claimable_until
) values (
  'cc400000-0000-4000-8000-00000000000e',
  'cc000000-0000-4000-8000-0000000000a2',
  'cc100000-0000-4000-8000-000000000002',
  'cc200000-0000-4000-8000-000000000002',
  'cc300000-0000-4000-8000-000000000002',
  'now', 'claimable', 'gen2', now() - interval '1 second'
) on conflict (id) do nothing;

do $$
declare tok text := 'tok_gen1_first_01234567';
begin
  -- (3) other org / other employee / pending / window expired
  if public.claim_credential_renewal_gen1_http(
       'cc400000-0000-4000-8000-000000000001',
       'cc000000-0000-4000-8000-0000000000a2',
       'cc100000-0000-4000-8000-000000000001',
       tok, now()
     ) then
    raise exception 'credential auto-renew gen1: other org claimed';
  end if;
  if public.claim_credential_renewal_gen1_http(
       'cc400000-0000-4000-8000-000000000001',
       'cc000000-0000-4000-8000-0000000000a1',
       'cc100000-0000-4000-8000-000000000002',
       tok, now()
     ) then
    raise exception 'credential auto-renew gen1: other employee claimed';
  end if;
  if public.claim_credential_renewal_gen1_http(
       'cc400000-0000-4000-8000-000000000003',
       'cc000000-0000-4000-8000-0000000000a1',
       'cc100000-0000-4000-8000-000000000001',
       tok, now()
     ) then
    raise exception 'credential auto-renew gen1: pending approval claimed';
  end if;
  if public.claim_credential_renewal_gen1_http(
       'cc400000-0000-4000-8000-00000000000e',
       'cc000000-0000-4000-8000-0000000000a2',
       'cc100000-0000-4000-8000-000000000002',
       tok, now()
     ) then
    raise exception 'credential auto-renew gen1: expired window claimed';
  end if;

  -- (2) first claim wins and pins mode
  if not public.claim_credential_renewal_gen1_http(
       'cc400000-0000-4000-8000-000000000001',
       'cc000000-0000-4000-8000-0000000000a1',
       'cc100000-0000-4000-8000-000000000001',
       tok, now()
     ) then
    raise exception 'credential auto-renew gen1: first claim lost';
  end if;
  if exists (
    select 1 from public.credential_renewals
     where id = 'cc400000-0000-4000-8000-000000000001'
       and (state <> 'claimed' or mode <> 'gen1_http' or claim_token is distinct from tok)
  ) then
    raise exception 'credential auto-renew gen1: mode/state not pinned';
  end if;
  if public.claim_credential_renewal_gen1_http(
       'cc400000-0000-4000-8000-000000000001',
       'cc000000-0000-4000-8000-0000000000a1',
       'cc100000-0000-4000-8000-000000000001',
       'tok_gen1_second_0123456', now()
     ) then
    raise exception 'credential auto-renew gen1: second claim won';
  end if;
  if exists (
    select 1 from public.credential_renewals
     where id = 'cc400000-0000-4000-8000-000000000001' and claim_token is distinct from tok
  ) then
    raise exception 'credential auto-renew gen1: first claimer overwritten';
  end if;
end $$;

-- (4) hold: employee on hold cannot claim
insert into public.credentials(id, org_id, employee_id, secret_hash, expires_at) values
 ('cc200000-0000-4000-8000-000000000031', 'cc000000-0000-4000-8000-0000000000a1', 'cc100000-0000-4000-8000-000000000001', repeat('n', 64), now() + interval '90 days')
on conflict (id) do nothing;
insert into public.approval_requests(id, org_id, purpose, summary, tool, risk, status, metadata) values
 ('cc300000-0000-4000-8000-000000000011', 'cc000000-0000-4000-8000-0000000000a1', 'admin.policy', 'car g1 hold', 'employees.credential.auto_renew', 'high', 'approved',
  '{"adminTool":"employees.credential.auto_renew"}')
on conflict (id) do nothing;
insert into public.credential_renewals (
  id, org_id, employee_id, old_credential_id, approval_id, threshold, state, mode, claimable_until
) values (
  'cc400000-0000-4000-8000-000000000011',
  'cc000000-0000-4000-8000-0000000000a1',
  'cc100000-0000-4000-8000-000000000001',
  'cc200000-0000-4000-8000-000000000031',
  'cc300000-0000-4000-8000-000000000011',
  'now', 'claimable', 'gen2', now() + interval '24 hours'
) on conflict (id) do nothing;

do $$
begin
  perform public.start_employee_hold(
    'cc000000-0000-4000-8000-0000000000a1',
    'cc100000-0000-4000-8000-000000000001',
    'stopped', 'g1 employee hold', 'ops:ops-g1', 'ops_console', null, now());
  if public.claim_credential_renewal_gen1_http(
       'cc400000-0000-4000-8000-000000000011',
       'cc000000-0000-4000-8000-0000000000a1',
       'cc100000-0000-4000-8000-000000000001',
       'tok_gen1_held__01234567', now()
     ) then
    raise exception 'credential auto-renew gen1: held employee claimed';
  end if;
  perform set_config('staffpass.hold_write', 'on', true);
  update public.employees
     set hold_state = null, hold_id = null
   where id = 'cc100000-0000-4000-8000-000000000001';
  perform set_config('staffpass.hold_write', '', true);
end $$;

-- (5) no secret columns
do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'credential_renewals'
       and column_name in ('secret_hash', 'secret_prefix', 'public_key', 'public_key_alg', 'prefix', 'one_time_secret')
  ) then
    raise exception 'credential auto-renew gen1: secret/prefix/public-key column present';
  end if;
end $$;

-- cleanup
reset role;
do $$
begin
  perform set_config('staffpass.hold_write', 'on', true);
  update public.employees set hold_state = null, hold_id = null where id::text like 'cc100000-%';
  update public.orgs set hold_state = null, hold_id = null where id::text like 'cc000000-%';
end $$;
delete from public.credential_renewals where id::text like 'cc400000-%';
delete from public.approval_requests where id::text like 'cc300000-%';
delete from public.credentials where id::text like 'cc200000-%';
delete from public.employees where id::text like 'cc100000-%';
delete from public.orgs where id::text like 'cc000000-%';
drop function if exists security_test.car_g1_denied(text);

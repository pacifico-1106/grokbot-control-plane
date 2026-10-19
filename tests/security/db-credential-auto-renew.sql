-- 社員証 auto-renew (migration 20261019100000, CREDENTIAL_AUTO_RENEW_ENABLED).
-- Synthetic fixtures only (ids ca000000-…); cleans up after itself. Runs in
-- scripts/test-db-local.py (plus a 12-way concurrent claim there) and after
-- every migration in scripts/test-db-all-migrations.py.
--  (1) RLS on, no policy; anon / authenticated hold no table privilege and
--      cannot execute the RPCs; service_role can
--  (2) unique (old_credential_id, threshold); 7d and now may coexist; other
--      threshold / state / mode values rejected
--  (3) tenant isolation: org / employee / approval / old+new credentials must
--      match (credential_renewal_cross_org) on insert and update
--  (4) claim succeeds once; second claim (any token) returns false and keeps
--      the first claimer's mark; other org / other employee / pending /
--      window-expired → false
--  (5) release only with the claimer's own token (wrong token / org → false);
--      after new_credential_id is set, release is refused
--  (6) revoke_overlapped_old_credential sets revoked_at; already-revoked
--      still true; other org / old=new → false
--  (7) no secret / prefix / hash / public-key columns; credential delete
--      cascades the renewal row
\set ON_ERROR_STOP 1
reset role;

create or replace function security_test.car_denied(command text) returns void language plpgsql as $$
begin
  begin
    execute command;
  exception when insufficient_privilege then return;
  end;
  raise exception 'credential auto-renew: session access not denied: %', command;
end $$;
create or replace function security_test.car_rejects(command text, expected text) returns void language plpgsql as $$
begin
  begin
    execute command;
  exception when others then
    if position(expected in sqlerrm) > 0 or sqlstate = expected then return; end if;
    raise exception 'credential auto-renew: % failed with "%" / % (expected "%")', command, sqlerrm, sqlstate, expected;
  end;
  raise exception 'credential auto-renew: not rejected: %', command;
end $$;
grant execute on function security_test.car_denied(text), security_test.car_rejects(text, text)
  to anon, authenticated, service_role;

-- (1) RLS on, no policy, no session privilege, no secret columns
do $$
declare r text;
begin
  if not (select relrowsecurity from pg_class where oid = 'public.credential_renewals'::regclass) then
    raise exception 'credential auto-renew: RLS off';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'credential_renewals') then
    raise exception 'credential auto-renew: unexpected policy';
  end if;
  foreach r in array array['anon','authenticated'] loop
    if has_table_privilege(r, 'public.credential_renewals', 'SELECT')
       or has_table_privilege(r, 'public.credential_renewals', 'INSERT')
       or has_table_privilege(r, 'public.credential_renewals', 'UPDATE')
       or has_table_privilege(r, 'public.credential_renewals', 'DELETE') then
      raise exception 'credential auto-renew: % holds a table privilege', r;
    end if;
  end loop;
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'credential_renewals'
       and column_name in ('secret_hash', 'secret_prefix', 'public_key', 'public_key_alg', 'prefix')
  ) then
    raise exception 'credential auto-renew: secret/prefix/public-key column present';
  end if;
end $$;

insert into public.orgs(id, name) values
 ('ca000000-0000-4000-8000-0000000000a1', 'car org a'),
 ('ca000000-0000-4000-8000-0000000000a2', 'car org b')
on conflict (id) do nothing;
insert into public.employees(id, org_id, display_name, role_label) values
 ('ca100000-0000-4000-8000-000000000001', 'ca000000-0000-4000-8000-0000000000a1', 'Car A1', 'fixture'),
 ('ca100000-0000-4000-8000-000000000002', 'ca000000-0000-4000-8000-0000000000a2', 'Car B1', 'fixture');
insert into public.credentials(id, org_id, employee_id, secret_hash, expires_at) values
 ('ca200000-0000-4000-8000-000000000001', 'ca000000-0000-4000-8000-0000000000a1', 'ca100000-0000-4000-8000-000000000001', repeat('a', 64), now() + interval '90 days'),
 ('ca200000-0000-4000-8000-000000000011', 'ca000000-0000-4000-8000-0000000000a1', 'ca100000-0000-4000-8000-000000000001', repeat('n', 64), now() + interval '90 days'),
 ('ca200000-0000-4000-8000-000000000002', 'ca000000-0000-4000-8000-0000000000a2', 'ca100000-0000-4000-8000-000000000002', repeat('b', 64), now() + interval '90 days');
insert into public.approval_requests(id, org_id, purpose, summary, tool, risk, status, metadata) values
 ('ca300000-0000-4000-8000-000000000001', 'ca000000-0000-4000-8000-0000000000a1', 'admin.policy', 'car', 'employees.credential.auto_renew', 'high', 'approved',
  '{"adminTool":"employees.credential.auto_renew"}'),
 ('ca300000-0000-4000-8000-000000000002', 'ca000000-0000-4000-8000-0000000000a2', 'admin.policy', 'car', 'employees.credential.auto_renew', 'high', 'approved',
  '{"adminTool":"employees.credential.auto_renew"}'),
 ('ca300000-0000-4000-8000-000000000003', 'ca000000-0000-4000-8000-0000000000a1', 'admin.policy', 'car pending', 'employees.credential.auto_renew', 'high', 'pending',
  '{"adminTool":"employees.credential.auto_renew"}');

set role service_role;

-- (2) unique (old_credential_id, threshold); 7d and now coexist
insert into public.credential_renewals (
  id, org_id, employee_id, old_credential_id, approval_id, threshold, state, mode, claimable_until
) values (
  'ca400000-0000-4000-8000-000000000001',
  'ca000000-0000-4000-8000-0000000000a1',
  'ca100000-0000-4000-8000-000000000001',
  'ca200000-0000-4000-8000-000000000001',
  'ca300000-0000-4000-8000-000000000001',
  'now', 'claimable', 'gen1_http', now() + interval '24 hours'
);
insert into public.credential_renewals (
  id, org_id, employee_id, old_credential_id, approval_id, threshold, state, mode
) values (
  'ca400000-0000-4000-8000-000000000007',
  'ca000000-0000-4000-8000-0000000000a1',
  'ca100000-0000-4000-8000-000000000001',
  'ca200000-0000-4000-8000-000000000001',
  'ca300000-0000-4000-8000-000000000001',
  '7d', 'pending_approval', 'gen2'
);
select security_test.car_rejects($q$insert into public.credential_renewals (
  org_id, employee_id, old_credential_id, approval_id, threshold, state
) values (
  'ca000000-0000-4000-8000-0000000000a1',
  'ca100000-0000-4000-8000-000000000001',
  'ca200000-0000-4000-8000-000000000001',
  'ca300000-0000-4000-8000-000000000001',
  'now', 'pending_approval'
)$q$, '23505');
select security_test.car_rejects($q$insert into public.credential_renewals (
  org_id, employee_id, old_credential_id, approval_id, threshold
) values (
  'ca000000-0000-4000-8000-0000000000a1',
  'ca100000-0000-4000-8000-000000000001',
  'ca200000-0000-4000-8000-000000000001',
  'ca300000-0000-4000-8000-000000000001',
  '1d'
)$q$, '23514');
select security_test.car_rejects($q$insert into public.credential_renewals (
  org_id, employee_id, old_credential_id, approval_id, threshold, state
) values (
  'ca000000-0000-4000-8000-0000000000a1',
  'ca100000-0000-4000-8000-000000000001',
  'ca200000-0000-4000-8000-000000000011',
  'ca300000-0000-4000-8000-000000000001',
  'now', 'not_a_state'
)$q$, '23514');
select security_test.car_rejects($q$insert into public.credential_renewals (
  org_id, employee_id, old_credential_id, approval_id, threshold, mode
) values (
  'ca000000-0000-4000-8000-0000000000a1',
  'ca100000-0000-4000-8000-000000000001',
  'ca200000-0000-4000-8000-000000000011',
  'ca300000-0000-4000-8000-000000000001',
  'now', 'gb_emp'
)$q$, '23514');

-- (3) cross-org: org B credential under org A; org A row with org B employee;
--     org B approval; new credential of the other org; update moving org
select security_test.car_rejects($q$insert into public.credential_renewals (
  org_id, employee_id, old_credential_id, approval_id, threshold
) values (
  'ca000000-0000-4000-8000-0000000000a1',
  'ca100000-0000-4000-8000-000000000002',
  'ca200000-0000-4000-8000-000000000002',
  'ca300000-0000-4000-8000-000000000001',
  'now'
)$q$, 'credential_renewal_cross_org');
select security_test.car_rejects($q$insert into public.credential_renewals (
  org_id, employee_id, old_credential_id, approval_id, threshold
) values (
  'ca000000-0000-4000-8000-0000000000a1',
  'ca100000-0000-4000-8000-000000000001',
  'ca200000-0000-4000-8000-000000000001',
  'ca300000-0000-4000-8000-000000000002',
  'now'
)$q$, 'credential_renewal_cross_org');
select security_test.car_rejects($q$update public.credential_renewals
  set org_id = 'ca000000-0000-4000-8000-0000000000a2'
  where id = 'ca400000-0000-4000-8000-000000000001'$q$, 'credential_renewal_cross_org');
select security_test.car_rejects($q$update public.credential_renewals
  set employee_id = 'ca100000-0000-4000-8000-000000000002'
  where id = 'ca400000-0000-4000-8000-000000000001'$q$, 'credential_renewal_cross_org');
select security_test.car_rejects($q$update public.credential_renewals
  set new_credential_id = 'ca200000-0000-4000-8000-000000000002'
  where id = 'ca400000-0000-4000-8000-000000000001'$q$, 'credential_renewal_cross_org');
select security_test.car_rejects($q$update public.credential_renewals
  set new_credential_id = old_credential_id
  where id = 'ca400000-0000-4000-8000-000000000001'$q$, 'credential_renewal_cross_org');

-- pending + expired-window rows for claim negatives
insert into public.credential_renewals (
  id, org_id, employee_id, old_credential_id, approval_id, threshold, state, claimable_until
) values (
  'ca400000-0000-4000-8000-000000000003',
  'ca000000-0000-4000-8000-0000000000a1',
  'ca100000-0000-4000-8000-000000000001',
  'ca200000-0000-4000-8000-000000000011',
  'ca300000-0000-4000-8000-000000000003',
  '7d', 'pending_approval', now() + interval '24 hours'
);
insert into public.credential_renewals (
  id, org_id, employee_id, old_credential_id, approval_id, threshold, state, claimable_until
) values (
  'ca400000-0000-4000-8000-00000000000e',
  'ca000000-0000-4000-8000-0000000000a2',
  'ca100000-0000-4000-8000-000000000002',
  'ca200000-0000-4000-8000-000000000002',
  'ca300000-0000-4000-8000-000000000002',
  'now', 'claimable', now() - interval '1 second'
);

do $$
declare tok text := 'tok_first_0123456789abcd';
begin
  -- (4) other org / other employee / pending / window expired
  if public.claim_credential_renewal(
       'ca400000-0000-4000-8000-000000000001',
       'ca000000-0000-4000-8000-0000000000a2',
       'ca100000-0000-4000-8000-000000000001',
       'tok_other_org_0123456789', now()) then
    raise exception 'credential auto-renew: another org claimed the row'; end if;
  if public.claim_credential_renewal(
       'ca400000-0000-4000-8000-000000000001',
       'ca000000-0000-4000-8000-0000000000a1',
       'ca100000-0000-4000-8000-000000000002',
       'tok_other_emp_0123456789', now()) then
    raise exception 'credential auto-renew: another employee claimed the row'; end if;
  if public.claim_credential_renewal(
       'ca400000-0000-4000-8000-000000000003',
       'ca000000-0000-4000-8000-0000000000a1',
       'ca100000-0000-4000-8000-000000000001',
       'tok_pending_0123456789ab', now()) then
    raise exception 'credential auto-renew: pending row claimed'; end if;
  if public.claim_credential_renewal(
       'ca400000-0000-4000-8000-00000000000e',
       'ca000000-0000-4000-8000-0000000000a2',
       'ca100000-0000-4000-8000-000000000002',
       'tok_expired_0123456789ab', now()) then
    raise exception 'credential auto-renew: expired window claimed'; end if;
  -- first claim wins, second loses, first mark kept
  if not public.claim_credential_renewal(
       'ca400000-0000-4000-8000-000000000001',
       'ca000000-0000-4000-8000-0000000000a1',
       'ca100000-0000-4000-8000-000000000001',
       tok, now()) then
    raise exception 'credential auto-renew: first claim failed'; end if;
  if public.claim_credential_renewal(
       'ca400000-0000-4000-8000-000000000001',
       'ca000000-0000-4000-8000-0000000000a1',
       'ca100000-0000-4000-8000-000000000001',
       'tok_second_0123456789abc', now()) then
    raise exception 'credential auto-renew: second claim succeeded'; end if;
  if (select claim_token from public.credential_renewals
       where id = 'ca400000-0000-4000-8000-000000000001') is distinct from tok
     or (select state from public.credential_renewals
          where id = 'ca400000-0000-4000-8000-000000000001') <> 'claimed'
     or (select claimed_at from public.credential_renewals
          where id = 'ca400000-0000-4000-8000-000000000001') is null then
    raise exception 'credential auto-renew: mark not the first claimer''s'; end if;
  -- (5) release with the wrong token / wrong org refused
  if public.release_credential_renewal(
       'ca400000-0000-4000-8000-000000000001',
       'ca000000-0000-4000-8000-0000000000a1',
       'tok_second_0123456789abc') then
    raise exception 'credential auto-renew: release with a foreign token succeeded'; end if;
  if public.release_credential_renewal(
       'ca400000-0000-4000-8000-000000000001',
       'ca000000-0000-4000-8000-0000000000a2',
       tok) then
    raise exception 'credential auto-renew: release from another org succeeded'; end if;
  if (select claim_token from public.credential_renewals
       where id = 'ca400000-0000-4000-8000-000000000001') is distinct from tok then
    raise exception 'credential auto-renew: mark changed by a refused release'; end if;
  -- own-token release, claim again
  if not public.release_credential_renewal(
       'ca400000-0000-4000-8000-000000000001',
       'ca000000-0000-4000-8000-0000000000a1',
       tok) then
    raise exception 'credential auto-renew: own release refused'; end if;
  if not public.claim_credential_renewal(
       'ca400000-0000-4000-8000-000000000001',
       'ca000000-0000-4000-8000-0000000000a1',
       'ca100000-0000-4000-8000-000000000001',
       'tok_third_0123456789abcd', now()) then
    raise exception 'credential auto-renew: re-claim after release failed'; end if;
  -- after new_credential_id is stored, release is refused
  update public.credential_renewals
     set new_credential_id = 'ca200000-0000-4000-8000-000000000011'
   where id = 'ca400000-0000-4000-8000-000000000001';
  if public.release_credential_renewal(
       'ca400000-0000-4000-8000-000000000001',
       'ca000000-0000-4000-8000-0000000000a1',
       'tok_third_0123456789abcd') then
    raise exception 'credential auto-renew: release after mint succeeded'; end if;
  -- (6) revoke overlapped old; already-revoked still true; other org / old=new false
  if public.revoke_overlapped_old_credential(
       'ca400000-0000-4000-8000-000000000001',
       'ca000000-0000-4000-8000-0000000000a2',
       'ca200000-0000-4000-8000-000000000001',
       'ca200000-0000-4000-8000-000000000011') then
    raise exception 'credential auto-renew: other org revoked the old row'; end if;
  if public.revoke_overlapped_old_credential(
       'ca400000-0000-4000-8000-000000000001',
       'ca000000-0000-4000-8000-0000000000a1',
       'ca200000-0000-4000-8000-000000000001',
       'ca200000-0000-4000-8000-000000000001') then
    raise exception 'credential auto-renew: old=new revoke succeeded'; end if;
  if not public.revoke_overlapped_old_credential(
       'ca400000-0000-4000-8000-000000000001',
       'ca000000-0000-4000-8000-0000000000a1',
       'ca200000-0000-4000-8000-000000000001',
       'ca200000-0000-4000-8000-000000000011') then
    raise exception 'credential auto-renew: first revoke failed'; end if;
  if (select revoked_at from public.credentials
       where id = 'ca200000-0000-4000-8000-000000000001') is null
     or (select state from public.credential_renewals
          where id = 'ca400000-0000-4000-8000-000000000001') <> 'old_revoked'
     or (select old_revoked_at from public.credential_renewals
          where id = 'ca400000-0000-4000-8000-000000000001') is null then
    raise exception 'credential auto-renew: old row not revoked'; end if;
  if (select revoked_at from public.credentials
       where id = 'ca200000-0000-4000-8000-000000000011') is not null then
    raise exception 'credential auto-renew: new row was revoked'; end if;
  if not public.revoke_overlapped_old_credential(
       'ca400000-0000-4000-8000-000000000001',
       'ca000000-0000-4000-8000-0000000000a1',
       'ca200000-0000-4000-8000-000000000001',
       'ca200000-0000-4000-8000-000000000011') then
    raise exception 'credential auto-renew: already-revoked did not return true'; end if;
  -- short / empty token refused
  begin
    perform public.claim_credential_renewal(
      'ca400000-0000-4000-8000-000000000003',
      'ca000000-0000-4000-8000-0000000000a1',
      'ca100000-0000-4000-8000-000000000001',
      'short', now());
    raise exception 'credential auto-renew: short token accepted';
  exception when others then
    if sqlerrm not like '%invalid_claim_token%' then raise; end if;
  end;
end $$;
reset role;

-- (1) sessions denied
set role authenticated;
select security_test.car_denied('select * from public.credential_renewals');
select security_test.car_denied($q$insert into public.credential_renewals (
  org_id, employee_id, old_credential_id, approval_id, threshold
) values (
  'ca000000-0000-4000-8000-0000000000a1',
  'ca100000-0000-4000-8000-000000000001',
  'ca200000-0000-4000-8000-000000000001',
  'ca300000-0000-4000-8000-000000000001',
  'now'
)$q$);
select security_test.car_denied('delete from public.credential_renewals');
select security_test.car_denied($q$select public.claim_credential_renewal(
  'ca400000-0000-4000-8000-000000000001','ca000000-0000-4000-8000-0000000000a1',
  'ca100000-0000-4000-8000-000000000001','tok_auth_0123456789abcdef', now())$q$);
select security_test.car_denied($q$select public.release_credential_renewal(
  'ca400000-0000-4000-8000-000000000001','ca000000-0000-4000-8000-0000000000a1',
  'tok_auth_0123456789abcdef')$q$);
select security_test.car_denied($q$select public.revoke_overlapped_old_credential(
  'ca400000-0000-4000-8000-000000000001','ca000000-0000-4000-8000-0000000000a1',
  'ca200000-0000-4000-8000-000000000001','ca200000-0000-4000-8000-000000000011')$q$);
set role anon;
select security_test.car_denied('select * from public.credential_renewals');
select security_test.car_denied($q$select public.claim_credential_renewal(
  'ca400000-0000-4000-8000-000000000001','ca000000-0000-4000-8000-0000000000a1',
  'ca100000-0000-4000-8000-000000000001','tok_anon_0123456789abcdef', now())$q$);
reset role;

-- M1: claim / release refuse inactive employee, revoked old badge, unapproved ticket
insert into public.employees(id, org_id, display_name, role_label, status) values
 ('ca100000-0000-4000-8000-000000000051', 'ca000000-0000-4000-8000-0000000000a1', 'Car suspended', 'fixture', 'suspended');
insert into public.credentials(id, org_id, employee_id, secret_hash, expires_at) values
 ('ca200000-0000-4000-8000-000000000051', 'ca000000-0000-4000-8000-0000000000a1', 'ca100000-0000-4000-8000-000000000051', repeat('s', 64), now() + interval '90 days'),
 ('ca200000-0000-4000-8000-000000000061', 'ca000000-0000-4000-8000-0000000000a1', 'ca100000-0000-4000-8000-000000000001', repeat('r', 64), now() + interval '90 days');
update public.credentials set revoked_at = now()
 where id = 'ca200000-0000-4000-8000-000000000061';
insert into public.approval_requests(id, org_id, purpose, summary, tool, risk, status, metadata) values
 ('ca300000-0000-4000-8000-000000000051', 'ca000000-0000-4000-8000-0000000000a1', 'admin.policy', 'car sus', 'employees.credential.auto_renew', 'high', 'approved',
  '{"adminTool":"employees.credential.auto_renew"}');
insert into public.credential_renewals (
  id, org_id, employee_id, old_credential_id, approval_id, threshold, state, claimable_until
) values
 ('ca400000-0000-4000-8000-000000000051',
  'ca000000-0000-4000-8000-0000000000a1',
  'ca100000-0000-4000-8000-000000000051',
  'ca200000-0000-4000-8000-000000000051',
  'ca300000-0000-4000-8000-000000000051',
  'now', 'claimable', now() + interval '24 hours'),
 ('ca400000-0000-4000-8000-000000000061',
  'ca000000-0000-4000-8000-0000000000a1',
  'ca100000-0000-4000-8000-000000000001',
  'ca200000-0000-4000-8000-000000000061',
  'ca300000-0000-4000-8000-000000000001',
  'now', 'claimable', now() + interval '24 hours');
-- claimable row whose ticket is still pending (reuse 003 approval + leftover 011-style cred)
insert into public.credentials(id, org_id, employee_id, secret_hash, expires_at) values
 ('ca200000-0000-4000-8000-000000000071', 'ca000000-0000-4000-8000-0000000000a1', 'ca100000-0000-4000-8000-000000000001', repeat('p', 64), now() + interval '90 days');
insert into public.credential_renewals (
  id, org_id, employee_id, old_credential_id, approval_id, threshold, state, claimable_until
) values (
  'ca400000-0000-4000-8000-000000000071',
  'ca000000-0000-4000-8000-0000000000a1',
  'ca100000-0000-4000-8000-000000000001',
  'ca200000-0000-4000-8000-000000000071',
  'ca300000-0000-4000-8000-000000000003',
  'now', 'claimable', now() + interval '24 hours'
);

set role service_role;
do $$
begin
  if public.claim_credential_renewal(
       'ca400000-0000-4000-8000-000000000051',
       'ca000000-0000-4000-8000-0000000000a1',
       'ca100000-0000-4000-8000-000000000051',
       'tok_suspended_0123456789', now()) then
    raise exception 'credential auto-renew M1: suspended employee claimed'; end if;
  if public.claim_credential_renewal(
       'ca400000-0000-4000-8000-000000000061',
       'ca000000-0000-4000-8000-0000000000a1',
       'ca100000-0000-4000-8000-000000000001',
       'tok_revoked_old_01234567', now()) then
    raise exception 'credential auto-renew M1: revoked old credential claimed'; end if;
  if public.claim_credential_renewal(
       'ca400000-0000-4000-8000-000000000071',
       'ca000000-0000-4000-8000-0000000000a1',
       'ca100000-0000-4000-8000-000000000001',
       'tok_unapproved_012345678', now()) then
    raise exception 'credential auto-renew M1: unapproved ticket claimed'; end if;
end $$;
reset role;

-- L2/L4: expired claimable is marked expired
set role service_role;
do $$
declare n integer;
begin
  n := public.expire_stale_credential_renewals('ca000000-0000-4000-8000-0000000000a2', now());
  if n < 1 then
    raise exception 'credential auto-renew L2/L4: expired claimable not swept'; end if;
  if (select state from public.credential_renewals
       where id = 'ca400000-0000-4000-8000-00000000000e') <> 'expired' then
    raise exception 'credential auto-renew L2/L4: row not expired'; end if;
end $$;
reset role;

-- L-D: claim refuses employee / org hold_state; stuck claimed (no new_id, >24h)
-- is swept and claimed-with-new_id is not
insert into public.orgs(id, name) values
 ('ca000000-0000-4000-8000-0000000000d0', 'car org hold')
on conflict (id) do nothing;
insert into public.employees(id, org_id, display_name, role_label) values
 ('ca100000-0000-4000-8000-0000000000d1', 'ca000000-0000-4000-8000-0000000000a1', 'Car hold emp', 'fixture'),
 ('ca100000-0000-4000-8000-0000000000d2', 'ca000000-0000-4000-8000-0000000000d0', 'Car hold org emp', 'fixture');
insert into public.credentials(id, org_id, employee_id, secret_hash, expires_at) values
 ('ca200000-0000-4000-8000-0000000000d1', 'ca000000-0000-4000-8000-0000000000a1', 'ca100000-0000-4000-8000-0000000000d1', repeat('1', 64), now() + interval '90 days'),
 ('ca200000-0000-4000-8000-0000000000d2', 'ca000000-0000-4000-8000-0000000000d0', 'ca100000-0000-4000-8000-0000000000d2', repeat('2', 64), now() + interval '90 days'),
 ('ca200000-0000-4000-8000-0000000000d3', 'ca000000-0000-4000-8000-0000000000a1', 'ca100000-0000-4000-8000-000000000001', repeat('3', 64), now() + interval '90 days'),
 ('ca200000-0000-4000-8000-0000000000d4', 'ca000000-0000-4000-8000-0000000000a1', 'ca100000-0000-4000-8000-000000000001', repeat('4', 64), now() + interval '90 days'),
 ('ca200000-0000-4000-8000-0000000000d5', 'ca000000-0000-4000-8000-0000000000a1', 'ca100000-0000-4000-8000-000000000001', repeat('5', 64), now() + interval '90 days'),
 ('ca200000-0000-4000-8000-0000000000d6', 'ca000000-0000-4000-8000-0000000000a1', 'ca100000-0000-4000-8000-000000000001', repeat('6', 64), now() + interval '90 days');
insert into public.approval_requests(id, org_id, purpose, summary, tool, risk, status, metadata) values
 ('ca300000-0000-4000-8000-0000000000d1', 'ca000000-0000-4000-8000-0000000000a1', 'admin.policy', 'car hold emp', 'employees.credential.auto_renew', 'high', 'approved',
  '{"adminTool":"employees.credential.auto_renew"}'),
 ('ca300000-0000-4000-8000-0000000000d2', 'ca000000-0000-4000-8000-0000000000d0', 'admin.policy', 'car hold org', 'employees.credential.auto_renew', 'high', 'approved',
  '{"adminTool":"employees.credential.auto_renew"}');
insert into public.credential_renewals (
  id, org_id, employee_id, old_credential_id, approval_id, threshold, state, claimable_until
) values
 ('ca400000-0000-4000-8000-0000000000d1',
  'ca000000-0000-4000-8000-0000000000a1',
  'ca100000-0000-4000-8000-0000000000d1',
  'ca200000-0000-4000-8000-0000000000d1',
  'ca300000-0000-4000-8000-0000000000d1',
  'now', 'claimable', now() + interval '24 hours'),
 ('ca400000-0000-4000-8000-0000000000d2',
  'ca000000-0000-4000-8000-0000000000d0',
  'ca100000-0000-4000-8000-0000000000d2',
  'ca200000-0000-4000-8000-0000000000d2',
  'ca300000-0000-4000-8000-0000000000d2',
  'now', 'claimable', now() + interval '24 hours');
insert into public.credential_renewals (
  id, org_id, employee_id, old_credential_id, new_credential_id, approval_id, threshold, state, claimed_at
) values
 ('ca400000-0000-4000-8000-0000000000d3',
  'ca000000-0000-4000-8000-0000000000a1',
  'ca100000-0000-4000-8000-000000000001',
  'ca200000-0000-4000-8000-0000000000d3',
  null,
  'ca300000-0000-4000-8000-000000000001',
  'now', 'claimed', now() - interval '25 hours'),
 ('ca400000-0000-4000-8000-0000000000d4',
  'ca000000-0000-4000-8000-0000000000a1',
  'ca100000-0000-4000-8000-000000000001',
  'ca200000-0000-4000-8000-0000000000d5',
  'ca200000-0000-4000-8000-0000000000d6',
  'ca300000-0000-4000-8000-000000000001',
  '7d', 'claimed', now() - interval '25 hours');

set role service_role;
do $$
declare n integer;
begin
  perform public.start_employee_hold(
    'ca000000-0000-4000-8000-0000000000a1',
    'ca100000-0000-4000-8000-0000000000d1',
    'stopped', 'ld employee hold', 'ops:ops-ld', 'ops_console', null, now());
  perform public.start_employee_hold(
    'ca000000-0000-4000-8000-0000000000d0',
    null,
    'stopped', 'ld org hold', 'ops:ops-ld', 'ops_console', null, now());
  if public.claim_credential_renewal(
       'ca400000-0000-4000-8000-0000000000d1',
       'ca000000-0000-4000-8000-0000000000a1',
       'ca100000-0000-4000-8000-0000000000d1',
       'tok_emp_hold_0123456789', now()) then
    raise exception 'credential auto-renew L-D: employee hold_state claimed'; end if;
  if public.claim_credential_renewal(
       'ca400000-0000-4000-8000-0000000000d2',
       'ca000000-0000-4000-8000-0000000000d0',
       'ca100000-0000-4000-8000-0000000000d2',
       'tok_org_hold_0123456789', now()) then
    raise exception 'credential auto-renew L-D: org hold_state claimed'; end if;
  n := public.expire_stale_credential_renewals('ca000000-0000-4000-8000-0000000000a1', now());
  if n < 1 then
    raise exception 'credential auto-renew L-D: stuck claimed not swept'; end if;
  if (select state from public.credential_renewals
       where id = 'ca400000-0000-4000-8000-0000000000d3') <> 'expired' then
    raise exception 'credential auto-renew L-D: stuck claimed (no new_id) not expired'; end if;
  if (select state from public.credential_renewals
       where id = 'ca400000-0000-4000-8000-0000000000d4') <> 'claimed' then
    raise exception 'credential auto-renew L-D: claimed-with-new_id was swept'; end if;
end $$;
reset role;

-- M3: deleting the NEW credential is RESTRICTED; release still refused
set role service_role;
select security_test.car_rejects(
  $q$delete from public.credentials where id = 'ca200000-0000-4000-8000-000000000011'$q$,
  '23503');
do $$
begin
  if public.release_credential_renewal(
       'ca400000-0000-4000-8000-000000000001',
       'ca000000-0000-4000-8000-0000000000a1',
       'tok_third_0123456789abcd') then
    raise exception 'credential auto-renew M3: release after new credential still succeeded'; end if;
end $$;
reset role;

-- M2: if the renewal row vanishes after the first UPDATE, RAISE and roll back
reset role;
create or replace function security_test.car_drop_renewal() returns trigger language plpgsql as $$
begin
  delete from public.credential_renewals where id = 'ca400000-0000-4000-8000-0000000000a2';
  return new;
end $$;
grant execute on function security_test.car_drop_renewal() to service_role;
set role service_role;
insert into public.credentials(id, org_id, employee_id, secret_hash, expires_at) values
 ('ca200000-0000-4000-8000-0000000000a2', 'ca000000-0000-4000-8000-0000000000a1', 'ca100000-0000-4000-8000-000000000001', repeat('m', 64), now() + interval '90 days'),
 ('ca200000-0000-4000-8000-0000000000b2', 'ca000000-0000-4000-8000-0000000000a1', 'ca100000-0000-4000-8000-000000000001', repeat('k', 64), now() + interval '90 days');
insert into public.credential_renewals (
  id, org_id, employee_id, old_credential_id, new_credential_id, approval_id, threshold, state, claimed_at
) values (
  'ca400000-0000-4000-8000-0000000000a2',
  'ca000000-0000-4000-8000-0000000000a1',
  'ca100000-0000-4000-8000-000000000001',
  'ca200000-0000-4000-8000-0000000000a2',
  'ca200000-0000-4000-8000-0000000000b2',
  'ca300000-0000-4000-8000-000000000001',
  '7d', 'claimed', now()
);
drop trigger if exists car_drop_renewal on public.credentials;
create trigger car_drop_renewal
  after update of revoked_at on public.credentials
  for each row
  when (new.id = 'ca200000-0000-4000-8000-0000000000a2')
  execute function security_test.car_drop_renewal();
do $$
begin
  begin
    perform public.revoke_overlapped_old_credential(
      'ca400000-0000-4000-8000-0000000000a2',
      'ca000000-0000-4000-8000-0000000000a1',
      'ca200000-0000-4000-8000-0000000000a2',
      'ca200000-0000-4000-8000-0000000000b2');
    raise exception 'credential auto-renew M2: incomplete revoke did not RAISE';
  exception when others then
    if sqlerrm not like '%credential_renewal_revoke_incomplete%' then raise; end if;
  end;
  if (select revoked_at from public.credentials
       where id = 'ca200000-0000-4000-8000-0000000000a2') is not null then
    raise exception 'credential auto-renew M2: first UPDATE was not rolled back';
  end if;
end $$;
reset role;
drop trigger if exists car_drop_renewal on public.credentials;
drop function if exists security_test.car_drop_renewal();

-- (7) cascade on old-credential delete
delete from public.credentials where id = 'ca200000-0000-4000-8000-000000000001';
do $$
begin
  if exists (select 1 from public.credential_renewals
              where old_credential_id = 'ca200000-0000-4000-8000-000000000001') then
    raise exception 'credential auto-renew: credential delete did not cascade';
  end if;
end $$;

-- cleanup
alter table public.employee_holds disable trigger employee_holds_guard;
alter table public.employees disable trigger employees_hold_guard;
alter table public.orgs disable trigger orgs_hold_guard;
update public.employees set hold_state = null, hold_id = null where id::text like 'ca1%';
update public.orgs set hold_state = null, hold_id = null where id::text like 'ca0%';
delete from public.employee_holds where org_id::text like 'ca0%';
delete from public.credential_renewals where id::text like 'ca4%';
delete from public.approval_requests where id::text like 'ca3%';
delete from public.credentials where id::text like 'ca2%';
delete from public.employees where id::text like 'ca1%';
delete from public.orgs where id::text like 'ca0%';
drop function security_test.car_denied(text);
drop function security_test.car_rejects(text, text);

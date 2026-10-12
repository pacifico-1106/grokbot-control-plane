-- LINE PoC per-employee accounts + secrets + inbound dedup + link-code limits
-- (migration 20261013200000). Synthetic fixtures (ec* uuids); cleans up after itself.
-- Runs in scripts/test-db-local.py and after every migration in test-db-all-migrations.py.
--  (1) 5 tables: RLS on, only the restrictive deny-all policy; anon / authenticated
--      hold no privilege and cannot execute the 2 functions
--  (2) accounts: one per employee per surface; an external account id is unique across
--      ALL orgs; employee must belong to the same org; value CHECKs (U+32hex, 43-char ref,
--      surface 'line' only for now, disabled ⇔ disabled_at)
--  (3) secrets: ciphertext format v2 only (no plaintext JSON), org must match account
--  (4) inbound events: same (account, event key) twice → 23505
--  (5) link-code limits (one reservation before the comparison): sender 5 attempts in 15 min →
--      the 6th refused + locked 1 h; a released (right) attempt does not count; account 30 in
--      1 h → the 31st locks with notify 'account_locked' once; the 3rd lock in 24 h →
--      'account_locked_repeat' once; another org's keys unaffected; locks expire
\set ON_ERROR_STOP 1
reset role;

create or replace function security_test.eca_rejects(command text, expected text) returns void language plpgsql as $$
begin
  begin
    execute command;
  exception when others then
    if position(expected in sqlerrm) > 0 or sqlstate = expected then return; end if;
    raise exception 'comm accounts: % failed with "%" / % (expected "%")', command, sqlerrm, sqlstate, expected;
  end;
  raise exception 'comm accounts: not rejected: %', command;
end $$;
create or replace function security_test.eca_denied(command text) returns void language plpgsql as $$
begin
  begin
    execute command;
  exception when insufficient_privilege then return;
  end;
  raise exception 'comm accounts: session access not denied: %', command;
end $$;
grant execute on function security_test.eca_rejects(text, text), security_test.eca_denied(text) to anon, authenticated, service_role;

-- (1)
do $$
declare r text; t text;
begin
  foreach t in array array['employee_comm_accounts','employee_comm_account_secrets','comm_inbound_events',
                           'comm_link_code_attempts','comm_link_code_locks','comm_link_code_lock_events'] loop
    if to_regclass('public.' || t) is null then raise exception 'comm accounts: table % missing', t; end if;
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then
      raise exception 'comm accounts: RLS off on %', t;
    end if;
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = t
               and not (permissive = 'RESTRICTIVE' and qual = 'false')) then
      raise exception 'comm accounts: unexpected policy on %', t;
    end if;
    foreach r in array array['anon','authenticated'] loop
      if has_table_privilege(r, 'public.' || t, 'SELECT') or has_table_privilege(r, 'public.' || t, 'INSERT')
         or has_table_privilege(r, 'public.' || t, 'UPDATE') or has_table_privilege(r, 'public.' || t, 'DELETE') then
        raise exception 'comm accounts: % holds a privilege on %', r, t;
      end if;
    end loop;
  end loop;
  foreach r in array array['anon','authenticated'] loop
    if has_function_privilege(r, 'public.comm_link_code_reserve_attempt(uuid,text,text,timestamptz)', 'EXECUTE')
       or has_function_privilege(r, 'public.comm_link_code_release_attempt(uuid,uuid)', 'EXECUTE') then
      raise exception 'comm accounts: % can execute a link-code function', r;
    end if;
  end loop;
end $$;
set role anon;
select security_test.eca_denied('select * from public.employee_comm_account_secrets');
select security_test.eca_denied($q$select public.comm_link_code_reserve_attempt('ec000000-0000-4000-8000-000000000001', 'comm_account:' || 'ec200000-0000-4000-8000-000000000001', repeat('b',64))$q$);
reset role;
set role authenticated;
select security_test.eca_denied('select * from public.employee_comm_accounts');
select security_test.eca_denied($q$select public.comm_link_code_release_attempt('ec000000-0000-4000-8000-000000000001', gen_random_uuid())$q$);
reset role;

insert into public.orgs(id, name) values
  ('ec000000-0000-4000-8000-000000000001', 'eca org 1'),
  ('ec000000-0000-4000-8000-000000000002', 'eca org 2');
insert into public.employees(id, org_id, display_name, role_label) values
  ('ec100000-0000-4000-8000-000000000001', 'ec000000-0000-4000-8000-000000000001', 'eca emp 1', 'staff'),
  ('ec100000-0000-4000-8000-000000000002', 'ec000000-0000-4000-8000-000000000001', 'eca emp 2', 'staff'),
  ('ec100000-0000-4000-8000-000000000003', 'ec000000-0000-4000-8000-000000000002', 'eca emp 3', 'staff');

set role service_role;
-- (2)
insert into public.employee_comm_accounts(id, org_id, employee_id, surface, external_account_id, webhook_ref, status)
values ('ec200000-0000-4000-8000-000000000001', 'ec000000-0000-4000-8000-000000000001', 'ec100000-0000-4000-8000-000000000001',
        'line', 'U' || repeat('1', 32), repeat('A', 43), 'active');
-- second account for the same employee + surface
select security_test.eca_rejects($q$insert into public.employee_comm_accounts(org_id, employee_id, surface, external_account_id, webhook_ref)
  values ('ec000000-0000-4000-8000-000000000001', 'ec100000-0000-4000-8000-000000000001', 'line', 'U' || repeat('2', 32), repeat('B', 43))$q$, '23505');
-- another org registering the same official account
select security_test.eca_rejects($q$insert into public.employee_comm_accounts(org_id, employee_id, surface, external_account_id, webhook_ref)
  values ('ec000000-0000-4000-8000-000000000002', 'ec100000-0000-4000-8000-000000000003', 'line', 'U' || repeat('1', 32), repeat('C', 43))$q$, '23505');
-- employee of another org
select security_test.eca_rejects($q$insert into public.employee_comm_accounts(org_id, employee_id, surface, external_account_id, webhook_ref)
  values ('ec000000-0000-4000-8000-000000000002', 'ec100000-0000-4000-8000-000000000002', 'line', 'U' || repeat('3', 32), repeat('D', 43))$q$, '23503');
-- same webhook ref
select security_test.eca_rejects($q$insert into public.employee_comm_accounts(org_id, employee_id, surface, external_account_id, webhook_ref)
  values ('ec000000-0000-4000-8000-000000000001', 'ec100000-0000-4000-8000-000000000002', 'line', 'U' || repeat('4', 32), repeat('A', 43))$q$, '23505');
-- value CHECKs
select security_test.eca_rejects($q$insert into public.employee_comm_accounts(org_id, employee_id, surface, external_account_id, webhook_ref)
  values ('ec000000-0000-4000-8000-000000000001', 'ec100000-0000-4000-8000-000000000002', 'line_works', 'U' || repeat('5', 32), repeat('E', 43))$q$, '23514');
select security_test.eca_rejects($q$insert into public.employee_comm_accounts(org_id, employee_id, surface, external_account_id, webhook_ref)
  values ('ec000000-0000-4000-8000-000000000001', 'ec100000-0000-4000-8000-000000000002', 'line', 'Uabc', repeat('E', 43))$q$, '23514');
select security_test.eca_rejects($q$insert into public.employee_comm_accounts(org_id, employee_id, surface, external_account_id, webhook_ref)
  values ('ec000000-0000-4000-8000-000000000001', 'ec100000-0000-4000-8000-000000000002', 'line', 'U' || repeat('5', 32), 'short')$q$, '23514');
select security_test.eca_rejects($q$insert into public.employee_comm_accounts(org_id, employee_id, surface, external_account_id, webhook_ref, status)
  values ('ec000000-0000-4000-8000-000000000001', 'ec100000-0000-4000-8000-000000000002', 'line', 'U' || repeat('5', 32), repeat('E', 43), 'disabled')$q$, '23514');

-- (3)
insert into public.employee_comm_account_secrets(account_id, org_id, ciphertext, secret_names)
values ('ec200000-0000-4000-8000-000000000001', 'ec000000-0000-4000-8000-000000000001',
        'v2.' || repeat('a', 16) || '.' || repeat('b', 22) || '.' || repeat('c', 40), array['channelAccessToken','channelSecret']);
select security_test.eca_rejects($q$update public.employee_comm_account_secrets set ciphertext = '{"channelSecret":"plain"}'
  where account_id = 'ec200000-0000-4000-8000-000000000001'$q$, '23514');
select security_test.eca_rejects($q$update public.employee_comm_account_secrets set ciphertext = 'v1.aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbb.cccc'
  where account_id = 'ec200000-0000-4000-8000-000000000001'$q$, '23514');
select security_test.eca_rejects($q$update public.employee_comm_account_secrets set org_id = 'ec000000-0000-4000-8000-000000000002'
  where account_id = 'ec200000-0000-4000-8000-000000000001'$q$, '23503');

-- (4)
insert into public.comm_inbound_events(account_id, org_id, event_key)
values ('ec200000-0000-4000-8000-000000000001', 'ec000000-0000-4000-8000-000000000001', '01HXEVENTKEY0001');
select security_test.eca_rejects($q$insert into public.comm_inbound_events(account_id, org_id, event_key)
  values ('ec200000-0000-4000-8000-000000000001', 'ec000000-0000-4000-8000-000000000001', '01HXEVENTKEY0001')$q$, '23505');
select security_test.eca_rejects($q$insert into public.comm_inbound_events(account_id, org_id, event_key)
  values ('ec200000-0000-4000-8000-000000000001', 'ec000000-0000-4000-8000-000000000002', '01HXEVENTKEY0002')$q$, '23503');

-- (5)
do $$
declare
  o1 uuid := 'ec000000-0000-4000-8000-000000000001';
  o2 uuid := 'ec000000-0000-4000-8000-000000000002';
  acct text := 'comm_account:ec200000-0000-4000-8000-000000000001';
  acct2 text := 'line_channel:ec300000-0000-4000-8000-000000000001';
  s1 text := repeat('1', 64);
  s2 text := repeat('2', 64);
  t0 timestamptz := '2026-10-13 00:00:00+00';
  r jsonb;
  i int;
  j int;
  locks int := 0;
  repeats int := 0;
begin
  -- sender: 5 attempts get a slot, the 6th is refused and locks for 1 hour
  for i in 1..5 loop
    r := public.comm_link_code_reserve_attempt(o1, acct, s1, t0 + make_interval(mins => i));
    if r->>'result' <> 'ok' or r->>'attempt_id' is null then raise exception 'comm accounts: attempt % returned %', i, r; end if;
  end loop;
  r := public.comm_link_code_reserve_attempt(o1, acct, s1, t0 + interval '6 minutes');
  if r->>'result' <> 'sender_locked' then raise exception 'comm accounts: 6th attempt returned %', r; end if;
  if public.comm_link_code_reserve_attempt(o1, acct, s1, t0 + interval '65 minutes')->>'result' <> 'sender_locked' then
    raise exception 'comm accounts: sender not locked for 1 hour';
  end if;
  -- another sender, and the same sender key in another org: not locked
  if public.comm_link_code_reserve_attempt(o1, acct, s2, t0 + interval '7 minutes')->>'result' <> 'ok' then raise exception 'comm accounts: other sender locked'; end if;
  if public.comm_link_code_reserve_attempt(o2, acct, s1, t0 + interval '7 minutes')->>'result' <> 'ok' then raise exception 'comm accounts: other org locked'; end if;
  if public.comm_link_code_reserve_attempt(o1, acct, s1, t0 + interval '67 minutes')->>'result' <> 'ok' then raise exception 'comm accounts: sender lock did not expire'; end if;
  -- a released attempt (right code) does not count: 10 reserve + release → still ok
  for i in 1..10 loop
    r := public.comm_link_code_reserve_attempt(o2, acct2, s2, t0 + make_interval(secs => i));
    if r->>'result' <> 'ok' then raise exception 'comm accounts: released attempts counted (%)', r; end if;
    if not public.comm_link_code_release_attempt(o2, (r->>'attempt_id')::uuid) then raise exception 'comm accounts: release failed'; end if;
  end loop;
  -- release is org-scoped
  r := public.comm_link_code_reserve_attempt(o2, acct2, s2, t0 + interval '1 minute');
  if public.comm_link_code_release_attempt(o1, (r->>'attempt_id')::uuid) then raise exception 'comm accounts: released another org''s attempt'; end if;
  -- account: 30 attempts from many senders get slots; the 31st locks (notify once); 3rd lock in 24 h → repeat once
  for j in 0..3 loop
    for i in 1..31 loop
      r := public.comm_link_code_reserve_attempt(o1, acct2, lpad(to_hex(j * 100 + i), 64, 'f'), t0 + make_interval(hours => 2 + j * 2) + make_interval(secs => i));
      if i <= 30 and r->>'result' <> 'ok' then raise exception 'comm accounts: round % attempt % returned %', j, i, r; end if;
      if i = 31 then
        if r->>'result' <> 'account_locked' then raise exception 'comm accounts: 31st returned %', r; end if;
        if r->>'notify' = 'account_locked' then locks := locks + 1; end if;
        if r->>'notify' = 'account_locked_repeat' then repeats := repeats + 1; end if;
        if j = 2 and r->>'notify' <> 'account_locked_repeat' then raise exception 'comm accounts: 3rd lock in 24 h not escalated (%)', r; end if;
        if j = 3 and r->>'notify' <> 'account_locked' then raise exception 'comm accounts: 4th lock escalated again (%)', r; end if;
      end if;
    end loop;
    -- while locked: everyone refused, no new notify
    r := public.comm_link_code_reserve_attempt(o1, acct2, repeat('9', 64), t0 + make_interval(hours => 2 + j * 2) + interval '5 minutes');
    if r->>'result' <> 'account_locked' or r->>'notify' is not null then raise exception 'comm accounts: locked account answered %', r; end if;
  end loop;
  if locks <> 3 or repeats <> 1 then raise exception 'comm accounts: notify counts locks=% repeats=%', locks, repeats; end if;
  if public.comm_link_code_reserve_attempt(o2, acct2, repeat('9', 64), t0 + interval '2 hours 5 minutes')->>'result' <> 'ok' then
    raise exception 'comm accounts: account lock leaked to another org';
  end if;
  begin
    perform public.comm_link_code_reserve_attempt(o1, null, s1, t0);
    raise exception 'comm accounts: null key accepted';
  exception when others then
    if sqlerrm not like '%comm_link_code_bad_input%' then raise; end if;
  end;
end $$;
select security_test.eca_rejects($q$insert into public.comm_link_code_attempts(org_id, attempt_id, scope, scope_key)
  values ('ec000000-0000-4000-8000-000000000001', gen_random_uuid(), 'sender', 'U1234567890')$q$, '23514');
select security_test.eca_rejects($q$insert into public.comm_link_code_attempts(org_id, attempt_id, scope, scope_key)
  values ('ec000000-0000-4000-8000-000000000001', gen_random_uuid(), 'account', 'ec200000-0000-4000-8000-000000000001')$q$, '23514');
reset role;

delete from public.comm_link_code_locks where org_id in ('ec000000-0000-4000-8000-000000000001','ec000000-0000-4000-8000-000000000002');
delete from public.comm_link_code_lock_events where org_id in ('ec000000-0000-4000-8000-000000000001','ec000000-0000-4000-8000-000000000002');
delete from public.comm_link_code_attempts where org_id in ('ec000000-0000-4000-8000-000000000001','ec000000-0000-4000-8000-000000000002');
delete from public.orgs where id in ('ec000000-0000-4000-8000-000000000001','ec000000-0000-4000-8000-000000000002');
drop function security_test.eca_rejects(text, text);
drop function security_test.eca_denied(text);

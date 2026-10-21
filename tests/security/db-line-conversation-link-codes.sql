-- Conversation link codes (migration 20261021100000).
-- RLS deny-all, service_role only, same-org FKs, no plaintext code.
\set ON_ERROR_STOP 1
reset role;

create or replace function security_test.lclc_rejects(command text, expected text) returns void language plpgsql as $$
begin
  begin
    execute command;
  exception when others then
    if position(expected in sqlerrm) > 0 or sqlstate = expected then return; end if;
    raise exception 'conversation link codes: % failed with "%" / % (expected "%")', command, sqlerrm, sqlstate, expected;
  end;
  raise exception 'conversation link codes: not rejected: %', command;
end $$;
create or replace function security_test.lclc_denied(command text) returns void language plpgsql as $$
begin
  begin
    execute command;
  exception when insufficient_privilege then return;
  end;
  raise exception 'conversation link codes: session access not denied: %', command;
end $$;
grant execute on function security_test.lclc_rejects(text, text), security_test.lclc_denied(text) to anon, authenticated, service_role;

do $$
declare r text; t text := 'line_conversation_link_codes';
begin
  if to_regclass('public.' || t) is null then raise exception 'conversation link codes: table missing'; end if;
  if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then
    raise exception 'conversation link codes: RLS off';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = t
             and not (permissive = 'RESTRICTIVE' and qual = 'false')) then
    raise exception 'conversation link codes: unexpected policy';
  end if;
  foreach r in array array['anon','authenticated'] loop
    if has_table_privilege(r, 'public.' || t, 'SELECT') or has_table_privilege(r, 'public.' || t, 'INSERT')
       or has_table_privilege(r, 'public.' || t, 'UPDATE') or has_table_privilege(r, 'public.' || t, 'DELETE') then
      raise exception 'conversation link codes: % holds a privilege', r;
    end if;
  end loop;
  if not has_table_privilege('service_role', 'public.' || t, 'SELECT')
     or not has_table_privilege('service_role', 'public.' || t, 'INSERT') then
    raise exception 'conversation link codes: service_role missing grant';
  end if;
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = t
      and column_name in ('code', 'plaintext', 'display', 'secret')
  ) then
    raise exception 'conversation link codes: plaintext code column must not exist';
  end if;
end $$;

insert into public.orgs(id, name) values
  ('c0211000-0000-4000-8000-000000000001', 'lclc 1'),
  ('c0211000-0000-4000-8000-000000000002', 'lclc 2');
insert into public.org_members(id, org_id, email, role, status) values
  ('c0211000-0000-4000-8000-000000000011', 'c0211000-0000-4000-8000-000000000001', 'lclc-a@fixture.invalid', 'admin', 'active'),
  ('c0211000-0000-4000-8000-000000000012', 'c0211000-0000-4000-8000-000000000002', 'lclc-b@fixture.invalid', 'admin', 'active');
insert into public.employees(id, org_id, display_name, role_label) values
  ('c0211000-0000-4000-8000-000000000021', 'c0211000-0000-4000-8000-000000000001', 'lclc emp 1', 'staff'),
  ('c0211000-0000-4000-8000-000000000022', 'c0211000-0000-4000-8000-000000000002', 'lclc emp 2', 'staff');
insert into public.employee_comm_accounts(id, org_id, employee_id, surface, external_account_id, webhook_ref, status) values
  ('c0211000-0000-4000-8000-000000000031', 'c0211000-0000-4000-8000-000000000001', 'c0211000-0000-4000-8000-000000000021', 'line', 'U' || repeat('c', 32), repeat('C', 43), 'active'),
  ('c0211000-0000-4000-8000-000000000032', 'c0211000-0000-4000-8000-000000000002', 'c0211000-0000-4000-8000-000000000022', 'line', 'U' || repeat('d', 32), repeat('D', 43), 'active');

set role service_role;
insert into public.line_conversation_link_codes(org_id, account_id, member_id, code_hash, expires_at)
  values (
    'c0211000-0000-4000-8000-000000000001',
    'c0211000-0000-4000-8000-000000000031',
    'c0211000-0000-4000-8000-000000000011',
    repeat('ab', 32),
    now() + interval '15 minutes'
  );
-- member of another org
select security_test.lclc_rejects(
  $q$insert into public.line_conversation_link_codes(org_id, account_id, member_id, code_hash, expires_at)
     values (
       'c0211000-0000-4000-8000-000000000001',
       'c0211000-0000-4000-8000-000000000031',
       'c0211000-0000-4000-8000-000000000012',
       repeat('cd', 32),
       now() + interval '15 minutes'
     )$q$,
  '23503');
-- account of another org
select security_test.lclc_rejects(
  $q$insert into public.line_conversation_link_codes(org_id, account_id, member_id, code_hash, expires_at)
     values (
       'c0211000-0000-4000-8000-000000000001',
       'c0211000-0000-4000-8000-000000000032',
       'c0211000-0000-4000-8000-000000000011',
       repeat('ef', 32),
       now() + interval '15 minutes'
     )$q$,
  '23503');
reset role;

set role anon;
select security_test.lclc_denied('select * from public.line_conversation_link_codes');
reset role;
set role authenticated;
select security_test.lclc_denied('select * from public.line_conversation_link_codes');
select security_test.lclc_denied(
  $q$insert into public.line_conversation_link_codes(org_id, account_id, member_id, code_hash, expires_at)
     values (
       'c0211000-0000-4000-8000-000000000001',
       'c0211000-0000-4000-8000-000000000031',
       'c0211000-0000-4000-8000-000000000011',
       repeat('11', 32),
       now() + interval '15 minutes'
     )$q$);
reset role;

delete from public.orgs where id in (
  'c0211000-0000-4000-8000-000000000001',
  'c0211000-0000-4000-8000-000000000002'
);
do $$
begin
  if exists (select 1 from public.line_conversation_link_codes
             where org_id in (
               'c0211000-0000-4000-8000-000000000001',
               'c0211000-0000-4000-8000-000000000002'
             )) then
    raise exception 'conversation link codes: org delete did not cascade';
  end if;
end $$;

drop function security_test.lclc_rejects(text, text);
drop function security_test.lclc_denied(text);

-- LINE approver link codes (migration 20261003180000, flag LINE_APPROVER_LINK_ENABLED).
-- HMAC only (64 hex). RLS on, restrictive deny-all; anon/authenticated no access.
-- Synthetic fixtures (a0318000-*); cleans up after itself.
-- Runs in scripts/test-db-local.py and scripts/test-db-all-migrations.py.
--  (1) RLS on, only the restrictive deny-all policy; anon / authenticated hold no privilege
--  (2) code_hash is 64 hex; unique across the table
--  (3) member must belong to the same org (composite FK)
--  (4) channel must exist; org delete cascades
--  (5) no plaintext code column
\set ON_ERROR_STOP 1
reset role;

create or replace function security_test.l0lc_rejects(command text, expected text) returns void language plpgsql as $$
begin
  begin
    execute command;
  exception when others then
    if position(expected in sqlerrm) > 0 or sqlstate = expected then return; end if;
    raise exception 'line link codes: % failed with "%" / % (expected "%")', command, sqlerrm, sqlstate, expected;
  end;
  raise exception 'line link codes: not rejected: %', command;
end $$;
create or replace function security_test.l0lc_denied(command text) returns void language plpgsql as $$
begin
  begin
    execute command;
  exception when insufficient_privilege then return;
  end;
  raise exception 'line link codes: session access not denied: %', command;
end $$;
grant execute on function security_test.l0lc_rejects(text, text), security_test.l0lc_denied(text) to anon, authenticated, service_role;

do $$
declare r text; t text := 'line_approver_link_codes';
begin
  if to_regclass('public.' || t) is null then raise exception 'line link codes: table missing'; end if;
  if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then
    raise exception 'line link codes: RLS off';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = t
             and not (permissive = 'RESTRICTIVE' and qual = 'false')) then
    raise exception 'line link codes: unexpected policy';
  end if;
  foreach r in array array['anon','authenticated'] loop
    if has_table_privilege(r, 'public.' || t, 'SELECT') or has_table_privilege(r, 'public.' || t, 'INSERT')
       or has_table_privilege(r, 'public.' || t, 'UPDATE') or has_table_privilege(r, 'public.' || t, 'DELETE') then
      raise exception 'line link codes: % holds a privilege', r;
    end if;
  end loop;
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = t
      and column_name in ('code', 'plaintext', 'display', 'secret')
  ) then
    raise exception 'line link codes: plaintext code column must not exist';
  end if;
end $$;

insert into public.orgs(id, name) values
  ('a0318000-0000-4000-8000-000000000001', 'l0 link 1'),
  ('a0318000-0000-4000-8000-000000000002', 'l0 link 2');
insert into public.org_members(id, org_id, email, role, status) values
  ('a0318000-0000-4000-8000-000000000011', 'a0318000-0000-4000-8000-000000000001', 'l0-a@fixture.invalid', 'admin', 'active'),
  ('a0318000-0000-4000-8000-000000000012', 'a0318000-0000-4000-8000-000000000002', 'l0-b@fixture.invalid', 'admin', 'active');
insert into public.org_notification_channels(id, org_id, provider, label, enabled, webhook_ref) values
  ('a0318000-0000-4000-8000-000000000021', 'a0318000-0000-4000-8000-000000000001', 'line', 'LINE A', true, 'l0refaaaaaa'),
  ('a0318000-0000-4000-8000-000000000022', 'a0318000-0000-4000-8000-000000000002', 'line', 'LINE B', true, 'l0refbbbbbb');

set role service_role;
insert into public.line_approver_link_codes(org_id, channel_id, member_id, code_hash, expires_at)
  values (
    'a0318000-0000-4000-8000-000000000001',
    'a0318000-0000-4000-8000-000000000021',
    'a0318000-0000-4000-8000-000000000011',
    repeat('ab', 32),
    now() + interval '15 minutes'
  );
select security_test.l0lc_rejects(
  $q$insert into public.line_approver_link_codes(org_id, channel_id, member_id, code_hash, expires_at)
     values (
       'a0318000-0000-4000-8000-000000000001',
       'a0318000-0000-4000-8000-000000000021',
       'a0318000-0000-4000-8000-000000000011',
       repeat('ab', 32),
       now() + interval '15 minutes'
     )$q$,
  '23505');
select security_test.l0lc_rejects(
  $q$insert into public.line_approver_link_codes(org_id, channel_id, member_id, code_hash, expires_at)
     values (
       'a0318000-0000-4000-8000-000000000001',
       'a0318000-0000-4000-8000-000000000021',
       'a0318000-0000-4000-8000-000000000011',
       'not-a-64-hex-hash',
       now() + interval '15 minutes'
     )$q$,
  '23514');
-- member of another org
select security_test.l0lc_rejects(
  $q$insert into public.line_approver_link_codes(org_id, channel_id, member_id, code_hash, expires_at)
     values (
       'a0318000-0000-4000-8000-000000000001',
       'a0318000-0000-4000-8000-000000000021',
       'a0318000-0000-4000-8000-000000000012',
       repeat('cd', 32),
       now() + interval '15 minutes'
     )$q$,
  '23503');
reset role;

set role anon;
select security_test.l0lc_denied('select * from public.line_approver_link_codes');
reset role;
set role authenticated;
select security_test.l0lc_denied('select * from public.line_approver_link_codes');
select security_test.l0lc_denied(
  $q$insert into public.line_approver_link_codes(org_id, channel_id, member_id, code_hash, expires_at)
     values (
       'a0318000-0000-4000-8000-000000000001',
       'a0318000-0000-4000-8000-000000000021',
       'a0318000-0000-4000-8000-000000000011',
       repeat('ef', 32),
       now() + interval '15 minutes'
     )$q$);
reset role;

delete from public.orgs where id in (
  'a0318000-0000-4000-8000-000000000001',
  'a0318000-0000-4000-8000-000000000002'
);
do $$
begin
  if exists (select 1 from public.line_approver_link_codes
             where org_id in (
               'a0318000-0000-4000-8000-000000000001',
               'a0318000-0000-4000-8000-000000000002'
             )) then
    raise exception 'line link codes: org delete did not cascade';
  end if;
end $$;

drop function security_test.l0lc_rejects(text, text);
drop function security_test.l0lc_denied(text);

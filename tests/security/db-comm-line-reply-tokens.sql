-- L-6 replyToken / unknown-outcome ledger (20261014100000).
-- RLS on, restrictive deny-all; anon/authenticated no access; hash format;
-- unique reply token; org delete cascades. Synthetic fixtures; cleans up.
\set ON_ERROR_STOP 1
reset role;

create or replace function security_test.l6rt_rejects(command text, expected text) returns void language plpgsql as $$
begin
  begin
    execute command;
  exception when others then
    if position(expected in sqlerrm) > 0 or sqlstate = expected then return; end if;
    raise exception 'l6 reply tokens: % failed with "%" / % (expected "%")', command, sqlerrm, sqlstate, expected;
  end;
  raise exception 'l6 reply tokens: not rejected: %', command;
end $$;
create or replace function security_test.l6rt_denied(command text) returns void language plpgsql as $$
begin
  begin
    execute command;
  exception when insufficient_privilege then return;
  end;
  raise exception 'l6 reply tokens: session access not denied: %', command;
end $$;
grant execute on function security_test.l6rt_rejects(text, text), security_test.l6rt_denied(text) to anon, authenticated, service_role;

do $$
declare r text; t text;
begin
  foreach t in array array['comm_line_reply_tokens','comm_line_send_unknown'] loop
    if to_regclass('public.' || t) is null then raise exception 'l6 reply tokens: table % missing', t; end if;
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then
      raise exception 'l6 reply tokens: RLS off on %', t;
    end if;
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = t
               and not (permissive = 'RESTRICTIVE' and qual = 'false')) then
      raise exception 'l6 reply tokens: unexpected policy on %', t;
    end if;
    foreach r in array array['anon','authenticated'] loop
      if has_table_privilege(r, 'public.' || t, 'SELECT') or has_table_privilege(r, 'public.' || t, 'INSERT')
         or has_table_privilege(r, 'public.' || t, 'UPDATE') or has_table_privilege(r, 'public.' || t, 'DELETE') then
        raise exception 'l6 reply tokens: % holds a privilege on %', r, t;
      end if;
    end loop;
  end loop;
end $$;

-- fixtures
insert into public.orgs(id, name) values ('ec000000-0000-4000-8000-0000000000l6', 'l6 rt')
  on conflict (id) do nothing;
insert into public.employees(id, org_id, display_name, role_label) values
  ('ec100000-0000-4000-8000-0000000000l6', 'ec000000-0000-4000-8000-0000000000l6', 'l6', 'staff')
  on conflict (id) do nothing;
insert into public.employee_comm_accounts(id, org_id, employee_id, surface, external_account_id, webhook_ref, status)
  values ('ec200000-0000-4000-8000-0000000000l6', 'ec000000-0000-4000-8000-0000000000l6',
          'ec100000-0000-4000-8000-0000000000l6', 'line', 'U' || repeat('6', 32), repeat('G', 43), 'active')
  on conflict (id) do nothing;

set role service_role;
insert into public.comm_line_reply_tokens(token_hash, org_id, account_id)
  values (repeat('a', 64), 'ec000000-0000-4000-8000-0000000000l6', 'ec200000-0000-4000-8000-0000000000l6');
select security_test.l6rt_rejects(
  $q$insert into public.comm_line_reply_tokens(token_hash, org_id, account_id)
     values (repeat('a', 64), 'ec000000-0000-4000-8000-0000000000l6', 'ec200000-0000-4000-8000-0000000000l6')$q$,
  '23505');
select security_test.l6rt_rejects(
  $q$insert into public.comm_line_reply_tokens(token_hash, org_id, account_id)
     values ('not-a-hash', 'ec000000-0000-4000-8000-0000000000l6', 'ec200000-0000-4000-8000-0000000000l6')$q$,
  '23514');
insert into public.comm_line_send_unknown(org_id, retry_key)
  values ('ec000000-0000-4000-8000-0000000000l6', 'job-unknown-1');
select security_test.l6rt_rejects(
  $q$insert into public.comm_line_send_unknown(org_id, retry_key)
     values ('ec000000-0000-4000-8000-0000000000l6', 'job-unknown-1')$q$,
  '23505');
reset role;

set role anon;
select security_test.l6rt_denied('select * from public.comm_line_reply_tokens');
select security_test.l6rt_denied('select * from public.comm_line_send_unknown');
reset role;
set role authenticated;
select security_test.l6rt_denied('select * from public.comm_line_reply_tokens');
select security_test.l6rt_denied('select * from public.comm_line_send_unknown');
reset role;

delete from public.orgs where id = 'ec000000-0000-4000-8000-0000000000l6';
do $$
begin
  if exists (select 1 from public.comm_line_reply_tokens where org_id = 'ec000000-0000-4000-8000-0000000000l6')
     or exists (select 1 from public.comm_line_send_unknown where org_id = 'ec000000-0000-4000-8000-0000000000l6') then
    raise exception 'l6 reply tokens: org delete did not cascade';
  end if;
end $$;

drop function security_test.l6rt_rejects(text, text);
drop function security_test.l6rt_denied(text);

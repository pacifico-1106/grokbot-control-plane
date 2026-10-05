-- D9 employee_webhook_settings (migration 20261005100000). Synthetic fixtures
-- only (ids b9000000-…); cleans up after itself. Runs in scripts/test-db-local.py
-- and after the full history in scripts/test-db-all-migrations.py.
--  (1) anon / authenticated: no SELECT / INSERT / UPDATE / DELETE
--  (2) service_role reads / writes (RLS on, no policy)
--  (3) tenant isolation: a row whose employee belongs to another org is rejected
--  (4) callback_payload only minimal | legacy_full (default minimal); the
--      secret is only ciphertext (v1.iv.tag.ct) + sha256 fingerprint, both or neither
--  (5) org / employee delete cascades
\set ON_ERROR_STOP 1
reset role;
create or replace function security_test.whs_denied(command text) returns void language plpgsql as $$
begin
  begin
    execute command;
  exception when insufficient_privilege then return;
  end;
  raise exception 'webhook settings: session access not denied: %', command;
end $$;
create or replace function security_test.whs_rejects(command text, expected text) returns void language plpgsql as $$
begin
  begin
    execute command;
  exception when others then
    if position(expected in sqlerrm) > 0 then return; end if;
    raise exception 'webhook settings: % failed with "%" (expected "%")', command, sqlerrm, expected;
  end;
  raise exception 'webhook settings: not rejected: %', command;
end $$;
grant execute on function security_test.whs_denied(text), security_test.whs_rejects(text, text) to anon, authenticated, service_role;

insert into public.orgs(id, name) values
 ('b9000000-0000-4000-8000-0000000000a1', 'webhook-settings-fixture-a'),
 ('b9000000-0000-4000-8000-0000000000a2', 'webhook-settings-fixture-b');
insert into public.employees(id, org_id, display_name, role_label) values
 ('b9100000-0000-4000-8000-000000000001', 'b9000000-0000-4000-8000-0000000000a1', 'Hook A1', 'fixture'),
 ('b9100000-0000-4000-8000-000000000002', 'b9000000-0000-4000-8000-0000000000a2', 'Hook B1', 'fixture');

-- (2) service_role
set role service_role;
insert into public.employee_webhook_settings (employee_id, org_id) values ('b9100000-0000-4000-8000-000000000001', 'b9000000-0000-4000-8000-0000000000a1');
do $$ begin
  if (select callback_payload from public.employee_webhook_settings where employee_id = 'b9100000-0000-4000-8000-000000000001') <> 'minimal' then
    raise exception 'webhook settings: default payload must be minimal';
  end if;
end $$;
update public.employee_webhook_settings set callback_payload = 'legacy_full', callback_secret_ciphertext = 'v1.aaaa.bbbb.cccc',
  callback_secret_fingerprint = repeat('e', 64), updated_at = now() where employee_id = 'b9100000-0000-4000-8000-000000000001';
-- upsert (the application path) on the primary key
insert into public.employee_webhook_settings (employee_id, org_id, callback_payload) values ('b9100000-0000-4000-8000-000000000001', 'b9000000-0000-4000-8000-0000000000a1', 'minimal')
  on conflict (employee_id) do update set callback_payload = excluded.callback_payload;
do $$ begin
  if (select callback_payload || ':' || callback_secret_fingerprint from public.employee_webhook_settings where employee_id = 'b9100000-0000-4000-8000-000000000001') <> 'minimal:' || repeat('e', 64) then
    raise exception 'webhook settings: upsert did not keep the secret / update the mode';
  end if;
end $$;
-- (3) tenant isolation
select security_test.whs_rejects($c$insert into public.employee_webhook_settings (employee_id, org_id) values ('b9100000-0000-4000-8000-000000000002', 'b9000000-0000-4000-8000-0000000000a1')$c$, 'webhook_settings_cross_org');
select security_test.whs_rejects($c$update public.employee_webhook_settings set org_id = 'b9000000-0000-4000-8000-0000000000a2' where employee_id = 'b9100000-0000-4000-8000-000000000001'$c$, 'webhook_settings_cross_org');
-- (4) checks
select security_test.whs_rejects($c$update public.employee_webhook_settings set callback_payload = 'everything' where employee_id = 'b9100000-0000-4000-8000-000000000001'$c$, 'check');
select security_test.whs_rejects($c$update public.employee_webhook_settings set callback_secret_ciphertext = 'whsec_plaintextlooking' where employee_id = 'b9100000-0000-4000-8000-000000000001'$c$, 'check');
select security_test.whs_rejects($c$update public.employee_webhook_settings set callback_secret_fingerprint = 'abc' where employee_id = 'b9100000-0000-4000-8000-000000000001'$c$, 'check');
select security_test.whs_rejects($c$update public.employee_webhook_settings set callback_secret_fingerprint = null where employee_id = 'b9100000-0000-4000-8000-000000000001'$c$, 'check');
reset role;

-- (1) anon / authenticated
set role anon;
select security_test.whs_denied($c$select * from public.employee_webhook_settings$c$);
select security_test.whs_denied($c$delete from public.employee_webhook_settings$c$);
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub', 'b9200000-0000-4000-8000-000000000001', false);
select security_test.whs_denied($c$select callback_secret_ciphertext from public.employee_webhook_settings$c$);
select security_test.whs_denied($c$insert into public.employee_webhook_settings (employee_id, org_id) values ('b9100000-0000-4000-8000-000000000002', 'b9000000-0000-4000-8000-0000000000a2')$c$);
select security_test.whs_denied($c$update public.employee_webhook_settings set callback_payload = 'legacy_full'$c$);
select security_test.whs_denied($c$delete from public.employee_webhook_settings$c$);
select set_config('request.jwt.claim.sub', '', false);
reset role;
do $$ begin
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'employee_webhook_settings') then
    raise exception 'webhook settings: table must have no policy';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.employee_webhook_settings'::regclass) then
    raise exception 'webhook settings: RLS must be enabled';
  end if;
end $$;

-- (5) cascade
delete from public.employees where id = 'b9100000-0000-4000-8000-000000000001';
do $$ begin
  if exists (select 1 from public.employee_webhook_settings where employee_id = 'b9100000-0000-4000-8000-000000000001') then
    raise exception 'webhook settings: employee delete did not cascade';
  end if;
end $$;
delete from public.orgs where id::text like 'b9000000-%';
drop function security_test.whs_denied(text);
drop function security_test.whs_rejects(text, text);

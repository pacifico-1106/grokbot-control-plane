-- MCP Events subscriptions / deliveries (migration 20261005000000). Synthetic
-- fixtures only (ids a9000000-…); cleans up after itself. Self-contained
-- helpers so it runs in scripts/test-db-local.py and after every migration in
-- scripts/test-db-all-migrations.py.
--  (1) anon / authenticated: no SELECT / INSERT / UPDATE / DELETE on either table
--  (2) service_role reads / writes both (RLS on, no policy, BYPASSRLS)
--  (3) tenant isolation in the schema: a subscription whose employee is in
--      another org, and a delivery whose org / employee differs from its
--      subscription, are rejected
--  (4) one delivery per (subscription, event): a duplicate insert is a no-op
--  (5) delivery bodies over 256 KiB, malformed ids, unknown events / statuses,
--      non-https URLs and plaintext-looking secrets are rejected
\set ON_ERROR_STOP 1
reset role;

create or replace function security_test.mcpev_denied(command text) returns void language plpgsql as $$
begin
  begin
    execute command;
  exception when insufficient_privilege then return;
  end;
  raise exception 'mcp events: session access not denied: %', command;
end $$;
create or replace function security_test.mcpev_rejects(command text, expected text) returns void language plpgsql as $$
begin
  begin
    execute command;
  exception when others then
    if position(expected in sqlerrm) > 0 then return; end if;
    raise exception 'mcp events: % failed with "%" (expected "%")', command, sqlerrm, expected;
  end;
  raise exception 'mcp events: not rejected: %', command;
end $$;
grant execute on function security_test.mcpev_denied(text), security_test.mcpev_rejects(text, text) to anon, authenticated, service_role;

insert into public.orgs(id, name) values
 ('a9000000-0000-4000-8000-0000000000a1', 'mcp-events-fixture-a'),
 ('a9000000-0000-4000-8000-0000000000a2', 'mcp-events-fixture-b');
insert into public.employees(id, org_id, display_name, role_label) values
 ('a9100000-0000-4000-8000-000000000001', 'a9000000-0000-4000-8000-0000000000a1', 'Events A1', 'fixture'),
 ('a9100000-0000-4000-8000-000000000002', 'a9000000-0000-4000-8000-0000000000a2', 'Events B1', 'fixture');

-- (2) service_role writes
set role service_role;
insert into public.mcp_event_subscriptions
  (id, org_id, employee_id, credential_generation, credential_fingerprint, principal, event_name, arguments,
   delivery_url, delivery_host, secret_ciphertext, secret_fingerprint, risk, risk_reasons, granted_ttl_ms, refresh_before, verified_at)
values
  ('sub_' || repeat('a', 32), 'a9000000-0000-4000-8000-0000000000a1', 'a9100000-0000-4000-8000-000000000001', 1, repeat('c', 64),
   'emp:a9000000-0000-4000-8000-0000000000a1:a9100000-0000-4000-8000-000000000001:g1', 'approval.decided', '{}'::jsonb,
   'https://hooks.example.com/a', 'hooks.example.com', 'v1.aaaa.bbbb.cccc', repeat('d', 64), 'elevated',
   array['receiver_not_allowlisted'], 900000, now() + interval '15 minutes', now());
insert into public.mcp_event_deliveries (org_id, employee_id, subscription_id, event_id, event_name, approval_id, body, next_attempt_at)
values ('a9000000-0000-4000-8000-0000000000a1', 'a9100000-0000-4000-8000-000000000001', 'sub_' || repeat('a', 32),
        'evt_' || repeat('1', 32), 'approval.decided', 'apr_fixture', '{"eventId":"evt_x"}', now());
do $$ begin
  if (select count(*) from public.mcp_event_subscriptions where id like 'sub_%' and org_id = 'a9000000-0000-4000-8000-0000000000a1') <> 1
     or (select count(*) from public.mcp_event_deliveries where org_id = 'a9000000-0000-4000-8000-0000000000a1') <> 1 then
    raise exception 'mcp events: service_role cannot read back its rows';
  end if;
end $$;

-- (4) duplicate delivery is a no-op with ON CONFLICT DO NOTHING (and a unique violation otherwise)
insert into public.mcp_event_deliveries (org_id, employee_id, subscription_id, event_id, event_name, approval_id, body, next_attempt_at)
values ('a9000000-0000-4000-8000-0000000000a1', 'a9100000-0000-4000-8000-000000000001', 'sub_' || repeat('a', 32),
        'evt_' || repeat('1', 32), 'approval.decided', 'apr_fixture', '{}', now())
on conflict (subscription_id, event_id) do nothing;
do $$ begin
  if (select count(*) from public.mcp_event_deliveries where event_id = 'evt_' || repeat('1', 32)) <> 1 then
    raise exception 'mcp events: duplicate delivery inserted';
  end if;
end $$;
select security_test.mcpev_rejects($c$insert into public.mcp_event_deliveries (org_id, employee_id, subscription_id, event_id, event_name, approval_id, body, next_attempt_at)
  values ('a9000000-0000-4000-8000-0000000000a1', 'a9100000-0000-4000-8000-000000000001', 'sub_' || repeat('a', 32), 'evt_' || repeat('1', 32), 'approval.decided', 'apr_fixture', '{}', now())$c$,
  'mcp_event_deliveries_subscription_event_key');

-- (3) tenant isolation
select security_test.mcpev_rejects($c$insert into public.mcp_event_subscriptions
  (id, org_id, employee_id, credential_generation, credential_fingerprint, principal, event_name, arguments, delivery_url, delivery_host,
   secret_ciphertext, secret_fingerprint, risk, granted_ttl_ms, refresh_before)
  values ('sub_' || repeat('b', 32), 'a9000000-0000-4000-8000-0000000000a1', 'a9100000-0000-4000-8000-000000000002', 1, repeat('c', 64), 'p',
   'approval.decided', '{}', 'https://hooks.example.com/b', 'hooks.example.com', 'v1.a.b.c', repeat('d', 64), 'standard', 900000, now())$c$,
  'mcp_events_cross_org');
select security_test.mcpev_rejects($c$insert into public.mcp_event_deliveries (org_id, employee_id, subscription_id, event_id, event_name, approval_id, body, next_attempt_at)
  values ('a9000000-0000-4000-8000-0000000000a2', 'a9100000-0000-4000-8000-000000000002', 'sub_' || repeat('a', 32), 'evt_' || repeat('2', 32), 'approval.decided', 'apr_x', '{}', now())$c$,
  'mcp_events_cross_org');
select security_test.mcpev_rejects($c$update public.mcp_event_subscriptions set org_id = 'a9000000-0000-4000-8000-0000000000a2' where id = 'sub_' || repeat('a', 32)$c$,
  'mcp_events_cross_org');

-- (5) shape checks
select security_test.mcpev_rejects($c$insert into public.mcp_event_deliveries (org_id, employee_id, subscription_id, event_id, event_name, approval_id, body, next_attempt_at)
  values ('a9000000-0000-4000-8000-0000000000a1', 'a9100000-0000-4000-8000-000000000001', 'sub_' || repeat('a', 32), 'evt_' || repeat('3', 32), 'approval.decided', 'apr_x', repeat('x', 262145), now())$c$,
  'mcp_event_deliveries_body_check');
select security_test.mcpev_rejects($c$insert into public.mcp_event_deliveries (org_id, employee_id, subscription_id, event_id, event_name, approval_id, body, next_attempt_at)
  values ('a9000000-0000-4000-8000-0000000000a1', 'a9100000-0000-4000-8000-000000000001', 'sub_' || repeat('a', 32), 'evt_bad', 'approval.decided', 'apr_x', '{}', now())$c$,
  'mcp_event_deliveries_event_id_check');
select security_test.mcpev_rejects($c$update public.mcp_event_subscriptions set event_name = 'tools.called' where id = 'sub_' || repeat('a', 32)$c$, 'mcp_event_subscriptions_event_name_check');
select security_test.mcpev_rejects($c$update public.mcp_event_subscriptions set status = 'paused' where id = 'sub_' || repeat('a', 32)$c$, 'mcp_event_subscriptions_status_check');
select security_test.mcpev_rejects($c$update public.mcp_event_subscriptions set delivery_url = 'http://hooks.example.com/a' where id = 'sub_' || repeat('a', 32)$c$, 'mcp_event_subscriptions_delivery_url_check');
select security_test.mcpev_rejects($c$update public.mcp_event_subscriptions set secret_ciphertext = 'whsec_plain' where id = 'sub_' || repeat('a', 32)$c$, 'mcp_event_subscriptions_secret_ciphertext_check');
select security_test.mcpev_rejects($c$update public.mcp_event_subscriptions set last_error = 'raw: 500 Internal Server Error' where id = 'sub_' || repeat('a', 32)$c$, 'mcp_event_subscriptions_last_error_check');
select security_test.mcpev_rejects($c$update public.mcp_event_subscriptions set id = 'sub_short' where id = 'sub_' || repeat('a', 32)$c$, 'mcp_event_subscriptions_id_check');
reset role;

-- (1) sessions: nothing
set role anon;
select security_test.mcpev_denied($c$select * from public.mcp_event_subscriptions$c$);
select security_test.mcpev_denied($c$select * from public.mcp_event_deliveries$c$);
select security_test.mcpev_denied($c$delete from public.mcp_event_subscriptions$c$);
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub', 'a9200000-0000-4000-8000-000000000001', false);
select security_test.mcpev_denied($c$select * from public.mcp_event_subscriptions$c$);
select security_test.mcpev_denied($c$select secret_ciphertext from public.mcp_event_subscriptions$c$);
select security_test.mcpev_denied($c$select * from public.mcp_event_deliveries$c$);
select security_test.mcpev_denied($c$insert into public.mcp_event_deliveries (org_id, employee_id, subscription_id, event_id, event_name, approval_id, body, next_attempt_at)
  values ('a9000000-0000-4000-8000-0000000000a1', 'a9100000-0000-4000-8000-000000000001', 'sub_' || repeat('a', 32), 'evt_' || repeat('4', 32), 'approval.decided', 'apr_x', '{}', now())$c$);
select security_test.mcpev_denied($c$update public.mcp_event_subscriptions set status = 'active'$c$);
select security_test.mcpev_denied($c$delete from public.mcp_event_deliveries$c$);
select set_config('request.jwt.claim.sub', '', false);
reset role;
do $$ begin
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename in ('mcp_event_subscriptions', 'mcp_event_deliveries')) then
    raise exception 'mcp events: tables must have no policy';
  end if;
  if not (select bool_and(relrowsecurity) from pg_class where oid in ('public.mcp_event_subscriptions'::regclass, 'public.mcp_event_deliveries'::regclass)) then
    raise exception 'mcp events: RLS must be enabled';
  end if;
  -- retention: the deliver cron deletes finished rows by updated_at (partial index on finished statuses)
  if not exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'mcp_event_deliveries'
                 and indexname = 'mcp_event_deliveries_retention_idx' and indexdef like '%(updated_at)%' and indexdef like '%delivered%abandoned%dropped%') then
    raise exception 'mcp events: retention index missing';
  end if;
end $$;

-- cleanup (cascade from orgs)
delete from public.orgs where id::text like 'a9000000-%';
do $$ begin
  if exists (select 1 from public.mcp_event_subscriptions where org_id::text like 'a9000000-%')
     or exists (select 1 from public.mcp_event_deliveries where org_id::text like 'a9000000-%') then
    raise exception 'mcp events: org delete did not cascade';
  end if;
end $$;
drop function security_test.mcpev_denied(text);
drop function security_test.mcpev_rejects(text, text);

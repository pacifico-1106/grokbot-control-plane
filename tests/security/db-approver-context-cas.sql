-- TOCTOU follow-up (migration 20261010100000): approval-executed policy writes
-- are a compare-and-swap. Fixture data only.
-- Org A: employee E (active credential + revoked credential), approved tickets.
-- Org B: employee F (cross-org checks).
\set ON_ERROR_STOP 1
reset role;
insert into public.orgs (id, name) values
 ('7c000000-0000-4000-8000-0000000000a1', 'context-cas-a'),
 ('7c000000-0000-4000-8000-0000000000b1', 'context-cas-b');
insert into public.employees (id, org_id, display_name, role_label, scopes, allowed_purposes, approval_policy, action_limits, tool_approval_defaults) values
 ('7c000000-0000-4000-8000-000000000e01','7c000000-0000-4000-8000-0000000000a1','E','r','{mail:draft,commerce:order}','{sales.outreach}','always_human',
  '{"commerce.order":{"perDay":1}}','{"commerce.order":"deny","mail.send":"always_human"}'),
 ('7c000000-0000-4000-8000-000000000f01','7c000000-0000-4000-8000-0000000000b1','F','r','{mail:draft}','{}','always_human','{}','{}');
insert into public.credentials (id, org_id, employee_id, secret_hash, scopes, allowed_purposes, approval_policy, action_limits, revoked_at) values
 ('7c000000-0000-4000-8000-000000000c01','7c000000-0000-4000-8000-0000000000a1','7c000000-0000-4000-8000-000000000e01','fixture-hash-active',
  '{mail:draft,commerce:order}','{sales.outreach}','always_human','{"commerce.order":{"perDay":1}}',null),
 ('7c000000-0000-4000-8000-000000000c02','7c000000-0000-4000-8000-0000000000a1','7c000000-0000-4000-8000-000000000e01','fixture-hash-revoked',
  '{old}','{}','always_human','{}',now());
insert into public.approval_requests (id, org_id, purpose, summary, risk, status, tool, required_approver_kind, approver_authority, metadata) values
 ('7c000000-0000-4000-8000-000000000101','7c000000-0000-4000-8000-0000000000a1','admin.policy','p','high','approved','policy.patch','owner',
  '{"contextFingerprint":"fp-policy"}','{"adminTool":"policy.patch","adminMutation":{"employeeId":"7c000000-0000-4000-8000-000000000e01"}}'),
 ('7c000000-0000-4000-8000-000000000102','7c000000-0000-4000-8000-0000000000a1','admin.policy','p-pending','high','pending','policy.patch','owner',
  '{"contextFingerprint":"fp-policy"}','{"adminTool":"policy.patch","adminMutation":{"employeeId":"7c000000-0000-4000-8000-000000000e01"}}'),
 ('7c000000-0000-4000-8000-000000000103','7c000000-0000-4000-8000-0000000000a1','admin.policy','p-no-fp','high','approved','policy.patch','owner',
  '{}','{"adminTool":"policy.patch","adminMutation":{"employeeId":"7c000000-0000-4000-8000-000000000e01"}}'),
 ('7c000000-0000-4000-8000-000000000201','7c000000-0000-4000-8000-0000000000a1','admin.policy','s-org','high','approved','schedulingPolicy.patch','owner',
  '{"contextFingerprint":"fp-sched-org"}','{"adminTool":"schedulingPolicy.patch","adminMutation":{}}'),
 ('7c000000-0000-4000-8000-000000000202','7c000000-0000-4000-8000-0000000000a1','admin.policy','s-emp','high','approved','schedulingPolicy.patch','owner',
  '{"contextFingerprint":"fp-sched-emp"}','{"adminTool":"schedulingPolicy.patch","adminMutation":{"employeeId":"7c000000-0000-4000-8000-000000000e01","clearOverride":true}}');
update public.orgs set scheduling_policy = '{"policyName":"P","rules":[{"id":"r1","costCapJpy":5000}]}' where id = '7c000000-0000-4000-8000-0000000000a1';
update public.employees set scheduling_policy = '{"policyName":"E","rules":[{"id":"r1","costCapJpy":4000}]}' where id = '7c000000-0000-4000-8000-000000000e01';

set role service_role;
do $$
declare
  a constant uuid := '7c000000-0000-4000-8000-0000000000a1';
  b constant uuid := '7c000000-0000-4000-8000-0000000000b1';
  e constant uuid := '7c000000-0000-4000-8000-000000000e01';
  f constant uuid := '7c000000-0000-4000-8000-000000000f01';
  t_policy constant uuid := '7c000000-0000-4000-8000-000000000101';
  t_pending constant uuid := '7c000000-0000-4000-8000-000000000102';
  t_nofp constant uuid := '7c000000-0000-4000-8000-000000000103';
  t_sorg constant uuid := '7c000000-0000-4000-8000-000000000201';
  t_semp constant uuid := '7c000000-0000-4000-8000-000000000202';
  snap jsonb;
  r jsonb;
  row_before jsonb;
  cred_before jsonb;
  pol jsonb := '{"policyName":"P","rules":[{"id":"r1","costCapJpy":9000}]}';
  c record;
begin
  -- the snapshot the application pins (the five compared columns, raw; allowed_purposes added 2026-10-10)
  select jsonb_build_object('scopes', to_jsonb(x.scopes), 'allowed_purposes', to_jsonb(x.allowed_purposes),
    'approval_policy', to_jsonb(x.approval_policy), 'action_limits', x.action_limits, 'tool_approval_defaults', x.tool_approval_defaults)
    into snap from public.employees x where x.id = e;

  -- (1) a concurrent change between the check and the write → refused, nothing written
  update public.employees set action_limits = '{"commerce.order":{"perDay":50}}' where id = e;  -- the owner saves right now
  select to_jsonb(x) - 'updated_at' into row_before from public.employees x where x.id = e;
  select jsonb_agg(to_jsonb(x) order by x.id) into cred_before from public.credentials x where x.employee_id = e;
  r := public.approver_cas_write_employee_policy(a, e, t_policy, 'fp-policy', snap,
    '{mail:draft}', '{sales.outreach}', 'risk_based', '{"commerce.order":"always_human"}', 'ok', '{}');
  if (r->>'ok')::boolean or r->>'reason' <> 'approver_context_changed' then raise exception 'concurrent change not refused: %', r; end if;
  if (select to_jsonb(x) - 'updated_at' from public.employees x where x.id = e) <> row_before then raise exception 'employee written on refusal'; end if;
  if (select jsonb_agg(to_jsonb(x) order by x.id) from public.credentials x where x.employee_id = e) <> cred_before then raise exception 'credentials written on refusal'; end if;

  -- (1b) 2026-10-10 item 2(a): a concurrent allowed_purposes change alone → refused, nothing written
  select jsonb_build_object('scopes', to_jsonb(x.scopes), 'allowed_purposes', to_jsonb(x.allowed_purposes),
    'approval_policy', to_jsonb(x.approval_policy), 'action_limits', x.action_limits, 'tool_approval_defaults', x.tool_approval_defaults)
    into snap from public.employees x where x.id = e;
  update public.employees set allowed_purposes = '{finance.close}' where id = e;  -- the owner saves right now
  select to_jsonb(x) - 'updated_at' into row_before from public.employees x where x.id = e;
  select jsonb_agg(to_jsonb(x) order by x.id) into cred_before from public.credentials x where x.employee_id = e;
  r := public.approver_cas_write_employee_policy(a, e, t_policy, 'fp-policy', snap,
    '{mail:draft}', '{sales.outreach}', 'risk_based', null, 'ok', '{}');
  if (r->>'ok')::boolean or r->>'reason' <> 'approver_context_changed' then raise exception 'concurrent purposes change not refused: %', r; end if;
  if (select to_jsonb(x) - 'updated_at' from public.employees x where x.id = e) <> row_before then raise exception 'employee written on purposes refusal'; end if;
  if (select jsonb_agg(to_jsonb(x) order by x.id) from public.credentials x where x.employee_id = e) <> cred_before then raise exception 'credentials written on purposes refusal'; end if;
  -- a snapshot without allowed_purposes (the old four-key shape) never matches
  r := public.approver_cas_write_employee_policy(a, e, t_policy, 'fp-policy', snap - 'allowed_purposes' ,
    '{mail:draft}', '{sales.outreach}', 'risk_based', null, 'ok', '{}');
  if (r->>'ok')::boolean or r->>'reason' <> 'approver_context_changed' then raise exception 'four-key snapshot accepted: %', r; end if;
  update public.employees set allowed_purposes = '{sales.outreach}' where id = e;

  -- (2) unchanged → written atomically: employee + active credential; revoked credential untouched
  select jsonb_build_object('scopes', to_jsonb(x.scopes), 'allowed_purposes', to_jsonb(x.allowed_purposes),
    'approval_policy', to_jsonb(x.approval_policy), 'action_limits', x.action_limits, 'tool_approval_defaults', x.tool_approval_defaults)
    into snap from public.employees x where x.id = e;
  -- key order of the snapshot does not matter (jsonb equality)
  r := public.approver_cas_write_employee_policy(a, e, t_policy, 'fp-policy',
    jsonb_build_object('tool_approval_defaults', snap->'tool_approval_defaults', 'action_limits', snap->'action_limits',
      'approval_policy', snap->'approval_policy', 'allowed_purposes', snap->'allowed_purposes', 'scopes', snap->'scopes'),
    '{mail:draft}', '{sales.outreach}', 'risk_based', null, 'warn', '{"mail.send":{"perDay":3}}');
  if not (r->>'ok')::boolean or r->'employee'->>'id' <> e::text then raise exception 'unchanged write refused: %', r; end if;
  if not exists (select 1 from public.employees x where x.id = e and x.scopes = '{mail:draft}' and x.approval_policy = 'risk_based'
      and x.sod_level = 'warn' and x.action_limits = '{"mail.send":{"perDay":3}}'
      and x.tool_approval_defaults = '{"commerce.order":"deny","mail.send":"always_human"}') then
    raise exception 'employee not written as asked (null tool_approval_defaults must keep the stored map)';
  end if;
  if not exists (select 1 from public.credentials x where x.id = '7c000000-0000-4000-8000-000000000c01' and x.scopes = '{mail:draft}'
      and x.approval_policy = 'risk_based' and x.action_limits = '{"mail.send":{"perDay":3}}') then raise exception 'active credential not written'; end if;
  if not exists (select 1 from public.credentials x where x.id = '7c000000-0000-4000-8000-000000000c02' and x.scopes = '{old}') then
    raise exception 'revoked credential written';
  end if;
  -- the same (now stale) snapshot again → refused
  r := public.approver_cas_write_employee_policy(a, e, t_policy, 'fp-policy', snap,
    '{mail:draft}', '{}', 'always_human', null, 'ok', '{}');
  if (r->>'ok')::boolean or r->>'reason' <> 'approver_context_changed' then raise exception 'stale snapshot accepted: %', r; end if;

  select jsonb_build_object('scopes', to_jsonb(x.scopes), 'allowed_purposes', to_jsonb(x.allowed_purposes),
    'approval_policy', to_jsonb(x.approval_policy), 'action_limits', x.action_limits, 'tool_approval_defaults', x.tool_approval_defaults)
    into snap from public.employees x where x.id = e;
  select to_jsonb(x) - 'updated_at' into row_before from public.employees x where x.id = e;
  -- (3) ticket binding: fingerprint, missing fingerprint, status, tool, target, org — all refused, nothing written
  for c in select * from (values
    (a, e, t_policy, 'fp-other', 'approver_context_changed'),
    (a, e, t_nofp, 'fp-policy', 'approver_context_changed'),
    (a, e, t_pending, 'fp-policy', 'approval_not_approved'),
    (a, e, t_sorg, 'fp-sched-org', 'approval_tool_mismatch'),
    (b, f, t_policy, 'fp-policy', 'approval_not_found'),
    (a, f, t_policy, 'fp-policy', 'approval_target_mismatch'),
    (a, e, '7c000000-0000-4000-8000-0000000009ff'::uuid, 'fp-policy', 'approval_not_found')
  ) v(org_id, emp_id, ticket, fp, reason) loop
    r := public.approver_cas_write_employee_policy(c.org_id, c.emp_id, c.ticket, c.fp, snap,
      '{mail:draft}', '{}', 'auto', '{}', 'ok', '{}');
    if (r->>'ok')::boolean or r->>'reason' <> c.reason then raise exception 'binding case % → %', c, r; end if;
  end loop;
  if (select to_jsonb(x) - 'updated_at' from public.employees x where x.id = e) <> row_before then raise exception 'written on a refused binding case'; end if;
  if exists (select 1 from public.employees x where x.id = f and x.approval_policy <> 'always_human') then raise exception 'cross-org employee written'; end if;
  -- invalid input → refused
  r := public.approver_cas_write_employee_policy(a, e, t_policy, 'fp-policy', null, '{mail:draft}', '{}', 'auto', null, 'ok', '{}');
  if (r->>'ok')::boolean or r->>'reason' <> 'invalid_input' then raise exception 'null snapshot: %', r; end if;
  r := public.approver_cas_write_employee_policy(a, e, t_policy, '', snap, '{mail:draft}', '{}', 'auto', null, 'ok', '{}');
  if (r->>'ok')::boolean or r->>'reason' <> 'invalid_input' then raise exception 'empty fingerprint: %', r; end if;

  -- (4) schedulingPolicy.patch, org target
  r := public.approver_cas_write_scheduling_policy(a, null, t_sorg, 'fp-sched-org',
    jsonb_build_object('org', '{"policyName":"P","rules":[{"id":"r1","costCapJpy":3000}]}'::jsonb), 'org', pol);  -- judged at 3000, now 5000
  if (r->>'ok')::boolean or r->>'reason' <> 'approver_context_changed' then raise exception 'scheduling concurrent change: %', r; end if;
  if (select scheduling_policy from public.orgs where id = a) <> '{"policyName":"P","rules":[{"id":"r1","costCapJpy":5000}]}' then raise exception 'org policy written on refusal'; end if;
  r := public.approver_cas_write_scheduling_policy(a, null, t_sorg, 'fp-sched-org',
    jsonb_build_object('org', (select scheduling_policy from public.orgs where id = a)), 'org', pol);
  if not (r->>'ok')::boolean or (select scheduling_policy from public.orgs where id = a) <> pol then raise exception 'scheduling org write: %', r; end if;
  -- missing key in the snapshot is not "null"
  r := public.approver_cas_write_scheduling_policy(a, null, t_sorg, 'fp-sched-org', '{}'::jsonb, 'org', pol);
  if (r->>'ok')::boolean or r->>'reason' <> 'invalid_input' then raise exception 'snapshot without org: %', r; end if;
  -- wrong target for the ticket
  r := public.approver_cas_write_scheduling_policy(a, e, t_sorg, 'fp-sched-org',
    jsonb_build_object('org', pol, 'employee', (select scheduling_policy from public.employees where id = e)), 'employee', null);
  if (r->>'ok')::boolean or r->>'reason' <> 'approval_target_mismatch' then raise exception 'scheduling target mismatch: %', r; end if;
  -- clearing the org policy is not a thing
  r := public.approver_cas_write_scheduling_policy(a, null, t_sorg, 'fp-sched-org', jsonb_build_object('org', pol), 'org', null);
  if (r->>'ok')::boolean or r->>'reason' <> 'invalid_input' then raise exception 'org clear: %', r; end if;

  -- (5) employee clearOverride: inherited org policy changed concurrently → refused; then unchanged → cleared
  r := public.approver_cas_write_scheduling_policy(a, e, t_semp, 'fp-sched-emp',
    jsonb_build_object('org', '{"policyName":"P","rules":[{"id":"r1","costCapJpy":5000}]}'::jsonb,
      'employee', (select scheduling_policy from public.employees where id = e)), 'employee', null);
  if (r->>'ok')::boolean or r->>'reason' <> 'approver_context_changed' then raise exception 'inherited org change not caught: %', r; end if;
  if (select scheduling_policy from public.employees where id = e) is null then raise exception 'override cleared on refusal'; end if;
  r := public.approver_cas_write_scheduling_policy(a, e, t_semp, 'fp-sched-emp',
    jsonb_build_object('org', pol, 'employee', (select scheduling_policy from public.employees where id = e)), 'employee', null);
  if not (r->>'ok')::boolean or (select scheduling_policy from public.employees where id = e) is not null then raise exception 'clear override: %', r; end if;
  -- cross-org
  r := public.approver_cas_write_scheduling_policy(b, null, t_sorg, 'fp-sched-org', jsonb_build_object('org', null), 'org', pol);
  if (r->>'ok')::boolean or r->>'reason' <> 'approval_not_found' then raise exception 'scheduling cross-org: %', r; end if;
end $$;

reset role;
do $$
begin
  if has_function_privilege('anon', 'public.approver_cas_write_employee_policy(uuid,uuid,uuid,text,jsonb,text[],text[],text,jsonb,text,jsonb)', 'execute')
    or has_function_privilege('authenticated', 'public.approver_cas_write_employee_policy(uuid,uuid,uuid,text,jsonb,text[],text[],text,jsonb,text,jsonb)', 'execute')
    or has_function_privilege('anon', 'public.approver_cas_write_scheduling_policy(uuid,uuid,uuid,text,jsonb,text,jsonb)', 'execute')
    or has_function_privilege('authenticated', 'public.approver_cas_write_scheduling_policy(uuid,uuid,uuid,text,jsonb,text,jsonb)', 'execute') then
    raise exception 'anon/authenticated can execute the CAS RPCs';
  end if;
  if not has_function_privilege('service_role', 'public.approver_cas_write_employee_policy(uuid,uuid,uuid,text,jsonb,text[],text[],text,jsonb,text,jsonb)', 'execute')
    or not has_function_privilege('service_role', 'public.approver_cas_write_scheduling_policy(uuid,uuid,uuid,text,jsonb,text,jsonb)', 'execute') then
    raise exception 'service_role cannot execute the CAS RPCs';
  end if;
end $$;

delete from public.approval_requests where org_id in ('7c000000-0000-4000-8000-0000000000a1','7c000000-0000-4000-8000-0000000000b1');
delete from public.orgs where id in ('7c000000-0000-4000-8000-0000000000a1','7c000000-0000-4000-8000-0000000000b1');

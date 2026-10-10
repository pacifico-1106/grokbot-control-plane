"""Disposable PostgreSQL test cluster. Never reads PG*/DATABASE_URL or .env.
Uses a newly created directory and Unix socket only; no existing DB is touched.
"""
import os
from pathlib import Path
import subprocess
import tempfile
import shutil
import argparse
import re

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--f8-parent-state", choices=("fresh", "legacy-indexes", "mismatched-indexes", "existing-constraints"), default="fresh")
args = parser.parse_args()

ROOT = Path(__file__).resolve().parents[1]
BIN = Path(os.environ.get("PG_TEST_BIN", "/opt/homebrew/opt/postgresql@16/bin"))
env = {key: os.environ[key] for key in ("PATH", "TMPDIR", "LANG") if key in os.environ}
env.update({"LC_ALL": "C", "PGCONNECT_TIMEOUT": "5", "PGOPTIONS": "-c client_min_messages=warning"})
cluster = Path(tempfile.mkdtemp(prefix="staffpass-authz-"))
started = False

def run(args, **kwargs):
    return subprocess.run([str(x) for x in args], env=env, check=True, **kwargs)

def sql(path):
    # Fixture-only SQL. ON_ERROR_STOP prevents false green results.
    run([BIN / "psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-h", cluster,
         "-p", "55439", "-U", "test_admin", "-d", "postgres", "-f", path], stdout=subprocess.DEVNULL)

def query(command):
    result = run([BIN / "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-h", cluster,
        "-p", "55439", "-U", "test_admin", "-d", "postgres", "-c", command], capture_output=True, text=True)
    return result.stdout.strip()

def parent_constraints():
    return query("""select conrelid::regclass::text || ':' || conname || ':' || oid || ':' || conindid
        from pg_constraint where contype='u' and not condeferrable and convalidated
        and conrelid in ('public.org_members'::regclass, 'public.approval_requests'::regclass,
                        'public.approval_workflow_instances'::regclass)
        and pg_get_constraintdef(oid)='UNIQUE (id, org_id)' order by conrelid, conname;""")

try:
    run([BIN / "initdb", "-D", cluster / "data", "-U", "test_admin", "--auth=trust", "--no-locale"], stdout=subprocess.DEVNULL)
    run([BIN / "pg_ctl", "-D", cluster / "data", "-l", cluster / "server.log",
         "-o", f"-F -c listen_addresses='' -k {cluster} -p 55439", "-w", "start"], stdout=subprocess.DEVNULL)
    started = True
    sql(ROOT / "tests/security/db-bootstrap.sql")
    sql(ROOT / "supabase/schema.sql")
    # Explicit dependency order: filenames are not all consistently timestamped.
    for name in ["20260823_production_ready.sql", "20260823_referral_code.sql", "20260823_agentmail_reservation.sql", "20260824_approval_loop.sql", "20260826_telegram_revision.sql", "20260827_sod_action_limits.sql", "20260827_tenant_notification_channels.sql", "20260827_cross_product_commerce_events.sql"]:
        sql(ROOT / "supabase/migrations" / name)
    for name in ['20260828_audience_egress.sql', '20260828_employee_voice.sql', '20260828_project_scope.sql', '20260828_slack_notify_post.sql', '20260828_slack_posting_identity.sql', '20260830_slack_mention_ingress.sql', '20260830_sod_warn_policy.sql', '20260830_tool_approval_defaults.sql', '20260830_tool_approval_money_destructive.sql', '20260831_per_employee_approval_inbox.sql', '20260831_sns_publish.sql', '20260903_admin_mcp.sql', '20260903_slack_internal_im_ingress.sql', '20260906_employee_ingress_handoff.sql', '20260906_ingress_handoff_policy.sql', '20260907_scheduling_policy.sql', '20260908_reply_policy.sql']:
        sql(ROOT / "supabase/migrations" / name)
    for name in ["20260914_internal_audience_rule.sql", "20260914_expired_trial_status.sql", "20260915_mail_policy.sql", "20260915_stuck_watch_policy.sql"]:
        sql(ROOT / "supabase/migrations" / name)
    migration = ROOT / "supabase/migrations/20260916000000_approval_execution_security.sql"
    sql(migration)
    workflow_migration = ROOT / "supabase/migrations/20260916_approval_workflow.sql"
    sql(workflow_migration)  # F8 must apply after the already-deployed #80 schema.
    parents = {
        "org_members": "org_members_id_org_uidx",
        "approval_requests": "approval_requests_id_org_uidx",
        "approval_workflow_instances": "workflow_instances_id_org_uidx",
    }
    existing_indexes = {}
    for table, index in parents.items():
        if args.f8_parent_state in ("legacy-indexes", "mismatched-indexes"):
            # A pre-existing same-name index may not cover the FK's columns.
            columns = "id, org_id" if args.f8_parent_state == "legacy-indexes" else "id"
            query(f"create unique index {index} on public.{table} ({columns});")
            existing_indexes[index] = query(f"select 'public.{index}'::regclass::oid;")
        elif args.f8_parent_state == "existing-constraints":
            # Split/manual rollout names must also remain idempotent.
            query(f"alter table public.{table} add constraint {table}_fixture_key unique (id, org_id);")
    existing_constraints = parent_constraints()
    enforcement = ROOT / "supabase/migrations/20260916120000_f8_enforcement.sql"
    sql(enforcement)
    constraints = parent_constraints()
    assert len(constraints.splitlines()) == 3, constraints
    for table in parents:
        name = table + ("_fixture_key" if args.f8_parent_state == "existing-constraints" else "_id_org_key")
        assert any(row.startswith(f"{table}:{name}:") for row in constraints.splitlines()), constraints
    if existing_constraints:
        assert constraints == existing_constraints, "existing parent constraints/indexes were replaced"
    for index, oid in existing_indexes.items():
        assert query(f"select 'public.{index}'::regclass::oid;") == oid, "legacy index was replaced"
    sql(ROOT / "tests/security/db-execution.sql")
    sql(migration)  # ACL/functions/table expansion must be re-applicable.
    sql(workflow_migration)
    sql(enforcement)
    assert parent_constraints() == constraints, "reapply duplicated/replaced parent constraints or indexes"
    sql(ROOT / "tests/security/db-workflow.sql")
    from concurrent.futures import ThreadPoolExecutor
    org = "00000000-0000-4000-8000-000000000001"
    ticket = "00000000-0000-4000-8000-000000000010"
    actor = "00000000-0000-4000-8000-000000000020"
    command = f"set role service_role; select public.claim_approval_execution('{ticket}','{org}',gen_random_uuid())->>'state';"
    with ThreadPoolExecutor(max_workers=12) as pool:
        states = list(pool.map(query, [command]*12))
    assert states.count("claimed") == 1 and states.count("running") == 11, states
    command = f"set role service_role; select coalesce(public.consume_admin_approval_secret('00000000-0000-4000-8000-000000000011','{org}','{actor}',1),'consumed');"
    with ThreadPoolExecutor(max_workers=12) as pool:
        results = list(pool.map(query, [command]*12))
    assert results.count("fixture-only") == 1 and results.count("consumed") == 11, "secret consumption was not atomic"
    assert query("select count(*) from approval_requests where metadata::text like '%fixture-only%';") == "0"
    command = "set role service_role; select security_test.vote(13,1)->>'accepted';"
    with ThreadPoolExecutor(max_workers=12) as pool:
        votes = list(pool.map(query, [command]*12))
    assert votes.count("true") == 1 and votes.count("false") == 11, votes
    assert query("select count(*) from approval_workflow_ballots b join approval_workflow_instances w on w.id=b.instance_id where w.approval_id='40000000-0000-4000-8000-000000000013' and b.vote is not null;") == "1"
    commands = [f"set role service_role; select security_test.vote(14,{v})->>'accepted';" for v in (1,2)]
    with ThreadPoolExecutor(max_workers=2) as pool:
        votes = list(pool.map(query, commands))
    assert votes == ["true", "true"], votes
    assert query("select current_stage_index from approval_workflow_instances where approval_id='40000000-0000-4000-8000-000000000014';") == "1"
    comm_reply_dedup = ROOT / "supabase/migrations/20261004700000_comm_reply_dedup.sql"
    sql(comm_reply_dedup)
    sql(comm_reply_dedup)  # re-applicable
    sql(ROOT / "tests/security/db-comm-reply-dedup.sql")
    dedup_org = "80000000-0000-4000-8000-0000000000a1"
    dedup_emp = "81000000-0000-4000-8000-000000000001"
    command = (f"set role service_role; select public.claim_comm_reply_send('{dedup_org}','{dedup_emp}',"
               f"repeat('d',64),repeat('e',64),null,'comm.reply',null,1800,0.6,172800)->>'state';")
    with ThreadPoolExecutor(max_workers=12) as pool:
        states = list(pool.map(query, [command]*12))
    assert states.count("claimed") == 1 and states.count("duplicate") == 11, states
    query("update public.approval_requests set status='superseded' where id='82000000-0000-4000-8000-000000000002';")
    sql(ROOT / "supabase/verification/20261004700000_comm_reply_dedup_rollback.sql")
    assert query("select to_regclass('public.comm_reply_send_fingerprints') is null;") == "t"
    assert query("select count(*) from public.approval_requests where status='superseded';") == "0"
    assert query("select status from public.approval_requests where id='82000000-0000-4000-8000-000000000002';") == "expired"
    assert "superseded" not in query("select pg_get_constraintdef(oid) from pg_constraint where conname='approval_requests_status_check';")
    sql(comm_reply_dedup)  # forward again after rollback
    guard_v2 = ROOT / "supabase/migrations/20261005300000_duplicate_post_guard_v2.sql"
    sql(guard_v2)
    sql(guard_v2)  # re-applicable
    sql(ROOT / "tests/security/db-duplicate-guard-v2.sql")
    # 12 concurrent identical claims by two employees in one channel (cross-employee block): 1 winner.
    commands = [(f"set role service_role; select public.claim_outbound_send_v2('{dedup_org}','{emp}',"
                 f"repeat('7',64),repeat('7',64),null,repeat('e',64),null,'comm.reply',null,21600,0.6,2592000,true,'block',false)->>'state';")
                for emp in [dedup_emp, "81000000-0000-4000-8000-000000000002"] * 6]
    with ThreadPoolExecutor(max_workers=12) as pool:
        states = list(pool.map(query, commands))
    assert states.count("claimed") == 1 and states.count("duplicate") == 11, states
    sql(ROOT / "supabase/verification/20261005300000_duplicate_post_guard_v2_rollback.sql")
    assert query("select to_regprocedure('public.claim_outbound_send_v2(uuid,uuid,text,text,text,text,integer[],text,uuid,integer,double precision,integer,boolean,text,boolean)') is null;") == "t"
    assert query("select count(*) from information_schema.columns where table_schema='public' and table_name='comm_reply_send_fingerprints' and column_name in ('channel_key','job_key');") == "0"
    assert query("select count(*) from public.comm_reply_send_fingerprints where tool='sns.publish';") == "0"
    # v1 keeps working after the v2 rollback
    command = (f"set role service_role; select public.claim_comm_reply_send('{dedup_org}','{dedup_emp}',"
               f"repeat('d',64),repeat('e',64),null,'comm.reply',null,1800,0.6,172800)->>'state';")
    assert query(command) == "claimed"
    query("delete from public.comm_reply_send_fingerprints where conversation_key=repeat('d',64);")
    sql(guard_v2)  # forward again after rollback
    print("PASS: duplicate post guard v2: anon/authenticated denied, same job regardless of window, cross-thread, cross-employee block/warn/off, uncertain rows reported + released only by their owner, fulfil uncertain vs superseded, sns.publish allowed, invalid input denied, 12 concurrent claims by 2 employees have 1 winner; rollback (v1 still works) + re-apply.")
    print("PASS: comm reply dedup ledger: superseded status + guard, anon/authenticated denied, org/employee isolation, exact/similar, superseded-after-approval only for an identical / similar reply (7 cases), 12 concurrent identical claims have 1 winner; rollback + re-apply.")
    member_guard = ROOT / "supabase/migrations/20261004200000_org_members_capability_guard.sql"
    sql(member_guard)
    sql(member_guard)  # re-applicable
    sql(ROOT / "tests/security/db-member-guard.sql")
    tenant_writes = ROOT / "supabase/migrations/20261004500000_tenant_tables_server_only_writes.sql"
    sql(tenant_writes)
    sql(tenant_writes)  # re-applicable
    sql(ROOT / "tests/security/db-rls-write-holes.sql")
    sql(ROOT / "supabase/migrations/20260923_external_contract_card_setup.sql")  # phase-2 tables not in schema.sql
    sql(ROOT / "supabase/migrations/20261001400000_lp_handoffs.sql")  # lp_* (formerly LOW) not in schema.sql
    config_writes = ROOT / "supabase/migrations/20261004600000_tenant_config_tables_server_only_writes.sql"
    sql(config_writes)
    sql(config_writes)  # re-applicable
    sql(ROOT / "tests/security/db-rls-write-holes-phase2.sql")
    sql(ROOT / "supabase/migrations/20261001000000_lp_inquiries.sql")  # lp_inquiries / notification_outbox not in schema.sql
    lp_server_only = ROOT / "supabase/migrations/20261004800000_lp_tables_server_only.sql"
    sql(lp_server_only)
    sql(lp_server_only)  # re-applicable
    sql(ROOT / "tests/security/db-lp-tables-server-only.sql")
    mcp_events = ROOT / "supabase/migrations/20261005000000_mcp_event_subscriptions.sql"
    sql(mcp_events)
    sql(mcp_events)  # re-applicable
    sql(ROOT / "tests/security/db-mcp-events.sql")
    # D11: 40 concurrent budget calls for one host in one window → exactly 30 accepted (atomic upsert, no read-then-write).
    command = ("set role service_role; select public.mcp_events_take_verification_budget("
               "'race.example.org', date_trunc('minute', now()) + interval '5 minutes', 30);")
    with ThreadPoolExecutor(max_workers=40) as pool:
        answers = list(pool.map(query, [command]*40))
    assert answers.count("t") == 30 and answers.count("f") == 10, answers
    assert query("select count from public.mcp_event_verification_windows where host='race.example.org';") == "30"
    query("delete from public.mcp_event_verification_windows where host='race.example.org';")
    sql(ROOT / "supabase/verification/20261005000000_mcp_event_subscriptions_rollback.sql")
    assert query("select to_regclass('public.mcp_event_subscriptions') is null and to_regclass('public.mcp_event_deliveries') is null"
                 " and to_regclass('public.mcp_event_verification_windows') is null"
                 " and to_regprocedure('public.mcp_events_take_verification_budget(text,timestamptz,integer)') is null;") == "t"
    sql(mcp_events)  # forward again after rollback
    sql(ROOT / "tests/security/db-mcp-events.sql")
    mcp_oauth = ROOT / "supabase/migrations/20261010200000_mcp_oauth.sql"
    sql(mcp_oauth)
    sql(mcp_oauth)  # re-applicable
    sql(ROOT / "tests/security/db-mcp-oauth.sql")
    sql(ROOT / "supabase/verification/20261010200000_mcp_oauth_rollback.sql")
    assert query("select " + " and ".join(f"to_regclass('public.{t}') is null" for t in (
        "oauth_clients", "oauth_authorization_requests", "oauth_grants", "oauth_authorization_codes",
        "oauth_access_tokens", "oauth_refresh_tokens", "oauth_rate_limits"))
        + " and to_regprocedure('public.oauth_rate_limit_hit(text,timestamptz)') is null"
        " and to_regprocedure('public.oauth_grants_same_org()') is null;") == "t"
    sql(mcp_oauth)  # forward again after rollback
    sql(ROOT / "tests/security/db-mcp-oauth.sql")
    print("PASS: mcp oauth (20261010200000): 7 tables RLS on / no policy, anon/authenticated hold no privilege and cannot execute "
          "oauth_rate_limit_hit; cross-org grant (employee / credential / member) rejected; atomic rate-limit counter; "
          "re-applicable; rollback drops all 7 tables + 2 functions; forward again.")
    webhook_settings = ROOT / "supabase/migrations/20261005100000_employee_webhook_settings.sql"
    sql(webhook_settings)
    sql(webhook_settings)  # re-applicable
    sql(ROOT / "tests/security/db-webhook-settings.sql")
    sql(ROOT / "supabase/verification/20261005100000_employee_webhook_settings_rollback.sql")
    assert query("select to_regclass('public.employee_webhook_settings') is null"
                 " and to_regprocedure('public.employee_webhook_settings_same_org()') is null;") == "t"
    sql(webhook_settings)  # forward again after rollback
    sql(ROOT / "tests/security/db-webhook-settings.sql")
    channel_classify = ROOT / "supabase/migrations/20261005200000_channel_classify_proposals.sql"
    sql(channel_classify)
    sql(channel_classify)  # re-applicable
    sql(ROOT / "tests/security/db-channel-classify.sql")
    ccp_org = "c5000000-0000-4000-8000-0000000000c1"
    query(f"insert into public.orgs(id, name) values ('{ccp_org}', 'channel-classify-race');")
    command = (f"set role service_role; select public.claim_channel_classify_proposal("
               f"'{ccp_org}', 'channel:slack:C0RACE0001', repeat('a', 64), 600)->>'state';")
    with ThreadPoolExecutor(max_workers=12) as pool:
        claims = list(pool.map(query, [command]*12))
    assert claims.count("claimed") == 1 and claims.count("in_flight") == 11, claims
    query(f"delete from public.orgs where id='{ccp_org}';")
    sql(ROOT / "supabase/verification/20261005200000_channel_classify_proposals_rollback.sql")
    assert query("select to_regclass('public.channel_classify_proposals') is null"
                 " and to_regclass('public.channel_stuck_notice_windows') is null"
                 " and to_regprocedure('public.claim_channel_classify_proposal(uuid,text,text,integer)') is null"
                 " and to_regprocedure('public.attach_channel_classify_proposal(uuid,text,uuid)') is null"
                 " and to_regprocedure('public.release_channel_classify_proposal(uuid,text)') is null"
                 " and to_regprocedure('public.take_channel_stuck_notice(uuid,text,integer)') is null;") == "t"
    assert "telegram" not in query("select pg_get_constraintdef(oid) from pg_constraint"
                                   " where conname='org_channels_surface_check';")
    sql(channel_classify)  # forward again after rollback
    sql(ROOT / "tests/security/db-channel-classify.sql")
    budget = ROOT / "supabase/migrations/20261005400000_channel_classify_budget.sql"
    sql(budget)
    sql(budget)  # re-applicable
    sql(ROOT / "tests/security/db-channel-classify-budget.sql")
    ccb_org = "c6000000-0000-4000-8000-0000000000c1"
    query(f"insert into public.orgs(id, name) values ('{ccb_org}', 'channel-classify-budget-race');")
    command = (f"set role service_role; select public.take_channel_classify_budget("
               f"'{ccb_org}', 'proposals', 3600, 5)->>'state';")
    with ThreadPoolExecutor(max_workers=12) as pool:
        takes = list(pool.map(query, [command]*20))
    assert takes.count("allowed") == 5 and takes.count("over_first") == 1 and takes.count("over") == 14, takes
    query(f"delete from public.orgs where id='{ccb_org}';")
    sql(ROOT / "supabase/verification/20261005400000_channel_classify_budget_rollback.sql")
    assert query("select to_regclass('public.channel_classify_budget_windows') is null"
                 " and to_regprocedure('public.take_channel_classify_budget(uuid,text,integer,integer)') is null"
                 " and to_regclass('public.channel_classify_proposals') is not null;") == "t"
    sql(budget)  # forward again after rollback
    sql(ROOT / "tests/security/db-channel-classify-budget.sql")
    thread_sf = ROOT / "supabase/migrations/20261009100000_thread_single_flight.sql"
    sql(thread_sf)
    sql(thread_sf)  # re-applicable
    sql(ROOT / "tests/security/db-thread-single-flight.sql")
    tsf_org = "c7000000-0000-4000-8000-0000000000f1"
    tsf_emp = "c7100000-0000-4000-8000-0000000000f1"
    query(f"insert into public.orgs(id, name) values ('{tsf_org}', 'thread-sf-race');"
          f" insert into public.employees(id, org_id, display_name, role_label) values ('{tsf_emp}', '{tsf_org}', 'TSF race', 'fixture');")
    tsf_commands = [(f"set role service_role; select public.acquire_thread_send_lease("
                     f"'{tsf_org}', repeat('a', 64), '{tsf_emp}', gen_random_uuid(), 60)->>'state';") for _ in range(12)]
    with ThreadPoolExecutor(max_workers=12) as pool:
        tsf_takes = list(pool.map(query, tsf_commands))
    assert tsf_takes.count("acquired") == 1 and tsf_takes.count("busy") == 11, tsf_takes
    query(f"delete from public.orgs where id='{tsf_org}';")
    sql(ROOT / "supabase/verification/20261009100000_thread_single_flight_rollback.sql")
    assert query("select to_regclass('public.thread_send_leases') is null and to_regclass('public.thread_self_posts') is null"
                 " and to_regprocedure('public.acquire_thread_send_lease(uuid,text,uuid,uuid,integer)') is null"
                 " and to_regprocedure('public.release_thread_send_lease(uuid,text,uuid)') is null"
                 " and to_regprocedure('public.record_thread_self_post(uuid,uuid,text,bigint,text)') is null"
                 " and to_regclass('public.comm_reply_send_fingerprints') is not null;") == "t"
    sql(thread_sf)  # forward again after rollback
    sql(ROOT / "tests/security/db-thread-single-flight.sql")
    preflag = ROOT / "supabase/migrations/20261009150000_thread_single_flight_preflag.sql"
    sql(preflag)
    sql(preflag)  # re-applicable
    sql(ROOT / "tests/security/db-thread-single-flight-preflag.sql")
    sql(ROOT / "tests/security/db-thread-single-flight.sql")  # #286's checks still pass on the new record function
    tsfp_org = "c7500000-0000-4000-8000-0000000000f1"
    query(f"insert into public.orgs(id, name) values ('{tsfp_org}', 'thread-sf-preflag-race');"
          + "".join(f" insert into public.approval_requests(id, org_id, purpose, summary, risk, status, tool) values"
                    f" ('c7700000-0000-4000-8000-0000000000f{i}', '{tsfp_org}', 'comm.internal', 'race', 'high', 'approved', 'comm.send');"
                    for i in range(1)))
    tsfp_commands = [(f"set role service_role; select public.close_approval_without_send('c7700000-0000-4000-8000-0000000000f0',"
                      f" '{tsfp_org}', array['approved'], '{'superseded' if i % 2 else 'expired'}', '{{\"reason\":\"race{i}\"}}'::jsonb) is not null;")
                     for i in range(12)]
    with ThreadPoolExecutor(max_workers=12) as pool:
        tsfp_closes = list(pool.map(query, tsfp_commands))
    assert tsfp_closes.count("t") == 1 and tsfp_closes.count("f") == 11, tsfp_closes
    assert query("select (status = metadata->'closedWithoutSend'->>'status') and resolved_at is not null"
                 " from public.approval_requests where id = 'c7700000-0000-4000-8000-0000000000f0';") == "t"
    query(f"delete from public.approval_requests where org_id = '{tsfp_org}'; delete from public.orgs where id = '{tsfp_org}';")
    sql(ROOT / "supabase/verification/20261009150000_thread_single_flight_preflag_rollback.sql")
    assert query("select to_regprocedure('public.close_approval_without_send(uuid,uuid,text[],text,jsonb)') is null"
                 " and to_regclass('public.thread_wake_points') is null"
                 " and to_regprocedure('public.record_thread_wake_point(uuid,uuid,text,bigint)') is null"
                 " and to_regprocedure('public.acquire_thread_send_lease(uuid,text,uuid,uuid,integer,text)') is null"
                 " and to_regprocedure('public.acquire_thread_send_lease(uuid,text,uuid,uuid,integer)') is not null"
                 " and not exists (select 1 from information_schema.columns where table_schema = 'public'"
                 " and table_name = 'thread_send_leases' and column_name = 'job_key')"
                 " and to_regprocedure('public.record_thread_self_post(uuid,uuid,text,bigint,text)') is not null"
                 " and to_regclass('public.thread_self_posts') is not null"
                 " and not exists (select 1 from information_schema.columns where table_schema = 'public'"
                 " and table_name = 'thread_self_posts' and column_name = 'job_first_micros');") == "t"
    sql(ROOT / "tests/security/db-thread-single-flight.sql")  # #286 intact after rolling back only the follow-up
    sql(preflag)  # forward again after rollback
    sql(ROOT / "tests/security/db-thread-single-flight-preflag.sql")
    # PR-D approver authority: needs the P0 admin-approver RPC it replaces.
    sql(ROOT / "supabase/migrations/20260927000300_admin_approver_enforcement.sql")
    approver_authority = ROOT / "supabase/migrations/20261005500000_approver_authority.sql"
    sql(approver_authority)
    sql(approver_authority)  # re-applicable
    sql(ROOT / "tests/security/db-approver-authority.sql")
    rollback = re.search(r"^-- ROLLBACK \(down\).*?$(.*?)^-- END ROLLBACK", approver_authority.read_text(), re.S | re.M)
    assert rollback, "approver authority migration has no rollback block"
    rollback_sql = cluster / "approver-authority-rollback.sql"
    rollback_sql.write_text("\n".join(ln[5:] for ln in rollback.group(1).splitlines() if ln.startswith("--   ")) + "\n")
    sql(rollback_sql)
    assert query("select to_regprocedure('public.resolve_approval_w1_checked(uuid,uuid,uuid,text,text,text,text)') is not null"
                 " and to_regprocedure('public.resolve_approval_w1_checked(uuid,uuid,uuid,text,text,text,text,boolean)') is null"
                 " and to_regprocedure('public.approver_authority_check(uuid,uuid,text,text[])') is null"
                 " and to_regprocedure('public.approver_authority_requester_ids(jsonb)') is null"
                 " and not exists (select 1 from information_schema.columns where table_schema='public'"
                 " and column_name in ('required_approver_kind','approver_member_id','approver_role','approver_authority','designated_admin_member_ids'));") == "t"
    sql(approver_authority)  # forward again after rollback
    sql(ROOT / "tests/security/db-approver-authority.sql")
    # TOCTOU follow-up (20261010100000): approval-executed policy writes are a
    # compare-and-swap on the snapshot pinned by the filing fingerprint.
    context_cas = ROOT / "supabase/migrations/20261010100000_approver_context_cas.sql"
    sql(context_cas)
    sql(context_cas)  # re-applicable
    sql(ROOT / "tests/security/db-approver-context-cas.sql")
    cas_org = "7c100000-0000-4000-8000-0000000000a1"
    cas_emp = "7c100000-0000-4000-8000-000000000e01"
    cas_ticket = "7c100000-0000-4000-8000-000000000101"
    cas_sched = "7c100000-0000-4000-8000-000000000201"
    query(f"insert into public.orgs(id, name, scheduling_policy) values ('{cas_org}', 'context-cas-race', '{{\"rules\":[{{\"id\":\"r1\",\"costCapJpy\":5000}}]}}');"
          f"insert into public.employees(id, org_id, display_name, role_label, scopes, approval_policy) values ('{cas_emp}', '{cas_org}', 'E', 'r', '{{commerce:order}}', 'always_human');"
          f"insert into public.approval_requests(id, org_id, purpose, summary, risk, status, tool, required_approver_kind, approver_authority, metadata) values"
          f" ('{cas_ticket}', '{cas_org}', 'admin.policy', 'race', 'high', 'approved', 'policy.patch', 'owner', '{{\"contextFingerprint\":\"fp\"}}',"
          f"  '{{\"adminTool\":\"policy.patch\",\"adminMutation\":{{\"employeeId\":\"{cas_emp}\"}}}}'),"
          f" ('{cas_sched}', '{cas_org}', 'admin.policy', 'race', 'high', 'approved', 'schedulingPolicy.patch', 'owner', '{{\"contextFingerprint\":\"fp\"}}',"
          f"  '{{\"adminTool\":\"schedulingPolicy.patch\",\"adminMutation\":{{}}}}');")
    snap = query(f"select jsonb_build_object('scopes', to_jsonb(scopes), 'allowed_purposes', to_jsonb(allowed_purposes), 'approval_policy', to_jsonb(approval_policy), 'action_limits', action_limits,"
                 f" 'tool_approval_defaults', tool_approval_defaults)::text from public.employees where id='{cas_emp}';")
    command = (f"set role service_role; select public.approver_cas_write_employee_policy('{cas_org}','{cas_emp}','{cas_ticket}','fp','{snap}'::jsonb,"
               f"'{{mail:draft}}','{{}}','risk_based',null,'ok','{{}}')->>'reason';")
    with ThreadPoolExecutor(max_workers=12) as pool:
        reasons = list(pool.map(query, [command]*12))
    assert reasons.count("") == 1 and reasons.count("approver_context_changed") == 11, reasons
    org_snap = query(f"select jsonb_build_object('org', scheduling_policy)::text from public.orgs where id='{cas_org}';")
    command = (f"set role service_role; select public.approver_cas_write_scheduling_policy('{cas_org}',null,'{cas_sched}','fp','{org_snap}'::jsonb,"
               f"'org',jsonb_build_object('rules', jsonb_build_array(jsonb_build_object('id','r1','costCapJpy',9000))))->>'reason';")
    with ThreadPoolExecutor(max_workers=12) as pool:
        reasons = list(pool.map(query, [command]*12))
    assert reasons.count("") == 1 and reasons.count("approver_context_changed") == 11, reasons
    query(f"delete from public.approval_requests where org_id='{cas_org}'; delete from public.orgs where id='{cas_org}';")
    sql(ROOT / "supabase/verification/20261010100000_approver_context_cas_rollback.sql")
    assert query("select to_regprocedure('public.approver_cas_write_employee_policy(uuid,uuid,uuid,text,jsonb,text[],text[],text,jsonb,text,jsonb)') is null"
                 " and to_regprocedure('public.approver_cas_write_scheduling_policy(uuid,uuid,uuid,text,jsonb,text,jsonb)') is null"
                 " and to_regprocedure('public.approver_authority_check(uuid,uuid,text,text[])') is not null;") == "t"
    sql(context_cas)  # forward again after rollback
    sql(ROOT / "tests/security/db-approver-context-cas.sql")
    print("PASS: approver authority (PR-D): owner / designated admin decision table; flag-OFF 7-argument W1 call unchanged; standard ticket → designated admin stored, others refused; owner ticket → designated admin endorsed once and kept pending, owner approves and is stored; zero owners stop; multiple owners: any one owner other than the requester (requesting owner refused; a sole owner's own approval counts; several owners all requesters → no_owner_other_than_requester); reject / non-target not gated; record_approver_authority verified/endorse; one RPC overload; EXECUTE service_role only; rollback restores the 7-argument RPC + re-apply.")
    print("PASS: approver context CAS (TOCTOU follow-up): policy.patch / schedulingPolicy.patch writes only when the locked row still equals the pinned snapshot; concurrent change between check and write → approver_context_changed with nothing written (employee row, active and revoked credentials, org / employee scheduling policy); ticket binding (fingerprint, missing fingerprint, status, tool, target, org) refused; invalid input refused; EXECUTE service_role only; 12 concurrent writers with one snapshot → exactly 1 write (both RPCs); rollback drops both RPCs (PR-D untouched) + re-apply.")
    print("PASS: employee_webhook_settings (D9): RLS on, no policy, anon/authenticated denied, service_role reads/writes/upserts; cross-org row rejected; payload mode minimal|legacy_full (default minimal); ciphertext-only secret + fingerprint pair; employee delete cascades; rollback + re-apply.")
    print("PASS: channel_classify_proposals / channel_stuck_notice_windows (PR-B): RLS on, anon/authenticated denied (tables + 4 RPCs); org_channels accepts telegram; claim states claimed/in_flight/pending/decided, facts change reopens, other org isolated; attach same-org only; release unattached only; notice window once then suppressed; bad input denied; org delete cascades; 12 concurrent claims → exactly 1 claimed; rollback (2 tables + 4 RPCs + telegram surface) + re-apply.")
    print("PASS: channel_classify_budget_windows (PR-B follow-up H1): RLS on, no policy, anon/authenticated denied (table + RPC); allowed up to max → over_first once → over; per org / per key independent; expired window resets; bad input denied; org delete cascades; 20 concurrent takes (max 5) → exactly 5 allowed + 1 over_first; rollback (table + RPC, PR-B tables untouched) + re-apply.")
    print("PASS: thread_send_leases / thread_self_posts (thread single-flight): RLS on, no policy, anon/authenticated denied (2 tables + 3 RPCs); acquire → busy (retry_after) → expired lease taken over; release by holder only (old holder cannot release a re-taken lease); other org's lease on the same key independent, other org cannot release, other org's employee denied; self posts only move forward, no cross-org rows; bad input denied; org delete cascades; 12 concurrent acquires → exactly 1 acquired; rollback (2 tables + 3 RPCs, dedup ledger untouched) + re-apply.")
    print("PASS: close_approval_without_send / job_first_micros (thread single-flight pre-flag fixes, 20261009150000): close writes status + resolved_at + closedWithoutSend in one statement (other metadata kept), only from the listed statuses, other org → null untouched, bad input refused, an injected failure leaves no partial state, 12 concurrent closes → exactly 1; same job re-enters its held lease within 10 min of its first post (after that / different job / other employee / no job key → busy); record keeps the job's first-post anchor, a different job / no job key re-anchors; wake read point recorded per org × employee × thread, forward-only, other org's employee / bad input refused; anon/authenticated denied (RPCs + thread_wake_points); rollback (RPCs + columns + wake table, #286 intact) + re-apply.")
    print("PASS: orgs / subscriptions / audit_events / approval_requests have no anon/authenticated write path (member/admin/owner JWT denied); service_role writes all four. Full-history check: scripts/test-db-all-migrations.py.")
    print("PASS: 14 tenant config / credential tables (credentials, employees, bindings, admin agents, directory, adapters, channels, projects, card setup/audit) + gateway_links, agentmail_inboxes, lp_handoffs, lp_wake_webhook_configs, lp_wake_webhook_events have no anon/authenticated write path; other reads unchanged; credentials (rows and secret_hash) unreadable from any session; service_role reads/writes all.")
    print("PASS: lp_inquiries / notification_outbox have no anon/authenticated write grant; lp_handoffs / lp_wake_* have no policy (RLS on) and no anon/authenticated SELECT; sessions read/write none of the 5 LP tables; service_role (BYPASSRLS) reads/writes all.")
    print("PASS: mcp_event_subscriptions / mcp_event_deliveries: RLS on, no policy, anon/authenticated denied (rows and secret_ciphertext), service_role reads/writes; cross-org subscription / delivery rejected; one delivery per (subscription, event); 256 KiB body cap; id / event / status / https / ciphertext / lastError-category checks; org delete cascades; D11 verification budget: 30/host/minute window, hosts and windows independent, bad input rejected, anon/authenticated denied (table + function), 40 concurrent takes → exactly 30 accepted; rollback (3 tables + 2 functions) + re-apply.")
    print("PASS: org_members has no authenticated write path; last active owner cannot be demoted/disabled/deleted; org cascade still works.")
    print(f"PASS: F8 parent state={args.f8_parent_state}; 3 explicit UNIQUE constraints; existing constraint/index OIDs preserved across apply/reapply.")
    print("PASS: #80 ACL/authority/metadata regressions; 12 claims and 12 secret readers each have 1 winner. F8 W1, multi-stage/finalGo, rejection, current voter/binding, self-approval, same-org FKs, direct access denial, atomic rollback and recovery pass. 12 duplicate votes count once; 2 concurrent voters advance once. All migrations reapplied.")

finally:
    if started:
        run([BIN / "pg_ctl", "-D", cluster / "data", "-m", "fast", "-w", "stop"], stdout=subprocess.DEVNULL)
    # Only this script's newly-created fixture directory is removed.
    shutil.rmtree(cluster)

"""Disposable PostgreSQL test cluster. Never reads PG*/DATABASE_URL or .env.
Uses a newly created directory and Unix socket only; no existing DB is touched.
"""
import os
from pathlib import Path
import subprocess
import tempfile
import shutil
import argparse

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

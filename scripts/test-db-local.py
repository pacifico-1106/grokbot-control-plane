"""Disposable PostgreSQL test cluster. Never reads PG*/DATABASE_URL or .env.
Uses a newly created directory and Unix socket only; no existing DB is touched.
"""
import os
from pathlib import Path
import subprocess
import tempfile
import shutil

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
    sql(ROOT / "tests/security/db-execution.sql")
    sql(migration)  # ACL/functions/table expansion must be re-applicable.
    sql(workflow_migration)
    from concurrent.futures import ThreadPoolExecutor
    def query(command):
        result = run([BIN / "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-h", cluster,
            "-p", "55439", "-U", "test_admin", "-d", "postgres", "-c", command], capture_output=True, text=True)
        return result.stdout.strip()
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
    print("PASS: PostgreSQL 16 role ACLs, tenant/requester/generation/status denials, stale metadata, no lease reclaim; 12 concurrent claims = 1 winner; 12 secret readers = 1 winner; #80 and F8 migrations applied and reapplied. F8 vote concurrency/ACL behavior is not covered.")

finally:
    if started:
        run([BIN / "pg_ctl", "-D", cluster / "data", "-m", "fast", "-w", "stop"], stdout=subprocess.DEVNULL)
    # Only this script's newly-created fixture directory is removed.
    shutil.rmtree(cluster)

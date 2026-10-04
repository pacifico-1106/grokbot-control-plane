"""Disposable PostgreSQL: apply schema.sql + EVERY migration, then prove the
RLS write holes on orgs / subscriptions / audit_events / approval_requests
are closed (tests/security/db-rls-write-holes.sql), that the migration is
re-applicable, and that its documented rollback block restores the previous
state exactly (and is then re-closed).

Never reads PG*/DATABASE_URL or .env. Uses a newly created directory and a
Unix socket only (no TCP listener); no existing DB is touched. The server is
stopped and its PID verified gone; the directory is deleted.
"""
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "supabase" / "migrations"
CANDIDATE_BINS = [os.environ.get("PG_TEST_BIN", ""), "/opt/homebrew/opt/postgresql@16/bin",
                  "/usr/lib/postgresql/17/bin", "/usr/lib/postgresql/16/bin"]
BIN = next(Path(p) for p in CANDIDATE_BINS if p and (Path(p) / "initdb").exists())
env = {key: os.environ[key] for key in ("PATH", "TMPDIR", "LANG") if key in os.environ}
env.update({"LC_ALL": "C", "PGCONNECT_TIMEOUT": "5", "PGOPTIONS": "-c client_min_messages=warning"})
PORT = "55438"
RLS_FIX_PREFIX = "20261004500000_"
FOUR = ("orgs", "subscriptions", "audit_events", "approval_requests")
FOUR_POLICIES = ("approvals_write_member", "audit_insert_member", "orgs_update_admin", "subscriptions_write_admin")

# Un-timestamped legacy names do not sort in dependency order (see
# scripts/test-db-local.py); everything after this list sorts correctly.
LEGACY_ORDER = [
    "20260823_production_ready.sql", "20260823_referral_code.sql", "20260823_agentmail_reservation.sql",
    "20260824_approval_loop.sql", "20260826_telegram_revision.sql", "20260827_sod_action_limits.sql",
    "20260827_tenant_notification_channels.sql", "20260827_cross_product_commerce_events.sql",
    "20260828_audience_egress.sql", "20260828_employee_voice.sql", "20260828_project_scope.sql",
    "20260828_slack_notify_post.sql", "20260828_slack_posting_identity.sql", "20260830_slack_mention_ingress.sql",
    "20260830_sod_warn_policy.sql", "20260830_tool_approval_defaults.sql", "20260830_tool_approval_money_destructive.sql",
    "20260831_per_employee_approval_inbox.sql", "20260831_sns_publish.sql", "20260903_admin_mcp.sql",
    "20260903_slack_internal_im_ingress.sql", "20260906_employee_ingress_handoff.sql",
    "20260906_ingress_handoff_policy.sql", "20260907_scheduling_policy.sql", "20260908_reply_policy.sql",
    "20260914_internal_audience_rule.sql", "20260914_expired_trial_status.sql", "20260915_mail_policy.sql",
    "20260915_stuck_watch_policy.sql", "20260916000000_approval_execution_security.sql",
    "20260916_approval_workflow.sql", "20260916120000_f8_enforcement.sql",
]
# Migrations on main that cannot apply as written. Each must still fail with
# this message (applied in a single transaction, so nothing partial remains);
# if one starts applying, remove it here.
KNOWN_BROKEN = {
    "20260930000200_decision_workflow.sql": 'relation "members" does not exist',
}

cluster = Path(tempfile.mkdtemp(prefix="staffpass-allmig-"))
started = False


def run(args, **kwargs):
    return subprocess.run([str(x) for x in args], env=env, check=True, **kwargs)


def psql_args(extra):
    return [BIN / "psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-h", cluster, "-p", PORT,
            "-U", "test_admin", "-d", "postgres", *extra]


def sql_file(path, single=False, expect_error=None):
    extra = (["--single-transaction"] if single else []) + ["-f", path]
    result = subprocess.run([str(x) for x in psql_args(extra)], env=env, capture_output=True, text=True)
    if expect_error is None:
        if result.returncode != 0:
            sys.stderr.write(result.stderr)
            raise SystemExit(f"FAIL applying {Path(path).name}")
        return result
    if result.returncode == 0:
        raise SystemExit(f"FAIL {Path(path).name} applied but was expected to fail ({expect_error}); update KNOWN_BROKEN")
    if expect_error not in result.stderr:
        sys.stderr.write(result.stderr)
        raise SystemExit(f"FAIL {Path(path).name} failed differently than expected")
    return result


def sql_text(text, single=True):
    result = subprocess.run([str(x) for x in psql_args((["--single-transaction"] if single else []) + ["-f", "-"])],
                            env=env, input=text, capture_output=True, text=True)
    if result.returncode != 0:
        sys.stderr.write(result.stderr)
        raise SystemExit("FAIL applying inline SQL")


def query(command):
    result = run(psql_args(["-At", "-F", "|", "-c", command]), capture_output=True, text=True)
    return result.stdout.strip()


def migration_order():
    names = sorted(p.name for p in MIGRATIONS.glob("*.sql"))
    order = LEGACY_ORDER + [n for n in names if n not in LEGACY_ORDER]
    assert sorted(order) == names and len(set(order)) == len(order), "every migration must be applied exactly once"
    return order


def rollback_block(text):
    m = re.search(r"^-- ROLLBACK \(down\).*?$(.*?)^-- END ROLLBACK", text, re.S | re.M)
    assert m, "migration has no '-- ROLLBACK (down)' ... '-- END ROLLBACK' block"
    lines = [ln for ln in m.group(1).splitlines() if ln.startswith("--   ")]
    return "\n".join(ln[5:] for ln in lines) + "\n"


def report_other_tables():
    rows = query(f"""select tablename, policyname, cmd, permissive, roles::text, coalesce(qual,'-'), coalesce(with_check,'-')
        from pg_policies where schemaname='public' and cmd <> 'SELECT'
          and tablename not in ({','.join(repr(t) for t in FOUR)}) order by 1,2;""")
    print("REPORT non-SELECT policies on other tables (table|policy|cmd|permissive|roles|using|with_check):")
    for row in rows.splitlines():
        print("REPORT   " + row)
    rows = query("""select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='public' and c.relkind in ('r','p') and not c.relrowsecurity
          and (has_table_privilege('anon', c.oid, 'INSERT,UPDATE,DELETE') or has_table_privilege('authenticated', c.oid, 'INSERT,UPDATE,DELETE'))
        order by 1;""")
    print("REPORT tables without RLS that anon/authenticated can write: " + (", ".join(rows.splitlines()) or "none"))


def assert_holes_state(open_):
    policies = query(f"""select count(*) from pg_policies where schemaname='public'
        and policyname in ({','.join(repr(p) for p in FOUR_POLICIES)});""")
    privs = query("""select count(*) from unnest(array['anon','authenticated']) r,
        unnest(array['public.orgs','public.subscriptions','public.audit_events','public.approval_requests']) t,
        unnest(array['INSERT','UPDATE','DELETE','TRUNCATE']) p where has_table_privilege(r, t, p);""")
    expected = ("4", "32") if open_ else ("0", "0")
    assert (policies, privs) == expected, f"policies={policies} privileges={privs}, expected {expected}"


try:
    run([BIN / "initdb", "-D", cluster / "data", "-U", "test_admin", "--auth=trust", "--no-locale"], stdout=subprocess.DEVNULL)
    run([BIN / "pg_ctl", "-D", cluster / "data", "-l", cluster / "server.log",
         "-o", f"-F -c listen_addresses='' -k {cluster} -p {PORT}", "-w", "start"], stdout=subprocess.DEVNULL)
    started = True
    pid = int((cluster / "data" / "postmaster.pid").read_text().splitlines()[0])
    print(f"local postgres {query('show server_version')} pid={pid} (unix socket only, throwaway dir)")
    sql_file(ROOT / "tests/security/db-bootstrap.sql")
    sql_file(ROOT / "supabase/schema.sql")
    order = migration_order()
    fix = next((n for n in order if n.startswith(RLS_FIX_PREFIX)), None)
    for name in order:
        if name in KNOWN_BROKEN:
            sql_file(MIGRATIONS / name, single=True, expect_error=KNOWN_BROKEN[name])
            print(f"NOTE {name}: not applicable on main as written ({KNOWN_BROKEN[name]}); rolled back, skipped")
        else:
            sql_file(MIGRATIONS / name)
    print(f"PASS applied schema.sql + {len(order) - len(KNOWN_BROKEN)}/{len(order)} migrations in order (last: {order[-1]})")
    report_other_tables()

    sql_file(ROOT / "tests/security/db-rls-write-holes.sql")
    print("PASS authenticated (member/admin/owner JWT) and anon: INSERT/UPDATE/DELETE on orgs, subscriptions, audit_events, approval_requests denied; own-org reads intact; service_role writes all four.")
    assert fix, "RLS fix migration missing"
    assert_holes_state(open_=False)
    sql_file(MIGRATIONS / fix)
    sql_file(ROOT / "tests/security/db-rls-write-holes.sql")
    print(f"PASS {fix} re-applied (idempotent); checks still pass.")

    sql_text(rollback_block((MIGRATIONS / fix).read_text()))
    assert_holes_state(open_=True)
    sql_file(ROOT / "tests/security/db-rls-write-holes.sql", expect_error="session writes not blocked")
    print("PASS documented rollback restores the 4 policies + anon/authenticated write grants (holes reproducible again).")
    sql_file(MIGRATIONS / fix)
    assert_holes_state(open_=False)
    sql_file(ROOT / "tests/security/db-rls-write-holes.sql")
    print("PASS re-applied after rollback; checks pass again. Fixture rows cleaned up by the SQL file.")
finally:
    if started:
        run([BIN / "pg_ctl", "-D", cluster / "data", "-m", "fast", "-w", "stop"], stdout=subprocess.DEVNULL)
        try:
            os.kill(pid, 0)
            raise SystemExit(f"FAIL postgres pid {pid} still running")
        except ProcessLookupError:
            print(f"stopped local postgres pid={pid}")
    shutil.rmtree(cluster)
    print(f"removed {cluster}")

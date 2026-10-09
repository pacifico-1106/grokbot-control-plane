"""Disposable PostgreSQL: apply schema.sql + EVERY migration, then prove the
RLS write-hole fixes are closed:
  #258  20261004500000  orgs / subscriptions / audit_events / approval_requests
        (tests/security/db-rls-write-holes.sql)
  phase 2 20261004600000  14 tenant config / credential tables
        (tests/security/db-rls-write-holes-phase2.sql)
For each fix: its SQL test FAILS just before the fix migration is applied
(the open holes are recorded), passes after, the migration is re-applicable,
its documented rollback block reopens EXACTLY the recorded set (and nothing
of the other fix), and re-applying closes it again.

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
FIXES = [
    {
        "name": "#258",
        "prefix": "20261004500000_",
        "test": "tests/security/db-rls-write-holes.sql",
        "fixture": "a5000000-",
        "tables": ("orgs", "subscriptions", "audit_events", "approval_requests"),
        "policies": ("approvals_write_member", "audit_insert_member", "orgs_update_admin", "subscriptions_write_admin"),
        "reopened": 27,
    },
    {
        "name": "phase 2",
        "prefix": "20261004600000_",
        "test": "tests/security/db-rls-write-holes-phase2.sql",
        "fixture": "a6000000-",
        "tables": ("credentials", "org_admin_agents", "employees", "employee_bindings", "org_parties", "org_channels",
                   "information_assets", "org_notification_channels", "org_conversation_adapters", "org_sns_adapters",
                   "employee_slack_identities", "org_external_contract_payment_methods", "org_projects",
                   "audit_external_contract_card_events",
                   # formerly LOW
                   "gateway_links", "agentmail_inboxes", "lp_handoffs", "lp_wake_webhook_configs", "lp_wake_webhook_events"),
        "policies": ("credentials_write_admin", "org_admin_agents_write_admin", "employees_write_admin",
                     "bindings_write_admin", "org_parties_write_admin", "org_channels_write_admin",
                     "information_assets_write_admin", "notification_channels_write_admin",
                     "conversation_adapters_write_admin", "sns_adapters_write_admin",
                     "employee_slack_identities_write_admin", "org_ext_contract_pm_write_admin",
                     "org_projects_write_admin", "audit_ext_card_insert_member",
                     "gateway_write_admin", "agentmail_write_admin", "credentials_select"),
        # session SELECT on credentials is revoked too
        "extra_privs": (("public.credentials", "SELECT"),),
        # admin + owner x (insert, update, delete) x 15 FOR ALL tables (13 config + gateway_links +
        # agentmail_inboxes), member/admin/owner card-audit insert, admin + owner x 4 targeted
        # HIGH-table takeovers, member/admin/owner read credentials rows, member/admin/owner/anon
        # can select credentials.secret_hash
        "reopened": 2 * 3 * 15 + 3 + 2 * 4 + 3 + 4,
        # lp_* rows are not org-scoped; left over only if the SQL test aborts
        "cleanup": ("delete from public.lp_wake_webhook_events where id::text like 'a6300000-%';"
                    "delete from public.lp_wake_webhook_configs where id::text like 'a6300000-%';"
                    "delete from public.lp_handoffs where id::text like 'a6300000-%';"),
    },
    {
        "name": "lp server-only",
        "prefix": "20261004800000_",
        "test": "tests/security/db-lp-tables-server-only.sql",
        "fixture": "a8000000-",
        # write privileges revoked here; the lp_* tables lose their (redundant)
        # service-role-only policies and their session SELECT
        "tables": ("lp_inquiries", "notification_outbox"),
        "policies": ("lp_handoffs_service_all", "lp_wake_configs_service_all", "lp_wake_events_service_all"),
        "extra_privs": (("public.lp_handoffs", "SELECT"), ("public.lp_wake_webhook_configs", "SELECT"),
                        ("public.lp_wake_webhook_events", "SELECT")),
        # anon + authenticated x INSERT/UPDATE/DELETE/TRUNCATE x 2 tables (surface; RLS with no
        # policy already blocks the rows) + the 3 service-role-only policies + anon + authenticated
        # x SELECT x 3 lp_* tables (surface; no row was visible); 0 session writes / reads
        "reopened": 2 * 4 * 2 + 3 + 2 * 3,
        "unit": "surface findings (grants / policies; session writes and reads: 0)",
        "summary": ("anon/authenticated hold no write grant on lp_inquiries / notification_outbox and no SELECT on "
                    "lp_handoffs / lp_wake_webhook_configs / lp_wake_webhook_events; no policy on the 5 LP tables, "
                    "RLS on; sessions read/write nothing; service_role (BYPASSRLS) reads/writes all 5."),
        "cleanup": ("delete from public.lp_wake_webhook_events where id::text like 'a8000000-%';"
                    "delete from public.lp_wake_webhook_configs where id::text like 'a8000000-%';"
                    "delete from public.lp_handoffs where id::text like 'a8000000-%';"
                    "delete from public.notification_outbox where id::text like 'a8000000-%';"
                    "delete from public.lp_inquiries where id::text like 'a8000000-%';"),
    },
]
ALL_FIX_TABLES = tuple(t for f in FIXES for t in f["tables"])
# Additive migrations (new server-only tables): (filename prefix, SQL test, tables).
ADDITIVE = [
    ("20261005000000_", "tests/security/db-mcp-events.sql", ("mcp_event_subscriptions", "mcp_event_deliveries", "mcp_event_verification_windows")),
    ("20261005100000_", "tests/security/db-webhook-settings.sql", ("employee_webhook_settings",)),
    ("20261005200000_", "tests/security/db-channel-classify.sql", ("channel_classify_proposals", "channel_stuck_notice_windows")),
    ("20261005400000_", "tests/security/db-channel-classify-budget.sql", ("channel_classify_budget_windows",)),
    ("20261009100000_", "tests/security/db-thread-single-flight.sql", ("thread_send_leases", "thread_self_posts")),
]

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
          and tablename not in ({','.join(repr(t) for t in ALL_FIX_TABLES)}) order by 1,2;""")
    print("REPORT non-SELECT policies on other tables (table|policy|cmd|permissive|roles|using|with_check):")
    for row in rows.splitlines():
        print("REPORT   " + row)
    rows = query("""select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='public' and c.relkind in ('r','p') and not c.relrowsecurity
          and (has_table_privilege('anon', c.oid, 'INSERT,UPDATE,DELETE') or has_table_privilege('authenticated', c.oid, 'INSERT,UPDATE,DELETE'))
        order by 1;""")
    print("REPORT tables without RLS that anon/authenticated can write: " + (", ".join(rows.splitlines()) or "none"))


def privileges_sql(fix):
    """SQL counting anon/authenticated session privileges the fix removes."""
    writes = f"""select count(*) from unnest(array['anon','authenticated']) r,
        unnest(array[{','.join(repr('public.' + t) for t in fix["tables"])}]) t,
        unnest(array['INSERT','UPDATE','DELETE','TRUNCATE']) p where has_table_privilege(r, t, p)"""
    extra = " + ".join(f"(select count(*) from unnest(array['anon','authenticated']) r where has_table_privilege(r, '{t}', '{p}'))"
                       for t, p in fix.get("extra_privs", ()))
    return f"select ({writes})" + (f" + {extra}" if extra else "") + ";"


def assert_holes_state(fix, open_):
    policies = query(f"""select count(*) from pg_policies where schemaname='public'
        and policyname in ({','.join(repr(p) for p in fix["policies"])});""")
    privs = query(privileges_sql(fix))
    full = len(fix["tables"]) * 8 + 2 * len(fix.get("extra_privs", ()))
    expected = (str(len(fix["policies"])), str(full)) if open_ else ("0", "0")
    assert (policies, privs) == expected, f"{fix['name']}: policies={policies} privileges={privs}, expected {expected}"
    return policies, privs


def open_holes(fix):
    """Run the fix's SQL test expecting failure; return the exact set of open holes."""
    result = sql_file(ROOT / fix["test"], expect_error="session writes not blocked")
    m = re.search(r"session writes not blocked \((\d+) case\(s\)\):\n(.*?)\n(?:CONTEXT|psql)", result.stderr, re.S)
    assert m, result.stderr
    cases = sorted(m.group(2).splitlines())
    assert len(cases) == int(m.group(1)), (m.group(1), cases)
    query(fix.get("cleanup", "") + f"delete from public.orgs where id::text like '{fix['fixture']}%';")  # fixtures left by the expected failure
    return cases


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
    files = {f["name"]: next((n for n in order if n.startswith(f["prefix"])), None) for f in FIXES}
    before = {}
    for name in order:
        fix = next((f for f in FIXES if name == files[f["name"]]), None)
        if fix:
            # Production pre-state = the migrations' write policies + Supabase's
            # default anon/authenticated table grants. schema.sql (fresh installs)
            # already revokes them once the fix is in, so re-grant them here to
            # record what the fix closes on an existing database.
            tables = ", ".join("public." + t for t in fix["tables"])
            policies = query(f"""select count(*) from pg_policies where schemaname='public'
                and policyname in ({','.join(repr(p) for p in fix["policies"])});""")
            privs = query(privileges_sql(fix))
            full = len(fix["tables"]) * 8 + 2 * len(fix.get("extra_privs", ()))
            print(f"NOTE before {name}: {policies}/{len(fix['policies'])} policies present, {privs}/{full} "
                  "anon/authenticated grants (Supabase default grants re-applied for the pre-fix measurement)")
            query(f"grant insert, update, delete, truncate on {tables} to anon, authenticated;"
                  + "".join(f"grant {p.lower()} on {t} to anon, authenticated;" for t, p in fix.get("extra_privs", ())))
            assert_holes_state(fix, open_=True)
            before[fix["name"]] = open_holes(fix)
            print(f"PASS before {name}: {len(before[fix['name']])} {fix.get('unit', 'session writes allowed')} (expected {fix['reopened']}) — "
                  + ", ".join(sorted({c.split(' ', 1)[1].split(':')[0].rsplit(' ', 1)[0] for c in before[fix['name']]})))
            assert len(before[fix["name"]]) == fix["reopened"], before[fix["name"]]
        if name in KNOWN_BROKEN:
            sql_file(MIGRATIONS / name, single=True, expect_error=KNOWN_BROKEN[name])
            print(f"NOTE {name}: not applicable on main as written ({KNOWN_BROKEN[name]}); rolled back, skipped")
        else:
            sql_file(MIGRATIONS / name)
    print(f"PASS applied schema.sql + {len(order) - len(KNOWN_BROKEN)}/{len(order)} migrations in order (last: {order[-1]})")
    report_other_tables()

    for fix in FIXES:
        sql_file(ROOT / fix["test"])
        print(f"PASS {fix['name']}: " + (fix.get("summary") or (
              f"authenticated (member/admin/owner JWT) and anon: INSERT/UPDATE/DELETE denied on "
              f"{len(fix['tables'])} tables; reads intact"
              + ("; credentials unreadable (rows + secret_hash)" if fix.get("extra_privs") else "")
              + "; service_role reads/writes all.")))
    missing = [f["name"] for f in FIXES if not files[f["name"]]]
    assert not missing, f"RLS fix migration missing: {missing}"

    for fix in FIXES:
        name = files[fix["name"]]
        assert_holes_state(fix, open_=False)
        sql_file(MIGRATIONS / name)
        sql_file(ROOT / fix["test"])
        print(f"PASS {name} re-applied (idempotent); checks still pass.")
        sql_text(rollback_block((MIGRATIONS / name).read_text()), single=False)
        policies, privs = assert_holes_state(fix, open_=True)
        reopened = open_holes(fix)
        assert reopened == before[fix["name"]], "rollback reopened a different set:\n" + "\n".join(
            sorted(set(reopened) ^ set(before[fix["name"]])))
        for other in FIXES:
            if other is not fix:
                sql_file(ROOT / other["test"])  # rolling back one fix never reopens the other
        print(f"PASS {fix['name']} rollback restores {policies} policies + {privs} anon/authenticated grants; "
              f"{len(reopened)} {fix.get('unit', 'session writes allowed')} again = exactly the pre-fix set; other fixes still closed.")
        sql_file(MIGRATIONS / name)
        assert_holes_state(fix, open_=False)
        sql_file(ROOT / fix["test"])
        print(f"PASS {fix['name']} re-applied after rollback; checks pass again. Fixture rows cleaned up by the SQL file.")
    # Additive (create-table) migrations: SQL test after the full history,
    # re-apply, documented rollback block removes exactly their objects, re-apply.
    for prefix, test, tables in ADDITIVE:
        name = next((n for n in order if n.startswith(prefix)), None)
        assert name, f"additive migration missing: {prefix}"
        sql_file(ROOT / test)
        sql_file(MIGRATIONS / name)
        sql_file(ROOT / test)
        sql_text(rollback_block((MIGRATIONS / name).read_text()), single=False)
        gone = query("select " + " and ".join(f"to_regclass('public.{t}') is null" for t in tables) + ";")
        assert gone == "t", f"{name}: rollback left tables behind"
        for fix in FIXES:
            sql_file(ROOT / fix["test"])  # rolling back an additive migration never reopens a fix
        sql_file(MIGRATIONS / name)
        sql_file(ROOT / test)
        print(f"PASS {name}: {test} passes after the full history, re-applied, rollback drops {', '.join(tables)}, re-applied; fixes still closed.")
    # PR-D approver authority (columns + functions, replaces resolve_approval_w1_checked):
    # SQL test after the full history, re-apply, rollback restores the 7-argument
    # RPC and drops the columns, fixes still closed, re-apply.
    name = next((n for n in order if n.startswith("20261005500000_")), None)
    assert name, "approver authority migration missing"
    test = "tests/security/db-approver-authority.sql"
    sql_file(ROOT / test)
    sql_file(MIGRATIONS / name)
    sql_file(ROOT / test)
    sql_text(rollback_block((MIGRATIONS / name).read_text()), single=False)
    restored = query("select to_regprocedure('public.resolve_approval_w1_checked(uuid,uuid,uuid,text,text,text,text)') is not null"
                     " and to_regprocedure('public.resolve_approval_w1_checked(uuid,uuid,uuid,text,text,text,text,boolean)') is null"
                     " and to_regprocedure('public.record_approver_authority(uuid,uuid,uuid,text)') is null"
                     " and not exists (select 1 from information_schema.columns where table_schema='public'"
                     " and column_name in ('required_approver_kind','approver_member_id','approver_role','approver_authority','designated_admin_member_ids'));")
    assert restored == "t", f"{name}: rollback did not restore the previous RPC / drop the columns"
    for fix in FIXES:
        sql_file(ROOT / fix["test"])
    sql_file(MIGRATIONS / name)
    sql_file(ROOT / test)
    print(f"PASS {name}: {test} passes after the full history, re-applied, rollback restores the 7-argument resolve_approval_w1_checked and drops the PR-D columns/functions, re-applied; fixes still closed.")
    # TOCTOU follow-up (20261010100000, approval-executed policy writes as a
    # compare-and-swap): SQL test after the full history, re-apply, rollback
    # drops exactly the two RPCs (PR-D stays), fixes still closed, re-apply.
    name = next((n for n in order if n.startswith("20261010100000_")), None)
    assert name, "approver context CAS migration missing"
    test = "tests/security/db-approver-context-cas.sql"
    sql_file(ROOT / test)
    sql_file(MIGRATIONS / name)
    sql_file(ROOT / test)
    sql_text(rollback_block((MIGRATIONS / name).read_text()), single=False)
    gone = query("select to_regprocedure('public.approver_cas_write_employee_policy(uuid,uuid,uuid,text,jsonb,text[],text[],text,jsonb,text,jsonb)') is null"
                 " and to_regprocedure('public.approver_cas_write_scheduling_policy(uuid,uuid,uuid,text,jsonb,text,jsonb)') is null"
                 " and to_regprocedure('public.approver_authority_check(uuid,uuid,text,text[])') is not null;")
    assert gone == "t", f"{name}: rollback did not drop exactly the CAS RPCs"
    for fix in FIXES:
        sql_file(ROOT / fix["test"])
    sql_file(MIGRATIONS / name)
    sql_file(ROOT / test)
    print(f"PASS {name}: {test} passes after the full history, re-applied, rollback drops the two CAS RPCs (PR-D untouched), re-applied; fixes still closed.")
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

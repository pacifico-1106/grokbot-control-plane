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
    # LP lead page / ref (20261012300000): additive nullable columns + CHECK; no grant change.
    sql(ROOT / "supabase/migrations/20261001300000_lp_journeys_chat.sql")  # lp_journeys not in schema.sql
    lead_page = ROOT / "supabase/migrations/20261012300000_lp_lead_page.sql"
    sql(lead_page)
    sql(lead_page)  # re-applicable
    sql(ROOT / "tests/security/db-lp-lead-page.sql")
    sql(ROOT / "tests/security/db-lp-tables-server-only.sql")  # LP tables still server-only
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
    # #315 follow-up (20261010300000): oauth_rate_limit_hit search_path = pg_catalog, public.
    oauth_sp = ROOT / "supabase/migrations/20261010300000_mcp_oauth_rate_limit_search_path.sql"
    sp_cfg = "select proconfig::text from pg_proc where oid = 'public.oauth_rate_limit_hit(text,timestamptz)'::regprocedure;"
    assert query(sp_cfg) == "{search_path=public}", query(sp_cfg)  # 20261010200000 alone
    sql(oauth_sp)
    sql(oauth_sp)  # re-applicable
    sql(ROOT / "tests/security/db-mcp-oauth-search-path.sql")
    sql(ROOT / "tests/security/db-mcp-oauth.sql")
    sql(ROOT / "supabase/verification/20261010300000_mcp_oauth_rate_limit_search_path_rollback.sql")
    assert query(sp_cfg) == "{search_path=public}", query(sp_cfg)
    sql(ROOT / "tests/security/db-mcp-oauth.sql")
    sql(oauth_sp)  # forward again after rollback
    sql(ROOT / "tests/security/db-mcp-oauth-search-path.sql")
    print("PASS: mcp oauth search_path (20261010300000): oauth_rate_limit_hit SECURITY DEFINER with search_path = pg_catalog, public; "
          "EXECUTE service_role only; counter unchanged; re-applicable; rollback restores search_path = public; forward again.")
    print("PASS: mcp oauth (20261010200000): 7 tables RLS on / no policy, anon/authenticated hold no privilege and cannot execute "
          "oauth_rate_limit_hit; cross-org grant (employee / credential / member) rejected; atomic rate-limit counter; "
          "re-applicable; rollback drops all 7 tables + 2 functions; forward again.")
    # 社員証 pre-expiry notice dedup (20261012100000, CREDENTIAL_EXPIRY_NOTICE_ENABLED).
    expiry_notices = ROOT / "supabase/migrations/20261012100000_credential_expiry_notices.sql"
    sql(expiry_notices)
    sql(expiry_notices)  # re-applicable
    sql(ROOT / "tests/security/db-credential-expiry-notices.sql")
    sql(ROOT / "supabase/verification/20261012100000_credential_expiry_notices_rollback.sql")
    assert query("select to_regclass('public.credential_expiry_notices') is null"
                 " and to_regprocedure('public.credential_expiry_notices_same_org()') is null"
                 " and to_regclass('public.credentials') is not null;") == "t"
    sql(expiry_notices)  # forward again after rollback
    sql(ROOT / "tests/security/db-credential-expiry-notices.sql")
    print("PASS: credential expiry notices (20261012100000): RLS on / no policy, anon/authenticated hold no privilege; "
          "one row per credential × threshold (unique); threshold 7d/1d only; org / employee must be the credential's own "
          "(insert + update); credential delete cascades; re-applicable; rollback drops table + trigger fn; forward again.")
    # 社員証 reissue pickup claim (20261012200000, ADMIN_MCP_CREDENTIAL_REISSUE_ENABLED).
    reissue_claim = ROOT / "supabase/migrations/20261012200000_credential_reissue_claim.sql"
    sql(reissue_claim)
    sql(reissue_claim)  # re-applicable
    sql(ROOT / "tests/security/db-credential-reissue-claim.sql")
    from concurrent.futures import ThreadPoolExecutor as _Pool
    rc_org, rc_ticket = "c7000000-0000-4000-8000-0000000000c1", "c7100000-0000-4000-8000-0000000000c1"
    query(f"insert into public.orgs(id, name) values ('{rc_org}', 'crc concurrent');"
          f"insert into public.approval_requests(id, org_id, purpose, summary, tool, risk, status, metadata) values "
          f"('{rc_ticket}', '{rc_org}', 'admin.policy', 'crc', 'employees.credential.reissue', 'high', 'approved',"
          f" '{{\"adminTool\":\"employees.credential.reissue\"}}');")
    commands = [f"set role service_role; select public.claim_credential_reissue('{rc_ticket}','{rc_org}','tok_concurrent_{i:02d}_0123456789','m{i}',now());"
                for i in range(12)]
    with _Pool(max_workers=12) as pool:
        claims = list(pool.map(query, commands))
    assert claims.count("t") == 1 and claims.count("f") == 11, claims
    winner = query(f"select metadata->'credentialReissue'->>'claimToken' from public.approval_requests where id = '{rc_ticket}';")
    assert winner == f"tok_concurrent_{claims.index('t'):02d}_0123456789", (winner, claims)
    query(f"delete from public.approval_requests where id = '{rc_ticket}'; delete from public.orgs where id = '{rc_org}';")
    sql(ROOT / "supabase/verification/20261012200000_credential_reissue_claim_rollback.sql")
    assert query("select to_regprocedure('public.claim_credential_reissue(uuid,uuid,text,text,timestamptz)') is null"
                 " and to_regprocedure('public.release_credential_reissue(uuid,uuid,text)') is null;") == "t"
    sql(reissue_claim)  # forward again after rollback
    sql(ROOT / "tests/security/db-credential-reissue-claim.sql")
    print("PASS: credential reissue claim (20261012200000): EXECUTE service_role only; 12 concurrent claims → exactly 1 winner "
          "(its token is the mark); release only with the claimer's own token and org; other org / other tool / pending refused; "
          "re-claim after own release; re-applicable; rollback drops both functions; forward again.")
    # LP setup-fee payment record (20261012400000, LP_AUTO_PROVISION_MODE=dry_run).
    lp_prov = ROOT / "supabase/migrations/20261012400000_lp_provisionings.sql"
    sql(lp_prov)
    sql(lp_prov)  # re-applicable
    sql(ROOT / "tests/security/db-lp-provisionings.sql")
    from concurrent.futures import ThreadPoolExecutor as _LpPool
    lp_sess = "cs_test_lpconcurrent1"
    query("set role service_role; insert into public.lp_provisionings (stripe_checkout_session_id, first_stripe_event_id, livemode,"
          f" amount_total, currency, plan, lp_page) values ('{lp_sess}', 'evt_lpconcurrent1', false, 165000, 'jpy', 'proper', 'ai-employee');")
    commands = [f"set role service_role; select public.claim_lp_provisioning_notice('{lp_sess}','tok_lpconc_{i:02d}_0123456789',600);"
                for i in range(12)]
    with _LpPool(max_workers=12) as pool:
        lp_claims = list(pool.map(query, commands))
    assert lp_claims.count("t") == 1 and lp_claims.count("f") == 11, lp_claims
    query(f"delete from public.lp_provisionings where stripe_checkout_session_id = '{lp_sess}';")
    sql(ROOT / "supabase/verification/20261012400000_lp_provisionings_rollback.sql")
    assert query("select to_regclass('public.lp_provisionings') is null and to_regclass('public.lp_provisioning_events') is null"
                 " and to_regprocedure('public.claim_lp_provisioning_notice(text,text,integer)') is null"
                 " and to_regprocedure('public.finish_lp_provisioning_notice(text,text,text)') is null;") == "t"
    sql(lp_prov)  # forward again after rollback
    sql(ROOT / "tests/security/db-lp-provisionings.sql")
    print("PASS: lp provisionings (20261012400000): RLS on / no policy, anon/authenticated no privilege, notice fns service_role only; "
          "one event row per Stripe event id, one payment row per Checkout Session; value CHECKs (allowlist / regex / '(invalid)' marker, "
          "keyed HMAC hex only); 12 concurrent notice claims → 1; finish/release with own token only; no re-notice after sent; stale takeover; "
          "re-applicable; rollback drops 2 tables + 2 functions; forward again.")
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
    skipped_wakes = ROOT / "supabase/migrations/20261009700000_slack_skipped_channel_wakes.sql"
    sql(skipped_wakes)
    sql(skipped_wakes)  # re-applicable
    sql(ROOT / "tests/security/db-slack-skipped-wakes.sql")
    ssw_org = "c9000000-0000-4000-8000-0000000000c1"
    ssw_emp = "c9200000-0000-4000-8000-0000000000c1"
    ssw_approval = "c9100000-0000-4000-8000-0000000000c1"
    query(f"insert into public.orgs(id, name) values ('{ssw_org}', 'skipped-wakes-race');"
          f"insert into public.employees(id, org_id, display_name, role_label) values ('{ssw_emp}', '{ssw_org}', 'race', 'race');"
          f"insert into public.approval_requests(id, org_id, purpose, summary, risk, status, tool, metadata) values ('{ssw_approval}', '{ssw_org}', 'admin.channel', 'race', 'high', 'approved', 'channels.classify',"
          f" '{{\"adminMutation\":{{\"surface\":\"slack\",\"externalId\":\"C0SSWRACE1\"}}}}');")
    query(f"set role service_role; select public.record_slack_skipped_channel_wake('{ssw_org}', '{ssw_emp}', 'C0SSWRACE1', '1788100001.000001', null, 'EvRace', 'U0SPEAK1', 'T0TEAM1', 'U0SUB1', 'T0TEAM1');")
    command = (f"set role service_role; select jsonb_array_length(public.claim_slack_skipped_channel_wakes("
               f"'{ssw_org}', 'C0SSWRACE1', '{ssw_approval}', 3600)->'rows');")
    with ThreadPoolExecutor(max_workers=12) as pool:
        claims = list(pool.map(query, [command]*12))
    assert claims.count("1") == 1 and claims.count("0") == 11, claims
    query(f"delete from public.orgs where id='{ssw_org}';")
    sql(ROOT / "supabase/verification/20261009700000_slack_skipped_channel_wakes_rollback.sql")
    assert query("select to_regclass('public.slack_skipped_channel_wakes') is null"
                 " and to_regprocedure('public.claim_slack_skipped_channel_wakes(uuid,text,uuid,integer)') is null"
                 " and to_regprocedure('public.record_slack_skipped_channel_wake(uuid,uuid,text,text,text,text,text,text,text,text)') is null"
                 " and to_regclass('public.channel_classify_proposals') is not null;") == "t"
    sql(skipped_wakes)  # forward again after rollback
    sql(ROOT / "tests/security/db-slack-skipped-wakes.sql")
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
    # 緊急停止 hold (20261012500000, S1; after PR-D: uses orgs.designated_admin_member_ids). Checks read hold_state regardless of flags (S2).
    holds = ROOT / "supabase/migrations/20261012500000_employee_holds.sql"
    sql(holds)
    sql(holds)  # re-applicable
    sql(ROOT / "tests/security/db-employee-holds.sql")
    eh_org, eh_emp = "e5000000-0000-4000-8000-0000000000c1", "e5100000-0000-4000-8000-0000000000c1"
    eh_req, eh_appr, eh_ticket = ("e5300000-0000-4000-8000-0000000000c1", "e5300000-0000-4000-8000-0000000000c2",
                                  "e5200000-0000-4000-8000-0000000000c9")
    query(f"insert into public.orgs(id, name) values ('{eh_org}', 'eh concurrent');"
          f"insert into public.org_members(id, org_id, email, role, status) values ('{eh_req}', '{eh_org}', 'eh-c1@eh.invalid', 'owner', 'active'),"
          f" ('{eh_appr}', '{eh_org}', 'eh-c2@eh.invalid', 'owner', 'active');"
          f"insert into public.employees(id, org_id, display_name, role_label) values ('{eh_emp}', '{eh_org}', 'eh c', 'r');")
    starts = [f"set role service_role; select public.start_employee_hold('{eh_org}','{eh_emp}','stopped',null,"
              f"'member:{eh_req}','web',null,now())->>'created';" for _ in range(12)]
    with ThreadPoolExecutor(max_workers=12) as pool:
        created = list(pool.map(query, starts))
    assert created.count("true") == 1 and created.count("false") == 11, created
    assert query(f"select count(*) from public.employee_holds where employee_id = '{eh_emp}';") == "1"
    hid = query(f"select hold_id from public.employees where id = '{eh_emp}';")
    query(f"insert into public.approval_requests(id, org_id, purpose, summary, tool, risk, status, metadata) values "
          f"('{eh_ticket}', '{eh_org}', 'admin.policy', 'eh', 'employee.hold.release', 'high', 'pending', '{{\"holdId\":\"{hid}\",\"requestedBy\":\"member:{eh_req}\"}}');"
          f"set role service_role; select public.request_employee_hold_release('{eh_org}','{hid}','member:{eh_req}','r','{eh_ticket}',now());"
          f"reset role; update public.approval_requests set status='approved', resolved_by='{eh_appr}', resolved_at=now() where id='{eh_ticket}';")
    releases = [f"set role service_role; select public.release_employee_hold('{eh_org}','{hid}','eh','{{}}'::jsonb,now())->>'released';"
                for _ in range(12)]
    def _try(cmd):
        try:
            return query(cmd) or "refused"
        except Exception:  # psql exits non-zero for the 11 losers (hold_not_found after the winner commits)
            return "refused"
    with ThreadPoolExecutor(max_workers=12) as pool:
        released = list(pool.map(_try, releases))
    assert released.count("true") == 1 and released.count("refused") == 11, released
    assert query(f"select count(*) from public.audit_events where org_id = '{eh_org}' and action = 'employee.hold.released';") == "1"
    # 木村 10/12 (2nd): release of an approved leave hold racing a detector upgrade — 15 rounds, no
    # deadlock (lock order employee → hold in both), and the employee always ends up held.
    def _psql(cmd):
        p = subprocess.run([str(BIN / "psql"), "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-h", str(cluster), "-p", "55439",
                            "-U", "test_admin", "-d", "postgres", "-c", cmd], env=env, capture_output=True, text=True)
        return p.returncode, p.stdout.strip(), p.stderr
    deadlocks = 0
    # widen the window: the release's audit insert (between its first and second lock) sleeps 150 ms
    query("create or replace function security_test.eh_slow_audit() returns trigger language plpgsql as $$ begin perform pg_sleep(0.15); return new; end $$;"
          "create trigger eh_slow_audit before insert on public.audit_events for each row when (new.action = 'employee.hold.released') execute function security_test.eh_slow_audit();")
    for i in range(15):
        hid_l = query(f"set role service_role; select public.start_employee_hold('{eh_org}','{eh_emp}','leave',null,'member:{eh_req}','web',null,now())->>'holdId';").splitlines()[-1]
        tk = f"e5200000-0000-4000-8000-0000000{i:05d}"
        query(f"insert into public.approval_requests(id, org_id, purpose, summary, tool, risk, status, metadata) values "
              f"('{tk}', '{eh_org}', 'admin.policy', 'eh', 'employee.hold.release', 'high', 'pending', '{{\"holdId\":\"{hid_l}\",\"requestedBy\":\"member:{eh_req}\"}}');"
              f"set role service_role; select public.request_employee_hold_release('{eh_org}','{hid_l}','member:{eh_req}','r','{tk}',now());"
              f"reset role; update public.approval_requests set status='approved', resolved_by='{eh_appr}', resolved_at=now() where id='{tk}';")
        rel = f"set role service_role; select public.release_employee_hold('{eh_org}','{hid_l}','eh','{{}}'::jsonb,now())->>'released';"
        up = (f"set role service_role; select pg_sleep(0.03 + 0.02 * {i % 3}); select public.start_employee_hold('{eh_org}','{eh_emp}','quarantined',null,"
              f"'system:anomaly','anomaly','signal:race',now())->>'holdId';")
        with ThreadPoolExecutor(max_workers=2) as pool:
            res = list(pool.map(_psql, [rel, up]))
        deadlocks += sum(1 for rc, _, err in res if "deadlock detected" in err)
        assert res[1][0] == 0, ("detector stop failed", i, res[1][2])
        assert query(f"select hold_state from public.employees where id = '{eh_emp}';") == "quarantined", (i, res)
        # reset for the next round: clear the employee (test-only, triggers off)
        for _stmt in ("alter table public.employees disable trigger employees_hold_guard;",
                      f"update public.employees set hold_state = null, hold_id = null where id = '{eh_emp}';",
                      "alter table public.employees enable trigger employees_hold_guard;",
                      "alter table public.employee_holds disable trigger employee_holds_guard;",
                      f"delete from public.employee_holds where employee_id = '{eh_emp}';",
                      "alter table public.employee_holds enable trigger employee_holds_guard;"):
            query(_stmt)
    query("drop trigger eh_slow_audit on public.audit_events; drop function security_test.eh_slow_audit();")
    assert deadlocks == 0, f"{deadlocks} deadlocks in 15 release × detector rounds"
    # 木村 10/12 09:01: when can a stop fail with 40001? The functions run at the caller's isolation
    # (PostgREST: READ COMMITTED). (a) READ COMMITTED: 40 concurrent mixed-kind starts on ONE employee
    # → every call succeeds (row-lock waits re-check, no 40001 / 40P01), strongest kind wins.
    # (b) If isolation were ever raised (REPEATABLE READ), the same burst raises 40001 — the app's
    # 5 attempts with jittered backoff (holdStartBackoffMs) must still land every stop.
    import random, time
    eh_emp2 = "e5100000-0000-4000-8000-0000000000c2"
    query(f"insert into public.employees(id, org_id, display_name, role_label) values ('{eh_emp2}', '{eh_org}', 'eh c2', 'r');")
    def _start_cmd(i, iso=None):
        kind, by, via, trig = [("leave", f"member:{eh_req}", "web", "null"), ("stopped", f"member:{eh_req}", "web", "null"),
                               ("quarantined", "system:anomaly", "anomaly", "'signal:burst'"), ("stopped", f"member:{eh_appr}", "slack", "null")][i % 4]
        call = (f"select public.start_employee_hold('{eh_org}','{eh_emp2}','{kind}',null,'{by}','{via}',{trig},now())->>'holdId';")
        if iso:
            return f"begin isolation level {iso}; set local role service_role; {call} commit;"
        return f"set role service_role; {call}"
    def _clear_emp2():
        for _stmt in ("alter table public.employees disable trigger employees_hold_guard;",
                      f"update public.employees set hold_state = null, hold_id = null where id = '{eh_emp2}';",
                      "alter table public.employees enable trigger employees_hold_guard;",
                      "alter table public.employee_holds disable trigger employee_holds_guard;",
                      f"delete from public.employee_holds where employee_id = '{eh_emp2}';",
                      "alter table public.employee_holds enable trigger employee_holds_guard;"):
            query(_stmt)
    with ThreadPoolExecutor(max_workers=20) as pool:
        res = list(pool.map(_psql, [_start_cmd(i) for i in range(40)]))
    rc_errors = [err.strip().splitlines()[-1] for rc, _, err in res if rc != 0]
    assert rc_errors == [], rc_errors
    assert query(f"select hold_state from public.employees where id = '{eh_emp2}';") == "quarantined"
    assert query(f"select count(*) from public.employee_holds where employee_id = '{eh_emp2}' and released_at is null and superseded_at is null;") == "1"
    _clear_emp2()
    def _with_retry(cmd):
        first_40001 = False
        for attempt in range(1, 6):  # HOLD_START_MAX_ATTEMPTS = 5
            rc, out, err = _psql(cmd)
            if rc == 0:
                return attempt, first_40001
            code = "40001" if "could not serialize" in err else "40P01" if "deadlock detected" in err else None
            if attempt == 1 and code == "40001":
                first_40001 = True
            if code is None:
                return f"error: {err.strip()[-200:]}", first_40001
            base = [50, 100, 200, 400][min(attempt, 4) - 1]
            time.sleep((base / 2 + random.random() * base / 2) / 1000)
        return "exhausted", first_40001
    with ThreadPoolExecutor(max_workers=20) as pool:
        rr = list(pool.map(_with_retry, [_start_cmd(i, "repeatable read") for i in range(40)]))
    rr_first = sum(1 for _, f in rr if f)
    rr_fail = [a for a, _ in rr if not isinstance(a, int)]
    assert rr_fail == [], rr_fail
    assert query(f"select hold_state from public.employees where id = '{eh_emp2}';") == "quarantined"
    print(f"PASS: hold start concurrency (木村 10/12 09:01): READ COMMITTED 40 concurrent mixed starts → 0 errors; "
          f"REPEATABLE READ 40 concurrent → {rr_first} first-attempt 40001, all landed within 5 attempts "
          f"(max attempt used: {max(a for a, _ in rr)}).")
    _clear_emp2()
    query(f"delete from public.employees where id = '{eh_emp2}';")
    # 木村 10/12 (6): the rollback refuses while any employee is held — nothing changes
    query(f"set role service_role; select public.start_employee_hold('{eh_org}','{eh_emp}','stopped',null,'member:{eh_req}','web',null,now());")
    try:
        sql(ROOT / "supabase/verification/20261012500000_employee_holds_rollback.sql")
        raise AssertionError("employee holds rollback ran while an employee was held")
    except subprocess.CalledProcessError:
        pass
    assert query("select to_regclass('public.employee_holds') is not null and exists (select 1 from information_schema.columns"
                 " where table_schema = 'public' and table_name = 'employees' and column_name = 'hold_state');") == "t"
    # one statement per call: the deferrable superseded_by FK queues trigger events that ALTER TABLE refuses in one transaction
    for _stmt in ("alter table public.employee_holds disable trigger employee_holds_guard;"
          "alter table public.employees disable trigger employees_hold_guard;"
          f"update public.employees set hold_state = null, hold_id = null where id = '{eh_emp}';"
          f"delete from public.audit_events where org_id = '{eh_org}'; delete from public.employee_holds where org_id = '{eh_org}';"
          "alter table public.employee_holds enable trigger employee_holds_guard;"
          "alter table public.employees enable trigger employees_hold_guard;"
          f"delete from public.approval_requests where org_id = '{eh_org}'; delete from public.orgs where id = '{eh_org}';").split(";"):
        if _stmt.strip():
            query(_stmt + ";")
    sql(ROOT / "supabase/verification/20261012500000_employee_holds_rollback.sql")
    assert query("select to_regclass('public.employee_holds') is null"
                 " and to_regprocedure('public.start_employee_hold(uuid,uuid,text,text,text,text,text,timestamptz)') is null"
                 " and to_regprocedure('public.request_employee_hold_release(uuid,uuid,text,text,uuid,timestamptz)') is null"
                 " and to_regprocedure('public.release_employee_hold(uuid,uuid,text,jsonb,timestamptz)') is null"
                 " and not exists (select 1 from information_schema.columns where table_schema = 'public'"
                 " and table_name in ('employees', 'orgs') and column_name in ('hold_state', 'hold_id'));") == "t"
    sql(holds)  # forward again after rollback
    sql(ROOT / "tests/security/db-employee-holds.sql")
    print("PASS: employee holds (20261012500000): employee_holds RLS on / no policy, anon/authenticated no access and cannot execute; "
          "hold columns + history writable only through the 3 functions; append-only history; start refuses another org's employee, "
          "idempotent, holds pending / approved-unexecuted tickets only; release needs an approved employee.hold.release ticket "
          "from an active owner / designated admin of the same org ≠ requester (single-owner exception only with 1 eligible approver), "
          "audit row in the same transaction (audit failure → no release), held tickets closed_by_hold; ops holds not member-releasable; "
          "org hold 'stopped' only; 12 concurrent starts → 1 hold, 12 concurrent releases → 1 release + 1 audit row; "
          "re-applicable; rollback drops table, 3 functions, 4 columns; forward again.")
    # Hold-release actor_email (20261016300000): fill actor_email from org_members of resolved_by.
    hold_ae = ROOT / "supabase/migrations/20261016300000_hold_release_actor_email.sql"
    ae_marker = ("select position('actor_email_from_member' in pg_get_functiondef("
                 "'public.release_employee_hold(uuid,uuid,text,jsonb,timestamptz)'::regprocedure));")
    assert query(ae_marker) == "0", query(ae_marker)  # 20261012500000 alone
    sql(hold_ae)
    sql(hold_ae)  # re-applicable
    sql(ROOT / "tests/security/db-hold-release-actor-email.sql")
    sql(ROOT / "tests/security/db-employee-holds.sql")
    sql(ROOT / "supabase/verification/20261016300000_hold_release_actor_email_rollback.sql")
    assert query(ae_marker) == "0", query(ae_marker)
    sql(ROOT / "tests/security/db-employee-holds.sql")
    sql(hold_ae)  # forward again after rollback
    sql(ROOT / "tests/security/db-hold-release-actor-email.sql")
    print("PASS: hold release actor_email (20261016300000): release audit row.actor_email is org_members.email of "
          "resolved_by; p_audit_metadata cannot forge it; EXECUTE service_role only; re-applicable; rollback restores "
          "the 20261012500000 body; forward again.")
    # LINE PoC per-employee accounts / secrets / inbound dedup / link-code limits (20261013200000).
    eca = ROOT / "supabase/migrations/20261013200000_employee_comm_accounts.sql"
    eca_rb = ROOT / "supabase/verification/20261013200000_employee_comm_accounts_rollback.sql"
    sql(eca)
    sql(eca)  # re-applicable
    sql(ROOT / "tests/security/db-employee-comm-accounts.sql")
    # 木村 10/12 [MED]: N concurrent wrong guesses from one sender → at most 5 get a slot (reach the
    # comparison); the reservation is one call, so there is no check-then-count gap.
    # 40 at once from 40 senders on one account → exactly 30 slots and one 'account_locked' notify.
    eca_org = "ec000000-0000-4000-8000-0000000000e1"
    query(f"insert into public.orgs(id, name) values ('{eca_org}', 'eca concurrent');")
    one = (f"set role service_role; select public.comm_link_code_reserve_attempt('{eca_org}',"
           f" 'comm_account:ec200000-0000-4000-8000-0000000000e1', repeat('7', 64), now())->>'result';")
    with ThreadPoolExecutor(max_workers=20) as pool:
        res = list(pool.map(_psql, [one] * 20))
    outs = [o.splitlines()[-1] for _, o, _ in res]
    assert all(rc == 0 for rc, _, _ in res), [e for _, _, e in res]
    assert outs.count("ok") == 5 and outs.count("sender_locked") == 15, outs
    many = [f"set role service_role; select (r->>'result') || ':' || coalesce(r->>'notify', '-') from"
            f" public.comm_link_code_reserve_attempt('{eca_org}', 'line_channel:ec200000-0000-4000-8000-0000000000e2',"
            f" lpad(to_hex({i}), 64, 'e'), now()) r;" for i in range(40)]
    with ThreadPoolExecutor(max_workers=20) as pool:
        res = list(pool.map(_psql, many))
    outs = [o.splitlines()[-1] for _, o, _ in res]
    assert all(rc == 0 for rc, _, _ in res), [e for _, _, e in res]
    assert outs.count("ok:-") == 30 and outs.count("account_locked:account_locked") == 1 and outs.count("account_locked:-") == 9, outs
    query(f"delete from public.orgs where id = '{eca_org}';")
    # the rollback refuses while an account is active
    query("insert into public.orgs(id, name) values ('ec000000-0000-4000-8000-0000000000f1', 'eca rb');"
          "insert into public.employees(id, org_id, display_name, role_label) values"
          " ('ec100000-0000-4000-8000-0000000000f1', 'ec000000-0000-4000-8000-0000000000f1', 'eca rb', 'staff');"
          "insert into public.employee_comm_accounts(org_id, employee_id, surface, external_account_id, webhook_ref, status)"
          " values ('ec000000-0000-4000-8000-0000000000f1', 'ec100000-0000-4000-8000-0000000000f1', 'line', 'U' || repeat('f', 32), repeat('F', 43), 'active');")
    try:
        sql(eca_rb)
        raise AssertionError("comm accounts rollback ran while an account was active")
    except subprocess.CalledProcessError:
        pass
    assert query("select to_regclass('public.employee_comm_accounts') is not null;") == "t"
    query("delete from public.orgs where id = 'ec000000-0000-4000-8000-0000000000f1';")
    sql(eca_rb)
    assert query("select to_regclass('public.employee_comm_accounts') is null and to_regclass('public.employee_comm_account_secrets') is null"
                 " and to_regclass('public.comm_inbound_events') is null and to_regclass('public.comm_link_code_attempts') is null"
                 " and to_regclass('public.comm_link_code_locks') is null and to_regclass('public.comm_link_code_lock_events') is null"
                 " and to_regprocedure('public.comm_link_code_reserve_attempt(uuid,text,text,timestamptz)') is null"
                 " and to_regprocedure('public.comm_link_code_release_attempt(uuid,uuid)') is null;") == "t"
    sql(eca)  # forward again after rollback
    sql(ROOT / "tests/security/db-employee-comm-accounts.sql")
    print("PASS: comm accounts (20261013200000): 6 tables RLS on / restrictive deny-all only, anon/authenticated no access and cannot execute; "
          "one account per employee per surface, external account id unique across orgs, same-org employee only, value CHECKs; "
          "secrets v2 ciphertext only, org bound to account; inbound event key once; link codes: ONE reserve call before the comparison — sender 5/15 min then 1 h lock, "
          "released (right) attempts not counted, release org-scoped; account 30/1 h then lock + one ops signal, 3rd lock in 24 h → one repeat signal "
          "(20 concurrent wrong guesses from one sender → exactly 5 slots; 40 concurrent senders → 30 slots + 1 signal), other org unaffected, lock expires; re-applicable; rollback refused while an "
          "account is active, then drops all; forward again.")
    # L-6 LINE replyToken / unknown-outcome ledger (20261014100000).
    l6rt = ROOT / "supabase/migrations/20261014100000_comm_line_reply_tokens.sql"
    l6rt_rb = ROOT / "supabase/verification/20261014100000_comm_line_reply_tokens_rollback.sql"
    sql(l6rt)
    sql(l6rt)  # re-applicable
    sql(ROOT / "tests/security/db-comm-line-reply-tokens.sql")
    query("insert into public.orgs(id, name) values ('ec000000-0000-4000-8000-0000000000a6', 'l6 rb');"
          "insert into public.comm_line_send_unknown(org_id, retry_key)"
          " values ('ec000000-0000-4000-8000-0000000000a6', 'refuse-while-unknown');")
    try:
        sql(l6rt_rb)
        raise AssertionError("line reply-token rollback ran while unknown rows existed")
    except subprocess.CalledProcessError:
        pass
    assert query("select to_regclass('public.comm_line_reply_tokens') is not null;") == "t"
    query("delete from public.orgs where id = 'ec000000-0000-4000-8000-0000000000a6';")
    sql(l6rt_rb)
    assert query("select to_regclass('public.comm_line_reply_tokens') is null"
                 " and to_regclass('public.comm_line_send_unknown') is null;") == "t"
    sql(l6rt)  # forward again after rollback
    sql(ROOT / "tests/security/db-comm-line-reply-tokens.sql")
    # Parent rollback must refuse while L-6 tables still exist (no CASCADE).
    try:
        sql(eca_rb)
        raise AssertionError("comm accounts rollback ran while L-6 tables existed")
    except subprocess.CalledProcessError:
        pass
    assert query("select to_regclass('public.employee_comm_accounts') is not null"
                 " and to_regclass('public.comm_line_reply_tokens') is not null"
                 " and to_regclass('public.comm_line_send_unknown') is not null;") == "t"
    apw = ROOT / "supabase/migrations/20261016100000_ai_peer_wake_guard.sql"
    sql(apw)
    sql(apw)  # re-applicable
    sql(ROOT / "tests/security/db-ai-peer-wake-guard.sql")
    apw_org, apw_emp1, apw_emp2 = ("a1600000-0000-4000-8000-0000000000c1",
                                   "a1610000-0000-4000-8000-0000000000c1",
                                   "a1610000-0000-4000-8000-0000000000c2")
    query(f"insert into public.orgs(id, name) values ('{apw_org}', 'apw race');"
          f"insert into public.employees(id, org_id, display_name, role_label) values "
          f"('{apw_emp1}', '{apw_org}', 'apw c1', 'r'), ('{apw_emp2}', '{apw_org}', 'apw c2', 'r');")
    command = (f"set role service_role; select public.claim_ai_peer_wake("
               f"'{apw_org}','T0TEAM1','C0RACE1','1787911797.502889','1787911800.000001',4,1800)->>'state';")
    with ThreadPoolExecutor(max_workers=12) as pool:
        claims = list(pool.map(query, [command]*12))
    assert claims.count("allowed") == 4 and claims.count("capped") == 8, claims
    query(f"delete from public.orgs where id='{apw_org}';")
    sql(ROOT / "supabase/verification/20261016100000_ai_peer_wake_guard_rollback.sql")
    assert query("select to_regclass('public.ai_peer_wake_allowlist') is null"
                 " and to_regclass('public.ai_peer_wake_threads') is null"
                 " and to_regprocedure('public.claim_ai_peer_wake(uuid,text,text,text,text,integer,integer)') is null"
                 " and to_regprocedure('public.stop_ai_peer_wake_thread(uuid,uuid,text)') is null"
                 " and to_regprocedure('public.resume_ai_peer_wake_thread(uuid,uuid,text)') is null"
                 " and to_regprocedure('public.ai_peer_wake_allowlist_guard()') is null;") == "t"
    sql(apw)  # forward again after rollback
    sql(ROOT / "tests/security/db-ai-peer-wake-guard.sql")
    print("PASS: comm line reply tokens (20261014100000): 2 tables RLS on / restrictive deny-all only, anon/authenticated no access; "
          "hash format, unique reply token, unknown retry_key unique per org, org delete cascades; re-applicable; "
          "rollback refused while unknown-outcome rows exist, then drops both; forward again.")
    # /api/mcp auth-failure audit + last_used_at touch (20261016400000).
    maf = ROOT / "supabase/migrations/20261016400000_mcp_auth_failures.sql"
    sql(maf)
    sql(maf)  # re-applicable
    sql(ROOT / "tests/security/db-mcp-auth-failures.sql")
    from concurrent.futures import ThreadPoolExecutor as _MafPool
    maf_commands = [
        "set role service_role; select public.record_mcp_auth_failure('missing_credential', null, null, null, 'tools/list');"
        for _ in range(12)
    ]
    with _MafPool(max_workers=12) as pool:
        maf_hits = list(pool.map(query, maf_commands))
    assert maf_hits.count("t") == 1 and maf_hits.count("f") == 11, maf_hits
    query("delete from public.mcp_auth_failures where failure_kind = 'missing_credential' and org_id is null;")
    sql(ROOT / "supabase/verification/20261016400000_mcp_auth_failures_rollback.sql")
    assert query("select to_regclass('public.mcp_auth_failures') is null"
                 " and to_regprocedure('public.record_mcp_auth_failure(text,uuid,uuid,uuid,text)') is null"
                 " and to_regprocedure('public.touch_credential_last_used(uuid)') is null"
                 " and to_regclass('public.credentials') is not null;") == "t"
    sql(maf)  # forward again after rollback
    sql(ROOT / "tests/security/db-mcp-auth-failures.sql")
    print("PASS: mcp auth failures (20261016400000): RLS on / no policy, anon/authenticated hold no privilege and cannot execute; "
          "kinds missing_credential/invalid/expired only; 5-minute throttle per kind×identity; no token/hash/prefix columns; "
          "touch_credential_last_used conditional UPDATE (5 min); 12 concurrent missing_credential → 1 insert; "
          "re-applicable; rollback drops table + 2 functions; forward again.")
    # 社員証 auto-renew (20261019100000, CREDENTIAL_AUTO_RENEW_ENABLED).
    car = ROOT / "supabase/migrations/20261019100000_credential_auto_renew.sql"
    sql(car)
    sql(car)  # re-applicable
    sql(ROOT / "tests/security/db-credential-auto-renew.sql")
    from concurrent.futures import ThreadPoolExecutor as _CarPool
    car_org, car_emp, car_old, car_appr, car_row = (
        "ca000000-0000-4000-8000-0000000000c1",
        "ca100000-0000-4000-8000-0000000000c1",
        "ca200000-0000-4000-8000-0000000000c1",
        "ca300000-0000-4000-8000-0000000000c1",
        "ca400000-0000-4000-8000-0000000000c1",
    )
    query(
        f"insert into public.orgs(id, name) values ('{car_org}', 'car concurrent');"
        f"insert into public.employees(id, org_id, display_name, role_label) values "
        f"('{car_emp}', '{car_org}', 'Car C', 'fixture');"
        f"insert into public.credentials(id, org_id, employee_id, secret_hash) values "
        f"('{car_old}', '{car_org}', '{car_emp}', repeat('c', 64));"
        f"insert into public.approval_requests(id, org_id, purpose, summary, tool, risk, status, metadata) values "
        f"('{car_appr}', '{car_org}', 'admin.policy', 'car', 'employees.credential.auto_renew', 'high', 'approved',"
        f" '{{\"adminTool\":\"employees.credential.auto_renew\"}}');"
        f"insert into public.credential_renewals(id, org_id, employee_id, old_credential_id, approval_id, threshold, state, claimable_until) values "
        f"('{car_row}', '{car_org}', '{car_emp}', '{car_old}', '{car_appr}', 'now', 'claimable', now() + interval '24 hours');"
    )
    car_commands = [
        f"set role service_role; select public.claim_credential_renewal('{car_row}','{car_org}','{car_emp}','tok_concurrent_{i:02d}_0123456789',now());"
        for i in range(12)
    ]
    with _CarPool(max_workers=12) as pool:
        car_claims = list(pool.map(query, car_commands))
    assert car_claims.count("t") == 1 and car_claims.count("f") == 11, car_claims
    car_winner = query(f"select claim_token from public.credential_renewals where id = '{car_row}';")
    assert car_winner == f"tok_concurrent_{car_claims.index('t'):02d}_0123456789", (car_winner, car_claims)
    query(
        f"delete from public.credential_renewals where id = '{car_row}';"
        f"delete from public.approval_requests where id = '{car_appr}';"
        f"delete from public.credentials where id = '{car_old}';"
        f"delete from public.employees where id = '{car_emp}';"
        f"delete from public.orgs where id = '{car_org}';"
    )
    sql(ROOT / "supabase/verification/20261019100000_credential_auto_renew_rollback.sql")
    assert query(
        "select to_regclass('public.credential_renewals') is null"
        " and to_regprocedure('public.claim_credential_renewal(uuid,uuid,uuid,text,timestamptz)') is null"
        " and to_regprocedure('public.release_credential_renewal(uuid,uuid,text)') is null"
        " and to_regprocedure('public.revoke_overlapped_old_credential(uuid,uuid,uuid,uuid)') is null"
        " and to_regprocedure('public.credential_renewal_operable(uuid,uuid,boolean)') is null"
        " and to_regprocedure('public.expire_stale_credential_renewals(uuid,timestamptz)') is null"
        " and to_regprocedure('public.credential_renewals_same_org()') is null"
        " and to_regclass('public.credentials') is not null;"
    ) == "t"
    sql(car)  # forward again after rollback
    sql(ROOT / "tests/security/db-credential-auto-renew.sql")
    print("PASS: credential auto-renew (20261019100000): RLS on / no policy, anon/authenticated hold no privilege "
          "and cannot execute; unique old_credential × threshold (7d/now); same-org trigger; "
          "claim once (12 concurrent → 1 winner); release only with own token before mint; "
          "revoke overlapped old (already-revoked true, 2nd UPDATE 0 rows RAISE); "
          "claim/release require active+unheld+approved+live old; new_credential ON DELETE RESTRICT; "
          "expire_stale_credential_renewals; no secret/prefix/public-key columns; "
          "re-applicable; rollback drops table + 6 functions; forward again.")
    print("PASS: approver authority (PR-D): owner / designated admin decision table; flag-OFF 7-argument W1 call unchanged; standard ticket → designated admin stored, others refused; owner ticket → designated admin endorsed once and kept pending, owner approves and is stored; zero owners stop; multiple owners: any one owner other than the requester (requesting owner refused; a sole owner's own approval counts; several owners all requesters → no_owner_other_than_requester); reject / non-target not gated; record_approver_authority verified/endorse; one RPC overload; EXECUTE service_role only; rollback restores the 7-argument RPC + re-apply.")
    print("PASS: approver context CAS (TOCTOU follow-up): policy.patch / schedulingPolicy.patch writes only when the locked row still equals the pinned snapshot; concurrent change between check and write → approver_context_changed with nothing written (employee row, active and revoked credentials, org / employee scheduling policy); ticket binding (fingerprint, missing fingerprint, status, tool, target, org) refused; invalid input refused; EXECUTE service_role only; 12 concurrent writers with one snapshot → exactly 1 write (both RPCs); rollback drops both RPCs (PR-D untouched) + re-apply.")
    print("PASS: employee_webhook_settings (D9): RLS on, no policy, anon/authenticated denied, service_role reads/writes/upserts; cross-org row rejected; payload mode minimal|legacy_full (default minimal); ciphertext-only secret + fingerprint pair; employee delete cascades; rollback + re-apply.")
    print("PASS: channel_classify_proposals / channel_stuck_notice_windows (PR-B): RLS on, anon/authenticated denied (tables + 4 RPCs); org_channels accepts telegram; claim states claimed/in_flight/pending/decided, facts change reopens, other org isolated; attach same-org only; release unattached only; notice window once then suppressed; bad input denied; org delete cascades; 12 concurrent claims → exactly 1 claimed; rollback (2 tables + 4 RPCs + telegram surface) + re-apply.")
    print("PASS: channel_classify_budget_windows (PR-B follow-up H1): RLS on, no policy, anon/authenticated denied (table + RPC); allowed up to max → over_first once → over; per org / per key independent; expired window resets; bad input denied; org delete cascades; 20 concurrent takes (max 5) → exactly 5 allowed + 1 over_first; rollback (table + RPC, PR-B tables untouched) + re-apply.")
    print("PASS: thread_send_leases / thread_self_posts (thread single-flight): RLS on, no policy, anon/authenticated denied (2 tables + 3 RPCs); acquire → busy (retry_after) → expired lease taken over; release by holder only (old holder cannot release a re-taken lease); other org's lease on the same key independent, other org cannot release, other org's employee denied; self posts only move forward, no cross-org rows; bad input denied; org delete cascades; 12 concurrent acquires → exactly 1 acquired; rollback (2 tables + 3 RPCs, dedup ledger untouched) + re-apply.")
    print("PASS: close_approval_without_send / job_first_micros (thread single-flight pre-flag fixes, 20261009150000): close writes status + resolved_at + closedWithoutSend in one statement (other metadata kept), only from the listed statuses, other org → null untouched, bad input refused, an injected failure leaves no partial state, 12 concurrent closes → exactly 1; same job re-enters its held lease within 10 min of its first post (after that / different job / other employee / no job key → busy); record keeps the job's first-post anchor, a different job / no job key re-anchors; wake read point recorded per org × employee × thread, forward-only, other org's employee / bad input refused; anon/authenticated denied (RPCs + thread_wake_points); rollback (RPCs + columns + wake table, #286 intact) + re-apply.")
    print("PASS: slack_skipped_channel_wakes (Path C re-wake, 20261009700000): RLS on, no policy, anon/authenticated denied (table + 2 RPCs); record: same-org employee only, bad ids denied, older kept / newer replaces; claim: approved same-org approval that classifies THIS channel only (tool + externalId; other channel / other tool / other surface / non-classification config change / pending / other org / missing denied), once, other org isolated; newer skip reopens, older does not; TTL; org delete cascades; 12 concurrent claims → exactly 1 winner; rollback (table + 2 RPCs) + re-apply.")
    print("PASS: ai_peer_wake_allowlist / ai_peer_wake_threads (20261016100000): RLS on, no policy, anon/authenticated denied (2 tables + 3 RPCs); allowlist same-org employees only, self pair / ai: created_by refused; claim first 4 allowed then capped (notify once), other org isolated, bad ids denied; stop/resume member-only and org-scoped; org delete cascades; 12 concurrent claims → exactly 4 allowed + 8 capped; rollback (2 tables + 3 RPCs) + re-apply.")
    print("PASS: orgs / subscriptions / audit_events / approval_requests have no anon/authenticated write path (member/admin/owner JWT denied); service_role writes all four. Full-history check: scripts/test-db-all-migrations.py.")
    print("PASS: 14 tenant config / credential tables (credentials, employees, bindings, admin agents, directory, adapters, channels, projects, card setup/audit) + gateway_links, agentmail_inboxes, lp_handoffs, lp_wake_webhook_configs, lp_wake_webhook_events have no anon/authenticated write path; other reads unchanged; credentials (rows and secret_hash) unreadable from any session; service_role reads/writes all.")
    print("PASS: lp_inquiries / notification_outbox have no anon/authenticated write grant; lp_handoffs / lp_wake_* have no policy (RLS on) and no anon/authenticated SELECT; sessions read/write none of the 5 LP tables; service_role (BYPASSRLS) reads/writes all.")
    print("PASS: lp_inquiries / lp_journeys lp_page + lp_ref (20261012300000): nullable text, no default; CHECK allowlist ai-employee | ai-employee-corp and ^[A-Za-z0-9_-]{1,32}$ (empty, 33 chars, space, dot, slash, <script>, non-ASCII, newline rejected); RLS on, anon/authenticated still cannot write; re-applicable.")
    print("PASS: mcp_event_subscriptions / mcp_event_deliveries: RLS on, no policy, anon/authenticated denied (rows and secret_ciphertext), service_role reads/writes; cross-org subscription / delivery rejected; one delivery per (subscription, event); 256 KiB body cap; id / event / status / https / ciphertext / lastError-category checks; org delete cascades; D11 verification budget: 30/host/minute window, hosts and windows independent, bad input rejected, anon/authenticated denied (table + function), 40 concurrent takes → exactly 30 accepted; rollback (3 tables + 2 functions) + re-apply.")
    # 木村 10/12: read-only LINE approval ref listing (supabase/verification/line-approval-refs-in-use-20261012.sql).
    lr_org, lr_e1, lr_e2, lr_e3 = ("e1a00000-0000-4000-8000-000000000001", "e1a00000-0000-4000-8000-0000000000e1",
                                   "e1a00000-0000-4000-8000-0000000000e2", "e1a00000-0000-4000-8000-0000000000e3")
    lr_ok, lr_off, lr_nosec = ("e1a00000-0000-4000-8000-0000000000c1", "e1a00000-0000-4000-8000-0000000000c2",
                               "e1a00000-0000-4000-8000-0000000000c3")
    for _stmt in (f"insert into public.orgs(id, name) values ('{lr_org}', 'スペースツリー（fixture）');"
                  f"insert into public.org_notification_channels(id, org_id, provider, label, enabled, is_default, webhook_ref) values"
                  f" ('{lr_ok}', '{lr_org}', 'line', 'ok', true, true, 'aaaaaaaaaaaa'),"
                  f" ('{lr_off}', '{lr_org}', 'line', 'off', false, false, 'bbbbbbbbbbbb'),"
                  f" ('{lr_nosec}', '{lr_org}', 'line', 'nosec', true, false, 'cccccccccccc');"
                  f"insert into public.org_notification_channel_secrets(channel_id, credentials_ciphertext) values ('{lr_ok}', 'v1.secret-not-selected');"
                  f"insert into public.employees(id, org_id, display_name, role_label) values ('{lr_e1}', '{lr_org}', 'line-user', 'fixture');"
                  f"insert into public.employees(id, org_id, display_name, role_label, approval_channel_id) values"
                  f" ('{lr_e2}', '{lr_org}', 'off-user', 'fixture', '{lr_off}'), ('{lr_e3}', '{lr_org}', 'nosec-user', 'fixture', '{lr_nosec}');").split(";"):
        if _stmt.strip():
            query(_stmt + ";")
    _out = run([BIN / "psql", "-X", "-qAt", "-F", "|", "-v", "ON_ERROR_STOP=1", "-h", cluster, "-p", "55439", "-U", "test_admin",
                "-d", "postgres", "-f", ROOT / "supabase/verification/line-approval-refs-in-use-20261012.sql"],
               capture_output=True, text=True).stdout
    _rows = [r.split("|") for r in _out.splitlines() if r.startswith("スペースツリー（fixture）")]
    _by = {r[2]: r for r in _rows}
    assert set(_by) == {"line-user", "off-user", "nosec-user"}, _rows
    assert _by["line-user"][5] == "org_default" and _by["line-user"][8] == "aaaaaaaaaaaa" and _by["line-user"][-1] == "t" and _by["line-user"][-2] == "t", _by["line-user"]
    assert _by["off-user"][-1] == "f" and _by["nosec-user"][-1] == "f" and _by["nosec-user"][11] == "f", _rows
    assert "secret-not-selected" not in _out
    assert query(f"select count(*) from public.org_notification_channels where org_id = '{lr_org}'") == "3"  # read-only: nothing changed
    for _stmt in (f"delete from public.employees where org_id = '{lr_org}'; delete from public.orgs where id = '{lr_org}';").split(";"):
        if _stmt.strip():
            query(_stmt + ";")
    print("PASS: line-approval-refs-in-use-20261012.sql (read-only): lists org / employee / ref per LINE channel (employee inbox + org default); "
          "resolves_under_new_route true only for enabled + credentials; no secret value in the output.")
    print("PASS: org_members has no authenticated write path; last active owner cannot be demoted/disabled/deleted; org cascade still works.")
    print(f"PASS: F8 parent state={args.f8_parent_state}; 3 explicit UNIQUE constraints; existing constraint/index OIDs preserved across apply/reapply.")
    print("PASS: #80 ACL/authority/metadata regressions; 12 claims and 12 secret readers each have 1 winner. F8 W1, multi-stage/finalGo, rejection, current voter/binding, self-approval, same-org FKs, direct access denial, atomic rollback and recovery pass. 12 duplicate votes count once; 2 concurrent voters advance once. All migrations reapplied.")

finally:
    if started:
        run([BIN / "pg_ctl", "-D", cluster / "data", "-m", "fast", "-w", "stop"], stdout=subprocess.DEVNULL)
    # Only this script's newly-created fixture directory is removed.
    shutil.rmtree(cluster)

"""Disposable PG16 cluster: PR-6 actor_email backfill contracts.

Never reads PG*/DATABASE_URL or .env. Unix socket only.
"""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
CANDIDATE_BINS = [
    os.environ.get("PG_TEST_BIN", ""),
    "/usr/lib/postgresql/16/bin",
    "/opt/homebrew/opt/postgresql@16/bin",
    "/usr/lib/postgresql/17/bin",
]
BIN = next(Path(p) for p in CANDIDATE_BINS if p and (Path(p) / "initdb").exists())
env = {key: os.environ[key] for key in ("PATH", "TMPDIR", "LANG") if key in os.environ}
env.update({"LC_ALL": "C", "PGCONNECT_TIMEOUT": "5", "PGOPTIONS": "-c client_min_messages=warning"})
PORT = "55441"
cluster = Path(tempfile.mkdtemp(prefix="staffpass-pr6-"))
started = False

ORG_A = "00000000-0000-4000-8000-0000000000a1"
ORG_B = "00000000-0000-4000-8000-0000000000b1"
MEM_A = "00000000-0000-4000-8000-0000000000a2"
MEM_B = "00000000-0000-4000-8000-0000000000b2"
MEM_SYN = "00000000-0000-4000-8000-0000000000a8"
APR_A = "00000000-0000-4000-8000-0000000000a3"
APR_B = "00000000-0000-4000-8000-0000000000b3"
APR_SYN = "00000000-0000-4000-8000-0000000000a9"
AUD_FILL = "00000000-0000-4000-8000-000000000101"
AUD_KEEP = "00000000-0000-4000-8000-000000000102"
AUD_OWNER = "00000000-0000-4000-8000-000000000103"
AUD_SLACK = "00000000-0000-4000-8000-000000000104"
AUD_ALERT = "00000000-0000-4000-8000-000000000105"
AUD_BAD_ID = "00000000-0000-4000-8000-000000000106"
AUD_CROSS = "00000000-0000-4000-8000-000000000107"
AUD_B = "00000000-0000-4000-8000-000000000108"
AUD_SYN_SRC = "00000000-0000-4000-8000-000000000109"
AUD_MARKED = "00000000-0000-4000-8000-00000000010a"
AUD_BLANK = "00000000-0000-4000-8000-00000000010b"
AUD_BATCH1 = "00000000-0000-4000-8000-00000000010c"
AUD_BATCH2 = "00000000-0000-4000-8000-00000000010d"
AUD_BATCH3 = "00000000-0000-4000-8000-00000000010e"


def run(args, **kwargs):
    return subprocess.run([str(x) for x in args], env=env, check=True, **kwargs)


def psql(extra, input_text=None):
    cmd = [
        BIN / "psql",
        "-X",
        "-q",
        "-v",
        "ON_ERROR_STOP=1",
        "-h",
        cluster,
        "-p",
        PORT,
        "-U",
        "test_admin",
        "-d",
        "postgres",
        *extra,
    ]
    result = subprocess.run(
        [str(x) for x in cmd],
        env=env,
        input=input_text,
        text=True,
        capture_output=True,
    )
    if result.returncode != 0:
        sys.stderr.write(result.stderr)
        raise SystemExit(f"FAIL psql {' '.join(str(x) for x in extra)}: {result.stderr.strip()}")
    return result


def query(command):
    result = psql(["-At", "-F", "|", "-c", command])
    return result.stdout.strip()


SCHEMA = f"""
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;

create table public.orgs (id uuid primary key);
create table public.org_members (
  id uuid primary key,
  org_id uuid not null references public.orgs(id),
  email text not null
);
create table public.approval_requests (
  id uuid primary key,
  org_id uuid not null references public.orgs(id),
  resolved_by uuid,
  status_token text,
  poll_path text
);
create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  actor_email text,
  action text not null default 'admin.policy',
  summary text not null default 't',
  metadata jsonb not null default '{{}}'::jsonb,
  created_at timestamptz not null default now()
);

insert into public.orgs(id) values ('{ORG_A}'), ('{ORG_B}');
insert into public.org_members(id, org_id, email) values
  ('{MEM_A}', '{ORG_A}', 'alice@a.example'),
  ('{MEM_B}', '{ORG_B}', 'bob@b.example'),
  ('{MEM_SYN}', '{ORG_A}', 'org_owner');
insert into public.approval_requests(id, org_id, resolved_by, status_token, poll_path) values
  ('{APR_A}', '{ORG_A}', '{MEM_A}', 'secret-token-a', '/api/approvals/status?id={APR_A}&token=secret-token-a'),
  ('{APR_B}', '{ORG_B}', '{MEM_B}', 'secret-token-b', '/api/approvals/status?id={APR_B}&token=secret-token-b'),
  ('{APR_SYN}', '{ORG_A}', '{MEM_SYN}', 'secret-token-s', '/api/approvals/status?id={APR_SYN}&token=secret-token-s');

insert into public.audit_events(id, org_id, actor_email, metadata, created_at) values
  ('{AUD_FILL}', '{ORG_A}', null, jsonb_build_object('approvalId', '{APR_A}'), '2026-10-01 00:00:01+00'),
  ('{AUD_KEEP}', '{ORG_A}', 'keep@a.example', jsonb_build_object('approvalId', '{APR_A}'), '2026-10-01 00:00:02+00'),
  ('{AUD_OWNER}', '{ORG_A}', 'org_owner', jsonb_build_object('approvalId', '{APR_A}'), '2026-10-01 00:00:03+00'),
  ('{AUD_SLACK}', '{ORG_A}', 'slack_shared_approval_install', jsonb_build_object('approvalId', '{APR_A}'), '2026-10-01 00:00:04+00'),
  ('{AUD_ALERT}', '{ORG_A}', 'approval_delivery_alert', jsonb_build_object('approvalId', '{APR_A}'), '2026-10-01 00:00:05+00'),
  ('{AUD_BAD_ID}', '{ORG_A}', null, jsonb_build_object('approvalId', 'slack_U123'), '2026-10-01 00:00:06+00'),
  ('{AUD_CROSS}', '{ORG_A}', null, jsonb_build_object('approvalId', '{APR_B}'), '2026-10-01 00:00:07+00'),
  ('{AUD_B}', '{ORG_B}', null, jsonb_build_object('approval_id', '{APR_B}'), '2026-10-01 00:00:08+00'),
  ('{AUD_SYN_SRC}', '{ORG_A}', null, jsonb_build_object('approvalId', '{APR_SYN}'), '2026-10-01 00:00:09+00'),
  ('{AUD_MARKED}', '{ORG_A}', null, jsonb_build_object('approvalId', '{APR_A}', 'backfill', 'actor_email_pr6'), '2026-10-01 00:00:10+00'),
  ('{AUD_BLANK}', '{ORG_A}', '   ', jsonb_build_object('approvalId', '{APR_A}'), '2026-10-01 00:00:11+00'),
  ('{AUD_BATCH1}', '{ORG_A}', null, jsonb_build_object('approvalId', '{APR_A}'), '2026-10-01 00:00:12+00'),
  ('{AUD_BATCH2}', '{ORG_A}', null, jsonb_build_object('approvalId', '{APR_A}'), '2026-10-01 00:00:13+00'),
  ('{AUD_BATCH3}', '{ORG_A}', null, jsonb_build_object('approvalId', '{APR_A}'), '2026-10-01 00:00:14+00');
"""


def snapshot():
    return query(
        """select id::text || '=' || coalesce(actor_email, '<null>') || '/' || coalesce(metadata->>'backfill', '-')
             from public.audit_events order by created_at, id"""
    )


def secrets():
    return query(
        """select id::text || '=' || coalesce(status_token, '') || '|' || coalesce(poll_path, '')
             from public.approval_requests order by id"""
    )


def drain(fn, org_id, limit=500):
    total = 0
    while True:
        n = int(query(f"select public.{fn}('{org_id}', {limit});"))
        total += n
        if n == 0:
            return total


try:
    run(
        [BIN / "initdb", "-D", cluster / "data", "-U", "test_admin", "--auth=trust", "--no-locale"],
        stdout=subprocess.DEVNULL,
    )
    run(
        [
            BIN / "pg_ctl",
            "-D",
            cluster / "data",
            "-l",
            cluster / "server.log",
            "-o",
            f"-F -c listen_addresses='' -k {cluster} -p {PORT}",
            "-w",
            "start",
        ],
        stdout=subprocess.DEVNULL,
    )
    started = True
    version = query("show server_version")
    assert version.startswith("16."), version

    psql(["-c", SCHEMA])
    psql(["-f", str(ROOT / "supabase/migrations/20261022200000_audit_actor_email_backfill.sql")])
    psql(["-f", str(ROOT / "supabase/migrations/20261022200000_audit_actor_email_backfill.sql")])

    assert query(
        "select has_function_privilege('anon', 'public.backfill_audit_actor_email_pr6_batch(uuid,integer)', 'execute')"
    ) == "f"
    assert query(
        "select has_function_privilege('authenticated', 'public.backfill_audit_actor_email_pr6_batch(uuid,integer)', 'execute')"
    ) == "f"
    assert query(
        "select has_function_privilege('service_role', 'public.backfill_audit_actor_email_pr6_batch(uuid,integer)', 'execute')"
    ) == "t"

    before_secrets = secrets()

    empty_before = query(
        f"select actor_email from public.audit_events where id='{AUD_FILL}'"
    )
    assert empty_before == ""
    psql(["-f", str(ROOT / "supabase/verification/20261022200000_audit_actor_email_backfill_apply.sql")])
    assert query(f"select coalesce(actor_email, '<null>') from public.audit_events where id='{AUD_FILL}'") == "<null>"

    raised = subprocess.run(
        [
            str(BIN / "psql"),
            "-X",
            "-q",
            "-v",
            "ON_ERROR_STOP=1",
            "-h",
            str(cluster),
            "-p",
            PORT,
            "-U",
            "test_admin",
            "-d",
            "postgres",
            "-c",
            "select public.backfill_audit_actor_email_pr6_batch(null, 10);",
        ],
        env=env,
        capture_output=True,
        text=True,
    )
    assert raised.returncode != 0
    assert "org_id_required" in raised.stderr

    first = query(f"select public.backfill_audit_actor_email_pr6_batch('{ORG_A}', 2);")
    assert first == "2", first
    second = query(f"select public.backfill_audit_actor_email_pr6_batch('{ORG_A}', 500);")
    assert int(second) >= 1, second
    third = query(f"select public.backfill_audit_actor_email_pr6_batch('{ORG_A}', 500);")
    assert third == "0", third

    filled = query(
        f"""select actor_email || '|' || (metadata->>'backfill')
              from public.audit_events
             where id in ('{AUD_FILL}','{AUD_BLANK}','{AUD_BATCH1}','{AUD_BATCH2}','{AUD_BATCH3}')
             order by id"""
    )
    for line in filled.splitlines():
        assert line == "alice@a.example|actor_email_pr6", line

    kept = query(
        f"""select id::text || '=' || actor_email
              from public.audit_events
             where id in ('{AUD_KEEP}','{AUD_OWNER}','{AUD_SLACK}','{AUD_ALERT}')
             order by id"""
    )
    assert kept.splitlines() == [
        f"{AUD_KEEP}=keep@a.example",
        f"{AUD_OWNER}=org_owner",
        f"{AUD_SLACK}=slack_shared_approval_install",
        f"{AUD_ALERT}=approval_delivery_alert",
    ]

    skipped = query(
        f"""select id::text || '=' || coalesce(actor_email,'<null>') || '/' || coalesce(metadata->>'backfill','-')
              from public.audit_events
             where id in ('{AUD_BAD_ID}','{AUD_CROSS}','{AUD_B}','{AUD_SYN_SRC}','{AUD_MARKED}')
             order by id"""
    )
    assert skipped.splitlines() == [
        f"{AUD_BAD_ID}=<null>/-",
        f"{AUD_CROSS}=<null>/-",
        f"{AUD_B}=<null>/-",
        f"{AUD_SYN_SRC}=<null>/-",
        f"{AUD_MARKED}=<null>/actor_email_pr6",
    ]

    org_b_before = query(f"select coalesce(actor_email,'<null>') from public.audit_events where id='{AUD_B}'")
    assert org_b_before == "<null>"

    marked_meta = query(
        f"""select count(*) from public.audit_events
             where metadata->>'backfill' = 'actor_email_pr6'
               and (
                 metadata::text ilike '%secret-token%'
                 or metadata ? 'status_token'
                 or metadata ? 'poll_path'
                 or metadata ? 'pollPath'
                 or metadata::text like '%alice@a.example%'
               )"""
    )
    assert marked_meta == "0", marked_meta
    assert secrets() == before_secrets

    again = query(f"select public.backfill_audit_actor_email_pr6_batch('{ORG_A}', 500);")
    assert again == "0", again
    assert query(f"select coalesce(actor_email,'<null>') from public.audit_events where id='{AUD_B}'") == "<null>"
    assert query(f"select actor_email from public.audit_events where id='{AUD_KEEP}'") == "keep@a.example"

    assert drain("backfill_audit_actor_email_pr6_batch", ORG_B) == 1
    assert query(f"select actor_email || '|' || (metadata->>'backfill') from public.audit_events where id='{AUD_B}'") == (
        "bob@b.example|actor_email_pr6"
    )
    assert query(f"select actor_email from public.audit_events where id='{AUD_KEEP}'") == "keep@a.example"

    rolled = query(f"select public.rollback_audit_actor_email_pr6_batch('{ORG_A}', 2000);")
    assert int(rolled) >= 1, rolled
    leftover_a = query(
        f"select count(*) from public.audit_events where org_id='{ORG_A}' and metadata->>'backfill' = 'actor_email_pr6'"
    )
    assert leftover_a == "0", leftover_a
    assert query(f"select coalesce(actor_email,'<null>') from public.audit_events where id='{AUD_FILL}'") == "<null>"
    assert query(f"select actor_email from public.audit_events where id='{AUD_KEEP}'") == "keep@a.example"
    assert query(f"select actor_email from public.audit_events where id='{AUD_OWNER}'") == "org_owner"
    assert query(
        f"select actor_email || '|' || (metadata->>'backfill') from public.audit_events where id='{AUD_B}'"
    ) == "bob@b.example|actor_email_pr6"

    psql(["-f", str(ROOT / "supabase/verification/20261022200000_audit_actor_email_backfill_rollback.sql")])
    assert query(
        f"select actor_email || '|' || (metadata->>'backfill') from public.audit_events where id='{AUD_B}'"
    ) == "bob@b.example|actor_email_pr6"

    assert drain("rollback_audit_actor_email_pr6_batch", ORG_B) == 1
    assert query(f"select coalesce(actor_email,'<null>') from public.audit_events where id='{AUD_B}'") == "<null>"
    assert query(
        "select count(*) from public.audit_events where metadata->>'backfill' = 'actor_email_pr6'"
    ) == "0"
    assert secrets() == before_secrets

    print(f"PASS PR-6 actor_email backfill on PostgreSQL {version}: per-org, empty-only, marked rollback, no secrets.")
finally:
    if started:
        subprocess.run(
            [str(BIN / "pg_ctl"), "-D", str(cluster / "data"), "-m", "fast", "-w", "stop"],
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    shutil.rmtree(cluster, ignore_errors=True)

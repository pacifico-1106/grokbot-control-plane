-- LINE PoC (design: line-lineworks-design-20261012.md §2-3 C5 / C6 / C3, §5).
-- Additive only. Flags LINE_CONVERSATION_ENABLED / COMM_ACCOUNTS_ENABLED (both
-- default OFF): with them OFF no code path reads or writes these tables, so the
-- code may deploy before this migration. Apply BEFORE turning a flag ON.
--
-- 1. employee_comm_accounts         : one LINE official account per AI employee (決定 3)
-- 2. employee_comm_account_secrets  : its secrets, AES-256-GCM ciphertext only (app-side,
--                                      bound to account id + org id as AAD). Never returned.
-- 3. comm_inbound_events            : replay / redelivery guard (webhookEventId), no body (C8)
-- 4. comm_link_code_failures / _locks + 2 functions: link-code brute-force limits (H8, §5)
--
-- All server-only: RLS on, restrictive deny-all policy, no grants to anon/authenticated.
begin;
set local lock_timeout = '5s';

-- Composite FK target (same guard as 20260928000000_employee_identity_bindings; a no-op
-- where that migration ran). Ensures an account's employee belongs to the same org.
do $p0$
begin
  if not exists (
    select 1 from pg_constraint c
    where c.conrelid = 'public.employees'::regclass and c.contype in ('u', 'p')
      and c.conkey @> array[
        (select attnum from pg_attribute where attrelid = 'public.employees'::regclass and attname = 'id' and not attisdropped),
        (select attnum from pg_attribute where attrelid = 'public.employees'::regclass and attname = 'org_id' and not attisdropped)
      ]::smallint[]
      and cardinality(c.conkey) = 2
  ) then
    alter table public.employees add constraint employees_id_org_key unique (id, org_id);
  end if;
end $p0$;

create table if not exists public.employee_comm_accounts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  employee_id uuid not null,
  -- C1 adds 'line_works' (and the other 7 CHECKs) in one go; the PoC is LINE only.
  surface text not null check (surface in ('line')),
  -- LINE bot userId (U + 32 hex). Unique across ALL tenants: another org cannot
  -- register the same official account (§5 テナントの分離).
  external_account_id text not null check (external_account_id ~ '^U[0-9a-f]{32}$'),
  -- Unguessable URL ref, separate from any secret. 32 bytes base64url = 43 chars.
  webhook_ref text not null check (webhook_ref ~ '^[A-Za-z0-9_-]{43}$'),
  status text not null default 'pending' check (status in ('pending', 'active', 'disabled')),
  display_name text check (display_name is null or length(display_name) between 1 and 200),
  created_by_member_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  disabled_at timestamptz,
  constraint employee_comm_accounts_id_org_key unique (id, org_id),
  constraint employee_comm_accounts_external_key unique (surface, external_account_id),
  constraint employee_comm_accounts_ref_key unique (webhook_ref),
  -- one account per employee per surface (1 社員 = 1 公式アカウント)
  constraint employee_comm_accounts_employee_key unique (org_id, employee_id, surface),
  constraint employee_comm_accounts_disabled_at check ((status = 'disabled') = (disabled_at is not null)),
  foreign key (employee_id, org_id) references public.employees(id, org_id) on delete cascade
);

create table if not exists public.employee_comm_account_secrets (
  account_id uuid primary key,
  org_id uuid not null,
  -- v2 = AES-256-GCM with AAD "employee_comm_account:<account_id>:<org_id>" (lib/comm/secret-crypto.ts)
  ciphertext text not null check (ciphertext ~ '^v2\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]+$' and length(ciphertext) <= 16384),
  -- names of the stored keys only (e.g. {channelAccessToken,channelSecret}); never values
  secret_names text[] not null check (cardinality(secret_names) between 1 and 8),
  verified_at timestamptz,
  updated_by_member_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (account_id, org_id) references public.employee_comm_accounts(id, org_id) on delete cascade
);

-- Replay guard: LINE has no timestamp in the signature, so a captured signed body
-- could be replayed (H10). The event key (webhookEventId) is stored once; a second
-- insert conflicts and the event is dropped. No message body (C8).
create table if not exists public.comm_inbound_events (
  account_id uuid not null,
  org_id uuid not null,
  event_key text not null check (length(event_key) between 8 and 128),
  received_at timestamptz not null default now(),
  primary key (account_id, event_key),
  foreign key (account_id, org_id) references public.employee_comm_accounts(id, org_id) on delete cascade
);
create index if not exists comm_inbound_events_received_idx on public.comm_inbound_events(received_at);

-- Link-code brute force (H8, §5). Counts live in the DB, not per server instance.
-- scope 'sender'  : keyed HMAC of the sending LINE userId (no raw userId stored)
-- scope 'account' : the channel / account id the code was sent to
create table if not exists public.comm_link_code_failures (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.orgs(id) on delete cascade,
  scope text not null check (scope in ('sender', 'account')),
  scope_key text not null check (scope_key ~ '^[0-9a-f]{64}$' or scope_key ~ '^[0-9a-f-]{36}$'),
  failed_at timestamptz not null default now()
);
create index if not exists comm_link_code_failures_key_idx
  on public.comm_link_code_failures(org_id, scope, scope_key, failed_at desc);

create table if not exists public.comm_link_code_locks (
  org_id uuid not null references public.orgs(id) on delete cascade,
  scope text not null check (scope in ('sender', 'account')),
  scope_key text not null check (scope_key ~ '^[0-9a-f]{64}$' or scope_key ~ '^[0-9a-f-]{36}$'),
  locked_until timestamptz not null,
  locked_at timestamptz not null default now(),
  primary key (org_id, scope, scope_key)
);

-- Gate: is either key locked right now? Called BEFORE the code is looked up, so a
-- locked sender gets the same answer for a right or wrong code.
create or replace function public.comm_link_code_gate(
  p_org_id uuid, p_account_key text, p_sender_key text, p_now timestamptz default now()
) returns text
language sql stable security definer set search_path = pg_catalog, public
as $$
  select case
    when exists (select 1 from public.comm_link_code_locks l where l.org_id = p_org_id
                 and l.scope = 'account' and l.scope_key = p_account_key and l.locked_until > p_now) then 'account_locked'
    when exists (select 1 from public.comm_link_code_locks l where l.org_id = p_org_id
                 and l.scope = 'sender' and l.scope_key = p_sender_key and l.locked_until > p_now) then 'sender_locked'
    else 'ok' end;
$$;

-- Record one wrong code. Atomic per (org, key) via advisory locks.
--   sender : 5 failures in 15 min → locked 1 hour
--   account: 30 failures in 1 hour → locked 1 hour; returns 'account_locked_new' the
--            first time so the caller alerts ops exactly once per lock.
create or replace function public.comm_link_code_record_failure(
  p_org_id uuid, p_account_key text, p_sender_key text, p_now timestamptz default now()
) returns text
language plpgsql security definer set search_path = pg_catalog, public
as $$
declare
  v_sender int;
  v_account int;
  v_result text := 'recorded';
begin
  if p_org_id is null or p_account_key is null or p_sender_key is null then
    raise exception 'comm_link_code_bad_input' using errcode = '22023';
  end if;
  -- fixed order (account, then sender) so two callers never deadlock
  perform pg_advisory_xact_lock(hashtextextended('comm_link:' || p_org_id || ':account:' || p_account_key, 0));
  perform pg_advisory_xact_lock(hashtextextended('comm_link:' || p_org_id || ':sender:' || p_sender_key, 0));
  insert into public.comm_link_code_failures(org_id, scope, scope_key, failed_at)
    values (p_org_id, 'account', p_account_key, p_now), (p_org_id, 'sender', p_sender_key, p_now);
  select count(*) into v_sender from public.comm_link_code_failures
    where org_id = p_org_id and scope = 'sender' and scope_key = p_sender_key
      and failed_at > p_now - interval '15 minutes' and failed_at <= p_now;
  select count(*) into v_account from public.comm_link_code_failures
    where org_id = p_org_id and scope = 'account' and scope_key = p_account_key
      and failed_at > p_now - interval '1 hour' and failed_at <= p_now;
  if v_sender >= 5 then
    insert into public.comm_link_code_locks(org_id, scope, scope_key, locked_until, locked_at)
      values (p_org_id, 'sender', p_sender_key, p_now + interval '1 hour', p_now)
      on conflict (org_id, scope, scope_key) do update
        set locked_until = greatest(public.comm_link_code_locks.locked_until, excluded.locked_until),
            locked_at = case when public.comm_link_code_locks.locked_until > p_now
                             then public.comm_link_code_locks.locked_at else excluded.locked_at end;
    v_result := 'sender_locked';
  end if;
  if v_account >= 30 then
    if not exists (select 1 from public.comm_link_code_locks where org_id = p_org_id and scope = 'account'
                   and scope_key = p_account_key and locked_until > p_now) then
      v_result := 'account_locked_new';
    elsif v_result <> 'sender_locked' then
      v_result := 'account_locked';
    end if;
    insert into public.comm_link_code_locks(org_id, scope, scope_key, locked_until, locked_at)
      values (p_org_id, 'account', p_account_key, p_now + interval '1 hour', p_now)
      on conflict (org_id, scope, scope_key) do update
        set locked_until = greatest(public.comm_link_code_locks.locked_until, excluded.locked_until);
  end if;
  -- retention: failures older than a day carry no signal
  delete from public.comm_link_code_failures
    where org_id = p_org_id and scope_key in (p_account_key, p_sender_key) and failed_at < p_now - interval '1 day';
  return v_result;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['employee_comm_accounts', 'employee_comm_account_secrets', 'comm_inbound_events',
                           'comm_link_code_failures', 'comm_link_code_locks'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to service_role', t);
    execute format('drop policy if exists %I on public.%I', t || '_server_only', t);
    execute format('create policy %I on public.%I as restrictive for all to public using (false) with check (false)',
                   t || '_server_only', t);
  end loop;
end $$;

revoke all on function public.comm_link_code_gate(uuid, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.comm_link_code_record_failure(uuid, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.comm_link_code_gate(uuid, text, text, timestamptz) to service_role;
grant execute on function public.comm_link_code_record_failure(uuid, text, text, timestamptz) to service_role;

comment on table public.employee_comm_accounts is
  'Per-employee LINE official account (LINE PoC C5). Server-only. Flag COMM_ACCOUNTS_ENABLED.';
comment on table public.employee_comm_account_secrets is
  'AES-256-GCM ciphertext (AAD = account id + org id) of the account secrets. Never returned to UI / API / AI.';
comment on table public.comm_inbound_events is
  'Inbound event keys (webhookEventId) for replay / redelivery dedup. No message body.';

commit;

-- ROLLBACK (down) — disable the accounts first; the standalone script refuses while
-- any account is active (supabase/verification/20261013200000_employee_comm_accounts_rollback.sql):
--   drop function if exists public.comm_link_code_record_failure(uuid, text, text, timestamptz);
--   drop function if exists public.comm_link_code_gate(uuid, text, text, timestamptz);
--   drop table if exists public.comm_link_code_locks;
--   drop table if exists public.comm_link_code_failures;
--   drop table if exists public.comm_inbound_events;
--   drop table if exists public.employee_comm_account_secrets;
--   drop table if exists public.employee_comm_accounts;
-- END ROLLBACK

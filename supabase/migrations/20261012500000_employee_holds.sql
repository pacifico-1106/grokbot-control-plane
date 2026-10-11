-- 緊急停止 (hold) — S1 of /workspace/p0/ai-safety-5rules-design-20261012.md §2 / §10.
-- Schema + the only 3 functions that may change it. No data change: every
-- hold column defaults to null, so nothing behaves differently until a hold is
-- started (S3, EMPLOYEE_HOLD_ENABLED). The checks (S2) read hold_state
-- regardless of any flag.
--
--   employees.hold_state  null | stopped | leave | quarantined   (+ hold_id)
--   orgs.hold_state       null | stopped                         (+ hold_id)
--   employee_holds        history, append-only (release fields are filled once)
--
-- Writes go ONLY through:
--   start_employee_hold(org, employee|null, kind, reason, started_by, started_via, trigger, at)
--     one transaction: history row → hold_state / hold_id → pending and
--     approved-but-unexecuted tickets of that employee (all of the org for an
--     org hold) get metadata.heldByHoldId. A same-or-weaker re-stop returns the
--     open hold; a STRONGER one (ops 3 > auto cutoff / incident 2 > leave 1)
--     upgrades (ops 4 > detector / quarantine 3 > tenant stop 2 > leave 1): the
--     old row is closed as superseded_by the new one (history),
--     tickets follow. Terminated employees can still be stopped.
--     Another org's employee → employee_not_found.
--   request_employee_hold_release(org, hold, requested_by, reason, approval, at)
--     member requester only (never system / ops / AI), a reason, and a pending
--     employee.hold.release ticket of the same org for that hold.
--   release_employee_hold(org, hold, audit_summary, audit_metadata, at)
--     the ticket must be approved by an ACTIVE owner / designated admin of the
--     same org who is NOT the requester (2-person rule). Single-owner
--     exception: only if the org has exactly one eligible approver, the ticket
--     says singleOwnerSelfRelease and a reason was given. Ops-console holds are
--     never member-releasable. The audit_events row is inserted in the SAME
--     transaction — if it cannot be written, nothing is released. Held tickets
--     get metadata.holdOutcome = 'closed_by_hold' (default discard, decision 3).
-- Direct writes to the hold columns / history (even by service_role) are
-- refused by triggers unless made inside these functions (transaction-local
-- GUC). This guards against app code bypassing the release rules; service_role
-- itself remains trusted infrastructure.
-- security invoker, search_path = pg_catalog, public, EXECUTE service_role only.
-- employee_holds: RLS on, no policy, no anon / authenticated privilege.
begin;
set local lock_timeout = '5s';

create table if not exists public.employee_holds (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  employee_id uuid references public.employees(id) on delete cascade,
  kind text not null constraint employee_holds_kind_check check (kind in ('stopped', 'leave', 'quarantined')),
  reason text check (reason is null or char_length(reason) <= 500),
  started_by text not null constraint employee_holds_started_by_check
    check (started_by ~ '^(member:[0-9a-f-]{36}|ops:[A-Za-z0-9._@+-]{1,128}|system:anomaly)$'),
  started_via text not null check (started_via in ('web', 'slack', 'line', 'telegram', 'ops_console', 'anomaly')),
  started_at timestamptz not null default now(),
  release_requested_by text check (release_requested_by is null or release_requested_by ~ '^member:[0-9a-f-]{36}$'),
  release_requested_at timestamptz,
  release_reason text check (release_reason is null or char_length(release_reason) <= 500),
  release_approval_id uuid,
  released_by text check (released_by is null or released_by ~ '^member:[0-9a-f-]{36}$'),
  released_at timestamptz,
  trigger text check (trigger is null or trigger ~ '^[A-Za-z0-9_.:=<>-]{1,200}$'),
  -- Upgrade (木村 10/12): a stronger re-stop closes this row as superseded and opens a new one.
  upgraded_from uuid references public.employee_holds(id),
  superseded_by uuid references public.employee_holds(id) deferrable initially deferred,
  superseded_at timestamptz,
  constraint employee_holds_superseded_shape check (
    ((superseded_by is null) = (superseded_at is null)) and not (superseded_at is not null and released_at is not null)),
  constraint employee_holds_org_kind_check check (employee_id is not null or kind = 'stopped'),
  constraint employee_holds_anomaly_shape check ((started_via = 'anomaly') = (started_by = 'system:anomaly')),
  -- 木村 10/12 (3): an ops: stopper always uses the ops console, and only ops uses it.
  constraint employee_holds_ops_route check ((started_via = 'ops_console') = (started_by like 'ops:%')),
  constraint employee_holds_request_shape check ((release_requested_by is null) = (release_requested_at is null)),
  constraint employee_holds_release_shape check (
    (released_at is null and released_by is null)
    or (released_at is not null and released_by is not null and release_approval_id is not null and release_requested_by is not null))
);
create index if not exists employee_holds_org_idx on public.employee_holds (org_id, started_at desc);
create unique index if not exists employee_holds_one_open_per_employee
  on public.employee_holds (employee_id) where released_at is null and superseded_at is null and employee_id is not null;
create unique index if not exists employee_holds_one_open_per_org
  on public.employee_holds (org_id) where released_at is null and superseded_at is null and employee_id is null;

alter table public.employee_holds enable row level security;
revoke all on table public.employee_holds from public, anon, authenticated;
grant select, insert, update on table public.employee_holds to service_role;

alter table public.employees
  add column if not exists hold_state text,
  add column if not exists hold_id uuid;
alter table public.employees drop constraint if exists employees_hold_state_check;
alter table public.employees add constraint employees_hold_state_check
  check ((hold_state is null and hold_id is null)
         or (hold_state in ('stopped', 'leave', 'quarantined') and hold_id is not null));
alter table public.employees drop constraint if exists employees_hold_id_fkey;
alter table public.employees add constraint employees_hold_id_fkey
  foreign key (hold_id) references public.employee_holds(id);

alter table public.orgs
  add column if not exists hold_state text,
  add column if not exists hold_id uuid;
alter table public.orgs drop constraint if exists orgs_hold_state_check;
alter table public.orgs add constraint orgs_hold_state_check
  check ((hold_state is null and hold_id is null) or (hold_state = 'stopped' and hold_id is not null));
alter table public.orgs drop constraint if exists orgs_hold_id_fkey;
alter table public.orgs add constraint orgs_hold_id_fkey
  foreign key (hold_id) references public.employee_holds(id);

-- History guard: function-only writes, append-only, identity fixed, release once.
create or replace function public.employee_holds_guard() returns trigger
language plpgsql security invoker set search_path = pg_catalog, public as $ehg$
begin
  if tg_op = 'DELETE' then
    -- org / employee deletion cascades (depth > 1); a direct delete never.
    if pg_trigger_depth() > 1 then return old; end if;
    raise exception 'employee_holds_append_only';
  end if;
  if coalesce(current_setting('staffpass.hold_write', true), '') <> 'on' then
    raise exception 'employee_holds_function_only';
  end if;
  if tg_op = 'INSERT' then
    if new.employee_id is not null and not exists (
      select 1 from public.employees e where e.id = new.employee_id and e.org_id = new.org_id) then
      raise exception 'employee_holds_cross_org';
    end if;
    if new.released_at is not null or new.release_requested_by is not null or new.superseded_at is not null then
      raise exception 'employee_holds_immutable';
    end if;
    return new;
  end if;
  if new.id is distinct from old.id or new.org_id is distinct from old.org_id
     or new.employee_id is distinct from old.employee_id or new.kind is distinct from old.kind
     or new.reason is distinct from old.reason or new.started_by is distinct from old.started_by
     or new.started_via is distinct from old.started_via or new.started_at is distinct from old.started_at
     or new.trigger is distinct from old.trigger or new.upgraded_from is distinct from old.upgraded_from then
    raise exception 'employee_holds_immutable';
  end if;
  if old.released_at is not null or old.superseded_at is not null then raise exception 'employee_holds_immutable'; end if;
  return new;
end $ehg$;
drop trigger if exists employee_holds_guard on public.employee_holds;
create trigger employee_holds_guard before insert or update or delete on public.employee_holds
  for each row execute function public.employee_holds_guard();

-- employees / orgs hold columns: function-only; a set hold must be an open
-- hold of the same org (and the same employee).
create or replace function public.hold_columns_guard() returns trigger
language plpgsql security invoker set search_path = pg_catalog, public as $hcg$
declare h public.employee_holds%rowtype;
begin
  if tg_op = 'UPDATE' and new.hold_state is not distinct from old.hold_state
     and new.hold_id is not distinct from old.hold_id then
    return new;
  end if;
  if tg_op = 'INSERT' and new.hold_state is null and new.hold_id is null then return new; end if;
  if coalesce(current_setting('staffpass.hold_write', true), '') <> 'on' then
    raise exception 'hold_columns_function_only';
  end if;
  if new.hold_id is not null then
    select * into h from public.employee_holds where id = new.hold_id;
    if not found or h.released_at is not null or h.superseded_at is not null or h.kind is distinct from new.hold_state then
      raise exception 'hold_columns_mismatch';
    end if;
    -- (separate branches: orgs has no org_id column)
    if tg_table_name = 'employees' then
      if h.org_id::text <> to_jsonb(new)->>'org_id' then raise exception 'hold_columns_mismatch'; end if;
      if h.employee_id is distinct from new.id then raise exception 'hold_columns_mismatch'; end if;
    elsif h.org_id <> new.id or h.employee_id is not null then
      raise exception 'hold_columns_mismatch';
    end if;
  end if;
  return new;
end $hcg$;
drop trigger if exists employees_hold_guard on public.employees;
create trigger employees_hold_guard before insert or update of hold_state, hold_id on public.employees
  for each row execute function public.hold_columns_guard();
drop trigger if exists orgs_hold_guard on public.orgs;
create trigger orgs_hold_guard before insert or update of hold_state, hold_id on public.orgs
  for each row execute function public.hold_columns_guard();

create or replace function public.employee_hold_rank(p_kind text, p_via text) returns integer
language sql immutable set search_path = pg_catalog, public as $ehr$
  -- 木村 10/12 (2nd): ops 4 > detector (anomaly route or quarantine) 3 > tenant stop / incident 2 > leave 1.
  -- A detector hold must outrank any human-placed one (else a single owner could self-release it).
  select case when p_via = 'ops_console' then 4
              when p_via = 'anomaly' or p_kind = 'quarantined' then 3
              when p_kind = 'stopped' then 2
              when p_kind = 'leave' then 1 else 0 end
$ehr$;

create or replace function public.start_employee_hold(
  p_org uuid, p_employee uuid, p_kind text, p_reason text,
  p_started_by text, p_started_via text, p_trigger text, p_at timestamptz
) returns jsonb
language plpgsql security invoker set search_path = pg_catalog, public as $seh$
declare existing uuid; hid uuid; n integer; prev public.employee_holds%rowtype;
begin
  if p_employee is null then
    select hold_id into existing from public.orgs where id = p_org for update;
    if not found then raise exception 'org_not_found'; end if;
  else
    select hold_id into existing from public.employees where id = p_employee and org_id = p_org for update;
    if not found then raise exception 'employee_not_found'; end if;
  end if;
  if existing is not null then
    select * into prev from public.employee_holds where id = existing for update;
    -- Strength (木村 10/12): ops stop 3 > automatic cutoff / incident stop 2 > leave 1.
    -- Only a STRONGER re-stop moves the hold (upgrade); same / weaker returns it.
    -- Moving down happens only through the release flow.
    if public.employee_hold_rank(p_kind, p_started_via) <= public.employee_hold_rank(prev.kind, prev.started_via) then
      return jsonb_build_object('holdId', existing, 'created', false, 'upgraded', false, 'heldTickets', 0);
    end if;
  end if;
  perform set_config('staffpass.hold_write', 'on', true);
  hid := gen_random_uuid();
  if existing is not null then
    -- close the weaker hold first (the open-hold unique index allows one open row)
    update public.employee_holds set superseded_by = hid, superseded_at = coalesce(p_at, now()) where id = existing;
  end if;
  insert into public.employee_holds(id, org_id, employee_id, kind, reason, started_by, started_via, started_at, trigger, upgraded_from)
  values (hid, p_org, p_employee, p_kind, nullif(btrim(coalesce(p_reason, '')), ''), p_started_by, p_started_via,
          coalesce(p_at, now()), p_trigger, existing);
  if p_employee is null then
    update public.orgs set hold_state = p_kind, hold_id = hid where id = p_org;
  else
    update public.employees set hold_state = p_kind, hold_id = hid where id = p_employee and org_id = p_org;
  end if;
  perform set_config('staffpass.hold_write', '', true);
  update public.approval_requests
     set metadata = coalesce(metadata, '{}'::jsonb) - 'holdOutcome'
                    || jsonb_build_object('heldByHoldId', hid, 'heldAt', coalesce(p_at, now()))
   where org_id = p_org
     and (p_employee is null or employee_id = p_employee)
     and status in ('pending', 'revision_requested', 'approved')
     and coalesce(metadata->'fulfillment'->>'ok', '') <> 'true'
     and coalesce(metadata->'adminFulfillment'->>'ok', '') <> 'true'
     and coalesce(metadata->>'adminTool', tool, '') <> 'employee.hold.release';
  get diagnostics n = row_count;
  if existing is not null then
    -- tickets held by the weaker hold follow the new one (released / closed with it)
    update public.approval_requests set metadata = metadata || jsonb_build_object('heldByHoldId', hid)
     where org_id = p_org and metadata->>'heldByHoldId' = existing::text;
  end if;
  return jsonb_build_object('holdId', hid, 'created', existing is null, 'upgraded', existing is not null,
                            'previousHoldId', existing, 'heldTickets', n);
end $seh$;

create or replace function public.request_employee_hold_release(
  p_org uuid, p_hold uuid, p_requested_by text, p_reason text, p_approval uuid, p_at timestamptz
) returns boolean
language plpgsql security invoker set search_path = pg_catalog, public as $reh$
declare h public.employee_holds%rowtype; subj uuid;
begin
  -- Same lock order as start / release: subject row, then the hold row.
  select employee_id into subj from public.employee_holds where id = p_hold and org_id = p_org;
  if not found then raise exception 'hold_not_found'; end if;
  if subj is null then perform 1 from public.orgs where id = p_org for update;
  else perform 1 from public.employees where id = subj and org_id = p_org for update; end if;
  select * into h from public.employee_holds where id = p_hold and org_id = p_org and released_at is null and superseded_at is null for update;
  if not found then raise exception 'hold_not_found'; end if;
  if h.started_via = 'ops_console' or h.started_by like 'ops:%' then raise exception 'ops_hold_ops_only'; end if;
  if p_requested_by is null or p_requested_by !~ '^member:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'release_requester_invalid'; end if;
  -- 木村 10/12 (1): the requester is an ACTIVE member of THIS org (not just a well-formed id).
  if not exists (select 1 from public.org_members m
                  where m.id = substr(p_requested_by, 8)::uuid and m.org_id = p_org and m.status = 'active') then
    raise exception 'release_requester_invalid';
  end if;
  if char_length(btrim(coalesce(p_reason, ''))) = 0 then raise exception 'release_reason_required'; end if;
  -- 木村 10/12 (2): a pending (or approved, not yet released) request is never replaced. A new
  -- request is accepted only once the previous ticket is rejected / expired / gone.
  if h.release_approval_id is not null and exists (
       select 1 from public.approval_requests a where a.id = h.release_approval_id and a.org_id = p_org
          and a.status in ('pending', 'approved')) then
    raise exception 'release_already_requested';
  end if;
  if not exists (
    select 1 from public.approval_requests a
     where a.id = p_approval and a.org_id = p_org and a.status = 'pending'
       and coalesce(a.metadata->>'adminTool', a.tool, '') = 'employee.hold.release'
       and a.metadata->>'holdId' = p_hold::text
       and a.metadata->>'requestedBy' = p_requested_by) then  -- the ticket's requester is the requester
    raise exception 'release_ticket_invalid';
  end if;
  perform set_config('staffpass.hold_write', 'on', true);
  update public.employee_holds
     set release_requested_by = p_requested_by, release_requested_at = coalesce(p_at, now()),
         release_reason = btrim(p_reason), release_approval_id = p_approval
   where id = p_hold;
  perform set_config('staffpass.hold_write', '', true);
  return true;
end $reh$;

create or replace function public.release_employee_hold(
  p_org uuid, p_hold uuid, p_audit_summary text, p_audit_metadata jsonb, p_at timestamptz
) returns jsonb
language plpgsql security invoker set search_path = pg_catalog, public as $rlh$
declare h public.employee_holds%rowtype; a public.approval_requests%rowtype;
        approver text; eligible integer; is_eligible boolean; n integer; subj uuid;
begin
  -- Lock order = start_employee_hold: the employee (or org) row FIRST, then the hold row.
  -- (木村 10/12: hold-then-employee here vs employee-then-hold in start deadlocked a
  -- concurrent detector upgrade.) After the subject lock, re-read the hold: an upgrade
  -- that won the race has superseded it → hold_not_found, the employee stays held.
  select employee_id into subj from public.employee_holds where id = p_hold and org_id = p_org;
  if not found then raise exception 'hold_not_found'; end if;
  if subj is null then perform 1 from public.orgs where id = p_org for update;
  else perform 1 from public.employees where id = subj and org_id = p_org for update; end if;
  select * into h from public.employee_holds where id = p_hold and org_id = p_org and released_at is null and superseded_at is null for update;
  if not found then raise exception 'hold_not_found'; end if;
  if h.started_via = 'ops_console' or h.started_by like 'ops:%' then raise exception 'ops_hold_ops_only'; end if;
  if h.release_approval_id is null or h.release_requested_by is null then raise exception 'release_not_requested'; end if;
  select * into a from public.approval_requests where id = h.release_approval_id and org_id = p_org for update;
  if not found or coalesce(a.metadata->>'adminTool', a.tool, '') <> 'employee.hold.release'
     or a.metadata->>'holdId' is distinct from p_hold::text
     or a.metadata->>'requestedBy' is distinct from h.release_requested_by then
    raise exception 'release_ticket_invalid';
  end if;
  if a.status <> 'approved' or a.resolved_by is null then raise exception 'release_not_approved'; end if;
  approver := 'member:' || a.resolved_by::text;
  -- Approver: an ACTIVE owner or designated admin of THIS org.
  select exists (
    select 1 from public.org_members m join public.orgs o on o.id = m.org_id
     where m.id = a.resolved_by and m.org_id = p_org and m.status = 'active'
       and (m.role = 'owner' or m.id = any(o.designated_admin_member_ids))) into is_eligible;
  if not is_eligible then raise exception 'release_approver_not_allowed'; end if;
  -- the requester must still be an active member of this org at release time
  if not exists (select 1 from public.org_members m
                  where m.id = substr(h.release_requested_by, 8)::uuid and m.org_id = p_org and m.status = 'active') then
    raise exception 'release_requester_invalid';
  end if;
  if approver = h.release_requested_by then
    -- Single-owner exception (decision 2): only with exactly one eligible approver.
    select count(*) into eligible from public.org_members m join public.orgs o on o.id = m.org_id
     where m.org_id = p_org and m.status = 'active'
       and (m.role = 'owner' or m.id = any(o.designated_admin_member_ids));
    -- 木村 10/12 (4): never for anomaly-triggered or quarantined holds (decoy-key design).
    if h.kind = 'quarantined' or h.started_via = 'anomaly' or h.trigger is not null then
      raise exception 'release_approver_not_allowed';
    end if;
    if eligible <> 1 or coalesce(a.metadata->>'singleOwnerSelfRelease', '') <> 'true'
       or char_length(btrim(coalesce(h.release_reason, ''))) = 0 then
      raise exception 'release_approver_not_allowed';
    end if;
  end if;
  -- Audit first, same transaction: if it fails, nothing below happens.
  insert into public.audit_events(org_id, employee_id, action, summary, metadata)
  values (p_org, h.employee_id, 'employee.hold.released',
          left(coalesce(nullif(btrim(p_audit_summary), ''), 'employee hold released'), 500),
          coalesce(p_audit_metadata, '{}'::jsonb) || jsonb_build_object(
            'auditClass', 'admin', 'holdId', h.id, 'approvalId', a.id, 'kind', h.kind,
            'requestedBy', h.release_requested_by, 'releasedBy', approver,
            'singleOwnerSelfRelease', approver = h.release_requested_by));
  perform set_config('staffpass.hold_write', 'on', true);
  update public.employee_holds set released_by = approver, released_at = coalesce(p_at, now()) where id = h.id;
  if h.employee_id is null then
    update public.orgs set hold_state = null, hold_id = null where id = p_org and hold_id = h.id;
  else
    update public.employees set hold_state = null, hold_id = null where id = h.employee_id and org_id = p_org and hold_id = h.id;
  end if;
  perform set_config('staffpass.hold_write', '', true);
  update public.approval_requests
     set metadata = metadata || jsonb_build_object('holdOutcome', 'closed_by_hold', 'holdReleasedAt', coalesce(p_at, now()))
   where org_id = p_org and metadata->>'heldByHoldId' = h.id::text;
  get diagnostics n = row_count;
  return jsonb_build_object('released', true, 'holdId', h.id, 'closedTickets', n);
end $rlh$;

revoke all on function public.employee_holds_guard() from public, anon, authenticated;
revoke all on function public.employee_hold_rank(text, text) from public, anon, authenticated;
grant execute on function public.employee_hold_rank(text, text) to service_role;
revoke all on function public.hold_columns_guard() from public, anon, authenticated;
revoke all on function public.start_employee_hold(uuid, uuid, text, text, text, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.request_employee_hold_release(uuid, uuid, text, text, uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.release_employee_hold(uuid, uuid, text, jsonb, timestamptz) from public, anon, authenticated;
grant execute on function public.start_employee_hold(uuid, uuid, text, text, text, text, text, timestamptz) to service_role;
grant execute on function public.request_employee_hold_release(uuid, uuid, text, text, uuid, timestamptz) to service_role;
grant execute on function public.release_employee_hold(uuid, uuid, text, jsonb, timestamptz) to service_role;

commit;

-- ROLLBACK (down) — only while no hold is in use (S3 / EMPLOYEE_HOLD_ENABLED off). Same
-- statements as supabase/verification/20261012500000_employee_holds_rollback.sql:
--   begin;
--   set local lock_timeout = '5s';
--   do $$ begin
--     if to_regclass('public.employee_holds') is not null and (
--          exists (select 1 from public.employee_holds where released_at is null and superseded_at is null)
--          or exists (select 1 from public.employees where hold_state is not null)
--          or exists (select 1 from public.orgs where hold_state is not null)) then
--       raise exception 'ROLLBACK_REFUSED: open holds exist — release them (or decide explicitly) first';
--     end if;
--   end $$;
--   drop function if exists public.release_employee_hold(uuid, uuid, text, jsonb, timestamptz);
--   drop function if exists public.request_employee_hold_release(uuid, uuid, text, text, uuid, timestamptz);
--   drop function if exists public.start_employee_hold(uuid, uuid, text, text, text, text, text, timestamptz);
--   drop function if exists public.employee_hold_rank(text, text);
--   drop trigger if exists employees_hold_guard on public.employees;
--   drop trigger if exists orgs_hold_guard on public.orgs;
--   alter table public.employees drop constraint if exists employees_hold_id_fkey;
--   alter table public.employees drop constraint if exists employees_hold_state_check;
--   alter table public.employees drop column if exists hold_id, drop column if exists hold_state;
--   alter table public.orgs drop constraint if exists orgs_hold_id_fkey;
--   alter table public.orgs drop constraint if exists orgs_hold_state_check;
--   alter table public.orgs drop column if exists hold_id, drop column if exists hold_state;
--   drop table if exists public.employee_holds;
--   drop function if exists public.hold_columns_guard();
--   drop function if exists public.employee_holds_guard();
--   commit;
-- END ROLLBACK

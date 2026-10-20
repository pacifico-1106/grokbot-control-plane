-- HOLD_DENIAL_AUDIT_ENABLED (default OFF): MCP hold 403 kinds on
-- mcp_auth_failures + record_hold_mcp_denial (1-minute unique throttle).
-- Self-approval denials use existing audit_events (no schema change).
-- Additive: expand failure_kind CHECK, optional hold_id, new RPC.
-- Existing record_mcp_auth_failure (5-min auth kinds) is unchanged.
-- NEVER token, hash, or prefix. RLS stays on, no policy, service_role only.
begin;

-- ACCESS EXCLUSIVE while the CHECK is dropped/re-added (brief; table is small).
-- Prefer the known name (this migration + PG's usual inline-CHECK auto-name).
-- Production / forked names: if a failure_kind CHECK still remains, drop that too.
alter table public.mcp_auth_failures
  drop constraint if exists mcp_auth_failures_failure_kind_check;

do $$
declare c name;
begin
  select conname into c
  from pg_constraint
  where conrelid = 'public.mcp_auth_failures'::regclass
    and contype = 'c'
    and conname <> 'mcp_auth_failures_failure_kind_check'
    and pg_get_constraintdef(oid) like '%failure_kind%'
  limit 1;
  if c is not null then
    execute format('alter table public.mcp_auth_failures drop constraint %I', c);
  end if;
end $$;

alter table public.mcp_auth_failures
  add constraint mcp_auth_failures_failure_kind_check
  check (failure_kind in (
    'missing_credential',
    'invalid',
    'expired',
    'org_on_hold',
    'employee_on_hold'
  ));

alter table public.mcp_auth_failures
  add column if not exists hold_id uuid;

comment on column public.mcp_auth_failures.hold_id is
  'Open hold id when failure_kind is org_on_hold / employee_on_hold. No FK (row survives hold delete). Never a secret.';

-- Existing unique (kind × org × employee × throttle_bucket) already makes
-- 1-min hold rows multi-instance safe. Partial index keys hold_id too so a
-- missing employee still throttles per hold.
create unique index if not exists mcp_auth_failures_hold_denial_throttle_uidx
  on public.mcp_auth_failures (
    failure_kind,
    (coalesce(hold_id, '00000000-0000-0000-0000-000000000000'::uuid)),
    (coalesce(org_id, '00000000-0000-0000-0000-000000000000'::uuid)),
    (coalesce(employee_id, '00000000-0000-0000-0000-000000000000'::uuid)),
    throttle_bucket
  )
  where failure_kind in ('org_on_hold', 'employee_on_hold');

create or replace function public.record_hold_mcp_denial(
  p_kind text,
  p_org_id uuid,
  p_employee_id uuid,
  p_hold_id uuid,
  p_method text
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $fn$
begin
  if p_kind is null or p_kind not in ('org_on_hold', 'employee_on_hold') then
    return false;
  end if;
  if p_org_id is null then
    return false;
  end if;
  perform set_config('lock_timeout', '200ms', true);
  perform set_config('statement_timeout', '250ms', true);
  if (select count(*)::int from public.mcp_auth_failures where created_at > now() - interval '1 hour') >= 200 then
    return false;
  end if;
  insert into public.mcp_auth_failures (
    failure_kind, org_id, employee_id, hold_id, mcp_method, throttle_bucket
  )
  values (
    p_kind,
    p_org_id,
    p_employee_id,
    p_hold_id,
    case when p_method ~ '^[A-Za-z0-9_./-]{1,64}$' then p_method else null end,
    floor(extract(epoch from now()) / 60.0)::bigint
  );
  return true;
exception
  when unique_violation then
    return false;
  when lock_not_available then
    return false;
  when query_canceled then
    return false;
end
$fn$;
revoke all on function public.record_hold_mcp_denial(text, uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.record_hold_mcp_denial(text, uuid, uuid, uuid, text) to service_role;

commit;

-- ROLLBACK (down) — turn HOLD_DENIAL_AUDIT_ENABLED off first.
-- Same statements as supabase/verification/20261020400000_hold_denial_audit_rollback.sql:
--   begin;
--   delete from public.mcp_auth_failures where failure_kind in ('org_on_hold', 'employee_on_hold');
--   drop function if exists public.record_hold_mcp_denial(text, uuid, uuid, uuid, text);
--   drop index if exists public.mcp_auth_failures_hold_denial_throttle_uidx;
--   alter table public.mcp_auth_failures drop column if exists hold_id;
--   alter table public.mcp_auth_failures drop constraint if exists mcp_auth_failures_failure_kind_check;
--   alter table public.mcp_auth_failures add constraint mcp_auth_failures_failure_kind_check
--     check (failure_kind in ('missing_credential', 'invalid', 'expired'));
--   commit;
-- END ROLLBACK

-- /api/mcp auth-failure audit + credentials.last_used_at touch (木村 2026-10-16).
-- Used ONLY with MCP_AUTH_FAILURE_AUDIT_ENABLED (default OFF) for the table;
-- touch_credential_last_used is the missing write for credentials.last_used_at
-- (the column already existed; no app path ever updated it). Additive.
--
-- mcp_auth_failures: kind + optional ids + method. NEVER token, hash, or
-- prefix. Throttle: unique (kind × org × employee × throttle_bucket) plus a
-- 200-rows/hour cap inside record_mcp_auth_failure. throttle_bucket is the
-- 5-minute epoch stored as a column (expression indexes on timestamptz
-- extract() are not IMMUTABLE). RLS on, no policy, service_role only.
-- No FKs (rows survive employee/credential delete).
--
-- touch_credential_last_used: conditional UPDATE last_used_at when null or
-- older than 5 minutes. Single-row PK update + lock/statement timeouts so a
-- contended credentials row cannot deadlock or hang auth. service_role only.
begin;

create table if not exists public.mcp_auth_failures (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  failure_kind text not null check (failure_kind in ('missing_credential', 'invalid', 'expired')),
  org_id uuid,
  employee_id uuid,
  credential_id uuid,
  mcp_method text check (mcp_method is null or mcp_method ~ '^[A-Za-z0-9_./-]{1,64}$'),
  throttle_bucket bigint not null
);
create index if not exists mcp_auth_failures_created_idx
  on public.mcp_auth_failures (created_at desc);
create unique index if not exists mcp_auth_failures_throttle_uidx
  on public.mcp_auth_failures (
    failure_kind,
    (coalesce(org_id, '00000000-0000-0000-0000-000000000000'::uuid)),
    (coalesce(employee_id, '00000000-0000-0000-0000-000000000000'::uuid)),
    throttle_bucket
  );
comment on table public.mcp_auth_failures is
  '/api/mcp auth-failure audit (MCP_AUTH_FAILURE_AUDIT_ENABLED). Kind + optional ids + method only. Never token/hash/prefix. Service role only.';

alter table public.mcp_auth_failures enable row level security;
revoke all on table public.mcp_auth_failures from public, anon, authenticated;
grant select, insert, update, delete on table public.mcp_auth_failures to service_role;

create or replace function public.record_mcp_auth_failure(
  p_kind text,
  p_org_id uuid,
  p_employee_id uuid,
  p_credential_id uuid,
  p_method text
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $fn$
begin
  if p_kind is null or p_kind not in ('missing_credential', 'invalid', 'expired') then
    return false;
  end if;
  if (select count(*)::int from public.mcp_auth_failures where created_at > now() - interval '1 hour') >= 200 then
    return false;
  end if;
  insert into public.mcp_auth_failures (
    failure_kind, org_id, employee_id, credential_id, mcp_method, throttle_bucket
  )
  values (
    p_kind,
    p_org_id,
    p_employee_id,
    p_credential_id,
    case when p_method ~ '^[A-Za-z0-9_./-]{1,64}$' then p_method else null end,
    floor(extract(epoch from now()) / 300.0)::bigint
  );
  return true;
exception
  when unique_violation then
    return false;
end
$fn$;
revoke all on function public.record_mcp_auth_failure(text, uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.record_mcp_auth_failure(text, uuid, uuid, uuid, text) to service_role;

create or replace function public.touch_credential_last_used(p_id uuid)
returns timestamptz
language plpgsql
security definer
set search_path = pg_catalog, public
as $fn$
declare
  v_at timestamptz;
begin
  if p_id is null then
    return null;
  end if;
  perform set_config('lock_timeout', '200ms', true);
  perform set_config('statement_timeout', '250ms', true);
  update public.credentials
  set last_used_at = now()
  where id = p_id
    and revoked_at is null
    and (last_used_at is null or last_used_at < now() - interval '5 minutes')
  returning last_used_at into v_at;
  return v_at;
exception
  when lock_not_available then
    return null;
  when query_canceled then
    return null;
end
$fn$;
revoke all on function public.touch_credential_last_used(uuid) from public, anon, authenticated;
grant execute on function public.touch_credential_last_used(uuid) to service_role;

commit;

-- ROLLBACK (down) — turn MCP_AUTH_FAILURE_AUDIT_ENABLED off first.
-- Same statements as supabase/verification/20261016400000_mcp_auth_failures_rollback.sql:
--   begin;
--   drop function if exists public.record_mcp_auth_failure(text, uuid, uuid, uuid, text);
--   drop function if exists public.touch_credential_last_used(uuid);
--   drop table if exists public.mcp_auth_failures;
--   commit;
-- END ROLLBACK

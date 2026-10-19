-- 社員証 auto-renew (木村 2026-10-16 design, R1). Used ONLY with
-- CREDENTIAL_AUTO_RENEW_ENABLED (default OFF) plus the org allowlist.
-- Additive. Apply BEFORE setting the flag; with the flag OFF nothing here
-- is touched. Design numbered this 20261017100000; that stamp is already
-- used by a verification script, so this file is 20261019100000.
--
-- credential_renewals: one row per old credential × threshold (7d / now).
-- Ids + timestamps + CAS nonce only: no 社員証 secret, prefix, hash, or
-- public key. claim_token is a short-lived CAS nonce so release can undo
-- THIS claimer's mark (same role as claim_credential_reissue); it is not
-- key material and must not be logged.
-- Tenant isolation: org / employee / old+new credentials / approval must
-- all be the same org (trigger credential_renewals_same_org).
-- RLS on, no policy, service_role only.
begin;

create table if not exists public.credential_renewals (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  old_credential_id uuid not null references public.credentials(id) on delete cascade,
  new_credential_id uuid references public.credentials(id) on delete set null,
  approval_id uuid not null references public.approval_requests(id),
  threshold text not null check (threshold in ('7d', 'now')),
  state text not null default 'pending_approval'
    check (state in (
      'pending_approval', 'claimable', 'claimed', 'old_revoked',
      'rejected', 'expired', 'held_blocked'
    )),
  mode text not null default 'gen2' check (mode in ('gen2', 'gen1_http')),
  claimable_until timestamptz,
  overlap_until timestamptz,
  claimed_at timestamptz,
  old_revoked_at timestamptz,
  claim_token text,
  created_at timestamptz not null default now(),
  unique (old_credential_id, threshold)
);
create index if not exists credential_renewals_org_state_idx
  on public.credential_renewals (org_id, state);
create index if not exists credential_renewals_employee_idx
  on public.credential_renewals (employee_id, state);
comment on table public.credential_renewals is
  '社員証 auto-renew (CREDENTIAL_AUTO_RENEW_ENABLED). Ids + timestamps + CAS nonce only. Never secret/hash/prefix/public key. Service role only.';
comment on column public.credential_renewals.claim_token is
  'CAS nonce for claim/release. Not 社員証 secret. Never log.';

alter table public.credential_renewals enable row level security;
revoke all on table public.credential_renewals from public, anon, authenticated;
grant select, insert, update, delete on table public.credential_renewals to service_role;

create or replace function public.credential_renewals_same_org()
returns trigger language plpgsql security invoker set search_path = pg_catalog, public as $crn$
begin
  if not exists (
    select 1 from public.credentials c
    where c.id = new.old_credential_id and c.org_id = new.org_id and c.employee_id = new.employee_id
  ) then
    raise exception 'credential_renewal_cross_org';
  end if;
  if not exists (
    select 1 from public.employees e
    where e.id = new.employee_id and e.org_id = new.org_id
  ) then
    raise exception 'credential_renewal_cross_org';
  end if;
  if not exists (
    select 1 from public.approval_requests a
    where a.id = new.approval_id and a.org_id = new.org_id
  ) then
    raise exception 'credential_renewal_cross_org';
  end if;
  if new.new_credential_id is not null and not exists (
    select 1 from public.credentials c
    where c.id = new.new_credential_id and c.org_id = new.org_id and c.employee_id = new.employee_id
  ) then
    raise exception 'credential_renewal_cross_org';
  end if;
  if new.new_credential_id is not null and new.new_credential_id = new.old_credential_id then
    raise exception 'credential_renewal_cross_org';
  end if;
  return new;
end $crn$;
revoke all on function public.credential_renewals_same_org() from public, anon, authenticated;
drop trigger if exists credential_renewals_same_org on public.credential_renewals;
create trigger credential_renewals_same_org
  before insert or update of old_credential_id, new_credential_id, org_id, employee_id, approval_id
  on public.credential_renewals
  for each row execute function public.credential_renewals_same_org();

-- One conditional UPDATE. READ COMMITTED: concurrent callers serialize on the
-- row; the loser re-checks WHERE and gets 0 rows.
create or replace function public.claim_credential_renewal(
  p_id uuid, p_org uuid, p_employee uuid, p_token text, p_at timestamptz
) returns boolean
language plpgsql security invoker set search_path = pg_catalog, public as $ccr$
declare n integer;
begin
  if p_token is null or length(p_token) < 16 then raise exception 'invalid_claim_token'; end if;
  update public.credential_renewals
     set state = 'claimed',
         claimed_at = p_at,
         claim_token = p_token
   where id = p_id
     and org_id = p_org
     and employee_id = p_employee
     and state = 'claimable'
     and claimable_until >= now()
     and claimed_at is null
     and claim_token is null;
  get diagnostics n = row_count;
  return n = 1;
end $ccr$;

-- Undo only THIS claimer's mark (and only before a new credential id is stored).
create or replace function public.release_credential_renewal(
  p_id uuid, p_org uuid, p_token text
) returns boolean
language plpgsql security invoker set search_path = pg_catalog, public as $rcr$
declare n integer;
begin
  if p_token is null or p_token = '' then return false; end if;
  update public.credential_renewals
     set state = 'claimable',
         claimed_at = null,
         claim_token = null
   where id = p_id
     and org_id = p_org
     and state = 'claimed'
     and claim_token = p_token
     and new_credential_id is null;
  get diagnostics n = row_count;
  return n = 1;
end $rcr$;

-- Revoke the overlapped old credentials row. Already-revoked still returns true
-- when this renewal owns the pair. Never revokes a different org's row.
create or replace function public.revoke_overlapped_old_credential(
  p_renewal uuid, p_org uuid, p_old uuid, p_new uuid
) returns boolean
language plpgsql security invoker set search_path = pg_catalog, public as $roc$
declare n integer;
begin
  if p_renewal is null or p_org is null or p_old is null or p_new is null then
    return false;
  end if;
  if p_old = p_new then return false; end if;
  update public.credentials c
     set revoked_at = coalesce(c.revoked_at, now())
   where c.id = p_old
     and c.org_id = p_org
     and exists (
       select 1 from public.credential_renewals r
        where r.id = p_renewal
          and r.org_id = p_org
          and r.old_credential_id = p_old
          and r.new_credential_id = p_new
     );
  get diagnostics n = row_count;
  if n <> 1 then return false; end if;
  update public.credential_renewals
     set old_revoked_at = coalesce(old_revoked_at, now()),
         state = 'old_revoked'
   where id = p_renewal
     and org_id = p_org
     and old_credential_id = p_old
     and new_credential_id = p_new;
  get diagnostics n = row_count;
  return n = 1;
end $roc$;

revoke all on function public.claim_credential_renewal(uuid, uuid, uuid, text, timestamptz) from public, anon, authenticated;
revoke all on function public.release_credential_renewal(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.revoke_overlapped_old_credential(uuid, uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.claim_credential_renewal(uuid, uuid, uuid, text, timestamptz) to service_role;
grant execute on function public.release_credential_renewal(uuid, uuid, text) to service_role;
grant execute on function public.revoke_overlapped_old_credential(uuid, uuid, uuid, uuid) to service_role;

commit;

-- ROLLBACK (down) — turn CREDENTIAL_AUTO_RENEW_ENABLED off first. Same
-- statements as supabase/verification/20261019100000_credential_auto_renew_rollback.sql:
--   begin;
--   drop function if exists public.claim_credential_renewal(uuid, uuid, uuid, text, timestamptz);
--   drop function if exists public.release_credential_renewal(uuid, uuid, text);
--   drop function if exists public.revoke_overlapped_old_credential(uuid, uuid, uuid, uuid);
--   drop table if exists public.credential_renewals;
--   drop function if exists public.credential_renewals_same_org();
--   commit;
-- END ROLLBACK

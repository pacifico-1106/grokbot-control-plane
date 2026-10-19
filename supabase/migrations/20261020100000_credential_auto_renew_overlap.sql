-- 社員証 auto-renew R3 (重ね置き). Additive functions only.
-- CREDENTIAL_AUTO_RENEW_ENABLED (default OFF) + org allowlist.
-- attach: CAS-store new_credential_id + overlap_until after a successful claim.
-- issue: insert + generation bump + attach in ONE transaction (M2).
-- switchover: revoke old + old_revoked + binding fingerprint CAS in ONE
-- transaction (M1). Audit is written by the caller only after this returns true.
-- timeout revoke: if the new badge is already revoked, expire the renewal and
-- leave the old badge to its 90-day expiry (L2). Otherwise switchover.
-- No secret / prefix / hash / public key / claim_token in comments that could leak.
begin;

create or replace function public.attach_overlapped_new_credential(
  p_id uuid, p_org uuid, p_token text, p_new uuid, p_overlap_until timestamptz
) returns boolean
language plpgsql security invoker set search_path = pg_catalog, public as $aoc$
declare n integer;
begin
  if p_token is null or length(p_token) < 16 then raise exception 'invalid_claim_token'; end if;
  if p_new is null or p_overlap_until is null then return false; end if;
  if not public.credential_renewal_operable(p_id, p_org, true) then return false; end if;
  update public.credential_renewals
     set new_credential_id = p_new,
         overlap_until = p_overlap_until
   where id = p_id
     and org_id = p_org
     and state = 'claimed'
     and claim_token = p_token
     and new_credential_id is null
     and p_new <> old_credential_id;
  get diagnostics n = row_count;
  return n = 1;
end $aoc$;

-- insert new badge + bump generation (fingerprint stays) + attach. One txn.
create or replace function public.issue_overlapped_new_credential(
  p_id uuid,
  p_org uuid,
  p_employee uuid,
  p_token text,
  p_secret_hash text,
  p_secret_prefix text,
  p_expires_at timestamptz,
  p_overlap_until timestamptz,
  p_scopes text[],
  p_allowed_purposes text[],
  p_approval_policy text,
  p_action_limits jsonb,
  p_spend jsonb,
  p_allowed_accounts jsonb
) returns table(new_credential_id uuid, generation integer)
language plpgsql security invoker set search_path = pg_catalog, public as $ion$
declare n integer;
declare new_id uuid;
declare gen integer;
begin
  if p_token is null or length(p_token) < 16 then raise exception 'invalid_claim_token'; end if;
  if p_secret_hash is null or p_secret_hash = '' or p_secret_prefix is null then
    raise exception 'overlap_issue_invalid';
  end if;
  if not public.credential_renewal_operable(p_id, p_org, true) then
    raise exception 'overlap_issue_not_operable';
  end if;
  insert into public.credentials (
    org_id, employee_id, secret_hash, secret_prefix, scopes, allowed_purposes,
    approval_policy, action_limits, spend, allowed_accounts, expires_at
  ) values (
    p_org, p_employee, p_secret_hash, p_secret_prefix,
    coalesce(p_scopes, '{}'), coalesce(p_allowed_purposes, '{}'),
    coalesce(p_approval_policy, 'risk_based'), coalesce(p_action_limits, '{}'::jsonb),
    p_spend, coalesce(p_allowed_accounts, '[]'::jsonb), p_expires_at
  ) returning id into new_id;
  if new_id is null then raise exception 'overlap_insert_failed'; end if;
  update public.employee_bindings
     set credential_generation = credential_generation + 1,
         last_error = null,
         updated_at = now()
   where employee_id = p_employee
     and org_id = p_org
  returning credential_generation into gen;
  if gen is null then raise exception 'overlap_issue_no_binding'; end if;
  update public.credential_renewals
     set new_credential_id = new_id,
         overlap_until = p_overlap_until
   where id = p_id
     and org_id = p_org
     and employee_id = p_employee
     and state = 'claimed'
     and claim_token = p_token
     and new_credential_id is null
     and new_id <> old_credential_id;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'overlap_attach_failed'; end if;
  return query select new_id, gen;
end $ion$;

-- M1: revoke old + mark old_revoked + CAS-move binding fingerprint. One txn.
-- RAISE on a partial write so the first UPDATE never commits alone.
create or replace function public.complete_overlapped_credential_switchover(
  p_renewal uuid, p_org uuid, p_employee uuid, p_old uuid, p_new uuid, p_require_operable boolean
) returns boolean
language plpgsql security invoker set search_path = pg_catalog, public as $cos$
declare n integer;
declare old_hash text;
declare new_hash text;
begin
  if p_renewal is null or p_org is null or p_employee is null or p_old is null or p_new is null then
    return false;
  end if;
  if p_old = p_new then return false; end if;
  if p_require_operable and not public.credential_renewal_operable(p_renewal, p_org, false) then
    return false;
  end if;
  if not exists (
    select 1 from public.credential_renewals r
     where r.id = p_renewal
       and r.org_id = p_org
       and r.employee_id = p_employee
       and r.old_credential_id = p_old
       and r.new_credential_id = p_new
       and r.state in ('claimed', 'old_revoked')
  ) then
    return false;
  end if;
  if exists (
    select 1 from public.credentials c
     where c.id = p_new and c.org_id = p_org and c.revoked_at is not null
  ) then
    return false;
  end if;
  select c.secret_hash into old_hash from public.credentials c where c.id = p_old and c.org_id = p_org;
  select c.secret_hash into new_hash from public.credentials c where c.id = p_new and c.org_id = p_org;
  if old_hash is null or old_hash = '' or new_hash is null or new_hash = '' then
    raise exception 'credential_renewal_switchover_incomplete';
  end if;
  update public.credentials c
     set revoked_at = coalesce(c.revoked_at, now())
   where c.id = p_old
     and c.org_id = p_org;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'credential_renewal_switchover_incomplete'; end if;
  update public.credential_renewals
     set old_revoked_at = coalesce(old_revoked_at, now()),
         state = 'old_revoked'
   where id = p_renewal
     and org_id = p_org
     and old_credential_id = p_old
     and new_credential_id = p_new;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'credential_renewal_switchover_incomplete'; end if;
  update public.employee_bindings
     set credential_fingerprint = new_hash,
         last_error = null,
         updated_at = now()
   where employee_id = p_employee
     and org_id = p_org
     and credential_fingerprint = old_hash;
  get diagnostics n = row_count;
  if n = 1 then return true; end if;
  if exists (
    select 1 from public.employee_bindings b
     where b.employee_id = p_employee
       and b.org_id = p_org
       and b.credential_fingerprint = new_hash
  ) then
    return true;
  end if;
  raise exception 'credential_renewal_switchover_incomplete';
end $cos$;

-- Cron path: do not require hold/active (G1 already blocks use).
-- L2: new already revoked → expire the renewal; do not revoke the old badge.
-- Otherwise M1 switchover (revoke + fingerprint) in this same function call.
create or replace function public.revoke_expired_overlapped_old_credential(
  p_renewal uuid, p_org uuid, p_old uuid, p_new uuid, p_at timestamptz
) returns text
language plpgsql security invoker set search_path = pg_catalog, public as $roc$
declare n integer;
declare emp uuid;
begin
  if p_renewal is null or p_org is null or p_old is null or p_new is null or p_at is null then
    return null;
  end if;
  if p_old = p_new then return null; end if;
  select r.employee_id into emp
    from public.credential_renewals r
   where r.id = p_renewal
     and r.org_id = p_org
     and r.old_credential_id = p_old
     and r.new_credential_id = p_new
     and r.state in ('claimed', 'old_revoked', 'expired')
     and r.overlap_until is not null
     and r.overlap_until < p_at;
  if emp is null then return null; end if;
  if exists (
    select 1 from public.credentials c
     where c.id = p_new and c.org_id = p_org and c.revoked_at is not null
  ) then
    update public.credential_renewals
       set state = 'expired'
     where id = p_renewal
       and org_id = p_org
       and state = 'claimed'
       and old_credential_id = p_old
       and new_credential_id = p_new;
    get diagnostics n = row_count;
    if n = 1 then return 'expired'; end if;
    if exists (
      select 1 from public.credential_renewals r
       where r.id = p_renewal and r.org_id = p_org and r.state = 'expired'
    ) then
      return 'expired';
    end if;
    return null;
  end if;
  if public.complete_overlapped_credential_switchover(p_renewal, p_org, emp, p_old, p_new, false) then
    return 'switched';
  end if;
  return null;
end $roc$;

revoke all on function public.attach_overlapped_new_credential(uuid, uuid, text, uuid, timestamptz)
  from public, anon, authenticated;
revoke all on function public.issue_overlapped_new_credential(uuid, uuid, uuid, text, text, text, timestamptz, timestamptz, text[], text[], text, jsonb, jsonb, jsonb)
  from public, anon, authenticated;
revoke all on function public.complete_overlapped_credential_switchover(uuid, uuid, uuid, uuid, uuid, boolean)
  from public, anon, authenticated;
revoke all on function public.revoke_expired_overlapped_old_credential(uuid, uuid, uuid, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.attach_overlapped_new_credential(uuid, uuid, text, uuid, timestamptz)
  to service_role;
grant execute on function public.issue_overlapped_new_credential(uuid, uuid, uuid, text, text, text, timestamptz, timestamptz, text[], text[], text, jsonb, jsonb, jsonb)
  to service_role;
grant execute on function public.complete_overlapped_credential_switchover(uuid, uuid, uuid, uuid, uuid, boolean)
  to service_role;
grant execute on function public.revoke_expired_overlapped_old_credential(uuid, uuid, uuid, uuid, timestamptz)
  to service_role;

commit;

-- ROLLBACK (down) — turn CREDENTIAL_AUTO_RENEW_ENABLED off first. Same
-- statements as supabase/verification/20261020100000_credential_auto_renew_overlap_rollback.sql:
--   begin;
--   drop function if exists public.revoke_expired_overlapped_old_credential(uuid, uuid, uuid, uuid, timestamptz);
--   drop function if exists public.complete_overlapped_credential_switchover(uuid, uuid, uuid, uuid, uuid, boolean);
--   drop function if exists public.issue_overlapped_new_credential(uuid, uuid, uuid, text, text, text, timestamptz, timestamptz, text[], text[], text, jsonb, jsonb, jsonb);
--   drop function if exists public.attach_overlapped_new_credential(uuid, uuid, text, uuid, timestamptz);
--   commit;
-- END ROLLBACK

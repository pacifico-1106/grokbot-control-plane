-- Rollback for 20261020300000_credential_auto_renew_review_followup.sql.
-- Restores claim / release / gen1 claim / timeout-revoke from 191/201/202.
begin;

drop trigger if exists employees_block_claimable_renewals_on_hold on public.employees;
drop trigger if exists orgs_block_claimable_renewals_on_hold on public.orgs;
drop function if exists public.abort_minted_credential_renewal(uuid, uuid, text, uuid);
drop function if exists public.block_claimable_credential_renewals_on_hold();
drop function if exists public.block_claimable_credential_renewals_on_hold_apply(uuid, uuid);

create or replace function public.claim_credential_renewal(
  p_id uuid, p_org uuid, p_employee uuid, p_token text, p_at timestamptz
) returns boolean
language plpgsql security invoker set search_path = pg_catalog, public as $ccr$
declare n integer;
begin
  if p_token is null or length(p_token) < 16 then raise exception 'invalid_claim_token'; end if;
  if not public.credential_renewal_operable(p_id, p_org, true) then return false; end if;
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

create or replace function public.claim_credential_renewal_gen1_http(
  p_id uuid, p_org uuid, p_employee uuid, p_token text, p_at timestamptz
) returns boolean
language plpgsql security invoker set search_path = pg_catalog, public as $ccg$
declare n integer;
begin
  if p_token is null or length(p_token) < 16 then raise exception 'invalid_claim_token'; end if;
  if not public.credential_renewal_operable(p_id, p_org, true) then return false; end if;
  update public.credential_renewals
     set state = 'claimed',
         claimed_at = p_at,
         claim_token = p_token,
         mode = 'gen1_http'
   where id = p_id
     and org_id = p_org
     and employee_id = p_employee
     and state = 'claimable'
     and mode in ('gen2', 'gen1_http')
     and claimable_until >= now()
     and claimed_at is null
     and claim_token is null;
  get diagnostics n = row_count;
  return n = 1;
end $ccg$;

create or replace function public.release_credential_renewal(
  p_id uuid, p_org uuid, p_token text
) returns boolean
language plpgsql security invoker set search_path = pg_catalog, public as $rcr$
declare n integer;
begin
  if p_token is null or p_token = '' then return false; end if;
  if not public.credential_renewal_operable(p_id, p_org, true) then return false; end if;
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

commit;

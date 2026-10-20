-- 社員証 auto-renew review follow-up (H1 / M1 / M2). Additive REPLACE only.
-- 20261020100000 functions stay on main; this file CREATE OR REPLACE them.
-- CREDENTIAL_AUTO_RENEW_ENABLED + GEN1 HTTP stay default OFF.
-- No secret / prefix / hash / public key / claim_token in comments that could leak.
begin;

-- M1: claimable → held_blocked when a hold starts (stop direction only).
create or replace function public.block_claimable_credential_renewals_on_hold_apply(
  p_org uuid, p_employee uuid
) returns integer
language plpgsql security invoker set search_path = pg_catalog, public as $blk$
declare n integer;
begin
  if p_org is null then return 0; end if;
  update public.credential_renewals
     set state = 'held_blocked'
   where org_id = p_org
     and state = 'claimable'
     and (p_employee is null or employee_id = p_employee);
  get diagnostics n = row_count;
  return n;
end $blk$;

create or replace function public.block_claimable_credential_renewals_on_hold()
returns trigger language plpgsql security invoker set search_path = pg_catalog, public as $btg$
begin
  if new.hold_state is null then
    return new;
  end if;
  if tg_table_name = 'employees' then
    perform public.block_claimable_credential_renewals_on_hold_apply(new.org_id, new.id);
  elsif tg_table_name = 'orgs' then
    perform public.block_claimable_credential_renewals_on_hold_apply(new.id, null);
  end if;
  return new;
end $btg$;

drop trigger if exists employees_block_claimable_renewals_on_hold on public.employees;
create trigger employees_block_claimable_renewals_on_hold
  after update of hold_state on public.employees
  for each row
  when (new.hold_state is not null)
  execute function public.block_claimable_credential_renewals_on_hold();

drop trigger if exists orgs_block_claimable_renewals_on_hold on public.orgs;
create trigger orgs_block_claimable_renewals_on_hold
  after update of hold_state on public.orgs
  for each row
  when (new.hold_state is not null)
  execute function public.block_claimable_credential_renewals_on_hold();

-- M2: CAS UPDATE re-checks operable after row lock and pins approved / unheld / live old.
create or replace function public.claim_credential_renewal(
  p_id uuid, p_org uuid, p_employee uuid, p_token text, p_at timestamptz
) returns boolean
language plpgsql security invoker set search_path = pg_catalog, public as $ccr$
declare n integer;
begin
  if p_token is null or length(p_token) < 16 then raise exception 'invalid_claim_token'; end if;
  perform 1 from public.credential_renewals r where r.id = p_id and r.org_id = p_org for update;
  if not public.credential_renewal_operable(p_id, p_org, true) then return false; end if;
  update public.credential_renewals r
     set state = 'claimed',
         claimed_at = p_at,
         claim_token = p_token
    from public.employees e,
         public.orgs o,
         public.credentials c,
         public.approval_requests a
   where r.id = p_id
     and r.org_id = p_org
     and r.employee_id = p_employee
     and r.state = 'claimable'
     and r.claimable_until >= now()
     and r.claimed_at is null
     and r.claim_token is null
     and e.id = r.employee_id and e.org_id = r.org_id
     and o.id = r.org_id
     and c.id = r.old_credential_id and c.org_id = r.org_id
     and a.id = r.approval_id and a.org_id = r.org_id
     and e.status = 'active'
     and e.hold_state is null
     and o.hold_state is null
     and a.status = 'approved'
     and c.revoked_at is null;
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
  perform 1 from public.credential_renewals r where r.id = p_id and r.org_id = p_org for update;
  if not public.credential_renewal_operable(p_id, p_org, true) then return false; end if;
  update public.credential_renewals r
     set state = 'claimed',
         claimed_at = p_at,
         claim_token = p_token,
         mode = 'gen1_http'
    from public.employees e,
         public.orgs o,
         public.credentials c,
         public.approval_requests a
   where r.id = p_id
     and r.org_id = p_org
     and r.employee_id = p_employee
     and r.state = 'claimable'
     and r.mode in ('gen2', 'gen1_http')
     and r.claimable_until >= now()
     and r.claimed_at is null
     and r.claim_token is null
     and e.id = r.employee_id and e.org_id = r.org_id
     and o.id = r.org_id
     and c.id = r.old_credential_id and c.org_id = r.org_id
     and a.id = r.approval_id and a.org_id = r.org_id
     and e.status = 'active'
     and e.hold_state is null
     and o.hold_state is null
     and a.status = 'approved'
     and c.revoked_at is null;
  get diagnostics n = row_count;
  return n = 1;
end $ccg$;

-- M2: own claimed + null new_id may release without operable.
-- Hold → held_blocked so the window cannot be picked up again.
create or replace function public.release_credential_renewal(
  p_id uuid, p_org uuid, p_token text
) returns boolean
language plpgsql security invoker set search_path = pg_catalog, public as $rcr$
declare n integer;
declare held boolean;
begin
  if p_token is null or p_token = '' then return false; end if;
  perform 1 from public.credential_renewals r where r.id = p_id and r.org_id = p_org for update;
  if not exists (
    select 1 from public.credential_renewals r
     where r.id = p_id
       and r.org_id = p_org
       and r.state = 'claimed'
       and r.claim_token = p_token
       and r.new_credential_id is null
  ) then
    return false;
  end if;
  select exists (
    select 1
      from public.credential_renewals r
      join public.employees e on e.id = r.employee_id and e.org_id = r.org_id
      join public.orgs o on o.id = r.org_id
     where r.id = p_id
       and r.org_id = p_org
       and (e.hold_state is not null or o.hold_state is not null)
  ) into held;
  update public.credential_renewals
     set state = case when held then 'held_blocked' else 'claimable' end,
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

-- H1: unused new badge (last_used_at null) → revoke new, keep old, expire.
-- Binding fingerprint is not moved. Used new → existing switchover.
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
  if exists (
    select 1 from public.credentials c
     where c.id = p_new and c.org_id = p_org and c.last_used_at is null and c.revoked_at is null
  ) then
    update public.credentials c
       set revoked_at = coalesce(c.revoked_at, now())
     where c.id = p_new
       and c.org_id = p_org
       and c.revoked_at is null;
    update public.credential_renewals
       set state = 'expired'
     where id = p_renewal
       and org_id = p_org
       and state = 'claimed'
       and old_credential_id = p_old
       and new_credential_id = p_new;
    get diagnostics n = row_count;
    if n = 1 then return 'unused_new_revoked'; end if;
    if exists (
      select 1 from public.credential_renewals r
       where r.id = p_renewal and r.org_id = p_org and r.state = 'expired'
    ) then
      return 'unused_new_revoked';
    end if;
    return null;
  end if;
  if public.complete_overlapped_credential_switchover(p_renewal, p_org, emp, p_old, p_new, false) then
    return 'switched';
  end if;
  return null;
end $roc$;

-- H1 plan 3: revoke minted new + detach + release (claimable or held_blocked).
create or replace function public.abort_minted_credential_renewal(
  p_id uuid, p_org uuid, p_token text, p_new uuid
) returns boolean
language plpgsql security invoker set search_path = pg_catalog, public as $abr$
declare n integer;
declare held boolean;
begin
  if p_id is null or p_org is null or p_token is null or p_token = '' or p_new is null then
    return false;
  end if;
  perform 1 from public.credential_renewals r where r.id = p_id and r.org_id = p_org for update;
  if not exists (
    select 1 from public.credential_renewals r
     where r.id = p_id
       and r.org_id = p_org
       and r.state = 'claimed'
       and r.claim_token = p_token
       and r.new_credential_id = p_new
  ) then
    return false;
  end if;
  update public.credentials c
     set revoked_at = coalesce(c.revoked_at, now())
   where c.id = p_new
     and c.org_id = p_org;
  update public.credential_renewals
     set new_credential_id = null,
         overlap_until = null
   where id = p_id
     and org_id = p_org
     and state = 'claimed'
     and claim_token = p_token
     and new_credential_id = p_new;
  get diagnostics n = row_count;
  if n <> 1 then return false; end if;
  select exists (
    select 1
      from public.credential_renewals r
      join public.employees e on e.id = r.employee_id and e.org_id = r.org_id
      join public.orgs o on o.id = r.org_id
     where r.id = p_id
       and r.org_id = p_org
       and (e.hold_state is not null or o.hold_state is not null)
  ) into held;
  update public.credential_renewals
     set state = case when held then 'held_blocked' else 'claimable' end,
         claimed_at = null,
         claim_token = null
   where id = p_id
     and org_id = p_org
     and state = 'claimed'
     and claim_token = p_token
     and new_credential_id is null;
  get diagnostics n = row_count;
  return n = 1;
end $abr$;

revoke all on function public.block_claimable_credential_renewals_on_hold_apply(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.block_claimable_credential_renewals_on_hold()
  from public, anon, authenticated;
revoke all on function public.abort_minted_credential_renewal(uuid, uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.block_claimable_credential_renewals_on_hold_apply(uuid, uuid)
  to service_role;
grant execute on function public.abort_minted_credential_renewal(uuid, uuid, text, uuid)
  to service_role;

commit;

-- ROLLBACK (down) — turn CREDENTIAL_AUTO_RENEW_ENABLED off first. Same
-- statements as supabase/verification/20261020300000_credential_auto_renew_review_followup_rollback.sql:
--   begin;
--
--   drop trigger if exists employees_block_claimable_renewals_on_hold on public.employees;
--   drop trigger if exists orgs_block_claimable_renewals_on_hold on public.orgs;
--   drop function if exists public.abort_minted_credential_renewal(uuid, uuid, text, uuid);
--   drop function if exists public.block_claimable_credential_renewals_on_hold();
--   drop function if exists public.block_claimable_credential_renewals_on_hold_apply(uuid, uuid);
--
--   create or replace function public.claim_credential_renewal(
--     p_id uuid, p_org uuid, p_employee uuid, p_token text, p_at timestamptz
--   ) returns boolean
--   language plpgsql security invoker set search_path = pg_catalog, public as $ccr$
--   declare n integer;
--   begin
--     if p_token is null or length(p_token) < 16 then raise exception 'invalid_claim_token'; end if;
--     if not public.credential_renewal_operable(p_id, p_org, true) then return false; end if;
--     update public.credential_renewals
--        set state = 'claimed',
--            claimed_at = p_at,
--            claim_token = p_token
--      where id = p_id
--        and org_id = p_org
--        and employee_id = p_employee
--        and state = 'claimable'
--        and claimable_until >= now()
--        and claimed_at is null
--        and claim_token is null;
--     get diagnostics n = row_count;
--     return n = 1;
--   end $ccr$;
--
--   create or replace function public.claim_credential_renewal_gen1_http(
--     p_id uuid, p_org uuid, p_employee uuid, p_token text, p_at timestamptz
--   ) returns boolean
--   language plpgsql security invoker set search_path = pg_catalog, public as $ccg$
--   declare n integer;
--   begin
--     if p_token is null or length(p_token) < 16 then raise exception 'invalid_claim_token'; end if;
--     if not public.credential_renewal_operable(p_id, p_org, true) then return false; end if;
--     update public.credential_renewals
--        set state = 'claimed',
--            claimed_at = p_at,
--            claim_token = p_token,
--            mode = 'gen1_http'
--      where id = p_id
--        and org_id = p_org
--        and employee_id = p_employee
--        and state = 'claimable'
--        and mode in ('gen2', 'gen1_http')
--        and claimable_until >= now()
--        and claimed_at is null
--        and claim_token is null;
--     get diagnostics n = row_count;
--     return n = 1;
--   end $ccg$;
--
--   create or replace function public.release_credential_renewal(
--     p_id uuid, p_org uuid, p_token text
--   ) returns boolean
--   language plpgsql security invoker set search_path = pg_catalog, public as $rcr$
--   declare n integer;
--   begin
--     if p_token is null or p_token = '' then return false; end if;
--     if not public.credential_renewal_operable(p_id, p_org, true) then return false; end if;
--     update public.credential_renewals
--        set state = 'claimable',
--            claimed_at = null,
--            claim_token = null
--      where id = p_id
--        and org_id = p_org
--        and state = 'claimed'
--        and claim_token = p_token
--        and new_credential_id is null;
--     get diagnostics n = row_count;
--     return n = 1;
--   end $rcr$;
--
--   create or replace function public.revoke_expired_overlapped_old_credential(
--     p_renewal uuid, p_org uuid, p_old uuid, p_new uuid, p_at timestamptz
--   ) returns text
--   language plpgsql security invoker set search_path = pg_catalog, public as $roc$
--   declare n integer;
--   declare emp uuid;
--   begin
--     if p_renewal is null or p_org is null or p_old is null or p_new is null or p_at is null then
--       return null;
--     end if;
--     if p_old = p_new then return null; end if;
--     select r.employee_id into emp
--       from public.credential_renewals r
--      where r.id = p_renewal
--        and r.org_id = p_org
--        and r.old_credential_id = p_old
--        and r.new_credential_id = p_new
--        and r.state in ('claimed', 'old_revoked', 'expired')
--        and r.overlap_until is not null
--        and r.overlap_until < p_at;
--     if emp is null then return null; end if;
--     if exists (
--       select 1 from public.credentials c
--        where c.id = p_new and c.org_id = p_org and c.revoked_at is not null
--     ) then
--       update public.credential_renewals
--          set state = 'expired'
--        where id = p_renewal
--          and org_id = p_org
--          and state = 'claimed'
--          and old_credential_id = p_old
--          and new_credential_id = p_new;
--       get diagnostics n = row_count;
--       if n = 1 then return 'expired'; end if;
--       if exists (
--         select 1 from public.credential_renewals r
--          where r.id = p_renewal and r.org_id = p_org and r.state = 'expired'
--       ) then
--         return 'expired';
--       end if;
--       return null;
--     end if;
--     if public.complete_overlapped_credential_switchover(p_renewal, p_org, emp, p_old, p_new, false) then
--       return 'switched';
--     end if;
--     return null;
--   end $roc$;
--
--   commit;
-- END ROLLBACK

-- 社員証 auto-renew R3 (重ね置き). Additive functions only.
-- CREDENTIAL_AUTO_RENEW_ENABLED (default OFF) + org allowlist.
-- attach: CAS-store new_credential_id + overlap_until after a successful claim.
-- timeout revoke: overlap_until elapsed → revoke old even when hold/status would
-- block the live-old operable check (cron must still finish the switch).
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

-- Cron path: do not require hold/active (G1 already blocks use; old must still expire).
create or replace function public.revoke_expired_overlapped_old_credential(
  p_renewal uuid, p_org uuid, p_old uuid, p_new uuid, p_at timestamptz
) returns boolean
language plpgsql security invoker set search_path = pg_catalog, public as $roc$
declare n integer;
begin
  if p_renewal is null or p_org is null or p_old is null or p_new is null or p_at is null then
    return false;
  end if;
  if p_old = p_new then return false; end if;
  if not exists (
    select 1 from public.credential_renewals r
     where r.id = p_renewal
       and r.org_id = p_org
       and r.old_credential_id = p_old
       and r.new_credential_id = p_new
       and r.state in ('claimed', 'old_revoked')
       and r.overlap_until is not null
       and r.overlap_until < p_at
  ) then
    return false;
  end if;
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
  if n <> 1 then
    raise exception 'credential_renewal_revoke_incomplete';
  end if;
  return true;
end $roc$;

revoke all on function public.attach_overlapped_new_credential(uuid, uuid, text, uuid, timestamptz)
  from public, anon, authenticated;
revoke all on function public.revoke_expired_overlapped_old_credential(uuid, uuid, uuid, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.attach_overlapped_new_credential(uuid, uuid, text, uuid, timestamptz)
  to service_role;
grant execute on function public.revoke_expired_overlapped_old_credential(uuid, uuid, uuid, uuid, timestamptz)
  to service_role;

commit;

-- ROLLBACK (down) — turn CREDENTIAL_AUTO_RENEW_ENABLED off first. Same
-- statements as supabase/verification/20261020100000_credential_auto_renew_overlap_rollback.sql:
--   begin;
--   drop function if exists public.revoke_expired_overlapped_old_credential(uuid, uuid, uuid, uuid, timestamptz);
--   drop function if exists public.attach_overlapped_new_credential(uuid, uuid, text, uuid, timestamptz);
--   commit;
-- END ROLLBACK

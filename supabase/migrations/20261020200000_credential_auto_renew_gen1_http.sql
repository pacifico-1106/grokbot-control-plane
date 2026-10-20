-- 社員証 auto-renew R8 (gen1 HTTP one-time claim). Additive function only.
-- CREDENTIAL_AUTO_RENEW_GEN1_HTTP_ENABLED (default OFF) + org allowlist.
-- Same CAS as claim_credential_renewal, plus pin mode=gen1_http so gen2
-- register cannot also take the window. Reuses credential_renewal_operable
-- (active + unheld + approved ticket + live old badge).
-- No secret / prefix / hash / public key / claim_token in comments that could leak.
begin;

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

revoke all on function public.claim_credential_renewal_gen1_http(uuid, uuid, uuid, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.claim_credential_renewal_gen1_http(uuid, uuid, uuid, text, timestamptz)
  to service_role;

commit;

-- ROLLBACK (down) — turn CREDENTIAL_AUTO_RENEW_GEN1_HTTP_ENABLED off first. Same
-- statements as supabase/verification/20261020200000_credential_auto_renew_gen1_http_rollback.sql:
--   begin;
--   drop function if exists public.claim_credential_renewal_gen1_http(uuid, uuid, uuid, text, timestamptz);
--   commit;
-- END ROLLBACK

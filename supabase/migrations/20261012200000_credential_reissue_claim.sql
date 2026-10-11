-- 社員証 reissue pickup claim (木村 2026-10-12, #332 follow-up). Used ONLY with
-- ADMIN_MCP_CREDENTIAL_REISSUE_ENABLED (default OFF). Adds 2 functions, no
-- table, no data change. Apply BEFORE setting the flag.
--
-- claim_credential_reissue: ONE conditional UPDATE sets
-- metadata.credentialReissue = {claimToken, redeemedAt, redeemedByMemberId}
-- only while the ticket is this org's, this tool's, approved and not yet
-- claimed. Concurrent callers serialize on the row lock; READ COMMITTED
-- re-checks the WHERE after the winner commits → exactly one true.
-- release_credential_reissue: removes the mark only when the claim token (and
-- org) match — a caller can never release someone else's claim.
-- security invoker + EXECUTE for service_role only (same as merge_approval_metadata).
begin;

create or replace function public.claim_credential_reissue(
  p_id uuid, p_org uuid, p_token text, p_member text, p_at timestamptz
) returns boolean
language plpgsql security invoker set search_path = pg_catalog, public as $crc$
declare n integer;
begin
  if p_token is null or length(p_token) < 16 then raise exception 'invalid_claim_token'; end if;
  update public.approval_requests
     set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
           'credentialReissue',
           jsonb_build_object('claimToken', p_token, 'redeemedAt', p_at, 'redeemedByMemberId', p_member))
   where id = p_id
     and org_id = p_org
     and status = 'approved'
     and coalesce(metadata->>'adminTool', tool) = 'employees.credential.reissue'
     and coalesce(metadata->'credentialReissue'->>'redeemedAt', '') = '';
  get diagnostics n = row_count;
  return n = 1;
end $crc$;

create or replace function public.release_credential_reissue(
  p_id uuid, p_org uuid, p_token text
) returns boolean
language plpgsql security invoker set search_path = pg_catalog, public as $crr$
declare n integer;
begin
  if p_token is null or p_token = '' then return false; end if;
  update public.approval_requests
     set metadata = metadata - 'credentialReissue'
   where id = p_id
     and org_id = p_org
     and coalesce(metadata->>'adminTool', tool) = 'employees.credential.reissue'
     and metadata->'credentialReissue'->>'claimToken' = p_token;
  get diagnostics n = row_count;
  return n = 1;
end $crr$;

revoke all on function public.claim_credential_reissue(uuid, uuid, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.release_credential_reissue(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.claim_credential_reissue(uuid, uuid, text, text, timestamptz) to service_role;
grant execute on function public.release_credential_reissue(uuid, uuid, text) to service_role;

commit;

-- ROLLBACK (down) — turn ADMIN_MCP_CREDENTIAL_REISSUE_ENABLED off first. Same
-- statements as supabase/verification/20261012200000_credential_reissue_claim_rollback.sql:
--   begin;
--   drop function if exists public.claim_credential_reissue(uuid, uuid, text, text, timestamptz);
--   drop function if exists public.release_credential_reissue(uuid, uuid, text);
--   commit;
-- END ROLLBACK

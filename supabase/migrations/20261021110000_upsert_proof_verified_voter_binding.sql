-- M4 / M2: atomic proof-verified voter binding (no get-then-upsert race).
-- Concurrent first INSERTs must not last-writer-win: ON CONFLICT updates only
-- when the existing row is revoked, unverified, expired, or the same member.
-- Zero updated rows → bound_to_other_member.
-- Flags that call upsertProofVerifiedVoterBinding default OFF; apply before ON.
begin;
set local lock_timeout = '5s';

create or replace function public.upsert_proof_verified_voter_binding(
  p_org uuid,
  p_provider text,
  p_channel_key text,
  p_external_user_id text,
  p_member_id uuid,
  p_team_id text,
  p_expires_at timestamptz
) returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  r public.approval_workflow_voter_bindings;
  now_ts timestamptz := now();
begin
  if p_org is null or p_provider is null or p_channel_key is null
     or p_external_user_id is null or p_member_id is null or p_expires_at is null then
    return jsonb_build_object('ok', false, 'reason', 'invalid_input');
  end if;

  insert into public.approval_workflow_voter_bindings (
    org_id, provider, channel_key, external_user_id, member_id, team_id,
    expires_at, revoked_at, verified_at, verification_hash, verification_expiry,
    verification_nonce, failed_verification_attempts, updated_at
  ) values (
    p_org, p_provider, p_channel_key, p_external_user_id, p_member_id, p_team_id,
    p_expires_at, null, now_ts, null, null, null, 0, now_ts
  )
  on conflict (org_id, provider, channel_key, external_user_id) do update
    set member_id = excluded.member_id,
        team_id = excluded.team_id,
        expires_at = excluded.expires_at,
        revoked_at = null,
        verified_at = excluded.verified_at,
        verification_hash = null,
        verification_expiry = null,
        verification_nonce = null,
        failed_verification_attempts = 0,
        updated_at = excluded.updated_at
  where approval_workflow_voter_bindings.revoked_at is not null
     or approval_workflow_voter_bindings.verified_at is null
     or (approval_workflow_voter_bindings.expires_at is not null
         and approval_workflow_voter_bindings.expires_at <= now_ts)
     or approval_workflow_voter_bindings.member_id is not distinct from excluded.member_id
  returning * into r;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'bound_to_other_member');
  end if;

  return jsonb_build_object('ok', true, 'row', to_jsonb(r));
end;
$$;

revoke all on function public.upsert_proof_verified_voter_binding(uuid, text, text, text, uuid, text, timestamptz) from public, anon, authenticated;
grant execute on function public.upsert_proof_verified_voter_binding(uuid, text, text, text, uuid, text, timestamptz) to service_role;

comment on function public.upsert_proof_verified_voter_binding(uuid, text, text, text, uuid, text, timestamptz) is
  'Atomic proof-verified voter binding. ON CONFLICT updates only revoked / unverified / expired / same member; else bound_to_other_member.';

commit;

-- ROLLBACK (down)
-- supabase/verification/20261021110000_upsert_proof_verified_voter_binding_rollback.sql
--   begin;
--   set local lock_timeout = '5s';
--   drop function if exists public.upsert_proof_verified_voter_binding(uuid, text, text, text, uuid, text, timestamptz);
--   commit;
-- END ROLLBACK

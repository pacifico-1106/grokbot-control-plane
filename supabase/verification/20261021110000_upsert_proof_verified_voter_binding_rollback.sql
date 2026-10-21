begin;
set local lock_timeout = '5s';
drop function if exists public.upsert_proof_verified_voter_binding(uuid, text, text, text, uuid, text, timestamptz);
commit;

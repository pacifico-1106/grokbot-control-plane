-- Rollback for supabase/migrations/20261005200000_duplicate_post_guard_v2.sql.
-- Run only after DUPLICATE_GUARD_V2_ENABLED is OFF in every environment
-- (COMM_REPLY_DEDUP_ENABLED v1 keeps working: claim_comm_reply_send and
-- finish_comm_reply_send are untouched). Exercised by scripts/test-db-local.py
-- (rollback, v1 claim, then re-apply).
begin;
drop function if exists public.release_uncertain_outbound_send(uuid, uuid, uuid);
drop function if exists public.claim_outbound_send_v2(uuid, uuid, text, text, text, text, integer[], text, uuid, integer, double precision, integer, boolean, text, boolean);
drop function if exists public.outbound_sketch_similarity(integer[], integer[]);
drop index if exists public.comm_reply_send_fingerprints_channel_idx;
drop index if exists public.comm_reply_send_fingerprints_job_idx;
-- sns.publish rows only exist with v2; the v1 tool check cannot hold them.
delete from public.comm_reply_send_fingerprints where tool = 'sns.publish';
alter table public.comm_reply_send_fingerprints drop constraint if exists comm_reply_send_fingerprints_tool_check;
alter table public.comm_reply_send_fingerprints add constraint comm_reply_send_fingerprints_tool_check
  check (tool in ('comm.reply', 'comm.send', 'slack.post', 'slack.post_external'));
alter table public.comm_reply_send_fingerprints drop constraint if exists comm_reply_send_fingerprints_channel_key_check;
alter table public.comm_reply_send_fingerprints drop constraint if exists comm_reply_send_fingerprints_job_key_check;
alter table public.comm_reply_send_fingerprints drop column if exists channel_key;
alter table public.comm_reply_send_fingerprints drop column if exists job_key;
commit;

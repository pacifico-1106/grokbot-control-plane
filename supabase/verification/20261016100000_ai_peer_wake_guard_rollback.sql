-- Rollback for 20261016100000_ai_peer_wake_guard.sql (same statements as
-- the migration's ROLLBACK block). Turn AI_PEER_WAKE_ALLOWLIST_ENABLED and
-- AI_PEER_WAKE_THREAD_GUARD_ENABLED off first.
begin;
drop function if exists public.resume_ai_peer_wake_thread(uuid, uuid, text);
drop function if exists public.stop_ai_peer_wake_thread(uuid, uuid, text);
drop function if exists public.claim_ai_peer_wake(uuid, text, text, text, text, integer, integer);
drop table if exists public.ai_peer_wake_threads;
drop table if exists public.ai_peer_wake_allowlist;
drop function if exists public.ai_peer_wake_allowlist_guard();
commit;

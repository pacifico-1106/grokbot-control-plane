-- Rollback for 20261009100000_thread_single_flight.sql (same statements as the
-- migration's ROLLBACK block). Turn THREAD_SINGLE_FLIGHT_ENABLED off first.
begin;
drop function if exists public.record_thread_self_post(uuid, uuid, text, bigint, text);
drop function if exists public.release_thread_send_lease(uuid, text, uuid);
drop function if exists public.acquire_thread_send_lease(uuid, text, uuid, uuid, integer);
drop table if exists public.thread_self_posts;
drop table if exists public.thread_send_leases;
commit;

-- Rollback for 20261009150000_thread_single_flight_preflag.sql (same statements as the
-- migration's ROLLBACK block). Turn THREAD_SINGLE_FLIGHT_ENABLED off first.
begin;
drop function if exists public.record_thread_wake_point(uuid, uuid, text, bigint);
drop table if exists public.thread_wake_points;
drop function if exists public.close_approval_without_send(uuid, uuid, text[], text, jsonb);
drop function if exists public.acquire_thread_send_lease(uuid, text, uuid, uuid, integer, text);
alter table public.thread_send_leases drop constraint if exists thread_send_leases_job_key_check;
alter table public.thread_send_leases drop column if exists job_key;
create or replace function public.record_thread_self_post(
  p_org uuid, p_employee uuid, p_thread_key text, p_message_micros bigint, p_job_key text)
returns boolean language plpgsql security invoker set search_path = pg_catalog, public as $f$
begin
  if p_org is null or p_employee is null
    or p_thread_key is null or p_thread_key !~ '^[0-9a-f]{64}$'
    or p_message_micros is null or p_message_micros <= 0
    or (p_job_key is not null and p_job_key !~ '^[0-9a-f]{64}$') then
    return false;
  end if;
  if not exists (select 1 from public.employees e where e.id = p_employee and e.org_id = p_org) then
    return false;
  end if;
  delete from public.thread_self_posts
    where org_id = p_org and updated_at < now() - interval '30 days';
  insert into public.thread_self_posts as p (org_id, employee_id, thread_key, message_micros, job_key, updated_at)
    values (p_org, p_employee, p_thread_key, p_message_micros, p_job_key, now())
    on conflict (org_id, employee_id, thread_key) do update
      set message_micros = excluded.message_micros, job_key = excluded.job_key, updated_at = now()
      where p.message_micros < excluded.message_micros;
  return true;
end $f$;
revoke all on function public.record_thread_self_post(uuid, uuid, text, bigint, text) from public, anon, authenticated;
grant execute on function public.record_thread_self_post(uuid, uuid, text, bigint, text) to service_role;
alter table public.thread_self_posts drop constraint if exists thread_self_posts_job_first_micros_check;
alter table public.thread_self_posts drop column if exists job_first_micros;
commit;

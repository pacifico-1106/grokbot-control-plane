-- Auth-link mail.send CAS ( #426 follow-up M1 ).
-- SECRET_AUTH_ACTION_LINK_ENABLED stays OFF until Kimura applies this.
-- Additive RPCs only: claim / release / consume / mark uncertain.
-- No table, no column. Apply BEFORE turning the flag ON.
--
-- claim_auth_link_send: ONE conditional UPDATE takes status=sending
-- only while the ticket is this org's, approved, authActionLink, and
-- not already sending / consumed / uncertain. Concurrent callers
-- serialize on the row; READ COMMITTED re-checks WHERE → exactly one
-- 'claimed'.
-- release_auth_link_send: clears sending only when this job holds it
-- (retryable provider failure).
-- consume_auth_link_send: marks consumed only when this job holds sending
-- (provider send succeeded).
-- mark_auth_link_send_uncertain: terminal unknown outcome (do not retry;
-- the provider may have accepted).
begin;

create or replace function public.claim_auth_link_send(
  p_id uuid, p_org uuid, p_job_id text, p_at timestamptz
) returns text
language plpgsql security invoker set search_path = pg_catalog, public as $cals$
declare
  n integer;
  cur text;
  consumed text;
begin
  if p_job_id is null or length(p_job_id) < 1 then
    raise exception 'invalid_job_id';
  end if;
  update public.approval_requests
     set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
           'authLinkFulfillment',
           jsonb_build_object(
             'status', 'sending',
             'sendingAt', p_at,
             'sendingByJobId', p_job_id,
             'consumed', false
           ))
   where id = p_id
     and org_id = p_org
     and status = 'approved'
     and coalesce(metadata->>'authActionLink', '') = 'true'
     and coalesce(metadata->'authLinkFulfillment'->>'consumed', 'false') <> 'true'
     and coalesce(metadata->'authLinkFulfillment'->>'status', '') not in ('sending', 'consumed', 'uncertain');
  get diagnostics n = row_count;
  if n = 1 then
    return 'claimed';
  end if;
  select
    metadata->'authLinkFulfillment'->>'status',
    metadata->'authLinkFulfillment'->>'consumed'
    into cur, consumed
    from public.approval_requests
   where id = p_id and org_id = p_org;
  if not found then
    return 'not_found';
  end if;
  if consumed = 'true' or cur = 'consumed' then
    return 'consumed';
  end if;
  if cur = 'uncertain' then
    return 'uncertain';
  end if;
  if cur = 'sending' then
    return 'sending';
  end if;
  return 'not_found';
end $cals$;

create or replace function public.release_auth_link_send(
  p_id uuid, p_org uuid, p_job_id text
) returns boolean
language plpgsql security invoker set search_path = pg_catalog, public as $rals$
declare n integer;
begin
  if p_job_id is null or p_job_id = '' then return false; end if;
  update public.approval_requests
     set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
           'authLinkFulfillment',
           jsonb_build_object('status', 'failed', 'consumed', false))
   where id = p_id
     and org_id = p_org
     and metadata->'authLinkFulfillment'->>'status' = 'sending'
     and metadata->'authLinkFulfillment'->>'sendingByJobId' = p_job_id;
  get diagnostics n = row_count;
  return n = 1;
end $rals$;

create or replace function public.consume_auth_link_send(
  p_id uuid, p_org uuid, p_job_id text, p_at timestamptz
) returns boolean
language plpgsql security invoker set search_path = pg_catalog, public as $nals$
declare n integer;
begin
  if p_job_id is null or p_job_id = '' then return false; end if;
  update public.approval_requests
     set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
           'authLinkFulfillment',
           jsonb_build_object(
             'status', 'consumed',
             'consumed', true,
             'consumedAt', p_at,
             'consumedByJobId', p_job_id
           ))
   where id = p_id
     and org_id = p_org
     and metadata->'authLinkFulfillment'->>'status' = 'sending'
     and metadata->'authLinkFulfillment'->>'sendingByJobId' = p_job_id;
  get diagnostics n = row_count;
  return n = 1;
end $nals$;

create or replace function public.mark_auth_link_send_uncertain(
  p_id uuid, p_org uuid, p_job_id text, p_at timestamptz
) returns boolean
language plpgsql security invoker set search_path = pg_catalog, public as $uals$
declare n integer;
begin
  if p_job_id is null or p_job_id = '' then return false; end if;
  update public.approval_requests
     set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
           'authLinkFulfillment',
           jsonb_build_object(
             'status', 'uncertain',
             'consumed', false,
             'uncertainAt', p_at,
             'uncertainByJobId', p_job_id
           ))
   where id = p_id
     and org_id = p_org
     and metadata->'authLinkFulfillment'->>'status' = 'sending'
     and metadata->'authLinkFulfillment'->>'sendingByJobId' = p_job_id;
  get diagnostics n = row_count;
  return n = 1;
end $uals$;

revoke all on function public.claim_auth_link_send(uuid, uuid, text, timestamptz) from public, anon, authenticated;
revoke all on function public.release_auth_link_send(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.consume_auth_link_send(uuid, uuid, text, timestamptz) from public, anon, authenticated;
revoke all on function public.mark_auth_link_send_uncertain(uuid, uuid, text, timestamptz) from public, anon, authenticated;
grant execute on function public.claim_auth_link_send(uuid, uuid, text, timestamptz) to service_role;
grant execute on function public.release_auth_link_send(uuid, uuid, text) to service_role;
grant execute on function public.consume_auth_link_send(uuid, uuid, text, timestamptz) to service_role;
grant execute on function public.mark_auth_link_send_uncertain(uuid, uuid, text, timestamptz) to service_role;

commit;

-- ROLLBACK (down) — keep SECRET_AUTH_ACTION_LINK_ENABLED off. Same
-- statements as supabase/verification/20261021120000_auth_link_send_claim_rollback.sql:
--   begin;
--   drop function if exists public.claim_auth_link_send(uuid, uuid, text, timestamptz);
--   drop function if exists public.release_auth_link_send(uuid, uuid, text);
--   drop function if exists public.consume_auth_link_send(uuid, uuid, text, timestamptz);
--   drop function if exists public.mark_auth_link_send_uncertain(uuid, uuid, text, timestamptz);
--   commit;
-- END ROLLBACK

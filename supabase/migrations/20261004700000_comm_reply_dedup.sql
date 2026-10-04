-- Duplicate-reply prevention for conversation tools (2026-10-04 incident follow-up).
-- Additive and re-applicable. Apply BEFORE setting COMM_REPLY_DEDUP_ENABLED=true;
-- with the flag OFF the application never touches anything added here.
--
-- 1. approval_requests.status gains 'superseded' (closed without sending because
--    the conversation already moved on). Every existing status is kept.
-- 2. guard_workflow_approval_status(): closing transitions pending|approved →
--    superseded|expired (and superseded → expired, used by the rollback) never
--    approve anything, so they are allowed even when a
--    workflow instance exists (otherwise the F8 guard raises
--    workflow_resolution_required). Every other transition is unchanged.
-- 3. comm_reply_send_fingerprints: hash-only send ledger. Holds org, employee,
--    keyed HMAC of the conversation, keyed HMAC of the normalized body, keyed
--    MinHash sketch, tool, approval id, state and timestamps. NEVER the body.
--    RLS on, no policies; anon / authenticated have no access; service_role only.
-- 4. claim_comm_reply_send / finish_comm_reply_send (service_role only):
--    atomic per org + employee + conversation (transaction advisory lock), so
--    two concurrent identical sends cannot both be claimed.
--    claim → denied     invalid input, employee not in org, approval not in org/employee
--            superseded p_approval given and the conversation already has a ledger
--                       row created after that approval (other than its own)
--                       whose body is the same (hash) or similar (sketch
--                       similarity ≥ p_similarity) — the same criterion as
--                       duplicate. A reply about another matter does not
--                       supersede (木村 2026-10-04); not limited to the window.
--            duplicate  same body hash (exact) or sketch similarity ≥ p_similarity
--                       within p_window_seconds
--            claimed    a 'reserved' row was inserted; finish with sent|failed|uncertain
--    finish → failed deletes the reserved row (a retry is not a duplicate);
--             sent / uncertain keep it.
--    Rows older than p_retention_seconds are deleted opportunistically on claim.
begin;

-- 1 ----------------------------------------------------------------------------
alter table public.approval_requests drop constraint if exists approval_requests_status_check;
alter table public.approval_requests add constraint approval_requests_status_check
  check (status in ('pending', 'approved', 'rejected', 'expired', 'revision_requested', 'superseded'));

-- 2 ----------------------------------------------------------------------------
create or replace function public.guard_workflow_approval_status()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $f8$
declare w public.approval_workflow_instances; p jsonb;
begin
  if new.status is not distinct from old.status then return new; end if;
  -- Closing without sending (duplicate-reply prevention / expiry) never approves.
  if new.status in ('superseded','expired') and old.status in ('pending','approved','superseded') then return new; end if;
  select * into w from public.approval_workflow_instances where approval_id=old.id and org_id=old.org_id;
  if found then
    if new.status not in ('approved','rejected') or new.status<>w.status
      or (new.status='approved' and not public.workflow_instance_satisfied(w.id,old.org_id)) then
      raise exception 'workflow_resolution_required'; end if;
  elsif not old.workflow_initialized then
    -- No recursive UPDATE of this same row inside a BEFORE UPDATE trigger.
    select coalesce(e.approval_workflow_policy,o.approval_workflow_policy) into p
      from public.orgs o left join public.employees e on e.id=old.employee_id and e.org_id=o.id where o.id=old.org_id;
    if p is not null then raise exception 'workflow_initialization_required'; end if;
    new.workflow_initialized:=true;
  end if;
  return new;
end $f8$;

-- 3 ----------------------------------------------------------------------------
create table if not exists public.comm_reply_send_fingerprints (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  conversation_key text not null check (conversation_key ~ '^[0-9a-f]{64}$'),
  body_hash text not null check (body_hash ~ '^[0-9a-f]{64}$'),
  sketch integer[] check (sketch is null or cardinality(sketch) = 128),
  tool text not null check (tool in ('comm.reply', 'comm.send', 'slack.post', 'slack.post_external')),
  approval_id uuid references public.approval_requests(id) on delete set null,
  state text not null default 'reserved' check (state in ('reserved', 'sent', 'uncertain')),
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index if not exists comm_reply_send_fingerprints_conv_idx
  on public.comm_reply_send_fingerprints (org_id, employee_id, conversation_key, created_at desc);
create index if not exists comm_reply_send_fingerprints_created_idx
  on public.comm_reply_send_fingerprints (created_at);
alter table public.comm_reply_send_fingerprints enable row level security;
revoke all on table public.comm_reply_send_fingerprints from public, anon, authenticated;
grant select, insert, update, delete on table public.comm_reply_send_fingerprints to service_role;

-- 4 ----------------------------------------------------------------------------
create or replace function public.claim_comm_reply_send(
  p_org uuid, p_employee uuid, p_conversation_key text, p_body_hash text, p_sketch integer[],
  p_tool text, p_approval uuid, p_window_seconds integer, p_similarity double precision,
  p_retention_seconds integer)
returns jsonb language plpgsql security invoker set search_path = pg_catalog, public as $$
declare
  a_created timestamptz;
  r record;
  best_sim double precision := 0;
  best_at timestamptz;
  sim double precision;
  new_id uuid;
begin
  if p_org is null or p_employee is null
    or p_conversation_key is null or p_conversation_key !~ '^[0-9a-f]{64}$'
    or p_body_hash is null or p_body_hash !~ '^[0-9a-f]{64}$'
    or (p_sketch is not null and cardinality(p_sketch) <> 128)
    or p_tool is null or p_tool not in ('comm.reply', 'comm.send', 'slack.post', 'slack.post_external')
    or p_window_seconds is null or p_window_seconds < 1 or p_window_seconds > 604800
    or (p_similarity is not null and (p_similarity < 0.5 or p_similarity > 1))
    or p_retention_seconds is null or p_retention_seconds < p_window_seconds or p_retention_seconds > 2592000 then
    return jsonb_build_object('state', 'denied');
  end if;
  if not exists (select 1 from public.employees e where e.id = p_employee and e.org_id = p_org) then
    return jsonb_build_object('state', 'denied');
  end if;
  if p_approval is not null then
    select ar.created_at into a_created from public.approval_requests ar
      where ar.id = p_approval and ar.org_id = p_org and ar.employee_id = p_employee;
    if not found then return jsonb_build_object('state', 'denied'); end if;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'comm_reply_send:' || p_org::text || ':' || p_employee::text || ':' || p_conversation_key, 0));

  delete from public.comm_reply_send_fingerprints
    where created_at < now() - make_interval(secs => p_retention_seconds);

  if p_approval is not null then
    -- Replied after the approval was created with the same / a similar body.
    select f.created_at into best_at from public.comm_reply_send_fingerprints f
      where f.org_id = p_org and f.employee_id = p_employee and f.conversation_key = p_conversation_key
        and f.created_at > a_created and f.approval_id is distinct from p_approval
        and f.body_hash = p_body_hash
      order by f.created_at asc limit 1;
    if found then
      return jsonb_build_object('state', 'superseded', 'replied_at', best_at, 'match', 'exact', 'similarity', 1);
    end if;
    if p_similarity is not null and p_sketch is not null then
      best_at := null;
      for r in
        select f.sketch, f.created_at from public.comm_reply_send_fingerprints f
          where f.org_id = p_org and f.employee_id = p_employee and f.conversation_key = p_conversation_key
            and f.created_at > a_created and f.approval_id is distinct from p_approval
            and f.sketch is not null
          order by f.created_at asc limit 200
      loop
        select count(*)::double precision / 128 into sim
          from unnest(r.sketch, p_sketch) as u(x, y) where u.x = u.y;
        if sim >= p_similarity and sim > best_sim then
          best_sim := sim;
          best_at := r.created_at;
        end if;
      end loop;
      if best_at is not null then
        return jsonb_build_object('state', 'superseded', 'replied_at', best_at, 'match', 'similar', 'similarity', best_sim);
      end if;
      best_sim := 0;
    end if;
  end if;

  select f.created_at into best_at from public.comm_reply_send_fingerprints f
    where f.org_id = p_org and f.employee_id = p_employee and f.conversation_key = p_conversation_key
      and f.created_at >= now() - make_interval(secs => p_window_seconds)
      and f.body_hash = p_body_hash
    order by f.created_at desc limit 1;
  if found then
    return jsonb_build_object('state', 'duplicate', 'match', 'exact', 'similarity', 1, 'matched_at', best_at);
  end if;

  if p_similarity is not null and p_sketch is not null then
    best_at := null;
    for r in
      select f.sketch, f.created_at from public.comm_reply_send_fingerprints f
        where f.org_id = p_org and f.employee_id = p_employee and f.conversation_key = p_conversation_key
          and f.created_at >= now() - make_interval(secs => p_window_seconds)
          and f.sketch is not null
        order by f.created_at desc limit 200
    loop
      select count(*)::double precision / 128 into sim
        from unnest(r.sketch, p_sketch) as u(x, y) where u.x = u.y;
      if sim >= p_similarity and sim > best_sim then
        best_sim := sim;
        best_at := r.created_at;
      end if;
    end loop;
    if best_at is not null then
      return jsonb_build_object('state', 'duplicate', 'match', 'similar', 'similarity', best_sim, 'matched_at', best_at);
    end if;
  end if;

  insert into public.comm_reply_send_fingerprints
    (org_id, employee_id, conversation_key, body_hash, sketch, tool, approval_id, state)
    values (p_org, p_employee, p_conversation_key, p_body_hash, p_sketch, p_tool, p_approval, 'reserved')
    returning id into new_id;
  return jsonb_build_object('state', 'claimed', 'id', new_id);
end $$;

create or replace function public.finish_comm_reply_send(p_id uuid, p_org uuid, p_outcome text)
returns boolean language plpgsql security invoker set search_path = pg_catalog, public as $$
begin
  if p_outcome is null or p_outcome not in ('sent', 'failed', 'uncertain') then
    raise exception 'invalid_comm_reply_outcome';
  end if;
  if p_outcome = 'failed' then
    delete from public.comm_reply_send_fingerprints where id = p_id and org_id = p_org and state = 'reserved';
  else
    update public.comm_reply_send_fingerprints set state = p_outcome, sent_at = now()
      where id = p_id and org_id = p_org and state = 'reserved';
  end if;
  return found;
end $$;

revoke all on function public.claim_comm_reply_send(uuid, uuid, text, text, integer[], text, uuid, integer, double precision, integer) from public, anon, authenticated;
revoke all on function public.finish_comm_reply_send(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.claim_comm_reply_send(uuid, uuid, text, text, integer[], text, uuid, integer, double precision, integer) to service_role;
grant execute on function public.finish_comm_reply_send(uuid, uuid, text) to service_role;

commit;

-- Rollback: supabase/verification/20261004700000_comm_reply_dedup_rollback.sql
-- (run only after COMM_REPLY_DEDUP_ENABLED is OFF everywhere). It drops both RPCs
-- and the ledger table, maps superseded → expired (closed tickets stay closed),
-- restores the previous status check and the F8 guard body. Tested by
-- scripts/test-db-local.py (rollback, then re-apply).

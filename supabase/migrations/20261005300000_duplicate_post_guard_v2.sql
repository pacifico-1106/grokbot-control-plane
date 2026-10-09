-- Duplicate post guard v2 (Yasaka / 木村 2026-10-05, PR-A). Additive and
-- re-applicable. Apply BEFORE setting DUPLICATE_GUARD_V2_ENABLED=true; with the
-- flag OFF the application never calls anything added here (v1 keeps using
-- claim_comm_reply_send from 20261004700000).
--
-- 1. comm_reply_send_fingerprints gains two nullable keyed hashes:
--      channel_key  HMAC of org + surface + destination WITHOUT the thread, so a
--                   top-level post and a thread post in one channel compare
--      job_key      HMAC of org + employee + jobId (same job → once)
--    Still hashes only: no body, no raw ids.
-- 2. tool check: + 'sns.publish' (the same ledger guards SNS posts).
-- 3. claim_outbound_send_v2 (service_role only, security invoker): one atomic
--    claim per org + channel (transaction advisory lock), so concurrent identical
--    posts — also by two employees, or to the channel and one of its threads —
--    cannot both be claimed. Order:
--      a. same job: same employee + job_key + channel_key + same / similar body,
--         ANY age (bounded by the ledger retention)               → duplicate same_job
--      b. p_approval: a row created after the approval (not its own) with the
--         same / similar body in the conversation (channel when p_cross_thread)
--         → superseded; an uncertain row → duplicate (matched_state uncertain,
--         the caller does not close the approval)
--      c. window (p_window_seconds): same employee, same conversation
--         → same_conversation; same channel (p_cross_thread) → cross_thread;
--         another employee (p_cross_employee='block') → cross_employee
--         For an approval the window also reaches back from the approval's
--         creation (a held copy of a body sent shortly before it was requested).
--      d. p_cross_employee='warn': another employee's match → 'warning' object
--    duplicate carries matched_state and, ONLY for the caller's own uncertain
--    row, matched_id (used to release it after the caller verified the post is
--    absent). Another employee's row id is never returned.
--    p_dry_run: read-only (no insert, no retention delete) → {state:'none'}.
-- 4. release_uncertain_outbound_send: deletes one 'uncertain' row owned by the
--    same org + employee (the AI verified the earlier post is absent). Sent /
--    reserved rows and other owners' rows are never touched.
-- finish_comm_reply_send (v1) is reused for sent / failed / uncertain.
begin;

-- 1 ----------------------------------------------------------------------------
alter table public.comm_reply_send_fingerprints
  add column if not exists channel_key text;
alter table public.comm_reply_send_fingerprints
  add column if not exists job_key text;
alter table public.comm_reply_send_fingerprints drop constraint if exists comm_reply_send_fingerprints_channel_key_check;
alter table public.comm_reply_send_fingerprints add constraint comm_reply_send_fingerprints_channel_key_check
  check (channel_key is null or channel_key ~ '^[0-9a-f]{64}$');
alter table public.comm_reply_send_fingerprints drop constraint if exists comm_reply_send_fingerprints_job_key_check;
alter table public.comm_reply_send_fingerprints add constraint comm_reply_send_fingerprints_job_key_check
  check (job_key is null or job_key ~ '^[0-9a-f]{64}$');

-- 2 ----------------------------------------------------------------------------
alter table public.comm_reply_send_fingerprints drop constraint if exists comm_reply_send_fingerprints_tool_check;
alter table public.comm_reply_send_fingerprints add constraint comm_reply_send_fingerprints_tool_check
  check (tool in ('comm.reply', 'comm.send', 'slack.post', 'slack.post_external', 'sns.publish'));

create index if not exists comm_reply_send_fingerprints_channel_idx
  on public.comm_reply_send_fingerprints (org_id, channel_key, created_at desc) where channel_key is not null;
create index if not exists comm_reply_send_fingerprints_job_idx
  on public.comm_reply_send_fingerprints (org_id, employee_id, job_key) where job_key is not null;

-- 3 ----------------------------------------------------------------------------
create or replace function public.outbound_sketch_similarity(a integer[], b integer[])
returns double precision language sql immutable security invoker set search_path = pg_catalog, public as $$
  select case when a is null or b is null or cardinality(a) <> 128 or cardinality(b) <> 128 then 0::double precision
    else (select count(*)::double precision / 128 from unnest(a, b) as u(x, y) where u.x = u.y) end
$$;

create or replace function public.claim_outbound_send_v2(
  p_org uuid, p_employee uuid, p_conversation_key text, p_channel_key text, p_job_key text,
  p_body_hash text, p_sketch integer[], p_tool text, p_approval uuid, p_window_seconds integer,
  p_similarity double precision, p_retention_seconds integer, p_cross_thread boolean,
  p_cross_employee text, p_dry_run boolean)
returns jsonb language plpgsql security invoker set search_path = pg_catalog, public as $$
declare
  a_created timestamptz;
  since timestamptz;
  r record;
  sim double precision;
  best record;
  best_sim double precision;
  best_scope text;
  best_rank integer;
  rank integer;
  warn jsonb;
  new_id uuid;
begin
  if p_org is null or p_employee is null
    or p_conversation_key is null or p_conversation_key !~ '^[0-9a-f]{64}$'
    or p_channel_key is null or p_channel_key !~ '^[0-9a-f]{64}$'
    or (p_job_key is not null and p_job_key !~ '^[0-9a-f]{64}$')
    or p_body_hash is null or p_body_hash !~ '^[0-9a-f]{64}$'
    or (p_sketch is not null and cardinality(p_sketch) <> 128)
    or p_tool is null or p_tool not in ('comm.reply', 'comm.send', 'slack.post', 'slack.post_external', 'sns.publish')
    or p_window_seconds is null or p_window_seconds < 1 or p_window_seconds > 604800
    or (p_similarity is not null and (p_similarity < 0.5 or p_similarity > 1))
    or p_retention_seconds is null or p_retention_seconds < p_window_seconds or p_retention_seconds > 2592000
    or p_cross_thread is null or p_dry_run is null
    or p_cross_employee is null or p_cross_employee not in ('off', 'warn', 'block') then
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
    'outbound_send:' || p_org::text || ':' || p_channel_key, 0));

  if not p_dry_run then
    delete from public.comm_reply_send_fingerprints
      where created_at < now() - make_interval(secs => p_retention_seconds);
  end if;

  -- a. same job, any age
  if p_job_key is not null then
    best_sim := 0;
    for r in
      select f.id, f.state, f.created_at, f.body_hash, f.sketch from public.comm_reply_send_fingerprints f
        where f.org_id = p_org and f.employee_id = p_employee and f.job_key = p_job_key
          and f.channel_key = p_channel_key
          and (p_approval is null or f.approval_id is distinct from p_approval)
        order by f.created_at desc limit 200
    loop
      sim := case when r.body_hash = p_body_hash then 1
        when p_similarity is null or p_sketch is null then 0
        else public.outbound_sketch_similarity(r.sketch, p_sketch) end;
      if (sim = 1 or (p_similarity is not null and sim >= p_similarity)) and sim > best_sim then
        best := r; best_sim := sim;
      end if;
    end loop;
    if best_sim > 0 then
      return jsonb_build_object('state', 'duplicate', 'scope', 'same_job',
        'match', case when best.body_hash = p_body_hash then 'exact' else 'similar' end,
        'similarity', best_sim, 'matched_at', best.created_at, 'matched_state', best.state)
        || case when best.state = 'uncertain' then jsonb_build_object('matched_id', best.id) else '{}'::jsonb end;
    end if;
  end if;

  -- b. replied after the approval was created (same / similar body)
  if p_approval is not null then
    best_sim := 0;
    for r in
      select f.id, f.state, f.created_at, f.body_hash, f.sketch, f.employee_id,
             (f.conversation_key = p_conversation_key) as same_conv
        from public.comm_reply_send_fingerprints f
        where f.org_id = p_org
          and (f.employee_id = p_employee or p_cross_employee = 'block')
          and (f.conversation_key = p_conversation_key or (p_cross_thread and f.channel_key = p_channel_key))
          and f.created_at > a_created and f.approval_id is distinct from p_approval
        order by f.created_at asc limit 200
    loop
      sim := case when r.body_hash = p_body_hash then 1
        when p_similarity is null or p_sketch is null then 0
        else public.outbound_sketch_similarity(r.sketch, p_sketch) end;
      if (sim = 1 or (p_similarity is not null and sim >= p_similarity))
        and (sim > best_sim or (sim = best_sim and r.state = 'uncertain' and r.employee_id = p_employee)) then
        best := r; best_sim := sim;
      end if;
    end loop;
    if best_sim > 0 then
      if best.state = 'uncertain' then
        -- Possibly sent, not confirmed: stop without closing the approval.
        return jsonb_build_object('state', 'duplicate',
          'scope', case when best.employee_id <> p_employee then 'cross_employee'
            when best.same_conv then 'same_conversation' else 'cross_thread' end,
          'match', case when best.body_hash = p_body_hash then 'exact' else 'similar' end,
          'similarity', best_sim, 'matched_at', best.created_at, 'matched_state', 'uncertain')
          || case when best.employee_id = p_employee then jsonb_build_object('matched_id', best.id) else '{}'::jsonb end;
      end if;
      return jsonb_build_object('state', 'superseded', 'replied_at', best.created_at,
        'match', case when best.body_hash = p_body_hash then 'exact' else 'similar' end, 'similarity', best_sim);
    end if;
  end if;

  -- c / d. window
  since := now() - make_interval(secs => p_window_seconds);
  if a_created is not null then since := least(since, a_created - make_interval(secs => p_window_seconds)); end if;
  best_sim := 0; best_scope := null; best_rank := 99; warn := null;
  for r in
    select f.id, f.state, f.created_at, f.body_hash, f.sketch, f.employee_id,
           (f.conversation_key = p_conversation_key) as same_conv
      from public.comm_reply_send_fingerprints f
      where f.org_id = p_org and f.created_at >= since
        and (f.conversation_key = p_conversation_key or ((p_cross_thread or p_cross_employee <> 'off') and f.channel_key = p_channel_key))
      order by f.created_at desc limit 500
  loop
    if not r.same_conv and not p_cross_thread then continue; end if;
    sim := case when r.body_hash = p_body_hash then 1
      when p_similarity is null or p_sketch is null then 0
      else public.outbound_sketch_similarity(r.sketch, p_sketch) end;
    if not (sim = 1 or (p_similarity is not null and sim >= p_similarity)) then continue; end if;
    if r.employee_id <> p_employee then
      if p_cross_employee = 'off' then continue; end if;
      if p_cross_employee = 'warn' then
        if warn is null or sim > (warn->>'similarity')::double precision then
          warn := jsonb_build_object('scope', 'cross_employee',
            'match', case when r.body_hash = p_body_hash then 'exact' else 'similar' end,
            'similarity', sim, 'matched_at', r.created_at);
        end if;
        continue;
      end if;
      rank := 3;
    elsif r.same_conv then
      rank := 1;
    else
      rank := 2;
    end if;
    -- own conversation before the rest of the channel before other employees; then the closest body
    if rank < best_rank or (rank = best_rank and sim > best_sim) then
      best := r; best_sim := sim; best_rank := rank;
      best_scope := case rank when 1 then 'same_conversation' when 2 then 'cross_thread' else 'cross_employee' end;
    end if;
  end loop;
  if best_scope is not null then
    return jsonb_build_object('state', 'duplicate', 'scope', best_scope,
      'match', case when best.body_hash = p_body_hash then 'exact' else 'similar' end,
      'similarity', best_sim, 'matched_at', best.created_at, 'matched_state', best.state)
      || case when best.state = 'uncertain' and best.employee_id = p_employee
           then jsonb_build_object('matched_id', best.id) else '{}'::jsonb end;
  end if;

  if p_dry_run then
    return jsonb_build_object('state', 'none') || case when warn is not null then jsonb_build_object('warning', warn) else '{}'::jsonb end;
  end if;
  insert into public.comm_reply_send_fingerprints
    (org_id, employee_id, conversation_key, channel_key, job_key, body_hash, sketch, tool, approval_id, state)
    values (p_org, p_employee, p_conversation_key, p_channel_key, p_job_key, p_body_hash, p_sketch, p_tool, p_approval, 'reserved')
    returning id into new_id;
  return jsonb_build_object('state', 'claimed', 'id', new_id)
    || case when warn is not null then jsonb_build_object('warning', warn) else '{}'::jsonb end;
end $$;

-- 4 ----------------------------------------------------------------------------
create or replace function public.release_uncertain_outbound_send(p_id uuid, p_org uuid, p_employee uuid)
returns boolean language plpgsql security invoker set search_path = pg_catalog, public as $$
begin
  if p_id is null or p_org is null or p_employee is null then return false; end if;
  delete from public.comm_reply_send_fingerprints
    where id = p_id and org_id = p_org and employee_id = p_employee and state = 'uncertain';
  return found;
end $$;

revoke all on function public.outbound_sketch_similarity(integer[], integer[]) from public, anon, authenticated;
revoke all on function public.claim_outbound_send_v2(uuid, uuid, text, text, text, text, integer[], text, uuid, integer, double precision, integer, boolean, text, boolean) from public, anon, authenticated;
revoke all on function public.release_uncertain_outbound_send(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.outbound_sketch_similarity(integer[], integer[]) to service_role;
grant execute on function public.claim_outbound_send_v2(uuid, uuid, text, text, text, text, integer[], text, uuid, integer, double precision, integer, boolean, text, boolean) to service_role;
grant execute on function public.release_uncertain_outbound_send(uuid, uuid, uuid) to service_role;

commit;

-- Rollback: supabase/verification/20261005300000_duplicate_post_guard_v2_rollback.sql
-- (run only after DUPLICATE_GUARD_V2_ENABLED is OFF everywhere). Drops the v2
-- RPCs and indexes, deletes sns.publish rows, restores the v1 tool check and
-- drops channel_key / job_key. v1 (claim_comm_reply_send) keeps working.
-- Tested by scripts/test-db-local.py (rollback, v1 claim, then re-apply).

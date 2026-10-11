-- Additive expansion (2026-10-04, #253 follow-up: scheduled attachment reconcile).
-- Apply after 20261004300000_approval_attachment_upload_claim.sql and before
-- enabling APPROVAL_ATTACHMENT_RECONCILE_ENABLED. No existing table, column,
-- grant on tables, RLS policy or business constraint is changed: five
-- functions rewrite approval_requests.metadata keys under the row lock, and one
-- NEW service_role-only table holds the retry-cap reset signal. Not applied in
-- production yet, so the 木村 #255 second / third-round additions
-- (slackTokenType, retry streak, capped claim, re-check stop, reset signal)
-- extend this file instead of a later migration.
--
-- org_settings_changes (new, 木村 third round h): one row per org = the time of
--   the last Slack-related settings change. RLS enabled with NO policy and
--   anon / authenticated revoked, so only service_role (the server) can read or
--   write it — an org member cannot forge a reset (the audit log is no longer
--   read for this). The (tool, source) check is the explicit allow-list
--   (木村 fourth round 3):
--     setup.slackAdapter.setBotToken / setup.slackApprover.set /
--     employees.postingIdentity.set  + admin_fulfillment (approved + fulfilled)
--     setup.slackAuthorizeLink.issue + authorize_link_completed (completion only)
--     dashboard.conversationAdapter.slack + dashboard_settings
-- record_org_settings_change (new): upsert of that row (changed_at = now(),
--   never moves back). source must be one of the three server-side sources
--   (else invalid_settings_change_source) and (tool, source) one of the pairs
--   above (else invalid_settings_change_tool).
--
-- reconcile_approval_attachment_upload: change metadata.attachmentUpload ONLY
--   when it is still exactly what the caller read (state = p_expected_state,
--   claimId = p_expected_claim). → true for the single applied write.
--     running|uncertain → succeeded (fileId required) | failed
--     running|uncertain → uncertain: sets adminNotifiedAt (+ recheckAttempts 0,
--                         nextCheckAt ≤ now + 24 h); when adminNotifiedAt is
--                         already set the admin agent is NOT told again: the
--                         write is a re-check (木村 2) and is applied only when
--                         p_result.recheckAttempts = stored attempts + 1
--                         (compare-and-set) and nextCheckAt is within
--                         adminNotifiedAt + 24 h; no nextCheckAt = last re-check
--                         (recheckStoppedAt). Anything else → false.
--                         A stopped schedule (recheckStoppedAt set) is never
--                         re-scheduled (→ false).
--   p_result keeps fileId / filename / bytes / code (+ the schedule) only.
-- finish_approval_attachment_upload (same signature as 20261004300000, 木村 5):
--   additionally keeps slackError (a Slack error code, ^[a-z_]{1,64}$) and
--   slackNeeded (≤ 10 scope names, ^[a-z][a-z0-9._:-]{0,63}$, never xox…).
--   Anything else is dropped (not an error: the claim must still close).
--   木村 #255 second round: + slackTokenType ('user' | 'bot', only next to
--   slackError) and metadata.attachmentUploadStreak = {code, count, lastAt}:
--   failed + slackError → same code as the stored streak: count + 1 (≤ 9999),
--   other code: 1; every other outcome removes the streak. Outside
--   attachmentUpload, so a new claim (which rewrites attachmentUpload) keeps it.
-- claim_approval_attachment_upload_capped (new, flag ON callers only): under the
--   row lock — not approved → denied; the failed record's slackError has a streak
--   with count ≥ p_cap (1..10) → if the org's org_settings_changes.changed_at is
--   after the streak's lastAt, remove the streak and continue, else →
--   {state:'capped', code, count} (no claim, no upload).
--   Then #253's claim_approval_attachment_upload (same transaction, same lock).
-- stop_approval_attachment_recheck (new): a notified uncertain record whose
--   schedule is still running → recheckStoppedAt + recheckStopReason
--   (p_reason 'stuck_watch_resolved' only), nextCheckAt removed. → true once.
-- mark_approval_attachment_not_sent: set metadata.fulfillment.fileUpload to the
--   not_sent marker ONLY while the approval is approved, the text was posted
--   (fulfillment.ok = true), there is no fulfillment.fileUpload, no
--   attachmentUpload and no #252 attachmentFulfillment success. → true once.
begin;

create table if not exists public.org_settings_changes (
  org_id uuid primary key references public.orgs(id) on delete cascade,
  changed_at timestamptz not null default now(),
  tool text not null,
  source text not null check (source in ('admin_fulfillment','authorize_link_completed','dashboard_settings')),
  constraint org_settings_changes_signal check ((tool, source) in (
    ('setup.slackAdapter.setBotToken','admin_fulfillment'),
    ('setup.slackApprover.set','admin_fulfillment'),
    ('employees.postingIdentity.set','admin_fulfillment'),
    ('setup.slackAuthorizeLink.issue','authorize_link_completed'),
    ('dashboard.conversationAdapter.slack','dashboard_settings')))
);
alter table public.org_settings_changes enable row level security;
revoke all on public.org_settings_changes from public, anon, authenticated;
grant select, insert, update on public.org_settings_changes to service_role;

create or replace function public.record_org_settings_change(p_org uuid, p_tool text, p_source text)
returns boolean language plpgsql security invoker set search_path = pg_catalog, public as $$
begin
  if p_org is null then raise exception 'invalid_settings_change_org'; end if;
  if p_source is null or p_source not in ('admin_fulfillment','authorize_link_completed','dashboard_settings') then
    raise exception 'invalid_settings_change_source';
  end if;
  -- 木村 fourth round 3: explicit Slack-related allow-list (same pairs as the table check)
  if p_tool is null or (p_tool, p_source) not in (
    ('setup.slackAdapter.setBotToken','admin_fulfillment'),
    ('setup.slackApprover.set','admin_fulfillment'),
    ('employees.postingIdentity.set','admin_fulfillment'),
    ('setup.slackAuthorizeLink.issue','authorize_link_completed'),
    ('dashboard.conversationAdapter.slack','dashboard_settings')) then
    raise exception 'invalid_settings_change_tool';
  end if;
  insert into public.org_settings_changes as c (org_id, changed_at, tool, source)
    values (p_org, now(), p_tool, p_source)
    on conflict (org_id) do update
      set changed_at = greatest(c.changed_at, excluded.changed_at), tool = excluded.tool, source = excluded.source;
  return true;
end $$;

create or replace function public.reconcile_approval_attachment_upload(
  p_id uuid, p_org uuid, p_expected_state text, p_expected_claim text, p_state text, p_result jsonb)
returns boolean language plpgsql security invoker set search_path = pg_catalog, public as $$
declare a public.approval_requests; u jsonb; r jsonb; n int; nx timestamptz; t0 timestamptz;
begin
  if p_expected_state is null or p_expected_state not in ('running','uncertain') then
    raise exception 'invalid_attachment_reconcile_expected_state';
  end if;
  if p_state is null or p_state not in ('succeeded','failed','uncertain') then
    raise exception 'invalid_attachment_upload_state';
  end if;
  r := coalesce(p_result,'{}'::jsonb);
  if jsonb_typeof(r) <> 'object' then raise exception 'invalid_attachment_upload_result'; end if;
  if p_state = 'succeeded' and coalesce(r->>'fileId','') = '' then raise exception 'attachment_file_id_required'; end if;
  if r ? 'recheckAttempts' and (jsonb_typeof(r->'recheckAttempts') <> 'number' or (r->>'recheckAttempts') !~ '^[0-9]{1,3}$') then
    raise exception 'invalid_attachment_recheck';
  end if;
  if r ? 'nextCheckAt' then
    if jsonb_typeof(r->'nextCheckAt') <> 'string' then raise exception 'invalid_attachment_recheck'; end if;
    nx := (r->>'nextCheckAt')::timestamptz;
  end if;
  select * into a from public.approval_requests where id=p_id and org_id=p_org for update;
  if not found then return false; end if;
  u := a.metadata->'attachmentUpload';
  if u is null or jsonb_typeof(u) <> 'object'
     or u->>'state' is distinct from p_expected_state
     or u->>'claimId' is distinct from p_expected_claim then
    return false;
  end if;
  if p_state = 'uncertain' and coalesce(u->>'adminNotifiedAt','') <> '' then
    -- stopped schedule (ran out, or the A1 item was resolved): never re-scheduled
    if u ? 'recheckStoppedAt' then return false; end if;
    -- re-check of a notified record (木村 2): compare-and-set on the attempt count
    n := coalesce((u->>'recheckAttempts')::int, 0) + 1;
    if (r->>'recheckAttempts')::int is distinct from n then return false; end if;
    t0 := (u->>'adminNotifiedAt')::timestamptz;
    if nx is not null and (nx <= t0 or nx > t0 + interval '24 hours') then return false; end if;
    u := (u - 'nextCheckAt') || jsonb_strip_nulls(jsonb_build_object(
        'filename', r->'filename', 'bytes', r->'bytes', 'code', r->'code', 'nextCheckAt', r->'nextCheckAt'))
      || jsonb_build_object('reconciledAt', now(), 'recheckAttempts', n);
    if nx is null then u := u || jsonb_build_object('recheckStoppedAt', now()); end if;
    update public.approval_requests set metadata = metadata || jsonb_build_object('attachmentUpload', u)
      where id=p_id and org_id=p_org;
    return true;
  end if;
  if p_state = 'uncertain' and nx is not null and nx > now() + interval '24 hours' then
    raise exception 'invalid_attachment_recheck';
  end if;
  u := u || jsonb_strip_nulls(jsonb_build_object(
      'fileId', r->'fileId', 'filename', r->'filename', 'bytes', r->'bytes', 'code', r->'code'))
    || jsonb_build_object('state', p_state, 'reconciledAt', now());
  if p_expected_state = 'running' then u := u || jsonb_build_object('finishedAt', now()); end if;
  if p_state = 'uncertain' then
    u := u || jsonb_strip_nulls(jsonb_build_object('adminNotifiedAt', now(), 'recheckAttempts', 0, 'nextCheckAt', r->'nextCheckAt'));
  end if;
  update public.approval_requests set metadata = metadata || jsonb_build_object('attachmentUpload', u)
    where id=p_id and org_id=p_org;
  return true;
end $$;

create or replace function public.finish_approval_attachment_upload(p_id uuid, p_org uuid, p_claim uuid, p_state text, p_result jsonb)
returns boolean language plpgsql security invoker set search_path = pg_catalog, public as $$
declare a public.approval_requests; u jsonb; r jsonb; se jsonb; sn jsonb; st jsonb; s jsonb; n int;
begin
  if p_state not in ('succeeded','failed','uncertain') then raise exception 'invalid_attachment_upload_state'; end if;
  r := coalesce(p_result,'{}'::jsonb);
  if jsonb_typeof(r) <> 'object' then raise exception 'invalid_attachment_upload_result'; end if;
  -- 木村 5: the definite Slack error behind a failure + (missing_scope) the needed scope names
  if jsonb_typeof(r->'slackError') = 'string' and (r->>'slackError') ~ '^[a-z_]{1,64}$' then se := r->'slackError'; end if;
  if se is not null and jsonb_typeof(r->'slackNeeded') = 'array' then
    select jsonb_agg(e) into sn from (
      select e from jsonb_array_elements(r->'slackNeeded') e
      where jsonb_typeof(e) = 'string' and (e #>> '{}') ~ '^[a-z][a-z0-9._:-]{0,63}$' and (e #>> '{}') !~ '^xox'
      limit 10) s;
  end if;
  -- 木村 #255 second round: which token Slack answered for (never the token itself)
  if se is not null and jsonb_typeof(r->'slackTokenType') = 'string' and (r->>'slackTokenType') in ('user','bot') then
    st := r->'slackTokenType';
  end if;
  select * into a from public.approval_requests where id=p_id and org_id=p_org for update;
  if not found then return false; end if;
  u := a.metadata->'attachmentUpload';
  if u is null or u->>'claimId' is distinct from p_claim::text or u->>'state' is distinct from 'running' then
    return false;
  end if;
  u := u || jsonb_strip_nulls(jsonb_build_object(
      'fileId', r->'fileId', 'filename', r->'filename', 'bytes', r->'bytes', 'code', r->'code',
      'slackError', se, 'slackNeeded', sn, 'slackTokenType', st))
    || jsonb_build_object('state', p_state, 'finishedAt', now());
  if p_state = 'failed' and se is not null then
    -- consecutive definite failures of this approval with this Slack error code
    s := a.metadata->'attachmentUploadStreak';
    n := case when jsonb_typeof(s) = 'object' and s->>'code' = (se #>> '{}') and (s->>'count') ~ '^[0-9]{1,4}$'
              then least((s->>'count')::int + 1, 9999) else 1 end;
    update public.approval_requests
      set metadata = metadata || jsonb_build_object('attachmentUpload', u)
        || jsonb_build_object('attachmentUploadStreak', jsonb_build_object('code', se, 'count', n, 'lastAt', now()))
      where id=p_id and org_id=p_org;
  else
    update public.approval_requests
      set metadata = (metadata || jsonb_build_object('attachmentUpload', u)) - 'attachmentUploadStreak'
      where id=p_id and org_id=p_org;
  end if;
  return true;
end $$;

create or replace function public.claim_approval_attachment_upload_capped(p_id uuid, p_org uuid, p_claim uuid, p_ref text, p_cap int)
returns jsonb language plpgsql security invoker set search_path = pg_catalog, public as $$
declare a public.approval_requests; u jsonb; s jsonb;
begin
  if p_cap is null or p_cap < 1 or p_cap > 10 then raise exception 'invalid_attachment_retry_cap'; end if;
  if p_ref is null or p_ref !~ '^[0-9a-f]{64}$' then raise exception 'invalid_attachment_ref'; end if;
  select * into a from public.approval_requests where id=p_id and org_id=p_org for update;
  if not found or a.status <> 'approved' then return jsonb_build_object('state','denied'); end if;
  u := a.metadata->'attachmentUpload';
  s := a.metadata->'attachmentUploadStreak';
  if u->>'state' = 'failed' and jsonb_typeof(s) = 'object' and s->>'code' = u->>'slackError'
     and (s->>'count') ~ '^[0-9]{1,4}$' and (s->>'count')::int >= p_cap then
    if exists (select 1 from public.org_settings_changes c
               where c.org_id = p_org and c.changed_at > (s->>'lastAt')::timestamptz) then
      -- settings changed since the last failure: count from 0 again
      update public.approval_requests set metadata = metadata - 'attachmentUploadStreak'
        where id=p_id and org_id=p_org;
    else
      return jsonb_build_object('state','capped','code', s->'code','count', (s->>'count')::int);
    end if;
  end if;
  return public.claim_approval_attachment_upload(p_id, p_org, p_claim, p_ref);
end $$;

create or replace function public.stop_approval_attachment_recheck(p_id uuid, p_org uuid, p_reason text)
returns boolean language plpgsql security invoker set search_path = pg_catalog, public as $$
declare a public.approval_requests; u jsonb;
begin
  if p_reason is null or p_reason not in ('stuck_watch_resolved') then
    raise exception 'invalid_attachment_recheck_stop_reason';
  end if;
  select * into a from public.approval_requests where id=p_id and org_id=p_org for update;
  if not found then return false; end if;
  u := a.metadata->'attachmentUpload';
  if u is null or jsonb_typeof(u) <> 'object' or u->>'state' is distinct from 'uncertain'
     or coalesce(u->>'adminNotifiedAt','') = '' or u ? 'recheckStoppedAt' then
    return false;
  end if;
  u := (u - 'nextCheckAt') || jsonb_build_object('recheckStoppedAt', now(), 'recheckStopReason', p_reason);
  update public.approval_requests set metadata = metadata || jsonb_build_object('attachmentUpload', u)
    where id=p_id and org_id=p_org;
  return true;
end $$;

create or replace function public.mark_approval_attachment_not_sent(p_id uuid, p_org uuid, p_marker jsonb)
returns boolean language plpgsql security invoker set search_path = pg_catalog, public as $$
declare a public.approval_requests; f jsonb; m jsonb;
begin
  if p_marker is null or jsonb_typeof(p_marker) <> 'object'
     or p_marker->>'status' is distinct from 'not_sent'
     or p_marker->>'reason' is distinct from 'rerun_required'
     or coalesce(p_marker->>'filename','') = '' then
    raise exception 'invalid_attachment_not_sent_marker';
  end if;
  m := jsonb_strip_nulls(jsonb_build_object('status','not_sent','reason','rerun_required',
    'filename', p_marker->'filename', 'bytes', p_marker->'bytes'));
  select * into a from public.approval_requests where id=p_id and org_id=p_org for update;
  if not found or a.status <> 'approved' then return false; end if;
  f := a.metadata->'fulfillment';
  if f is null or jsonb_typeof(f) <> 'object' or f->>'ok' is distinct from 'true' or f ? 'fileUpload' then return false; end if;
  if a.metadata ? 'attachmentUpload' then return false; end if;
  if a.metadata->'attachmentFulfillment'->>'ok' = 'true' then return false; end if;
  update public.approval_requests
    set metadata = metadata || jsonb_build_object('fulfillment', f || jsonb_build_object('fileUpload', m))
    where id=p_id and org_id=p_org;
  return true;
end $$;

revoke all on function public.reconcile_approval_attachment_upload(uuid,uuid,text,text,text,jsonb) from public,anon,authenticated;
revoke all on function public.mark_approval_attachment_not_sent(uuid,uuid,jsonb) from public,anon,authenticated;
revoke all on function public.finish_approval_attachment_upload(uuid,uuid,uuid,text,jsonb) from public,anon,authenticated;
revoke all on function public.claim_approval_attachment_upload_capped(uuid,uuid,uuid,text,int) from public,anon,authenticated;
revoke all on function public.stop_approval_attachment_recheck(uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.record_org_settings_change(uuid,text,text) from public,anon,authenticated;
grant execute on function public.reconcile_approval_attachment_upload(uuid,uuid,text,text,text,jsonb) to service_role;
grant execute on function public.mark_approval_attachment_not_sent(uuid,uuid,jsonb) to service_role;
grant execute on function public.finish_approval_attachment_upload(uuid,uuid,uuid,text,jsonb) to service_role;
grant execute on function public.claim_approval_attachment_upload_capped(uuid,uuid,uuid,text,int) to service_role;
grant execute on function public.stop_approval_attachment_recheck(uuid,uuid,text) to service_role;
grant execute on function public.record_org_settings_change(uuid,text,text) to service_role;
commit;

-- Additive expansion (2026-10-04, #253 follow-up: scheduled attachment reconcile).
-- Apply after 20261004300000_approval_attachment_upload_claim.sql and before
-- enabling APPROVAL_ATTACHMENT_RECONCILE_ENABLED. No table, column, grant on
-- tables, RLS policy or business constraint is changed: both functions only
-- rewrite approval_requests.metadata keys under the row lock.
--
-- reconcile_approval_attachment_upload: change metadata.attachmentUpload ONLY
--   when it is still exactly what the caller read (state = p_expected_state,
--   claimId = p_expected_claim). → true for the single applied write.
--     running|uncertain → succeeded (fileId required) | failed
--     running|uncertain → uncertain: sets adminNotifiedAt; refused (false)
--                         when it is already set → the admin agent is told once
--   p_result keeps fileId / filename / bytes / code only.
-- mark_approval_attachment_not_sent: set metadata.fulfillment.fileUpload to the
--   not_sent marker ONLY while the approval is approved, the text was posted
--   (fulfillment.ok = true), there is no fulfillment.fileUpload, no
--   attachmentUpload and no #252 attachmentFulfillment success. → true once.
begin;

create or replace function public.reconcile_approval_attachment_upload(
  p_id uuid, p_org uuid, p_expected_state text, p_expected_claim text, p_state text, p_result jsonb)
returns boolean language plpgsql security invoker set search_path = pg_catalog, public as $$
declare a public.approval_requests; u jsonb; r jsonb;
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
  select * into a from public.approval_requests where id=p_id and org_id=p_org for update;
  if not found then return false; end if;
  u := a.metadata->'attachmentUpload';
  if u is null or jsonb_typeof(u) <> 'object'
     or u->>'state' is distinct from p_expected_state
     or u->>'claimId' is distinct from p_expected_claim then
    return false;
  end if;
  if p_state = 'uncertain' and coalesce(u->>'adminNotifiedAt','') <> '' then return false; end if;
  u := u || jsonb_strip_nulls(jsonb_build_object(
      'fileId', r->'fileId', 'filename', r->'filename', 'bytes', r->'bytes', 'code', r->'code'))
    || jsonb_build_object('state', p_state, 'reconciledAt', now());
  if p_expected_state = 'running' then u := u || jsonb_build_object('finishedAt', now()); end if;
  if p_state = 'uncertain' then u := u || jsonb_build_object('adminNotifiedAt', now()); end if;
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
grant execute on function public.reconcile_approval_attachment_upload(uuid,uuid,text,text,text,jsonb) to service_role;
grant execute on function public.mark_approval_attachment_not_sent(uuid,uuid,jsonb) to service_role;
commit;

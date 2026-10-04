-- Additive expansion (2026-10-04, #252 follow-up). Apply before deploying the
-- matching application. No table, column, grant on tables, RLS policy or
-- business constraint is changed: the claim lives in
-- approval_requests.metadata.attachmentUpload and is changed only under the row lock.
--
-- claim:  denied     — approval missing / other org / not approved
--         succeeded  — already uploaded (also #252's metadata.attachmentFulfillment)
--         running    — another worker holds the claim (do not upload)
--         uncertain  — outcome unknown; never claimed again automatically
--         claimed    — absent or failed → now running for p_claim
-- finish: only the holder of a running claim; p_result keeps fileId / filename / bytes / code.
begin;

create or replace function public.claim_approval_attachment_upload(p_id uuid, p_org uuid, p_claim uuid, p_ref text)
returns jsonb language plpgsql security invoker set search_path = pg_catalog, public as $$
declare a public.approval_requests; u jsonb; f jsonb;
begin
  if p_ref is null or p_ref !~ '^[0-9a-f]{64}$' then raise exception 'invalid_attachment_ref'; end if;
  select * into a from public.approval_requests where id=p_id and org_id=p_org for update;
  if not found or a.status <> 'approved' then return jsonb_build_object('state','denied'); end if;
  f := a.metadata->'attachmentFulfillment';
  if f->>'ok' = 'true' and f->>'refSha256' = p_ref and coalesce(f->>'fileId','') <> '' then
    return jsonb_build_object('state','succeeded','upload',
      jsonb_build_object('fileId',f->'fileId','filename',f->'filename','bytes',f->'bytes'));
  end if;
  u := a.metadata->'attachmentUpload';
  if u->>'state' = 'succeeded' and coalesce(u->>'fileId','') <> '' then
    return jsonb_build_object('state','succeeded','upload',
      jsonb_build_object('fileId',u->'fileId','filename',u->'filename','bytes',u->'bytes'));
  end if;
  if u->>'state' in ('running','uncertain','succeeded') then
    return jsonb_build_object('state', case when u->>'state' = 'succeeded' then 'uncertain' else u->>'state' end);
  end if;
  update public.approval_requests set metadata = coalesce(metadata,'{}'::jsonb) || jsonb_build_object(
    'attachmentUpload', jsonb_build_object('state','running','claimId',p_claim::text,'refSha256',p_ref,'claimedAt',now()))
    where id=p_id and org_id=p_org;
  return jsonb_build_object('state','claimed');
end $$;

create or replace function public.finish_approval_attachment_upload(p_id uuid, p_org uuid, p_claim uuid, p_state text, p_result jsonb)
returns boolean language plpgsql security invoker set search_path = pg_catalog, public as $$
declare a public.approval_requests; u jsonb; r jsonb;
begin
  if p_state not in ('succeeded','failed','uncertain') then raise exception 'invalid_attachment_upload_state'; end if;
  r := coalesce(p_result,'{}'::jsonb);
  if jsonb_typeof(r) <> 'object' then raise exception 'invalid_attachment_upload_result'; end if;
  select * into a from public.approval_requests where id=p_id and org_id=p_org for update;
  if not found then return false; end if;
  u := a.metadata->'attachmentUpload';
  if u is null or u->>'claimId' is distinct from p_claim::text or u->>'state' is distinct from 'running' then
    return false;
  end if;
  u := u || jsonb_strip_nulls(jsonb_build_object(
      'fileId', r->'fileId', 'filename', r->'filename', 'bytes', r->'bytes', 'code', r->'code'))
    || jsonb_build_object('state', p_state, 'finishedAt', now());
  update public.approval_requests set metadata = metadata || jsonb_build_object('attachmentUpload', u)
    where id=p_id and org_id=p_org;
  return true;
end $$;

revoke all on function public.claim_approval_attachment_upload(uuid,uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.finish_approval_attachment_upload(uuid,uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.claim_approval_attachment_upload(uuid,uuid,uuid,text) to service_role;
grant execute on function public.finish_approval_attachment_upload(uuid,uuid,uuid,text,jsonb) to service_role;
commit;

create table if not exists cross_product_event_outbox (
  id text primary key,
  org_id uuid not null references orgs(id) on delete cascade,
  event_id text not null,
  event_type text not null,
  body_hash text not null check (body_hash ~ '^[a-f0-9]{64}$'),
  raw_event jsonb not null,
  status text not null check (status in ('pending','delivered','retryable','dead_letter')),
  attempts integer not null default 0,
  last_http_status integer,
  last_error text,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (event_id)
);

create table if not exists cross_product_event_inbox (
  id text primary key,
  org_id uuid not null references orgs(id) on delete cascade,
  producer_system text not null,
  producer_environment text not null check (producer_environment in ('staging','production')),
  event_id text not null,
  event_type text not null,
  body_hash text not null check (body_hash ~ '^[a-f0-9]{64}$'),
  aggregate_id text not null,
  aggregate_version bigint not null check (aggregate_version >= 1),
  raw_event jsonb not null,
  received_at timestamptz not null default now(),
  unique (producer_system, producer_environment, event_id)
);

create table if not exists commerce_projections (
  org_id uuid not null references orgs(id) on delete cascade,
  order_id text not null,
  job_id text not null,
  approval_id uuid not null references approval_requests(id) on delete cascade,
  reported_status text not null,
  payment_event_id text,
  source_system text not null default 'sealith' check (source_system = 'sealith'),
  source_event_id text not null,
  source_aggregate_version bigint not null check (source_aggregate_version >= 1),
  observed_at timestamptz not null default now(),
  payload jsonb not null,
  primary key (org_id, order_id)
);

alter table cross_product_event_outbox enable row level security;
alter table cross_product_event_inbox enable row level security;
alter table commerce_projections enable row level security;

create policy cross_product_outbox_select on cross_product_event_outbox
  for select using (public.is_org_member(org_id));
create policy cross_product_inbox_select on cross_product_event_inbox
  for select using (public.is_org_member(org_id));
create policy commerce_projections_select on commerce_projections
  for select using (public.is_org_member(org_id));

create or replace function public.accept_sealith_commerce_event(
  p_inbox_id text,
  p_org_id uuid,
  p_event_id text,
  p_event_type text,
  p_body_hash text,
  p_aggregate_id text,
  p_aggregate_version bigint,
  p_order_id text,
  p_job_id text,
  p_approval_id uuid,
  p_reported_status text,
  p_payment_event_id text,
  p_payload jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  existing_hash text;
  existing_version bigint;
begin
  select body_hash into existing_hash
  from cross_product_event_inbox
  where producer_system = 'sealith'
    and producer_environment = p_payload->'producer'->>'environment'
    and event_id = p_event_id
  for update;

  if existing_hash is not null then
    if existing_hash <> p_body_hash then
      raise exception 'event_id_body_conflict';
    end if;
    return jsonb_build_object('received', true, 'eventId', p_event_id, 'duplicate', true, 'businessDisposition', 'duplicate');
  end if;

  if not exists (
    select 1 from approval_requests
    where id = p_approval_id and org_id = p_org_id and job_id = p_job_id
  ) then
    raise exception 'approval_tenant_or_job_mismatch';
  end if;

  select source_aggregate_version into existing_version
  from commerce_projections
  where org_id = p_org_id and order_id = p_order_id
  for update;

  insert into cross_product_event_inbox (
    id, org_id, producer_system, producer_environment, event_id, event_type,
    body_hash, aggregate_id, aggregate_version, raw_event
  ) values (
    p_inbox_id, p_org_id, 'sealith', p_payload->'producer'->>'environment',
    p_event_id, p_event_type, p_body_hash, p_aggregate_id,
    p_aggregate_version, p_payload
  );

  if existing_version is not null and p_aggregate_version <= existing_version then
    return jsonb_build_object('received', true, 'eventId', p_event_id, 'duplicate', false, 'businessDisposition', 'stale');
  end if;

  insert into commerce_projections (
    org_id, order_id, job_id, approval_id, reported_status,
    payment_event_id, source_event_id, source_aggregate_version,
    observed_at, payload
  ) values (
    p_org_id, p_order_id, p_job_id, p_approval_id, p_reported_status,
    p_payment_event_id, p_event_id, p_aggregate_version, now(), p_payload
  )
  on conflict (org_id, order_id) do update set
    job_id = excluded.job_id,
    approval_id = excluded.approval_id,
    reported_status = excluded.reported_status,
    payment_event_id = excluded.payment_event_id,
    source_event_id = excluded.source_event_id,
    source_aggregate_version = excluded.source_aggregate_version,
    observed_at = now(),
    payload = excluded.payload;

  insert into audit_events (
    org_id, employee_id, credential_id, action, purpose, summary, metadata
  )
  select
    p_org_id, a.employee_id, a.credential_id,
    'commerce.projection_received', a.purpose,
    'Sealith commerce projection: ' || p_reported_status,
    jsonb_build_object(
      'jobId', p_job_id,
      'approvalId', p_approval_id,
      'orderId', p_order_id,
      'sourceSystem', 'sealith',
      'sourceEventId', p_event_id,
      'sourceAggregateVersion', p_aggregate_version,
      'paymentEventId', p_payment_event_id
    )
  from approval_requests a where a.id = p_approval_id;

  return jsonb_build_object('received', true, 'eventId', p_event_id, 'duplicate', false, 'businessDisposition', 'projection_updated');
end;
$$;

revoke all on function public.accept_sealith_commerce_event(text, uuid, text, text, text, text, bigint, text, text, uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.accept_sealith_commerce_event(text, uuid, text, text, text, text, bigint, text, text, uuid, text, text, jsonb) to service_role;

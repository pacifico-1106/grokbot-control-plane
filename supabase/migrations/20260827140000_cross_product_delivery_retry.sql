alter table public.cross_product_event_outbox
  add column if not exists raw_body text,
  add column if not exists next_attempt_at timestamptz,
  add column if not exists dead_lettered_at timestamptz;

update public.cross_product_event_outbox
set next_attempt_at = coalesce(next_attempt_at, now())
where status in ('pending', 'retryable');

create index if not exists cross_product_outbox_dispatch_idx
  on public.cross_product_event_outbox (status, next_attempt_at, created_at)
  where status in ('pending', 'retryable');

comment on column public.cross_product_event_outbox.raw_body is
  'Exact UTF-8 bytes signed and retried. Never reconstruct from jsonb.';

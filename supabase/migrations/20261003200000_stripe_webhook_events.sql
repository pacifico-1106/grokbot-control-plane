-- Stripe webhook event ledger: dedupe by event.id with a processing claim.
--
-- Used by app/api/webhooks/stripe/route.ts via lib/billing/stripe-webhook-ledger.ts.
-- The code is fail-safe when this table does not exist yet (it processes events
-- without dedupe, the same as before), so this migration can be applied after
-- the code is deployed.
--
-- Additive only: new table, RLS on, service_role only. No existing data changes.
-- Rollback: drop table if exists public.stripe_webhook_events;
--   (the code then falls back to "no dedupe" automatically.)

create table if not exists public.stripe_webhook_events (
  event_id text primary key,
  event_type text not null,
  status text not null
    check (status in ('processing', 'processed', 'failed', 'rejected')),
  attempts integer not null default 1 check (attempts >= 1),
  claimed_at timestamptz not null default now(),
  processed_at timestamptz,
  last_error text,
  org_id uuid references public.orgs(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.stripe_webhook_events is
  'Stripe webhook ledger. One row per event.id. processing → processed | failed | rejected. '
  'processed = handled successfully (duplicates are skipped). failed = transient error (Stripe retries, next delivery re-claims). '
  'rejected = permanent (e.g. org/customer mismatch), acknowledged 2xx; a manual resend re-evaluates. '
  'A processing row older than the lease (15 min) is treated as a crashed worker and re-claimed. No payloads stored.';
comment on column public.stripe_webhook_events.attempts is
  'Claim counter used as a fencing token: every update after a claim is conditional on (status, attempts).';
comment on column public.stripe_webhook_events.last_error is
  'Short error / rejection reason (max 500 chars). Never contains the event payload, card data or emails.';

create index if not exists idx_stripe_webhook_events_status_claimed
  on public.stripe_webhook_events (status, claimed_at)
  where status <> 'processed';

alter table public.stripe_webhook_events enable row level security;

drop policy if exists stripe_webhook_events_server_only on public.stripe_webhook_events;
create policy stripe_webhook_events_server_only on public.stripe_webhook_events
  as restrictive for all to public using (false) with check (false);

revoke all on public.stripe_webhook_events from public, anon, authenticated;
grant select, insert, update on public.stripe_webhook_events to service_role;

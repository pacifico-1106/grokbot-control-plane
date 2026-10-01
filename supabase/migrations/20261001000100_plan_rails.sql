-- P1 Plan Rails: per-plan MCP allowlists and approval route templates.
-- Feature flag P1_PLAN_RAILS_ENABLED must be ON to use these features.
-- When flag is OFF, existing behavior preserved (byte-identical).
-- Safe to re-run (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).
--
-- Security invariants:
-- - plan_key = NULL means legacy (no filtering)
-- - Unknown/invalid plan_key = fail closed in application code
-- - stripe_processed_events enforces webhook idempotency
-- - RLS restricts access to service role only

begin;
set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- orgs: plan_key and billing_status columns
-- ---------------------------------------------------------------------------

-- plan_key: intern | proper | executive | NULL (legacy)
-- NULL = legacy org with no plan filtering (preserve existing behavior)
-- No FK constraint - plan keys are defined in code (lib/billing/plan-scopes.ts)
-- No default - new orgs must explicitly set plan_key via Stripe checkout
alter table orgs
  add column if not exists plan_key text default null;

comment on column orgs.plan_key is
  'P1 plan rails: intern | proper | executive | NULL (legacy). NULL = no plan filtering. Set via Stripe checkout webhook. Feature flag P1_PLAN_RAILS_ENABLED must be ON for filtering to apply.';

-- billing_status: mirrors Stripe subscription.status for quick checks
-- Values: trialing | active | past_due | canceled | incomplete | unpaid | expired | suspended
-- NULL = no subscription info yet
alter table orgs
  add column if not exists billing_status text default null;

comment on column orgs.billing_status is
  'P1 plan rails: mirrors Stripe subscription status. NULL = no subscription. Used with plan_key for scope filtering. Values: trialing, active, past_due, canceled, incomplete, unpaid, expired, suspended.';

-- scheduled_plan_key: for scheduled downgrades at period end
-- Set when downgrade is scheduled, applied when period ends
alter table orgs
  add column if not exists scheduled_plan_key text default null;

comment on column orgs.scheduled_plan_key is
  'P1 plan rails: scheduled plan_key to apply at billing period end (downgrade). NULL = no scheduled change. Applied via Stripe webhook when period rolls over.';

-- scheduled_plan_effective_at: when the scheduled plan change takes effect
alter table orgs
  add column if not exists scheduled_plan_effective_at timestamptz default null;

comment on column orgs.scheduled_plan_effective_at is
  'P1 plan rails: timestamp when scheduled_plan_key takes effect. NULL = no scheduled change.';

-- Index for plan_key queries (when filtering by plan)
create index if not exists idx_orgs_plan_key
  on orgs(plan_key)
  where plan_key is not null;

-- Index for billing_status queries (e.g., find suspended orgs)
create index if not exists idx_orgs_billing_status
  on orgs(billing_status)
  where billing_status is not null;

-- ---------------------------------------------------------------------------
-- stripe_processed_events: webhook idempotency via event.id deduplication
-- ---------------------------------------------------------------------------

create table if not exists public.stripe_processed_events (
  event_id text primary key,
  event_type text not null,
  org_id uuid references orgs(id) on delete set null,
  processed_at timestamptz not null default now(),
  metadata jsonb default null
);

comment on table public.stripe_processed_events is
  'P1 plan rails: Stripe webhook idempotency. Stores processed event.id to prevent duplicate handling. Entries retained for audit, prunable after 90 days.';

comment on column public.stripe_processed_events.event_id is
  'Stripe event.id (evt_...). Primary key ensures exactly-once processing.';

comment on column public.stripe_processed_events.event_type is
  'Stripe event type (e.g., customer.subscription.updated). For audit/debugging.';

comment on column public.stripe_processed_events.org_id is
  'Associated org if resolvable. NULL if org could not be determined from event metadata.';

comment on column public.stripe_processed_events.metadata is
  'Optional event processing metadata for audit (e.g., plan change details).';

-- Index for cleanup queries (prune old events)
create index if not exists idx_stripe_processed_events_processed_at
  on stripe_processed_events(processed_at);

-- Index for org-scoped queries (list events for an org)
create index if not exists idx_stripe_processed_events_org_id
  on stripe_processed_events(org_id)
  where org_id is not null;

-- Enable RLS
alter table public.stripe_processed_events enable row level security;

-- RLS policy: service role only (same pattern as other security tables)
drop policy if exists stripe_processed_events_server_only on public.stripe_processed_events;
create policy stripe_processed_events_server_only on public.stripe_processed_events
  as restrictive for all to public using (false) with check (false);

comment on policy stripe_processed_events_server_only on public.stripe_processed_events is
  'RLS: Block anon/authenticated access. Server-side only via service role.';

-- Revoke public access, grant to service role only
revoke all on public.stripe_processed_events from public, anon, authenticated;
grant select, insert on public.stripe_processed_events to service_role;

-- ---------------------------------------------------------------------------
-- plan_upgrade_tickets: pending always_human approval for plan upgrades
-- ---------------------------------------------------------------------------

create table if not exists public.plan_upgrade_tickets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  stripe_event_id text not null,
  old_plan_key text,
  new_plan_key text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'expired')),
  approval_id uuid references approval_requests(id) on delete set null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references org_members(id) on delete set null,
  constraint plan_upgrade_tickets_event_unique unique (stripe_event_id)
);

comment on table public.plan_upgrade_tickets is
  'P1 plan rails: pending plan upgrade approvals. Upgrades require always_human owner approval before applying.';

-- Index for pending tickets query
create index if not exists idx_plan_upgrade_tickets_org_pending
  on plan_upgrade_tickets(org_id, status)
  where status = 'pending';

-- Enable RLS
alter table public.plan_upgrade_tickets enable row level security;

drop policy if exists plan_upgrade_tickets_server_only on public.plan_upgrade_tickets;
create policy plan_upgrade_tickets_server_only on public.plan_upgrade_tickets
  as restrictive for all to public using (false) with check (false);

revoke all on public.plan_upgrade_tickets from public, anon, authenticated;
grant select, insert, update on public.plan_upgrade_tickets to service_role;

commit;

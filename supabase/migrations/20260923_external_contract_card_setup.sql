-- P1 External Contract Card Registration
-- Design lock: p1-external-contract-card-registration-design-20260923.md
-- Data model: p1-external-contract-card-registration-data-model-20260923.md
--
-- CRITICAL SECURITY CONSTRAINTS (non-negotiable):
-- - NEVER store PAN, CVV, expiry, card_fingerprint in any column including metadata jsonb
-- - PaymentMethod ID (pm_xxx) is a token reference only — card details remain in Stripe
-- - Feature flag EXTERNAL_CONTRACT_CARD_SETUP must be OFF (0) by default
-- - Production enable requires full security audit + separate GO
--
-- SAQ A orientation: card data never touches Staffpass DB/logs/env — Stripe-hosted only

-- ---------------------------------------------------------------------------
-- 1. org_external_contract_payment_methods
-- Main store for external contract payment method registration status.
-- Stores PaymentMethod token reference only — never raw card data.
-- ---------------------------------------------------------------------------
create table if not exists org_external_contract_payment_methods (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  
  -- Stripe PaymentMethod ID (pm_xxx) — token reference only
  -- Card details (PAN/CVV/expiry) remain in Stripe; never stored here
  stripe_payment_method_id text,
  
  -- Setup status lifecycle
  setup_status text not null default 'pending'
    check (setup_status in ('pending', 'completed', 'failed', 'removed')),
  
  -- Setup completion metadata
  setup_completed_at timestamptz,
  setup_completed_by uuid references org_members(id) on delete set null,
  setup_approval_id uuid references approval_requests(id) on delete set null,
  
  -- Stripe SetupIntent ID (for tracking pending setup / webhook correlation)
  stripe_setup_intent_id text,
  
  -- Contract metadata
  -- FORBIDDEN in this jsonb: card_number, cvv, expiry, card_fingerprint, full_billing_address
  metadata jsonb not null default '{}'::jsonb,
  
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table org_external_contract_payment_methods is
  'P1 external contract payment method registration. Stores PaymentMethod token reference only — NEVER PAN/CVV/expiry/fingerprint. Feature flag OFF by default.';

comment on column org_external_contract_payment_methods.stripe_payment_method_id is
  'Stripe PaymentMethod ID (pm_xxx). Token reference only — card details remain in Stripe. NEVER store raw card data.';

comment on column org_external_contract_payment_methods.setup_approval_id is
  'always_human approval ID for bind/change. Required for completed status. Enforced at application layer.';

comment on column org_external_contract_payment_methods.metadata is
  'Contract metadata. FORBIDDEN: card_number, cvv, expiry, card_fingerprint, full_billing_address, any raw card data.';

-- Primary lookup: org's payment method
create index if not exists org_ext_contract_pm_org_idx
  on org_external_contract_payment_methods (org_id, setup_status);

-- Ensure only one active/completed payment method per org (v1 constraint)
create unique index if not exists org_ext_contract_pm_one_active_per_org
  on org_external_contract_payment_methods (org_id)
  where setup_status = 'completed';

-- SetupIntent lookup (for webhook processing / idempotency)
create index if not exists org_ext_contract_pm_setup_intent_idx
  on org_external_contract_payment_methods (stripe_setup_intent_id)
  where stripe_setup_intent_id is not null;

-- ---------------------------------------------------------------------------
-- 2. audit_external_contract_card_events
-- Card registration–specific audit log. NEVER store PAN/CVV/expiry/fingerprint.
-- Separate from general audit_events for PCI compliance boundary / security review.
-- ---------------------------------------------------------------------------
create table if not exists audit_external_contract_card_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  
  -- Action type
  action text not null
    check (action in (
      'link_minted',            -- Deep link created (awaiting human click)
      'link_opened',            -- Setup link clicked by human
      'setup_completed',        -- SetupIntent succeeded via webhook
      'setup_failed',           -- SetupIntent failed via webhook
      'setup_expired',          -- Checkout session expired
      'portal_link_minted',     -- Customer Portal link created
      'portal_opened',          -- Customer Portal link clicked
      'method_changed',         -- PaymentMethod changed via Portal
      'method_removed',         -- PaymentMethod removed via Portal
      'card_like_string_blocked' -- PAN-like string detected and blocked (fail-closed)
    )),
  
  -- Actor (human who performed/initiated the action)
  actor_user_id uuid references org_members(id) on delete set null,
  actor_email text,
  
  -- Approval reference (required for setup_completed / method_changed)
  approval_id uuid references approval_requests(id) on delete set null,
  
  -- Stripe session reference (not secret — safe for audit)
  stripe_session_id text,
  
  -- Outcome
  outcome text
    check (outcome in ('success', 'failure', 'expired', 'blocked', null)),
  
  -- Event metadata
  -- FORBIDDEN: card_number, cvv, expiry, card_fingerprint, error messages containing card data
  metadata jsonb not null default '{}'::jsonb,
  
  created_at timestamptz not null default now()
);

comment on table audit_external_contract_card_events is
  'P1 external contract card setup audit log. NEVER store PAN/CVV/expiry/fingerprint in any column including metadata jsonb. Separate from audit_events for security review clarity.';

comment on column audit_external_contract_card_events.approval_id is
  'always_human approval ID. Required for setup_completed / method_changed actions.';

comment on column audit_external_contract_card_events.stripe_session_id is
  'Stripe Checkout or Portal session ID for audit trail. Not a secret.';

comment on column audit_external_contract_card_events.metadata is
  'Additional event context. FORBIDDEN: card_number, cvv, expiry, card_fingerprint, error messages containing card data.';

-- Primary lookup: org's card events timeline
create index if not exists audit_ext_card_org_created_idx
  on audit_external_contract_card_events (org_id, created_at desc);

-- Action-specific queries
create index if not exists audit_ext_card_action_idx
  on audit_external_contract_card_events (org_id, action, created_at desc);

-- Approval reference lookup
create index if not exists audit_ext_card_approval_idx
  on audit_external_contract_card_events (approval_id)
  where approval_id is not null;

-- Security monitoring: blocked events
create index if not exists audit_ext_card_blocked_idx
  on audit_external_contract_card_events (created_at desc)
  where action = 'card_like_string_blocked';

-- ---------------------------------------------------------------------------
-- 3. RLS policies
-- Tenant isolation via org_members.user_id = auth.uid()
-- Service role bypasses RLS (webhook handler, admin API).
-- ---------------------------------------------------------------------------
alter table org_external_contract_payment_methods enable row level security;
alter table audit_external_contract_card_events enable row level security;

-- Payment methods: member can read, admin can write
drop policy if exists org_ext_contract_pm_select on org_external_contract_payment_methods;
drop policy if exists org_ext_contract_pm_write_admin on org_external_contract_payment_methods;

create policy org_ext_contract_pm_select on org_external_contract_payment_methods
  for select using (public.is_org_member(org_id));

create policy org_ext_contract_pm_write_admin on org_external_contract_payment_methods
  for all using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));

-- Audit events: member can read, member can insert (service role for webhooks)
drop policy if exists audit_ext_card_select on audit_external_contract_card_events;
drop policy if exists audit_ext_card_insert_member on audit_external_contract_card_events;

create policy audit_ext_card_select on audit_external_contract_card_events
  for select using (public.is_org_member(org_id));

create policy audit_ext_card_insert_member on audit_external_contract_card_events
  for insert with check (public.is_org_member(org_id));

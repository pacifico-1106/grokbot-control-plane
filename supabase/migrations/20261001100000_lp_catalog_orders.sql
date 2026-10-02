-- LP Catalog and Order Ledger (PR-0b)
-- Feature flag LP_CATALOG_DB_ENABLED must be ON to read catalog from DB.
-- Feature flag LP_ORDER_LEDGER_ENABLED must be ON to use order ledger.

-- catalog_versions: versioned catalog snapshots
CREATE TABLE IF NOT EXISTS public.lp_catalog_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_key text NOT NULL UNIQUE,
  published boolean NOT NULL DEFAULT false,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  notes text
);

COMMENT ON TABLE public.lp_catalog_versions IS 
  'Versioned catalog snapshots for LP. Only published versions are used for checkout.';

-- catalog_items: SKU definitions per catalog version
CREATE TABLE IF NOT EXISTS public.lp_catalog_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  catalog_version_id uuid NOT NULL REFERENCES public.lp_catalog_versions(id),
  sku text NOT NULL,
  display_name text NOT NULL,
  display_name_ja text NOT NULL,
  
  -- Pricing in JPY (smallest unit = 1 yen), tax-exclusive
  monthly_amount_ex_tax int,
  setup_amount_ex_tax int,
  annual_display_amount_ex_tax int,
  
  -- Stripe mapping
  stripe_price_env_key text,
  stripe_price_id text,
  
  -- Flags
  requires_quote boolean NOT NULL DEFAULT false,
  published boolean NOT NULL DEFAULT true,
  
  created_at timestamptz NOT NULL DEFAULT now(),
  
  UNIQUE(catalog_version_id, sku)
);

COMMENT ON TABLE public.lp_catalog_items IS 
  'SKU definitions per catalog version. Amounts in JPY ex-tax. Feature flag LP_CATALOG_DB_ENABLED must be ON.';

-- Index for efficient lookups
CREATE INDEX IF NOT EXISTS idx_lp_catalog_items_version_sku 
  ON public.lp_catalog_items(catalog_version_id, sku);

-- Enable RLS
ALTER TABLE public.lp_catalog_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lp_catalog_items ENABLE ROW LEVEL SECURITY;

-- Revoke from anon/authenticated (read via API only)
REVOKE ALL ON public.lp_catalog_versions FROM anon, authenticated;
REVOKE ALL ON public.lp_catalog_items FROM anon, authenticated;

-- Grant to service role
GRANT SELECT, INSERT, UPDATE ON public.lp_catalog_versions TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.lp_catalog_items TO service_role;

-- Seed initial catalog matching current LP values (all JPY ex-tax)
INSERT INTO public.lp_catalog_versions (version_key, published, published_at, notes)
VALUES ('2026-10-01-initial', true, now(), 'Initial catalog matching LP values as of 2026-10-01')
ON CONFLICT (version_key) DO NOTHING;

INSERT INTO public.lp_catalog_items (
  catalog_version_id, sku, display_name, display_name_ja,
  monthly_amount_ex_tax, setup_amount_ex_tax, annual_display_amount_ex_tax,
  stripe_price_env_key, requires_quote, published
)
SELECT 
  cv.id,
  items.sku,
  items.display_name,
  items.display_name_ja,
  items.monthly_amount_ex_tax,
  items.setup_amount_ex_tax,
  items.annual_display_amount_ex_tax,
  items.stripe_price_env_key,
  items.requires_quote,
  items.published
FROM public.lp_catalog_versions cv
CROSS JOIN (
  VALUES 
    ('intern', 'Intern', 'インターン', 50000, 150000, 540000, 'STRIPE_PRICE_ID_AI_EMP_SETUP_INTERN', false, true),
    ('proper', 'Proper', 'プロパー', 150000, 150000, 1620000, 'STRIPE_PRICE_ID_AI_EMP_SETUP_PROPER', false, true),
    ('executive', 'Executive', 'エグゼクティブ', 300000, 300000, 3240000, 'STRIPE_PRICE_ID_AI_EMP_SETUP_EXECUTIVE', false, true),
    ('custom', 'Custom', 'カスタマイズ', NULL, NULL, NULL, NULL, true, true)
) AS items(sku, display_name, display_name_ja, monthly_amount_ex_tax, setup_amount_ex_tax, annual_display_amount_ex_tax, stripe_price_env_key, requires_quote, published)
WHERE cv.version_key = '2026-10-01-initial'
ON CONFLICT (catalog_version_id, sku) DO NOTHING;

-- orders: LP order ledger
CREATE TABLE IF NOT EXISTS public.lp_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'::uuid,
  
  -- Customer reference (from inquiry or journey)
  inquiry_id uuid,
  journey_id uuid,
  email text NOT NULL,
  
  -- Order state
  current_revision int NOT NULL DEFAULT 1,
  catalog_version_id uuid REFERENCES public.lp_catalog_versions(id),
  
  -- Status breakdown (per spec sections 8, 19, 20)
  payment_status text NOT NULL DEFAULT 'not_started' 
    CHECK (payment_status IN ('not_started', 'pending', 'paid', 'failed', 'refunded')),
  contract_status text NOT NULL DEFAULT 'not_accepted'
    CHECK (contract_status IN ('not_accepted', 'terms_accepted', 'concluded', 'cancelled')),
  service_status text NOT NULL DEFAULT 'not_started'
    CHECK (service_status IN ('not_started', 'scheduled', 'provisioning', 'active', 'suspended', 'ended')),
  
  -- Overall status for display
  status text NOT NULL DEFAULT 'draft' 
    CHECK (status IN (
      'draft', 'application_submitted', 'checkout_pending',
      'payment_pending', 'setup_paid', 'provisioning',
      'active', 'payment_failed', 'paid_provisioning_failed',
      'cancelled', 'review_required'
    )),
  
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.lp_orders IS 
  'LP order ledger. Feature flag LP_ORDER_LEDGER_ENABLED must be ON.';

-- order_revisions: immutable order snapshots
CREATE TABLE IF NOT EXISTS public.lp_order_revisions (
  id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  order_id uuid NOT NULL REFERENCES public.lp_orders(id),
  tenant_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'::uuid,
  revision int NOT NULL,
  
  -- Snapshot of order at this revision
  snapshot jsonb NOT NULL,
  snapshot_hash text NOT NULL,
  
  -- Terms acceptance
  terms_version text NOT NULL,
  accepted_at timestamptz,
  acceptance_event_id uuid,
  
  created_at timestamptz NOT NULL DEFAULT now(),
  
  PRIMARY KEY (order_id, revision),
  CONSTRAINT lp_order_revisions_snapshot_size CHECK (pg_column_size(snapshot) <= 32768)
);

COMMENT ON TABLE public.lp_order_revisions IS 
  'Immutable order revision snapshots. Never UPDATE/DELETE after acceptance.';

-- checkout_attempts: track checkout session attempts
CREATE TABLE IF NOT EXISTS public.lp_checkout_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.lp_orders(id),
  tenant_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'::uuid,
  revision int NOT NULL,
  attempt_number int NOT NULL,
  
  -- Stripe session info
  stripe_session_id text,
  stripe_mode text NOT NULL DEFAULT 'payment' CHECK (stripe_mode IN ('payment', 'subscription', 'setup')),
  
  -- Status
  status text NOT NULL DEFAULT 'created' 
    CHECK (status IN ('created', 'pending', 'complete', 'expired', 'failed')),
  
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  
  -- Only one valid/pending attempt per order at a time
  UNIQUE(order_id, revision, attempt_number)
);

COMMENT ON TABLE public.lp_checkout_attempts IS 
  'Track Stripe checkout attempts per order revision.';

-- Partial unique index: only one non-expired/non-failed attempt at a time
CREATE UNIQUE INDEX IF NOT EXISTS idx_lp_checkout_attempts_active
  ON public.lp_checkout_attempts(order_id)
  WHERE status IN ('created', 'pending');

-- stripe_event_inbox: idempotent webhook processing
CREATE TABLE IF NOT EXISTS public.lp_stripe_event_inbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  environment text NOT NULL CHECK (environment IN ('test', 'live')),
  account_id text NOT NULL,
  event_id text NOT NULL,
  event_type text NOT NULL,
  object_id text NOT NULL,
  
  -- Processing status
  status text NOT NULL DEFAULT 'pending' 
    CHECK (status IN ('pending', 'processing', 'processed', 'failed', 'ignored')),
  
  -- Payload (no secrets)
  payload_hash text,
  
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  error text,
  
  -- Unique per environment/account/event
  UNIQUE(environment, account_id, event_id)
);

COMMENT ON TABLE public.lp_stripe_event_inbox IS 
  'Idempotent Stripe webhook event inbox. One row per event ID.';

-- Indexes
CREATE INDEX IF NOT EXISTS idx_lp_orders_tenant ON public.lp_orders(tenant_id);
CREATE INDEX IF NOT EXISTS idx_lp_orders_email ON public.lp_orders(email);
CREATE INDEX IF NOT EXISTS idx_lp_orders_status ON public.lp_orders(status);
CREATE INDEX IF NOT EXISTS idx_lp_stripe_event_inbox_pending 
  ON public.lp_stripe_event_inbox(status, received_at) WHERE status = 'pending';

-- Enable RLS on all tables
ALTER TABLE public.lp_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lp_order_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lp_checkout_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lp_stripe_event_inbox ENABLE ROW LEVEL SECURITY;

-- Revoke from anon/authenticated (server-only)
REVOKE ALL ON public.lp_orders FROM anon, authenticated;
REVOKE ALL ON public.lp_order_revisions FROM anon, authenticated;
REVOKE ALL ON public.lp_checkout_attempts FROM anon, authenticated;
REVOKE ALL ON public.lp_stripe_event_inbox FROM anon, authenticated;

-- Grant to service role
GRANT SELECT, INSERT, UPDATE ON public.lp_orders TO service_role;
GRANT SELECT, INSERT ON public.lp_order_revisions TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.lp_checkout_attempts TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.lp_stripe_event_inbox TO service_role;

-- Function to get current published catalog
CREATE OR REPLACE FUNCTION public.get_published_lp_catalog()
RETURNS TABLE (
  sku text,
  display_name text,
  display_name_ja text,
  monthly_amount_ex_tax int,
  setup_amount_ex_tax int,
  annual_display_amount_ex_tax int,
  stripe_price_env_key text,
  requires_quote boolean,
  catalog_version_key text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT 
    ci.sku,
    ci.display_name,
    ci.display_name_ja,
    ci.monthly_amount_ex_tax,
    ci.setup_amount_ex_tax,
    ci.annual_display_amount_ex_tax,
    ci.stripe_price_env_key,
    ci.requires_quote,
    cv.version_key AS catalog_version_key
  FROM public.lp_catalog_items ci
  JOIN public.lp_catalog_versions cv ON cv.id = ci.catalog_version_id
  WHERE cv.published = true AND ci.published = true
  ORDER BY 
    CASE ci.sku
      WHEN 'intern' THEN 1
      WHEN 'proper' THEN 2
      WHEN 'executive' THEN 3
      WHEN 'custom' THEN 4
      ELSE 5
    END;
$$;

REVOKE ALL ON FUNCTION public.get_published_lp_catalog() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_published_lp_catalog() TO service_role;

-- LP Inquiry Intake Hardening (PR-0a)
-- Feature flag LP_INQUIRY_DB_ENABLED must be ON to use this table.
-- Feature flag LP_INQUIRY_BOT_PROTECTION_ENABLED gates bot protection (Turnstile + rate limit).

-- inquiries: tenant-scoped LP inquiries with 90-day retention
CREATE TABLE IF NOT EXISTS public.lp_inquiries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'::uuid,
  source text NOT NULL CHECK (source IN ('form', 'chat_handoff')),
  plan text NOT NULL CHECK (plan IN ('intern', 'proper', 'executive', 'custom', 'undecided')),
  billing_preference text NOT NULL DEFAULT 'monthly' CHECK (billing_preference IN ('monthly', 'annual')),
  
  -- Contact fields in dedicated columns
  company text NOT NULL,
  contact_name text NOT NULL,
  email text NOT NULL,
  phone text,
  headcount text,
  
  -- Use case with length limit (2000 chars max enforced at API layer)
  use_case text NOT NULL,
  
  -- Consent record
  consent_given boolean NOT NULL DEFAULT false,
  consent_version text,
  consent_at timestamptz,
  
  -- Status tracking
  status text NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'notified', 'contacted', 'closed')),
  
  -- Retention: 90 days from creation
  created_at timestamptz NOT NULL DEFAULT now(),
  retention_until timestamptz NOT NULL DEFAULT (now() + interval '90 days'),
  
  -- For chat handoff summary
  handoff_summary text,
  journey_id uuid,
  
  CONSTRAINT lp_inquiries_use_case_length CHECK (char_length(use_case) <= 2000),
  CONSTRAINT lp_inquiries_handoff_summary_length CHECK (handoff_summary IS NULL OR char_length(handoff_summary) <= 2000)
);

COMMENT ON TABLE public.lp_inquiries IS 
  'LP AI社員パック inquiries. tenant-scoped, RLS enabled, anon/authenticated revoked, server-only access. 90-day retention. Feature flag LP_INQUIRY_DB_ENABLED must be ON.';

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_lp_inquiries_tenant_created 
  ON public.lp_inquiries(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lp_inquiries_retention 
  ON public.lp_inquiries(retention_until) WHERE retention_until IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lp_inquiries_status 
  ON public.lp_inquiries(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_lp_inquiries_email 
  ON public.lp_inquiries(tenant_id, email);

-- Enable RLS
ALTER TABLE public.lp_inquiries ENABLE ROW LEVEL SECURITY;

-- Revoke all from anon and authenticated (server-only access)
REVOKE ALL ON public.lp_inquiries FROM anon, authenticated;

-- Only service role can access this table (via server API routes)
-- No RLS policy for anon/authenticated = they cannot see any rows even if GRANT existed

-- Grant to service role (admin client) only
GRANT SELECT, INSERT, UPDATE ON public.lp_inquiries TO service_role;

-- notification_outbox: durable outbox for email notifications with idempotency
CREATE TABLE IF NOT EXISTS public.notification_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'::uuid,
  
  -- Business key for idempotency (unique per tenant)
  business_key text NOT NULL,
  
  -- Notification details
  notification_type text NOT NULL CHECK (notification_type IN ('inquiry_received', 'handoff_created', 'order_submitted', 'payment_confirmed')),
  recipient text NOT NULL,
  subject text NOT NULL,
  
  -- Template and payload (no secrets in payload)
  template text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  
  -- Status tracking
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  provider_id text,
  attempt_count int NOT NULL DEFAULT 0,
  last_attempt_at timestamptz,
  last_error text,
  
  -- Timestamps
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  
  CONSTRAINT notification_outbox_payload_size CHECK (pg_column_size(payload) <= 32768)
);

COMMENT ON TABLE public.notification_outbox IS 
  'Durable notification outbox for LP events. Business key ensures idempotent sends. Service-role only.';

-- Unique index for business key per tenant
CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_outbox_business_key 
  ON public.notification_outbox(tenant_id, business_key);
CREATE INDEX IF NOT EXISTS idx_notification_outbox_pending 
  ON public.notification_outbox(status, created_at) WHERE status = 'pending';

-- Enable RLS  
ALTER TABLE public.notification_outbox ENABLE ROW LEVEL SECURITY;

-- Revoke all from anon and authenticated
REVOKE ALL ON public.notification_outbox FROM anon, authenticated;

-- Grant to service role only
GRANT SELECT, INSERT, UPDATE ON public.notification_outbox TO service_role;

-- Cleanup function for expired inquiries (called by cron)
CREATE OR REPLACE FUNCTION public.cleanup_expired_lp_inquiries()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  deleted_count int;
BEGIN
  DELETE FROM public.lp_inquiries
  WHERE retention_until < now()
  RETURNING 1 INTO deleted_count;
  
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

COMMENT ON FUNCTION public.cleanup_expired_lp_inquiries IS
  'Cleanup expired LP inquiries (retention_until passed). Called by scheduled cron. Feature flag LP_INQUIRY_CLEANUP_ENABLED must be ON.';

-- Revoke execute from public
REVOKE ALL ON FUNCTION public.cleanup_expired_lp_inquiries() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_expired_lp_inquiries() TO service_role;

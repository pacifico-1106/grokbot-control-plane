-- PR-1c: Handoffs and wake webhooks for LP AI consultation
-- Feature flags: LP_HANDOFF_ENABLED, LP_WAKE_WEBHOOK_ENABLED (default OFF)

-- Handoff requests table
-- Stores requests to transfer chat sessions to human consultation
CREATE TABLE IF NOT EXISTS lp_handoffs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'::uuid,
  journey_id uuid NOT NULL,
  
  -- Handoff details
  reason text NOT NULL,
  summary_draft text NOT NULL,
  summary_final text, -- Set after user confirms/edits
  
  -- User-provided contact info (optional, user chooses to share)
  contact_email text,
  contact_phone text,
  contact_notes text,
  
  -- Status tracking
  status text NOT NULL DEFAULT 'pending_confirmation'
    CHECK (status IN ('pending_confirmation', 'confirmed', 'sent_to_outbox', 'delivered', 'cancelled')),
  
  -- Timestamps
  confirmed_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  
  -- Metadata for auditing
  ip_hash text,
  user_agent_hash text
);

-- Indexes for handoffs
CREATE INDEX IF NOT EXISTS idx_lp_handoffs_journey ON lp_handoffs(journey_id);
CREATE INDEX IF NOT EXISTS idx_lp_handoffs_status ON lp_handoffs(status) WHERE status != 'cancelled';
CREATE INDEX IF NOT EXISTS idx_lp_handoffs_created ON lp_handoffs(created_at DESC);

-- Wake webhooks configuration table
-- Stores webhook endpoints for external systems to trigger wakes
CREATE TABLE IF NOT EXISTS lp_wake_webhook_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'::uuid,
  
  -- Webhook configuration
  name text NOT NULL,
  endpoint_path text NOT NULL UNIQUE, -- e.g., /api/webhooks/lp-wake/abc123
  secret_hash text NOT NULL, -- SHA-256 hash of the webhook secret
  
  -- What the webhook does
  trigger_type text NOT NULL DEFAULT 'journey_resume'
    CHECK (trigger_type IN ('journey_resume', 'notification', 'custom')),
  
  -- Status
  enabled boolean NOT NULL DEFAULT true,
  last_triggered_at timestamptz,
  trigger_count integer NOT NULL DEFAULT 0,
  
  -- Timestamps
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Wake webhook events log
-- Audit trail for webhook invocations
CREATE TABLE IF NOT EXISTS lp_wake_webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'::uuid,
  webhook_config_id uuid NOT NULL REFERENCES lp_wake_webhook_configs(id),
  
  -- Event details
  event_type text NOT NULL,
  payload_hash text, -- Hash of payload for deduplication
  
  -- Result
  status text NOT NULL DEFAULT 'received'
    CHECK (status IN ('received', 'processed', 'failed', 'duplicate')),
  error_code text,
  
  -- Deduplication
  idempotency_key text,
  
  -- Timestamps
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  
  -- Metadata
  ip_hash text,
  user_agent_hash text
);

-- Indexes for webhook events
CREATE INDEX IF NOT EXISTS idx_lp_wake_events_config ON lp_wake_webhook_events(webhook_config_id);
CREATE INDEX IF NOT EXISTS idx_lp_wake_events_idempotency ON lp_wake_webhook_events(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lp_wake_events_received ON lp_wake_webhook_events(received_at DESC);

-- Notification outbox extension for handoff notifications
-- Uses existing notification_outbox table with handoff-specific payload
-- business_key format: handoff:<handoff_id>

-- Enable RLS
ALTER TABLE lp_handoffs ENABLE ROW LEVEL SECURITY;
ALTER TABLE lp_wake_webhook_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE lp_wake_webhook_events ENABLE ROW LEVEL SECURITY;

-- Service role policies (no anon access)
CREATE POLICY "lp_handoffs_service_all" ON lp_handoffs
  FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "lp_wake_configs_service_all" ON lp_wake_webhook_configs
  FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "lp_wake_events_service_all" ON lp_wake_webhook_events
  FOR ALL USING (auth.role() = 'service_role');

-- Add comment for documentation
COMMENT ON TABLE lp_handoffs IS 'Handoff requests from AI chat to human consultation. Part of LP Phase 1c.';
COMMENT ON TABLE lp_wake_webhook_configs IS 'Configuration for external webhook triggers. Part of LP Phase 1c.';
COMMENT ON TABLE lp_wake_webhook_events IS 'Audit log for webhook invocations. Part of LP Phase 1c.';
COMMENT ON COLUMN lp_handoffs.summary_draft IS 'AI-generated summary for user review. Never sent without confirmation.';
COMMENT ON COLUMN lp_handoffs.summary_final IS 'User-confirmed (possibly edited) summary that was shared.';

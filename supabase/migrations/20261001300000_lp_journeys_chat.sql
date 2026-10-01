-- LP Journeys and Chat (PR-1b)
-- Feature flag LP_CHAT_ENABLED must be ON.

-- journeys: guest chat sessions
CREATE TABLE IF NOT EXISTS public.lp_journeys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'::uuid,
  
  -- Guest identification (hashed token, not raw)
  token_hash text NOT NULL UNIQUE,
  
  -- Session state
  active_agent text NOT NULL DEFAULT 'sales',
  kb_release_id uuid,
  prompt_version text NOT NULL DEFAULT 'v1',
  
  -- Consent
  ai_disclosure_accepted boolean NOT NULL DEFAULT false,
  privacy_version text,
  
  -- Limits and expiry
  expires_at timestamptz NOT NULL,
  turn_count int NOT NULL DEFAULT 0,
  
  -- Timestamps
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  
  UNIQUE(id, tenant_id)
);

COMMENT ON TABLE public.lp_journeys IS 
  'LP chat journeys. Guest sessions with consent tracking. Feature flag LP_CHAT_ENABLED must be ON.';

-- consent_events: audit trail for consent
CREATE TABLE IF NOT EXISTS public.lp_consent_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  journey_id uuid NOT NULL REFERENCES public.lp_journeys(id),
  tenant_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'::uuid,
  
  -- What was consented to
  consent_type text NOT NULL CHECK (consent_type IN ('ai_disclosure', 'privacy', 'handoff_data_share')),
  version text NOT NULL,
  
  -- How consent was given
  method text NOT NULL DEFAULT 'button_click' CHECK (method IN ('button_click', 'checkbox', 'form_submit')),
  
  -- Timestamp
  consented_at timestamptz NOT NULL DEFAULT now(),
  
  -- IP hash for fraud detection (not raw IP)
  ip_hash text
);

COMMENT ON TABLE public.lp_consent_events IS 
  'Consent audit trail for LP journeys. Never delete.';

-- chat_turns: minimal turn tracking for rate limiting (no transcript storage)
CREATE TABLE IF NOT EXISTS public.lp_chat_turns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  journey_id uuid NOT NULL REFERENCES public.lp_journeys(id),
  tenant_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'::uuid,
  
  -- Turn metadata (no transcript content)
  turn_number int NOT NULL,
  client_turn_id text,
  kb_release_id uuid,
  
  -- Token usage for billing
  input_tokens int,
  output_tokens int,
  model text,
  
  -- Tool calls (names only, not arguments)
  tool_calls text[],
  
  -- Timestamps
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  
  UNIQUE(journey_id, turn_number),
  UNIQUE(journey_id, client_turn_id)
);

COMMENT ON TABLE public.lp_chat_turns IS 
  'Chat turn metadata for rate limiting and usage tracking. No transcript stored.';

-- rate_buckets: rate limiting counters
CREATE TABLE IF NOT EXISTS public.lp_rate_buckets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_type text NOT NULL CHECK (bucket_type IN ('journey', 'ip_hash', 'tenant', 'global')),
  bucket_key text NOT NULL,
  window_start timestamptz NOT NULL,
  window_seconds int NOT NULL DEFAULT 60,
  request_count int NOT NULL DEFAULT 0,
  token_count int NOT NULL DEFAULT 0,
  
  updated_at timestamptz NOT NULL DEFAULT now(),
  
  UNIQUE(bucket_type, bucket_key, window_start)
);

COMMENT ON TABLE public.lp_rate_buckets IS 
  'Rate limiting buckets for LP chat.';

-- Indexes
CREATE INDEX IF NOT EXISTS idx_lp_journeys_tenant ON public.lp_journeys(tenant_id);
CREATE INDEX IF NOT EXISTS idx_lp_journeys_expires ON public.lp_journeys(expires_at);
CREATE INDEX IF NOT EXISTS idx_lp_consent_events_journey ON public.lp_consent_events(journey_id);
CREATE INDEX IF NOT EXISTS idx_lp_chat_turns_journey ON public.lp_chat_turns(journey_id);
CREATE INDEX IF NOT EXISTS idx_lp_rate_buckets_cleanup ON public.lp_rate_buckets(window_start);

-- Enable RLS
ALTER TABLE public.lp_journeys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lp_consent_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lp_chat_turns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lp_rate_buckets ENABLE ROW LEVEL SECURITY;

-- Revoke from anon/authenticated
REVOKE ALL ON public.lp_journeys FROM anon, authenticated;
REVOKE ALL ON public.lp_consent_events FROM anon, authenticated;
REVOKE ALL ON public.lp_chat_turns FROM anon, authenticated;
REVOKE ALL ON public.lp_rate_buckets FROM anon, authenticated;

-- Grant to service role
GRANT SELECT, INSERT, UPDATE ON public.lp_journeys TO service_role;
GRANT SELECT, INSERT ON public.lp_consent_events TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.lp_chat_turns TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.lp_rate_buckets TO service_role;

-- Cleanup expired journeys (called by cron)
CREATE OR REPLACE FUNCTION public.cleanup_expired_lp_journeys()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  deleted_count int;
BEGIN
  -- Delete expired journeys (cascades to consent_events and chat_turns via ON DELETE)
  -- Actually we don't have ON DELETE CASCADE, so we need to handle manually
  DELETE FROM public.lp_chat_turns
  WHERE journey_id IN (
    SELECT id FROM public.lp_journeys WHERE expires_at < now() - interval '1 hour'
  );
  
  DELETE FROM public.lp_consent_events
  WHERE journey_id IN (
    SELECT id FROM public.lp_journeys WHERE expires_at < now() - interval '1 hour'
  );
  
  DELETE FROM public.lp_journeys
  WHERE expires_at < now() - interval '1 hour'
  RETURNING 1 INTO deleted_count;
  
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  
  -- Also cleanup old rate buckets
  DELETE FROM public.lp_rate_buckets
  WHERE window_start < now() - interval '1 day';
  
  RETURN deleted_count;
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_expired_lp_journeys() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_expired_lp_journeys() TO service_role;

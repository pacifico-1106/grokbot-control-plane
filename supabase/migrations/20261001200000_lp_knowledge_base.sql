-- LP Knowledge Base (PR-1a)
-- Feature flag LP_CHAT_ENABLED must be ON to use KB in chat.
-- Admin MCP tools: kb.draft, kb.release.propose, kb.read

-- kb_documents: knowledge base documents
CREATE TABLE IF NOT EXISTS public.lp_kb_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'::uuid,
  document_key text NOT NULL,
  title text NOT NULL,
  source_url text,
  scope text NOT NULL DEFAULT 'public' CHECK (scope IN ('public', 'internal', 'quarantined')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  
  UNIQUE(tenant_id, document_key)
);

COMMENT ON TABLE public.lp_kb_documents IS 
  'Knowledge base documents. scope=public for published, quarantined for unapproved content.';

-- kb_revisions: immutable document revisions
CREATE TABLE IF NOT EXISTS public.lp_kb_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES public.lp_kb_documents(id),
  revision int NOT NULL,
  content text NOT NULL,
  content_hash text NOT NULL,
  approved_by text,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  
  UNIQUE(document_id, revision),
  CONSTRAINT lp_kb_revisions_content_length CHECK (char_length(content) <= 10000)
);

COMMENT ON TABLE public.lp_kb_revisions IS 
  'Immutable document revisions. Content is versioned, never updated in place.';

-- kb_releases: published sets of revisions
CREATE TABLE IF NOT EXISTS public.lp_kb_releases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'::uuid,
  release_key text NOT NULL,
  revision_ids uuid[] NOT NULL,
  effective_at timestamptz NOT NULL DEFAULT now(),
  supersedes uuid REFERENCES public.lp_kb_releases(id),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending_approval', 'published', 'superseded')),
  published_by text,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  
  UNIQUE(tenant_id, release_key)
);

COMMENT ON TABLE public.lp_kb_releases IS 
  'Published KB releases. Only status=published releases are used for search.';

-- Indexes
CREATE INDEX IF NOT EXISTS idx_lp_kb_documents_tenant ON public.lp_kb_documents(tenant_id);
CREATE INDEX IF NOT EXISTS idx_lp_kb_documents_scope ON public.lp_kb_documents(tenant_id, scope);
CREATE INDEX IF NOT EXISTS idx_lp_kb_revisions_document ON public.lp_kb_revisions(document_id);
CREATE INDEX IF NOT EXISTS idx_lp_kb_releases_tenant ON public.lp_kb_releases(tenant_id);
CREATE INDEX IF NOT EXISTS idx_lp_kb_releases_status ON public.lp_kb_releases(tenant_id, status);

-- Enable RLS
ALTER TABLE public.lp_kb_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lp_kb_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lp_kb_releases ENABLE ROW LEVEL SECURITY;

-- Revoke from anon/authenticated
REVOKE ALL ON public.lp_kb_documents FROM anon, authenticated;
REVOKE ALL ON public.lp_kb_revisions FROM anon, authenticated;
REVOKE ALL ON public.lp_kb_releases FROM anon, authenticated;

-- Grant to service role
GRANT SELECT, INSERT, UPDATE ON public.lp_kb_documents TO service_role;
GRANT SELECT, INSERT ON public.lp_kb_revisions TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.lp_kb_releases TO service_role;

-- Seed public FAQ documents (SP01-SP05 from spec section 17)
INSERT INTO public.lp_kb_documents (tenant_id, document_key, title, source_url, scope)
VALUES 
  ('00000000-0000-0000-0000-000000000001', 'faq-sp01', 'どんな仕事を頼める？', 'https://staffpass.sealith.com/lp/ai-employee#faq', 'public'),
  ('00000000-0000-0000-0000-000000000001', 'faq-sp02', 'どのプランがよい？', 'https://staffpass.sealith.com/lp/ai-employee#faq', 'public'),
  ('00000000-0000-0000-0000-000000000001', 'faq-sp03', 'すぐ使える？', 'https://staffpass.sealith.com/lp/ai-employee#faq', 'public'),
  ('00000000-0000-0000-0000-000000000001', 'faq-sp04', '外部サービス代は込み？', 'https://staffpass.sealith.com/lp/ai-employee#faq', 'public'),
  ('00000000-0000-0000-0000-000000000001', 'faq-sp05', '間違いは絶対に起きない？', 'https://staffpass.sealith.com/lp/ai-employee#faq', 'public')
ON CONFLICT (tenant_id, document_key) DO NOTHING;

-- Seed FAQ content revisions
INSERT INTO public.lp_kb_revisions (document_id, revision, content, content_hash, approved_by, approved_at)
SELECT 
  d.id,
  1,
  items.content,
  encode(sha256(items.content::bytea), 'hex'),
  'system',
  now()
FROM public.lp_kb_documents d
CROSS JOIN (
  VALUES 
    ('faq-sp01', 'AI社員は、承認した業務と権限の範囲で設計します。任せたい具体的な業務を確認させてください。日報・議事録・社内案内の下書き、問い合わせへの一次返信、予定調整など、定型業務から始められます。'),
    ('faq-sp02', '作業領域の数と複雑さから候補をお伝えします。定型1領域ならインターン、約3業務相当ならプロパー、高度運用や複数業務の個別設計はエグゼクティブをおすすめします。最終的な範囲は確認が必要です。'),
    ('faq-sp03', 'LPにはセットアップ開始12月以降と表示しています。個別の開始日はお約束できません。導入の準備ができましたらご案内いたします。'),
    ('faq-sp04', 'Google Workspace・Slack・外部アカウント等の別途費用がかかります。必要な環境は導入前に確認させてください。'),
    ('faq-sp05', '完全な正確性や成果は保証できません。重要な処理については、承認設計を確認させてください。')
) AS items(doc_key, content)
WHERE d.document_key = items.doc_key
ON CONFLICT (document_id, revision) DO NOTHING;

-- Create initial published release
INSERT INTO public.lp_kb_releases (tenant_id, release_key, revision_ids, effective_at, status, published_by, published_at)
SELECT 
  '00000000-0000-0000-0000-000000000001'::uuid,
  '2026-10-01-initial',
  array_agg(r.id),
  now(),
  'published',
  'system',
  now()
FROM public.lp_kb_revisions r
JOIN public.lp_kb_documents d ON d.id = r.document_id
WHERE d.scope = 'public' AND r.revision = 1
HAVING count(*) > 0
ON CONFLICT (tenant_id, release_key) DO NOTHING;

-- Quarantined content (not in published release)
-- Trial, refund, billing start, annual payment, cancellation deadline, contract formation
INSERT INTO public.lp_kb_documents (tenant_id, document_key, title, source_url, scope)
VALUES 
  ('00000000-0000-0000-0000-000000000001', 'policy-trial', '試用期間について', NULL, 'quarantined'),
  ('00000000-0000-0000-0000-000000000001', 'policy-refund', '返金について', NULL, 'quarantined'),
  ('00000000-0000-0000-0000-000000000001', 'policy-billing-start', '課金開始について', NULL, 'quarantined'),
  ('00000000-0000-0000-0000-000000000001', 'policy-annual', '年契約支払いについて', NULL, 'quarantined'),
  ('00000000-0000-0000-0000-000000000001', 'policy-cancellation', '解約締切について', NULL, 'quarantined'),
  ('00000000-0000-0000-0000-000000000001', 'policy-contract', '契約成立時点について', NULL, 'quarantined')
ON CONFLICT (tenant_id, document_key) DO NOTHING;

-- Function to get published KB content
CREATE OR REPLACE FUNCTION public.search_published_kb(
  p_query text,
  p_tenant_id uuid DEFAULT '00000000-0000-0000-0000-000000000001'::uuid,
  p_limit int DEFAULT 3
)
RETURNS TABLE (
  document_id uuid,
  document_key text,
  title text,
  source_url text,
  revision int,
  content text,
  release_key text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT 
    d.id AS document_id,
    d.document_key,
    d.title,
    d.source_url,
    r.revision,
    r.content,
    rel.release_key
  FROM public.lp_kb_releases rel
  JOIN public.lp_kb_revisions r ON r.id = ANY(rel.revision_ids)
  JOIN public.lp_kb_documents d ON d.id = r.document_id
  WHERE rel.tenant_id = p_tenant_id
    AND rel.status = 'published'
    AND d.scope = 'public'
    AND (
      d.title ILIKE '%' || p_query || '%'
      OR d.document_key ILIKE '%' || p_query || '%'
      OR r.content ILIKE '%' || p_query || '%'
    )
  ORDER BY 
    CASE 
      WHEN d.title ILIKE '%' || p_query || '%' THEN 0
      ELSE 1
    END,
    d.created_at DESC
  LIMIT p_limit;
$$;

REVOKE ALL ON FUNCTION public.search_published_kb(text, uuid, int) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_published_kb(text, uuid, int) TO service_role;

-- Function to get current published release
CREATE OR REPLACE FUNCTION public.get_published_kb_release(
  p_tenant_id uuid DEFAULT '00000000-0000-0000-0000-000000000001'::uuid
)
RETURNS TABLE (
  release_id uuid,
  release_key text,
  published_at timestamptz,
  document_count int
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT 
    rel.id AS release_id,
    rel.release_key,
    rel.published_at,
    cardinality(rel.revision_ids) AS document_count
  FROM public.lp_kb_releases rel
  WHERE rel.tenant_id = p_tenant_id
    AND rel.status = 'published'
  ORDER BY rel.effective_at DESC
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.get_published_kb_release(uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_published_kb_release(uuid) TO service_role;

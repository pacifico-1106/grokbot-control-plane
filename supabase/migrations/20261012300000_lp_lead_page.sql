-- LP lead page (pattern A / B) and referrer on LP leads.
-- Additive only: two nullable text columns per table, no default, no backfill.
-- Written by the app only with LP_LEAD_PAGE_DB_ENABLED=true (turn ON after this migration).
-- No grants change: lp_inquiries / lp_journeys stay service-role only (RLS on, no session-role policies).

alter table public.lp_inquiries
  add column if not exists lp_page text,
  add column if not exists lp_ref text;

alter table public.lp_journeys
  add column if not exists lp_page text,
  add column if not exists lp_ref text;

alter table public.lp_inquiries
  drop constraint if exists lp_inquiries_lp_page_check,
  add constraint lp_inquiries_lp_page_check check (lp_page is null or lp_page in ('ai-employee', 'ai-employee-corp')),
  drop constraint if exists lp_inquiries_lp_ref_check,
  add constraint lp_inquiries_lp_ref_check check (lp_ref is null or lp_ref ~ '^[A-Za-z0-9_-]{1,32}$');

alter table public.lp_journeys
  drop constraint if exists lp_journeys_lp_page_check,
  add constraint lp_journeys_lp_page_check check (lp_page is null or lp_page in ('ai-employee', 'ai-employee-corp')),
  drop constraint if exists lp_journeys_lp_ref_check,
  add constraint lp_journeys_lp_ref_check check (lp_ref is null or lp_ref ~ '^[A-Za-z0-9_-]{1,32}$');

comment on column public.lp_inquiries.lp_page is 'LP the lead came from (allowlist: ai-employee | ai-employee-corp). NULL = before LP_LEAD_PAGE_DB_ENABLED.';
comment on column public.lp_inquiries.lp_ref is '?ref= on pattern B, validated ^[A-Za-z0-9_-]{1,32}$; invalid values are never stored.';
comment on column public.lp_journeys.lp_page is 'LP the AI chat was started on (allowlist). Drives the variant-aware system prompt.';
comment on column public.lp_journeys.lp_ref is '?ref= on pattern B, validated ^[A-Za-z0-9_-]{1,32}$.';

-- ROLLBACK (down): app first sets LP_LEAD_PAGE_DB_ENABLED=false (code stops naming the columns)
--   alter table public.lp_inquiries drop constraint if exists lp_inquiries_lp_page_check, drop constraint if exists lp_inquiries_lp_ref_check;
--   alter table public.lp_journeys drop constraint if exists lp_journeys_lp_page_check, drop constraint if exists lp_journeys_lp_ref_check;
--   alter table public.lp_inquiries drop column if exists lp_page, drop column if exists lp_ref;
--   alter table public.lp_journeys drop column if exists lp_page, drop column if exists lp_ref;
-- END ROLLBACK

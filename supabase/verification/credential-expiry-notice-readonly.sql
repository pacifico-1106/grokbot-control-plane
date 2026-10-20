-- Read-only: was a 社員証 pre-expiry notice actually sent?
-- 木村 2026-10-16: ともり's card expired 2026-10-16 09:33 JST.
--
-- Code path (does not send unless CREDENTIAL_EXPIRY_NOTICE_ENABLED is ON):
--   GET /api/cron/telegram-digest (vercel.json: 30 23 * * * = 08:30 JST,
--   and 0 9 * * * = 18:00 JST) → isCredentialExpiryNoticeEnabled()
--   → runCredentialExpiryNotices → claim credential_expiry_notices
--   THEN sendApprovalInboxText. A send failure DELETES the claim
--   (retried next run). Audit action credential.expiry_notice, metadata.ok.
--
-- 7d window for 2026-10-16 00:33:00+00 opens 2026-10-09 00:33:00+00
--   → first eligible cron 2026-10-09 09:00 UTC (18:00 JST).
-- 1d window opens 2026-10-15 00:33:00+00
--   → first eligible cron 2026-10-15 09:00 UTC (18:00 JST).
-- If the flag is OFF, both queries below return 0 rows.
--
-- Never selects secret_hash / secret_prefix / tokens.
-- Replace the display_name pattern if needed.

-- 1. The card itself (expiry + last_used_at)
select
  e.id as employee_id,
  e.display_name,
  e.org_id,
  e.status as employee_status,
  c.id as credential_id,
  c.expires_at,
  timezone('Asia/Tokyo', c.expires_at) as expires_at_jst,
  c.revoked_at,
  c.last_used_at,
  timezone('Asia/Tokyo', c.last_used_at) as last_used_at_jst,
  c.created_at
from public.employees e
join public.credentials c on c.employee_id = e.id
where e.display_name like '%ともり%'
order by c.created_at desc;

-- 2. Dedup claims (a row = last successful claim; send-fail releases/deletes it)
select
  n.credential_id,
  n.threshold,
  n.org_id,
  n.employee_id,
  e.display_name,
  n.expires_at,
  timezone('Asia/Tokyo', n.expires_at) as expires_at_jst,
  n.notified_at,
  timezone('Asia/Tokyo', n.notified_at) as notified_at_jst
from public.credential_expiry_notices n
join public.employees e on e.id = n.employee_id
where e.display_name like '%ともり%'
order by n.notified_at;

-- 3. Audit of send attempts (metadata.ok = true means the inbox send succeeded)
select
  a.id,
  a.created_at,
  timezone('Asia/Tokyo', a.created_at) as created_at_jst,
  a.org_id,
  a.action,
  a.summary,
  a.metadata
from public.audit_events a
where a.action = 'credential.expiry_notice'
  and a.metadata::text like '%' || (
    select e.id::text from public.employees e
    where e.display_name like '%ともり%'
    order by e.created_at desc
    limit 1
  ) || '%'
order by a.created_at;

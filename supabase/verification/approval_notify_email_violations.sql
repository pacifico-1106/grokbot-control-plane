-- READ-ONLY (木村 2026-10-05 mail tightening, item 1). Lists existing
-- employees.approval_notify_email settings that break the members-only rule:
-- the address must equal (NFKC, trimmed, case-insensitive) the email of an
-- ACTIVE member of the SAME org. SELECT only: no writes, no locks beyond a
-- normal read. Output carries IDs + a reason code only (no addresses), so the
-- result can be pasted into a ticket. After this PR such rows are never sent
-- to (send-time recheck writes an audit row with IDs only); this query is for
-- cleaning them up.
--
-- reason:
--   invalid_format     not exactly one plain address (list, display name, junk)
--   member_inactive    matches a member of the same org whose status is not active
--   other_org_member   matches an ACTIVE member of a DIFFERENT org only
--   not_member         matches no member anywhere
with s as (
  select e.id as employee_id,
         e.org_id,
         e.status as employee_status,
         lower(btrim(normalize(e.approval_notify_email, NFKC))) as wanted,
         btrim(e.approval_notify_email) as raw
  from public.employees e
  where e.approval_notify_email is not null
    and btrim(e.approval_notify_email) <> ''
),
m as (
  select org_id, status, lower(btrim(normalize(email, NFKC))) as email
  from public.org_members
)
select s.employee_id,
       s.org_id,
       s.employee_status,
       case
         when length(s.raw) > 254 or s.raw !~ '^[^\s@,;<>"''()]+@[^\s@,;<>"''()]+\.[^\s@,;<>"''()]+$' then 'invalid_format'
         when exists (select 1 from m where m.org_id = s.org_id and m.email = s.wanted and m.status <> 'active') then 'member_inactive'
         when exists (select 1 from m where m.org_id <> s.org_id and m.email = s.wanted and m.status = 'active') then 'other_org_member'
         else 'not_member'
       end as reason
from s
where not exists (
  select 1 from m where m.org_id = s.org_id and m.status = 'active' and m.email = s.wanted
)
order by s.org_id, s.employee_id;

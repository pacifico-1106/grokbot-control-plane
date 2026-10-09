-- =============================================================================
-- action_limits wipe investigation (木村 2026-10-10) — READ-ONLY
--
-- Bug: updateEmployeePolicy wrote action_limits = '{}' (employees AND the
-- active credentials row) whenever a caller left actionLimits out:
--   (A) setup.lineApproval.setEmployeeInbox fulfilment — since 30a631f (2026-09-14)
--   (B) admin MCP policy.patch approved WITHOUT an actionLimits argument
--       — since at least 6e536ca (2026-09-02)
-- (Dashboard PATCH could not wipe: the policy lock refuses any posted
--  actionLimits that differs from the stored value. spend (yen caps) was never
--  touched: it is only written when passed.)
--
-- Run in the Supabase SQL editor. Everything is SELECT inside a READ ONLY
-- transaction that is rolled back. No secrets are selected (no secret_hash).
-- Optional: set the org filter in `params` (NULL = all orgs).
-- =============================================================================
begin transaction read only;

-- -----------------------------------------------------------------------------
-- Q1. Every wipe event (who, when, which ticket)
-- -----------------------------------------------------------------------------
with params as (select null::uuid as org_filter),
wipes as (
  select a.org_id,
         (a.metadata->'adminMutation'->>'employeeId')                       as employee_id,
         a.id::text                                                         as approval_id,
         'A: setup.lineApproval.setEmployeeInbox'                           as wipe_source,
         coalesce((select min(ae.created_at) from audit_events ae
                    where ae.org_id = a.org_id
                      and ae.action = 'admin.notificationChannel'
                      and ae.metadata->>'approvalId' = a.id::text), a.resolved_at) as wiped_at
    from approval_requests a, params p
   where a.metadata->>'adminTool' = 'setup.lineApproval.setEmployeeInbox'
     and a.status = 'approved'
     and coalesce(a.metadata->'adminFulfillment'->>'ok', a.metadata->'fulfillment'->>'ok') = 'true'
     and (p.org_filter is null or a.org_id = p.org_filter)
  union all
  select a.org_id,
         (a.metadata->'adminMutation'->>'employeeId'),
         a.id::text,
         'B: policy.patch without actionLimits',
         coalesce((select min(ae.created_at) from audit_events ae
                    where ae.org_id = a.org_id
                      and ae.action = 'admin.policy'
                      and ae.metadata->>'approvalId' = a.id::text), a.resolved_at)
    from approval_requests a, params p
   where a.metadata->>'adminTool' = 'policy.patch'
     and a.status = 'approved'
     and coalesce(a.metadata->'adminFulfillment'->>'ok', a.metadata->'fulfillment'->>'ok') = 'true'
     and not (coalesce(a.metadata->'adminMutation', '{}'::jsonb) ? 'actionLimits')
     and (p.org_filter is null or a.org_id = p.org_filter)
)
select * from wipes order by org_id, employee_id, wiped_at;

-- -----------------------------------------------------------------------------
-- Q2. Per employee: what was lost, whether a human set limits again afterwards,
--     the current values, and the restore source.
--
-- "Known value" timeline (the only writers of action_limits besides the bug):
--   audit credential.issued   metadata.actionLimits   (hire / employees.issue)
--   audit employee.updated    metadata.actionLimits   (dashboard save; value AFTER the save)
--   approved policy.patch     adminMutation.actionLimits (admin MCP; value applied)
--   rotation copies the active row into a new credentials row; the old row is
--   revoked and never updated again → revoked rows are point-in-time snapshots.
-- metadata.actionLimits on both audit actions exists since 6e536ca (2026-09-02);
-- older employees may only have the revoked-credentials snapshot.
-- -----------------------------------------------------------------------------
with params as (select null::uuid as org_filter),
wipes as (
  select a.org_id, (a.metadata->'adminMutation'->>'employeeId') as employee_id, a.id::text as ref,
         case when a.metadata->>'adminTool' = 'policy.patch' then 'B: policy.patch without actionLimits'
              else 'A: setup.lineApproval.setEmployeeInbox' end as src,
         coalesce((select min(ae.created_at) from audit_events ae
                    where ae.org_id = a.org_id
                      and ae.action in ('admin.notificationChannel', 'admin.policy')
                      and ae.metadata->>'approvalId' = a.id::text), a.resolved_at) as at
    from approval_requests a, params p
   where a.status = 'approved'
     and coalesce(a.metadata->'adminFulfillment'->>'ok', a.metadata->'fulfillment'->>'ok') = 'true'
     and (p.org_filter is null or a.org_id = p.org_filter)
     and (   a.metadata->>'adminTool' = 'setup.lineApproval.setEmployeeInbox'
          or (a.metadata->>'adminTool' = 'policy.patch'
              and not (coalesce(a.metadata->'adminMutation', '{}'::jsonb) ? 'actionLimits')))
),
sets as (
  select ae.org_id, ae.employee_id::text as employee_id, ae.id::text as ref,
         'audit:' || ae.action as src, ae.created_at as at, ae.metadata->'actionLimits' as limits
    from audit_events ae, params p
   where ae.action in ('credential.issued', 'employee.updated')
     and ae.employee_id is not null
     and ae.metadata ? 'actionLimits'
     and (p.org_filter is null or ae.org_id = p.org_filter)
  union all
  select a.org_id, a.metadata->'adminMutation'->>'employeeId', a.id::text,
         'approval:policy.patch',
         coalesce((select min(ae.created_at) from audit_events ae
                    where ae.org_id = a.org_id and ae.action = 'admin.policy'
                      and ae.metadata->>'approvalId' = a.id::text), a.resolved_at),
         a.metadata->'adminMutation'->'actionLimits'
    from approval_requests a, params p
   where a.metadata->>'adminTool' = 'policy.patch'
     and a.status = 'approved'
     and coalesce(a.metadata->'adminFulfillment'->>'ok', a.metadata->'fulfillment'->>'ok') = 'true'
     and coalesce(a.metadata->'adminMutation', '{}'::jsonb) ? 'actionLimits'
     and (p.org_filter is null or a.org_id = p.org_filter)
),
per_emp as (
  select w.org_id, w.employee_id,
         min(w.at) as first_wipe_at, max(w.at) as last_wipe_at, count(*) as wipe_count,
         string_agg(distinct w.src, ' / ') as wipe_sources
    from wipes w group by w.org_id, w.employee_id
),
last_set_before_first as (
  select distinct on (pe.org_id, pe.employee_id) pe.org_id, pe.employee_id,
         s.limits, s.src, s.ref, s.at
    from per_emp pe join sets s on s.org_id = pe.org_id and s.employee_id = pe.employee_id and s.at < pe.first_wipe_at
   order by pe.org_id, pe.employee_id, s.at desc
),
last_set_overall as (
  select distinct on (s.org_id, s.employee_id) s.org_id, s.employee_id, s.limits, s.src, s.ref, s.at
    from sets s join per_emp pe on pe.org_id = s.org_id and pe.employee_id = s.employee_id
   order by s.org_id, s.employee_id, s.at desc
),
revoked_snapshot as (
  select distinct on (pe.org_id, pe.employee_id) pe.org_id, pe.employee_id,
         c.id::text as credential_id, c.revoked_at, c.action_limits
    from per_emp pe
    join credentials c on c.org_id = pe.org_id and c.employee_id::text = pe.employee_id
   where c.revoked_at is not null and c.revoked_at <= pe.last_wipe_at
   order by pe.org_id, pe.employee_id, c.revoked_at desc
)
select pe.org_id, pe.employee_id, e.display_name, e.status,
       pe.wipe_sources, pe.wipe_count, pe.first_wipe_at, pe.last_wipe_at,
       lb.limits  as known_before_first_wipe, lb.src as known_before_src, lb.ref as known_before_ref, lb.at as known_before_at,
       lo.limits  as last_known_set, lo.src as last_known_src, lo.ref as last_known_ref, lo.at as last_known_at,
       rs.action_limits as revoked_credential_snapshot, rs.credential_id as snapshot_credential_id, rs.revoked_at as snapshot_revoked_at,
       e.action_limits as employees_now,
       (select c.action_limits from credentials c
         where c.org_id = pe.org_id and c.employee_id::text = pe.employee_id and c.revoked_at is null
         order by c.created_at desc limit 1) as active_credentials_now,
       case
         when lo.limits is not null and lo.at > pe.last_wipe_at
           then 'RESET_BY_HUMAN_AFTER_WIPE (no restore; compare with known_before_first_wipe)'
         when coalesce(lo.limits, rs.action_limits, '{}'::jsonb) = '{}'::jsonb
           then 'NO_LOSS (nothing set before the wipe) — or UNKNOWN if hired before 2026-09-02 and no snapshot'
         when e.action_limits = '{}'::jsonb and lo.limits is not null and lo.limits <> '{}'::jsonb
           then 'WIPED — RESTORE from last_known_set'
         when e.action_limits = '{}'::jsonb and rs.action_limits <> '{}'::jsonb
           then 'WIPED — RESTORE candidate from revoked_credential_snapshot (older than the wipe; confirm with the owner)'
         else 'CHECK MANUALLY (current value differs from the last known value)'
       end as verdict
  from per_emp pe
  left join employees e on e.org_id = pe.org_id and e.id::text = pe.employee_id
  left join last_set_before_first lb on lb.org_id = pe.org_id and lb.employee_id = pe.employee_id
  left join last_set_overall lo on lo.org_id = pe.org_id and lo.employee_id = pe.employee_id
  left join revoked_snapshot rs on rs.org_id = pe.org_id and rs.employee_id = pe.employee_id
 order by pe.org_id, verdict, pe.first_wipe_at;

-- -----------------------------------------------------------------------------
-- Q3. Drift check: employees vs the active credentials row (should be equal;
--     both were wiped together, so a mismatch means a different cause).
-- -----------------------------------------------------------------------------
with params as (select null::uuid as org_filter)
select e.org_id, e.id as employee_id, e.display_name, e.action_limits as employees_action_limits,
       c.id as credential_id, c.action_limits as credentials_action_limits
  from employees e
  join credentials c on c.employee_id = e.id and c.org_id = e.org_id and c.revoked_at is null,
       params p
 where e.action_limits is distinct from c.action_limits
   and (p.org_filter is null or e.org_id = p.org_filter)
 order by e.org_id, e.id;

rollback;

-- Restore (NOT part of this file, NOT run by Staffpass engineers): only after
-- 木村 / the tenant owner confirms each row of Q2 with verdict "WIPED — RESTORE…",
-- write the value back through the normal admin path (admin MCP policy.patch
-- with an explicit actionLimits, human-approved), so the change is audited and
-- reaches employees + the active credentials row together.

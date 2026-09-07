-- A1 scheduling.policy: org-level and optional per-employee scheduling policy.
-- First rule-pack that locks the shared pack shape for all future situation policies.
-- Fail-closed: missing/conflicting rules → do not widen candidates; escalate to human.
--
-- Schema mirrors ingress_handoff_policy pattern.
-- High-risk enablement (full_auto confirm) requires explicit tenant consent.
--
-- Copy-paste SQL apply:
--   psql -d <database> -f supabase/migrations/20260907_scheduling_policy.sql

alter table orgs
  add column if not exists scheduling_policy jsonb;

comment on column orgs.scheduling_policy is
  'A1 scheduling policy: location affinity, travel buffer, online pack, hard blackout, confirm automation level. First-match rule ordering. High-risk (full_auto) requires highRiskConsentAt/By. NULL = default (always_human confirm).';

-- Per-employee override (optional, same shape as org policy)
alter table employees
  add column if not exists scheduling_policy jsonb;

comment on column employees.scheduling_policy is
  'Optional per-employee scheduling policy override. Same shape as orgs.scheduling_policy. NULL = inherit org policy. First-match rule ordering.';

-- Index for finding employees with overrides
create index if not exists employees_scheduling_policy_idx
  on employees (org_id)
  where scheduling_policy is not null;

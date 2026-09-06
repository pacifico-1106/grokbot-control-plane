-- Per-employee ingress handoff policy override.
-- Extends org-level ingress_handoff_policy with optional employee-level granularity.
-- Fallback order: employee override → org policy → convenience default.

alter table employees
  add column if not exists ingress_handoff_policy jsonb;

comment on column employees.ingress_handoff_policy is
  'Optional per-employee ingress handoff policy override. Same shape as orgs.ingress_handoff_policy. NULL = inherit org policy. First-match rule ordering.';

create index if not exists employees_ingress_handoff_idx
  on employees (org_id)
  where ingress_handoff_policy is not null;

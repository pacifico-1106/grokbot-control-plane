-- Per-tool approval hints on the employee badge (mail.send / calendar.confirm choosable).
-- Missing keys stay always_human. Distinct from employee.approval_policy.

alter table employees
  add column if not exists tool_approval_defaults jsonb not null default '{
    "mail.send": "always_human",
    "calendar.confirm": "always_human"
  }'::jsonb;

comment on column employees.tool_approval_defaults is
  'Per-tool approval hints. mail.send and calendar.confirm are choosable always_human|risk_based|auto. Defaults stay always_human.';

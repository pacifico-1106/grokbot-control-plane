-- B1 Mail Policy: outbound mail send/draft behavior
-- Follows A1/B2 pattern: org-level policy + employee override

alter table orgs
  add column if not exists mail_policy jsonb default null;

comment on column orgs.mail_policy is 'B1 mail policy: sendMode per audience, domain allow/deny, attachment rules';

alter table employees
  add column if not exists mail_policy jsonb default null;

comment on column employees.mail_policy is 'B1 mail policy override (inherits org when null)';

create index if not exists employees_mail_policy_idx
  on employees (org_id) where mail_policy is not null;

-- Operator note:
-- mail_policy follows A1 scheduling.policy / B2 reply_policy pattern.
-- JSON shape: { version: 1, policyId, policyName, rules: [...], highRiskConsentAt?, highRiskConsentBy?, updatedAt, updatedBy }
-- Rule shape: { id, priority?, audience?, toDomainAllowlist?, toDomainDenylist?, sendMode, draftMailbox?, requireHumanFinalSend?, allowCc?, allowBcc?, attachmentPolicyRef? }
-- Fallback order: employee override → org policy → convenience default (external draft_only).

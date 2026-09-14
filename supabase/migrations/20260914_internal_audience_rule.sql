-- Migration: Internal Audience Rule for large/stablo-scale channels
-- Internal = parties allowlist UNION emailDomains UNION slackTeamIds
-- Connect guests / unregistered → external (fail-closed)
-- Example: #stablo_tokyo307 Connect channel

alter table orgs
  add column if not exists internal_audience_rule jsonb;

comment on column orgs.internal_audience_rule is
  'Org-level internal audience rule for large/stablo-scale channels. Internal = parties UNION emailDomains UNION slackTeamIds. Connect guests fail-closed external. A1/D1 shape.';

create index if not exists orgs_internal_audience_rule_idx
  on orgs using gin (internal_audience_rule)
  where internal_audience_rule is not null;

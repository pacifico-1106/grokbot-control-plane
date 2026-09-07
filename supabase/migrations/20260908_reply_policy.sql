-- B2 Reply Policy: Slack/LINE conversation reply behavior
-- Follows A1/F1 pattern: org-level policy + employee override

-- Add reply_policy column to orgs
alter table orgs
  add column if not exists reply_policy jsonb default null;

comment on column orgs.reply_policy is 'B2 reply policy: after-hours, emoji, short-reply, thread affinity rules';

-- Add reply_policy column to employees for per-employee override
alter table employees
  add column if not exists reply_policy jsonb default null;

comment on column employees.reply_policy is 'B2 reply policy override (inherits org when null)';

-- Operator note:
-- reply_policy follows A1 scheduling.policy / F1 mouth_routing_policy pattern.
-- JSON shape: { version: 1, policyId, policyName, rules: [...], highRiskConsentAt?, highRiskConsentBy?, updatedAt, updatedBy }
-- Rule shape: { id, priority?, surface?, afterHoursMode, businessHours?, shortReplyMode, shortReplyMinChars?, emojiMode, allowedEmojis?, threadAffinity, topicChangeThreshold? }
-- Fallback order: employee override → org policy → convenience default (safe: draft_only after hours, emoji limited, prefer_thread).

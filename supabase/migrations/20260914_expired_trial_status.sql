-- Add 'expired' status to subscriptions for soft-locked trial expiry
-- Grace period: 0 days (trial expires immediately when trial_ends_at < now)

alter table subscriptions
  drop constraint if exists subscriptions_status_check;

alter table subscriptions
  add constraint subscriptions_status_check
  check (status in ('trialing', 'active', 'past_due', 'canceled', 'incomplete', 'unpaid', 'expired'));

comment on column subscriptions.status is
  'Subscription status: trialing, active, past_due, canceled, incomplete, unpaid, expired. Expired = trial ended without conversion.';

-- Slack mention ingress: Staffpass Event Subscriptions wake a bound Grok Bot.
-- Apply this in the production Supabase SQL editor (same as 20260828_slack_posting_identity.sql).
-- Wake URL is visible on employee_bindings; sender/secret is service-role only.
-- Event Subscriptions Request URL: https://staffpass.sealith.com/api/webhooks/slack/events

alter table employee_bindings
  add column if not exists wake_webhook_url text;

alter table employee_bindings
  add column if not exists has_wake_webhook boolean not null default false;

comment on column employee_bindings.wake_webhook_url is
  'Visible Grok Bot wake webhook URL copied from the agent webhook routine. Cursor Slack is not used.';
comment on column employee_bindings.has_wake_webhook is
  'True when a sender/secret is stored. Dashboard never reads the secret.';

create table if not exists employee_binding_secrets (
  employee_id uuid primary key references employees(id) on delete cascade,
  credentials_ciphertext text not null,
  updated_at timestamptz not null default now()
);

comment on table employee_binding_secrets is
  'Service-role-only encrypted wake webhook sender key (NOTIFICATION_CONFIG_ENCRYPTION_KEY / encryptNotificationSecrets). Intentionally inaccessible via browser RLS.';

alter table employee_binding_secrets enable row level security;

create table if not exists slack_mention_events (
  event_id text primary key,
  received_at timestamptz not null default now()
);

comment on table slack_mention_events is
  'Idempotency for Slack Event Subscriptions retries (PK event_id). Service-role only.';

alter table slack_mention_events enable row level security;

create index if not exists employee_slack_identities_user_status_idx
  on employee_slack_identities (slack_user_id, status);

create index if not exists employee_slack_identities_team_user_idx
  on employee_slack_identities (slack_team_id, slack_user_id)
  where status = 'linked';

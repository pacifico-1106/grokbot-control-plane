-- READ-ONLY. For 木村 to run against production (we do not read production ourselves).
-- Lists every LINE approval webhook ref in use, so each one can be checked against the
-- #228 route logic (app/api/webhooks/line/[ref]/route.ts → getNotificationChannelByWebhookRef):
--   a ref resolves  ⇔  provider = 'line' AND enabled AND a credentials row exists (and decrypts).
--   Otherwise the route now answers 404 (before #228: 200 "ignored"). LINE's webhook
--   delivery to such a ref already did nothing; only the response code changes.
-- Also listed: which employees route their approvals through that channel (their own
-- approval_channel_id, or the org default when they have none), because #228 refuses a
-- postback whose employee cannot be read.
-- Columns: org, employee and ref only. NO secrets: the credentials table is only tested
-- for existence (true / false); config (destinationId, allowedUserIds) is not selected.
-- Production (木村 10/12): 0 rows. There are no LINE approval refs in production, and 稲盛
-- (スペースツリー) is Slack-only. A row here would be a new LINE channel added since.
begin transaction read only;
set local statement_timeout = '15s';

with line_channels as (
  select c.id as channel_id, c.org_id, c.webhook_ref, c.enabled, c.is_default, c.label,
         exists (select 1 from public.org_notification_channel_secrets s where s.channel_id = c.id) as has_credentials
  from public.org_notification_channels c
  where c.provider = 'line'
),
users_of_channel as (
  -- explicit per-employee inbox
  select e.org_id, e.id as employee_id, e.display_name, e.status as employee_status, e.approval_channel_id as channel_id, 'employee_inbox'::text as via
  from public.employees e
  join line_channels lc on lc.channel_id = e.approval_channel_id
  union all
  -- org default inbox (employee has none of its own)
  select e.org_id, e.id, e.display_name, e.status, lc.channel_id, 'org_default'
  from public.employees e
  join line_channels lc on lc.org_id = e.org_id and lc.is_default
  where e.approval_channel_id is null
)
select
  o.name                       as org_name,
  lc.org_id,
  u.display_name               as employee,
  u.employee_id,
  u.employee_status,
  u.via,
  lc.label                     as channel_label,
  lc.channel_id,
  lc.webhook_ref,
  '/api/webhooks/line/' || lc.webhook_ref as webhook_path,
  lc.enabled,
  lc.has_credentials,
  (lc.webhook_ref ~ '^[0-9a-f]{12}$') as ref_shape_standard,       -- DB default / app: 6 random bytes hex
  (lc.enabled and lc.has_credentials) as resolves_under_new_route  -- false → 404 under #228
from line_channels lc
join public.orgs o on o.id = lc.org_id
left join users_of_channel u on u.channel_id = lc.channel_id
order by o.name, lc.label, u.display_name nulls last;

-- Rows with resolves_under_new_route = false but an employee attached are the ones to look at:
-- a disabled or credential-less channel that an employee still points to.
rollback;

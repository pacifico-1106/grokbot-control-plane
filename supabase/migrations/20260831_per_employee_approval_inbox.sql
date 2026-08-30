-- Per-employee approval inboxes.
-- User applies this in the production SQL editor. Do not rewrite existing rows.
--
-- An org may have several 「承認を受け取る」 rows (Telegram DM / group, later Slack / LINE).
-- Drop unique (org_id, provider). One is_default per org (partial unique index).
-- employees.approval_channel_id unset → org default inbox (安藤 compatible).
-- Do not mix with org_conversation_adapters (「チャンネルに書き込む」).
-- Webhook [ref] stays unique per channel.
-- sns.publish adapters live in 20260831_sns_publish.sql — do not duplicate them here.

alter table org_notification_channels
  drop constraint if exists org_notification_channels_org_id_provider_key;
drop index if exists org_notification_channels_org_id_provider_key;

alter table org_notification_channels
  add column if not exists is_default boolean not null default false;

update org_notification_channels c
set is_default = true
where c.id in (
  select distinct on (org_id) id
  from org_notification_channels
  order by org_id, created_at asc, id asc
)
and not exists (
  select 1 from org_notification_channels d
  where d.org_id = c.org_id and d.is_default
);

create unique index if not exists org_notification_channels_one_default_per_org
  on org_notification_channels (org_id)
  where is_default;

alter table employees
  add column if not exists approval_channel_id uuid references org_notification_channels(id) on delete set null;

alter table employees
  add column if not exists approver_user_ids text[] not null default '{}';

create index if not exists employees_approval_channel_idx
  on employees (org_id, approval_channel_id)
  where approval_channel_id is not null;

comment on column employees.approval_channel_id is
  'Optional approval inbox (org_notification_channels). Unset falls back to the org default inbox.';
comment on column employees.approver_user_ids is
  'Optional extra Telegram/Slack/LINE user ids allowed to resolve this employee''s tickets (AND with channel allowedUserIds).';
comment on column org_notification_channels.is_default is
  'Exactly one default approval inbox per org. Unset employee.approval_channel_id uses this row.';

-- Per-tool approval hints: extend tool_approval_defaults default json.
-- Choosable: mail.send, calendar.confirm, commerce.order, files.write,
-- drive.share_external, browser.use. Missing keys stay always_human.
-- User applies this in the production SQL editor. Do not rewrite existing rows.

alter table employees
  add column if not exists tool_approval_defaults jsonb not null default '{
    "mail.send": "always_human",
    "calendar.confirm": "always_human",
    "commerce.order": "always_human",
    "files.write": "always_human",
    "drive.share_external": "always_human",
    "browser.use": "always_human"
  }'::jsonb;

alter table employees
  alter column tool_approval_defaults set default '{
    "mail.send": "always_human",
    "calendar.confirm": "always_human",
    "commerce.order": "always_human",
    "files.write": "always_human",
    "drive.share_external": "always_human",
    "browser.use": "always_human"
  }'::jsonb;

comment on column employees.tool_approval_defaults is
  'Per-tool approval hints. Choosable tools default always_human; operator may set risk_based or auto.';

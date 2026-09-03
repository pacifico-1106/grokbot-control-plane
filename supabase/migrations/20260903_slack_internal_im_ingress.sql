-- 社内分類した Slack 1:1 の受け口。管理MCP channels.classify の履行だけが更新する。
-- Staffpass Slack アプリが実際に受信した message.im だけを対象にし、未分類DMは開かない。

create table if not exists slack_im_employee_routes (
  org_id uuid not null references orgs(id) on delete cascade,
  slack_channel_id text not null,
  slack_team_id text not null default '',
  employee_id uuid not null references employees(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, slack_channel_id)
);

create index if not exists slack_im_employee_routes_channel_idx
  on slack_im_employee_routes (slack_channel_id, slack_team_id);
create index if not exists slack_im_employee_routes_employee_idx
  on slack_im_employee_routes (employee_id);

comment on table slack_im_employee_routes is
  '社内分類済み Slack 1:1 と、メンションなしで起こすAI社員の対応。社員未指定・未分類・複数候補は fail-closed。';
comment on column slack_im_employee_routes.slack_channel_id is
  'Staffpass Slack アプリの Event Subscriptions が実際に受信する message.im の D チャネルID。';
comment on column slack_im_employee_routes.slack_team_id is
  'Slack ワークスペースID。既存データで不明な場合は空文字、候補重複時は起動しない。';
comment on column slack_im_employee_routes.employee_id is
  'この社内1:1で起こす単一のAI社員。管理MCPの人承認後だけ設定する。';

alter table slack_im_employee_routes enable row level security;
-- RLS policy intentionally omitted: service-role の管理MCP履行だけが読み書きする。

-- 第一号の既存分類へ受け口を付ける。権限ポリシーは変更しない。
insert into slack_im_employee_routes (org_id, slack_channel_id, employee_id)
select channel.org_id, channel.external_id, employee.id
from org_channels as channel
join employees as employee on employee.org_id = channel.org_id
where channel.surface = 'slack'
  and channel.external_id = 'D0BSWG1804F'
  and channel.classification = 'internal'
  and channel.mixed = false
  and employee.id = '79c1834d-2428-4aad-88ba-d17d9d7bcd1e'::uuid
  and employee.status = 'active'
on conflict (org_id, slack_channel_id) do update
set employee_id = excluded.employee_id,
    updated_at = now();

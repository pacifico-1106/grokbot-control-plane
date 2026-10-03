-- SLACK_AUTHORIZE_LINK_ENABLED（既定 OFF）用。AI社員ごとの Slack 再認可リンク（1回限り・約24時間）。
-- リンクの平文は保存しない（token_hash = sha256 hex のみ）。発行時に期待する Slack user / team を固定し、
-- コールバックで一致しなければ何も保存しない。届け先は承認アプリの DM だけ（delivered_*）。
-- 適用順: PR マージ・デプロイ → 本 migration → SLACK_AUTHORIZE_LINK_ENABLED=1（先に適用しても無害）。
-- ロールバック: フラグ OFF で十分。テーブルを消す場合: drop table if exists public.slack_authorize_links;

create table if not exists public.slack_authorize_links (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  expected_slack_user_id text check (expected_slack_user_id is null or expected_slack_user_id ~ '^[UW][A-Z0-9]{2,30}$'),
  expected_team_id text not null check (expected_team_id ~ '^[TE][A-Z0-9]{2,30}$'),
  status text not null default 'issued'
    check (status in ('issued', 'consumed', 'completed', 'rejected', 'superseded', 'revoked')),
  result_reason text check (result_reason is null or result_reason ~ '^[a-z0-9_]{1,64}$'),
  bound_slack_user_id text check (bound_slack_user_id is null or bound_slack_user_id ~ '^[UW][A-Z0-9]{2,30}$'),
  delivered_inbox_id text,
  delivered_channel_id text check (delivered_channel_id is null or delivered_channel_id ~ '^D[A-Z0-9]{2,30}$'),
  delivered_user_id text check (delivered_user_id is null or delivered_user_id ~ '^[UW][A-Z0-9]{2,30}$'),
  -- deliverTo（既定 employee）: 実際にリンクを受け取った相手。employee = 社員本人の Slack、approver = 承認者。
  delivered_target text not null default 'approver' check (delivered_target in ('employee', 'approver')),
  -- 承認者 DM（「社員本人に送りました」・完了通知の宛先）。
  approver_channel_id text check (approver_channel_id is null or approver_channel_id ~ '^D[A-Z0-9]{2,30}$'),
  approver_user_id text check (approver_user_id is null or approver_user_id ~ '^[UW][A-Z0-9]{2,30}$'),
  approval_id text,
  issued_via text not null default 'ticket' check (issued_via in ('ticket', 'audit_only')),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 2026-10-04 追加（deliverTo）: 旧版の本 migration を先に適用済みの環境でも列がそろうように（冪等）。
alter table public.slack_authorize_links
  add column if not exists delivered_target text not null default 'approver'
    check (delivered_target in ('employee', 'approver')),
  add column if not exists approver_channel_id text
    check (approver_channel_id is null or approver_channel_id ~ '^D[A-Z0-9]{2,30}$'),
  add column if not exists approver_user_id text
    check (approver_user_id is null or approver_user_id ~ '^[UW][A-Z0-9]{2,30}$');

create index if not exists slack_authorize_links_employee_idx
  on public.slack_authorize_links (org_id, employee_id, status);

alter table public.slack_authorize_links enable row level security;
-- No policies: anon / authenticated get nothing; service role bypasses RLS.
revoke all on public.slack_authorize_links from anon, authenticated;

comment on table public.slack_authorize_links is
  'AI社員の Slack 再認可リンク（SLACK_AUTHORIZE_LINK_ENABLED）。平文リンクは保存しない。Service role only.';

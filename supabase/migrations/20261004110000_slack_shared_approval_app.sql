-- SLACK_SHARED_APPROVAL_APP_ENABLED（既定 OFF）用。Staffpass 共通の承認アプリ「Staffpass承認」。
-- 1) OAuth state の 1 回限り使用（nonce の sha256 のみ保存）。
-- 2) 共通承認アプリの承認口は 1 つの Slack ワークスペース（team_id）につき 1 つの org だけ
--    （interactivity / events の team → org 解決を一意にする DB 側の保証）。
-- 適用順: PR マージ・デプロイ → 本 migration → env 設定 → SLACK_SHARED_APPROVAL_APP_ENABLED=1
-- （フラグ OFF のまま先に適用しても無害。共通アプリの承認口はまだ 1 件も無いので index 作成は失敗しない）。
-- ロールバック: フラグ OFF で十分。消す場合:
--   drop index if exists public.org_notification_channels_shared_approval_team_uidx;
--   drop table if exists public.slack_oauth_state_uses;

create table if not exists public.slack_oauth_state_uses (
  nonce_hash text primary key check (nonce_hash ~ '^[0-9a-f]{64}$'),
  purpose text not null check (purpose ~ '^[a-z0-9_]{1,64}$'),
  org_id uuid not null references orgs(id) on delete cascade,
  expires_at timestamptz not null,
  used_at timestamptz not null default now()
);

create index if not exists slack_oauth_state_uses_expires_idx
  on public.slack_oauth_state_uses (expires_at);

alter table public.slack_oauth_state_uses enable row level security;
-- No policies: anon / authenticated get nothing; service role bypasses RLS.
revoke all on public.slack_oauth_state_uses from anon, authenticated;

comment on table public.slack_oauth_state_uses is
  'Slack OAuth state の使用済み記録（共通承認アプリのインストール）。nonce は sha256 のみ。Service role only.';

-- One shared-approval-app inbox per Slack workspace across ALL orgs.
create unique index if not exists org_notification_channels_shared_approval_team_uidx
  on public.org_notification_channels ((config->>'apiAppId'), (config->>'teamId'))
  where provider = 'slack' and (config->>'sharedApprovalApp') = 'true';

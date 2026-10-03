-- SLACK_DM_AUTOROUTE_ENABLED（既定 OFF）用。slack_im_employee_routes に「どう作られたか」を記録する。
-- 既存行はすべて manual（channels.classify の人承認）。auto_party は org_parties の internal slack_user
-- から自動導出した行で、相手が external になった／社員の Slack 認可が解除されたときだけ自動で消える。
-- 適用順: PR マージ・デプロイ → 本 migration → SLACK_DM_AUTOROUTE_ENABLED=1（先に適用しても無害）。
-- ロールバック: フラグ OFF で十分（列は残してよい）。列を消す場合は下の DROP を実行。
--   alter table slack_im_employee_routes drop constraint if exists slack_im_employee_routes_source_check;
--   drop index if exists slack_im_employee_routes_counterpart_idx;
--   alter table slack_im_employee_routes drop column if exists counterpart_slack_user_id, drop column if exists source;

alter table slack_im_employee_routes
  add column if not exists source text not null default 'manual',
  add column if not exists counterpart_slack_user_id text;

alter table slack_im_employee_routes
  drop constraint if exists slack_im_employee_routes_source_check;
alter table slack_im_employee_routes
  add constraint slack_im_employee_routes_source_check
  check (source in ('manual', 'auto_party'));

create index if not exists slack_im_employee_routes_counterpart_idx
  on slack_im_employee_routes (org_id, counterpart_slack_user_id)
  where source = 'auto_party';

comment on column slack_im_employee_routes.source is
  'manual = channels.classify（人承認）。auto_party = SLACK_DM_AUTOROUTE が org_parties の internal slack_user から自動作成。';
comment on column slack_im_employee_routes.counterpart_slack_user_id is
  'auto_party のときの相手 Slack user ID（U…）。相手が external になったら該当ルートを削除するために使う。manual は null。';

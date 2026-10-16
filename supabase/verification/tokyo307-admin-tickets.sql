-- READ ONLY. Production operator が実行する（このエージェントは本番を読まない・書かない）。
-- TOKYO307 の管理クラス承認チケットを、状態別件数と credentialGeneration 欠落件数で数える。
--
-- 根拠（コード）:
--   テーブル: public.approval_requests（lib/data/approvals.ts, supabase/schema.sql）
--   組織: public.orgs.name（lib/types.ts Org.name / lib/data/mappers.ts mapOrgRow）。
--         orgs に slug 列は無い（schema / Org 型）。環境に slug があれば name と同様にマッチする。
--   status: lib/types.ts ApprovalStatus と
--           supabase/migrations/20261004700000_comm_reply_dedup.sql の check
--           pending | approved | rejected | expired | revision_requested | superseded
--   管理クラス: lib/admin-mcp/audit-class.ts isAdminClassApproval
--           metadata.approvalClass / auditClass / isAdminMcpTool / purpose admin.* / legacy tool
--   credentialGeneration: metadata.adminRequester.credentialGeneration
--           （lib/admin-mcp/self-approval.ts parseAdminRequester, lib/admin-mcp/queue.ts）
-- 未処理は status = 'pending'（revision_requested は差し戻し済みとして状態別に別計上）。
begin transaction read only;
set local statement_timeout = '15s';

with tokyo307 as (
  select o.id, o.name
  from public.orgs o
  where o.name ilike 'TOKYO307'
     or o.name ilike '%TOKYO307%'
     or coalesce(to_jsonb(o)->>'slug', '') ilike '%tokyo307%'
),
admin_tickets as (
  select
    a.id,
    a.org_id,
    a.status,
    a.purpose,
    a.tool,
    a.metadata,
    coalesce(a.tool, a.metadata->>'adminTool', a.metadata->>'tool') as tool_name,
    (
      a.metadata->>'approvalClass' = 'admin'
      or (
        coalesce(a.metadata->>'approvalClass', '') is distinct from 'business'
        and (
          a.metadata->>'auditClass' = 'admin'
          or a.metadata->>'isAdminMcpTool' in ('true', 't')
          or coalesce(a.purpose, '') like 'admin.%'
          or coalesce(a.tool, a.metadata->>'adminTool', a.metadata->>'tool') in (
            'employees.issue', 'link', 'policy.patch', 'parties.upsert',
            'channels.classify', 'roles.propose'
          )
          or coalesce(a.tool, a.metadata->>'adminTool', a.metadata->>'tool') like 'admin.%'
          or coalesce(a.tool, a.metadata->>'adminTool', a.metadata->>'tool') like 'setup.%'
          or coalesce(a.tool, a.metadata->>'adminTool', a.metadata->>'tool') like 'orgs.%'
          or coalesce(a.tool, a.metadata->>'adminTool', a.metadata->>'tool') like 'internalAudienceRule.%'
          or coalesce(a.tool, a.metadata->>'adminTool', a.metadata->>'tool') like 'approvalWorkflow.%'
          or coalesce(a.tool, a.metadata->>'adminTool', a.metadata->>'tool') like 'ingressHandoff.%'
          or coalesce(a.tool, a.metadata->>'adminTool', a.metadata->>'tool') like 'schedulingPolicy.%'
          or coalesce(a.tool, a.metadata->>'adminTool', a.metadata->>'tool') like 'replyPolicy.%'
          or coalesce(a.tool, a.metadata->>'adminTool', a.metadata->>'tool') like 'mailPolicy.%'
          or coalesce(a.tool, a.metadata->>'adminTool', a.metadata->>'tool') like 'stuckWatch.%'
          or coalesce(a.tool, a.metadata->>'adminTool', a.metadata->>'tool') like 'approvals.%'
        )
      )
    ) as is_admin,
    (
      a.metadata->'adminRequester' is null
      or jsonb_typeof(a.metadata->'adminRequester'->'credentialGeneration') is null
    ) as missing_credential_generation
  from public.approval_requests a
  join tokyo307 t on t.id = a.org_id
)
select 'org_match' as item, t.id::text as org_id, t.name as org_name, null::text as status, count(*)::bigint as n
from tokyo307 t
group by t.id, t.name
union all
select 'admin_by_status', null, null, a.status, count(*)
from admin_tickets a
where a.is_admin
group by a.status
union all
select 'admin_missing_generation_by_status', null, null, a.status, count(*)
from admin_tickets a
where a.is_admin and a.missing_credential_generation
group by a.status
union all
select 'admin_unprocessed_pending', null, null, 'pending', count(*)
from admin_tickets a
where a.is_admin and a.status = 'pending'
union all
select 'admin_unprocessed_pending_missing_generation', null, null, 'pending', count(*)
from admin_tickets a
where a.is_admin and a.status = 'pending' and a.missing_credential_generation
order by 1, 4;

rollback;

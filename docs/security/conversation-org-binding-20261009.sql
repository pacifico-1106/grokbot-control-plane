-- READ-ONLY investigation for the conversation.orgId tenant-isolation fix
-- (fix/resolve-audience-org-binding-20261009). SELECT only; run in a
-- read-only transaction:  BEGIN READ ONLY; \i this file; ROLLBACK;
-- Output carries IDs only (no message bodies). Treat the result as sensitive.

-- Q1. Approval snapshots whose conversation.orgId differs from the row org or
--     from the employee's org. Pending/approved ones would now be refused at
--     fulfil (fulfill_blocked_conversation_org_mismatch).
select ar.id            as approval_id,
       ar.org_id        as approval_org_id,
       e.org_id         as employee_org_id,
       ar.employee_id,
       ar.tool,
       ar.status,
       ar.job_id,
       ar.created_at,
       (ar.metadata->'invoke'->'conversation'->>'orgId') as snapshot_conversation_org_id,
       exists (select 1 from orgs o
               where o.id::text = lower(btrim(ar.metadata->'invoke'->'conversation'->>'orgId'))) as claimed_org_exists
from approval_requests ar
left join employees e on e.id = ar.employee_id
where coalesce(btrim(ar.metadata->'invoke'->'conversation'->>'orgId'), '') <> ''
  and (lower(btrim(ar.metadata->'invoke'->'conversation'->>'orgId')) <> ar.org_id::text
       or (e.org_id is not null and lower(btrim(ar.metadata->'invoke'->'conversation'->>'orgId')) <> e.org_id::text))
order by ar.created_at desc;

-- Q2. Audit rows whose own org differs from the acting employee's org, or
--     whose metadata names another org in a conversation field (some paths
--     copy conversation context into metadata).
select ae.id, ae.org_id as audit_org_id, e.org_id as employee_org_id,
       ae.employee_id, ae.action, ae.created_at,
       coalesce(ae.metadata->'conversation'->>'orgId', ae.metadata->>'conversationOrgId') as metadata_conversation_org_id
from audit_events ae
left join employees e on e.id = ae.employee_id
where (e.org_id is not null and e.org_id <> ae.org_id)
   or lower(btrim(coalesce(ae.metadata->'conversation'->>'orgId', ae.metadata->>'conversationOrgId', ae.org_id::text))) <> ae.org_id::text
order by ae.created_at desc;

-- Q3. Ledger rows in org B possibly written by another org's employee.
--     org_channels has no writer column, so this is a correlation, not proof:
--     auto-written rows (shared_external + mixed, written by resolveAudience
--     after conversations.info) in org B whose channel id was used by an
--     employee of a DIFFERENT org in an approval snapshot or the Q1 set.
select oc.org_id as ledger_org_id, oc.external_id as channel_id,
       oc.classification, oc.mixed, oc.created_at, oc.updated_at,
       ar.id as approval_id, ar.org_id as approval_org_id, ar.employee_id, ar.created_at as approval_created_at
from org_channels oc
join approval_requests ar
  on ar.metadata->'invoke'->'conversation'->>'slackChannelId' = oc.external_id
 and ar.org_id <> oc.org_id
where oc.surface = 'slack'
  and oc.classification = 'shared_external'
  and oc.mixed = true
order by oc.updated_at desc;

-- Q4. Size of the exposure window: how many approval snapshots carry any
--     conversation.orgId at all (equal or not), by org.
select ar.org_id,
       count(*) filter (where coalesce(ar.metadata->'invoke'->'conversation'->>'orgId','') <> '') as with_conv_org,
       count(*) filter (where lower(btrim(ar.metadata->'invoke'->'conversation'->>'orgId')) <> ar.org_id::text) as mismatched
from approval_requests ar
group by ar.org_id
order by mismatched desc, with_conv_org desc;

-- Q5 (#5 session cookie vs badge). Approval rows created in an org other than
--     the requesting employee's (badge) org: the pre-fix session-cookie
--     override. Read-only; expected 0.
select ar.id as approval_id, ar.org_id as approval_org_id, e.org_id as employee_org_id,
       ar.employee_id, ar.tool, ar.status, ar.created_at
from approval_requests ar
join employees e on e.id = ar.employee_id
where e.org_id <> ar.org_id
order by ar.created_at desc;

-- Q6. Slack-team self-assertion exposure: orgs that relied on
--     autoSlackTeamInternal (now requires Slack users.info verification with
--     the org's own bot token; missing users:read → speakers fall back to
--     unknown → approval).
select o.id as org_id,
       o.internal_audience_rule->'slackTeamIds' as slack_team_ids,
       o.internal_audience_rule->>'autoSlackTeamInternal' as auto_internal
from orgs o
where coalesce((o.internal_audience_rule->>'autoSlackTeamInternal')::boolean, false);

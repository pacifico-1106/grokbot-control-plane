-- READ-ONLY (木村 2026-10-05 #284 decision 4). Lists existing
-- employees.project_access.projectIds entries that are NOT a project of the
-- employee's own org (another org's project, or an id that no longer exists).
-- SELECT only: no writes. Output is IDs + a reason code (no project names).
-- After this PR such values can no longer be written; this query is for
-- cleaning up rows written before it. Only mode = 'selected' is used at
-- runtime (other modes ignore projectIds), but every mode is listed so the
-- data can be cleaned.
--
-- reason:
--   other_org_project    the id is a project of a DIFFERENT org
--   unknown_or_deleted   no project with this id exists
with ids as (
  select e.id as employee_id,
         e.org_id,
         e.status as employee_status,
         coalesce(e.project_access->>'mode', 'company') as mode,
         btrim(pid) as project_id
  from public.employees e
  cross join lateral jsonb_array_elements_text(
    case when jsonb_typeof(e.project_access->'projectIds') = 'array'
         then e.project_access->'projectIds' else '[]'::jsonb end
  ) as pid
)
select ids.employee_id,
       ids.org_id,
       ids.employee_status,
       ids.mode,
       ids.project_id,
       case
         when exists (select 1 from public.org_projects p
                      where p.id::text = lower(ids.project_id) and p.org_id <> ids.org_id) then 'other_org_project'
         else 'unknown_or_deleted'
       end as reason
from ids
where not exists (
  select 1 from public.org_projects p
  where p.org_id = ids.org_id and p.id::text = lower(ids.project_id)
)
order by ids.org_id, ids.employee_id, ids.project_id;

-- Pending Admin MCP employees.issue requests carrying such ids (they are
-- refused at fulfil after this PR; listed so they can be rejected up front).
select a.id as approval_id,
       a.org_id,
       a.status,
       btrim(pid) as project_id,
       case
         when exists (select 1 from public.org_projects p
                      where p.id::text = lower(btrim(pid)) and p.org_id <> a.org_id) then 'other_org_project'
         else 'unknown_or_deleted'
       end as reason
from public.approval_requests a
cross join lateral jsonb_array_elements_text(
  case when jsonb_typeof(a.metadata->'adminMutation'->'projectAccess'->'projectIds') = 'array'
       then a.metadata->'adminMutation'->'projectAccess'->'projectIds' else '[]'::jsonb end
) as pid
where a.status in ('pending', 'approved')
  and coalesce(a.metadata->>'adminTool', a.tool) = 'employees.issue'
  and not exists (
    select 1 from public.org_projects p
    where p.org_id = a.org_id and p.id::text = lower(btrim(pid))
  )
order by a.org_id, a.id;

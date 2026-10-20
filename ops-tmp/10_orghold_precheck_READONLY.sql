-- 10 orghold precheck (read-only)
-- A. 既存 hold と org ポインタ
select
  h.id,
  h.org_id,
  h.employee_id,
  h.kind,
  h.reason,
  h.started_by,
  h.started_via,
  h.started_at,
  h.release_requested_by,
  h.release_requested_at,
  h.release_reason,
  h.release_approval_id,
  h.released_by,
  h.released_at,
  h.superseded_by,
  h.superseded_at,
  o.hold_id   as orgs_hold_id,
  o.hold_state as orgs_hold_state
from public.employee_holds h
join public.orgs o on o.id = h.org_id
where h.id = 'efcfe065-566d-43af-9255-ddf2af03d5fe';

-- B. TOKYO307 のいま開いている org hold（employee_id is null）
select h.id, h.started_via, h.started_by, h.kind, h.released_at, h.superseded_at,
       o.hold_id, o.hold_state
from public.orgs o
left join public.employee_holds h
  on h.id = o.hold_id and h.org_id = o.id
where o.id = '92f3617c-33fc-4dac-b9b4-d4f42e8522ac';

-- C. 二人承認できる人（info@ 申請、tyasaka@ 承認）
select m.id, m.user_id, m.email, m.display_name, m.role, m.status,
       (m.id = any(o.designated_admin_member_ids)) as designated_admin
from public.org_members m
join public.orgs o on o.id = m.org_id
where m.org_id = '92f3617c-33fc-4dac-b9b4-d4f42e8522ac'
  and m.status = 'active'
  and (m.role = 'owner' or m.id = any(o.designated_admin_member_ids))
order by m.role, m.email;
-- end orghold precheck

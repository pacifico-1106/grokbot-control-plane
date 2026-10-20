-- h verify (read-only) TOKYO307 retired employees
select e.id, e.display_name, e.status, c.id as credential_id, c.revoked_at,
  (select count(*) from public.audit_events a where a.org_id=e.org_id and a.employee_id=e.id and a.action='employee.terminated') as terminated_events,
  (select count(*) from public.audit_events a where a.org_id=e.org_id and a.employee_id=e.id and a.action='credential.revoked') as revoked_events,
  (select count(*) from public.credentials c2 where c2.employee_id=e.id and c2.revoked_at is null) as active_creds
from public.employees e left join public.credentials c on c.employee_id=e.id
where e.org_id='92f3617c-33fc-4dac-b9b4-d4f42e8522ac' order by e.display_name, c.revoked_at;
-- end h verify

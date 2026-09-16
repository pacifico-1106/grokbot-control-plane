-- READ ONLY. For the authorized production/staging operator, before deployment.
-- Reports counts and ACL metadata only; no credentials or tenant policy contents.
select 'org policies' as item,count(*) from public.orgs where approval_workflow_policy is not null
union all select 'employee policies',count(*) from public.employees where approval_workflow_policy is not null
union all select 'workflow instances',count(*) from public.approval_workflow_instances
union all select 'cross-org instances',count(*) from public.approval_workflow_instances w
  join public.approval_requests a on a.id=w.approval_id where w.org_id<>a.org_id
union all select 'cross-org ballots',count(*) from public.approval_workflow_ballots b
  join public.approval_workflow_instances w on w.id=b.instance_id where b.org_id<>w.org_id
union all select 'terminal workflow with pending ticket',count(*) from public.approval_workflow_instances w
  join public.approval_requests a on a.id=w.approval_id where w.status in ('approved','rejected') and a.status='pending';

select table_name,grantee,privilege_type from information_schema.role_table_grants
where table_schema='public' and table_name in ('approval_workflow_instances','approval_workflow_ballots',
  'approval_workflow_voter_bindings','approval_requests','orgs','employees')
order by table_name,grantee,privilege_type;
select table_name,column_name,grantee,privilege_type from information_schema.column_privileges
where table_schema='public' and table_name in ('approval_workflow_instances','approval_workflow_ballots','approval_workflow_voter_bindings')
order by table_name,column_name,grantee;
select tablename,policyname,roles,cmd from pg_policies where schemaname='public'
  and tablename in ('approval_workflow_instances','approval_workflow_ballots','approval_workflow_voter_bindings');
select rolname,rolsuper,rolbypassrls from pg_roles where rolname in ('anon','authenticated','service_role');
select column_name,data_type from information_schema.columns where table_schema='auth' and table_name='users'
  and column_name in ('id','banned_until','deleted_at') order by column_name;
select p.proname,pg_get_function_identity_arguments(p.oid),p.prosecdef,p.proacl
from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
  and (p.proname like '%workflow%' or p.proname in ('claim_approval_execution','consume_admin_approval_secret'))
order by p.proname;

-- READ ONLY. Run by an authorized operator; do not paste live identifiers or
-- secrets into chat. This intentionally selects no credential/payload values.
begin read only;
select current_database() as database_name, current_user as inspected_by;
select rolname, rolbypassrls, rolsuper from pg_roles
where rolname in ('anon','authenticated','service_role',current_user);
select n.nspname, c.relname, c.relkind, c.relrowsecurity, c.relforcerowsecurity,
       pg_get_userbyid(c.relowner) as owner, c.relacl
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname in ('public','storage') and c.relkind in ('r','p','v','m') order by 1,2;
select table_schema,table_name,column_name,grantee,privilege_type
from information_schema.column_privileges
where table_schema in ('public','storage') and grantee in ('anon','authenticated','service_role') order by 1,2,3,4,5;
select n.nspname,p.proname,pg_get_function_identity_arguments(p.oid) as arguments,
       p.prosecdef as security_definer,pg_get_userbyid(p.proowner) as owner,p.proacl,p.proconfig
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname in ('public','storage') order by 1,2,3;
select schemaname,tablename,policyname,permissive,roles,cmd
from pg_policies where schemaname in ('public','storage') order by 1,2,3;
select defaclrole::regrole,defaclnamespace::regnamespace,defaclobjtype,defaclacl from pg_default_acl;
select count(*) filter(where user_id is null) as memberships_without_auth_identity,
       count(*) filter(where status='active' and role='owner' and user_id is null) as active_owners_without_auth_identity
from public.org_members;
select status,tool,count(*) as tickets,
       count(*) filter(where metadata->'adminRequester' is not null and not ((metadata->'adminRequester') ? 'credentialGeneration')) as legacy_admin_tickets,
       count(*) filter(where metadata #>> '{adminFulfillment,oneTimeSecret}' is not null or metadata #>> '{fulfillment,oneTimeSecret}' is not null) as tickets_with_unconsumed_secret
from public.approval_requests where status in ('pending','approved') group by status,tool order by status,tool;
commit;

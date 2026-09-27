-- Security hardening for voter binding verification
-- PR #129 audit fix: defense-in-depth brute-force protection
-- Even though verification codes are HMAC-signed in button callbacks,
-- this provides defense-in-depth against future attack vectors.
begin;
set local lock_timeout = '5s';

-- Add failed_verification_attempts counter for brute-force protection
-- After 5 failures, the pending binding becomes invalidated
alter table public.approval_workflow_voter_bindings
  add column if not exists failed_verification_attempts integer not null default 0;

comment on column public.approval_workflow_voter_bindings.failed_verification_attempts is
  'Counter for failed verification attempts. After 5 failures, the binding is invalidated.';

-- Verify RLS is enabled and restrictive policy exists
-- (These should already exist from 20260916120000_f8_enforcement.sql)
do $$
begin
  -- Verify RLS is enabled
  if not exists (
    select 1 from pg_tables
    where schemaname = 'public'
    and tablename = 'approval_workflow_voter_bindings'
    and rowsecurity = true
  ) then
    raise exception 'RLS must be enabled on approval_workflow_voter_bindings';
  end if;

  -- Verify restrictive policy blocks anon/authenticated
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
    and tablename = 'approval_workflow_voter_bindings'
    and policyname = 'workflow_server_only'
  ) then
    raise exception 'workflow_server_only policy must exist on approval_workflow_voter_bindings';
  end if;
end $$;

-- Revoke any column-level grants that might have been added for the new column
revoke select (failed_verification_attempts), insert (failed_verification_attempts),
       update (failed_verification_attempts), references (failed_verification_attempts)
  on public.approval_workflow_voter_bindings from public, anon, authenticated;

commit;

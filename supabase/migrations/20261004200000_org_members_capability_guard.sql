-- Team capability / role escalation fix (2026-10-04).
--
-- NOT APPLIED BY THE PR. Apply in production as a separate, reviewed step.
-- Existing rows are not modified.
--
-- 1) Remove the direct PostgREST write path on org_members.
--    `org_members_write_admin` (for all using is_org_admin(org_id)) let any
--    owner/admin session JWT + the public anon key UPDATE/INSERT org_members
--    rows in its own org directly (e.g. PATCH own row's capabilities), which
--    bypasses the server guard (lib/team/member-change-guard.ts).
--    All app writes use the service-role client (bypasses RLS), so app
--    behaviour is unchanged. SELECT policy (org_members_select) is kept.
drop policy if exists org_members_write_admin on public.org_members;

-- 2) Last-owner invariant at the DB layer (TOCTOU between concurrent requests:
--    two owners demoting each other at the same time both see ownerCount=2).
--    Serialised per org with an advisory xact lock; counts committed rows.
--    Org deletion (cascade) is allowed: the parent org row is already gone.
create or replace function public.org_members_keep_last_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  remaining integer;
begin
  if old.role is distinct from 'owner' or old.status is distinct from 'active' then
    return coalesce(new, old);
  end if;
  if tg_op = 'UPDATE' and new.role = 'owner' and new.status = 'active' and new.org_id = old.org_id then
    return new;
  end if;
  if not exists (select 1 from public.orgs o where o.id = old.org_id) then
    return coalesce(new, old);
  end if;
  perform pg_advisory_xact_lock(hashtextextended('org_members_owner:' || old.org_id::text, 0));
  select count(*) into remaining
    from public.org_members m
   where m.org_id = old.org_id
     and m.id <> old.id
     and m.role = 'owner'
     and m.status = 'active';
  if remaining = 0 then
    raise exception 'last_owner_required' using errcode = 'check_violation';
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists org_members_keep_last_owner on public.org_members;
create trigger org_members_keep_last_owner
  before update of role, status, org_id or delete on public.org_members
  for each row execute function public.org_members_keep_last_owner();

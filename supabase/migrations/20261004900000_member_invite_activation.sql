-- Member invite activation + last-owner user_id guard + atomic org provisioning
-- (木村 2026-10-04 decisions 1, 2, 4).
--
-- NOT APPLIED BY THE PR. Apply in production as a separate, reviewed step
-- BEFORE turning MEMBER_INVITE_ACTIVATION_ENABLED on. Existing rows are not
-- modified. Re-applicable. Rollback block at the end.
--
-- (1) public.claim_member_invites(p_user_id)
--     Binds ONE pending invite (status 'invited', user_id null) to the Auth
--     user and activates it, only when ALL of these hold (read from auth.users
--     here, never from the client or an argument):
--       - the Auth user exists, is not deleted, not banned;
--       - it was created by an invite (invited_at) and the invite link was
--         accepted (email_confirmed_at) — i.e. the person proved control of the
--         address. Signup / admin-created users are created with
--         email_confirm:true (no proof), so they never claim;
--       - its email matches the invite email after NFKC + trim + lower;
--       - no other live Auth user has the same normalized email;
--       - the user has no active membership anywhere (one org per session
--         today — see PR "open decisions") and no row in that org yet.
--     Oldest pending invite wins; the rest stay pending. Role, capabilities,
--     job role and profile are left exactly as invited. One audit_events row
--     (member.invite_claimed) in the same transaction. Serialised per user
--     (advisory xact lock) + row lock: concurrent claims bind once. Idempotent.
--     Rows that are already 'active' with user_id null (e.g. TOKYO307's extra
--     owner row) are NOT invites and are never bound.
-- (2) org_members_keep_last_owner also fires on user_id. The last active owner
--     that has a user_id cannot be re-pointed or nulled (nor demoted /
--     disabled / deleted, as before). Owner rows without a user_id are not a
--     usable owner: they never count as "another owner" and are not protected.
--     Binding a null user_id (invite claim) is always allowed.
-- (4) public.provision_org_with_owner(...)
--     orgs + owner org_members insert in ONE transaction: if the owner insert
--     fails, the org insert is rolled back (no orphan org). Serialised per user;
--     returns the existing active membership instead of creating a second org.
-- Both RPCs: security definer, EXECUTE for service_role only.

create or replace function public.normalize_identity_email(p_email text)
returns text
language sql
immutable
set search_path = pg_catalog
as $$
  -- Same as normalizeIdentityEmail() in lib/team/member-change-guard.ts:
  -- NFKC, trim (incl. full-width space after NFKC), lower-case.
  select nullif(lower(regexp_replace(normalize(p_email, NFKC), '^\s+|\s+$', '', 'g')), '')
$$;

revoke all on function public.normalize_identity_email(text) from public;
grant execute on function public.normalize_identity_email(text) to service_role;

create or replace function public.claim_member_invites(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email text;
  v_raw_email text;
  v_confirmed timestamptz;
  v_invited timestamptz;
  v_banned timestamptz;
  v_deleted timestamptz;
  v_invite public.org_members;
begin
  if p_user_id is null then
    return jsonb_build_object('status', 'none', 'reason', 'not_eligible');
  end if;
  -- One claim at a time per user (two tabs / double submit).
  perform pg_advisory_xact_lock(hashtextextended('member_invite_claim:' || p_user_id::text, 0));

  select u.email, u.email_confirmed_at, u.invited_at, u.banned_until, u.deleted_at
    into v_raw_email, v_confirmed, v_invited, v_banned, v_deleted
    from auth.users u where u.id = p_user_id;
  if not found then
    return jsonb_build_object('status', 'none', 'reason', 'not_eligible');
  end if;
  v_email := public.normalize_identity_email(v_raw_email);
  if v_email is null or v_confirmed is null or v_invited is null
     or v_deleted is not null or (v_banned is not null and v_banned > now()) then
    return jsonb_build_object('status', 'none', 'reason', 'not_eligible');
  end if;

  if exists (select 1 from auth.users u
              where u.id <> p_user_id and u.deleted_at is null
                and public.normalize_identity_email(u.email) = v_email) then
    return jsonb_build_object('status', 'none', 'reason', 'email_ambiguous');
  end if;

  if exists (select 1 from public.org_members m where m.user_id = p_user_id and m.status = 'active') then
    return jsonb_build_object('status', 'none', 'reason', 'has_active_membership');
  end if;

  select m.* into v_invite
    from public.org_members m
   where m.status = 'invited'
     and m.user_id is null
     and public.normalize_identity_email(m.email) = v_email
     and not exists (select 1 from public.org_members o where o.org_id = m.org_id and o.user_id = p_user_id)
     and exists (select 1 from public.orgs g where g.id = m.org_id)
   order by m.invited_at asc nulls last, m.created_at asc, m.id asc
   limit 1
   for update of m;
  if not found then
    return jsonb_build_object('status', 'none', 'reason', 'no_pending_invite');
  end if;

  -- Only user_id + status change: role / capabilities stay exactly as invited.
  update public.org_members
     set user_id = p_user_id, status = 'active'
   where id = v_invite.id and user_id is null and status = 'invited';
  if not found then
    return jsonb_build_object('status', 'none', 'reason', 'no_pending_invite');
  end if;

  insert into public.audit_events (org_id, action, summary, actor_email, metadata)
  values (
    v_invite.org_id,
    'member.invite_claimed',
    format('招待を承認: %s（%s）', coalesce(nullif(v_invite.display_name, ''), v_email), v_invite.role),
    v_email,
    jsonb_build_object(
      'memberId', v_invite.id,
      'userId', p_user_id,
      'source', 'invite_claim',
      'role', v_invite.role,
      'jobRole', v_invite.job_role,
      'capabilities', to_jsonb(v_invite.capabilities),
      'invitedAt', v_invite.invited_at,
      'statusBefore', 'invited',
      'statusAfter', 'active',
      'emailMatch', 'nfkc_trim_lower'
    )
  );

  return jsonb_build_object('status', 'claimed', 'member_id', v_invite.id, 'org_id', v_invite.org_id);
end;
$$;

revoke all on function public.claim_member_invites(uuid) from public, anon, authenticated;
grant execute on function public.claim_member_invites(uuid) to service_role;

-- (2) last-owner invariant now also covers user_id; only owners with a user_id count.
create or replace function public.org_members_keep_last_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  remaining integer;
begin
  -- Not a usable owner (not active, not owner, or no Auth user bound): unprotected.
  -- This also lets an invite claim bind a null user_id.
  if old.role is distinct from 'owner' or old.status is distinct from 'active' or old.user_id is null then
    return coalesce(new, old);
  end if;
  if tg_op = 'UPDATE' and new.role = 'owner' and new.status = 'active' and new.org_id = old.org_id
     and new.user_id is not distinct from old.user_id then
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
     and m.status = 'active'
     and m.user_id is not null;
  if remaining = 0 then
    raise exception 'last_owner_required' using errcode = 'check_violation';
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists org_members_keep_last_owner on public.org_members;
create trigger org_members_keep_last_owner
  before update of role, status, org_id, user_id or delete on public.org_members
  for each row execute function public.org_members_keep_last_owner();

-- (4) atomic org + owner provisioning.
create or replace function public.provision_org_with_owner(
  p_org_id uuid,
  p_user_id uuid,
  p_email text,
  p_display_name text,
  p_org_name text,
  p_integration_mode text,
  p_trial_ends_at timestamptz,
  p_referral_code text,
  p_capabilities text[]
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org_id uuid;
  v_member public.org_members;
begin
  if p_user_id is null then
    raise exception 'user_id_required' using errcode = 'invalid_parameter_value';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('org_provision:' || p_user_id::text, 0));

  select m.* into v_member
    from public.org_members m
   where m.user_id = p_user_id and m.status = 'active'
   order by m.created_at asc
   limit 1;
  if found then
    return jsonb_build_object('created', false, 'org_id', v_member.org_id, 'member', to_jsonb(v_member));
  end if;

  insert into public.orgs (id, name, integration_mode, gateway_status, trial_ends_at, referral_code)
  values (coalesce(p_org_id, gen_random_uuid()), coalesce(nullif(p_org_name, ''), '新しい組織'), coalesce(p_integration_mode, 'managed'), 'pending',
          p_trial_ends_at, nullif(p_referral_code, ''))
  returning id into v_org_id;

  -- Same statement as before (lib/auth/session.ts); any failure here aborts the
  -- whole function, so the org row above is rolled back with it.
  insert into public.org_members (org_id, user_id, email, display_name, role, job_role, capabilities, status)
  values (v_org_id, p_user_id, p_email, coalesce(p_display_name, ''), 'owner', 'owner',
          coalesce(p_capabilities, '{}'), 'active')
  returning * into v_member;

  return jsonb_build_object('created', true, 'org_id', v_org_id, 'member', to_jsonb(v_member));
end;
$$;

revoke all on function public.provision_org_with_owner(uuid, uuid, text, text, text, text, timestamptz, text, text[]) from public, anon, authenticated;
grant execute on function public.provision_org_with_owner(uuid, uuid, text, text, text, text, timestamptz, text, text[]) to service_role;

-- ROLLBACK (down) — restores the 20261004200000 trigger exactly and drops the
-- RPCs. Turn MEMBER_INVITE_ACTIVATION_ENABLED off first; provisioning falls back
-- to the two-step insert with a compensating delete when the RPC is missing.
-- Members already bound by a claim stay bound (that is the invited state).
-- Run as one transaction:
--   begin;
--   drop function if exists public.claim_member_invites(uuid);
--   drop function if exists public.provision_org_with_owner(uuid, uuid, text, text, text, text, timestamptz, text, text[]);
--   drop function if exists public.normalize_identity_email(text);
--   create or replace function public.org_members_keep_last_owner()
--   returns trigger
--   language plpgsql
--   security definer
--   set search_path = public
--   as $fn$
--   declare
--     remaining integer;
--   begin
--     if old.role is distinct from 'owner' or old.status is distinct from 'active' then
--       return coalesce(new, old);
--     end if;
--     if tg_op = 'UPDATE' and new.role = 'owner' and new.status = 'active' and new.org_id = old.org_id then
--       return new;
--     end if;
--     if not exists (select 1 from public.orgs o where o.id = old.org_id) then
--       return coalesce(new, old);
--     end if;
--     perform pg_advisory_xact_lock(hashtextextended('org_members_owner:' || old.org_id::text, 0));
--     select count(*) into remaining
--       from public.org_members m
--      where m.org_id = old.org_id
--        and m.id <> old.id
--        and m.role = 'owner'
--        and m.status = 'active';
--     if remaining = 0 then
--       raise exception 'last_owner_required' using errcode = 'check_violation';
--     end if;
--     return coalesce(new, old);
--   end;
--   $fn$;
--   drop trigger if exists org_members_keep_last_owner on public.org_members;
--   create trigger org_members_keep_last_owner
--     before update of role, status, org_id or delete on public.org_members
--     for each row execute function public.org_members_keep_last_owner();
--   commit;
-- END ROLLBACK

# Member invite activation / last-owner user_id / atomic org provisioning (2026-10-04)

Migration `supabase/migrations/20261004900000_member_invite_activation.sql`,
flag `MEMBER_INVITE_ACTIVATION_ENABLED` (OFF by default).

## Flow (flag ON)

1. An owner / admin with `manage_team` invites someone on `/app/team`
   (`POST /api/team/members`). `applyMemberChange` + `evaluateMemberChange` decide role
   and capabilities as before, and `writeMemberRow` inserts the row with
   `status = invited`, `user_id = null`.
2. For a **new** invite only, the server sends the Supabase Auth invite
   (`auth.admin.inviteUserByEmail`, normalized address). The outcome
   (`sent` / `existing_account` / `failed`) is in the response as `inviteEmail` and in
   the audit log as `member.invite_email`. No token or link is logged.
3. The invitee clicks the link once. `/auth/confirm` (POST, server-side `verifyOtp`)
   takes them to `/auth/set-password?flow=invite`, then to `/app`.
4. The `/app` gate (`ensureAuthenticatedOrg`), or `/api/auth/repair-org`, sees an
   invited Auth user with no active membership and calls
   `claim_member_invites(user_id)`. The DB binds the matching invite, sets it
   `active`, and writes `member.invite_claimed`. The user lands in the inviting org
   with the invited role and capabilities.

When the address already has an Auth account (`existing_account`), no email is sent.
If that account was itself created by an invite and has no active membership, its
next visit to `/app` binds the invite. Any other account is left pending: see the
open decisions in the PR.

## Read-only SQL for 木村 (production)

Each block runs in a read-only transaction and ends with `rollback`.

```sql
-- readonly:active-rows-without-user (TOKYO307: active owner row with user_id null)
begin transaction read only;
select o.id as org_id, o.name as org_name, o.referral_code,
       m.id as member_id, m.email, m.display_name, m.role, m.job_role, m.status, m.user_id,
       m.capabilities, m.invited_at, m.created_at,
       (select count(*) from public.org_members b
         where b.org_id = m.org_id and b.role = 'owner' and b.status = 'active' and b.user_id is not null) as bound_active_owners,
       (select count(*) from auth.users u
         where u.deleted_at is null and lower(btrim(u.email)) = lower(btrim(m.email))) as auth_users_same_email,
       (select string_agg(u.id::text || ' invited_at=' || coalesce(u.invited_at::text, '-')
                 || ' email_confirmed_at=' || coalesce(u.email_confirmed_at::text, '-')
                 || ' last_sign_in_at=' || coalesce(u.last_sign_in_at::text, '-'), '; ')
          from auth.users u where lower(btrim(u.email)) = lower(btrim(m.email))) as auth_users,
       (select count(*) from public.org_members x
         where x.org_id = m.org_id and x.id <> m.id and lower(btrim(x.email)) = lower(btrim(m.email))) as same_email_rows_in_org
  from public.org_members m
  join public.orgs o on o.id = m.org_id
 where m.status = 'active' and m.user_id is null
 order by o.name, m.created_at;
select a.org_id, a.created_at, a.action, a.actor_email, a.summary, a.metadata
  from public.audit_events a
 where a.metadata->>'memberId' in (select m.id::text from public.org_members m where m.status = 'active' and m.user_id is null)
 order by a.created_at;
rollback;
```

```sql
-- readonly:orphan-orgs (no owner row with a user_id; member_rows = 0 = failed signup/provisioning)
begin transaction read only;
select o.id, o.name, o.created_at, o.trial_ends_at, o.referral_code,
       (select count(*) from public.org_members m where m.org_id = o.id) as member_rows,
       (select count(*) from public.org_members m where m.org_id = o.id and m.status = 'active') as active_members,
       (select count(*) from public.org_members m where m.org_id = o.id and m.role = 'owner' and m.status = 'active') as active_owner_rows,
       (select count(*) from public.subscriptions s where s.org_id = o.id) as subscriptions,
       (select count(*) from public.gateway_links g where g.org_id = o.id) as gateway_links,
       (select count(*) from public.employees e where e.org_id = o.id) as employees,
       (select count(*) from public.audit_events a where a.org_id = o.id) as audit_events
  from public.orgs o
 where not exists (select 1 from public.org_members m
                    where m.org_id = o.id and m.role = 'owner' and m.status = 'active' and m.user_id is not null)
 order by o.created_at;
rollback;
```

```sql
-- readonly:pending-invites (what a claim would bind; run before inviting 上原 / 仙田 and after they sign in)
begin transaction read only;
select o.name as org_name, m.id as member_id, m.email, m.role, m.capabilities, m.status, m.user_id, m.invited_at,
       (select string_agg(u.id::text || ' invited_at=' || coalesce(u.invited_at::text, '-')
                 || ' email_confirmed_at=' || coalesce(u.email_confirmed_at::text, '-'), '; ')
          from auth.users u where u.deleted_at is null and lower(btrim(u.email)) = lower(btrim(m.email))) as auth_users,
       (select count(*) from public.org_members a
          join auth.users u on u.id = a.user_id
         where a.status = 'active' and lower(btrim(u.email)) = lower(btrim(m.email))) as active_memberships_elsewhere
  from public.org_members m
  join public.orgs o on o.id = m.org_id
 where m.status = 'invited' and m.user_id is null
 order by m.invited_at;
select a.org_id, a.created_at, a.action, a.actor_email, a.summary, a.metadata
  from public.audit_events a
 where a.action in ('member.invite_claimed', 'member.invite_email')
 order by a.created_at desc
 limit 50;
rollback;
```

## TOKYO307 extra owner row (active, user_id null)

The claim RPC never binds it, because it binds only `status = 'invited'` rows. The
last-owner trigger also does not count it as an owner. Run the first query above,
then decide:

- If it is a real pending invite for a known person, turn it back into an invite
  with one reviewed statement (it is then bound on that person's first invite
  sign-in). Do this only after confirming the email belongs to that person:
  `update public.org_members set status = 'invited', invited_at = coalesce(invited_at, now()) where id = '<member_id>' and user_id is null and status = 'active';`
- If it is stale (seed / test / mistyped address), delete it. The trigger allows
  this, because the row has no user_id:
  `delete from public.org_members where id = '<member_id>' and user_id is null;`

Neither statement is part of this PR.

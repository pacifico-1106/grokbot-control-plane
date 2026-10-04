-- Member invite activation / last-owner user_id / atomic org provisioning
-- (migration 20261004900000_member_invite_activation.sql). Fixture data only.
--   (1) public.claim_member_invites(p_user_id): binds ONE pending invite
--       (status invited, user_id null) whose email matches the Auth user's
--       verified email (NFKC + trim + lower) — only for invite-created Auth
--       users (invited_at) that confirmed the invite (email_confirmed_at).
--       Role / capabilities kept exactly; audit row in the same transaction;
--       idempotent; never for a user with another active membership.
--   (2) org_members_keep_last_owner also covers user_id: the last active
--       owner WITH a user_id cannot be re-pointed or nulled; owners without a
--       user_id never count; binding a null user_id still works.
--   (4) public.provision_org_with_owner: org + owner row in ONE transaction
--       (member insert failure leaves no org row); idempotent per user.
-- Every check records its failure instead of aborting, then one exception
-- lists them all ("member invite activation checks failed (N case(s))").
-- Cleans up its own fixtures (re-runnable).
\set ON_ERROR_STOP 1
reset role;
drop table if exists pg_temp.invite_failures;
create temporary table invite_failures(label text, detail text);
grant all on invite_failures to public;

-- fixtures ------------------------------------------------------------------
insert into public.orgs (id, name) values
 ('a9000000-0000-4000-8000-0000000000a1', 'invite-fixture-a'),
 ('a9000000-0000-4000-8000-0000000000a2', 'invite-fixture-b'),
 ('a9000000-0000-4000-8000-0000000000a3', 'invite-fixture-c');
insert into auth.users (id, email, email_confirmed_at, invited_at, deleted_at) values
 ('a9100000-0000-4000-8000-000000000001', 'owner-a@fixture.invalid', now(), null, null),
 ('a9100000-0000-4000-8000-000000000002', 'owner-b@fixture.invalid', now(), null, null),
 ('a9100000-0000-4000-8000-000000000011', 'uehara@fixture.invalid', now(), now(), null),          -- happy path
 ('a9100000-0000-4000-8000-000000000012', 'unverified@fixture.invalid', null, now(), null),       -- invite not accepted
 ('a9100000-0000-4000-8000-000000000013', 'selfsignup@fixture.invalid', now(), null, null),       -- email_confirm:true signup (no proof)
 ('a9100000-0000-4000-8000-000000000014', 'attacker@fixture.invalid', now(), now(), null),        -- invited elsewhere
 ('a9100000-0000-4000-8000-000000000015', 'multi-org@fixture.invalid', now(), now(), null),       -- already active in org b
 ('a9100000-0000-4000-8000-000000000016', 'two-invites@fixture.invalid', now(), now(), null),
 ('a9100000-0000-4000-8000-000000000017', 'phantom@fixture.invalid', now(), now(), null),         -- TOKYO307 pattern
 ('a9100000-0000-4000-8000-000000000018', 'deleted@fixture.invalid', now(), now(), now()),
 ('a9100000-0000-4000-8000-000000000019', 'dup@fixture.invalid', now(), now(), null),
 ('a9100000-0000-4000-8000-000000000020', 'DUP@fixture.invalid', now(), now(), null),             -- same normalized email
 ('a9100000-0000-4000-8000-000000000021', 'sendai@fixture.invalid', now(), now(), null),          -- invited as owner
 ('a9100000-0000-4000-8000-000000000022', 'rejoin@fixture.invalid', now(), now(), null);          -- old disabled row in org a
insert into public.org_members (id, org_id, user_id, email, display_name, role, job_role, capabilities, status, invited_at, created_at) values
 ('a9200000-0000-4000-8000-000000000001','a9000000-0000-4000-8000-0000000000a1','a9100000-0000-4000-8000-000000000001','owner-a@fixture.invalid','Owner A','owner','owner','{view_dashboard,view_employees,view_audit,approve_actions,manage_spend_limits,hire_issue_credentials,manage_team,manage_billing}','active',null, now() - interval '10 days'),
 ('a9200000-0000-4000-8000-000000000002','a9000000-0000-4000-8000-0000000000a2','a9100000-0000-4000-8000-000000000002','owner-b@fixture.invalid','Owner B','owner','owner','{view_dashboard,manage_team,manage_billing}','active',null, now() - interval '10 days'),
 -- invite stored un-normalized (legacy row): fullwidth + mixed case + spaces
 ('a9200000-0000-4000-8000-000000000011','a9000000-0000-4000-8000-0000000000a1',null,' ＵＥＨＡＲＡ@Fixture.Invalid ','上原','admin','sales','{view_dashboard,approve_actions,manage_team}','invited', now() - interval '1 day', now() - interval '1 day'),
 ('a9200000-0000-4000-8000-000000000012','a9000000-0000-4000-8000-0000000000a1',null,'unverified@fixture.invalid','U','member','custom','{view_dashboard}','invited', now(), now()),
 ('a9200000-0000-4000-8000-000000000013','a9000000-0000-4000-8000-0000000000a1',null,'selfsignup@fixture.invalid','S','member','custom','{view_dashboard}','invited', now(), now()),
 ('a9200000-0000-4000-8000-000000000014','a9000000-0000-4000-8000-0000000000a1',null,'victim@fixture.invalid','V','owner','owner','{view_dashboard,manage_team,manage_billing}','invited', now(), now()),
 ('a9200000-0000-4000-8000-000000000015','a9000000-0000-4000-8000-0000000000a1',null,'multi-org@fixture.invalid','M','member','custom','{view_dashboard}','invited', now(), now()),
 ('a9200000-0000-4000-8000-000000000115','a9000000-0000-4000-8000-0000000000a2','a9100000-0000-4000-8000-000000000015','multi-org@fixture.invalid','M','member','custom','{view_dashboard}','active', null, now()),
 ('a9200000-0000-4000-8000-000000000016','a9000000-0000-4000-8000-0000000000a2',null,'two-invites@fixture.invalid','T','member','custom','{view_dashboard}','invited', now() - interval '2 hours', now()),
 ('a9200000-0000-4000-8000-000000000116','a9000000-0000-4000-8000-0000000000a3',null,'two-invites@fixture.invalid','T','member','custom','{view_dashboard}','invited', now() - interval '1 hour', now()),
 ('a9200000-0000-4000-8000-000000000017','a9000000-0000-4000-8000-0000000000a1',null,'phantom@fixture.invalid','P','owner','owner','{view_dashboard,manage_team,manage_billing}','active', null, now()),
 ('a9200000-0000-4000-8000-000000000018','a9000000-0000-4000-8000-0000000000a1',null,'deleted@fixture.invalid','D','member','custom','{view_dashboard}','invited', now(), now()),
 ('a9200000-0000-4000-8000-000000000019','a9000000-0000-4000-8000-0000000000a1',null,'dup@fixture.invalid','Dup','member','custom','{view_dashboard}','invited', now(), now()),
 ('a9200000-0000-4000-8000-000000000021','a9000000-0000-4000-8000-0000000000a3',null,'sendai@fixture.invalid','仙田','owner','owner','{view_dashboard,view_employees,view_audit,approve_actions,manage_spend_limits,hire_issue_credentials,manage_team,manage_billing}','invited', now(), now()),
 ('a9200000-0000-4000-8000-000000000022','a9000000-0000-4000-8000-0000000000a1','a9100000-0000-4000-8000-000000000022','rejoin-old@fixture.invalid','R','member','custom','{view_dashboard}','disabled', null, now()),
 ('a9200000-0000-4000-8000-000000000122','a9000000-0000-4000-8000-0000000000a1',null,'rejoin@fixture.invalid','R','member','custom','{view_dashboard}','invited', now(), now());

-- (1) invite claim ----------------------------------------------------------
do $$
declare r jsonb; m public.org_members;
begin
  r := public.claim_member_invites('a9100000-0000-4000-8000-000000000011');
  if r->>'status' is distinct from 'claimed' or r->>'member_id' is distinct from 'a9200000-0000-4000-8000-000000000011'
     or r->>'org_id' is distinct from 'a9000000-0000-4000-8000-0000000000a1' then
    raise exception 'unexpected result %', r;
  end if;
  select * into m from public.org_members where id = 'a9200000-0000-4000-8000-000000000011';
  if m.user_id is distinct from 'a9100000-0000-4000-8000-000000000011' or m.status <> 'active' then
    raise exception 'row not bound/active: % %', m.user_id, m.status;
  end if;
  if m.role <> 'admin' or m.capabilities <> '{view_dashboard,approve_actions,manage_team}'::text[] or m.job_role <> 'sales'
     or m.email <> ' ＵＥＨＡＲＡ@Fixture.Invalid ' or m.display_name <> '上原' or m.invited_at is null then
    raise exception 'invited role/capabilities/profile changed: % % % %', m.role, m.capabilities, m.job_role, m.email;
  end if;
  if (select count(*) from public.audit_events where org_id = 'a9000000-0000-4000-8000-0000000000a1'
        and action = 'member.invite_claimed' and metadata->>'memberId' = 'a9200000-0000-4000-8000-000000000011'
        and metadata->>'userId' = 'a9100000-0000-4000-8000-000000000011'
        and metadata->>'role' = 'admin'
        and metadata->'capabilities' = '["view_dashboard","approve_actions","manage_team"]'::jsonb) <> 1 then
    raise exception 'expected exactly one member.invite_claimed audit row';
  end if;
exception when others then insert into invite_failures values ('(1a) matching verified invitee binds, role/caps kept, audited', sqlerrm);
end $$;

do $$
declare r jsonb;
begin
  r := public.claim_member_invites('a9100000-0000-4000-8000-000000000011');
  if r->>'status' is distinct from 'none' or r->>'reason' is distinct from 'has_active_membership' then
    raise exception 'second claim: %', r;
  end if;
  if (select count(*) from public.audit_events where action = 'member.invite_claimed'
        and metadata->>'memberId' = 'a9200000-0000-4000-8000-000000000011') <> 1 then
    raise exception 'second claim wrote another audit row';
  end if;
exception when others then insert into invite_failures values ('(1b) idempotent: second claim is a no-op', sqlerrm);
end $$;

do $$
declare r jsonb; u uuid; label text;
begin
  foreach label in array array['012:not_eligible','013:not_eligible','018:not_eligible'] loop
    u := ('a9100000-0000-4000-8000-000000000' || split_part(label, ':', 1))::uuid;
    r := public.claim_member_invites(u);
    if r->>'status' is distinct from 'none' or r->>'reason' is distinct from split_part(label, ':', 2) then
      raise exception 'user % got %', u, r;
    end if;
  end loop;
  if exists (select 1 from public.org_members where id in ('a9200000-0000-4000-8000-000000000012','a9200000-0000-4000-8000-000000000013','a9200000-0000-4000-8000-000000000018')
               and (user_id is not null or status <> 'invited')) then
    raise exception 'ineligible user bound an invite';
  end if;
exception when others then insert into invite_failures values ('(1c) unconfirmed / self-signup (no invite proof) / deleted users never bind', sqlerrm);
end $$;

do $$
declare r jsonb;
begin
  r := public.claim_member_invites('a9100000-0000-4000-8000-000000000014');
  if r->>'status' is distinct from 'none' or r->>'reason' is distinct from 'no_pending_invite' then raise exception 'attacker got %', r; end if;
  if exists (select 1 from public.org_members where id = 'a9200000-0000-4000-8000-000000000014' and (user_id is not null or status <> 'invited')) then
    raise exception 'non-matching invite was claimed';
  end if;
  -- the function takes no email argument at all (nothing client-supplied to trust)
  if (select pg_get_function_identity_arguments('public.claim_member_invites(uuid)'::regprocedure)) <> 'p_user_id uuid' then
    raise exception 'claim_member_invites must take only p_user_id';
  end if;
exception when others then insert into invite_failures values ('(1d) non-matching email never claims; no email parameter', sqlerrm);
end $$;

do $$
declare r jsonb;
begin
  r := public.claim_member_invites('a9100000-0000-4000-8000-000000000015');
  if r->>'status' is distinct from 'none' or r->>'reason' is distinct from 'has_active_membership' then raise exception 'multi-org got %', r; end if;
  if exists (select 1 from public.org_members where id = 'a9200000-0000-4000-8000-000000000015' and (user_id is not null or status <> 'invited')) then
    raise exception 'invite bound for a user active in another org';
  end if;
exception when others then insert into invite_failures values ('(1e) user active in another org: invite left pending', sqlerrm);
end $$;

do $$
declare r jsonb;
begin
  r := public.claim_member_invites('a9100000-0000-4000-8000-000000000016');
  if r->>'status' is distinct from 'claimed' or r->>'member_id' is distinct from 'a9200000-0000-4000-8000-000000000016' then raise exception 'two-invites got %', r; end if;
  if exists (select 1 from public.org_members where id = 'a9200000-0000-4000-8000-000000000116' and (user_id is not null or status <> 'invited')) then
    raise exception 'second invite was also bound';
  end if;
exception when others then insert into invite_failures values ('(1f) several pending invites: only the oldest binds', sqlerrm);
end $$;

do $$
declare r jsonb;
begin
  r := public.claim_member_invites('a9100000-0000-4000-8000-000000000017');
  if r->>'status' is distinct from 'none' then raise exception 'phantom got %', r; end if;
  if exists (select 1 from public.org_members where id = 'a9200000-0000-4000-8000-000000000017' and user_id is not null) then
    raise exception 'active owner row without user_id was bound';
  end if;
exception when others then insert into invite_failures values ('(1g) active row with user_id null (TOKYO307 pattern) is never bound', sqlerrm);
end $$;

do $$
declare r jsonb;
begin
  r := public.claim_member_invites('a9100000-0000-4000-8000-000000000019');
  if r->>'status' is distinct from 'none' or r->>'reason' is distinct from 'email_ambiguous' then raise exception 'dup got %', r; end if;
  if exists (select 1 from public.org_members where id = 'a9200000-0000-4000-8000-000000000019' and user_id is not null) then
    raise exception 'ambiguous email bound';
  end if;
exception when others then insert into invite_failures values ('(1h) two Auth users with the same normalized email: nobody binds', sqlerrm);
end $$;

do $$
declare r jsonb; m public.org_members;
begin
  r := public.claim_member_invites('a9100000-0000-4000-8000-000000000021');
  select * into m from public.org_members where id = 'a9200000-0000-4000-8000-000000000021';
  if r->>'status' is distinct from 'claimed' or m.user_id is distinct from 'a9100000-0000-4000-8000-000000000021'
     or m.status <> 'active' or m.role <> 'owner'
     or m.capabilities <> '{view_dashboard,view_employees,view_audit,approve_actions,manage_spend_limits,hire_issue_credentials,manage_team,manage_billing}'::text[] then
    raise exception 'owner invite: % / % % %', r, m.status, m.role, m.capabilities;
  end if;
exception when others then insert into invite_failures values ('(1i) invited owner becomes an active owner with exactly the invited capabilities', sqlerrm);
end $$;

do $$
declare r jsonb;
begin
  r := public.claim_member_invites('a9100000-0000-4000-8000-000000000022');
  if r->>'status' is distinct from 'none' or r->>'reason' is distinct from 'no_pending_invite' then raise exception 'rejoin got %', r; end if;
  if exists (select 1 from public.org_members where id = 'a9200000-0000-4000-8000-000000000122' and user_id is not null) then
    raise exception 'second row for the same user in one org';
  end if;
  r := public.claim_member_invites(null);
  if r->>'status' is distinct from 'none' then raise exception 'null user got %', r; end if;
  r := public.claim_member_invites('a9100000-0000-4000-8000-0000000000ff');
  if r->>'status' is distinct from 'none' or r->>'reason' is distinct from 'not_eligible' then raise exception 'unknown user got %', r; end if;
exception when others then insert into invite_failures values ('(1j) no second row per org; null / unknown user is a no-op', sqlerrm);
end $$;

do $$
declare f text;
begin
  foreach f in array array['public.claim_member_invites(uuid)',
    'public.provision_org_with_owner(uuid,text,text,text,text,timestamptz,text,text[])'] loop
    if has_function_privilege('anon', f, 'execute') or has_function_privilege('authenticated', f, 'execute') then
      raise exception '% executable by a session role', f;
    end if;
    if not has_function_privilege('service_role', f, 'execute') then
      raise exception '% not executable by service_role', f;
    end if;
  end loop;
exception when others then insert into invite_failures values ('(1k) RPCs are service_role only (no anon / authenticated execute)', sqlerrm);
end $$;

-- (2) last-owner trigger covers user_id ----------------------------------------
insert into auth.users (id, email, email_confirmed_at) values
 ('a9100000-0000-4000-8000-000000000031', 'owner-c@fixture.invalid', now()),
 ('a9100000-0000-4000-8000-000000000032', 'owner-c2@fixture.invalid', now());
insert into public.org_members (id, org_id, user_id, email, role, capabilities, status) values
 ('a9200000-0000-4000-8000-000000000031','a9000000-0000-4000-8000-0000000000a3','a9100000-0000-4000-8000-000000000031','owner-c@fixture.invalid','owner','{manage_team}','active'),
 ('a9200000-0000-4000-8000-000000000033','a9000000-0000-4000-8000-0000000000a3',null,'phantom-c@fixture.invalid','owner','{manage_team}','active');
-- org c now: bound owner 031, phantom owner 033 (no user_id), owner 021 bound by (1i) if it passed.
delete from public.org_members where id = 'a9200000-0000-4000-8000-000000000021' and user_id is not null;
do $$
declare stmt text;
begin
  foreach stmt in array array[
    'update public.org_members set user_id = ''a9100000-0000-4000-8000-000000000032'' where id = ''a9200000-0000-4000-8000-000000000031''',
    'update public.org_members set user_id = null where id = ''a9200000-0000-4000-8000-000000000031''',
    'update public.org_members set role = ''admin'' where id = ''a9200000-0000-4000-8000-000000000031''',
    'update public.org_members set status = ''disabled'' where id = ''a9200000-0000-4000-8000-000000000031''',
    'delete from public.org_members where id = ''a9200000-0000-4000-8000-000000000031'''
  ] loop
    begin
      execute stmt;
      raise exception 'last bound owner removable (an owner row without user_id counted): %', stmt;
    exception when check_violation then
      if sqlerrm <> 'last_owner_required' then raise; end if;
    end;
  end loop;
exception when others then insert into invite_failures values ('(2a) last active owner with a user_id: re-point / null / demote / disable / delete blocked', sqlerrm);
end $$;

do $$
begin
  -- binding a null user_id (also on an active owner row) is allowed
  update public.org_members set user_id = 'a9100000-0000-4000-8000-000000000032' where id = 'a9200000-0000-4000-8000-000000000033';
  -- now two bound owners: one may be re-pointed / nulled
  update public.org_members set user_id = null where id = 'a9200000-0000-4000-8000-000000000031';
  if (select count(*) from public.org_members where org_id = 'a9000000-0000-4000-8000-0000000000a3'
        and role = 'owner' and status = 'active' and user_id is not null) <> 1 then
    raise exception 'expected one bound owner left';
  end if;
  -- the unbound owner row is not protected
  delete from public.org_members where id = 'a9200000-0000-4000-8000-000000000031';
  -- capability edits on the last owner stay possible
  update public.org_members set capabilities = '{manage_team,manage_billing}' where id = 'a9200000-0000-4000-8000-000000000033';
exception when others then insert into invite_failures values ('(2b) null user_id binding and changes with another bound owner still work', sqlerrm);
end $$;

-- (4) atomic org provisioning ------------------------------------------------
insert into auth.users (id, email, email_confirmed_at) values
 ('a9100000-0000-4000-8000-000000000041', 'p41@fixture.invalid', now()),
 ('a9100000-0000-4000-8000-000000000042', 'p42@fixture.invalid', now());
do $$
declare r jsonb; r2 jsonb; m public.org_members;
begin
  r := public.provision_org_with_owner('a9100000-0000-4000-8000-000000000041', 'p41@fixture.invalid', 'P41',
         'invite-fixture-p41', 'managed', now() + interval '14 days', 'AIC-TEST', '{view_dashboard,manage_team,manage_billing}');
  if (r->>'created')::boolean is not true then raise exception 'not created: %', r; end if;
  select * into m from public.org_members where id = (r->'member'->>'id')::uuid;
  if m.org_id <> (r->>'org_id')::uuid or m.user_id <> 'a9100000-0000-4000-8000-000000000041' or m.role <> 'owner'
     or m.status <> 'active' or m.job_role <> 'owner' or m.capabilities <> '{view_dashboard,manage_team,manage_billing}'::text[] then
    raise exception 'owner row wrong: %', to_jsonb(m);
  end if;
  if (select count(*) from public.orgs where name = 'invite-fixture-p41' and referral_code = 'AIC-TEST'
        and integration_mode = 'managed' and gateway_status = 'pending' and trial_ends_at is not null) <> 1 then
    raise exception 'org row wrong';
  end if;
  r2 := public.provision_org_with_owner('a9100000-0000-4000-8000-000000000041', 'p41@fixture.invalid', 'P41',
         'invite-fixture-p41-again', 'managed', now() + interval '14 days', null, '{view_dashboard}');
  if (r2->>'created')::boolean is not false or r2->>'org_id' <> r->>'org_id' then raise exception 'not idempotent: %', r2; end if;
  if exists (select 1 from public.orgs where name = 'invite-fixture-p41-again') then raise exception 'second org created'; end if;
exception when others then insert into invite_failures values ('(4a) provision creates org + owner together; idempotent per user', sqlerrm);
end $$;

do $$
begin
  begin
    -- member insert fails (email is NOT NULL) after the org insert
    perform public.provision_org_with_owner('a9100000-0000-4000-8000-000000000042', null, 'P42',
         'invite-fixture-p42', 'managed', now() + interval '14 days', null, '{view_dashboard}');
    raise exception 'provision with a failing member insert succeeded';
  exception when not_null_violation then null;
  end;
  if exists (select 1 from public.orgs where name = 'invite-fixture-p42') then
    raise exception 'org row left behind after member insert failure';
  end if;
exception when others then insert into invite_failures values ('(4b) member insert failure leaves no org row', sqlerrm);
end $$;

-- cleanup + verdict ----------------------------------------------------------
delete from public.orgs where id::text like 'a9000000-%' or name like 'invite-fixture-%';
delete from auth.users where id::text like 'a9100000-%';
do $$
declare msg text;
begin
  select string_agg(format('%s: %s', label, detail), E'\n' order by label) into msg from invite_failures;
  if msg is not null then
    raise exception E'member invite activation checks failed (% case(s)):\n%', (select count(*) from invite_failures), msg;
  end if;
end $$;

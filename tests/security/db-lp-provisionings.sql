-- LP setup-fee payment record (migration 20261012400000, LP_AUTO_PROVISION_MODE=dry_run).
-- Synthetic fixtures only (cs_test_lpfixture…/evt_lpfixture…); cleans up after itself.
-- Runs in scripts/test-db-local.py (plus a 12-way concurrent notice claim there)
-- and after every migration in scripts/test-db-all-migrations.py.
--  (1) RLS on, no policy; anon / authenticated hold no table privilege and
--      cannot execute the notice functions
--  (2) one event row per Stripe event id; one payment row per Checkout Session (23505)
--  (3) value CHECKs: ids, currency, amount, lp_page allowlist, lp_ref regex,
--      AIC- code, email sha256 — invalid values only as the '(invalid)' marker
--  (4) notice claim: once; a second claim false; finish only with the claim
--      token; 'failed' releases (own token only); after 'sent' never again;
--      a stale claim (> p_stale_seconds) can be taken over
\set ON_ERROR_STOP 1
reset role;

create or replace function security_test.lpp_denied(command text) returns void language plpgsql as $$
begin
  begin
    execute command;
  exception when insufficient_privilege then return;
  end;
  raise exception 'lp provisionings: session access not denied: %', command;
end $$;
create or replace function security_test.lpp_rejects(command text, expected text) returns void language plpgsql as $$
begin
  begin
    execute command;
  exception when others then
    if position(expected in sqlerrm) > 0 or sqlstate = expected then return; end if;
    raise exception 'lp provisionings: % failed with "%" / % (expected "%")', command, sqlerrm, sqlstate, expected;
  end;
  raise exception 'lp provisionings: not rejected: %', command;
end $$;
grant execute on function security_test.lpp_denied(text), security_test.lpp_rejects(text, text) to anon, authenticated, service_role;

-- (1)
do $$
declare r text; t text;
begin
  foreach t in array array['lp_provisionings','lp_provisioning_events'] loop
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then
      raise exception 'lp provisionings: RLS off on %', t;
    end if;
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = t) then
      raise exception 'lp provisionings: unexpected policy on %', t;
    end if;
    foreach r in array array['anon','authenticated'] loop
      if has_table_privilege(r, 'public.' || t, 'SELECT') or has_table_privilege(r, 'public.' || t, 'INSERT')
         or has_table_privilege(r, 'public.' || t, 'UPDATE') or has_table_privilege(r, 'public.' || t, 'DELETE') then
        raise exception 'lp provisionings: % holds a privilege on %', r, t;
      end if;
    end loop;
  end loop;
  foreach r in array array['anon','authenticated'] loop
    if has_function_privilege(r, 'public.claim_lp_provisioning_notice(text,text,integer)', 'EXECUTE')
       or has_function_privilege(r, 'public.finish_lp_provisioning_notice(text,text,text)', 'EXECUTE') then
      raise exception 'lp provisionings: % can execute a notice function', r;
    end if;
  end loop;
end $$;
set role anon;
select security_test.lpp_denied('select * from public.lp_provisionings');
select security_test.lpp_denied($q$select public.claim_lp_provisioning_notice('cs_test_lpfixture1','tok_anon_0123456789abcdef',600)$q$);
reset role;
set role authenticated;
select security_test.lpp_denied('select * from public.lp_provisioning_events');
select security_test.lpp_denied($q$select public.finish_lp_provisioning_notice('cs_test_lpfixture1','tok_auth_0123456789abcdef','sent')$q$);
reset role;

set role service_role;
-- (2) event dedupe
insert into public.lp_provisioning_events (stripe_event_id, stripe_checkout_session_id, event_type, outcome, payment_status, livemode)
values ('evt_lpfixture1', 'cs_test_lpfixture1', 'checkout.session.completed', 'paid', 'paid', false);
select security_test.lpp_rejects($q$insert into public.lp_provisioning_events (stripe_event_id, stripe_checkout_session_id, event_type, outcome, payment_status, livemode)
  values ('evt_lpfixture1', 'cs_test_lpfixture1', 'checkout.session.completed', 'paid', 'paid', false)$q$, '23505');
insert into public.lp_provisioning_events (stripe_event_id, stripe_checkout_session_id, event_type, outcome, reason, payment_status, livemode)
values ('evt_lpfixture2', 'cs_test_lpfixture1', 'checkout.session.async_payment_succeeded', 'ignored', 'session_unpaid', 'unpaid', false);
-- (2) session dedupe
insert into public.lp_provisionings (stripe_checkout_session_id, first_stripe_event_id, livemode, amount_total, currency, plan, lp_page, lp_ref, referral_code, customer_email_sha256, customer_email_domain)
values ('cs_test_lpfixture1', 'evt_lpfixture1', false, 165000, 'jpy', 'proper', 'ai-employee-corp', 'partner_01', 'AIC-ABCD1234', repeat('a', 64), 'example.co.jp');
select security_test.lpp_rejects($q$insert into public.lp_provisionings (stripe_checkout_session_id, first_stripe_event_id, livemode, amount_total, currency, plan, lp_page)
  values ('cs_test_lpfixture1', 'evt_lpfixture2', false, 165000, 'jpy', 'proper', 'ai-employee')$q$, '23505');
-- (3) CHECKs
select security_test.lpp_rejects($q$insert into public.lp_provisionings (stripe_checkout_session_id, first_stripe_event_id, livemode, amount_total, currency, plan, lp_page)
  values ('cs_test_lpfixture2', 'evt_lpfixture3', false, 1, 'jpy', 'proper', 'evil-page')$q$, '23514');
select security_test.lpp_rejects($q$insert into public.lp_provisionings (stripe_checkout_session_id, first_stripe_event_id, livemode, amount_total, currency, plan, lp_page, lp_ref)
  values ('cs_test_lpfixture2', 'evt_lpfixture3', false, 1, 'jpy', 'proper', 'ai-employee', '<script>')$q$, '23514');
select security_test.lpp_rejects($q$insert into public.lp_provisionings (stripe_checkout_session_id, first_stripe_event_id, livemode, amount_total, currency, plan, lp_page, referral_code)
  values ('cs_test_lpfixture2', 'evt_lpfixture3', false, 1, 'jpy', 'proper', 'ai-employee', 'aic-lower')$q$, '23514');
select security_test.lpp_rejects($q$insert into public.lp_provisionings (stripe_checkout_session_id, first_stripe_event_id, livemode, amount_total, currency, plan, lp_page, customer_email_sha256)
  values ('cs_test_lpfixture2', 'evt_lpfixture3', false, 1, 'jpy', 'proper', 'ai-employee', 'someone@example.com')$q$, '23514');
select security_test.lpp_rejects($q$insert into public.lp_provisionings (stripe_checkout_session_id, first_stripe_event_id, livemode, amount_total, currency, plan, lp_page)
  values ('cs_test_lpfixture2', 'evt_lpfixture3', false, -1, 'jpy', 'proper', 'ai-employee')$q$, '23514');
select security_test.lpp_rejects($q$insert into public.lp_provisionings (stripe_checkout_session_id, first_stripe_event_id, livemode, amount_total, currency, plan, lp_page)
  values ('cs_test_lpfixture2', 'evt_lpfixture3', false, 1, 'JPY', 'proper', 'ai-employee')$q$, '23514');
select security_test.lpp_rejects($q$insert into public.lp_provisionings (stripe_checkout_session_id, first_stripe_event_id, livemode, amount_total, currency, plan, lp_page)
  values ('not_a_session', 'evt_lpfixture3', false, 1, 'jpy', 'proper', 'ai-employee')$q$, '23514');
select security_test.lpp_rejects($q$insert into public.lp_provisioning_events (stripe_event_id, event_type, outcome)
  values ('evt_lpfixture9', 'customer.created', 'ignored')$q$, '23514');
-- markers are accepted
insert into public.lp_provisionings (stripe_checkout_session_id, first_stripe_event_id, livemode, amount_total, currency, plan, lp_page, lp_ref, referral_code, lp_order_id, customer_email_domain)
values ('cs_test_lpfixture3', 'evt_lpfixture4', false, 0, 'usd', '(invalid)', '(invalid)', '(invalid)', '(invalid)', '(invalid)', '(invalid)');

-- (4) notice claim / finish
do $$
begin
  if not public.claim_lp_provisioning_notice('cs_test_lpfixture1', 'tok_first_0123456789abcd', 600) then
    raise exception 'lp provisionings: first claim failed'; end if;
  if public.claim_lp_provisioning_notice('cs_test_lpfixture1', 'tok_second_0123456789abc', 600) then
    raise exception 'lp provisionings: second claim succeeded'; end if;
  if public.finish_lp_provisioning_notice('cs_test_lpfixture1', 'tok_second_0123456789abc', 'sent') then
    raise exception 'lp provisionings: finish with a foreign token succeeded'; end if;
  if public.finish_lp_provisioning_notice('cs_test_lpfixture1', 'tok_second_0123456789abc', 'failed') then
    raise exception 'lp provisionings: release with a foreign token succeeded'; end if;
  -- own release → claimable again
  if not public.finish_lp_provisioning_notice('cs_test_lpfixture1', 'tok_first_0123456789abcd', 'failed') then
    raise exception 'lp provisionings: own release refused'; end if;
  if not public.claim_lp_provisioning_notice('cs_test_lpfixture1', 'tok_third_0123456789abcd', 600) then
    raise exception 'lp provisionings: re-claim after release failed'; end if;
  if not public.finish_lp_provisioning_notice('cs_test_lpfixture1', 'tok_third_0123456789abcd', 'sent') then
    raise exception 'lp provisionings: finish sent refused'; end if;
  if (select notified_at is null or notice_result <> 'sent' or notice_claim_token is not null from public.lp_provisionings where stripe_checkout_session_id = 'cs_test_lpfixture1') then
    raise exception 'lp provisionings: sent state not recorded'; end if;
  -- after sent: never again (even with stale = 0)
  if public.claim_lp_provisioning_notice('cs_test_lpfixture1', 'tok_fourth_0123456789abc', 0) then
    raise exception 'lp provisionings: claim after sent succeeded'; end if;
  -- unknown session
  if public.claim_lp_provisioning_notice('cs_test_lpfixture_none', 'tok_fifth_0123456789abcd', 600) then
    raise exception 'lp provisionings: claim on a missing session succeeded'; end if;
  -- stale takeover
  if not public.claim_lp_provisioning_notice('cs_test_lpfixture3', 'tok_stale_a_0123456789ab', 600) then
    raise exception 'lp provisionings: claim 3 failed'; end if;
  update public.lp_provisionings set notice_claimed_at = now() - interval '20 minutes' where stripe_checkout_session_id = 'cs_test_lpfixture3';
  if not public.claim_lp_provisioning_notice('cs_test_lpfixture3', 'tok_stale_b_0123456789ab', 600) then
    raise exception 'lp provisionings: stale claim not taken over'; end if;
  if public.finish_lp_provisioning_notice('cs_test_lpfixture3', 'tok_stale_a_0123456789ab', 'sent') then
    raise exception 'lp provisionings: the superseded claimer finished'; end if;
  begin
    perform public.claim_lp_provisioning_notice('cs_test_lpfixture3', 'short', 600);
    raise exception 'lp provisionings: short token accepted';
  exception when others then
    if sqlerrm not like '%invalid_claim_token%' then raise; end if;
  end;
  begin
    perform public.finish_lp_provisioning_notice('cs_test_lpfixture3', 'tok_stale_b_0123456789ab', 'bogus');
    raise exception 'lp provisionings: bogus result accepted';
  exception when others then
    if sqlerrm not like '%invalid_notice_result%' then raise; end if;
  end;
end $$;
reset role;

delete from public.lp_provisionings where stripe_checkout_session_id like 'cs_test_lpfixture%';
delete from public.lp_provisioning_events where stripe_event_id like 'evt_lpfixture%';
drop function security_test.lpp_denied(text);
drop function security_test.lpp_rejects(text, text);

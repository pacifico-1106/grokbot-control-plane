-- LP lead page (migration 20261012300000): lp_inquiries.lp_page / lp_journeys.lp_page.
-- Synthetic fixtures only (ids a9100000-…); cleans up after itself. Runs in
-- scripts/test-db-local.py and after the full history in scripts/test-db-all-migrations.py.
--  (1) both columns exist, nullable text, no default (rows written before the flag stay NULL)
--  (2) CHECK: only 'ai-employee' / 'ai-employee-corp' (or NULL); anything else is rejected
--  (3) no new privilege: anon / authenticated still cannot insert / update / select the tables
--  (4) RLS still on for both tables
\set ON_ERROR_STOP 1
reset role;
do $$
declare
  t text;
  r record;
begin
  foreach t in array array['lp_inquiries', 'lp_journeys'] loop
    select data_type, is_nullable, column_default into r
      from information_schema.columns where table_schema = 'public' and table_name = t and column_name = 'lp_page';
    if not found then raise exception 'lead page: %.lp_page missing', t; end if;
    if r.data_type <> 'text' or r.is_nullable <> 'YES' or r.column_default is not null then
      raise exception 'lead page: %.lp_page must be nullable text without default (got %, %, %)', t, r.data_type, r.is_nullable, r.column_default;
    end if;
    if not (select relrowsecurity from pg_class where oid = format('public.%I', t)::regclass) then
      raise exception 'lead page: RLS off on %', t;
    end if;
    if has_table_privilege('anon', format('public.%I', t), 'INSERT') or has_table_privilege('authenticated', format('public.%I', t), 'INSERT')
       or has_table_privilege('anon', format('public.%I', t), 'UPDATE') or has_table_privilege('authenticated', format('public.%I', t), 'UPDATE')
       or has_column_privilege('anon', format('public.%I', t), 'lp_page', 'UPDATE') or has_column_privilege('authenticated', format('public.%I', t), 'lp_page', 'UPDATE') then
      raise exception 'lead page: a session role can write %', t;
    end if;
  end loop;
end $$;

insert into public.lp_inquiries (id, source, plan, company, contact_name, email, use_case, lp_page) values
 ('a9100000-0000-4000-8000-000000000001', 'form', 'intern', 'lead-page-fixture', 'f', 'lead@fixture.invalid', 'fixture', 'ai-employee-corp'),
 ('a9100000-0000-4000-8000-000000000002', 'form', 'intern', 'lead-page-fixture', 'f', 'lead@fixture.invalid', 'fixture', 'ai-employee'),
 ('a9100000-0000-4000-8000-000000000003', 'form', 'intern', 'lead-page-fixture', 'f', 'lead@fixture.invalid', 'fixture', null);
insert into public.lp_journeys (id, token_hash, expires_at, lp_page) values
 ('a9100000-0000-4000-8000-000000000011', 'lead-page-fixture-1', now() + interval '1 hour', 'ai-employee-corp'),
 ('a9100000-0000-4000-8000-000000000012', 'lead-page-fixture-2', now() + interval '1 hour', null);

do $$
declare
  bad text;
  t text;
begin
  foreach t in array array['lp_inquiries', 'lp_journeys'] loop
    foreach bad in array array['', 'AI-EMPLOYEE-CORP', ' ai-employee-corp', 'ai-employee-corp ', '/lp/ai-employee-corp', 'https://evil.example', 'lp-ai-employee', 'ai-employee-corp2'] loop
      begin
        if t = 'lp_inquiries' then
          update public.lp_inquiries set lp_page = bad where id = 'a9100000-0000-4000-8000-000000000003';
        else
          update public.lp_journeys set lp_page = bad where id = 'a9100000-0000-4000-8000-000000000012';
        end if;
        raise exception 'lead page: %.lp_page accepted %', t, quote_literal(bad);
      exception when check_violation then null;
      end;
    end loop;
  end loop;
end $$;

-- sessions see none of it
set role anon;
do $$ begin
  begin
    perform 1 from public.lp_inquiries where id::text like 'a9100000-%';
    if found then raise exception 'lead page: anon read lp_inquiries'; end if;
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

delete from public.lp_inquiries where id::text like 'a9100000-%';
delete from public.lp_journeys where id::text like 'a9100000-%';

-- lp_ref (?ref= on pattern B): nullable text, ^[A-Za-z0-9_-]{1,32}$ only.
do $$
declare
  t text;
  bad text;
begin
  foreach t in array array['lp_inquiries', 'lp_journeys'] loop
    if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = t and column_name = 'lp_ref' and data_type = 'text' and is_nullable = 'YES' and column_default is null) then
      raise exception 'lead page: %.lp_ref missing or not nullable text without default', t;
    end if;
  end loop;
  insert into public.lp_inquiries (id, source, plan, company, contact_name, email, use_case, lp_page, lp_ref)
    values ('a9100000-0000-4000-8000-000000000021', 'form', 'intern', 'lead-ref-fixture', 'f', 'lead@fixture.invalid', 'fixture', 'ai-employee-corp', 'partner_01');
  insert into public.lp_journeys (id, token_hash, expires_at, lp_page, lp_ref)
    values ('a9100000-0000-4000-8000-000000000022', 'lead-ref-fixture', now() + interval '1 hour', 'ai-employee-corp', repeat('x', 32));
  foreach bad in array array['', repeat('x', 33), 'a b', 'a.b', '<script>', 'a/b', '紹介', E'a\nb'] loop
    begin
      update public.lp_inquiries set lp_ref = bad where id = 'a9100000-0000-4000-8000-000000000021';
      raise exception 'lead page: lp_inquiries.lp_ref accepted %', quote_literal(bad);
    exception when check_violation then null;
    end;
    begin
      update public.lp_journeys set lp_ref = bad where id = 'a9100000-0000-4000-8000-000000000022';
      raise exception 'lead page: lp_journeys.lp_ref accepted %', quote_literal(bad);
    exception when check_violation then null;
    end;
  end loop;
  delete from public.lp_inquiries where id = 'a9100000-0000-4000-8000-000000000021';
  delete from public.lp_journeys where id = 'a9100000-0000-4000-8000-000000000022';
end $$;

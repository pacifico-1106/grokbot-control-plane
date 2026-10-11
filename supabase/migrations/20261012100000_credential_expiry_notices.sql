-- 社員証 pre-expiry notice (木村 2026-10-12). Used ONLY with
-- CREDENTIAL_EXPIRY_NOTICE_ENABLED (default OFF). Additive and re-applicable.
-- Apply BEFORE setting the flag; with the flag OFF nothing here is touched.
--
-- credential_expiry_notices: one row per credential × threshold (7d / 1d) =
-- "this notice was sent" (dedup claim). Ids + timestamps only: no text, no
-- names, no key material. The app inserts the row BEFORE sending (the primary
-- key makes a second claim fail → already sent) and deletes it again when the
-- send failed (retried on the next run). Per-org caps count rows per org over
-- the last 24h (index org_id, notified_at).
-- Tenant isolation: org_id / employee_id must be the credential's own
-- (trigger credential_expiry_notices_same_org, insert + update).
-- RLS on, no policy, service_role only.
begin;

create table if not exists public.credential_expiry_notices (
  credential_id uuid not null references public.credentials(id) on delete cascade,
  threshold text not null check (threshold in ('7d', '1d')),
  org_id uuid not null references public.orgs(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  expires_at timestamptz not null,
  notified_at timestamptz not null default now(),
  primary key (credential_id, threshold)
);
create index if not exists credential_expiry_notices_org_idx
  on public.credential_expiry_notices (org_id, notified_at);
alter table public.credential_expiry_notices enable row level security;
revoke all on table public.credential_expiry_notices from public, anon, authenticated;
grant select, insert, update, delete on table public.credential_expiry_notices to service_role;

create or replace function public.credential_expiry_notices_same_org()
returns trigger language plpgsql security invoker set search_path = pg_catalog, public as $cen$
begin
  if not exists (
    select 1 from public.credentials c
    where c.id = new.credential_id and c.org_id = new.org_id and c.employee_id = new.employee_id
  ) then
    raise exception 'credential_expiry_notice_cross_org';
  end if;
  return new;
end $cen$;
revoke all on function public.credential_expiry_notices_same_org() from public, anon, authenticated;
drop trigger if exists credential_expiry_notices_same_org on public.credential_expiry_notices;
create trigger credential_expiry_notices_same_org before insert or update of credential_id, org_id, employee_id
  on public.credential_expiry_notices for each row execute function public.credential_expiry_notices_same_org();

commit;

-- ROLLBACK (down) — turn CREDENTIAL_EXPIRY_NOTICE_ENABLED off first (drops the
-- dedup history: notices may be sent again once re-applied). Same statements as
-- supabase/verification/20261012100000_credential_expiry_notices_rollback.sql:
--   begin;
--   drop table if exists public.credential_expiry_notices;
--   drop function if exists public.credential_expiry_notices_same_org();
--   commit;
-- END ROLLBACK

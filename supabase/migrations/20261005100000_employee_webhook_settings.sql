-- D9 (八坂 GO 2026-10-05): per-config settings for the approval.resolved
-- callback (employee.callbackUrl) under WEBHOOK_HARDENING_ENABLED.
-- Design: PR "D9" / lib/webhooks/settings.ts. After 20261005000000 (#267).
--
-- NOT APPLIED BY THE PR. Additive only: one new server-only table and one
-- trigger function. No existing table, row, policy or grant is touched.
-- Apply BEFORE setting WEBHOOK_HARDENING_ENABLED=true (with the flag ON and
-- the table missing, the hardened callback fails closed: not sent,
-- category config_unavailable). With the flag OFF the application never reads
-- or writes this table. Re-runnable; one explicit transaction.
--
-- employee_webhook_settings — one row per employee (= per callbackUrl config):
--   callback_payload            'minimal' (default: ids + status) |
--                               'legacy_full' (opt-in compatibility body)
--   callback_secret_ciphertext  the minted whsec_ signing secret, ONLY as
--                               lib/notify/crypto.ts ciphertext v1.iv.tag.ct
--                               (AES-256-GCM, NOTIFICATION_CONFIG_ENCRYPTION_KEY)
--   callback_secret_fingerprint sha256 hex of the secret (both or neither)
-- Tenant isolation: the row's employee must belong to its org
-- (trigger → 'webhook_settings_cross_org'); deleting the employee or the org
-- deletes the row. RLS on, NO policy, anon / authenticated have no privilege;
-- only service_role (server code via createSupabaseAdminClient).

begin;

create table if not exists public.employee_webhook_settings (
  employee_id uuid primary key references public.employees(id) on delete cascade,
  org_id uuid not null references public.orgs(id) on delete cascade,
  callback_payload text not null default 'minimal'
    constraint employee_webhook_settings_payload_check check (callback_payload in ('minimal', 'legacy_full')),
  callback_secret_ciphertext text
    constraint employee_webhook_settings_ciphertext_check check (
      callback_secret_ciphertext is null or callback_secret_ciphertext ~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'),
  callback_secret_fingerprint text
    constraint employee_webhook_settings_fingerprint_check check (
      callback_secret_fingerprint is null or callback_secret_fingerprint ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint employee_webhook_settings_secret_pair_check check (
    (callback_secret_ciphertext is null) = (callback_secret_fingerprint is null))
);
create index if not exists employee_webhook_settings_org_idx on public.employee_webhook_settings (org_id);

create or replace function public.employee_webhook_settings_same_org()
returns trigger language plpgsql security invoker set search_path = pg_catalog, public as $whs$
begin
  if not exists (select 1 from public.employees e where e.id = new.employee_id and e.org_id = new.org_id) then
    raise exception 'webhook_settings_cross_org';
  end if;
  return new;
end $whs$;
revoke all on function public.employee_webhook_settings_same_org() from public, anon, authenticated;

drop trigger if exists employee_webhook_settings_same_org on public.employee_webhook_settings;
create trigger employee_webhook_settings_same_org before insert or update of org_id, employee_id
  on public.employee_webhook_settings for each row execute function public.employee_webhook_settings_same_org();

alter table public.employee_webhook_settings enable row level security;
revoke all on public.employee_webhook_settings from anon, authenticated;
grant select, insert, update, delete on public.employee_webhook_settings to service_role;

commit;

-- ROLLBACK (down) — removes everything this migration added (the table, its
-- index / trigger, the trigger function). Nothing else depends on them. Turn
-- WEBHOOK_HARDENING_ENABLED off first; minted callback secrets and payload
-- modes are discarded (receivers verifying signatures must be told, or keep
-- the flag off — with the flag off the callback is sent exactly as before).
-- Run as one transaction:
--   begin;
--   drop table if exists public.employee_webhook_settings;
--   drop function if exists public.employee_webhook_settings_same_org();
--   commit;
-- END ROLLBACK

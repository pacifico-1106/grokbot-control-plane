-- MCP Events: subscriptions + delivery outbox for approval.decided /
-- approval.expired webhooks (2026-10-05, design:
-- docs/mcp-events-approval-wake-20261005.md). After 20261004800000 (main);
-- 20261004900000 is taken by #265.
--
-- NOT APPLIED BY THE PR. Additive only: two new server-only tables, one
-- trigger function. No existing table, row, policy or grant is touched.
-- Apply BEFORE setting MCP_EVENTS_ENABLED=true; with the flag OFF the
-- application never reads or writes these tables. Re-runnable
-- (create … if not exists / create or replace / drop trigger if exists).
-- One explicit transaction: a failing statement leaves nothing behind.
--
-- mcp_event_subscriptions — one row per subscription key
--   (principal, delivery_url, event_name, canonical arguments) → id sub_<32 hex>.
--   Holds the receiver's signing secret ONLY as AES-256-GCM ciphertext
--   (lib/notify/crypto.ts v1.iv.tag.ct, NOTIFICATION_CONFIG_ENCRYPTION_KEY —
--   the same scheme as the existing wake-webhook / adapter secrets) plus a
--   sha256 fingerprint; never plaintext (check below). last_error is one of
--   the fixed MCP categories only (never raw receiver responses).
-- mcp_event_deliveries — outbox, one row per (subscription, event):
--   unique (subscription_id, event_id) makes re-emit / concurrent emit a
--   no-op, and every retry re-sends the same body + webhook-id (= event_id).
--   body ≤ 256 KiB and carries ids + status only (application invariant).
-- Tenant isolation in the schema: a subscription's employee must belong to
-- its org, and a delivery's org / employee must equal its subscription's
-- (trigger mcp_events_same_org → 'mcp_events_cross_org').
-- RLS on, NO policy, anon / authenticated have no privilege at all; only
-- service_role (BYPASSRLS, server code via createSupabaseAdminClient) uses them.

begin;

create table if not exists public.mcp_event_subscriptions (
  id text primary key constraint mcp_event_subscriptions_id_check check (id ~ '^sub_[0-9a-f]{32}$'),
  org_id uuid not null references public.orgs(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  credential_id uuid,
  credential_generation integer not null,
  credential_fingerprint text not null check (credential_fingerprint ~ '^[0-9a-f]{64}$'),
  principal text not null check (length(principal) between 1 and 300),
  event_name text not null constraint mcp_event_subscriptions_event_name_check
    check (event_name in ('approval.decided', 'approval.expired')),
  arguments jsonb not null default '{}'::jsonb check (jsonb_typeof(arguments) = 'object' and length(arguments::text) <= 4096),
  delivery_url text not null constraint mcp_event_subscriptions_delivery_url_check
    check (delivery_url ~ '^https://' and length(delivery_url) <= 2048),
  delivery_host text not null check (length(delivery_host) between 1 and 253),
  secret_ciphertext text not null constraint mcp_event_subscriptions_secret_ciphertext_check
    check (secret_ciphertext ~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'),
  secret_fingerprint text not null check (secret_fingerprint ~ '^[0-9a-f]{64}$'),
  previous_secret_ciphertext text check (previous_secret_ciphertext is null
    or previous_secret_ciphertext ~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'),
  previous_secret_valid_until timestamptz,
  status text not null default 'active' constraint mcp_event_subscriptions_status_check
    check (status in ('active', 'unsubscribed', 'revoked', 'expired')),
  risk text not null check (risk in ('standard', 'elevated')),
  risk_reasons text[] not null default '{}',
  granted_ttl_ms bigint not null check (granted_ttl_ms > 0),
  refresh_before timestamptz not null,
  verified_at timestamptz,
  last_delivery_at timestamptz,
  last_error text constraint mcp_event_subscriptions_last_error_check check (last_error is null or last_error in
    ('connection_refused', 'timeout', 'tls_error', 'http_4xx', 'http_5xx', 'challenge_failed')),
  failed_since timestamptz,
  revoked_reason text check (revoked_reason is null or length(revoked_reason) <= 64),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists mcp_event_subscriptions_match_idx
  on public.mcp_event_subscriptions (org_id, employee_id, event_name) where status = 'active';
create index if not exists mcp_event_subscriptions_principal_url_idx
  on public.mcp_event_subscriptions (principal, delivery_url);

create table if not exists public.mcp_event_deliveries (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  employee_id uuid not null,
  subscription_id text not null references public.mcp_event_subscriptions(id) on delete cascade,
  event_id text not null constraint mcp_event_deliveries_event_id_check check (event_id ~ '^evt_[0-9a-f]{32}$'),
  event_name text not null check (event_name in ('approval.decided', 'approval.expired')),
  approval_id text not null check (length(approval_id) between 1 and 128),
  body text not null constraint mcp_event_deliveries_body_check check (octet_length(body) <= 262144),
  status text not null default 'pending' check (status in ('pending', 'delivered', 'abandoned', 'dropped')),
  attempts integer not null default 0 check (attempts between 0 and 10),
  next_attempt_at timestamptz,
  lease_until timestamptz,
  last_status integer,
  last_error text check (last_error is null or length(last_error) <= 64),
  delivered_at timestamptz,
  attributed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint mcp_event_deliveries_subscription_event_key unique (subscription_id, event_id)
);
create index if not exists mcp_event_deliveries_due_idx
  on public.mcp_event_deliveries (next_attempt_at) where status = 'pending';
create index if not exists mcp_event_deliveries_attribution_idx
  on public.mcp_event_deliveries (org_id, employee_id, delivered_at desc) where status = 'delivered' and attributed_at is null;

create or replace function public.mcp_events_same_org()
returns trigger language plpgsql security invoker set search_path = pg_catalog, public as $mcpev$
begin
  if tg_table_name = 'mcp_event_subscriptions' then
    if not exists (select 1 from public.employees e where e.id = new.employee_id and e.org_id = new.org_id) then
      raise exception 'mcp_events_cross_org';
    end if;
  else
    if not exists (select 1 from public.mcp_event_subscriptions s
                   where s.id = new.subscription_id and s.org_id = new.org_id and s.employee_id = new.employee_id) then
      raise exception 'mcp_events_cross_org';
    end if;
  end if;
  return new;
end $mcpev$;
revoke all on function public.mcp_events_same_org() from public, anon, authenticated;

drop trigger if exists mcp_event_subscriptions_same_org on public.mcp_event_subscriptions;
create trigger mcp_event_subscriptions_same_org before insert or update of org_id, employee_id
  on public.mcp_event_subscriptions for each row execute function public.mcp_events_same_org();
drop trigger if exists mcp_event_deliveries_same_org on public.mcp_event_deliveries;
create trigger mcp_event_deliveries_same_org before insert or update of org_id, employee_id, subscription_id
  on public.mcp_event_deliveries for each row execute function public.mcp_events_same_org();

alter table public.mcp_event_subscriptions enable row level security;
alter table public.mcp_event_deliveries enable row level security;
revoke all on public.mcp_event_subscriptions, public.mcp_event_deliveries from anon, authenticated;
grant select, insert, update, delete on public.mcp_event_subscriptions, public.mcp_event_deliveries to service_role;

commit;

-- ROLLBACK (down) — removes everything this migration added (the two tables,
-- their indexes / triggers, the trigger function). Nothing else depends on
-- them. Turn MCP_EVENTS_ENABLED off first; pending deliveries and
-- subscriptions are discarded (receivers simply stop getting events; the
-- existing wake paths are unchanged). Run as one transaction:
--   begin;
--   drop table if exists public.mcp_event_deliveries;
--   drop table if exists public.mcp_event_subscriptions;
--   drop function if exists public.mcp_events_same_org();
--   commit;
-- END ROLLBACK

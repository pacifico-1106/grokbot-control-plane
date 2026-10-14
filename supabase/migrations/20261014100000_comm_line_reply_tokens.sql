-- L-6: LINE replyToken + unknown-outcome ledger (design §2-6 / §5 送れたかどうか).
-- Additive. Flag LINE_CONVERSATION_ENABLED (default OFF): with it OFF no code
-- path writes these tables. Apply BEFORE turning the flag ON.
--
-- 1. comm_line_reply_tokens   : a replyToken is used at most once (hash only)
-- 2. comm_line_send_unknown   : a Reply/Push whose result is unclear; never
--                               auto-retried (a retry would double-deliver via Push)
--
-- No message body. RLS on, restrictive deny-all, no grants to anon/authenticated.
begin;
set local lock_timeout = '5s';

create table if not exists public.comm_line_reply_tokens (
  token_hash text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  org_id uuid not null references public.orgs(id) on delete cascade,
  account_id uuid not null,
  outcome text not null default 'used' check (outcome in ('used')),
  used_at timestamptz not null default now(),
  foreign key (account_id, org_id) references public.employee_comm_accounts(id, org_id) on delete cascade
);

create table if not exists public.comm_line_send_unknown (
  org_id uuid not null references public.orgs(id) on delete cascade,
  retry_key text not null check (length(retry_key) between 1 and 128),
  account_id uuid,
  recorded_at timestamptz not null default now(),
  primary key (org_id, retry_key)
);

alter table public.comm_line_reply_tokens enable row level security;
alter table public.comm_line_send_unknown enable row level security;

drop policy if exists comm_line_reply_tokens_deny_all on public.comm_line_reply_tokens;
create policy comm_line_reply_tokens_deny_all on public.comm_line_reply_tokens as restrictive for all using (false) with check (false);
drop policy if exists comm_line_send_unknown_deny_all on public.comm_line_send_unknown;
create policy comm_line_send_unknown_deny_all on public.comm_line_send_unknown as restrictive for all using (false) with check (false);

revoke all on public.comm_line_reply_tokens from public, anon, authenticated;
revoke all on public.comm_line_send_unknown from public, anon, authenticated;
grant select, insert, update, delete on public.comm_line_reply_tokens to service_role;
grant select, insert, update, delete on public.comm_line_send_unknown to service_role;
commit;

-- ROLLBACK (down) — refuse while unknown-outcome rows exist (a retry would
-- double-deliver via Push). Standalone:
-- supabase/verification/20261014100000_comm_line_reply_tokens_rollback.sql
--   drop table if exists public.comm_line_send_unknown;
--   drop table if exists public.comm_line_reply_tokens;
-- END ROLLBACK

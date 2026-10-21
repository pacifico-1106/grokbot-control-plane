-- Conversation link codes (L-7 / review M1).
-- line_approver_link_codes.channel_id FKs to org_notification_channels.
-- Conversation codes bind a comm account, so they live in their own table
-- with account_id → employee_comm_accounts. Flags default OFF; apply before
-- turning COMM_ACCOUNTS_ENABLED / LINE_CONVERSATION_ENABLED on.
begin;
set local lock_timeout = '5s';

create table if not exists public.line_conversation_link_codes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  account_id uuid not null,
  member_id uuid not null,
  issued_by_user_id uuid,
  code_hash text not null check (length(code_hash) = 64),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  line_user_id text check (line_user_id is null or length(line_user_id) between 1 and 64),
  invalidated_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (account_id, org_id) references public.employee_comm_accounts(id, org_id) on delete cascade,
  foreign key (member_id, org_id) references public.org_members(id, org_id) on delete cascade
);

create unique index if not exists line_conversation_link_codes_hash_idx
  on public.line_conversation_link_codes(code_hash);
create index if not exists line_conversation_link_codes_account_idx
  on public.line_conversation_link_codes(org_id, account_id, member_id, created_at desc);

alter table public.line_conversation_link_codes enable row level security;
revoke all on public.line_conversation_link_codes from public, anon, authenticated;
grant select, insert, update, delete on public.line_conversation_link_codes to service_role;
drop policy if exists line_conversation_link_codes_server_only on public.line_conversation_link_codes;
create policy line_conversation_link_codes_server_only on public.line_conversation_link_codes
  as restrictive for all to public using (false) with check (false);

comment on table public.line_conversation_link_codes is
  'Single-use 15-minute LINE conversation link codes (HMAC only). Server-only. Flags COMM_ACCOUNTS_ENABLED / LINE_CONVERSATION_ENABLED.';

commit;

-- ROLLBACK (down) — refuse while an unused code exists.
-- supabase/verification/20261021100000_line_conversation_link_codes_rollback.sql
--   begin;
--   set local lock_timeout = '5s';
--   do $rb$ begin
--     if to_regclass('public.line_conversation_link_codes') is not null
--        and exists (
--          select 1 from public.line_conversation_link_codes
--          where consumed_at is null and invalidated_at is null
--        ) then
--       raise exception 'ROLLBACK_REFUSED: unused line_conversation_link_codes exist; consume or invalidate them first';
--     end if;
--   end $rb$;
--   drop table if exists public.line_conversation_link_codes;
--   commit;
-- END ROLLBACK

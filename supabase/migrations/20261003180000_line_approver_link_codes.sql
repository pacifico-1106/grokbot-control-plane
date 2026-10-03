-- LINE approver link codes (連携コード) — LINE approval gaps G1 + G4.
-- Feature flag: LINE_APPROVER_LINK_ENABLED (default OFF). With the flag OFF no
-- code path reads or writes this table, so deploying the code before this
-- migration is safe; apply this migration BEFORE turning the flag ON.
--
-- Stores only a keyed HMAC of each code (VOTER_BINDING_SECRET). The plaintext
-- code is shown once to the issuing member (self-link) and never persisted.
-- Server-only table: RLS on, restrictive deny-all policy, no client grants.
begin;
set local lock_timeout = '5s';

create table if not exists public.line_approver_link_codes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  channel_id uuid not null references public.org_notification_channels(id) on delete cascade,
  member_id uuid not null,
  issued_by_user_id uuid,
  code_hash text not null check (length(code_hash) = 64),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  line_user_id text check (line_user_id is null or length(line_user_id) between 1 and 64),
  invalidated_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (member_id, org_id) references public.org_members(id, org_id) on delete cascade
);

create unique index if not exists line_approver_link_codes_hash_idx
  on public.line_approver_link_codes(code_hash);
create index if not exists line_approver_link_codes_member_idx
  on public.line_approver_link_codes(org_id, channel_id, member_id, created_at desc);

alter table public.line_approver_link_codes enable row level security;
revoke all on public.line_approver_link_codes from public, anon, authenticated;
grant select, insert, update, delete on public.line_approver_link_codes to service_role;
drop policy if exists line_link_codes_server_only on public.line_approver_link_codes;
create policy line_link_codes_server_only on public.line_approver_link_codes
  as restrictive for all to public using (false) with check (false);

comment on table public.line_approver_link_codes is
  'Single-use 15-minute LINE approver link codes (HMAC only). Server-only. Flag LINE_APPROVER_LINK_ENABLED.';

commit;

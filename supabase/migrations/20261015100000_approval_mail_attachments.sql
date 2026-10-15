-- mail.send approved attachment bytes (2026-10-15).
-- Additive. Do NOT apply from this PR automatically; keep idempotent.
-- Stores sealed ciphertext + content SHA-256 only (no plaintext, no Base64
-- of the original). Used so fulfill sends exactly the approved bytes.
--
-- approval_requests.metadata.invoke.mailAttachments still holds display
-- fields + ciphertext for demo / when this table is absent. Production
-- should prefer this table (tenant-isolated, RLS deny-all, service_role).
--
-- Retention: rows cascade with the approval. No SELECT for anon/authenticated.
begin;
set local lock_timeout = '5s';

create table if not exists public.approval_mail_attachments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  approval_id uuid not null references public.approval_requests(id) on delete cascade,
  ordinal smallint not null check (ordinal between 0 and 2),
  filename text not null check (char_length(filename) between 1 and 200),
  mime_type text not null check (char_length(mime_type) between 1 and 127),
  byte_length integer not null check (byte_length > 0 and byte_length <= 10485760),
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  content_ciphertext text not null check (content_ciphertext like 'b1.%'),
  created_at timestamptz not null default now(),
  unique (approval_id, ordinal),
  unique (approval_id, content_sha256, ordinal)
);

create index if not exists approval_mail_attachments_org_approval_idx
  on public.approval_mail_attachments (org_id, approval_id);

alter table public.approval_mail_attachments enable row level security;

drop policy if exists approval_mail_attachments_deny_all on public.approval_mail_attachments;
create policy approval_mail_attachments_deny_all
  on public.approval_mail_attachments
  as restrictive for all
  using (false) with check (false);

revoke all on public.approval_mail_attachments from public, anon, authenticated;
grant select, insert, update, delete on public.approval_mail_attachments to service_role;

comment on table public.approval_mail_attachments is
  'Sealed mail.send attachment bytes for an approved ticket. Ciphertext + sha256 only; never log contents.';

commit;

-- ROLLBACK (down) — standalone, only when no live send depends on the rows:
--   drop table if exists public.approval_mail_attachments;
-- END ROLLBACK

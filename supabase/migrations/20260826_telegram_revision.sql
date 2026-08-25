-- Telegram approval channel + revision/resubmission loop.
-- Safe to re-run on an existing Staffpass database.

alter table approval_requests drop constraint if exists approval_requests_status_check;
alter table approval_requests add constraint approval_requests_status_check
  check (status in ('pending', 'approved', 'rejected', 'expired', 'revision_requested'));

alter table approval_requests
  add column if not exists revision_note text,
  add column if not exists revision_count integer not null default 0,
  add column if not exists telegram_message_id bigint,
  add column if not exists telegram_ref text,
  add column if not exists parent_approval_id uuid references approval_requests(id) on delete set null;

alter table approval_requests
  alter column telegram_ref set default encode(gen_random_bytes(6), 'hex');

update approval_requests
set telegram_ref = encode(gen_random_bytes(6), 'hex')
where telegram_ref is null;

alter table approval_requests alter column telegram_ref set not null;

create unique index if not exists approval_requests_telegram_ref_idx
  on approval_requests (telegram_ref);
create index if not exists approval_requests_telegram_msg_idx
  on approval_requests (telegram_message_id);
create index if not exists approval_requests_job_idx
  on approval_requests (org_id, job_id);

comment on column approval_requests.telegram_ref is
  'Random callback reference; never expose a shortened approval UUID in Telegram callback_data.';
comment on column approval_requests.parent_approval_id is
  'Prior revision_requested approval for a corrected resubmission.';

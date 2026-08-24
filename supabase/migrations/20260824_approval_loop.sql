-- Approval loop: rich ticket fields + employee notify/callback/routine
-- Safe to re-run (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS style via DO blocks).

alter table approval_requests
  add column if not exists title text,
  add column if not exists tool text,
  add column if not exists job_id text,
  add column if not exists status_token text,
  add column if not exists poll_path text;

create index if not exists approval_requests_status_token_idx
  on approval_requests (id, status_token);

alter table employees
  add column if not exists approval_notify_email text,
  add column if not exists callback_url text,
  add column if not exists approval_routine_text text;

comment on column approval_requests.status_token is
  'Opaque token for signed status poll URL (Bot return pipe until Partner webhook).';
comment on column employees.approval_notify_email is
  'Optional machine-readable notify target (future AgentMail).';
comment on column employees.callback_url is
  'Optional webhook; best-effort POST on approve/reject.';

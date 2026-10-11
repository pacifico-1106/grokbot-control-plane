-- 運営からのお知らせ (Operator Notices) PR-A: data model
-- (design /workspace/p0/operator-notices-design-20261012.md §2). After
-- 20261012500000 (main).
--
-- NOT APPLIED BY THE PR. Additive only: six new server-only tables, the
-- visibility functions and three trigger functions. No existing table, row,
-- policy or grant is touched. With OPERATOR_NOTICES_ENABLED OFF (default) the
-- application never reads or writes these tables. Re-runnable
-- (create … if not exists / create or replace / drop trigger if exists).
-- One explicit transaction.
--
-- operator_notices           the notice (current version). Written only by the
--                            operator (super admin / platform-ops gates; app code).
-- operator_notice_versions   append-only version history (no update / delete).
-- operator_notice_targets    audience rows for scope 'orgs' / 'employees' only.
--                            Trigger: employee must belong to org; no change
--                            once the notice has left 'draft'.
-- operator_notice_receipts   per-employee delivered / read / applied state.
--                            Trigger: (org, employee) must be a real pair AND
--                            the notice must be visible to that org/employee.
-- ops_feedback_items         AI → operator requests / bugs / weekly digest (§7).
-- ops_feedback_events        append-only item history (no update / delete).
--
-- Visibility is ONE SQL function (operator_notice_visible); the list and the
-- count use it, never an application-side filter. org / employee always come
-- from the caller's credential, never from tool arguments.
-- RLS on, NO policy, anon / authenticated have no privilege (tables and
-- functions); only service_role uses them.

begin;

create table if not exists public.operator_notices (
  id text primary key constraint operator_notices_id_check check (id ~ '^ntc_[0-9A-HJKMNP-TV-Z]{26}$'),
  seq bigint generated always as identity unique,
  version integer not null default 1 check (version between 1 and 1000),
  -- the newest version whose kind is initial / correction: a receipt acked
  -- below this is unread again (a 'minor' version does not raise it)
  ack_required_version integer not null default 1 check (ack_required_version between 1 and version),
  status text not null default 'draft' check (status in ('draft', 'published', 'withdrawn')),
  severity text not null default 'normal' check (severity in ('info', 'normal', 'important', 'urgent')),
  title text not null check (length(title) between 1 and 120),
  change_summary text not null default '' check (length(change_summary) <= 4000),
  ai_usage_change text not null default '' check (length(ai_usage_change) <= 4000),
  effective_at timestamptz not null default now(),
  expires_at timestamptz,
  audience_scope text not null default 'all' check (audience_scope in ('all', 'orgs', 'employees')),
  sticky boolean not null default false,
  related_flags text[] not null default '{}' check (cardinality(related_flags) <= 10),
  apply_mode text not null default 'self_rules' check (apply_mode in ('none', 'self_rules', 'instructions_via_approval')),
  show_to_tenant_admin boolean not null default true,
  relates_to_item_ids text[] not null default '{}' check (cardinality(relates_to_item_ids) <= 20),
  body_hash text not null check (body_hash ~ '^[0-9a-f]{64}$'),
  created_by_user_id text not null check (length(created_by_user_id) between 1 and 128),
  created_by_email text check (created_by_email is null or length(created_by_email) <= 320),
  published_by_user_id text check (published_by_user_id is null or length(published_by_user_id) <= 128),
  published_by_email text check (published_by_email is null or length(published_by_email) <= 320),
  created_at timestamptz not null default now(),
  published_at timestamptz,
  withdrawn_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint operator_notices_body_total_check check (length(change_summary) + length(ai_usage_change) <= 8000),
  constraint operator_notices_expiry_check check (expires_at is null or expires_at > effective_at),
  constraint operator_notices_published_check check (
    (status = 'draft' and published_at is null)
    or (status in ('published', 'withdrawn') and published_at is not null and published_by_user_id is not null)),
  constraint operator_notices_withdrawn_check check ((status = 'withdrawn') = (withdrawn_at is not null))
);
create index if not exists operator_notices_published_idx
  on public.operator_notices (published_at desc) where status = 'published';

create table if not exists public.operator_notice_versions (
  notice_id text not null references public.operator_notices(id) on delete cascade,
  version integer not null check (version between 1 and 1000),
  kind text not null check (kind in ('initial', 'correction', 'minor')),
  change_note text not null default '' check (length(change_note) <= 500),
  title text not null check (length(title) between 1 and 120),
  change_summary text not null check (length(change_summary) <= 4000),
  ai_usage_change text not null check (length(ai_usage_change) <= 4000),
  apply_mode text not null check (apply_mode in ('none', 'self_rules', 'instructions_via_approval')),
  body_hash text not null check (body_hash ~ '^[0-9a-f]{64}$'),
  created_by_user_id text not null check (length(created_by_user_id) between 1 and 128),
  created_at timestamptz not null default now(),
  primary key (notice_id, version)
);

create table if not exists public.operator_notice_targets (
  id bigint generated always as identity primary key,
  notice_id text not null references public.operator_notices(id) on delete cascade,
  org_id uuid not null references public.orgs(id) on delete cascade,
  employee_id uuid references public.employees(id) on delete cascade
);
create unique index if not exists operator_notice_targets_key
  on public.operator_notice_targets (notice_id, org_id, coalesce(employee_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index if not exists operator_notice_targets_org_idx on public.operator_notice_targets (org_id, notice_id);

create table if not exists public.operator_notice_receipts (
  notice_id text not null references public.operator_notices(id) on delete cascade,
  org_id uuid not null references public.orgs(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  first_listed_at timestamptz not null default now(),
  read_at timestamptz,
  read_version integer,
  state text not null default 'delivered' check (state in
    ('delivered', 'read', 'applied', 'not_applicable', 'needs_tenant_approval', 'declined')),
  acked_version integer check (acked_version is null or acked_version between 1 and 1000),
  acked_at timestamptz,
  apply_evidence text check (apply_evidence is null or apply_evidence in ('self_reported', 'config_change_applied')),
  config_change_approval_id text check (config_change_approval_id is null or length(config_change_approval_id) <= 128),
  note text check (note is null or length(note) <= 500),
  wake_state text not null default 'none' check (wake_state in ('none', 'pending', 'delivered', 'failed')),
  updated_at timestamptz not null default now(),
  primary key (notice_id, employee_id)
);
create index if not exists operator_notice_receipts_org_idx on public.operator_notice_receipts (org_id, employee_id);

create table if not exists public.ops_feedback_items (
  id text primary key constraint ops_feedback_items_id_check check (id ~ '^fb_[0-9A-HJKMNP-TV-Z]{26}$'),
  org_id uuid not null references public.orgs(id) on delete cascade,
  employee_id uuid references public.employees(id) on delete set null,
  kind text not null check (kind in ('request', 'bug', 'question', 'weekly_digest')),
  source text not null check (source in ('ai_employee', 'system_weekly', 'operator')),
  title text not null check (length(title) between 1 and 120),
  body text not null default '' check (length(body) <= 2000),
  metrics jsonb check (metrics is null or (jsonb_typeof(metrics) = 'object' and length(metrics::text) <= 4096)),
  status text not null default 'open' check (status in ('open', 'triaged', 'in_progress', 'shipped', 'wontfix', 'duplicate')),
  job_id text check (job_id is null or length(job_id) between 1 and 128),
  related_notice_ids text[] not null default '{}' check (cardinality(related_notice_ids) <= 20),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- a weekly digest carries counts only (no free text)
  constraint ops_feedback_items_digest_check check (kind <> 'weekly_digest' or (body = '' and source = 'system_weekly'))
);
create unique index if not exists ops_feedback_items_job_key
  on public.ops_feedback_items (org_id, coalesce(employee_id, '00000000-0000-0000-0000-000000000000'::uuid), job_id)
  where job_id is not null;
create index if not exists ops_feedback_items_org_idx on public.ops_feedback_items (org_id, created_at desc);

create table if not exists public.ops_feedback_events (
  id bigint generated always as identity primary key,
  item_id text not null references public.ops_feedback_items(id) on delete cascade,
  org_id uuid not null references public.orgs(id) on delete cascade,
  actor_kind text not null check (actor_kind in ('ai_employee', 'operator', 'system')),
  status_to text check (status_to is null or status_to in ('open', 'triaged', 'in_progress', 'shipped', 'wontfix', 'duplicate')),
  body text not null default '' check (length(body) <= 2000),
  notice_id text references public.operator_notices(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists ops_feedback_events_item_idx on public.ops_feedback_events (item_id, id);

-- ---------------------------------------------------------------------------
-- Visibility: the one definition (design §2.6). A notice is visible to
-- (org, employee) when it is published, not expired, and either
--   scope 'all' and (sticky or published after the org was created), or
--   a target row for that org with employee_id null or = the employee.
create or replace function public.operator_notice_visible(p_notice text, p_org uuid, p_employee uuid, p_now timestamptz default now())
returns boolean language sql stable security invoker set search_path = pg_catalog, public as $onv$
  select exists (
    select 1 from public.operator_notices n
     where n.id = p_notice
       and n.status = 'published'
       and (n.expires_at is null or n.expires_at > p_now)
       and exists (select 1 from public.employees e where e.id = p_employee and e.org_id = p_org)
       and (
         (n.audience_scope = 'all'
            and (n.sticky or n.published_at >= (select o.created_at from public.orgs o where o.id = p_org)))
         or (n.audience_scope in ('orgs', 'employees')
            and exists (select 1 from public.operator_notice_targets t
                         where t.notice_id = n.id and t.org_id = p_org
                           and (t.employee_id is null or t.employee_id = p_employee)))
       ));
$onv$;

create or replace function public.list_visible_operator_notices(p_org uuid, p_employee uuid, p_now timestamptz default now())
returns setof public.operator_notices language sql stable security invoker set search_path = pg_catalog, public as $lvn$
  select n.* from public.operator_notices n
   where n.status = 'published'
     and public.operator_notice_visible(n.id, p_org, p_employee, p_now)
   order by n.published_at desc, n.seq desc
   limit 200;
$lvn$;

-- ---------------------------------------------------------------------------
-- Targets: employee must belong to org; scope must take targets of that shape;
-- no change once the notice has left 'draft' (no later cross-tenant widening).
create or replace function public.operator_notice_targets_guard()
returns trigger language plpgsql security invoker set search_path = pg_catalog, public as $ontg$
declare v_scope text; v_status text; v_notice text;
begin
  -- a cascade from deleting the notice / org / employee itself is allowed
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then return old; end if;
  v_notice := case when tg_op = 'DELETE' then old.notice_id else new.notice_id end;
  select n.audience_scope, n.status into v_scope, v_status from public.operator_notices n where n.id = v_notice;
  if v_status is distinct from 'draft' then
    raise exception 'operator_notice_targets_locked';
  end if;
  if tg_op = 'UPDATE' and (new.notice_id <> old.notice_id) then
    raise exception 'operator_notice_targets_locked';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  if v_scope = 'all' then raise exception 'operator_notice_scope_mismatch'; end if;
  if v_scope = 'orgs' and new.employee_id is not null then raise exception 'operator_notice_scope_mismatch'; end if;
  if v_scope = 'employees' and new.employee_id is null then raise exception 'operator_notice_scope_mismatch'; end if;
  if new.employee_id is not null
     and not exists (select 1 from public.employees e where e.id = new.employee_id and e.org_id = new.org_id) then
    raise exception 'operator_notice_cross_org';
  end if;
  return new;
end $ontg$;
drop trigger if exists operator_notices_target_same_org on public.operator_notice_targets;
create trigger operator_notices_target_same_org before insert or update or delete on public.operator_notice_targets
  for each row execute function public.operator_notice_targets_guard();

-- Notices: once published, the audience can't change; a withdrawn notice
-- can't be republished; scope 'all' can't hold targets.
create or replace function public.operator_notices_guard()
returns trigger language plpgsql security invoker set search_path = pg_catalog, public as $ong$
begin
  if tg_op = 'UPDATE' then
    if old.status <> 'draft' and (new.audience_scope <> old.audience_scope or new.sticky <> old.sticky) then
      raise exception 'operator_notice_audience_locked';
    end if;
    if old.status = 'withdrawn' and new.status <> 'withdrawn' then
      raise exception 'operator_notice_withdrawn';
    end if;
    if old.status <> 'draft' and new.status = 'draft' then
      raise exception 'operator_notice_status_backwards';
    end if;
    if new.version < old.version or new.ack_required_version < old.ack_required_version then
      raise exception 'operator_notice_version_backwards';
    end if;
  end if;
  if new.audience_scope = 'all' and tg_op = 'UPDATE'
     and exists (select 1 from public.operator_notice_targets t where t.notice_id = new.id) then
    raise exception 'operator_notice_scope_mismatch';
  end if;
  if new.status = 'published' and new.audience_scope in ('orgs', 'employees')
     and not exists (select 1 from public.operator_notice_targets t where t.notice_id = new.id) then
    raise exception 'operator_notice_no_targets';
  end if;
  return new;
end $ong$;
drop trigger if exists operator_notices_guard on public.operator_notices;
create trigger operator_notices_guard before insert or update on public.operator_notices
  for each row execute function public.operator_notices_guard();

-- Receipts: a real (org, employee) pair AND the notice visible to it. Even a
-- buggy server can't create another tenant's receipt.
create or replace function public.operator_notice_receipts_guard()
returns trigger language plpgsql security invoker set search_path = pg_catalog, public as $onrg$
begin
  if tg_op = 'UPDATE' and (new.notice_id <> old.notice_id or new.org_id <> old.org_id or new.employee_id <> old.employee_id) then
    raise exception 'operator_notice_receipt_immutable_key';
  end if;
  if not exists (select 1 from public.employees e where e.id = new.employee_id and e.org_id = new.org_id) then
    raise exception 'operator_notice_cross_org';
  end if;
  if not public.operator_notice_visible(new.notice_id, new.org_id, new.employee_id) then
    raise exception 'operator_notice_not_visible';
  end if;
  return new;
end $onrg$;
drop trigger if exists operator_notice_receipt_visible on public.operator_notice_receipts;
create trigger operator_notice_receipt_visible before insert or update on public.operator_notice_receipts
  for each row execute function public.operator_notice_receipts_guard();

-- Feedback events: org must equal the item's org.
create or replace function public.ops_feedback_events_guard()
returns trigger language plpgsql security invoker set search_path = pg_catalog, public as $ofeg$
begin
  if not exists (select 1 from public.ops_feedback_items i where i.id = new.item_id and i.org_id = new.org_id) then
    raise exception 'ops_feedback_cross_org';
  end if;
  return new;
end $ofeg$;
drop trigger if exists ops_feedback_events_same_org on public.ops_feedback_events;
create trigger ops_feedback_events_same_org before insert on public.ops_feedback_events
  for each row execute function public.ops_feedback_events_guard();

-- Append-only history tables.
create or replace function public.operator_notices_append_only()
returns trigger language plpgsql security invoker set search_path = pg_catalog, public as $onao$
begin
  raise exception 'operator_notice_history_append_only';
end $onao$;
drop trigger if exists operator_notice_versions_append_only on public.operator_notice_versions;
create trigger operator_notice_versions_append_only before update on public.operator_notice_versions
  for each row execute function public.operator_notices_append_only();
drop trigger if exists ops_feedback_events_append_only on public.ops_feedback_events;
create trigger ops_feedback_events_append_only before update on public.ops_feedback_events
  for each row execute function public.operator_notices_append_only();
-- (row DELETE is left to ON DELETE CASCADE from the parent; direct deletes are
-- refused below via the statement-level guard, which cascades bypass.)
create or replace function public.operator_notices_no_direct_delete()
returns trigger language plpgsql security invoker set search_path = pg_catalog, public as $onnd$
begin
  if pg_trigger_depth() = 1 then raise exception 'operator_notice_history_append_only'; end if;
  return old;
end $onnd$;
drop trigger if exists operator_notice_versions_no_delete on public.operator_notice_versions;
create trigger operator_notice_versions_no_delete before delete on public.operator_notice_versions
  for each row execute function public.operator_notices_no_direct_delete();
drop trigger if exists ops_feedback_events_no_delete on public.ops_feedback_events;
create trigger ops_feedback_events_no_delete before delete on public.ops_feedback_events
  for each row execute function public.operator_notices_no_direct_delete();

-- ---------------------------------------------------------------------------
-- RLS on, no policy; server only.
alter table public.operator_notices enable row level security;
alter table public.operator_notice_versions enable row level security;
alter table public.operator_notice_targets enable row level security;
alter table public.operator_notice_receipts enable row level security;
alter table public.ops_feedback_items enable row level security;
alter table public.ops_feedback_events enable row level security;
revoke all on public.operator_notices, public.operator_notice_versions, public.operator_notice_targets,
  public.operator_notice_receipts, public.ops_feedback_items, public.ops_feedback_events from anon, authenticated;
grant select, insert, update, delete on public.operator_notices, public.operator_notice_versions, public.operator_notice_targets,
  public.operator_notice_receipts, public.ops_feedback_items, public.ops_feedback_events to service_role;
revoke all on function public.operator_notice_visible(text, uuid, uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.list_visible_operator_notices(uuid, uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.operator_notice_visible(text, uuid, uuid, timestamptz) to service_role;
grant execute on function public.list_visible_operator_notices(uuid, uuid, timestamptz) to service_role;
revoke all on function public.operator_notice_targets_guard(), public.operator_notices_guard(),
  public.operator_notice_receipts_guard(), public.ops_feedback_events_guard(),
  public.operator_notices_append_only(), public.operator_notices_no_direct_delete() from public, anon, authenticated;

commit;

-- ROLLBACK (down) — set OPERATOR_NOTICES_ENABLED / OPS_FEEDBACK_ENABLED off
-- first. Drops every notice, receipt and feedback item (export first if
-- needed). Same statements as
-- supabase/verification/20261013100000_operator_notices_rollback.sql:
--   begin;
--   drop table if exists public.operator_notice_receipts;
--   drop table if exists public.operator_notice_targets;
--   drop table if exists public.operator_notice_versions;
--   drop table if exists public.ops_feedback_events;
--   drop table if exists public.ops_feedback_items;
--   drop function if exists public.list_visible_operator_notices(uuid, uuid, timestamptz);
--   drop function if exists public.operator_notice_visible(text, uuid, uuid, timestamptz);
--   drop table if exists public.operator_notices;
--   drop function if exists public.operator_notice_targets_guard();
--   drop function if exists public.operator_notices_guard();
--   drop function if exists public.operator_notice_receipts_guard();
--   drop function if exists public.ops_feedback_events_guard();
--   drop function if exists public.operator_notices_append_only();
--   drop function if exists public.operator_notices_no_direct_delete();
--   commit;
-- END ROLLBACK

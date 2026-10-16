-- Operator notices (運営からのお知らせ) + bidirectional ops feedback.
-- Design: /cursor/stores/bot/docs/operator-notices-design-20261012.md PR-A.
-- After 20261015100000_approval_mail_attachments (main). Additive only: six new server-only tables,
-- two isolation triggers, visibility + count SQL. No existing table, row,
-- policy or grant is touched.
--
-- NOT APPLIED BY THE PR. Apply in production as a separate, reviewed step
-- (Yasaka's card) BEFORE setting OPERATOR_NOTICES_ENABLED=true. With every
-- notices / feedback flag OFF the application never reads or writes these
-- tables. Re-runnable (create … if not exists / create or replace /
-- drop trigger if exists). One explicit transaction: a failing statement
-- leaves nothing behind.
--
-- Visibility is one SQL function (operator_notices_for_employee): org and
-- employee come from the employee badge (passed by server code) and
-- orgs.created_at is read inside the function (never from an argument).
-- operator_notices_target_same_org: a target employee must belong to
-- target.org_id (exception operator_notice_cross_org).
-- operator_notice_receipt_visible: a receipt row is allowed only when the
-- employee belongs to receipt.org_id AND the notice is visible to that org
-- (insert) / audience-matches (update).
-- RLS on, NO policy, anon / authenticated have no privilege at all (tables
-- and functions); only service_role (BYPASSRLS, server code via
-- createSupabaseAdminClient) uses them.

begin;
set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. operator_notices (current version of each notice)
-- ---------------------------------------------------------------------------
create table if not exists public.operator_notices (
  id text primary key constraint operator_notices_id_check
    check (id ~ '^ntc_[0-9A-HJKMNP-TV-Z]{26}$'),
  seq bigint generated always as identity (sequence name public.operator_notices_seq),
  version integer not null default 1 check (version >= 1),
  status text not null default 'draft' constraint operator_notices_status_check
    check (status in ('draft', 'published', 'withdrawn')),
  severity text not null default 'normal' constraint operator_notices_severity_check
    check (severity in ('info', 'normal', 'important', 'urgent')),
  title text not null constraint operator_notices_title_check
    check (char_length(title) between 1 and 120),
  change_summary text not null default '' constraint operator_notices_change_summary_check
    check (char_length(change_summary) <= 4000),
  ai_usage_change text not null default '' constraint operator_notices_ai_usage_change_check
    check (char_length(ai_usage_change) <= 4000),
  effective_at timestamptz not null,
  expires_at timestamptz,
  audience_scope text not null default 'all' constraint operator_notices_audience_scope_check
    check (audience_scope in ('all', 'orgs', 'employees')),
  sticky boolean not null default false,
  related_flags text[] not null default '{}'::text[]
    constraint operator_notices_related_flags_check check (cardinality(related_flags) <= 10),
  apply_mode text not null default 'self_rules' constraint operator_notices_apply_mode_check
    check (apply_mode in ('none', 'self_rules', 'instructions_via_approval')),
  show_to_tenant_admin boolean not null default true,
  relates_to_item_ids text[] not null default '{}'::text[],
  body_hash text not null check (body_hash ~ '^[0-9a-f]{64}$'),
  created_by_user_id text,
  created_by_email text,
  published_by_user_id text,
  published_by_email text,
  created_at timestamptz not null default now(),
  published_at timestamptz,
  withdrawn_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint operator_notices_body_combined_check
    check (char_length(change_summary) + char_length(ai_usage_change) <= 8000),
  constraint operator_notices_published_at_check
    check (status <> 'published' or published_at is not null),
  constraint operator_notices_withdrawn_at_check
    check (status <> 'withdrawn' or withdrawn_at is not null),
  constraint operator_notices_expires_after_effective_check
    check (expires_at is null or expires_at > effective_at)
);
create unique index if not exists operator_notices_seq_key on public.operator_notices (seq);
create index if not exists operator_notices_published_idx
  on public.operator_notices (published_at desc) where status = 'published';

-- ---------------------------------------------------------------------------
-- 2. operator_notice_versions (immutable snapshots)
-- ---------------------------------------------------------------------------
create table if not exists public.operator_notice_versions (
  notice_id text not null references public.operator_notices(id) on delete cascade,
  version integer not null check (version >= 1),
  kind text not null constraint operator_notice_versions_kind_check
    check (kind in ('initial', 'correction', 'minor')),
  change_note text constraint operator_notice_versions_change_note_check
    check (change_note is null or char_length(change_note) <= 500),
  title text not null check (char_length(title) between 1 and 120),
  change_summary text not null check (char_length(change_summary) <= 4000),
  ai_usage_change text not null check (char_length(ai_usage_change) <= 4000),
  body_hash text not null check (body_hash ~ '^[0-9a-f]{64}$'),
  created_by_user_id text,
  created_at timestamptz not null default now(),
  primary key (notice_id, version)
);

-- ---------------------------------------------------------------------------
-- 3. operator_notice_targets (orgs / employees scopes only)
-- ---------------------------------------------------------------------------
create table if not exists public.operator_notice_targets (
  notice_id text not null references public.operator_notices(id) on delete cascade,
  org_id uuid not null references public.orgs(id) on delete cascade,
  employee_id uuid references public.employees(id) on delete cascade,
  created_at timestamptz not null default now()
);
create unique index if not exists operator_notice_targets_uniq
  on public.operator_notice_targets (
    notice_id, org_id, coalesce(employee_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );
create index if not exists operator_notice_targets_org_idx
  on public.operator_notice_targets (org_id, employee_id);

-- ---------------------------------------------------------------------------
-- 4. operator_notice_receipts (per-employee delivery / ack)
-- ---------------------------------------------------------------------------
create table if not exists public.operator_notice_receipts (
  notice_id text not null references public.operator_notices(id) on delete cascade,
  org_id uuid not null references public.orgs(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  first_listed_at timestamptz not null default now(),
  read_at timestamptz,
  read_version integer,
  state text not null default 'delivered' constraint operator_notice_receipts_state_check
    check (state in ('delivered', 'read', 'applied', 'not_applicable', 'needs_tenant_approval', 'declined')),
  acked_version integer,
  acked_at timestamptz,
  apply_evidence text constraint operator_notice_receipts_apply_evidence_check
    check (apply_evidence is null or apply_evidence in ('self_reported', 'config_change_applied')),
  config_change_approval_id text,
  note text constraint operator_notice_receipts_note_check
    check (note is null or char_length(note) <= 500),
  wake_state text not null default 'none' constraint operator_notice_receipts_wake_state_check
    check (wake_state in ('none', 'pending', 'delivered', 'failed')),
  updated_at timestamptz not null default now(),
  primary key (notice_id, employee_id)
);
create index if not exists operator_notice_receipts_org_emp_idx
  on public.operator_notice_receipts (org_id, employee_id);
create index if not exists operator_notice_receipts_state_idx
  on public.operator_notice_receipts (notice_id, state);

-- ---------------------------------------------------------------------------
-- 5. ops_feedback_items / ops_feedback_events (bidirectional; used from PR-F)
-- ---------------------------------------------------------------------------
create table if not exists public.ops_feedback_items (
  id text primary key constraint ops_feedback_items_id_check
    check (id ~ '^fb_[0-9A-HJKMNP-TV-Z]{26}$'),
  org_id uuid not null references public.orgs(id) on delete cascade,
  employee_id uuid references public.employees(id) on delete set null,
  kind text not null constraint ops_feedback_items_kind_check
    check (kind in ('request', 'bug', 'question', 'weekly_digest')),
  source text not null constraint ops_feedback_items_source_check
    check (source in ('ai_employee', 'system_weekly', 'operator')),
  title text not null constraint ops_feedback_items_title_check
    check (char_length(title) between 1 and 120),
  body text not null default '' constraint ops_feedback_items_body_check
    check (char_length(body) <= 2000),
  metrics jsonb not null default '{}'::jsonb
    constraint ops_feedback_items_metrics_check check (jsonb_typeof(metrics) = 'object'),
  status text not null default 'open' constraint ops_feedback_items_status_check
    check (status in ('open', 'triaged', 'in_progress', 'shipped', 'wontfix', 'duplicate')),
  job_id text,
  related_notice_ids text[] not null default '{}'::text[],
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists ops_feedback_items_job_uniq
  on public.ops_feedback_items (
    org_id, coalesce(employee_id, '00000000-0000-0000-0000-000000000000'::uuid), job_id
  ) where job_id is not null;
create index if not exists ops_feedback_items_org_idx
  on public.ops_feedback_items (org_id, created_at desc);

create table if not exists public.ops_feedback_events (
  id uuid primary key default gen_random_uuid(),
  item_id text not null references public.ops_feedback_items(id) on delete cascade,
  org_id uuid not null references public.orgs(id) on delete cascade,
  actor_kind text not null constraint ops_feedback_events_actor_kind_check
    check (actor_kind in ('operator', 'ai_employee', 'system')),
  body text not null default '' constraint ops_feedback_events_body_check
    check (char_length(body) <= 2000),
  notice_id text,
  created_at timestamptz not null default now()
);
create index if not exists ops_feedback_events_item_idx
  on public.ops_feedback_events (item_id, created_at);

-- ---------------------------------------------------------------------------
-- 6. Visibility SQL (org created_at is read here, never from an argument)
-- ---------------------------------------------------------------------------
create or replace function public.operator_notice_employee_in_org(p_org_id uuid, p_employee_id uuid)
returns boolean
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  select exists (
    select 1 from public.employees e
    where e.id = p_employee_id and e.org_id = p_org_id
  );
$$;

create or replace function public.operator_notice_audience_matches(
  p_notice public.operator_notices,
  p_org_id uuid,
  p_employee_id uuid
) returns boolean
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  select
    case
      when p_notice.audience_scope = 'all' then
        p_notice.sticky
        or (
          p_notice.published_at is not null
          and p_notice.published_at >= (select o.created_at from public.orgs o where o.id = p_org_id)
        )
      else exists (
        select 1 from public.operator_notice_targets t
        where t.notice_id = p_notice.id
          and t.org_id = p_org_id
          and (t.employee_id is null or t.employee_id = p_employee_id)
      )
    end;
$$;

create or replace function public.operator_notices_for_employee(p_org_id uuid, p_employee_id uuid)
returns setof public.operator_notices
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  select n.*
  from public.operator_notices n
  where n.status = 'published'
    and (n.expires_at is null or n.expires_at > now())
    and public.operator_notice_employee_in_org(p_org_id, p_employee_id)
    and exists (select 1 from public.orgs o where o.id = p_org_id)
    and public.operator_notice_audience_matches(n, p_org_id, p_employee_id);
$$;

create or replace function public.operator_notice_counts_for_employee(p_org_id uuid, p_employee_id uuid)
returns table(unread integer, urgent_unread integer, pending_apply integer)
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  with vis as (
    select n.* from public.operator_notices_for_employee(p_org_id, p_employee_id) n
  ), rec as (
    select r.* from public.operator_notice_receipts r
    where r.org_id = p_org_id and r.employee_id = p_employee_id
  ), joined as (
    select
      v.id,
      v.version,
      v.severity,
      v.apply_mode,
      r.state,
      r.acked_version,
      (
        select ver.kind from public.operator_notice_versions ver
        where ver.notice_id = v.id and ver.version = v.version
      ) as latest_kind
    from vis v
    left join rec r on r.notice_id = v.id
  )
  select
    count(*) filter (
      where state is null
         or state = 'delivered'
         or (acked_version is not null and acked_version < version and latest_kind = 'correction')
    )::integer as unread,
    count(*) filter (
      where severity = 'urgent'
        and (
          state is null
          or state = 'delivered'
          or (acked_version is not null and acked_version < version and latest_kind = 'correction')
        )
    )::integer as urgent_unread,
    count(*) filter (
      where apply_mode in ('self_rules', 'instructions_via_approval')
        and (state is null or state in ('delivered', 'read', 'needs_tenant_approval'))
    )::integer as pending_apply
  from joined;
$$;

-- ---------------------------------------------------------------------------
-- 7. Triggers: same-org targets, visible receipts, all-scope has 0 targets,
--    published audience is locked
-- ---------------------------------------------------------------------------
create or replace function public.operator_notices_target_same_org()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $fn$
declare
  notice_scope text;
  notice_status text;
begin
  select n.audience_scope, n.status into notice_scope, notice_status
  from public.operator_notices n where n.id = new.notice_id;
  if notice_scope is null then
    raise exception 'operator_notice_cross_org';
  end if;
  if notice_scope = 'all' then
    raise exception 'operator_notice_all_has_no_targets';
  end if;
  if notice_status in ('published', 'withdrawn') then
    raise exception 'operator_notice_targets_locked';
  end if;
  if new.employee_id is not null
     and not exists (
       select 1 from public.employees e
       where e.id = new.employee_id and e.org_id = new.org_id
     ) then
    raise exception 'operator_notice_cross_org';
  end if;
  return new;
end
$fn$;

create or replace function public.operator_notices_target_locked_del()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $fn$
begin
  if exists (
    select 1 from public.operator_notices n
    where n.id = old.notice_id and n.status in ('published', 'withdrawn')
  ) then
    raise exception 'operator_notice_targets_locked';
  end if;
  return old;
end
$fn$;

create or replace function public.operator_notices_all_targets_guard()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $fn$
begin
  if new.audience_scope = 'all'
     and exists (select 1 from public.operator_notice_targets t where t.notice_id = new.id) then
    raise exception 'operator_notice_all_has_no_targets';
  end if;
  if tg_op = 'UPDATE'
     and old.status in ('published', 'withdrawn')
     and (
       new.audience_scope is distinct from old.audience_scope
       or new.sticky is distinct from old.sticky
     ) then
    raise exception 'operator_notice_audience_locked';
  end if;
  return new;
end
$fn$;

create or replace function public.operator_notice_receipt_visible()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $fn$
declare
  n public.operator_notices;
begin
  if not public.operator_notice_employee_in_org(new.org_id, new.employee_id) then
    raise exception 'operator_notice_receipt_not_visible';
  end if;
  select * into n from public.operator_notices where id = new.notice_id;
  if n.id is null then
    raise exception 'operator_notice_receipt_not_visible';
  end if;
  if tg_op = 'INSERT' then
    if n.status <> 'published'
       or (n.expires_at is not null and n.expires_at <= now())
       or not public.operator_notice_audience_matches(n, new.org_id, new.employee_id) then
      raise exception 'operator_notice_receipt_not_visible';
    end if;
  else
    if not public.operator_notice_audience_matches(n, new.org_id, new.employee_id) then
      raise exception 'operator_notice_receipt_not_visible';
    end if;
  end if;
  return new;
end
$fn$;

create or replace function public.ops_feedback_events_same_org()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $fn$
begin
  if not exists (
    select 1 from public.ops_feedback_items i
    where i.id = new.item_id and i.org_id = new.org_id
  ) then
    raise exception 'ops_feedback_cross_org';
  end if;
  return new;
end
$fn$;

drop trigger if exists operator_notice_targets_same_org on public.operator_notice_targets;
create trigger operator_notice_targets_same_org
  before insert or update of notice_id, org_id, employee_id
  on public.operator_notice_targets
  for each row execute function public.operator_notices_target_same_org();

drop trigger if exists operator_notice_targets_locked_del on public.operator_notice_targets;
create trigger operator_notice_targets_locked_del
  before delete on public.operator_notice_targets
  for each row execute function public.operator_notices_target_locked_del();

drop trigger if exists operator_notices_all_targets_guard on public.operator_notices;
create trigger operator_notices_all_targets_guard
  before insert or update of audience_scope, sticky, status
  on public.operator_notices
  for each row execute function public.operator_notices_all_targets_guard();

drop trigger if exists operator_notice_receipts_visible on public.operator_notice_receipts;
create trigger operator_notice_receipts_visible
  before insert or update of notice_id, org_id, employee_id
  on public.operator_notice_receipts
  for each row execute function public.operator_notice_receipt_visible();

drop trigger if exists ops_feedback_events_same_org on public.ops_feedback_events;
create trigger ops_feedback_events_same_org
  before insert or update of item_id, org_id
  on public.ops_feedback_events
  for each row execute function public.ops_feedback_events_same_org();

-- ---------------------------------------------------------------------------
-- 8. RLS + grants (no policies)
-- ---------------------------------------------------------------------------
alter table public.operator_notices enable row level security;
alter table public.operator_notice_versions enable row level security;
alter table public.operator_notice_targets enable row level security;
alter table public.operator_notice_receipts enable row level security;
alter table public.ops_feedback_items enable row level security;
alter table public.ops_feedback_events enable row level security;

revoke all on public.operator_notices, public.operator_notice_versions,
  public.operator_notice_targets, public.operator_notice_receipts,
  public.ops_feedback_items, public.ops_feedback_events from anon, authenticated;
grant select, insert, update, delete on public.operator_notices, public.operator_notice_versions,
  public.operator_notice_targets, public.operator_notice_receipts,
  public.ops_feedback_items, public.ops_feedback_events to service_role;
grant usage, select on sequence public.operator_notices_seq to service_role;

revoke all on function public.operator_notice_employee_in_org(uuid, uuid) from public, anon, authenticated;
revoke all on function public.operator_notice_audience_matches(public.operator_notices, uuid, uuid) from public, anon, authenticated;
revoke all on function public.operator_notices_for_employee(uuid, uuid) from public, anon, authenticated;
revoke all on function public.operator_notice_counts_for_employee(uuid, uuid) from public, anon, authenticated;
revoke all on function public.operator_notices_target_same_org() from public, anon, authenticated;
revoke all on function public.operator_notices_target_locked_del() from public, anon, authenticated;
revoke all on function public.operator_notices_all_targets_guard() from public, anon, authenticated;
revoke all on function public.operator_notice_receipt_visible() from public, anon, authenticated;
revoke all on function public.ops_feedback_events_same_org() from public, anon, authenticated;

grant execute on function public.operator_notice_employee_in_org(uuid, uuid) to service_role;
grant execute on function public.operator_notice_audience_matches(public.operator_notices, uuid, uuid) to service_role;
grant execute on function public.operator_notices_for_employee(uuid, uuid) to service_role;
grant execute on function public.operator_notice_counts_for_employee(uuid, uuid) to service_role;

commit;

-- ROLLBACK (down) — removes everything this migration added. Turn
-- OPERATOR_NOTICES_ENABLED / OPS_FEEDBACK_ENABLED / OPS_WEEKLY_DIGEST_ENABLED
-- off first. Run as one transaction:
--   begin;
--   drop trigger if exists ops_feedback_events_same_org on public.ops_feedback_events;
--   drop trigger if exists operator_notice_receipts_visible on public.operator_notice_receipts;
--   drop trigger if exists operator_notices_all_targets_guard on public.operator_notices;
--   drop trigger if exists operator_notice_targets_locked_del on public.operator_notice_targets;
--   drop trigger if exists operator_notice_targets_same_org on public.operator_notice_targets;
--   drop table if exists public.ops_feedback_events;
--   drop table if exists public.ops_feedback_items;
--   drop table if exists public.operator_notice_receipts;
--   drop table if exists public.operator_notice_targets;
--   drop table if exists public.operator_notice_versions;
--   drop table if exists public.operator_notices;
--   drop function if exists public.operator_notice_counts_for_employee(uuid, uuid);
--   drop function if exists public.operator_notices_for_employee(uuid, uuid);
--   drop function if exists public.operator_notice_audience_matches(public.operator_notices, uuid, uuid);
--   drop function if exists public.operator_notice_employee_in_org(uuid, uuid);
--   drop function if exists public.ops_feedback_events_same_org();
--   drop function if exists public.operator_notice_receipt_visible();
--   drop function if exists public.operator_notices_all_targets_guard();
--   drop function if exists public.operator_notices_target_locked_del();
--   drop function if exists public.operator_notices_target_same_org();
--   commit;
-- END ROLLBACK

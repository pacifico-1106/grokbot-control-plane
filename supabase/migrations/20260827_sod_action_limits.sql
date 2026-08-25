-- Separation of duties, permission concentration, and action-based limits.

alter table employees
  add column if not exists sod_level text not null default 'ok'
    check (sod_level in ('ok','warn','force_human')),
  add column if not exists action_limits jsonb not null default '{}'::jsonb;

alter table credentials
  add column if not exists action_limits jsonb not null default '{}'::jsonb;

-- Existing mixed-duty employees must become fail-safe immediately. This uses
-- the same five high-risk domain groups as lib/gateway/domains.ts.
with employee_domains as (
  select
    id,
    org_id,
    (
      case when scopes && array['mail:send','agentmail:send','slack:post_external','drive:share_external'] then 1 else 0 end +
      case when scopes && array['commerce:order'] then 1 else 0 end +
      case when scopes && array['files:write'] then 1 else 0 end +
      case when scopes && array['calendar:confirm'] then 1 else 0 end +
      case when scopes && array['browser:use'] then 1 else 0 end
    ) as high_risk_domain_count
  from employees
)
update employees e
set
  sod_level = case
    when d.high_risk_domain_count >= 2 then 'force_human'
    when e.scopes && array['browser:use'] then 'warn'
    else 'ok'
  end,
  approval_policy = case
    when d.high_risk_domain_count >= 2 then 'always_human'
    else e.approval_policy
  end,
  updated_at = now()
from employee_domains d
where d.id = e.id;

update credentials c
set approval_policy = e.approval_policy,
    action_limits = e.action_limits
from employees e
where e.id = c.employee_id and e.org_id = c.org_id and c.revoked_at is null;

create table if not exists action_counters (
  org_id uuid not null references orgs(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete cascade,
  period text not null check (period ~ '^[0-9]{4}-[0-9]{2}$'),
  tool text not null,
  count integer not null default 0 check (count >= 0),
  updated_at timestamptz not null default now(),
  primary key (org_id, employee_id, period, tool)
);

create index if not exists action_counters_employee_period_idx
  on action_counters (employee_id, period);

alter table action_counters enable row level security;

drop policy if exists action_counters_select on action_counters;
create policy action_counters_select on action_counters
  for select using (public.is_org_member(org_id));

create or replace function public.increment_action_counter(
  p_org_id uuid,
  p_employee_id uuid,
  p_period text,
  p_tool text
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  next_count integer;
begin
  if p_period !~ '^[0-9]{4}-[0-9]{2}$' or trim(p_tool) = '' then
    raise exception 'invalid_action_counter_input';
  end if;
  if not exists (
    select 1 from employees where id = p_employee_id and org_id = p_org_id
  ) then
    raise exception 'employee_org_mismatch';
  end if;
  insert into action_counters (org_id, employee_id, period, tool, count, updated_at)
  values (p_org_id, p_employee_id, p_period, p_tool, 1, now())
  on conflict (org_id, employee_id, period, tool)
  do update set count = action_counters.count + 1, updated_at = now()
  returning count into next_count;
  return next_count;
end;
$$;

revoke all on function public.increment_action_counter(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.increment_action_counter(uuid, uuid, text, text) to service_role;

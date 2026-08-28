-- Project knowledge walls (WHICH) on the employee badge.
-- Default access is 会社全般. Named projects are granted in Staffpass.

create table if not exists org_projects (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  slug text not null,
  name text not null,
  description text not null default '',
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, slug)
);

create unique index if not exists org_projects_one_default_per_org
  on org_projects (org_id)
  where is_default;

create index if not exists org_projects_org_idx on org_projects (org_id, slug);

insert into org_projects (org_id, slug, name, is_default)
select id, 'company', '会社全般', true from orgs
on conflict (org_id, slug) do nothing;

alter table information_assets
  add column if not exists project_id uuid references org_projects(id) on delete set null;

create index if not exists information_assets_project_idx
  on information_assets (org_id, project_id);

alter table employees
  add column if not exists project_access jsonb not null default '{"mode":"company","projectIds":[]}'::jsonb;

comment on table org_projects is
  'Named knowledge projects per org. Each org has exactly one default 会社全般 (slug company).';
comment on column employees.project_access is
  'Badge project wall: {mode: company|selected|all, projectIds: string[]}. Default company = 会社全般 only.';
comment on column information_assets.project_id is
  'Owning org_projects row. Null is treated as the org default 会社全般 project.';

alter table org_projects enable row level security;

drop policy if exists org_projects_select on org_projects;
drop policy if exists org_projects_write_admin on org_projects;
create policy org_projects_select on org_projects
  for select using (public.is_org_member(org_id));
create policy org_projects_write_admin on org_projects
  for all using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));

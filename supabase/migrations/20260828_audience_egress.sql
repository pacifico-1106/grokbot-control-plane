-- Audience × information-class egress control.
-- Conversation adapters (comm.send / slack.post) are NOT org_notification_channels.

alter table employees
  add column if not exists manager_id uuid references org_members(id) on delete set null;

create index if not exists employees_manager_idx on employees (org_id, manager_id)
  where manager_id is not null;

create or replace function public.employees_manager_same_org()
returns trigger
language plpgsql
as $$
begin
  if new.manager_id is null then
    return new;
  end if;
  if not exists (
    select 1 from org_members m
    where m.id = new.manager_id and m.org_id = new.org_id
  ) then
    raise exception 'manager_org_mismatch';
  end if;
  return new;
end;
$$;

drop trigger if exists employees_manager_same_org on employees;
create trigger employees_manager_same_org
  before insert or update of manager_id, org_id on employees
  for each row execute function public.employees_manager_same_org();

create table if not exists org_parties (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  kind text not null check (kind in ('email_domain','slack_channel','slack_user','phone','line','mail_address')),
  identifier text not null,
  audience text not null check (audience in ('internal','external')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, kind, identifier)
);

create index if not exists org_parties_org_kind_idx on org_parties (org_id, kind);

create table if not exists org_channels (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  surface text not null check (surface in ('slack','line','mail','phone','web')),
  external_id text not null,
  classification text not null default 'unknown'
    check (classification in ('internal','shared_external','unknown')),
  mixed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, surface, external_id)
);

create index if not exists org_channels_org_surface_idx on org_channels (org_id, surface);

create table if not exists information_assets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  ref text not null,
  class text not null check (class in ('public','internal','confidential','verbatim')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, ref)
);

create index if not exists information_assets_org_idx on information_assets (org_id, ref);

alter table org_parties enable row level security;
alter table org_channels enable row level security;
alter table information_assets enable row level security;

drop policy if exists org_parties_select on org_parties;
drop policy if exists org_parties_write_admin on org_parties;
create policy org_parties_select on org_parties
  for select using (public.is_org_member(org_id));
create policy org_parties_write_admin on org_parties
  for all using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));

drop policy if exists org_channels_select on org_channels;
drop policy if exists org_channels_write_admin on org_channels;
create policy org_channels_select on org_channels
  for select using (public.is_org_member(org_id));
create policy org_channels_write_admin on org_channels
  for all using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));

drop policy if exists information_assets_select on information_assets;
drop policy if exists information_assets_write_admin on information_assets;
create policy information_assets_select on information_assets
  for select using (public.is_org_member(org_id));
create policy information_assets_write_admin on information_assets
  for all using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));

comment on table org_parties is
  'Conversation party directory (WHO). Unknown identifier → treat as external. Distinct from org_notification_channels.';
comment on table org_channels is
  'Conversation channel classification. Mixed/guest or shared_external → external for egress.';
comment on table information_assets is
  'Optional information-class tags. Unknown asset → confidential.';

-- P1 Decision Workflow: T1/T2/T3 tier decision system
-- Feature flag P1_DECISION_WORKFLOW_ENABLED must be ON to use these features.
-- Safe to re-run (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).

-- Decision requests table (稟議・決裁)
create table if not exists decision_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  employee_id uuid references employees(id),
  credential_id uuid references credentials(id),
  approval_id uuid references approval_requests(id),
  
  -- Basic info
  title text not null,
  description text not null,
  purpose text not null,
  job_id text,
  
  -- Amount and tier
  amount_jpy bigint,
  tax_included boolean default true,
  tax_excluded_amount_jpy bigint,
  tier text not null check (tier in ('T1', 'T2', 'T3')),
  tier_reason text,
  requested_tier text check (requested_tier in ('T1', 'T2', 'T3')),
  
  -- Fiscal year
  fiscal_year text not null,
  decision_number text,
  
  -- Deputy (職務代行)
  deputy_user_id uuid references members(id),
  deputy_activated_at timestamptz,
  deputy_activated_by uuid references members(id),
  
  -- Status
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'withdrawn')),
  deadline_at timestamptz,
  expired_at timestamptz,
  
  -- Audit
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by text,
  
  -- Metadata
  metadata jsonb default '{}'::jsonb
);

create index if not exists idx_decision_requests_org_id on decision_requests(org_id);
create index if not exists idx_decision_requests_status on decision_requests(status);
create index if not exists idx_decision_requests_fiscal_year on decision_requests(fiscal_year);
create index if not exists idx_decision_requests_tier on decision_requests(tier);

comment on table decision_requests is
  'P1 decision requests (稟議・決裁). T1=専決, T2=理事過半数, T3=社員総会. Feature flag P1_DECISION_WORKFLOW_ENABLED must be ON.';

-- Decision ballots (votes on decisions)
create table if not exists decision_ballots (
  id uuid primary key default gen_random_uuid(),
  decision_id uuid not null references decision_requests(id) on delete cascade,
  org_id uuid not null references orgs(id),
  voter_user_id uuid not null references members(id),
  
  -- Voting weight (T3 uses weights)
  vote_weight integer not null default 1,
  
  -- Vote
  vote text check (vote in ('approve', 'reject')),
  vote_reason text,
  
  -- Stage tracking
  tier text not null check (tier in ('T1', 'T2', 'T3')),
  is_final_go boolean not null default false,
  
  -- Audit
  created_at timestamptz not null default now(),
  voted_at timestamptz,
  
  -- Unique: one ballot per voter per decision
  unique (decision_id, voter_user_id)
);

create index if not exists idx_decision_ballots_decision_id on decision_ballots(decision_id);
create index if not exists idx_decision_ballots_voter_user_id on decision_ballots(voter_user_id);

comment on table decision_ballots is
  'P1 decision ballots (votes). T2 requires 2/3 approve. T3 requires all approve. vote_weight is for T3 weighted voting (八坂2・上原1・仲田1).';

-- Decision results (final outcomes)
create table if not exists decision_results (
  id uuid primary key default gen_random_uuid(),
  decision_id uuid not null references decision_requests(id) on delete cascade unique,
  org_id uuid not null references orgs(id),
  
  -- Outcome
  outcome text not null check (outcome in ('approved', 'rejected', 'expired', 'withdrawn')),
  outcome_reason text,
  
  -- Vote counts
  total_voters integer not null,
  approve_count integer not null default 0,
  reject_count integer not null default 0,
  abstain_count integer not null default 0,
  
  -- Weighted counts (for T3)
  weighted_approve integer,
  weighted_reject integer,
  
  -- Execution
  executed boolean not null default false,
  executed_at timestamptz,
  executed_by text,
  execution_summary text,
  
  -- Audit
  created_at timestamptz not null default now(),
  
  -- Metadata (for audit trail)
  metadata jsonb default '{}'::jsonb
);

create index if not exists idx_decision_results_decision_id on decision_results(decision_id);
create index if not exists idx_decision_results_org_id on decision_results(org_id);
create index if not exists idx_decision_results_outcome on decision_results(outcome);

comment on table decision_results is
  'P1 decision results (final outcomes). Stores vote counts and execution info. Never post to Connect shared_external.';

-- Decision minutes (議事録)
create table if not exists decision_minutes (
  id uuid primary key default gen_random_uuid(),
  decision_id uuid not null references decision_requests(id) on delete cascade unique,
  org_id uuid not null references orgs(id),
  
  -- Fiscal year and numbering
  fiscal_year text not null,
  minute_number integer not null,
  
  -- Content
  title text not null,
  description text not null,
  tier text not null check (tier in ('T1', 'T2', 'T3')),
  outcome text not null check (outcome in ('approved', 'rejected', 'expired', 'withdrawn')),
  
  -- Attendees
  attendees jsonb not null default '[]'::jsonb,
  
  -- Full text (議事録本文)
  body_text text not null,
  body_html text,
  
  -- Generation
  generated_at timestamptz not null default now(),
  generated_by text,
  
  -- Metadata
  metadata jsonb default '{}'::jsonb
);

create index if not exists idx_decision_minutes_org_id on decision_minutes(org_id);
create index if not exists idx_decision_minutes_fiscal_year on decision_minutes(fiscal_year);
create unique index if not exists idx_decision_minutes_org_fiscal_number 
  on decision_minutes(org_id, fiscal_year, minute_number);

comment on table decision_minutes is
  'P1 decision minutes (議事録). Auto-generated after decision completion. minute_number is per-org-per-fiscal-year sequence.';

-- RLS policies

-- decision_requests RLS
alter table decision_requests enable row level security;

drop policy if exists decision_requests_select_own_org on decision_requests;
create policy decision_requests_select_own_org on decision_requests
  for select using (
    auth.uid() in (
      select m.user_id from members m 
      where m.org_id = decision_requests.org_id 
      and m.status = 'active'
    )
  );

drop policy if exists decision_requests_insert_own_org on decision_requests;
create policy decision_requests_insert_own_org on decision_requests
  for insert with check (
    auth.uid() in (
      select m.user_id from members m 
      where m.org_id = decision_requests.org_id 
      and m.status = 'active'
    )
  );

-- decision_ballots RLS
alter table decision_ballots enable row level security;

drop policy if exists decision_ballots_select_own_org on decision_ballots;
create policy decision_ballots_select_own_org on decision_ballots
  for select using (
    auth.uid() in (
      select m.user_id from members m 
      where m.org_id = decision_ballots.org_id 
      and m.status = 'active'
    )
  );

drop policy if exists decision_ballots_insert_voter on decision_ballots;
create policy decision_ballots_insert_voter on decision_ballots
  for insert with check (
    auth.uid() = (select m.user_id from members m where m.id = voter_user_id)
  );

drop policy if exists decision_ballots_update_voter on decision_ballots;
create policy decision_ballots_update_voter on decision_ballots
  for update using (
    auth.uid() = (select m.user_id from members m where m.id = voter_user_id)
    and vote is null -- Can only vote once
  );

-- decision_results RLS
alter table decision_results enable row level security;

drop policy if exists decision_results_select_own_org on decision_results;
create policy decision_results_select_own_org on decision_results
  for select using (
    auth.uid() in (
      select m.user_id from members m 
      where m.org_id = decision_results.org_id 
      and m.status = 'active'
    )
  );

-- decision_minutes RLS
alter table decision_minutes enable row level security;

drop policy if exists decision_minutes_select_own_org on decision_minutes;
create policy decision_minutes_select_own_org on decision_minutes
  for select using (
    auth.uid() in (
      select m.user_id from members m 
      where m.org_id = decision_minutes.org_id 
      and m.status = 'active'
    )
  );

-- Org settings for decision workflow
-- These are stored in approval_kind_routes_policy.decisionWorkflow
-- - deputyUserId: UUID reference to member
-- - fiscalYearStartMonth: 1-12 (default 4)
-- - fiscalYearStartDay: 1-31 (default 1)
-- - amountThresholdJpy: number (default 500000, tax-excluded)

-- P1 Approval Kind Routes: per-kind approval routing
-- Feature flag P1_APPROVAL_KIND_ROUTES_ENABLED must be ON to use these features.
-- When flag is OFF, existing routes[] (class=admin|business) behavior preserved.
-- Safe to re-run (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).

-- Org-level approval kind routes policy
-- Migration from routes[] is handled in application code at first enable.
alter table orgs
  add column if not exists approval_kind_routes_policy jsonb default null;

comment on column orgs.approval_kind_routes_policy is
  'P1 approval kind routes policy: per-kind routes with approvers, quorum, finalGo, deadline, reminders. Null = use legacy routes[] or default (owner 1名). Feature flag P1_APPROVAL_KIND_ROUTES_ENABLED must be ON.';

-- Per-employee approval kind routes override
alter table employees
  add column if not exists approval_kind_routes_override jsonb default null;

comment on column employees.approval_kind_routes_override is
  'P1 optional per-employee approval kind routes override. Null = inherit org policy. Feature flag P1_APPROVAL_KIND_ROUTES_ENABLED must be ON.';

-- Topic gate config for post kind (stored in org policy)
-- sensitiveTopics[], mainBoardChannelIds[]

-- Decision workflow config (stored in org policy)
-- amountThresholdJpy, fiscalYearStartMonth, fiscalYearStartDay, deputyUserId, tiers[]

-- Decision requests table (for D1 PR)
-- This migration only reserves the column; D1 creates the full table.

-- Org-editable SoD warn policy: which high-risk domains produce a save-time warning
-- when 2+ are combined. Warn + ACK only; never force_human. User applies in production SQL editor.

alter table orgs
  add column if not exists sod_warn_policy jsonb not null default '{
    "domains": ["comm_external", "money", "destructive", "commit"]
  }'::jsonb;

comment on column orgs.sod_warn_policy is
  'Which of comm_external/money/destructive/commit produce a save-time warning when 2+ are combined. Warn and operator ACK only; Gateway never force_human.';

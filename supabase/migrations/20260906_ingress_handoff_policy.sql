-- Ingress handoff policy: how incoming message content is passed to AI employees.
-- Convenience default: full body, meta-only attachment, Sealith off.
-- Tighten for external/sensitive via ordered rules (first match wins).

alter table orgs
  add column if not exists ingress_handoff_policy jsonb;

comment on column orgs.ingress_handoff_policy is
  'Tenant policy for ingress handoff: body (full/prefix/none), attachment (file/meta/none), Sealith (off/suggest/required). First-match rule ordering. NULL = default convenience policy.';

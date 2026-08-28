-- Employee badge voice (character / register). Org-scoped via existing employees RLS.
-- External audience cannot drop below polite. No extra table.

alter table employees
  add column if not exists voice jsonb not null default '{
    "template": "polite",
    "register": "polite",
    "endings": "desumasu",
    "forbidden": ["了解", "ぶっちゃけ", "ヤバい", "マジで", "ごめん"],
    "signOff": "何卒よろしくお願いいたします",
    "externalFloor": "polite"
  }'::jsonb;

comment on column employees.voice is
  'AI employee badge character/register (polite/frank/custom). External audience cannot drop below polite. Forbidden-word scan is not DLP.';

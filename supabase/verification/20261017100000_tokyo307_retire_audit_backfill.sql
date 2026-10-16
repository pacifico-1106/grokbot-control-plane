-- TOKYO307: REST で先に失効した社員証の監査を、あとから正規化する。
--
-- 使い方（本番に流す前は必ず ROLLBACK のまま）:
--   1. 下の変数を埋める（完全な UUID が無いときは prefix のまま）。
--   2. このファイル全体を SQL エディタで実行する（BEGIN … ROLLBACK）。
--   3. 「確認」セクションの結果を見る。
--   4. 書き込み結果（insert 件数）を確認したら ROLLBACK されていることを確認する。
--   5. 本番適用は人間が別途、同じ文を COMMIT に変えて流す（このエージェントは流さない）。
--
-- 監査の型:
--   public.audit_events
--   action = credential.revoked / employee.terminated
--   （既存の契約終了経路 app/api/employees/[id]/terminate/route.ts と同じ）
--   metadata.backfill = true
--   metadata.actor = 'human'
--   actor_email に実施者（八坂 GO）
--
-- 二重挿入しない:
--   同じ credential_id + action + metadata.backfill=true が既にあれば入れない。
--   employee.terminated は employee_id 単位で同様。

begin;

-- ---------------------------------------------------------------------------
-- 変数（本番の完全な UUID が分かったら prefix の代わりに ids を埋めてよい）
-- ---------------------------------------------------------------------------
create temporary table if not exists retire_backfill_params (
  credential_id_prefixes text[] not null,
  credential_ids uuid[] not null default '{}',
  org_id uuid,
  actor_email text not null,
  performed_by text not null,
  reason text not null,
  go_by text not null
) on commit drop;

delete from retire_backfill_params;
insert into retire_backfill_params (
  credential_id_prefixes, credential_ids, org_id, actor_email, performed_by, reason, go_by
) values (
  array['9e9bfc80', '53d551f3', '43b63187', '0fd2f410'],
  '{}',
  null,  -- 分かっているなら TOKYO307 の org_id を入れる
  'yasaka@tokyo307.example',  -- 八坂さんの実メールに置き換え
  'yasaka',
  'TOKYO307 AI社員4名の退職（八坂GO）。社員証はRESTで先に revoked_at を入れた。監査を後から正規化する。',
  'yasaka'
);

-- 対象社員証
create temporary table if not exists retire_backfill_credentials (
  credential_id uuid primary key,
  org_id uuid not null,
  employee_id uuid not null,
  revoked_at timestamptz,
  employee_status text,
  employee_name text
) on commit drop;

delete from retire_backfill_credentials;
insert into retire_backfill_credentials (
  credential_id, org_id, employee_id, revoked_at, employee_status, employee_name
)
select
  c.id,
  c.org_id,
  c.employee_id,
  c.revoked_at,
  e.status,
  e.display_name
from public.credentials c
join public.employees e
  on e.id = c.employee_id
 and e.org_id = c.org_id
cross join retire_backfill_params p
where (
  (cardinality(p.credential_ids) > 0 and c.id = any (p.credential_ids))
  or (
    cardinality(p.credential_ids) = 0
    and exists (
      select 1
      from unnest(p.credential_id_prefixes) as pref
      where c.id::text like pref || '%'
    )
  )
)
and (p.org_id is null or c.org_id = p.org_id);

-- ===========================================================================
-- 確認（read-only。ROLLBACK しても結果は見える）
-- ===========================================================================

-- (1) 対象社員証: revoked_at と従業員 status
select
  'credentials' as check_name,
  t.credential_id,
  t.org_id,
  t.employee_id,
  t.employee_name,
  t.employee_status,
  t.revoked_at,
  (t.revoked_at is not null) as already_revoked
from retire_backfill_credentials t
order by t.credential_id;

-- (2) 既存の監査（credential.revoked / employee.terminated）
select
  'existing_audit' as check_name,
  a.id as audit_id,
  a.org_id,
  a.employee_id,
  a.credential_id,
  a.action,
  a.actor_email,
  a.created_at,
  a.metadata
from public.audit_events a
where a.credential_id in (select credential_id from retire_backfill_credentials)
   or (
     a.employee_id in (select employee_id from retire_backfill_credentials)
     and a.action in ('credential.revoked', 'employee.terminated')
   )
order by a.created_at, a.id;

-- (3) 同じ従業員に、まだ有効な社員証が残っていないか
select
  'other_active_credentials' as check_name,
  c.id as credential_id,
  c.org_id,
  c.employee_id,
  c.revoked_at,
  c.expires_at
from public.credentials c
where c.employee_id in (select employee_id from retire_backfill_credentials)
  and c.revoked_at is null
order by c.employee_id, c.id;

-- (4) 有効な OAuth grant
select
  'active_oauth_grants' as check_name,
  g.id as grant_id,
  g.org_id,
  g.employee_id,
  g.client_id,
  g.status,
  g.revoked_at,
  g.expires_at
from public.oauth_grants g
where g.employee_id in (select employee_id from retire_backfill_credentials)
  and g.status = 'active'
order by g.employee_id, g.id;

-- (5) 有効な OAuth access / refresh token（revoke されていないもの）
select
  'active_oauth_access_tokens' as check_name,
  t.token_hash,
  t.grant_id,
  g.employee_id,
  t.revoked_at,
  t.expires_at
from public.oauth_access_tokens t
join public.oauth_grants g on g.id = t.grant_id
where g.employee_id in (select employee_id from retire_backfill_credentials)
  and t.revoked_at is null
order by g.employee_id, t.grant_id;

select
  'active_oauth_refresh_tokens' as check_name,
  t.token_hash,
  t.grant_id,
  g.employee_id,
  t.revoked_at,
  t.expires_at
from public.oauth_refresh_tokens t
join public.oauth_grants g on g.id = t.grant_id
where g.employee_id in (select employee_id from retire_backfill_credentials)
  and t.revoked_at is null
order by g.employee_id, t.grant_id;

-- (6) 有効な MCP Events wake listener
select
  'active_mcp_event_subscriptions' as check_name,
  s.id as subscription_id,
  s.org_id,
  s.employee_id,
  s.status,
  s.event_name,
  s.updated_at
from public.mcp_event_subscriptions s
where s.employee_id in (select employee_id from retire_backfill_credentials)
  and s.status = 'active'
order by s.employee_id, s.id;

-- (7) 対象 prefix で社員証が見つからないもの（打ち間違い防止）
select
  'unmatched_prefixes' as check_name,
  pref as credential_id_prefix
from retire_backfill_params p
cross join unnest(p.credential_id_prefixes) as pref
where cardinality(p.credential_ids) = 0
  and not exists (
    select 1
    from public.credentials c
    where c.id::text like pref || '%'
      and (p.org_id is null or c.org_id = p.org_id)
  );

-- ===========================================================================
-- 書き込み（このファイルは ROLLBACK。本番適用は人間が COMMIT に変える）
-- ===========================================================================

-- 社員証ごとの credential.revoked（backfill）
insert into public.audit_events (
  org_id, employee_id, credential_id, actor_email, action, purpose, summary, metadata
)
select
  t.org_id,
  t.employee_id,
  t.credential_id,
  p.actor_email,
  'credential.revoked',
  null,
  t.employee_name || ' の社員証を失効（退職の事後監査）',
  jsonb_build_object(
    'backfill', true,
    'actor', 'human',
    'reason', p.reason,
    'revoked_at', t.revoked_at,
    'performedBy', p.performed_by,
    'goBy', p.go_by,
    'source', 'rest_direct_revoke'
  )
from retire_backfill_credentials t
cross join retire_backfill_params p
where t.revoked_at is not null
  and not exists (
    select 1
    from public.audit_events a
    where a.org_id = t.org_id
      and a.credential_id = t.credential_id
      and a.action = 'credential.revoked'
      and coalesce((a.metadata ->> 'backfill')::boolean, false) = true
  );

-- 従業員ごとの employee.terminated（backfill、1人1行）
insert into public.audit_events (
  org_id, employee_id, credential_id, actor_email, action, purpose, summary, metadata
)
select
  t.org_id,
  t.employee_id,
  null,
  p.actor_email,
  'employee.terminated',
  null,
  t.employee_name || ' の契約を終了（事後監査。社員証はRESTで先に失効済み。番号と監査は残す）',
  jsonb_build_object(
    'backfill', true,
    'actor', 'human',
    'reason', p.reason,
    'revoked_at', t.revoked_at,
    'performedBy', p.performed_by,
    'goBy', p.go_by,
    'status', t.employee_status,
    'source', 'rest_direct_revoke'
  )
from (
  select distinct on (employee_id)
    org_id, employee_id, employee_name, employee_status, revoked_at
  from retire_backfill_credentials
  order by employee_id, revoked_at desc nulls last
) t
cross join retire_backfill_params p
where not exists (
  select 1
  from public.audit_events a
  where a.org_id = t.org_id
    and a.employee_id = t.employee_id
    and a.action = 'employee.terminated'
    and coalesce((a.metadata ->> 'backfill')::boolean, false) = true
);

-- 書き込み結果（ROLLBACK 前に件数を見る）
select
  'backfill_preview' as check_name,
  action,
  count(*) as rows
from public.audit_events
where coalesce((metadata ->> 'backfill')::boolean, false) = true
  and (
    credential_id in (select credential_id from retire_backfill_credentials)
    or employee_id in (select employee_id from retire_backfill_credentials)
  )
group by action
order by action;

-- 二重に入らないことの確認（同じ backfill 行を再 insert しても 0 件）
insert into public.audit_events (
  org_id, employee_id, credential_id, actor_email, action, purpose, summary, metadata
)
select
  t.org_id,
  t.employee_id,
  t.credential_id,
  p.actor_email,
  'credential.revoked',
  null,
  t.employee_name || ' の社員証を失効（退職の事後監査）',
  jsonb_build_object(
    'backfill', true,
    'actor', 'human',
    'reason', p.reason,
    'revoked_at', t.revoked_at,
    'performedBy', p.performed_by,
    'goBy', p.go_by,
    'source', 'rest_direct_revoke'
  )
from retire_backfill_credentials t
cross join retire_backfill_params p
where t.revoked_at is not null
  and not exists (
    select 1
    from public.audit_events a
    where a.org_id = t.org_id
      and a.credential_id = t.credential_id
      and a.action = 'credential.revoked'
      and coalesce((a.metadata ->> 'backfill')::boolean, false) = true
  );

select
  'idempotent_second_insert' as check_name,
  count(*) as extra_credential_revoked_rows
from public.audit_events
where action = 'credential.revoked'
  and coalesce((metadata ->> 'backfill')::boolean, false) = true
  and credential_id in (select credential_id from retire_backfill_credentials);

rollback;

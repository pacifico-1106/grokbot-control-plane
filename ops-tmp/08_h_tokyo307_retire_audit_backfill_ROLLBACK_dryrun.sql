-- TOKYO307: REST で先に失効した社員証の監査を、あとから正規化する。
--
-- 使い方（本番に流す前は必ず ROLLBACK のまま）:
--   1. 下の変数を埋める。org_id は必須（TOKYO307）。未設定のままでは 0 件（他 org に広がらない）。
--      完全な UUID が無いときは 8 桁 hex prefix のまま。
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
--   同じ org の credential_id + action = credential.revoked が既にあれば入れない（backfill 以外も含む）。
--   employee.terminated は employee_id 単位で同様。
--
-- テナント:
--   prefix / id の一致は p.org_id が NOT NULL のときだけ。他 org には広がらない。
--   prefix は ^[0-9a-f]{8}$ のみ。1 prefix が 0 件または 2 件以上なら書き込みしない。

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
  '{9e9bfc80-bd7d-4188-b116-4e89aab1e7d6,53d551f3-6eb8-4baf-8dcf-8e7e26148c63,43b63187-0cc0-429b-a761-4fc64d343c3d,0fd2f410-29fd-4a27-b35b-0aa9753facc0}',
  '92f3617c-33fc-4dac-b9b4-d4f42e8522ac'::uuid,  -- TOKYO307
  'tyasaka@tokyo307inc.com',
  'yasaka',
  'TOKYO307 AI社員4名の退職（八坂GO）。社員証はRESTで先に revoked_at を入れた。監査を後から正規化する。',
  'yasaka'
);

-- 対象社員証（この org だけ。org_id が null なら 0 件）
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
where p.org_id is not null
  and c.org_id = p.org_id
  and (
    (cardinality(p.credential_ids) > 0 and c.id = any (p.credential_ids))
    or (
      cardinality(p.credential_ids) = 0
      and exists (
        select 1
        from unnest(p.credential_id_prefixes) as pref
        where pref ~ '^[0-9a-f]{8}$'
          and c.id::text like pref || '%'
      )
    )
  );

-- 書き込みしてよいか（他 org / prefix 過不足 / org_id 未設定なら false → INSERT 0 件）
create temporary table if not exists retire_backfill_write_ok (
  ok boolean not null
) on commit drop;

delete from retire_backfill_write_ok;
insert into retire_backfill_write_ok (ok)
select
  p.org_id is not null
  and (select count(*) from retire_backfill_credentials) > 0
  and (select count(distinct org_id) from retire_backfill_credentials) = 1
  and not exists (
    select 1
    from retire_backfill_credentials t
    where t.org_id is distinct from p.org_id
  )
  and (
    cardinality(p.credential_ids) > 0
    or not exists (
      select 1
      from unnest(p.credential_id_prefixes) as pref
      where (
        select count(*)
        from public.credentials c
        where p.org_id is not null
          and c.org_id = p.org_id
          and pref ~ '^[0-9a-f]{8}$'
          and c.id::text like pref || '%'
      ) <> 1
    )
  )
from retire_backfill_params p;

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

-- (7) 対象 prefix で社員証が見つからないもの（打ち間違い防止。この org のみ）
select
  'unmatched_prefixes' as check_name,
  pref as credential_id_prefix
from retire_backfill_params p
cross join unnest(p.credential_id_prefixes) as pref
where cardinality(p.credential_ids) = 0
  and p.org_id is not null
  and not exists (
    select 1
    from public.credentials c
    where c.org_id = p.org_id
      and pref ~ '^[0-9a-f]{8}$'
      and c.id::text like pref || '%'
  );

-- (8) 1 prefix が 1 件以外（0 件・2 件以上）。COMMIT 前に空であること
select
  'overmatched_or_unmatched_prefixes' as check_name,
  pref as credential_id_prefix,
  count(*) as matches
from retire_backfill_params p
cross join unnest(p.credential_id_prefixes) as pref
join public.credentials c
  on p.org_id is not null
 and c.org_id = p.org_id
 and pref ~ '^[0-9a-f]{8}$'
 and c.id::text like pref || '%'
where cardinality(p.credential_ids) = 0
group by pref
having count(*) <> 1;

-- (9) 一致した org の数（1 以外なら書き込まない）
select
  'matched_org_count' as check_name,
  (select count(distinct org_id) from retire_backfill_credentials) as distinct_orgs,
  (select ok from retire_backfill_write_ok) as write_ok;

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
cross join retire_backfill_write_ok w
where w.ok
  and p.org_id is not null
  and t.org_id = p.org_id
  and t.revoked_at is not null
  and not exists (
    select 1
    from public.audit_events a
    where a.org_id = t.org_id
      and a.credential_id = t.credential_id
      and a.action = 'credential.revoked'
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
cross join retire_backfill_write_ok w
where w.ok
  and p.org_id is not null
  and t.org_id = p.org_id
  and t.revoked_at is not null
  and t.employee_status = 'suspended'
  and not exists (
    select 1
    from public.audit_events a
    where a.org_id = t.org_id
      and a.employee_id = t.employee_id
      and a.action = 'employee.terminated'
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
cross join retire_backfill_write_ok w
where w.ok
  and p.org_id is not null
  and t.org_id = p.org_id
  and t.revoked_at is not null
  and not exists (
    select 1
    from public.audit_events a
    where a.org_id = t.org_id
      and a.credential_id = t.credential_id
      and a.action = 'credential.revoked'
  );

select
  'idempotent_second_insert' as check_name,
  count(*) as extra_credential_revoked_rows
from public.audit_events
where action = 'credential.revoked'
  and coalesce((metadata ->> 'backfill')::boolean, false) = true
  and credential_id in (select credential_id from retire_backfill_credentials);

rollback;

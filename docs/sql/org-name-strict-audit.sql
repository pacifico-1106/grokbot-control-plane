-- org-name-strict-audit.sql
-- ORG_NAME_INPUT_STRICT_ENABLED フラグを ON にする前に、既存の組織名のうち
-- いくつが引っかかるかを理由ごとに数える読み取り専用クエリ。
--
-- 重要:
-- - このクエリは SELECT のみ。UPDATE / INSERT / DELETE は一切含まれていません。
-- - 組織名そのものは出力しません。Q1 は件数のみ、Q2 は org_id と理由のみ。
--
-- 対象テーブル:
-- - public.orgs.name: 組織名
-- - public.signup_attempts (org_id 経由でリンク可能だが、name は保持していない)
--
-- ========================================================================
-- SQL とアプリの判定のずれ（重要）
-- ========================================================================
-- SQL の件数は「上限の目安」です。実際にアプリが拒否する件数は、SQL の結果以下になります。
--
-- 1. NFKC 正規化の有無
--    - アプリ: 入力を NFKC 正規化してから判定
--    - SQL: 正規化なし（Postgres では再現困難）
--    → 全角文字 → 半角変換などで、アプリでは通るが SQL では引っかかるケースがあり得る
--
-- 2. 先頭 BOM (U+FEFF) の扱い
--    - アプリ: normalize().trim() で先頭の BOM を除去 → 検出されない
--    - SQL: 先頭の BOM も検出 → has_invisible = true
--    → SQL のほうが厳しく判定
--
-- 3. ドメイン判定の safe suffix
--    - アプリ: Co., Ltd. / Inc. などを複数レベルで除外
--    - SQL: 正規表現で近似（誤検知の可能性あり）
--    → SQL のほうが厳しく判定することがある
--
-- 4. 全角文字の正規化
--    - アプリ: 全角コロン（：）、全角スラッシュ（／）、全角ドット（．）、
--             句点（。）をそれぞれ半角に変換してからURL判定
--    - SQL: 全角文字は検出しない
--    → アプリのほうが厳しく判定（例: example。com はアプリで拒否、SQLでは通過）
--
-- 5. 日本語ドメイン・隣接パターン
--    - アプリ: 日本語.com, 株式会社malware.com, note.com株式会社 を検出
--    - SQL: 近似パターンで検出（完全一致ではない）
--    → SQL では一部検出漏れの可能性あり
--
-- 結論: SQL で件数 = 0 なら安全。件数 > 0 でも、アプリでは通る可能性がある。
-- 全角パターン (example。com 等) は SQL では検出されないが、アプリでは拒否される。
-- ========================================================================
--
-- 正規表現は Postgres (POSIX) 形式です。
-- 注意: Postgres では \b (word boundary) は使えません。代わりに \y を使用。
-- 参考: https://www.postgresql.org/docs/current/functions-matching.html#POSIX-CONSTRAINT-ESCAPES

-- =============================================================================
-- Q1: 理由ごとの件数カウント
-- =============================================================================
WITH org_analysis AS (
  SELECT
    o.id,
    o.name,
    -- Bidi control characters: U+202A–202E, U+2066–2069, U+200E/F, U+061C
    CASE WHEN o.name ~ '[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]' THEN true ELSE false END AS has_bidi,
    -- Zero-width and invisible: U+200B–200D, U+2060–2065 (function application等含む), U+FEFF, U+00AD, U+180E
    CASE WHEN o.name ~ '[\u200B-\u200D\u2060-\u2065\uFEFF\u00AD\u180E]' THEN true ELSE false END AS has_invisible,
    -- Control characters and CR/LF: U+0000–001F, U+007F–009F, U+2028, U+2029
    CASE WHEN o.name ~ '[\u0000-\u001F\u007F-\u009F\u2028\u2029\r\n]' THEN true ELSE false END AS has_control,
    -- URL-like: schemes, www., domain patterns, IPv4
    -- Note: This is an approximation. App-side validation is more sophisticated.
    -- App also normalizes fullwidth chars (：→:, ／→/, ．→., 。→.) which SQL doesn't.
    CASE WHEN
      -- Standard and obfuscated schemes (hxxp, hxxps, ftp)
      o.name ~* '(https?|hxxps?|ftp|javascript|data|vbscript|file|mailto):' OR
      -- www. prefix
      o.name ~* '(^|\s)www\.' OR
      -- IPv4 addresses (e.g., 192.168.1.1)
      o.name ~ '(^|\s|\()([0-9]{1,3}\.){3}[0-9]{1,3}(/|\?|#|$|\s)' OR
      -- Punycode labels (xn--)
      o.name ~* '(^|\s|\.)(xn--[a-z0-9-]+)' OR
      -- Domain pattern: supports 2-level domains like evil.co.jp
      -- Uses \y (word boundary) instead of \b for Postgres POSIX
      (o.name ~* '(^|\s)[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*\.[a-z]{2,}(/|\?|#|$|\s)'
       AND o.name !~* '\y(co|inc|ltd|llc|llp|corp|gmbh|sa|ag|plc|kg)\.(,|\s|$)')
    THEN true ELSE false END AS has_url,
    -- Length check (max 100 for signup; admin uses 200)
    -- This checks the base signup limit; admin path allows longer names
    CASE WHEN length(o.name) > 100 THEN true ELSE false END AS too_long
  FROM public.orgs o
)
SELECT
  'bidi' AS reason,
  COUNT(*) FILTER (WHERE has_bidi) AS count
FROM org_analysis
UNION ALL
SELECT
  'invisible' AS reason,
  COUNT(*) FILTER (WHERE has_invisible) AS count
FROM org_analysis
UNION ALL
SELECT
  'control' AS reason,
  COUNT(*) FILTER (WHERE has_control) AS count
FROM org_analysis
UNION ALL
SELECT
  'url' AS reason,
  COUNT(*) FILTER (WHERE has_url) AS count
FROM org_analysis
UNION ALL
SELECT
  'too_long' AS reason,
  COUNT(*) FILTER (WHERE too_long) AS count
FROM org_analysis
UNION ALL
SELECT
  'any_issue' AS reason,
  COUNT(*) FILTER (WHERE has_bidi OR has_invisible OR has_control OR has_url OR too_long) AS count
FROM org_analysis
UNION ALL
SELECT
  'total_orgs' AS reason,
  COUNT(*) AS count
FROM org_analysis;

-- =============================================================================
-- Q2: 問題のある組織の ID と理由 (組織名そのものは出力しない)
-- =============================================================================
WITH org_analysis AS (
  SELECT
    o.id,
    o.name,
    CASE WHEN o.name ~ '[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]' THEN true ELSE false END AS has_bidi,
    CASE WHEN o.name ~ '[\u200B-\u200D\u2060-\u2065\uFEFF\u00AD\u180E]' THEN true ELSE false END AS has_invisible,
    CASE WHEN o.name ~ '[\u0000-\u001F\u007F-\u009F\u2028\u2029\r\n]' THEN true ELSE false END AS has_control,
    CASE WHEN
      o.name ~* '(https?|hxxps?|ftp|javascript|data|vbscript|file|mailto):' OR
      o.name ~* '(^|\s)www\.' OR
      o.name ~ '(^|\s|\()([0-9]{1,3}\.){3}[0-9]{1,3}(/|\?|#|$|\s)' OR
      o.name ~* '(^|\s|\.)(xn--[a-z0-9-]+)' OR
      (o.name ~* '(^|\s)[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*\.[a-z]{2,}(/|\?|#|$|\s)'
       AND o.name !~* '\y(co|inc|ltd|llc|llp|corp|gmbh|sa|ag|plc|kg)\.(,|\s|$)')
    THEN true ELSE false END AS has_url,
    CASE WHEN length(o.name) > 100 THEN true ELSE false END AS too_long
  FROM public.orgs o
)
SELECT
  id AS org_id,
  array_remove(ARRAY[
    CASE WHEN has_bidi THEN 'bidi' END,
    CASE WHEN has_invisible THEN 'invisible' END,
    CASE WHEN has_control THEN 'control' END,
    CASE WHEN has_url THEN 'url' END,
    CASE WHEN too_long THEN 'too_long' END
  ], NULL) AS reasons
FROM org_analysis
WHERE has_bidi OR has_invisible OR has_control OR has_url OR too_long
ORDER BY id;

-- =============================================================================
-- 使い方:
-- 1. Q1 を実行して any_issue の件数を確認
-- 2. any_issue = 0 → フラグを ON にしても既存データに影響なし（安全）
-- 3. any_issue > 0 → Q2 を実行して org_id を確認し、対処を検討
--    - SQL の件数は「上限の目安」なので、実際には通るケースもあり得る
--    - 必要に応じてデータ修正またはフラグ ON の延期を検討
--
-- 注意:
-- - このクエリは SELECT のみ。データは変更されません。
-- - 組織名そのものは出力されません（セキュリティ配慮）。
-- - 全角文字パターン（例: example。com）はこの SQL では検出されませんが、
--   アプリでは正規化後に拒否されます。
-- - 日本語隣接ドメイン（株式会社malware.com 等）は SQL の近似パターンでは
--   検出漏れの可能性があります。
-- =============================================================================

-- org-name-strict-audit.sql
-- ORG_NAME_INPUT_STRICT_ENABLED フラグを ON にする前に、既存の組織名のうち
-- いくつが引っかかるかを理由ごとに数える読み取り専用クエリ。
--
-- 対象テーブル:
-- - public.orgs.name: 組織名
-- - public.signup_attempts (org_id 経由でリンク可能だが、name は保持していない)
--
-- 注意:
-- - このクエリは SELECT のみ。データを変更しません。
-- - 正規表現は Postgres (POSIX) 形式です。
-- - アプリ側の判定と完全に同じにはできない部分があります:
--   - NFKC 正規化は SQL では再現が難しいため、省略しています。
--   - ドメイン判定の safe suffix (Co., Ltd. など) は SQL で近似しています。

-- =============================================================================
-- Q1: 理由ごとの件数カウント
-- =============================================================================
WITH org_analysis AS (
  SELECT
    o.id,
    o.name,
    -- Bidi control characters: U+202A–202E, U+2066–2069, U+200E/F, U+061C
    CASE WHEN o.name ~ '[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]' THEN true ELSE false END AS has_bidi,
    -- Zero-width and invisible: U+200B–200D, U+2060, U+FEFF, U+00AD, U+180E
    CASE WHEN o.name ~ '[\u200B-\u200D\u2060\uFEFF\u00AD\u180E]' THEN true ELSE false END AS has_invisible,
    -- Control characters and CR/LF: U+0000–001F, U+007F–009F, U+2028, U+2029
    CASE WHEN o.name ~ '[\u0000-\u001F\u007F-\u009F\u2028\u2029\r\n]' THEN true ELSE false END AS has_control,
    -- URL-like: schemes or domain patterns
    -- Note: This is an approximation. App-side validation is more sophisticated.
    CASE WHEN
      o.name ~* '(https?|javascript|data|vbscript|file|mailto):' OR
      o.name ~* '(^|\s)www\.' OR
      -- Domain pattern: word.tld (simplified, may have false positives for Co., Ltd.)
      (o.name ~* '(^|\s)[a-z0-9][a-z0-9-]*\.[a-z]{2,}(/|\?|#|$|\s)'
       AND o.name !~* '\b(co|inc|ltd|llc|llp|corp|gmbh|sa|ag|plc|kg)\.(,|\s|$)')
    THEN true ELSE false END AS has_url,
    -- Length check (max 100)
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
    CASE WHEN o.name ~ '[\u200B-\u200D\u2060\uFEFF\u00AD\u180E]' THEN true ELSE false END AS has_invisible,
    CASE WHEN o.name ~ '[\u0000-\u001F\u007F-\u009F\u2028\u2029\r\n]' THEN true ELSE false END AS has_control,
    CASE WHEN
      o.name ~* '(https?|javascript|data|vbscript|file|mailto):' OR
      o.name ~* '(^|\s)www\.' OR
      (o.name ~* '(^|\s)[a-z0-9][a-z0-9-]*\.[a-z]{2,}(/|\?|#|$|\s)'
       AND o.name !~* '\b(co|inc|ltd|llc|llp|corp|gmbh|sa|ag|plc|kg)\.(,|\s|$)')
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
-- 補足:
-- - 上記クエリで件数が 0 であれば、フラグを ON にしても既存データに影響はありません。
-- - 件数が 0 でない場合は、Q2 で出力された org_id を確認し、
--   必要に応じてデータ修正またはフラグ ON の延期を検討してください。
--
-- アプリ側の判定とのずれ:
-- - NFKC 正規化: アプリは NFKC 正規化後に判定しますが、SQL では省略。
--   全角文字が半角に変換される等の違いがあり得ます。
-- - ドメイン判定: アプリは safe suffix (Co., Ltd.) を複数レベルで除外しますが、
--   SQL では正規表現で近似しています。誤検知の可能性があります。
-- - FEFF (BOM) at start: アプリは trim() で先頭の BOM を除去するため検出しませんが、
--   SQL では検出されます。これは SQL の方が厳しい方向のずれです。
-- =============================================================================

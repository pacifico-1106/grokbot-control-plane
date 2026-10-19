-- org-name-strict-audit.sql
-- ORG_NAME_INPUT_STRICT_ENABLED フラグを ON にする前に、既存の組織名のうち
-- 「要確認」の件数を数える読み取り専用クエリ。
--
-- 重要:
-- - このクエリは SELECT のみ。UPDATE / INSERT / DELETE は一切含まれていません。
-- - 組織名そのものは出力しません。Q1 は件数のみ、Q2 は org_id と理由のみ。
-- - この SQL は「広めに拾う」方式です。アプリが拒否する件数と完全一致ではありません。
--   SQL で要確認 = 0 なら、アプリでも拒否 = 0 です。
--   SQL で要確認 > 0 でも、アプリでは許可されるケースがあります。
--
-- ========================================================================
-- 拒否対象（アプリの新基準）
-- ========================================================================
-- - スキーム: http, https, hxxp, hxxps, ftp, javascript, data, vbscript, file, mailto
--   - javascript:, vbscript:, mailto: は空白を挟んでも拒否
--   - data:, file: は空白なしで続く場合のみ拒否（"File: Notes" 拒否, "File : Notes" 許可）
-- - www. プレフィックス（空白を挟んでも拒否: w w w.evil）
-- - xn-- (punycode)
-- - @ (メールアドレス風) - ﹫ (U+FE6B) も含む
-- - / または // (パス風) - スラッシュに似た文字も含む
--   U+2215 (∕), U+2044 (⁄), U+29F8 (⧸), U+2571 (╱), U+FF0F (／)
-- - ホスト:ポート (例: a.com:8080, [::1]:80, ::1:80)
--   - コロンの後に空白があっても拒否 (a.com: 80)
--   - ?# が続く場合も拒否 (a.com:80?x)
-- - 制御文字、bidi 文字、不可視文字、100 コードポイント超
--
-- 許可（拒否しない）:
-- - ドットだけを含む名前（Sealith.AI, example.com, 1.2.3.4 等）
-- - 時刻/比率パターン（10:30, 16:9）
-- - 結合文字は除去してから URL 判定するため、café は許可
--
-- ========================================================================
-- 方式: 広めに拾う（少なく数えるより多く数える）
-- ========================================================================
-- アプリの正規表現を再現するのではなく、以下の文字が含まれていれば要確認とします:
--
-- 1. スラッシュ系: / ／ ∕ ⁄ ⧸ ╱ (U+002F, U+FF0F, U+2215, U+2044, U+29F8, U+2571)
-- 2. @ 系: @ ＠ ﹫ (U+0040, U+FF20, U+FE6B)
-- 3. コロン系: : ： (U+003A, U+FF1A) → スキーム/ポートの可能性
-- 4. www パターン: 'www' または全角 'ｗｗｗ' (空白を挟んでも拾う)
-- 5. punycode: xn-- または全角 ｘｎ－－ (全角ハイフン類も含む)
-- 6. IPv6 関連: [ または :: → IPv6:port の可能性
-- 7. ? または # → URL クエリ/フラグメントの可能性 (ポート判定用)
-- 8. 制御文字: U+0000–001F, U+007F–009F, U+2028, U+2029
-- 9. bidi 文字: U+202A–202E, U+2066–2069, U+200E/F, U+061C
-- 10. ゼロ幅・不可視文字: U+200B–200D, U+2060–2065, U+FEFF, U+00AD, U+180E
-- 11. 長さ > 100 コードポイント (signup の上限)
--
-- 注: ドット (.) だけの名前は要確認にしません。
-- 注: 結合文字は URL 判定前に除去するため、has_combining は除外。
-- ========================================================================

-- =============================================================================
-- Q1: 要確認の件数カウント（理由ごとの内訳付き）
-- =============================================================================
WITH org_analysis AS (
  SELECT
    o.id,
    o.name,
    -- スラッシュ系: / ／ ∕ ⁄ ⧸ ╱
    CASE WHEN o.name ~ '[/\uFF0F\u2215\u2044\u29F8\u2571]' THEN true ELSE false END AS has_slash,
    -- @ 系: @ ＠ ﹫
    CASE WHEN o.name ~ '[@\uFF20\uFE6B]' THEN true ELSE false END AS has_at,
    -- コロン系: : ：
    CASE WHEN o.name ~ '[:\uFF1A]' THEN true ELSE false END AS has_colon,
    -- www パターン (半角/全角、空白を挟んでも拾う)
    CASE WHEN o.name ~* 'w[\s]*w[\s]*w[\s]*\.' OR o.name ~ '[\uFF57][\s]*[\uFF57][\s]*[\uFF57][\s]*[\uFF0E\.]' THEN true ELSE false END AS has_www,
    -- Punycode ラベル: xn-- または全角 ｘｎ－－ (全角ハイフン類: U+FF0D, U+2010, U+2012, U+2013, U+2014)
    CASE WHEN o.name ~* '(^|[\s.])xn--[a-z0-9-]*' OR o.name ~ '[\uFF58][\uFF4E][\uFF0D\u2010\u2012\u2013\u2014-][\uFF0D\u2010\u2012\u2013\u2014-]' THEN true ELSE false END AS has_punycode,
    -- IPv6 関連: [ または ::
    CASE WHEN o.name ~ '\[' OR o.name ~ '::' THEN true ELSE false END AS has_ipv6,
    -- ? または # (URL クエリ/フラグメント)
    CASE WHEN o.name ~ '[?#]' THEN true ELSE false END AS has_url_suffix,
    -- 制御文字: U+0000–001F, U+007F–009F, U+2028, U+2029
    CASE WHEN o.name ~ '[\u0000-\u001F\u007F-\u009F\u2028\u2029]' THEN true ELSE false END AS has_control,
    -- bidi 文字: U+202A–202E, U+2066–2069, U+200E/F, U+061C
    CASE WHEN o.name ~ '[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]' THEN true ELSE false END AS has_bidi,
    -- ゼロ幅・不可視文字: U+200B–200D, U+2060–2065, U+FEFF, U+00AD, U+180E
    CASE WHEN o.name ~ '[\u200B-\u200D\u2060-\u2065\uFEFF\u00AD\u180E]' THEN true ELSE false END AS has_invisible,
    -- 長さ > 100 コードポイント
    CASE WHEN char_length(o.name) > 100 THEN true ELSE false END AS too_long
  FROM public.orgs o
)
SELECT
  'slash' AS reason,
  COUNT(*) FILTER (WHERE has_slash) AS count
FROM org_analysis
UNION ALL
SELECT
  'at' AS reason,
  COUNT(*) FILTER (WHERE has_at) AS count
FROM org_analysis
UNION ALL
SELECT
  'colon' AS reason,
  COUNT(*) FILTER (WHERE has_colon) AS count
FROM org_analysis
UNION ALL
SELECT
  'www' AS reason,
  COUNT(*) FILTER (WHERE has_www) AS count
FROM org_analysis
UNION ALL
SELECT
  'punycode' AS reason,
  COUNT(*) FILTER (WHERE has_punycode) AS count
FROM org_analysis
UNION ALL
SELECT
  'ipv6' AS reason,
  COUNT(*) FILTER (WHERE has_ipv6) AS count
FROM org_analysis
UNION ALL
SELECT
  'url_suffix' AS reason,
  COUNT(*) FILTER (WHERE has_url_suffix) AS count
FROM org_analysis
UNION ALL
SELECT
  'control' AS reason,
  COUNT(*) FILTER (WHERE has_control) AS count
FROM org_analysis
UNION ALL
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
  'too_long' AS reason,
  COUNT(*) FILTER (WHERE too_long) AS count
FROM org_analysis
UNION ALL
SELECT
  'needs_review' AS reason,
  COUNT(*) FILTER (WHERE has_slash OR has_at OR has_colon OR has_www OR
                         has_punycode OR has_ipv6 OR has_url_suffix OR
                         has_control OR has_bidi OR has_invisible OR too_long) AS count
FROM org_analysis
UNION ALL
SELECT
  'total_orgs' AS reason,
  COUNT(*) AS count
FROM org_analysis;

-- =============================================================================
-- Q2: 要確認の組織の ID と理由 (組織名そのものは出力しない)
-- =============================================================================
WITH org_analysis AS (
  SELECT
    o.id,
    o.name,
    CASE WHEN o.name ~ '[/\uFF0F\u2215\u2044\u29F8\u2571]' THEN true ELSE false END AS has_slash,
    CASE WHEN o.name ~ '[@\uFF20\uFE6B]' THEN true ELSE false END AS has_at,
    CASE WHEN o.name ~ '[:\uFF1A]' THEN true ELSE false END AS has_colon,
    CASE WHEN o.name ~* 'w[\s]*w[\s]*w[\s]*\.' OR o.name ~ '[\uFF57][\s]*[\uFF57][\s]*[\uFF57][\s]*[\uFF0E\.]' THEN true ELSE false END AS has_www,
    CASE WHEN o.name ~* '(^|[\s.])xn--[a-z0-9-]*' OR o.name ~ '[\uFF58][\uFF4E][\uFF0D\u2010\u2012\u2013\u2014-][\uFF0D\u2010\u2012\u2013\u2014-]' THEN true ELSE false END AS has_punycode,
    CASE WHEN o.name ~ '\[' OR o.name ~ '::' THEN true ELSE false END AS has_ipv6,
    CASE WHEN o.name ~ '[?#]' THEN true ELSE false END AS has_url_suffix,
    CASE WHEN o.name ~ '[\u0000-\u001F\u007F-\u009F\u2028\u2029]' THEN true ELSE false END AS has_control,
    CASE WHEN o.name ~ '[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]' THEN true ELSE false END AS has_bidi,
    CASE WHEN o.name ~ '[\u200B-\u200D\u2060-\u2065\uFEFF\u00AD\u180E]' THEN true ELSE false END AS has_invisible,
    CASE WHEN char_length(o.name) > 100 THEN true ELSE false END AS too_long
  FROM public.orgs o
)
SELECT
  id AS org_id,
  array_remove(ARRAY[
    CASE WHEN has_slash THEN 'slash' END,
    CASE WHEN has_at THEN 'at' END,
    CASE WHEN has_colon THEN 'colon' END,
    CASE WHEN has_www THEN 'www' END,
    CASE WHEN has_punycode THEN 'punycode' END,
    CASE WHEN has_ipv6 THEN 'ipv6' END,
    CASE WHEN has_url_suffix THEN 'url_suffix' END,
    CASE WHEN has_control THEN 'control' END,
    CASE WHEN has_bidi THEN 'bidi' END,
    CASE WHEN has_invisible THEN 'invisible' END,
    CASE WHEN too_long THEN 'too_long' END
  ], NULL) AS reasons
FROM org_analysis
WHERE has_slash OR has_at OR has_colon OR has_www OR
      has_punycode OR has_ipv6 OR has_url_suffix OR
      has_control OR has_bidi OR has_invisible OR too_long
ORDER BY id;

-- =============================================================================
-- 使い方:
-- 1. Q1 を実行して needs_review の件数を確認
-- 2. needs_review = 0 → フラグを ON にしても既存データに影響なし（安全）
-- 3. needs_review > 0 → 管理者が Q2 の org_id の名前を個別に確かめて判断する
--    - 既存の名前は変わらず、影響するのは新しい入力だけ
--    - colon が多い場合でも、"File : Notes" などは許可されるので
--      実際にアプリが拒否するのは一部のみ
--
-- 注意:
-- - このクエリは SELECT のみ。データは変更されません。
-- - 組織名そのものは出力されません（セキュリティ配慮）。
-- - この SQL は「広めに拾う」方式です。要確認 > 0 でも、
--   アプリでは許可されるケースがあります。
-- - ドット (.) だけを含む名前は、許可されるため要確認にしません。
--   例: "Sealith.AI", "example.com", "1.2.3.4"
-- - 結合文字 (café 等) は URL 判定前に除去するため、許可されます。
-- =============================================================================

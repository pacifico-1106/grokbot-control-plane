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
-- 方式: 広めに拾う（少なく数えるより多く数える）
-- ========================================================================
-- アプリの正規表現を再現するのではなく、以下の文字が含まれていれば要確認とします:
--
-- 1. ドット系: . 。 ． ｡ (U+002E, U+3002, U+FF0E, U+FF61)
--    → ドメインに見える可能性
-- 2. コロン系: : ： (U+003A, U+FF1A)
--    → URL スキームの可能性
-- 3. スラッシュ系: / ／ (U+002F, U+FF0F)
--    → URL パスの可能性
-- 4. @
--    → メールアドレスの可能性
-- 5. 制御文字: U+0000–001F, U+007F–009F, U+2028, U+2029
-- 6. bidi 文字: U+202A–202E, U+2066–2069, U+200E/F, U+061C
-- 7. ゼロ幅・不可視文字: U+200B–200D, U+2060–2065, U+FEFF, U+00AD, U+180E
-- 8. 結合文字: U+0300–036F, U+1AB0–1AFF, U+1DC0–1DFF, U+20D0–20FF, U+FE20–FE2F
--    (Postgres では \p{M} が使えないため、主要な結合文字範囲を列挙)
-- 9. 全角英数字: U+FF01–FF5E
--    → 正規化前は通るが、正規化後に URL として拒否される可能性
-- 10. 長さ > 100 コードポイント (signup の上限)
--
-- この方式でも拾えないケース:
-- - アプリが空白を除去してからスキーム判定するケース（例: "ht tp://"）は
--   SQL では検出困難です。コロン系で間接的に拾います。
-- - NFKC 正規化で変換される特殊文字（例: ℃ → °C）は SQL では追跡困難です。
-- ========================================================================

-- =============================================================================
-- Q1: 要確認の件数カウント（理由ごとの内訳付き）
-- =============================================================================
WITH org_analysis AS (
  SELECT
    o.id,
    o.name,
    -- ドット系: . 。 ． ｡
    CASE WHEN o.name ~ '[\.\u3002\uFF0E\uFF61]' THEN true ELSE false END AS has_dot,
    -- コロン系: : ：
    CASE WHEN o.name ~ '[:\uFF1A]' THEN true ELSE false END AS has_colon,
    -- スラッシュ系: / ／
    CASE WHEN o.name ~ '[/\uFF0F]' THEN true ELSE false END AS has_slash,
    -- @
    CASE WHEN o.name ~ '@' THEN true ELSE false END AS has_at,
    -- 制御文字: U+0000–001F, U+007F–009F, U+2028, U+2029
    CASE WHEN o.name ~ '[\u0000-\u001F\u007F-\u009F\u2028\u2029]' THEN true ELSE false END AS has_control,
    -- bidi 文字: U+202A–202E, U+2066–2069, U+200E/F, U+061C
    CASE WHEN o.name ~ '[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]' THEN true ELSE false END AS has_bidi,
    -- ゼロ幅・不可視文字: U+200B–200D, U+2060–2065, U+FEFF, U+00AD, U+180E
    CASE WHEN o.name ~ '[\u200B-\u200D\u2060-\u2065\uFEFF\u00AD\u180E]' THEN true ELSE false END AS has_invisible,
    -- 結合文字: U+0300–036F, U+1AB0–1AFF, U+1DC0–1DFF, U+20D0–20FF, U+FE20–FE2F
    CASE WHEN o.name ~ '[\u0300-\u036F\u1AB0-\u1AFF\u1DC0-\u1DFF\u20D0-\u20FF\uFE20-\uFE2F]' THEN true ELSE false END AS has_combining,
    -- 全角英数字: U+FF01–FF5E
    CASE WHEN o.name ~ '[\uFF01-\uFF5E]' THEN true ELSE false END AS has_fullwidth,
    -- 長さ > 100 コードポイント
    -- Postgres の char_length は code points を数える
    CASE WHEN char_length(o.name) > 100 THEN true ELSE false END AS too_long
  FROM public.orgs o
)
SELECT
  'dot' AS reason,
  COUNT(*) FILTER (WHERE has_dot) AS count
FROM org_analysis
UNION ALL
SELECT
  'colon' AS reason,
  COUNT(*) FILTER (WHERE has_colon) AS count
FROM org_analysis
UNION ALL
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
  'combining' AS reason,
  COUNT(*) FILTER (WHERE has_combining) AS count
FROM org_analysis
UNION ALL
SELECT
  'fullwidth' AS reason,
  COUNT(*) FILTER (WHERE has_fullwidth) AS count
FROM org_analysis
UNION ALL
SELECT
  'too_long' AS reason,
  COUNT(*) FILTER (WHERE too_long) AS count
FROM org_analysis
UNION ALL
SELECT
  'needs_review' AS reason,
  COUNT(*) FILTER (WHERE has_dot OR has_colon OR has_slash OR has_at OR
                         has_control OR has_bidi OR has_invisible OR
                         has_combining OR has_fullwidth OR too_long) AS count
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
    CASE WHEN o.name ~ '[\.\u3002\uFF0E\uFF61]' THEN true ELSE false END AS has_dot,
    CASE WHEN o.name ~ '[:\uFF1A]' THEN true ELSE false END AS has_colon,
    CASE WHEN o.name ~ '[/\uFF0F]' THEN true ELSE false END AS has_slash,
    CASE WHEN o.name ~ '@' THEN true ELSE false END AS has_at,
    CASE WHEN o.name ~ '[\u0000-\u001F\u007F-\u009F\u2028\u2029]' THEN true ELSE false END AS has_control,
    CASE WHEN o.name ~ '[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]' THEN true ELSE false END AS has_bidi,
    CASE WHEN o.name ~ '[\u200B-\u200D\u2060-\u2065\uFEFF\u00AD\u180E]' THEN true ELSE false END AS has_invisible,
    CASE WHEN o.name ~ '[\u0300-\u036F\u1AB0-\u1AFF\u1DC0-\u1DFF\u20D0-\u20FF\uFE20-\uFE2F]' THEN true ELSE false END AS has_combining,
    CASE WHEN o.name ~ '[\uFF01-\uFF5E]' THEN true ELSE false END AS has_fullwidth,
    CASE WHEN char_length(o.name) > 100 THEN true ELSE false END AS too_long
  FROM public.orgs o
)
SELECT
  id AS org_id,
  array_remove(ARRAY[
    CASE WHEN has_dot THEN 'dot' END,
    CASE WHEN has_colon THEN 'colon' END,
    CASE WHEN has_slash THEN 'slash' END,
    CASE WHEN has_at THEN 'at' END,
    CASE WHEN has_control THEN 'control' END,
    CASE WHEN has_bidi THEN 'bidi' END,
    CASE WHEN has_invisible THEN 'invisible' END,
    CASE WHEN has_combining THEN 'combining' END,
    CASE WHEN has_fullwidth THEN 'fullwidth' END,
    CASE WHEN too_long THEN 'too_long' END
  ], NULL) AS reasons
FROM org_analysis
WHERE has_dot OR has_colon OR has_slash OR has_at OR
      has_control OR has_bidi OR has_invisible OR
      has_combining OR has_fullwidth OR too_long
ORDER BY id;

-- =============================================================================
-- 使い方:
-- 1. Q1 を実行して needs_review の件数を確認
-- 2. needs_review = 0 → フラグを ON にしても既存データに影響なし（安全）
-- 3. needs_review > 0 → 管理者が Q2 の org_id の名前を個別に確かめて判断する
--    - 既存の名前は変わらず、影響するのは新しい入力だけ
--    - dot / colon が多い場合でも、"Co., Ltd." などは許可されるので
--      実際にアプリが拒否するのは一部のみ
--
-- 注意:
-- - このクエリは SELECT のみ。データは変更されません。
-- - 組織名そのものは出力されません（セキュリティ配慮）。
-- - この SQL は「広めに拾う」方式です。要確認 > 0 でも、
--   アプリでは許可されるケースがあります。
-- =============================================================================

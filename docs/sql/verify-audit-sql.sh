#!/bin/bash
# verify-audit-sql.sh
#
# ============================================================================
# 警告: 本番や共有 DB では実行しないこと。ローカルの使い捨ての Postgres 専用。
# ============================================================================
#
# Verify that the org-name-strict-audit.sql catches all rejection samples.
#
# Usage: ./verify-audit-sql.sh
# Requires: Postgres 16+ (uses char_length, Unicode escapes)
#
# This script:
# 1. Creates a unique temporary schema (not touching public.orgs)
# 2. Creates orgs table in that schema
# 3. Inserts test samples with expected categories
# 4. Runs the audit SQL against that table
# 5. Verifies each sample against its expected category
# 6. Drops the temporary schema
#
# Expected categories:
# - "reject": App rejects this input. SQL must flag it as needs_review.
# - "broad": App allows but SQL catches broadly. SQL should flag it as needs_review.
# - "allow": App allows and SQL should NOT flag it as needs_review.
#
# Safety:
# - Only runs on localhost/127.0.0.1/Unix socket
# - Rejects PGHOSTADDR, PGSERVICE, PGSERVICEFILE environment variables
# - Uses temporary schema, never touches public.orgs
# - DATABASE_URL and SUPABASE_* environment variables are NOT used
#
# Exit codes:
#   0 - All samples match expected
#   1 - Some samples mismatch
#   2 - psql not found
#   3 - Connection refused (not localhost)
#   4 - Forbidden environment variable set (PGHOSTADDR, PGSERVICE, PGSERVICEFILE)

set -e

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AUDIT_SQL_PATH="$SCRIPT_DIR/org-name-strict-audit.sql"

# Generate unique schema name
SCHEMA_NAME="audit_test_$(date +%s)_$$"

# Check for forbidden environment variables
if [ -n "$PGHOSTADDR" ]; then
  echo "ERROR: PGHOSTADDR is set. This script only runs on localhost."
  echo "For safety, PGHOSTADDR connections are not allowed."
  exit 4
fi

if [ -n "$PGSERVICE" ]; then
  echo "ERROR: PGSERVICE is set. This script only runs on localhost."
  echo "For safety, PGSERVICE connections are not allowed."
  exit 4
fi

if [ -n "$PGSERVICEFILE" ]; then
  echo "ERROR: PGSERVICEFILE is set. This script only runs on localhost."
  echo "For safety, PGSERVICEFILE connections are not allowed."
  exit 4
fi

# Unset potentially dangerous variables when calling psql
unset PGHOSTADDR PGSERVICE PGSERVICEFILE

# Check if psql is available
if ! command -v psql &> /dev/null; then
  echo "ERROR: psql not found."
  echo "Please install PostgreSQL client tools or run this in an environment with psql."
  echo "This script requires PostgreSQL 16+ for Unicode escape support."
  exit 2
fi

# Parse connection parameters (only allow localhost)
# Default to empty (Unix socket) if not set
PGHOST="${PGHOST:-}"
PGPORT="${PGPORT:-5432}"
PGUSER="${PGUSER:-postgres}"
PGDATABASE="${PGDATABASE:-postgres}"

# Check if host is localhost (safety check)
case "$PGHOST" in
  localhost|127.0.0.1|""|/var/run/postgresql|/tmp)
    # OK - local connection
    ;;
  *)
    echo "ERROR: This script only runs on localhost."
    echo "Current PGHOST: $PGHOST"
    echo "For safety, remote database connections are not allowed."
    echo ""
    echo "To use a local Postgres, set:"
    echo "  unset PGHOST  # or export PGHOST=localhost"
    echo "  export PGUSER=postgres"
    echo "  export PGDATABASE=postgres"
    exit 3
    ;;
esac

# Build psql connection args
PSQL_ARGS=()
if [ -n "$PGHOST" ]; then
  PSQL_ARGS+=("-h" "$PGHOST")
fi
PSQL_ARGS+=("-p" "$PGPORT" "-U" "$PGUSER" "-d" "$PGDATABASE")

echo "============================================================"
echo "verify-audit-sql.sh"
echo "============================================================"
echo "Host: $PGHOST"
echo "Port: $PGPORT"
echo "User: $PGUSER"
echo "Database: $PGDATABASE"
echo "Temporary schema: $SCHEMA_NAME"
echo "Audit SQL path: $AUDIT_SQL_PATH"
echo "============================================================"
echo ""

# Check if audit SQL file exists
if [ ! -f "$AUDIT_SQL_PATH" ]; then
  echo "ERROR: Audit SQL file not found: $AUDIT_SQL_PATH"
  exit 1
fi

# Create SQL file with temporary schema
cat << 'EOF' > /tmp/audit-test-$$.sql
-- Create temporary schema (unique per run)
DROP SCHEMA IF EXISTS SCHEMA_PLACEHOLDER CASCADE;
CREATE SCHEMA SCHEMA_PLACEHOLDER;

-- Create orgs table in temporary schema with expected category
CREATE TABLE SCHEMA_PLACEHOLDER.orgs (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  expected TEXT NOT NULL CHECK (expected IN ('reject', 'broad', 'allow'))
);

-- =============================================================================
-- Test samples: "reject" = app rejects, "broad" = app allows but SQL catches,
--               "allow" = app allows and SQL should not flag
-- =============================================================================

-- Control characters (reject)
INSERT INTO SCHEMA_PLACEHOLDER.orgs (name, expected) VALUES ('株式会社' || E'\r\n' || 'テスト', 'reject');
INSERT INTO SCHEMA_PLACEHOLDER.orgs (name, expected) VALUES ('Test' || E'\u0001' || 'Org', 'reject');

-- Bidi characters (reject)
INSERT INTO SCHEMA_PLACEHOLDER.orgs (name, expected) VALUES ('Test' || E'\u202E' || 'Org', 'reject');
INSERT INTO SCHEMA_PLACEHOLDER.orgs (name, expected) VALUES ('Test' || E'\u2066' || 'Corp', 'reject');
INSERT INTO SCHEMA_PLACEHOLDER.orgs (name, expected) VALUES ('Test' || E'\u200E' || 'Corp', 'reject');
INSERT INTO SCHEMA_PLACEHOLDER.orgs (name, expected) VALUES ('Test' || E'\u061C' || 'Corp', 'reject');

-- Zero-width / invisible characters (reject)
INSERT INTO SCHEMA_PLACEHOLDER.orgs (name, expected) VALUES ('Test' || E'\u200B' || 'Org', 'reject');
INSERT INTO SCHEMA_PLACEHOLDER.orgs (name, expected) VALUES ('Test' || E'\u200C' || 'Org', 'reject');
INSERT INTO SCHEMA_PLACEHOLDER.orgs (name, expected) VALUES ('Test' || E'\u200D' || 'Org', 'reject');
INSERT INTO SCHEMA_PLACEHOLDER.orgs (name, expected) VALUES ('Test' || E'\u2060' || 'Corp', 'reject');
INSERT INTO SCHEMA_PLACEHOLDER.orgs (name, expected) VALUES ('Test' || E'\uFEFF' || 'Corp', 'reject');
INSERT INTO SCHEMA_PLACEHOLDER.orgs (name, expected) VALUES ('Test' || E'\u00AD' || 'Corp', 'reject');
INSERT INTO SCHEMA_PLACEHOLDER.orgs (name, expected) VALUES ('Test' || E'\u180E' || 'Corp', 'reject');
INSERT INTO SCHEMA_PLACEHOLDER.orgs (name, expected) VALUES ('Test' || E'\u2061' || 'Corp', 'reject');
INSERT INTO SCHEMA_PLACEHOLDER.orgs (name, expected) VALUES ('Test' || E'\u2065' || 'Corp', 'reject');

-- URL schemes (reject)
INSERT INTO SCHEMA_PLACEHOLDER.orgs (name, expected) VALUES ('http://example.com', 'reject');
INSERT INTO SCHEMA_PLACEHOLDER.orgs (name, expected) VALUES ('https://evil.com', 'reject');
INSERT INTO SCHEMA_PLACEHOLDER.orgs (name, expected) VALUES ('javascript:alert(1)', 'reject');
INSERT INTO SCHEMA_PLACEHOLDER.orgs (name, expected) VALUES ('data:text/html,<script>', 'reject');
INSERT INTO SCHEMA_PLACEHOLDER.orgs (name, expected) VALUES ('hxxp://example.com', 'reject');
INSERT INTO SCHEMA_PLACEHOLDER.orgs (name, expected) VALUES ('ftp://ftp.example.com', 'reject');

-- Whitespace-separated dangerous schemes (reject)
INSERT INTO SCHEMA_PLACEHOLDER.orgs (name, expected) VALUES ('java script:alert(1)', 'reject');
INSERT INTO SCHEMA_PLACEHOLDER.orgs (name, expected) VALUES ('mail to:admin', 'reject');
INSERT INTO SCHEMA_PLACEHOLDER.orgs (name, expected) VALUES ('vb script:msgbox', 'reject');
INSERT INTO SCHEMA_PLACEHOLDER.orgs (name, expected) VALUES (E'\uFF4A\uFF41\uFF56\uFF41 \uFF53\uFF43\uFF52\uFF49\uFF50\uFF54\uFF1Ax', 'reject');
INSERT INTO SCHEMA_PLACEHOLDER.orgs (name, expected) VALUES ('Mail To: John', 'reject');
INSERT INTO SCHEMA_PLACEHOLDER.orgs (name, expected) VALUES ('Java Script: Guide', 'reject');
INSERT INTO SCHEMA_PLACEHOLDER.orgs (name, expected) VALUES ('File: Notes', 'reject');

-- www. prefix (reject)
INSERT INTO SCHEMA_PLACEHOLDER.orgs (name, expected) VALUES ('www.example.com', 'reject');
INSERT INTO SCHEMA_PLACEHOLDER.orgs (name, expected) VALUES (E'\uFF57\uFF57\uFF57\uFF0Eevil.com', 'reject');
INSERT INTO SCHEMA_PLACEHOLDER.orgs (name, expected) VALUES ('w w w.evil.com', 'reject');

-- @ sign (reject)
INSERT INTO SCHEMA_PLACEHOLDER.orgs (name, expected) VALUES ('a@b', 'reject');
INSERT INTO SCHEMA_PLACEHOLDER.orgs (name, expected) VALUES ('admin@example.com', 'reject');
INSERT INTO SCHEMA_PLACEHOLDER.orgs (name, expected) VALUES (E'a\uFF20b', 'reject');
INSERT INTO SCHEMA_PLACEHOLDER.orgs (name, expected) VALUES (E'a\uFE6Bb', 'reject');

-- / and // (reject)
INSERT INTO SCHEMA_PLACEHOLDER.orgs (name, expected) VALUES ('a/b', 'reject');
INSERT INTO SCHEMA_PLACEHOLDER.orgs (name, expected) VALUES ('//evil', 'reject');
INSERT INTO SCHEMA_PLACEHOLDER.orgs (name, expected) VALUES (E'\uFF0F\uFF0Fevil', 'reject');
INSERT INTO SCHEMA_PLACEHOLDER.orgs (name, expected) VALUES (E'a\u2215b', 'reject');
INSERT INTO SCHEMA_PLACEHOLDER.orgs (name, expected) VALUES (E'a\u2044b', 'reject');
INSERT INTO SCHEMA_PLACEHOLDER.orgs (name, expected) VALUES (E'a\u29F8b', 'reject');
INSERT INTO SCHEMA_PLACEHOLDER.orgs (name, expected) VALUES (E'a\u2571b', 'reject');

-- Host with port (reject)
INSERT INTO SCHEMA_PLACEHOLDER.orgs (name, expected) VALUES ('evil.com:8080', 'reject');
INSERT INTO SCHEMA_PLACEHOLDER.orgs (name, expected) VALUES ('1.2.3.4:80', 'reject');
INSERT INTO SCHEMA_PLACEHOLDER.orgs (name, expected) VALUES ('[::1]:80', 'reject');
INSERT INTO SCHEMA_PLACEHOLDER.orgs (name, expected) VALUES ('::1:80', 'reject');
INSERT INTO SCHEMA_PLACEHOLDER.orgs (name, expected) VALUES ('a.com:80?x', 'reject');
INSERT INTO SCHEMA_PLACEHOLDER.orgs (name, expected) VALUES ('a.com:80#x', 'reject');
INSERT INTO SCHEMA_PLACEHOLDER.orgs (name, expected) VALUES ('a.com: 80', 'reject');
INSERT INTO SCHEMA_PLACEHOLDER.orgs (name, expected) VALUES (E'a.com\uFF1A80', 'reject');
INSERT INTO SCHEMA_PLACEHOLDER.orgs (name, expected) VALUES ('株式会社a.com:443', 'reject');

-- LOW-2: Port followed by non-digit (reject)
INSERT INTO SCHEMA_PLACEHOLDER.orgs (name, expected) VALUES ('a.com:8080foo', 'reject');
INSERT INTO SCHEMA_PLACEHOLDER.orgs (name, expected) VALUES ('evil.com:8080.', 'reject');

-- Punycode (reject)
INSERT INTO SCHEMA_PLACEHOLDER.orgs (name, expected) VALUES ('xn--n3h', 'reject');
INSERT INTO SCHEMA_PLACEHOLDER.orgs (name, expected) VALUES ('xn--nxasmq5b', 'reject');

-- Length > 100 (reject)
INSERT INTO SCHEMA_PLACEHOLDER.orgs (name, expected) VALUES (repeat('あ', 101), 'reject');

-- =============================================================================
-- "broad" samples: app allows but SQL catches (colon for time/ratio patterns)
-- =============================================================================
INSERT INTO SCHEMA_PLACEHOLDER.orgs (name, expected) VALUES ('株式会社 3:2', 'broad');
INSERT INTO SCHEMA_PLACEHOLDER.orgs (name, expected) VALUES ('10:30 Labs', 'broad');
INSERT INTO SCHEMA_PLACEHOLDER.orgs (name, expected) VALUES ('Ratio 16:9 Inc', 'broad');
INSERT INTO SCHEMA_PLACEHOLDER.orgs (name, expected) VALUES ('File : Notes', 'broad');

-- =============================================================================
-- "allow" samples: app allows and SQL should NOT flag
-- =============================================================================
INSERT INTO SCHEMA_PLACEHOLDER.orgs (name, expected) VALUES ('Sealith.AI', 'allow');
INSERT INTO SCHEMA_PLACEHOLDER.orgs (name, expected) VALUES ('Next.js 勉強会', 'allow');
INSERT INTO SCHEMA_PLACEHOLDER.orgs (name, expected) VALUES ('株式会社 A.B.C', 'allow');
INSERT INTO SCHEMA_PLACEHOLDER.orgs (name, expected) VALUES ('example.com', 'allow');
INSERT INTO SCHEMA_PLACEHOLDER.orgs (name, expected) VALUES ('1.2.3.4', 'allow');
INSERT INTO SCHEMA_PLACEHOLDER.orgs (name, expected) VALUES ('株式会社malware.com', 'allow');
INSERT INTO SCHEMA_PLACEHOLDER.orgs (name, expected) VALUES ('note.com株式会社', 'allow');
INSERT INTO SCHEMA_PLACEHOLDER.orgs (name, expected) VALUES ('日本語.com', 'allow');
INSERT INTO SCHEMA_PLACEHOLDER.orgs (name, expected) VALUES ('T.K. Holdings', 'allow');
INSERT INTO SCHEMA_PLACEHOLDER.orgs (name, expected) VALUES ('Version 2.0 Inc', 'allow');
INSERT INTO SCHEMA_PLACEHOLDER.orgs (name, expected) VALUES ('A&B Co., Ltd.', 'allow');
INSERT INTO SCHEMA_PLACEHOLDER.orgs (name, expected) VALUES ('TOKYO307 Inc.', 'allow');
INSERT INTO SCHEMA_PLACEHOLDER.orgs (name, expected) VALUES ('株式会社スペースツリー', 'allow');
INSERT INTO SCHEMA_PLACEHOLDER.orgs (name, expected) VALUES ('Dr. Smith Associates', 'allow');
INSERT INTO SCHEMA_PLACEHOLDER.orgs (name, expected) VALUES ('cafe' || E'\u0301', 'allow');

-- aa:bb:cc:80 - app allows (no ::), but SQL flags (has colon) → broad
INSERT INTO SCHEMA_PLACEHOLDER.orgs (name, expected) VALUES ('aa:bb:cc:80', 'broad');

-- Count samples by category
SELECT 'Inserted samples by category:' AS info;
SELECT expected, COUNT(*) AS count FROM SCHEMA_PLACEHOLDER.orgs GROUP BY expected ORDER BY expected;

EOF

# Replace SCHEMA_PLACEHOLDER with actual schema name
sed -i "s/SCHEMA_PLACEHOLDER/$SCHEMA_NAME/g" /tmp/audit-test-$$.sql

# Now add the audit SQL, replacing public.orgs with our temp schema
echo "" >> /tmp/audit-test-$$.sql
echo "-- Audit SQL (adapted to use temporary schema)" >> /tmp/audit-test-$$.sql
echo "SET search_path TO $SCHEMA_NAME, public;" >> /tmp/audit-test-$$.sql
echo "" >> /tmp/audit-test-$$.sql

# Extract and modify the audit SQL (replace public.orgs with orgs, which will use search_path)
sed 's/public\.orgs/orgs/g' "$AUDIT_SQL_PATH" >> /tmp/audit-test-$$.sql

# Add verification query
cat << EOF >> /tmp/audit-test-$$.sql

-- =============================================================================
-- Verification: check each sample against expected category
-- =============================================================================
SET search_path TO $SCHEMA_NAME, public;

SELECT '=== VERIFICATION RESULTS ===' AS info;

-- Show mismatches
WITH org_analysis AS (
  SELECT
    o.id,
    o.expected,
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
  FROM orgs o
),
flagged AS (
  SELECT
    id,
    expected,
    (has_slash OR has_at OR has_colon OR has_www OR
     has_punycode OR has_ipv6 OR has_url_suffix OR
     has_control OR has_bidi OR has_invisible OR too_long) AS needs_review
  FROM org_analysis
)
SELECT 'MISMATCH' AS status, id, expected,
       CASE WHEN needs_review THEN 'flagged' ELSE 'not_flagged' END AS actual
FROM flagged
WHERE (expected = 'reject' AND NOT needs_review)
   OR (expected = 'broad' AND NOT needs_review)
   OR (expected = 'allow' AND needs_review);

-- Count results
SELECT 'SUMMARY' AS info;
WITH org_analysis AS (
  SELECT
    o.id,
    o.expected,
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
  FROM orgs o
),
flagged AS (
  SELECT
    id,
    expected,
    (has_slash OR has_at OR has_colon OR has_www OR
     has_punycode OR has_ipv6 OR has_url_suffix OR
     has_control OR has_bidi OR has_invisible OR too_long) AS needs_review
  FROM org_analysis
)
SELECT
  COUNT(*) FILTER (WHERE expected = 'reject') AS total_reject,
  COUNT(*) FILTER (WHERE expected = 'reject' AND needs_review) AS reject_flagged,
  COUNT(*) FILTER (WHERE expected = 'broad') AS total_broad,
  COUNT(*) FILTER (WHERE expected = 'broad' AND needs_review) AS broad_flagged,
  COUNT(*) FILTER (WHERE expected = 'allow') AS total_allow,
  COUNT(*) FILTER (WHERE expected = 'allow' AND NOT needs_review) AS allow_not_flagged,
  COUNT(*) AS total_samples
FROM flagged;

-- Exit status: output mismatch count
WITH org_analysis AS (
  SELECT
    o.id,
    o.expected,
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
  FROM orgs o
),
flagged AS (
  SELECT
    id,
    expected,
    (has_slash OR has_at OR has_colon OR has_www OR
     has_punycode OR has_ipv6 OR has_url_suffix OR
     has_control OR has_bidi OR has_invisible OR too_long) AS needs_review
  FROM org_analysis
)
SELECT 'MISMATCH_COUNT' AS key,
       COUNT(*) AS value
FROM flagged
WHERE (expected = 'reject' AND NOT needs_review)
   OR (expected = 'broad' AND NOT needs_review)
   OR (expected = 'allow' AND needs_review);

-- Cleanup: drop temporary schema
DROP SCHEMA $SCHEMA_NAME CASCADE;

-- Reset search_path
SET search_path TO public;
EOF

# Capture public schema state before
echo "Checking public schema state before test..."
PUBLIC_BEFORE=$(psql "${PSQL_ARGS[@]}" -t -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'" 2>/dev/null || echo "0")
echo "Tables in public schema: $PUBLIC_BEFORE"
echo ""

# Run with psql
echo "Running SQL..."
echo ""
OUTPUT=$(psql "${PSQL_ARGS[@]}" -f /tmp/audit-test-$$.sql 2>&1)
echo "$OUTPUT"
echo ""

# Capture public schema state after
echo "Checking public schema state after test..."
PUBLIC_AFTER=$(psql "${PSQL_ARGS[@]}" -t -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'" 2>/dev/null || echo "0")
echo "Tables in public schema: $PUBLIC_AFTER"
echo ""

# Verify public schema unchanged
if [ "$PUBLIC_BEFORE" = "$PUBLIC_AFTER" ]; then
  echo "✓ Public schema unchanged"
else
  echo "✗ WARNING: Public schema changed! Before: $PUBLIC_BEFORE, After: $PUBLIC_AFTER"
fi

# Extract results from the summary row (the row after the header)
# Header: total_reject | reject_flagged | total_broad | broad_flagged | total_allow | allow_not_flagged | total_samples
SUMMARY_LINE=$(echo "$OUTPUT" | grep -A2 "total_reject" | tail -1 | tr -d ' ')
TOTAL_REJECT=$(echo "$SUMMARY_LINE" | cut -d'|' -f1)
REJECT_FLAGGED=$(echo "$SUMMARY_LINE" | cut -d'|' -f2)
TOTAL_BROAD=$(echo "$SUMMARY_LINE" | cut -d'|' -f3)
BROAD_FLAGGED=$(echo "$SUMMARY_LINE" | cut -d'|' -f4)
TOTAL_ALLOW=$(echo "$SUMMARY_LINE" | cut -d'|' -f5)
ALLOW_NOT_FLAGGED=$(echo "$SUMMARY_LINE" | cut -d'|' -f6)
TOTAL_SAMPLES=$(echo "$SUMMARY_LINE" | cut -d'|' -f7)
# Get the line containing the actual mismatch count (skip header, get data row)
MISMATCH_LINE=$(echo "$OUTPUT" | grep "MISMATCH_COUNT" | grep -v "key" | tr -d ' ')
MISMATCH_COUNT=$(echo "$MISMATCH_LINE" | cut -d'|' -f2)

echo ""
echo "============================================================"
echo "Results:"
echo "  Total samples: $TOTAL_SAMPLES"
echo ""
echo "  Rejected by app (should be flagged):"
echo "    Total: $TOTAL_REJECT"
echo "    Flagged: $REJECT_FLAGGED"
echo ""
echo "  Broad catch (app allows, SQL flags):"
echo "    Total: $TOTAL_BROAD"
echo "    Flagged: $BROAD_FLAGGED"
echo ""
echo "  Allowed (should not be flagged):"
echo "    Total: $TOTAL_ALLOW"
echo "    Not flagged: $ALLOW_NOT_FLAGGED"
echo ""
echo "  Mismatches: $MISMATCH_COUNT"
echo "============================================================"

# Cleanup temp file
rm -f /tmp/audit-test-$$.sql

# Check for mismatches
if [ "$MISMATCH_COUNT" = "0" ]; then
  echo "✓ All samples match expected!"
  echo "✓ Test passed!"
  exit 0
else
  echo "✗ $MISMATCH_COUNT sample(s) did not match expected!"
  exit 1
fi

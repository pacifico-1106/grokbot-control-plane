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
# 3. Runs the audit SQL against that table
# 4. Verifies all samples are flagged as needs_review
# 5. Drops the temporary schema
#
# Safety:
# - Only runs on localhost/127.0.0.1/Unix socket
# - Rejects PGHOSTADDR, PGSERVICE, PGSERVICEFILE environment variables
# - Uses temporary schema, never touches public.orgs
# - DATABASE_URL and SUPABASE_* environment variables are NOT used
#
# Exit codes:
#   0 - All samples caught
#   1 - Some samples missed
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
cat << EOF > /tmp/audit-test-$$.sql
-- Create temporary schema (unique per run)
DROP SCHEMA IF EXISTS $SCHEMA_NAME CASCADE;
CREATE SCHEMA $SCHEMA_NAME;

-- Create orgs table in temporary schema
CREATE TABLE $SCHEMA_NAME.orgs (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL
);

-- =============================================================================
-- Test samples that should be REJECTED by the app (flagged as needs_review)
-- =============================================================================

-- Control characters
-- Note: U+0000 (null) is not valid in PostgreSQL strings, skip it
INSERT INTO $SCHEMA_NAME.orgs (name) VALUES ('株式会社' || E'\r\n' || 'テスト');    -- CRLF
INSERT INTO $SCHEMA_NAME.orgs (name) VALUES ('Test' || E'\u0001' || 'Org');        -- SOH (control char)

-- Bidi characters
INSERT INTO $SCHEMA_NAME.orgs (name) VALUES ('Test' || E'\u202E' || 'Org');  -- RLO
INSERT INTO $SCHEMA_NAME.orgs (name) VALUES ('Test' || E'\u2066' || 'Corp'); -- LRI
INSERT INTO $SCHEMA_NAME.orgs (name) VALUES ('Test' || E'\u200E' || 'Corp'); -- LRM
INSERT INTO $SCHEMA_NAME.orgs (name) VALUES ('Test' || E'\u061C' || 'Corp'); -- ALM

-- Zero-width / invisible characters
INSERT INTO $SCHEMA_NAME.orgs (name) VALUES ('Test' || E'\u200B' || 'Org');  -- ZWSP
INSERT INTO $SCHEMA_NAME.orgs (name) VALUES ('Test' || E'\u200C' || 'Org');  -- ZWNJ
INSERT INTO $SCHEMA_NAME.orgs (name) VALUES ('Test' || E'\u200D' || 'Org');  -- ZWJ
INSERT INTO $SCHEMA_NAME.orgs (name) VALUES ('Test' || E'\u2060' || 'Corp'); -- Word Joiner
INSERT INTO $SCHEMA_NAME.orgs (name) VALUES ('Test' || E'\uFEFF' || 'Corp'); -- BOM
INSERT INTO $SCHEMA_NAME.orgs (name) VALUES ('Test' || E'\u00AD' || 'Corp'); -- Soft Hyphen
INSERT INTO $SCHEMA_NAME.orgs (name) VALUES ('Test' || E'\u180E' || 'Corp'); -- Mongolian Vowel Separator
INSERT INTO $SCHEMA_NAME.orgs (name) VALUES ('Test' || E'\u2061' || 'Corp'); -- Function Application
INSERT INTO $SCHEMA_NAME.orgs (name) VALUES ('Test' || E'\u2065' || 'Corp'); -- U+2065

-- URL schemes (has : and /)
INSERT INTO $SCHEMA_NAME.orgs (name) VALUES ('http://example.com');
INSERT INTO $SCHEMA_NAME.orgs (name) VALUES ('https://evil.com');
INSERT INTO $SCHEMA_NAME.orgs (name) VALUES ('javascript:alert(1)');
INSERT INTO $SCHEMA_NAME.orgs (name) VALUES ('data:text/html,<script>');
INSERT INTO $SCHEMA_NAME.orgs (name) VALUES ('hxxp://example.com');
INSERT INTO $SCHEMA_NAME.orgs (name) VALUES ('ftp://ftp.example.com');

-- www. prefix
INSERT INTO $SCHEMA_NAME.orgs (name) VALUES ('www.example.com');
INSERT INTO $SCHEMA_NAME.orgs (name) VALUES (E'\uFF57\uFF57\uFF57\uFF0Eevil.com');  -- ｗｗｗ．

-- @ sign
INSERT INTO $SCHEMA_NAME.orgs (name) VALUES ('a@b');
INSERT INTO $SCHEMA_NAME.orgs (name) VALUES ('admin@example.com');
INSERT INTO $SCHEMA_NAME.orgs (name) VALUES (E'a\uFF20b');  -- ＠ fullwidth

-- / and //
INSERT INTO $SCHEMA_NAME.orgs (name) VALUES ('a/b');
INSERT INTO $SCHEMA_NAME.orgs (name) VALUES ('//evil');
INSERT INTO $SCHEMA_NAME.orgs (name) VALUES (E'\uFF0F\uFF0Fevil');  -- ／／ fullwidth

-- Host with port (has :)
INSERT INTO $SCHEMA_NAME.orgs (name) VALUES ('evil.com:8080');
INSERT INTO $SCHEMA_NAME.orgs (name) VALUES ('1.2.3.4:80');

-- Punycode
INSERT INTO $SCHEMA_NAME.orgs (name) VALUES ('xn--n3h');
INSERT INTO $SCHEMA_NAME.orgs (name) VALUES ('xn--nxasmq5b');

-- Combining characters
INSERT INTO $SCHEMA_NAME.orgs (name) VALUES ('h' || E'\u0301' || 'ttp://example.com');

-- Length > 100
INSERT INTO $SCHEMA_NAME.orgs (name) VALUES (repeat('あ', 101));

-- =============================================================================
-- Test samples that should be ALLOWED by the app (NOT flagged as needs_review)
-- These have dots but no dangerous patterns
-- =============================================================================
-- Note: These are inserted separately and counted as "allowed_samples"

-- Dot-containing company names (now allowed)
INSERT INTO $SCHEMA_NAME.orgs (name) VALUES ('Sealith.AI');
INSERT INTO $SCHEMA_NAME.orgs (name) VALUES ('Next.js 勉強会');
INSERT INTO $SCHEMA_NAME.orgs (name) VALUES ('株式会社 A.B.C');
INSERT INTO $SCHEMA_NAME.orgs (name) VALUES ('example.com');
INSERT INTO $SCHEMA_NAME.orgs (name) VALUES ('1.2.3.4');
INSERT INTO $SCHEMA_NAME.orgs (name) VALUES ('株式会社malware.com');
INSERT INTO $SCHEMA_NAME.orgs (name) VALUES ('note.com株式会社');
INSERT INTO $SCHEMA_NAME.orgs (name) VALUES ('日本語.com');
INSERT INTO $SCHEMA_NAME.orgs (name) VALUES ('T.K. Holdings');
INSERT INTO $SCHEMA_NAME.orgs (name) VALUES ('Version 2.0 Inc');
INSERT INTO $SCHEMA_NAME.orgs (name) VALUES ('A&B Co., Ltd.');
INSERT INTO $SCHEMA_NAME.orgs (name) VALUES ('TOKYO307 Inc.');
INSERT INTO $SCHEMA_NAME.orgs (name) VALUES ('File : Notes');
INSERT INTO $SCHEMA_NAME.orgs (name) VALUES ('株式会社スペースツリー');
INSERT INTO $SCHEMA_NAME.orgs (name) VALUES ('Dr. Smith Associates');

-- Count total samples
SELECT 'Inserted samples: ' || COUNT(*) FROM $SCHEMA_NAME.orgs;

EOF

# Now add the audit SQL, replacing public.orgs with our temp schema
echo "" >> /tmp/audit-test-$$.sql
echo "-- Audit SQL (adapted to use temporary schema)" >> /tmp/audit-test-$$.sql
echo "SET search_path TO $SCHEMA_NAME, public;" >> /tmp/audit-test-$$.sql
echo "" >> /tmp/audit-test-$$.sql

# Extract and modify the audit SQL (replace public.orgs with orgs, which will use search_path)
sed 's/public\.orgs/orgs/g' "$AUDIT_SQL_PATH" >> /tmp/audit-test-$$.sql

# Add cleanup at the end
cat << EOF >> /tmp/audit-test-$$.sql

-- Cleanup: drop temporary schema
DROP SCHEMA $SCHEMA_NAME CASCADE;

-- Reset search_path
SET search_path TO public;
EOF

# Count expected samples
# Rejection samples (should be caught by SQL): 35
# Allowed samples (app allows, SQL also allows): 14
# SQL broad catch (app allows, but SQL catches due to colon etc.): 1 (File : Notes)
EXPECTED_REJECTED=35
EXPECTED_ALLOWED_NOT_FLAGGED=14
EXPECTED_SQL_BROAD_CATCH=1
TOTAL_SAMPLES=$((EXPECTED_REJECTED + EXPECTED_ALLOWED_NOT_FLAGGED + EXPECTED_SQL_BROAD_CATCH))

echo "Expected rejected samples: $EXPECTED_REJECTED"
echo "Expected allowed (not flagged): $EXPECTED_ALLOWED_NOT_FLAGGED"
echo "Expected SQL broad catch (app allows, SQL catches): $EXPECTED_SQL_BROAD_CATCH"
echo "Total samples: $TOTAL_SAMPLES"
echo ""

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

# Extract needs_review count from output
NEEDS_REVIEW=$(echo "$OUTPUT" | grep "needs_review" | awk '{print $NF}' | tr -d '[:space:]')
TOTAL_ORGS=$(echo "$OUTPUT" | grep "total_orgs" | awk '{print $NF}' | tr -d '[:space:]')

echo ""
echo "============================================================"
echo "Results:"
echo "  Total orgs inserted: $TOTAL_ORGS"
echo "  needs_review count: $NEEDS_REVIEW"
echo "  Expected rejected: $EXPECTED_REJECTED"
echo "  Expected SQL broad catch: $EXPECTED_SQL_BROAD_CATCH"
echo "  Expected allowed (not flagged): $EXPECTED_ALLOWED_NOT_FLAGGED"
echo "============================================================"

# Cleanup temp file
rm -f /tmp/audit-test-$$.sql

# Calculate expected needs_review = rejected + SQL broad catch
EXPECTED_NEEDS_REVIEW=$((EXPECTED_REJECTED + EXPECTED_SQL_BROAD_CATCH))

# Verify results
if [ "$NEEDS_REVIEW" = "$EXPECTED_NEEDS_REVIEW" ]; then
  echo "✓ All rejection samples caught! ($EXPECTED_REJECTED samples)"
  echo "✓ SQL broad catch working as expected! ($EXPECTED_SQL_BROAD_CATCH samples - app allows, SQL catches)"
  echo "✓ Allowed samples not flagged! ($EXPECTED_ALLOWED_NOT_FLAGGED samples with dots allowed)"
  exit 0
else
  if [ "$NEEDS_REVIEW" -gt "$EXPECTED_NEEDS_REVIEW" ] 2>/dev/null; then
    EXTRA=$((NEEDS_REVIEW - EXPECTED_NEEDS_REVIEW))
    echo "✗ $EXTRA extra samples were unexpectedly flagged!"
  elif [ "$NEEDS_REVIEW" -lt "$EXPECTED_NEEDS_REVIEW" ] 2>/dev/null; then
    MISSED=$((EXPECTED_NEEDS_REVIEW - NEEDS_REVIEW))
    echo "✗ $MISSED expected samples were missed!"
  else
    echo "✗ Unexpected result"
  fi
  exit 1
fi

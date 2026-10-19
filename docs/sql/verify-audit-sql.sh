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
# - Uses temporary schema, never touches public.orgs
# - DATABASE_URL and SUPABASE_* environment variables are NOT used
#
# Exit codes:
#   0 - All samples caught
#   1 - Some samples missed
#   2 - psql not found
#   3 - Connection refused (not localhost)

set -e

# Generate unique schema name
SCHEMA_NAME="audit_test_$(date +%s)_$$"

# Check if psql is available
if ! command -v psql &> /dev/null; then
  echo "ERROR: psql not found."
  echo "Please install PostgreSQL client tools or run this in an environment with psql."
  echo "This script requires PostgreSQL 16+ for Unicode escape support."
  exit 2
fi

# Parse connection parameters (only allow localhost)
PGHOST="${PGHOST:-localhost}"
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
    echo "  export PGHOST=localhost"
    echo "  export PGUSER=postgres"
    echo "  export PGDATABASE=postgres"
    exit 3
    ;;
esac

echo "============================================================"
echo "verify-audit-sql.sh"
echo "============================================================"
echo "Host: $PGHOST"
echo "Port: $PGPORT"
echo "User: $PGUSER"
echo "Database: $PGDATABASE"
echo "Temporary schema: $SCHEMA_NAME"
echo "============================================================"
echo ""

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

-- Insert test samples that should be rejected by the app (from org-name.test.ts)
-- These should ALL be flagged as needs_review by the SQL

-- Control characters
-- Note: U+0000 (null) is not valid in PostgreSQL strings, skip it
-- INSERT INTO $SCHEMA_NAME.orgs (name) VALUES ('株式会社' || E'\u0000' || 'テスト');
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

-- URL schemes
INSERT INTO $SCHEMA_NAME.orgs (name) VALUES ('http://example.com');
INSERT INTO $SCHEMA_NAME.orgs (name) VALUES ('https://evil.com');
INSERT INTO $SCHEMA_NAME.orgs (name) VALUES ('javascript:alert(1)');
INSERT INTO $SCHEMA_NAME.orgs (name) VALUES ('data:text/html,<script>');
INSERT INTO $SCHEMA_NAME.orgs (name) VALUES ('vbscript:msgbox');
INSERT INTO $SCHEMA_NAME.orgs (name) VALUES ('file:///etc/passwd');
INSERT INTO $SCHEMA_NAME.orgs (name) VALUES ('mailto:admin@example.com');
INSERT INTO $SCHEMA_NAME.orgs (name) VALUES ('hxxp://example.com');
INSERT INTO $SCHEMA_NAME.orgs (name) VALUES ('hxxps://example.com');
INSERT INTO $SCHEMA_NAME.orgs (name) VALUES ('ftp://ftp.example.com');

-- URL with spaces in scheme
INSERT INTO $SCHEMA_NAME.orgs (name) VALUES ('http ://example.com');
INSERT INTO $SCHEMA_NAME.orgs (name) VALUES ('ht tp://example.com');
INSERT INTO $SCHEMA_NAME.orgs (name) VALUES ('http' || E'\u00A0' || '://example.com');

-- Domain patterns
INSERT INTO $SCHEMA_NAME.orgs (name) VALUES ('www.example.com');
INSERT INTO $SCHEMA_NAME.orgs (name) VALUES ('example.com');
INSERT INTO $SCHEMA_NAME.orgs (name) VALUES ('evil.co.jp/x');
INSERT INTO $SCHEMA_NAME.orgs (name) VALUES ('株式会社 malware.org テスト');

-- IPv4
INSERT INTO $SCHEMA_NAME.orgs (name) VALUES ('192.168.1.1');
INSERT INTO $SCHEMA_NAME.orgs (name) VALUES ('192.168.1.1/admin');

-- Fullwidth characters (normalized to URL by app)
INSERT INTO $SCHEMA_NAME.orgs (name) VALUES ('example' || E'\u3002' || 'com');  -- 。
INSERT INTO $SCHEMA_NAME.orgs (name) VALUES ('example' || E'\uFF0E' || 'com');  -- ．

-- Punycode
INSERT INTO $SCHEMA_NAME.orgs (name) VALUES ('xn--n3h.com');
INSERT INTO $SCHEMA_NAME.orgs (name) VALUES ('xn--nxasmq5b');  -- punycode without dot

-- Japanese adjacent domain
INSERT INTO $SCHEMA_NAME.orgs (name) VALUES ('株式会社malware.com');
INSERT INTO $SCHEMA_NAME.orgs (name) VALUES ('note.com株式会社');
INSERT INTO $SCHEMA_NAME.orgs (name) VALUES ('日本語.com');

-- Combining characters
INSERT INTO $SCHEMA_NAME.orgs (name) VALUES ('h' || E'\u0301' || 'ttp://example.com');

-- Length > 100
INSERT INTO $SCHEMA_NAME.orgs (name) VALUES (repeat('あ', 101));

-- Fullwidth alphanumeric
INSERT INTO $SCHEMA_NAME.orgs (name) VALUES (E'\uFF28\uFF54\uFF54\uFF50://example.com');  -- Ｈｔｔｐ

-- Additional samples from review (scheme with internal spaces)
INSERT INTO $SCHEMA_NAME.orgs (name) VALUES ('h t t p s://example.com');

-- Samples that should be allowed (for false positive check)
-- These are commented out as they should NOT be in needs_review
-- INSERT INTO $SCHEMA_NAME.orgs (name) VALUES ('株式会社スペースツリー');
-- INSERT INTO $SCHEMA_NAME.orgs (name) VALUES ('TOKYO307 Inc.');

-- Count total samples
SELECT 'Inserted samples: ' || COUNT(*) FROM $SCHEMA_NAME.orgs;

EOF

# Now add the audit SQL, replacing public.orgs with our temp schema
echo "" >> /tmp/audit-test-$$.sql
echo "-- Audit SQL (adapted to use temporary schema)" >> /tmp/audit-test-$$.sql
echo "SET search_path TO $SCHEMA_NAME, public;" >> /tmp/audit-test-$$.sql
echo "" >> /tmp/audit-test-$$.sql

# Extract and modify the audit SQL (replace public.orgs with orgs, which will use search_path)
sed 's/public\.orgs/orgs/g' /workspace/docs/sql/org-name-strict-audit.sql >> /tmp/audit-test-$$.sql

# Add cleanup at the end
cat << EOF >> /tmp/audit-test-$$.sql

-- Cleanup: drop temporary schema
DROP SCHEMA $SCHEMA_NAME CASCADE;

-- Reset search_path
SET search_path TO public;
EOF

# Count expected samples (count INSERT lines that are not commented out)
EXPECTED_SAMPLES=$(grep -c "^INSERT INTO $SCHEMA_NAME.orgs" /tmp/audit-test-$$.sql || true)
echo "Expected samples to catch: $EXPECTED_SAMPLES"
echo ""

# Capture public schema state before
echo "Checking public schema state before test..."
PUBLIC_BEFORE=$(psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" -t -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'" 2>/dev/null || echo "0")
echo "Tables in public schema: $PUBLIC_BEFORE"
echo ""

# Run with psql
echo "Running SQL..."
echo ""
OUTPUT=$(psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" -f /tmp/audit-test-$$.sql 2>&1)
echo "$OUTPUT"
echo ""

# Capture public schema state after
echo "Checking public schema state after test..."
PUBLIC_AFTER=$(psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" -t -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'" 2>/dev/null || echo "0")
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
echo ""
echo "============================================================"
echo "Results:"
echo "  Expected samples: $EXPECTED_SAMPLES"
echo "  needs_review count: $NEEDS_REVIEW"
echo "============================================================"

# Cleanup temp file
rm -f /tmp/audit-test-$$.sql

if [ "$NEEDS_REVIEW" = "$EXPECTED_SAMPLES" ]; then
  echo "✓ All samples caught!"
  exit 0
else
  echo "✗ Some samples missed!"
  exit 1
fi

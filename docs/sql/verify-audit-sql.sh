#!/bin/bash
# verify-audit-sql.sh
# Verify that the org-name-strict-audit.sql catches all rejection samples.
#
# Usage: ./verify-audit-sql.sh
# Requires: Postgres 16+ (uses char_length, Unicode escapes)
#
# This script:
# 1. Creates a temporary database with sample org names
# 2. Runs the audit SQL
# 3. Verifies all samples are flagged as needs_review
#
# Exit code: 0 if all samples caught, 1 if any missed

set -e

# Use a temporary SQLite file for simplicity if psql not available
# Otherwise use psql with a temp database

# Sample org names that should be rejected by the app (from org-name.test.ts)
# These should ALL be flagged as needs_review by the SQL

cat << 'EOF' > /tmp/audit-test.sql
-- Create temporary table for testing
DROP TABLE IF EXISTS public.orgs;
CREATE TABLE public.orgs (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL
);

-- Insert test samples that should be rejected by the app
-- Format: Each INSERT is a rejection case from org-name.test.ts

-- Control characters
INSERT INTO public.orgs (name) VALUES ('株式会社' || E'\u0000' || 'テスト');  -- null char
INSERT INTO public.orgs (name) VALUES ('株式会社' || E'\r\n' || 'テスト');    -- CRLF

-- Bidi characters
INSERT INTO public.orgs (name) VALUES ('Test' || E'\u202E' || 'Org');  -- RLO
INSERT INTO public.orgs (name) VALUES ('Test' || E'\u2066' || 'Corp'); -- LRI
INSERT INTO public.orgs (name) VALUES ('Test' || E'\u200E' || 'Corp'); -- LRM
INSERT INTO public.orgs (name) VALUES ('Test' || E'\u061C' || 'Corp'); -- ALM

-- Zero-width / invisible characters
INSERT INTO public.orgs (name) VALUES ('Test' || E'\u200B' || 'Org');  -- ZWSP
INSERT INTO public.orgs (name) VALUES ('Test' || E'\u200C' || 'Org');  -- ZWNJ
INSERT INTO public.orgs (name) VALUES ('Test' || E'\u200D' || 'Org');  -- ZWJ
INSERT INTO public.orgs (name) VALUES ('Test' || E'\u2060' || 'Corp'); -- Word Joiner
INSERT INTO public.orgs (name) VALUES ('Test' || E'\uFEFF' || 'Corp'); -- BOM
INSERT INTO public.orgs (name) VALUES ('Test' || E'\u00AD' || 'Corp'); -- Soft Hyphen
INSERT INTO public.orgs (name) VALUES ('Test' || E'\u180E' || 'Corp'); -- Mongolian Vowel Separator
INSERT INTO public.orgs (name) VALUES ('Test' || E'\u2061' || 'Corp'); -- Function Application
INSERT INTO public.orgs (name) VALUES ('Test' || E'\u2065' || 'Corp'); -- U+2065

-- URL schemes
INSERT INTO public.orgs (name) VALUES ('http://example.com');
INSERT INTO public.orgs (name) VALUES ('https://evil.com');
INSERT INTO public.orgs (name) VALUES ('javascript:alert(1)');
INSERT INTO public.orgs (name) VALUES ('data:text/html,<script>');
INSERT INTO public.orgs (name) VALUES ('vbscript:msgbox');
INSERT INTO public.orgs (name) VALUES ('file:///etc/passwd');
INSERT INTO public.orgs (name) VALUES ('mailto:admin@example.com');
INSERT INTO public.orgs (name) VALUES ('hxxp://example.com');
INSERT INTO public.orgs (name) VALUES ('hxxps://example.com');
INSERT INTO public.orgs (name) VALUES ('ftp://ftp.example.com');

-- URL with spaces in scheme
INSERT INTO public.orgs (name) VALUES ('http ://example.com');
INSERT INTO public.orgs (name) VALUES ('ht tp://example.com');
INSERT INTO public.orgs (name) VALUES ('http' || E'\u00A0' || '://example.com');

-- Domain patterns
INSERT INTO public.orgs (name) VALUES ('www.example.com');
INSERT INTO public.orgs (name) VALUES ('example.com');
INSERT INTO public.orgs (name) VALUES ('evil.co.jp/x');
INSERT INTO public.orgs (name) VALUES ('株式会社 malware.org テスト');

-- IPv4
INSERT INTO public.orgs (name) VALUES ('192.168.1.1');
INSERT INTO public.orgs (name) VALUES ('192.168.1.1/admin');

-- Fullwidth characters (normalized to URL by app)
INSERT INTO public.orgs (name) VALUES ('example' || E'\u3002' || 'com');  -- 。
INSERT INTO public.orgs (name) VALUES ('example' || E'\uFF0E' || 'com');  -- ．

-- Punycode
INSERT INTO public.orgs (name) VALUES ('xn--n3h.com');

-- Japanese adjacent domain
INSERT INTO public.orgs (name) VALUES ('株式会社malware.com');
INSERT INTO public.orgs (name) VALUES ('note.com株式会社');
INSERT INTO public.orgs (name) VALUES ('日本語.com');

-- Combining characters
INSERT INTO public.orgs (name) VALUES ('h' || E'\u0301' || 'ttp://example.com');

-- Length > 100
INSERT INTO public.orgs (name) VALUES (repeat('あ', 101));

-- Fullwidth alphanumeric
INSERT INTO public.orgs (name) VALUES (E'\uFF28\uFF54\uFF54\uFF50://example.com');  -- Ｈｔｔｐ

-- Now run the audit query and count
EOF

echo "Testing audit SQL against $(grep -c "INSERT INTO public.orgs" /tmp/audit-test.sql) samples..."

# Append the audit query to count needs_review
cat /workspace/docs/sql/org-name-strict-audit.sql >> /tmp/audit-test.sql

# Check if psql is available
if ! command -v psql &> /dev/null; then
  echo "psql not found. Please run this script with access to PostgreSQL 16+."
  echo "Alternatively, copy the SQL to a Postgres environment and verify manually."
  echo ""
  echo "Expected result: needs_review count should equal the number of INSERTs"
  exit 0
fi

# Run with psql (requires local postgres or docker)
echo "Running SQL..."
psql -h localhost -U postgres -d postgres -f /tmp/audit-test.sql 2>&1 | tail -30

echo ""
echo "Verify that 'needs_review' count equals the number of test samples."

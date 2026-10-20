/**
 * Production verification SQL for TOKYO307 admin tickets must stay read-only
 * and pin exactly one org by name (stop if 0 or 2+ rows match).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const SQL_PATH = "supabase/verification/tokyo307-admin-tickets.sql";

describe("tokyo307-admin-tickets.sql tenant isolation", () => {
  const sql = readFileSync(SQL_PATH, "utf8");

  test("is a read-only transaction that rolls back", () => {
    expect(sql).toMatch(/begin\s+transaction\s+read\s+only/i);
    expect(sql).toMatch(/^\s*rollback\s*;/m);
    const body = sql
      .replace(/begin\s+transaction\s+read\s+only/gi, " ")
      .replace(/set\s+local\s+statement_timeout[^;]*;/gi, " ");
    expect(body).not.toMatch(
      /\b(insert\s+into|update\s+public\.|delete\s+from|truncate\s+|drop\s+|alter\s+|grant\s+|revoke\s+|copy\s+|merge\s+)\b/i
    );
  });

  test("identifies TOKYO307 by exact orgs.name and stops when the match is not unique", () => {
    expect(sql).not.toMatch(/%TOKYO307%/i);
    expect(sql).not.toMatch(/%tokyo307%/i);
    expect(sql).toMatch(/o\.name\s+ilike\s+'TOKYO307'/i);
    expect(sql).toMatch(/raise\s+exception/i);
    expect(sql).toMatch(/count\(\*\)/);
    expect(sql).toMatch(/n\s*<>\s*1|n\s*!=\s*1|count\(\*\)\s*<>\s*1/i);
  });
});

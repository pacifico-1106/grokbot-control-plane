import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SQL = readFileSync(
  resolve("supabase/migrations/20261015100000_approval_mail_attachments.sql"),
  "utf8"
);

describe("approval_mail_attachments SQL contract (not applied)", () => {
  test("idempotent additive table with RLS deny-all and service_role only", () => {
    expect(SQL).toContain("create table if not exists public.approval_mail_attachments");
    expect(SQL).toContain("enable row level security");
    expect(SQL).toContain("as restrictive for all");
    expect(SQL).toContain("using (false) with check (false)");
    expect(SQL).toContain("revoke all on public.approval_mail_attachments from public, anon, authenticated");
    expect(SQL).toContain("grant select, insert, update, delete on public.approval_mail_attachments to service_role");
    expect(SQL).toContain("content_sha256");
    expect(SQL).toContain("content_ciphertext");
    expect(SQL).toContain("org_id uuid not null");
    expect(SQL).toContain("on delete cascade");
    expect(SQL).not.toMatch(/grant\s+.*\s+to\s+anon/i);
    expect(SQL).not.toMatch(/grant\s+.*\s+to\s+authenticated/i);
  });
});

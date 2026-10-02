/**
 * Static regression guards for the CS1 migration and the approval-route migrations.
 * (Real-Postgres validation was done with PGlite; see PR body.)
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const dir = resolve("supabase/migrations");
const read = (f: string) => readFileSync(resolve(dir, f), "utf8");
const strip = (sql: string) => sql.replace(/--.*$/gm, "");

describe("migrations", () => {
  test("no migration references the nonexistent members table", () => {
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql"))) {
      const sql = strip(read(f));
      expect({ f, hit: /(references|from|join)\s+(public\.)?members\b/i.test(sql) }).toEqual({ f, hit: false });
    }
  });

  test("decision workflow references org_members", () => {
    const sql = strip(read("20260930000200_decision_workflow.sql"));
    expect((sql.match(/references org_members\(id\)/g) ?? []).length).toBe(3);
  });

  const cs = strip(read("20261002000000_channel_scope.sql"));

  test("channel_scope: exactly one primary key, no column-level PK", () => {
    expect((cs.match(/primary key/gi) ?? []).length).toBe(1);
    expect(/uuid\s+primary key/i.test(cs)).toBe(false);
  });

  test("channel_scope: RLS deny-by-default and service_role grants", () => {
    expect(cs).toContain("alter table public.employee_channel_memberships enable row level security");
    expect(cs).toMatch(/as restrictive for all to public using \(false\) with check \(false\)/);
    expect(cs).toContain("revoke all on public.employee_channel_memberships from public, anon, authenticated");
    expect(cs).toContain("grant select, insert, update, delete on public.employee_channel_memberships to service_role");
  });

  test("channel_scope: idempotent DDL", () => {
    expect(cs).not.toMatch(/create table (?!if not exists)/i);
    expect(cs).not.toMatch(/add column (?!if not exists)/i);
    expect(cs).not.toMatch(/create index (?!if not exists)/i);
    for (const m of cs.matchAll(/create policy (\S+)/gi)) expect(cs).toContain(`drop policy if exists ${m[1]}`);
    for (const m of cs.matchAll(/create trigger (\S+)/gi)) expect(cs).toContain(`drop trigger if exists ${m[1]}`);
    for (const m of cs.matchAll(/add constraint (\S+)/gi)) {
      if (m[1] === "employees_id_org_key") continue; // guarded by DO block
      expect(cs).toContain(`drop constraint if exists ${m[1]}`);
    }
  });
});

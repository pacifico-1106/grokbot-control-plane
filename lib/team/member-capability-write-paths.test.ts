/**
 * Every path that can change a human member's capabilities / role must go
 * through ONE decision function: evaluateMemberChange (lib/team/member-change-guard.ts).
 *
 * This is a source-level inventory so a new write path (route, admin MCP tool,
 * demo store, DB helper) fails CI until it is routed through the guard.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name.startsWith(".")) return [];
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : [];
  });
}
const files = ["lib", "app", "components", "hooks"].flatMap((d) => walk(join(ROOT, d)));
const src = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const rel = (p: string) => relative(ROOT, p);

/** `.from("org_members")` followed (within the same chain) by a mutating call. */
function orgMemberWriteSites(): Array<{ file: string; line: number; op: string }> {
  const out: Array<{ file: string; line: number; op: string }> = [];
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    const re = /\.from\(\s*["'`]org_members["'`]\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const chain = text.slice(m.index, m.index + 400).split(/;\s*\n/)[0];
      const op = /\.(update|insert|upsert|delete)\s*\(/.exec(chain)?.[1];
      if (op) out.push({ file: rel(f), line: text.slice(0, m.index).split("\n").length, op });
    }
  }
  return out;
}

describe("org_members write inventory", () => {
  test("only the guarded writer and the guarded org bootstrap write org_members", () => {
    const sites = orgMemberWriteSites().map((s) => `${s.file}:${s.op}`).sort();
    expect([...new Set(sites)]).toEqual([
      // bootstrap owner insert (evaluateMemberChange with SYSTEM_BOOTSTRAP_ACTOR) + email/display_name repair (no role/capabilities)
      "lib/auth/session.ts:insert",
      "lib/auth/session.ts:update",
      // writeMemberRow (insert-only invite / conditional update) — only reachable from applyMemberChange
      "lib/data/members.ts:insert",
      "lib/data/members.ts:update",
    ]);
  });

  test("session.ts placeholder repair never writes role or capabilities", () => {
    const text = src("lib/auth/session.ts");
    const repair = text.slice(text.indexOf("async function repairDemoPlaceholderMember"), text.indexOf("export async function getSessionContext"));
    const update = repair.slice(repair.indexOf(".update("), repair.indexOf(".eq(\"id\""));
    expect(update).toContain("email");
    expect(update).not.toMatch(/role|capabilities/);
  });

  test("org bootstrap owner insert is decided by evaluateMemberChange", () => {
    const text = src("lib/auth/session.ts");
    const provision = text.slice(text.indexOf("export async function provisionOrgForUser"), text.indexOf("export type EnsureOrgResult"));
    const guardAt = provision.indexOf("evaluateMemberChange(");
    expect(guardAt).toBeGreaterThan(-1);
    expect(provision).toContain("SYSTEM_BOOTSTRAP_ACTOR");
    // Atomic RPC (20261004900000) and the pre-migration two-step fallback both
    // run after the guard and write exactly the guard's role / capabilities.
    expect(provision.indexOf('rpc("provision_org_with_owner"')).toBeGreaterThan(guardAt);
    expect(provision).toContain("p_capabilities: bootstrap.capabilitiesAfter");
    const twoStepCall = provision.indexOf("provisionOrgTwoStep({");
    expect(twoStepCall).toBeGreaterThan(guardAt);
    expect(provision.slice(twoStepCall)).toMatch(/role: bootstrap\.roleAfter,\s*capabilities: bootstrap\.capabilitiesAfter/);
    const helper = text.slice(text.indexOf("async function provisionOrgTwoStep"), text.indexOf("function isSchemaMissingError"));
    expect(helper).toMatch(/\.from\("org_members"\)\s*\.insert/);
    expect(helper).toMatch(/role: input\.role,/);
    expect(helper).toMatch(/capabilities: input\.capabilities,/);
    expect([...text.matchAll(/provisionOrgTwoStep\(/g)].length).toBe(2); // definition + the one guarded call
  });

  test("org_members RPC writers: invite claim only via invite-claim.ts, org bootstrap only after evaluateMemberChange", () => {
    const rpcSites = (fn: string) =>
      files.filter((f) => new RegExp(`\\.rpc\\(\\s*["'\`]${fn}["'\`]`).test(readFileSync(f, "utf8"))).map(rel).sort();
    expect(rpcSites("claim_member_invites")).toEqual(["lib/auth/invite-claim.ts"]);
    expect(rpcSites("provision_org_with_owner")).toEqual(["lib/auth/session.ts"]);
    const text = src("lib/auth/session.ts");
    const provision = text.slice(text.indexOf("export async function provisionOrgForUser"), text.indexOf("export type EnsureOrgResult"));
    const guardAt = provision.indexOf("evaluateMemberChange(");
    expect(guardAt).toBeGreaterThan(-1);
    expect(provision.indexOf('rpc("provision_org_with_owner"')).toBeGreaterThan(guardAt);
    // the claim RPC takes the user id only — never an email
    expect(src("lib/auth/invite-claim.ts")).not.toMatch(/p_email/);
  });

  test("writeMemberRow is only called from applyMemberChange, which calls evaluateMemberChange first", () => {
    const callers = files.filter((f) => /\bwriteMemberRow\s*\(/.test(readFileSync(f, "utf8"))).map(rel).sort();
    expect(callers).toEqual(["lib/data/members.ts", "lib/team/apply-member-change.ts"]);
    const apply = src("lib/team/apply-member-change.ts");
    expect(apply.indexOf("evaluateMemberChange(")).toBeGreaterThan(-1);
    expect(apply.indexOf("writeMemberRow(")).toBeGreaterThan(apply.indexOf("evaluateMemberChange("));
    expect(src("lib/data/index.ts")).not.toMatch(/\bupsertMember\b|\bwriteMemberRow\b/);
  });

  test("demo store mutators are only used by the guarded writer", () => {
    const users = files
      .filter((f) => /\b(upsertRuntimeMember|setRuntimeMember)\s*\(/.test(readFileSync(f, "utf8")))
      .map(rel)
      .sort();
    expect(users).toEqual(["lib/data/members.ts", "lib/demo-data.ts"]);
  });

  test("team API route uses applyMemberChange and session-derived actor", () => {
    const route = src("app/api/team/members/route.ts");
    expect(route).toContain("applyMemberChange(");
    expect(route).toContain("resolveMemberChangeActor(");
    expect(route).not.toMatch(/\bupsertMember\b|\bwriteMemberRow\b|requireCapability\(/);
  });

  test("admin / employee MCP expose no tool that edits human members (would bypass the guard)", () => {
    const tools = src("lib/mcp/admin-tools.ts");
    const names = [...tools.matchAll(/name:\s*"([a-zA-Z]+\.[a-zA-Z.]+)"/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(10);
    expect(names.filter((n) => /^(members?|team|humans?|capabilit)/i.test(n))).toEqual([]);
  });

  test("migration removes the direct PostgREST write policy on org_members", () => {
    const dir = join(ROOT, "supabase", "migrations");
    const sql = readdirSync(dir).filter((n) => n.endsWith(".sql")).sort().map((n) => readFileSync(join(dir, n), "utf8")).join("\n");
    const lastCreate = sql.lastIndexOf("create policy org_members_write_admin");
    const lastDrop = sql.lastIndexOf("drop policy if exists org_members_write_admin");
    expect(lastDrop).toBeGreaterThan(lastCreate);
  });
});

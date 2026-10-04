/**
 * LP tables are server-only (木村 2026-10-04, #2 / #3), migration 20261004800000:
 * - lp_inquiries / notification_outbox: every app access goes through the
 *   service-role client in a server module (inventory + callers pinned here);
 *   anon / authenticated INSERT / UPDATE / DELETE / TRUNCATE are revoked
 *   (20261001000000 already did REVOKE ALL; this re-asserts it on databases
 *   where the default grants came back or were never removed)
 * - lp_handoffs / lp_wake_webhook_configs / lp_wake_webhook_events: the
 *   `*_service_all` policies (using auth.role() = 'service_role') are dropped.
 *   They admit no user session, and service_role bypasses RLS, so they are
 *   redundant; RLS stays enabled (no policy = sessions see / write nothing).
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { scanTableAccess, WRITE_OPS, type SourceFile } from "../../tests/helpers/table-write-scan";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const STAMP = "20261004800000";
const REVOKED = ["lp_inquiries", "notification_outbox"];
const LP_TABLES = ["lp_handoffs", "lp_wake_webhook_configs", "lp_wake_webhook_events"];
/** [table, policy] exactly as created by 20261001400000_lp_handoffs.sql */
const DROPPED = [
  ["lp_handoffs", "lp_handoffs_service_all"],
  ["lp_wake_webhook_configs", "lp_wake_configs_service_all"],
  ["lp_wake_webhook_events", "lp_wake_events_service_all"],
] as const;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name.startsWith(".")) return [];
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : [];
  });
}
const sources: SourceFile[] = ["lib", "app", "components", "hooks"]
  .flatMap((d) => walk(join(ROOT, d)))
  .concat([join(ROOT, "middleware.ts")])
  .map((p) => ({ path: relative(ROOT, p), text: readFileSync(p, "utf8") }));
const src = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const sites = scanTableAccess(sources).filter((s) => [...REVOKED, ...LP_TABLES].includes(s.table));
const callers = (fn: string) =>
  sources
    .filter((f) => new RegExp(`\\b${fn}\\s*\\(`).test(f.text) && !f.path.startsWith("lib/lp/"))
    .map((f) => f.path)
    .sort();

describe("app: lp_inquiries / notification_outbox (and lp_*) are accessed only server-side", () => {
  test("every read and write uses the service-role client", () => {
    expect(sites.filter((s) => REVOKED.includes(s.table)).length).toBeGreaterThan(10);
    expect(sites.filter((s) => s.clientKind !== "service_role")).toEqual([]);
  });

  test("write inventory is pinned", () => {
    const writes = [...new Set(sites.filter((s) => REVOKED.includes(s.table) && WRITE_OPS.has(s.op)).map((s) => `${s.file}:${s.table}:${s.op}`))].sort();
    expect(writes).toEqual([
      "lib/lp/inquiry-data.ts:lp_inquiries:insert",
      "lib/lp/inquiry-data.ts:lp_inquiries:update",
      "lib/lp/notification-outbox.ts:notification_outbox:insert",
      "lib/lp/notification-outbox.ts:notification_outbox:update",
      "lib/lp/outbox-processor.ts:notification_outbox:insert",
      "lib/lp/outbox-processor.ts:notification_outbox:update",
    ]);
  });

  test("writers are reached only from server routes with their own checks", () => {
    // public inquiry form: rate limit + Turnstile + validation in the route
    for (const fn of ["createInquiry", "enqueueNotification", "processOutboxEntry"]) {
      expect(callers(fn)).toEqual(["app/api/lp/ai-employee/inquiry/route.ts"]);
    }
    expect(callers("updateInquiryStatus")).toEqual([]);
    // chat handoff: guest journey + CSRF in the route
    expect(callers("enqueueHandoffNotification")).toEqual(["app/api/lp/handoff/route.ts"]);
    // cron: CRON_SECRET
    expect(callers("processHandoffOutbox")).toEqual(["app/api/cron/lp-handoff-outbox/route.ts"]);
    for (const fn of ["markOutboxProcessing", "markOutboxDelivered", "markOutboxFailed"]) expect(callers(fn)).toEqual([]);
    const inquiry = src("app/api/lp/ai-employee/inquiry/route.ts");
    expect(inquiry).toContain("checkRateLimits(");
    expect(inquiry).toContain("verifyTurnstileToken(");
    expect(src("app/api/cron/lp-handoff-outbox/route.ts")).toContain("validateCronSecret(request)");
    expect(src("app/api/cron/lp-inquiry-cleanup/route.ts")).toContain("verifyCronSecret(req)");
    expect(src("app/api/cron/lp-inquiry-cleanup/route.ts")).toMatch(/admin\.rpc\("cleanup_expired_lp_inquiries"\)/);
  });

  test("no app code depends on the lp_*_service_all policies or on auth.role()", () => {
    for (const f of sources) {
      expect(`${f.path}:${/_service_all\b|auth\.role\(\)/.test(f.text)}`).toBe(`${f.path}:false`);
    }
  });
});

describe(`migration ${STAMP}: LP tables server-only`, () => {
  const dir = join(ROOT, "supabase", "migrations");
  const names = readdirSync(dir).filter((n) => n.endsWith(".sql")).sort();
  const file = names.find((n) => n.startsWith(`${STAMP}_`));
  const migration = file ? readFileSync(join(dir, file), "utf8") : "";
  const exec = (text: string) =>
    text
      .split("\n")
      .filter((l) => !/^\s*--/.test(l))
      .join("\n")
      .toLowerCase();
  const executable = exec(migration);

  test("exists and sorts after 20261004600000 and the 700000 slot (#260)", () => {
    expect(file).toBeDefined();
    expect(names.indexOf(file!)).toBeGreaterThan(names.findIndex((n) => n.startsWith("20261004600000_")));
    expect(file! > "20261004700000_~").toBe(true);
  });

  test("drops the 3 redundant service-role policies after their create; revokes writes on lp_inquiries / notification_outbox", () => {
    const all = exec(names.map((n) => readFileSync(join(dir, n), "utf8")).join("\n"));
    for (const [table, policy] of DROPPED) {
      const drop = `drop policy if exists ${policy} on public.${table};`;
      expect(executable).toContain(drop);
      expect(all.lastIndexOf(drop)).toBeGreaterThan(all.lastIndexOf(`create policy "${policy}"`));
      expect(all.lastIndexOf(`create policy "${policy}"`)).toBeGreaterThan(-1);
    }
    expect(executable).toContain(
      `revoke insert, update, delete, truncate on ${REVOKED.map((t) => `public.${t}`).join(", ")} from anon, authenticated;`
    );
    expect(executable).not.toMatch(/create policy|grant |insert into|update public\.|delete from|alter table|truncate public|disable row level security/);
  });

  test("RLS stays enabled on all 5 tables (never disabled by any migration)", () => {
    const all = exec(names.map((n) => readFileSync(join(dir, n), "utf8")).join("\n"));
    for (const t of [...REVOKED, ...LP_TABLES]) {
      expect(all).toMatch(new RegExp(`alter table (public\\.)?${t} enable row level security`));
      expect(all).not.toMatch(new RegExp(`alter table (public\\.)?${t} (disable|no force) row level security`));
    }
  });

  test("a documented rollback block restores exactly the previous policies and grants", () => {
    const m = migration.match(/^-- ROLLBACK \(down\).*$([\s\S]*?)^-- END ROLLBACK/m);
    expect(m).not.toBeNull();
    const down = (m?.[1] ?? "")
      .split("\n")
      .filter((l) => l.startsWith("--   "))
      .map((l) => l.slice(5))
      .join("\n")
      .replace(/\s+/g, " ")
      .toLowerCase();
    for (const [table, policy] of DROPPED) {
      expect(down).toContain(`create policy ${policy} on public.${table} for all using (auth.role() = 'service_role');`);
    }
    expect(down).toContain(`grant insert, update, delete, truncate on ${REVOKED.map((t) => `public.${t}`).join(", ")} to anon, authenticated;`);
    expect(down.match(/create policy/g)?.length).toBe(3);
  });

  test("verification SQL exists and is read-only", () => {
    const v = src(`supabase/verification/${STAMP}_lp_tables_server_only_check.sql`);
    const body = exec(v);
    expect(body).toContain("begin read only;");
    expect(body).not.toMatch(/\b(insert into|update public\.|delete from|create |drop |grant |revoke |alter )/);
    expect(body).toContain("rolbypassrls");
  });
});

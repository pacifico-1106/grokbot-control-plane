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
 *   SELECT is revoked from anon / authenticated as well (木村 2026-10-04): no
 *   user-session or anon client reads them — every reader is a server module
 *   on the service-role client, reached only from routes with their own
 *   checks (read inventory + callers pinned below).
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { clientComponentsImportingSupabase, scanTableAccess, WRITE_OPS, type SourceFile } from "../../tests/helpers/table-write-scan";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const STAMP = "20261004800000";
const REVOKED = ["lp_inquiries", "notification_outbox"];
const LP_TABLES = ["lp_handoffs", "lp_wake_webhook_configs", "lp_wake_webhook_events"];
const LP_LIST = LP_TABLES.map((t) => `public.${t}`).join(", ");
/** every app access (read and write) to the 3 lp_* tables: `file:table:op` */
const LP_ACCESS = [
  "lib/lp/handoffs.ts:lp_handoffs:insert",
  "lib/lp/handoffs.ts:lp_handoffs:select",
  "lib/lp/handoffs.ts:lp_handoffs:update",
  "lib/lp/wake-webhook.ts:lp_wake_webhook_configs:insert",
  "lib/lp/wake-webhook.ts:lp_wake_webhook_configs:select",
  "lib/lp/wake-webhook.ts:lp_wake_webhook_configs:update",
  "lib/lp/wake-webhook.ts:lp_wake_webhook_events:insert",
  "lib/lp/wake-webhook.ts:lp_wake_webhook_events:select",
  "lib/lp/wake-webhook.ts:lp_wake_webhook_events:update",
];
/** exported functions of the 2 lp_* modules -> modules that call them (outside the module itself) */
const LP_MODULE_CALLERS: Record<string, Record<string, string[]>> = {
  "lib/lp/handoffs.ts": {
    createHandoff: ["app/api/lp/handoff/route.ts"],
    getHandoff: ["app/api/lp/handoff/route.ts"],
    getHandoffByJourney: [],
    confirmHandoff: ["app/api/lp/handoff/route.ts"],
    cancelHandoff: ["app/api/lp/handoff/route.ts"],
    updateHandoffStatus: ["lib/lp/outbox-processor.ts"],
    getConfirmedHandoffsForOutbox: [],
  },
  "lib/lp/wake-webhook.ts": {
    validateWebhookRequest: ["app/api/webhooks/lp-wake/[path]/route.ts"],
    checkIdempotency: [],
    recordWebhookEvent: ["app/api/webhooks/lp-wake/[path]/route.ts"],
    updateWebhookEventStatus: ["app/api/webhooks/lp-wake/[path]/route.ts"],
    createWebhookConfig: [],
  },
};
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

describe("app: lp_handoffs / lp_wake_* are read (and written) only by service-role server code", () => {
  const lpSites = sites.filter((s) => LP_TABLES.includes(s.table));

  test("no user-session / anon / unknown client reads them", () => {
    expect(lpSites.filter((s) => s.op === "select").length).toBeGreaterThanOrEqual(LP_TABLES.length);
    expect(lpSites.filter((s) => s.clientKind !== "service_role")).toEqual([]);
    for (const f of ["lib/lp/handoffs.ts", "lib/lp/wake-webhook.ts"]) {
      expect(src(f)).toContain('import { createSupabaseAdminClient } from "@/lib/supabase";');
      expect(src(f)).not.toMatch(/createSupabase(Browser|Server)Client|createRouteSupabase|NEXT_PUBLIC_SUPABASE_ANON_KEY|["']use client["']/);
    }
  });

  test("read + write inventory is pinned (readers: lib/lp/handoffs.ts, lib/lp/wake-webhook.ts)", () => {
    expect([...new Set(lpSites.map((s) => `${s.file}:${s.table}:${s.op}`))].sort()).toEqual(LP_ACCESS);
  });

  test("the lp_* modules are reached only from server routes with their own checks, never from a client module", () => {
    for (const [mod, fns] of Object.entries(LP_MODULE_CALLERS)) {
      const exported = [...src(mod).matchAll(/^export (?:async )?function (\w+)/gm)].map((m) => m[1]).sort();
      expect(exported).toEqual(Object.keys(fns).sort());
      for (const [fn, expected] of Object.entries(fns)) {
        const found = sources
          .filter((f) => f.path !== mod && new RegExp(`\\b${fn}\\s*\\(`).test(f.text))
          .map((f) => f.path)
          .sort();
        expect(`${fn}: ${found.join(", ")}`).toBe(`${fn}: ${expected.join(", ")}`);
      }
    }
    const importers = sources
      .filter((f) => /["']@\/lib\/lp\/(handoffs|wake-webhook)["']|["'][./]+(lp\/)?(handoffs|wake-webhook)["']/.test(f.text))
      .map((f) => f.path)
      .sort();
    expect(importers).toEqual(["app/api/lp/handoff/route.ts", "app/api/webhooks/lp-wake/[path]/route.ts", "lib/lp/outbox-processor.ts"]);
    for (const f of importers) expect(`${f}:${/^\s*["']use client["']/m.test(src(f))}`).toBe(`${f}:false`);
    expect(clientComponentsImportingSupabase(sources).filter((f) => /\blp\b|lp-|\/lp\//.test(f))).toEqual([]);
    // guest handoff: journey cookie (+ CSRF on writes) and ownership check before any read is returned
    const handoff = src("app/api/lp/handoff/route.ts");
    expect(handoff).toContain("resolveGuestJourney(request, { requireCsrf: true })");
    expect(handoff.match(/journeyId !== session\.journey\.id/g)?.length).toBe(3);
    // wake webhook: per-endpoint secret, compared as a hash in constant time
    const wake = src("app/api/webhooks/lp-wake/[path]/route.ts");
    expect(wake).toContain("validateWebhookRequest(endpointPath, secret)");
    expect(src("lib/lp/wake-webhook.ts")).toContain("timingSafeEqual(storedHashBuffer, providedHashBuffer)");
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

  test("revokes SELECT on the 3 lp_* tables from anon / authenticated (service_role untouched)", () => {
    expect(executable).toContain(`revoke select on ${LP_LIST} from anon, authenticated;`);
    expect(executable).not.toMatch(/service_role/);
    expect(executable).not.toMatch(/revoke [^;]*\bon public\.(lp_handoffs|lp_wake_webhook_configs|lp_wake_webhook_events)\b[^;]*from [^;]*\b(public|postgres)\b/);
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
    expect(down).toContain(`grant select on ${LP_LIST} to anon, authenticated;`);
    expect(down.match(/create policy/g)?.length).toBe(3);
    expect(down.match(/\bgrant /g)?.length).toBe(2);
  });

  test("verification SQL exists and is read-only", () => {
    const v = src(`supabase/verification/${STAMP}_lp_tables_server_only_check.sql`);
    const body = exec(v);
    expect(body).toContain("begin read only;");
    expect(body).not.toMatch(/\b(insert into|update public\.|delete from|create |drop |grant |revoke |alter )/);
    expect(body).toContain("rolbypassrls");
  });

  test("verification SQL checks effective session SELECT on the 3 lp_* tables and documents the expected values", () => {
    const v = src(`supabase/verification/${STAMP}_lp_tables_server_only_check.sql`);
    const body = exec(v);
    expect(body).toContain("has_table_privilege(r, 'public.' || t, 'select')");
    expect(body).toContain("has_any_column_privilege(r, 'public.' || t, 'select')");
    expect(body).toContain("unnest(array['lp_handoffs','lp_wake_webhook_configs','lp_wake_webhook_events']) t");
    expect(v).toContain("no SELECT on lp_handoffs / lp_wake_webhook_configs / lp_wake_webhook_events");
    expect(v).toMatch(/After:[\s\S]*\(6\) all f/);
  });
});

/**
 * RLS write holes (木村 review, 2026-10-04): orgs / subscriptions /
 * audit_events / approval_requests had member/admin write policies, so any
 * tenant session JWT + the public anon key could write them directly through
 * PostgREST (plan_key / billing_status rewrite, self-approval, forged audit).
 *
 * End state pinned here:
 * - the app never writes these tables (or anything else) with a user-session
 *   client; user-session clients are only used for supabase.auth.*
 * - every write goes through the service-role client inside a server route /
 *   server module, and the user-facing routes that reach those writers carry
 *   an explicit server-side authz check
 * - plan / billing columns are written only by the billing modules reached
 *   from the Stripe webhook, the trial cron, super-admin and approval-gated
 *   admin fulfilment
 * - migration 20261004500000 drops the four policies and revokes table
 *   write privileges from anon / authenticated (documented rollback)
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  clientComponentsImportingSupabase,
  scanTableAccess,
  WRITE_OPS,
  type SourceFile,
} from "../../tests/helpers/table-write-scan";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const TABLES = ["orgs", "subscriptions", "audit_events", "approval_requests"] as const;
const POLICIES = [
  ["approval_requests", "approvals_write_member"],
  ["audit_events", "audit_insert_member"],
  ["orgs", "orgs_update_admin"],
  ["subscriptions", "subscriptions_write_admin"],
] as const;
const ORG_BILLING_COLUMNS = [
  "plan_key",
  "billing_status",
  "scheduled_plan_key",
  "scheduled_plan_effective_at",
  "stripe_customer_id",
  "trial_ends_at",
];

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
const sites = scanTableAccess(sources);
const tenantWrites = sites.filter(
  (s) => (TABLES as readonly string[]).includes(s.table) && WRITE_OPS.has(s.op)
);

describe("scanner (synthetic sources)", () => {
  test("browser client write is classified user_session with its columns", () => {
    const found = scanTableAccess([
      {
        path: "components/Rename.tsx",
        text: `"use client";\nimport { createSupabaseBrowserClient } from "@/lib/supabase";\nexport async function rename(id: string, name: string) {\n  const supabase = createSupabaseBrowserClient();\n  await supabase!.from("orgs").update({ name, plan_key: "x" }).eq("id", id);\n}\n`,
      },
    ]);
    expect(found).toEqual([
      {
        file: "components/Rename.tsx",
        line: 5,
        table: "orgs",
        op: "update",
        client: "supabase",
        clientKind: "user_session",
        columns: ["name", "plan_key"],
      },
    ]);
  });

  test("multi-line chain on a cookie-bound route client is a user_session insert", () => {
    const found = scanTableAccess([
      {
        path: "app/api/x/route.ts",
        text: `import { createRouteSupabase } from "@/lib/auth/route-supabase";\nexport async function POST() {\n  const sb = await createRouteSupabase();\n  await sb\n    .from("audit_events")\n    .insert({\n      org_id: "o",\n      action: "a",\n    });\n}\n`,
      },
    ]);
    expect(found.map((s) => [s.table, s.op, s.clientKind, s.columns.join(",")])).toEqual([
      ["audit_events", "insert", "user_session", "org_id,action"],
    ]);
  });

  test("server cookie client (createSupabaseServerClient / @supabase/ssr) is user_session", () => {
    const found = scanTableAccess([
      {
        path: "lib/a.ts",
        text: `const s = createSupabaseServerClient(store);\nawait s.from("approval_requests").delete().eq("id", id);\nconst t = createServerClient(u, k, o);\nawait t.rpc("do_thing", {});\n`,
      },
    ]);
    expect(found.map((s) => [s.table, s.op, s.clientKind])).toEqual([
      ["approval_requests", "delete", "user_session"],
      ["do_thing", "rpc", "user_session"],
    ]);
  });

  test("service-role client writes are service_role; reads are select; non-literal payload is <dynamic>", () => {
    const found = scanTableAccess([
      {
        path: "lib/b.ts",
        text: `export async function f(update: Record<string, unknown>) {\n  const admin = createSupabaseAdminClient();\n  await admin.from("orgs").select("id").eq("id", "x");\n  await admin.from("orgs").update(update).eq("id", "x");\n}\nexport async function g(db: SupabaseClient) {\n  await db.from("subscriptions").upsert(row, { onConflict: "org_id" });\n}\n`,
      },
    ]);
    expect(found.map((s) => [s.op, s.clientKind, s.columns.join(",")])).toEqual([
      ["select", "service_role", ""],
      ["update", "service_role", "<dynamic>"],
      ["upsert", "unknown", "<dynamic>"],
    ]);
  });

  test("client component importing a Supabase client module is reported", () => {
    expect(
      clientComponentsImportingSupabase([
        { path: "components/A.tsx", text: `"use client";\nimport { createSupabaseBrowserClient } from "@/lib/supabase";\n` },
        { path: "components/B.tsx", text: `'use client'\nimport { createBrowserClient } from "@supabase/ssr";\n` },
        { path: "components/C.tsx", text: `import { createSupabaseAdminClient } from "@/lib/supabase";\n` },
        { path: "components/D.tsx", text: `"use client";\nimport { useState } from "react";\n` },
      ])
    ).toEqual(["components/A.tsx", "components/B.tsx"]);
  });
});

describe("app: no user-session writes to tenant tables", () => {
  test("scanner sees the real code base", () => {
    expect(tenantWrites.length).toBeGreaterThan(20);
  });

  test("every write to orgs / subscriptions / audit_events / approval_requests uses the service-role client", () => {
    expect(tenantWrites.filter((s) => s.clientKind !== "service_role")).toEqual([]);
  });

  test("user-session clients never query PostgREST (.from / .rpc) at all — only supabase.auth.*", () => {
    expect(sites.filter((s) => s.clientKind === "user_session")).toEqual([]);
  });

  test("no client component imports a Supabase client module", () => {
    expect(clientComponentsImportingSupabase(sources)).toEqual([]);
  });

  test("write inventory is pinned (a new write path must be reviewed here)", () => {
    const pinned = [...new Set(tenantWrites.map((s) => `${s.file}:${s.table}:${s.op}`))].sort();
    expect(pinned).toEqual([
      // super-admin only (getSuperAdminAccess)
      "app/api/admin/org-rename/route.ts:orgs:update",
      // platform ops admin MCP (name only)
      "lib/admin-mcp/orgs-patch.ts:orgs:update",
      // approval-gated policy writers (admin MCP fulfilment / service paths)
      "lib/approval-kind-routes/data.ts:orgs:update",
      "lib/approval-workflow/data.ts:orgs:update",
      // org bootstrap at signup (service role, new org only)
      "lib/auth/session.ts:orgs:insert",
      "lib/auth/session.ts:subscriptions:insert",
      // Stripe plan downgrade → cancel pending approvals for revoked tools
      "lib/billing/approval-cancellation.ts:approval_requests:update",
      // plan / billing columns (Stripe webhook handlers)
      "lib/billing/org-plan.ts:orgs:update",
      // approvals: create / resolve / telegram state (routes gated by requireCapability / webhook verification)
      "lib/data/approvals.ts:approval_requests:insert",
      "lib/data/approvals.ts:approval_requests:update",
      "lib/data/approvals.ts:audit_events:insert",
      // appendAuditEvent (server-side only)
      "lib/data/audit.ts:audit_events:insert",
      "lib/data/employees.ts:audit_events:insert",
      // approval-gated org policy writers
      "lib/data/ingress-handoff.ts:orgs:update",
      "lib/data/internal-audience-rule.ts:orgs:update",
      "lib/data/mail-policy.ts:orgs:update",
      "lib/data/mouth-routing-policy.ts:orgs:update",
      "lib/data/org-context.ts:orgs:update",
      "lib/data/reply-policy.ts:orgs:update",
      "lib/data/scheduling-policy.ts:orgs:update",
      "lib/data/stuck-watch-policy.ts:orgs:update",
      // Stripe customer / subscription mirror, trial cron, super-admin trial extension
      "lib/data/subscriptions.ts:orgs:update",
      "lib/data/subscriptions.ts:subscriptions:update",
      "lib/data/subscriptions.ts:subscriptions:upsert",
    ]);
  });

  test("plan / billing columns and subscriptions rows are written only by billing modules", () => {
    const BILLING_FILES = ["lib/auth/session.ts", "lib/billing/org-plan.ts", "lib/data/subscriptions.ts"];
    const billingWrites = tenantWrites.filter(
      (s) =>
        s.table === "subscriptions" ||
        (s.table === "orgs" &&
          s.columns.some((c) => c === "<dynamic>" || ORG_BILLING_COLUMNS.includes(c)))
    );
    expect(billingWrites.length).toBeGreaterThan(5);
    expect([...new Set(billingWrites.map((s) => s.file))].sort()).toEqual(BILLING_FILES);
    // session.ts: bootstrap only (new org row + its trial subscription)
    expect(
      billingWrites.filter((s) => s.file === "lib/auth/session.ts").map((s) => `${s.table}:${s.op}`).sort()
    ).toEqual(["orgs:insert", "subscriptions:insert"]);
  });

  test("billing writers are reached only from Stripe webhook / cron / super-admin / approval-gated fulfilment", () => {
    const callers = (fn: string) =>
      sources
        .filter((f) => new RegExp(`\\b${fn}\\s*\\(`).test(f.text))
        .map((f) => f.path)
        .filter((p) => !/^lib\/(billing\/org-plan|data\/subscriptions)\.ts$/.test(p))
        .sort();
    for (const fn of ["updateOrgPlanKey", "updateOrgBillingStatus", "scheduleOrgPlanDowngrade", "applyScheduledPlanChange", "clearScheduledPlanChange"]) {
      expect(callers(fn).every((p) => /^lib\/billing\/plan-(change|upgrade)-handler\.ts$/.test(p))).toBe(true);
    }
    expect(callers("upsertSubscription")).toEqual(["app/api/webhooks/stripe/route.ts"]);
    expect(callers("expireTrials")).toEqual(["app/api/cron/expire-trials/route.ts"]);
    expect(callers("extendTrial")).toEqual(["app/api/admin/trial-extension/route.ts"]);
    expect(callers("setOrgStripeCustomerId")).toEqual(["lib/external-contract-card/checkout-setup.ts"]);
    const handlers = sources
      .filter((f) => /from\s+["'][^"']*plan-(change|upgrade)-handler["']/.test(f.text))
      .map((f) => f.path)
      .sort();
    expect(handlers).toEqual(["lib/billing/stripe-plan-webhook.ts"]);
    expect(src("app/api/webhooks/stripe/route.ts")).toContain("stripe.webhooks.constructEvent(");
    expect(src("app/api/cron/expire-trials/route.ts")).toContain("`Bearer ${secret}`");
    expect(src("app/api/admin/trial-extension/route.ts")).toContain("getSuperAdminAccess()");
  });

  test("user-facing routes that reach the writers carry an explicit server-side authz check", () => {
    for (const r of ["approve", "reject", "revise"]) {
      expect(src(`app/api/approvals/[id]/${r}/route.ts`)).toContain('requireCapability(req, "approve_actions")');
    }
    expect(src("app/api/admin/org-rename/route.ts")).toContain("getSuperAdminAccess()");
    expect(src("app/api/settings/sod-warn-policy/route.ts")).toMatch(/PUT[\s\S]*requireOrgAdminSession\(\)/);
    expect(src("app/api/approval-routes/route.ts")).toMatch(/POST[\s\S]*\["owner", "admin"\]\.includes\(member\.role\)/);
  });
});

describe("migration 20261004500000: drop direct PostgREST write policies", () => {
  const dir = join(ROOT, "supabase", "migrations");
  const names = readdirSync(dir).filter((n) => n.endsWith(".sql")).sort();
  const file = names.find((n) => n.startsWith("20261004500000_"));
  const migration = file ? readFileSync(join(dir, file), "utf8") : "";
  const executable = migration.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");

  test("migration exists and is the latest timestamp", () => {
    expect(file).toBeDefined();
    const stamps = names.map((n) => n.split("_")[0]).filter((s) => s.length === 14 && s !== "20261004500000");
    expect(stamps.every((s) => s < "20261004500000")).toBe(true);
    // #255's pending 20261004400000 must still sort before this one
    expect("20261004400000" < "20261004500000").toBe(true);
  });

  test("each write policy's last drop comes after its last create (migrations in order)", () => {
    // executable SQL only: the rollback block in the migration is commented out
    const all = names
      .map((n) => readFileSync(join(dir, n), "utf8"))
      .join("\n")
      .split("\n")
      .filter((l) => !/^\s*--/.test(l))
      .join("\n")
      .toLowerCase();
    for (const [table, policy] of POLICIES) {
      const lastCreate = all.lastIndexOf(`create policy ${policy}`);
      const lastDrop = all.lastIndexOf(`drop policy if exists ${policy} on public.${table}`);
      expect(lastCreate).toBeGreaterThan(-1);
      expect(lastDrop).toBeGreaterThan(lastCreate);
    }
  });

  test("table write privileges are revoked from anon / authenticated; no new policy or data change", () => {
    expect(executable.toLowerCase()).toMatch(
      /revoke insert, update, delete, truncate on public\.orgs, public\.subscriptions, public\.audit_events, public\.approval_requests from anon, authenticated;/
    );
    expect(executable).not.toMatch(/create policy|grant |insert into|update public\.|delete from|alter table/i);
  });

  test("a documented rollback block restores the previous state", () => {
    expect(migration).toContain("-- ROLLBACK (down)");
    for (const [table, policy] of POLICIES) {
      expect(migration).toMatch(new RegExp(`--\\s*create policy ${policy} on public\\.${table}`));
    }
    expect(migration).toMatch(/--\s*grant insert, update, delete, truncate on public\.orgs, public\.subscriptions, public\.audit_events, public\.approval_requests to anon, authenticated;/);
  });

  test("schema.sql (fresh installs) no longer creates the four write policies and revokes writes", () => {
    const schema = src("supabase/schema.sql").toLowerCase();
    for (const [, policy] of POLICIES) {
      expect(schema).not.toContain(`create policy ${policy}`);
    }
    expect(schema).toContain(
      "revoke insert, update, delete, truncate on public.orgs, public.subscriptions, public.audit_events, public.approval_requests from anon, authenticated;"
    );
    // read policies stay
    for (const p of ["orgs_select_member", "approvals_select", "audit_select", "subscriptions_select"]) {
      expect(schema).toContain(`create policy ${p}`);
    }
  });
});

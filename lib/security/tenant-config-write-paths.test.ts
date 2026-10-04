/**
 * RLS write holes, phase 2 (木村 review (c), 2026-10-04): the tenant
 * configuration / credential tables below still had `*_write_admin` (FOR ALL
 * using is_org_admin) policies plus the default anon / authenticated table
 * grants, and audit_external_contract_card_events had a member INSERT policy.
 * An org admin (or, for the card audit, any member) could therefore write them
 * directly through PostgREST with their session JWT + the public anon key,
 * bypassing every server-side check (capabilities, approval gating, secret
 * hashing, audit logging).
 *
 * End state pinned here (same method as #258 / 20261004500000):
 * - every app write to these tables goes through the service-role client in a
 *   server module; no user-session client writes them (inventory pinned)
 * - the user-facing routes that reach those writers carry an explicit
 *   server-side authz check
 * - migration 20261004600000 drops the write policies and revokes table write
 *   privileges from anon / authenticated on the 14 config tables AND the
 *   formerly-LOW tables (gateway_links, agentmail_inboxes, lp_*) (documented
 *   rollback); SELECT policies and service_role stay
 * - credentials are unreadable from any user session: credentials_select is
 *   dropped and SELECT is revoked from anon / authenticated (no app code reads
 *   credentials with a user-session client — pinned below)
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { scanTableAccess, WRITE_OPS, type SourceFile } from "../../tests/helpers/table-write-scan";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const STAMP = "20261004600000";
/** [table, write policy, command, using | null, with check | null] exactly as created before this migration */
const POLICIES = [
  ["credentials", "credentials_write_admin", "all", "public.is_org_admin(org_id)", null],
  ["org_admin_agents", "org_admin_agents_write_admin", "all", "public.is_org_admin(org_id)", "public.is_org_admin(org_id)"],
  ["employees", "employees_write_admin", "all", "public.is_org_admin(org_id)", null],
  ["employee_bindings", "bindings_write_admin", "all", "public.is_org_admin(org_id)", null],
  ["org_parties", "org_parties_write_admin", "all", "public.is_org_admin(org_id)", "public.is_org_admin(org_id)"],
  ["org_channels", "org_channels_write_admin", "all", "public.is_org_admin(org_id)", "public.is_org_admin(org_id)"],
  ["information_assets", "information_assets_write_admin", "all", "public.is_org_admin(org_id)", "public.is_org_admin(org_id)"],
  ["org_notification_channels", "notification_channels_write_admin", "all", "public.is_org_admin(org_id)", "public.is_org_admin(org_id)"],
  ["org_conversation_adapters", "conversation_adapters_write_admin", "all", "public.is_org_admin(org_id)", "public.is_org_admin(org_id)"],
  ["org_sns_adapters", "sns_adapters_write_admin", "all", "public.is_org_admin(org_id)", "public.is_org_admin(org_id)"],
  ["employee_slack_identities", "employee_slack_identities_write_admin", "all", "public.is_org_admin(org_id)", "public.is_org_admin(org_id)"],
  ["org_external_contract_payment_methods", "org_ext_contract_pm_write_admin", "all", "public.is_org_admin(org_id)", "public.is_org_admin(org_id)"],
  ["org_projects", "org_projects_write_admin", "all", "public.is_org_admin(org_id)", "public.is_org_admin(org_id)"],
  ["audit_external_contract_card_events", "audit_ext_card_insert_member", "insert", null, "public.is_org_member(org_id)"],
  ["gateway_links", "gateway_write_admin", "all", "public.is_org_admin(org_id)", null],
  ["agentmail_inboxes", "agentmail_write_admin", "all", "public.is_org_admin(org_id)", null],
  // read policy: credentials become unreadable from any session
  ["credentials", "credentials_select", "select", "public.is_org_member(org_id)", null],
] as const;
/** the 14 tenant config / credential tables (HIGH / MED-HIGH / MEDIUM) */
const TABLES = POLICIES.slice(0, 14).map(([t]) => t) as readonly string[];
/** formerly LOW (木村): closed in the same migration */
const LOW_TABLES = ["gateway_links", "agentmail_inboxes", "lp_handoffs", "lp_wake_webhook_configs", "lp_wake_webhook_events"];
const REVOKED = [...TABLES, ...LOW_TABLES];
const TABLE_LIST = REVOKED.map((t) => `public.${t}`).join(", ");
/** SELECT policies that must survive (schema.sql / migrations) */
const SELECT_POLICIES = [
  "org_admin_agents_select",
  "employees_select",
  "bindings_select",
  "org_parties_select",
  "org_channels_select",
  "information_assets_select",
  "notification_channels_select",
  "conversation_adapters_select",
  "sns_adapters_select",
  "employee_slack_identities_select",
  "org_ext_contract_pm_select",
  "org_projects_select",
  "audit_ext_card_select",
  "gateway_select",
  "agentmail_select",
];
/** server modules that read credentials (all via createSupabaseAdminClient) */
const CREDENTIAL_READERS = [
  "lib/auth/approval-authority.ts",
  "lib/auth/employee-credential.ts",
  "lib/data/employees.ts",
];
/** lp_* only admit the service_role JWT (never a session) — kept as-is */
const LP_SERVICE_POLICIES = ["lp_handoffs_service_all", "lp_wake_configs_service_all", "lp_wake_events_service_all"];

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
const writes = sites.filter((s) => TABLES.includes(s.table) && WRITE_OPS.has(s.op));
const lowWrites = sites.filter((s) => LOW_TABLES.includes(s.table) && WRITE_OPS.has(s.op));
const pin = (list: typeof writes) => [...new Set(list.map((s) => `${s.file}:${s.table}:${s.op}`))].sort();

describe("app: tenant config / credential tables are written only server-side", () => {
  test("scanner sees the real code base", () => {
    expect(writes.length).toBeGreaterThan(50);
  });

  test("every write to the 14 tables (and the LOW tables) uses the service-role client", () => {
    expect(writes.filter((s) => s.clientKind !== "service_role")).toEqual([]);
    expect(lowWrites.filter((s) => s.clientKind !== "service_role")).toEqual([]);
  });

  test("no non-literal .from() target could hide a write to these tables", () => {
    const dynamicFrom = sources.flatMap((f) =>
      f.text
        .split("\n")
        .map((line, i) => ({ line, at: `${f.path}:${i + 1}` }))
        .filter(({ line }) => /\.from\(\s*[^"'`\s)[]/.test(line) && !/\b(Array|Buffer|Uint8Array)\.from\(/.test(line))
        .map(({ at }) => at)
    );
    // the only one targets the Stripe ledger constant, not a table in scope
    expect(dynamicFrom).toEqual(["lib/billing/stripe-webhook-ledger.ts:213"]);
  });

  test("write inventory is pinned (a new write path must be reviewed here)", () => {
    expect(pin(writes)).toEqual([
      // per-employee policy setters (approval-gated admin MCP fulfilment)
      "lib/approval-kind-routes/data.ts:employees:update",
      "lib/approval-workflow/data.ts:employees:update",
      // org admin agent: issue (requireCredentialAdmin) / link + ops doc (requireOrgAdminSession)
      "lib/data/admin-agents.ts:org_admin_agents:insert",
      "lib/data/admin-agents.ts:org_admin_agents:update",
      // credentials rotate + employee_bindings ensure / link / rotate / health / revoke / wake webhook
      "lib/data/bindings.ts:credentials:insert",
      "lib/data/bindings.ts:credentials:update",
      "lib/data/bindings.ts:employee_bindings:update",
      "lib/data/bindings.ts:employee_bindings:upsert",
      // settings (requireOrgAdminSession), Slack bot install callback (signed state), admin fulfilment
      "lib/data/conversation-adapters.ts:org_conversation_adapters:upsert",
      // directory: settings (requireOrgAdminSession), audience ledger / classifiers, config-change service
      "lib/data/directory.ts:information_assets:upsert",
      "lib/data/directory.ts:org_channels:delete",
      "lib/data/directory.ts:org_channels:upsert",
      "lib/data/directory.ts:org_parties:delete",
      "lib/data/directory.ts:org_parties:upsert",
      // issue / policy / allowed accounts / terminate (requireCredentialAdmin / requireCapability)
      "lib/data/employees.ts:credentials:insert",
      "lib/data/employees.ts:credentials:update",
      "lib/data/employees.ts:employee_bindings:upsert",
      "lib/data/employees.ts:employees:insert",
      "lib/data/employees.ts:employees:update",
      // per-employee policy setters (approval-gated admin MCP fulfilment)
      "lib/data/ingress-handoff.ts:employees:update",
      "lib/data/mail-policy.ts:employees:update",
      "lib/data/mouth-routing-policy.ts:employees:update",
      // settings (requireOrgAdminSession), Slack shared approval app, admin fulfilment
      "lib/data/notification-channels.ts:org_notification_channels:insert",
      "lib/data/notification-channels.ts:org_notification_channels:update",
      // default project bootstrap + settings (requireOrgAdminSession)
      "lib/data/projects.ts:org_projects:delete",
      "lib/data/projects.ts:org_projects:insert",
      "lib/data/projects.ts:org_projects:update",
      "lib/data/projects.ts:org_projects:upsert",
      "lib/data/reply-policy.ts:employees:update",
      "lib/data/scheduling-policy.ts:employees:update",
      // Slack OAuth callback (signed state) / unlink (requireCapability)
      "lib/data/slack-identities.ts:employee_slack_identities:delete",
      "lib/data/slack-identities.ts:employee_slack_identities:upsert",
      // no caller today
      "lib/data/sns-adapters.ts:org_sns_adapters:upsert",
      // external contract card: checkout setup / Stripe webhook / portal link (approval-gated)
      "lib/external-contract-card/data.ts:audit_external_contract_card_events:insert",
      "lib/external-contract-card/data.ts:org_external_contract_payment_methods:insert",
      "lib/external-contract-card/data.ts:org_external_contract_payment_methods:update",
    ]);
  });

  test("formerly-LOW tables inventory is pinned (all service_role)", () => {
    expect(pin(lowWrites)).toEqual([
      "lib/auth/session.ts:gateway_links:insert",
      "lib/data/org-context.ts:gateway_links:upsert",
      "lib/lp/handoffs.ts:lp_handoffs:insert",
      "lib/lp/handoffs.ts:lp_handoffs:update",
      "lib/lp/wake-webhook.ts:lp_wake_webhook_configs:insert",
      "lib/lp/wake-webhook.ts:lp_wake_webhook_configs:update",
      "lib/lp/wake-webhook.ts:lp_wake_webhook_events:insert",
      "lib/lp/wake-webhook.ts:lp_wake_webhook_events:update",
    ]);
  });

  test("user-facing routes that reach the writers carry an explicit server-side authz check", () => {
    const has = (file: string, re: RegExp) => expect(src(file)).toMatch(re);
    has("app/api/employees/issue/route.ts", /POST[\s\S]*requireCredentialAdmin\(/);
    has("app/api/employees/[id]/rotate/route.ts", /POST[\s\S]*requireCredentialAdmin\(/);
    has("app/api/admin-mcp/issue/route.ts", /POST[\s\S]*requireCredentialAdmin\(req\)/);
    has("app/api/employees/[id]/policy/route.ts", /PATCH[\s\S]*requireCapability\(req, "hire_issue_credentials"/);
    has("app/api/employees/[id]/terminate/route.ts", /POST[\s\S]*requireCapability\(/);
    has("app/api/employees/[id]/binding/route.ts", /PATCH[\s\S]*requireCapability\(/);
    has("app/api/employees/[id]/slack-identity/route.ts", /PATCH[\s\S]*requireCapability\([\s\S]*DELETE[\s\S]*requireCapability\(/);
    for (const r of ["admin-mcp/link", "admin-mcp/ops-doc"]) has(`app/api/${r}/route.ts`, /POST[\s\S]*requireOrgAdminSession\(\)/);
    for (const r of ["settings/directory", "settings/projects"]) {
      has(`app/api/${r}/route.ts`, /PUT[\s\S]*requireOrgAdminSession\(\)[\s\S]*DELETE[\s\S]*requireOrgAdminSession\(\)/);
    }
    for (const r of ["settings/conversation-adapters", "settings/notification-channels"]) {
      has(`app/api/${r}/route.ts`, /PUT[\s\S]*requireOrgAdminSession\(\)/);
    }
    has("app/api/slack/oauth/callback/route.ts", /verifySlackOAuthState\(state, nonce\)/);
    has("app/api/slack/bot-install/callback/route.ts", /verifySlackBotInstallState\(state, nonce\)/);
    // (d) gateway status is tenant-level integration state → owner/admin only
    has("app/api/gateway/link/route.ts", /export async function POST[\s\S]*requireOrgAdminSession\(\)/);
    // employee binding link / health probe write employee_bindings → owner/admin only
    has("app/api/employees/[id]/link/route.ts", /export async function POST[\s\S]*requireOrgAdminSession\(\)/);
    has("app/api/employees/[id]/health/route.ts", /export async function POST[\s\S]*requireOrgAdminSession\(\)/);
    // ?forceFail is a demo-only switch (lib/mode isDemoMode)
    has("app/api/employees/[id]/health/route.ts", /const forceFail =\s*isDemoMode\(\) &&/);
  });
});

describe(`migration ${STAMP}: drop direct PostgREST write policies (phase 2)`, () => {
  const dir = join(ROOT, "supabase", "migrations");
  const names = readdirSync(dir).filter((n) => n.endsWith(".sql")).sort();
  const file = names.find((n) => n.startsWith(`${STAMP}_`));
  const migration = file ? readFileSync(join(dir, file), "utf8") : "";
  const executable = migration
    .split("\n")
    .filter((l) => !/^\s*--/.test(l))
    .join("\n")
    .toLowerCase();

  test("migration exists and sorts after #258 (20261004500000)", () => {
    expect(file).toBeDefined();
    expect(names.indexOf(file!)).toBeGreaterThan(names.findIndex((n) => n.startsWith("20261004500000_")));
  });

  test("each dropped policy's last drop comes after its last create (migrations in order)", () => {
    const all = names
      .map((n) => readFileSync(join(dir, n), "utf8"))
      .join("\n")
      .split("\n")
      .filter((l) => !/^\s*--/.test(l))
      .join("\n")
      .toLowerCase();
    for (const [table, policy] of POLICIES) {
      const lastCreate = all.lastIndexOf(`create policy ${policy} on`);
      const lastDrop = all.lastIndexOf(`drop policy if exists ${policy} on public.${table};`);
      expect(lastCreate).toBeGreaterThan(-1);
      expect(lastDrop).toBeGreaterThan(lastCreate);
    }
  });

  test("write privileges revoked on the 14 config + 5 formerly-LOW tables; credentials SELECT revoked; no new policy, grant or data change", () => {
    expect(REVOKED.length).toBe(19);
    expect(executable).toContain(`revoke insert, update, delete, truncate on ${TABLE_LIST} from anon, authenticated;`);
    expect(executable).toContain("revoke select on public.credentials from anon, authenticated;");
    expect(executable).not.toMatch(/create policy|grant |insert into|update public\.|delete from|alter table|truncate public/);
    // other SELECT policies are not dropped; lp_* service-role-only policies are kept
    for (const p of [...SELECT_POLICIES, ...LP_SERVICE_POLICIES]) expect(executable).not.toContain(`drop policy if exists ${p} `);
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
    for (const [table, policy, cmd, using, check] of POLICIES) {
      const body =
        `create policy ${policy} on public.${table} for ${cmd}` +
        (using ? ` using (${using})` : "") +
        (check ? ` with check (${check})` : "") +
        ";";
      expect(down).toContain(body);
    }
    expect(down).toContain(`grant insert, update, delete, truncate on ${TABLE_LIST} to anon, authenticated;`);
    expect(down).toContain("grant select on public.credentials to anon, authenticated;");
    expect(down.match(/create policy/g)?.length).toBe(POLICIES.length);
  });

  test("schema.sql (fresh installs) no longer creates the dropped policies and revokes; other SELECT policies stay", () => {
    const schemaExec = src("supabase/schema.sql")
      .toLowerCase()
      .split("\n")
      .filter((l) => !/^\s*--/.test(l))
      .join("\n");
    for (const [, policy] of POLICIES) {
      expect(schemaExec).not.toContain(`create policy ${policy} `);
    }
    const inSchema = REVOKED.filter((t) => new RegExp(`create table if not exists (public\\.)?${t}\\s*\\(`).test(schemaExec));
    // ext-contract (2) and lp_* (3) tables live only in migrations
    expect(inSchema.length).toBe(14);
    expect(schemaExec).toContain(
      `revoke insert, update, delete, truncate on ${inSchema.map((t) => `public.${t}`).join(", ")} from anon, authenticated;`
    );
    expect(schemaExec).toContain("revoke select on public.credentials from anon, authenticated;");
    for (const p of SELECT_POLICIES.filter((p) => !/^(org_ext_contract_pm|audit_ext_card)_/.test(p))) {
      expect(schemaExec).toContain(`create policy ${p} `);
    }
  });
});

describe("credentials are read only by server code (service role)", () => {
  const reads = sites.filter((s) => s.table === "credentials" && s.op === "select");

  test("no user-session / unknown client reads credentials", () => {
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.filter((s) => s.clientKind !== "service_role")).toEqual([]);
    expect(sites.filter((s) => s.clientKind === "user_session")).toEqual([]);
  });

  test("credentials reader inventory is pinned", () => {
    expect([...new Set(reads.map((s) => s.file))].sort()).toEqual(CREDENTIAL_READERS);
  });
});

describe("formerly-LOW tables: write paths are server routes with their own checks", () => {
  const callers = (fn: string) =>
    sources
      .filter((f) => new RegExp(`\\b${fn}\\s*\\(`).test(f.text) && !f.path.startsWith("lib/lp/"))
      .map((f) => f.path)
      .sort();

  test("gateway_links writers use the service-role client", () => {
    for (const f of ["lib/auth/session.ts", "lib/data/org-context.ts"]) {
      const gw = sites.filter((s) => s.file === f && s.table === "gateway_links" && WRITE_OPS.has(s.op));
      expect(gw.length).toBe(1);
      expect(gw[0].clientKind).toBe("service_role");
    }
  });

  test("LP handoff / wake-webhook writers are reached only from their API routes (guest session + CSRF / secret)", () => {
    for (const fn of ["createHandoff", "confirmHandoff", "cancelHandoff"]) {
      expect(callers(fn)).toEqual(["app/api/lp/handoff/route.ts"]);
    }
    expect(callers("recordWebhookEvent")).toEqual(["app/api/webhooks/lp-wake/[path]/route.ts"]);
    expect(callers("updateWebhookEventStatus")).toEqual(["app/api/webhooks/lp-wake/[path]/route.ts"]);
    expect(callers("createWebhookConfig")).toEqual([]);
    const handoff = src("app/api/lp/handoff/route.ts");
    for (const verb of ["POST", "PUT"]) {
      expect(handoff).toMatch(new RegExp(`export async function ${verb}[\\s\\S]*?resolveGuestJourney\\(request, \\{ requireCsrf: true \\}\\)`));
    }
    expect(src("app/api/webhooks/lp-wake/[path]/route.ts")).toContain("validateWebhookRequest(endpointPath, secret)");
  });

  test("LP client components never talk to Supabase directly (only fetch to /api routes)", () => {
    const lpClient = sources.filter((f) => f.path.startsWith("app/lp/") && /^["']use client["']/m.test(f.text));
    expect(lpClient.length).toBeGreaterThan(0);
    for (const f of lpClient) {
      expect(`${f.path}:${/supabase/i.test(f.text)}`).toBe(`${f.path}:false`);
    }
  });
});

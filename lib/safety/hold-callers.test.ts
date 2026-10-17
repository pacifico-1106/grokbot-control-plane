/**
 * S2 caller inventory (design §2.3, same idea as the #339 json-utf8 rule): every
 * entry into employee work is listed here with the checkpoint that covers it.
 * A NEW caller of one of these entry points fails this test until someone adds
 * it below — i.e. confirms it goes through a checkpoint (or adds one).
 * The checkpoints themselves must keep calling the hold check.
 */
import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** entry point → files allowed to call it (the definition file included). */
export const PINNED: Record<string, string[]> = {
  // G3 inside (assertExecutable) — every caller, authenticated or not.
  "runGatewayInvoke(": ["app/api/gateway/invoke/route.ts", "lib/mcp/tools.ts", "lib/stuck-watch/admin-handlers.ts"],
  // G4 inside (assertApprovalExecutionAuthority before + after the claim, assertTicketNotHeld).
  "executeApproval(": ["lib/admin-mcp/fulfill-admin.ts", "lib/approvals/fulfill.ts", "lib/config-change-request/service.ts"],
  // G5 inside.
  "postWake(": ["lib/slack/mention-ingress.ts"],
  // G5 inside (checkOperable phase:"wake"). Ingress already checked; wake re-checks.
  "dispatchLineConversationWake(": ["lib/comm/line-ingress.ts"],
  // G1 inside.
  "resolveEmployeeCredential(": ["app/api/gateway/invoke/route.ts", "app/api/mcp/route.ts", "lib/mcp-oauth/resource-server.ts"],
  // G2 inside (resolveOAuthAccessToken).
  "resolveMcpCredential(": ["app/api/mcp/route.ts"],
  "resolveOAuthAccessToken(": ["lib/mcp-oauth/resource-server.ts"],
  // + two conservative hits of the widened import() scan (木村 10/12 07:15), reviewed: both load
  // "@/lib/data" inside Promise.all([...]) and never call assertExecutable.
  "assertExecutable(": ["lib/gateway/invoke.ts", "lib/mcp-oauth/consent.ts", "lib/slack/approval-app-scope-notice.ts"],
  // stuckWatch.retry → runW2FulfillRetry → W2 eligibility (approval_held) + G4.
  "runW2FulfillRetry(": ["lib/stuck-watch/admin-handlers.ts", "lib/stuck-watch/w2-unfulfilled.ts"],
  "checkSubscriptionPrincipal(": ["lib/mcp-events/service.ts"],
  "handleTokenRequest(": ["app/api/oauth/token/route.ts"],
  // S3: stop / release are reachable ONLY from human-session routes and the inbox stop button
  // (all refuse AI credentials first). An MCP tool or an AI path importing these fails here.
  "startHold(": ["app/api/admin/holds/stop/route.ts", "app/api/holds/stop/route.ts", "lib/safety/hold-inbox.ts"],
  "requestHoldRelease(": ["app/api/holds/release/request/route.ts"],
  "approveHoldRelease(": ["app/api/holds/release/approve/route.ts"],
};

/** checkpoint file → the hold call it must contain (the gate itself). */
const GATES: Array<[string, string, RegExp]> = [
  ["G1 credential", "lib/auth/employee-credential.ts", /checkOperable\(\{[^}]*phase: "credential"/],
  ["G2 OAuth RS", "lib/mcp-oauth/resource-server.ts", /checkOperable\(\{[^}]*phase: "oauth"/],
  ["G2 consent", "lib/mcp-oauth/consent.ts", /checkOperable\(\{[^}]*phase: "oauth_consent"/],
  ["G2 token", "lib/mcp-oauth/token-endpoint.ts", /checkOperable\(\{[^}]*phase: "oauth_refresh"/],
  ["G3 gateway entry", "lib/data/bindings.ts", /checkOperable\(\{[^}]*phase: "gateway"/],
  ["G4 execution authority", "lib/approvals/execution-authority.ts", /assertTicketNotHeld\(approval\)[\s\S]*phase: "approval_execution"/],
  ["G4 executeApproval", "lib/approvals/execution.ts", /assertTicketNotHeld\(approval\)/],
  ["G4 approvalId re-invoke (priorApprovalOk)", "lib/gateway/invoke.ts", /if \(prior && heldTicketMarker\(prior\.metadata\)\)/],
  ["G4 approvalId re-invoke assertTicketNotHeld", "lib/gateway/invoke.ts", /assertTicketNotHeld\(prior\)/],
  ["pre-send LINE (LINE PoC L-5/L-6)", "lib/comm/pre-send.ts", /preSendHoldCode\(/],
  ["W2 / stuckWatch.retry", "lib/stuck-watch/w2-unfulfilled.ts", /heldTicketMarker\(approval\.metadata\)/],
  ["G5 wake", "lib/slack/mention-ingress.ts", /checkOperable\(\{[^}]*phase: "wake"/],
  ["G5 inbound notice wake", "lib/inbound-notice/intake.ts", /checkOperable\(\{[^}]*phase: "wake"/],
  ["G5 LINE account wake (LINE PoC L-4)", "lib/comm/line-ingress.ts", /checkOperable\(\{[^}]*phase: "wake"/],
  ["G5 LINE conversation wake (LINE PoC L-7)", "lib/comm/line-wake.ts", /checkOperable\(\{[^}]*phase: "wake"/],
  ["G5 MCP Events", "lib/mcp-events/principal.ts", /checkOperable\(\{[^}]*phase: "mcp_events"/],
  ["pre-send Slack", "lib/gateway/adapters/slack.ts", /preSendHoldCode\(/],
  ["pre-send Slack file", "lib/gateway/adapters/slack-file-upload.ts", /preSendHoldCode\(/],
  ["pre-send SNS", "lib/gateway/adapters/sns.ts", /preSendHoldCode\(/],
  ["pre-send comm.delete", "lib/comm-delete/run.ts", /preSendHoldCode\(ctx\.orgId, ctx\.employeeId\)[\s\S]*deleteSlackPost\(/],
];

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "__tests__") continue;
      sources(p, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** entry → the module(s) that define or re-export it (paths without extension). */
const DEFINED_IN: Record<string, string[]> = {
  runGatewayInvoke: ["lib/gateway/invoke"],
  executeApproval: ["lib/approvals/execution"],
  postWake: ["lib/slack/mention-ingress"],
  dispatchLineConversationWake: ["lib/comm/line-wake"],
  resolveEmployeeCredential: ["lib/auth/employee-credential"],
  resolveMcpCredential: ["lib/mcp-oauth/resource-server"],
  resolveOAuthAccessToken: ["lib/mcp-oauth/resource-server"],
  assertExecutable: ["lib/data/bindings", "lib/data/index", "lib/bindings"],
  runW2FulfillRetry: ["lib/stuck-watch/w2-unfulfilled"],
  checkSubscriptionPrincipal: ["lib/mcp-events/principal"],
  handleTokenRequest: ["lib/mcp-oauth/token-endpoint"],
  startHold: ["lib/safety/hold-actions"],
  requestHoldRelease: ["lib/safety/hold-actions"],
  approveHoldRelease: ["lib/safety/hold-actions"],
};

const stripExt = (p: string) => p.replace(/\.(tsx?|mjs|js)$/, "").replace(/\/index$/, "/index");
function resolveSpec(spec: string, fromPath: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = spec.slice(2);
  else if (spec.startsWith(".")) base = join(dirname(fromPath), spec).replace(/\\/g, "/");
  else if (/^(lib|app|components|hooks)\//.test(spec)) base = spec; // root-relative (baseUrl)
  else return null; // packages
  base = stripExt(base);
  return base;
}
function sameModule(resolved: string, mod: string): boolean {
  return resolved === mod || resolved === `${mod}/index` || `${resolved}/index` === mod;
}

/**
 * Import-based caller detection (木村 10/12: the old call regex missed `ns.fn(`,
 * `import { fn as alias }` and `const { fn: x } = await import(...)`).
 * A file is a caller of `entry` when it:
 *  - imports `entry` by name from a defining module (any alias; `import type` excluded),
 *  - namespace-imports a defining module (`import * as ns`) — counted conservatively,
 *  - dynamically imports a defining module and mentions `entry`, or keeps the module object
 *    (`const m = await import(...)`) — counted conservatively,
 *  - re-exports `entry`, or
 *  - is a defining module that calls `entry` itself.
 */
export function callersIn(files: Array<{ path: string; text: string }>, entryWithParen: string): string[] {
  const entry = entryWithParen.replace(/\($/, "");
  const mods = DEFINED_IN[entry] ?? [];
  const out = new Set<string>();
  const nameRe = new RegExp(`\\b${entry}\\b`);
  for (const f of files) {
    const self = stripExt(f.path);
    if (mods.some((m) => self === m)) {
      const calls = f.text.replace(new RegExp(`function\\s+${entry}\\b`, "g"), "").match(new RegExp(`(^|[^A-Za-z0-9_$])${entry}\\s*[(<]`, "m"));
      if (calls) out.add(f.path);
      continue;
    }
    const fromDefining = (spec: string) => {
      const r = resolveSpec(spec, f.path);
      return r !== null && mods.some((m) => sameModule(r, m));
    };
    // static imports / re-exports
    for (const m of f.text.matchAll(/(import|export)\s+(type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["']/g)) {
      if (m[2] || !fromDefining(m[4])) continue;
      const clause = m[3];
      if (/\*\s+as\s+\w+/.test(clause) || (m[1] === "export" && /^\*/.test(clause.trim()))) { out.add(f.path); continue; }
      const named = /\{([\s\S]*)\}/.exec(clause)?.[1] ?? "";
      const names = named.split(",").map((x) => x.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]).filter(Boolean);
      if (names.includes(entry)) out.add(f.path);
    }
    // dynamic imports
    for (const m of f.text.matchAll(/(const|let|var)\s+([^=;]{1,300}?)=\s*(await\s+)?import\(\s*["']([^"']+)["']\s*\)/g)) {
      if (!fromDefining(m[4])) continue;
      const lhs = m[2].trim();
      if (!lhs.startsWith("{") || nameRe.test(lhs)) out.add(f.path);
    }
    for (const m of f.text.matchAll(/import\(\s*["']([^"']+)["']\s*\)\s*\)?\s*\.\s*(\w+)/g)) {
      if (fromDefining(m[1]) && m[2] === entry) out.add(f.path);
    }
    // require("x") (lint bans it in app code; detected anyway)
    for (const m of f.text.matchAll(/(?:^|[^.\w$])require\(\s*["'`]([^"'`$]+)["'`]\s*\)/g)) {
      if (fromDefining(m[1])) out.add(f.path);
    }
    // import(`literal`) without ${} = a literal; any other import() argument (variable,
    // template with ${}, expression) cannot be resolved → counted as a caller of every entry.
    for (const m of f.text.matchAll(/(?:^|[^.\w$])import\(\s*([^)]*?)\s*\)/g)) {
      const arg = m[1];
      const lit = /^["']([^"']+)["']$/.exec(arg) ?? /^`([^`$]+)`$/.exec(arg);
      if (!lit) { out.add(f.path); continue; }
      if (!fromDefining(lit[1])) continue;
      // a bare / returned / chained import() of a defining module counts (conservative),
      // unless it is destructured into names that don't include the entry.
      const before = f.text.slice(Math.max(0, (m.index ?? 0) - 320), m.index ?? 0);
      const destructured = /(const|let|var)\s+(\{[^=;]*\})\s*=\s*(await)?\s*\(?\s*$/.exec(before);
      if (!destructured || nameRe.test(destructured[2])) out.add(f.path);
    }
    // import("x").then((m) => m.entry(...)) and similar: module mentioned + entry mentioned
    for (const m of f.text.matchAll(/import\(\s*["']([^"']+)["']\s*\)\s*\.then/g)) {
      if (fromDefining(m[1]) && nameRe.test(f.text)) out.add(f.path);
    }
  }
  return [...out].sort();
}

// 木村 10/12 07:15 (2): lib/ and app/ plus components/, hooks/ and the root files (middleware.ts …).
const ROOT_FILES = readdirSync(ROOT).filter((n) => /\.(ts|tsx)$/.test(n) && !/\.d\.ts$/.test(n) && !/\.test\.tsx?$/.test(n)).map((n) => join(ROOT, n));
const files = [...["lib", "app", "components", "hooks"].flatMap((d) => sources(join(ROOT, d))), ...ROOT_FILES]
  .map((p) => ({ path: relative(ROOT, p), text: readFileSync(p, "utf8") }));

for (const [entry, pinned] of Object.entries(PINNED)) {
  test(`caller inventory: ${entry} — only the reviewed callers (a new one must be added here after checking its checkpoint)`, () => {
    expect(callersIn(files, entry)).toEqual([...pinned].sort());
  });
}
for (const [name, file, re] of GATES) {
  test(`checkpoint ${name} (${file}) still calls the hold check`, () => {
    expect(re.test(readFileSync(join(ROOT, file), "utf8"))).toBe(true);
  });
}
test("self-check: every import form is detected (木村 10/12 fixtures)", () => {
  const f = (text: string) => callersIn([{ path: "lib/new/x.ts", text }], "runGatewayInvoke(");
  expect(f("import * as gw from '@/lib/gateway/invoke'; await gw.runGatewayInvoke({})")).toEqual(["lib/new/x.ts"]);
  expect(f("import { runGatewayInvoke as rgi } from '@/lib/gateway/invoke'; await rgi({})")).toEqual(["lib/new/x.ts"]);
  expect(f("const { runGatewayInvoke: r } = await import('@/lib/gateway/invoke'); await r({})")).toEqual(["lib/new/x.ts"]);
  expect(f("const gw = await import(\"@/lib/gateway/invoke\"); await gw.runGatewayInvoke({})")).toEqual(["lib/new/x.ts"]);
  expect(f("import {\n  foo,\n  runGatewayInvoke,\n} from \"../gateway/invoke\";")).toEqual(["lib/new/x.ts"]);
  expect(f("export { runGatewayInvoke } from '@/lib/gateway/invoke';")).toEqual(["lib/new/x.ts"]);
  expect(f("export * from '@/lib/gateway/invoke';")).toEqual(["lib/new/x.ts"]);
  expect(f("await runGatewayInvoke({})")).toEqual([]); // no import → not callable from here
  expect(f("import type { runGatewayInvoke } from '@/lib/gateway/invoke';")).toEqual([]);
  expect(f("import { other } from '@/lib/gateway/invoke';")).toEqual([]);
});
test("self-check: a new file calling an entry point is detected", () => {
  const fake = [...files, { path: "lib/new/skips-the-check.ts", text: "import { runGatewayInvoke } from '@/lib/gateway/invoke';\nawait runGatewayInvoke({ employeeId })" }];
  expect(callersIn(fake, "runGatewayInvoke(")).toContain("lib/new/skips-the-check.ts");
  expect(callersIn(fake, "runGatewayInvoke(")).not.toEqual([...PINNED["runGatewayInvoke("]].sort());
});
test("self-check v2: require, template / variable import(), () => import(), root-relative spec (木村 10/12 07:15)", () => {
  const f = (text: string) => callersIn([{ path: "lib/new/x.ts", text }], "runGatewayInvoke(");
  expect(f("const { runGatewayInvoke } = require('@/lib/gateway/invoke'); runGatewayInvoke({})")).toEqual(["lib/new/x.ts"]);
  expect(f("const m = require(\"../gateway/invoke\"); m.runGatewayInvoke({})")).toEqual(["lib/new/x.ts"]);
  expect(f("const m = await import(`@/lib/gateway/invoke`); await m.runGatewayInvoke({})")).toEqual(["lib/new/x.ts"]);
  // a non-literal specifier can't be resolved → counted as a caller of every entry (and lint bans it)
  expect(f("const p = '@/lib/gateway/invoke'; const m = await import(p); await m.runGatewayInvoke({})")).toEqual(["lib/new/x.ts"]);
  expect(f("const m = await import(`@/lib/${'gateway'}/invoke`);")).toEqual(["lib/new/x.ts"]);
  expect(f("export const load = () => import('@/lib/gateway/invoke');")).toEqual(["lib/new/x.ts"]);
  expect(f("import { runGatewayInvoke } from 'lib/gateway/invoke'; runGatewayInvoke({})")).toEqual(["lib/new/x.ts"]);
  // still not a caller
  expect(f("const { other } = await import('@/lib/gateway/invoke');")).toEqual([]);
});
test("the inventory scans the root files too (middleware.ts, next.config.ts, …) plus components/ and hooks/", () => {
  const scanned = new Set(files.map((x) => x.path));
  for (const p of ["middleware.ts", "next.config.ts"]) expect(scanned.has(p)).toBe(true);
  expect([...scanned].some((p) => p.startsWith("components/"))).toBe(true);
});
test("ESLint bans require() and import() with a non-literal argument in app code", async () => {
  const { ESLint } = await import("eslint");
  const eslint = new ESLint({ cwd: ROOT });
  const lint = async (code: string, filePath = "lib/new/x.ts") =>
    (await eslint.lintText(code, { filePath: join(ROOT, filePath) }))[0].messages.filter((m) => m.ruleId === "no-restricted-syntax").length;
  expect(await lint("const m = require('@/lib/gateway/invoke');\nexport { m };\n")).toBe(1);
  expect(await lint("const p = 'x';\nexport const a = () => import(p);\n")).toBe(1);
  expect(await lint("export const a = () => import(`@/lib/gateway/invoke`);\n")).toBe(1);
  expect(await lint("export const a = () => import('@/lib/gateway/invoke');\n")).toBe(0);
  expect(await lint("const m = require('x');\nexport { m };\n", "middleware.ts")).toBe(1);
});

/**
 * S2 caller inventory (design §2.3, same idea as the #339 json-utf8 rule): every
 * entry into employee work is listed here with the checkpoint that covers it.
 * A NEW caller of one of these entry points fails this test until someone adds
 * it below — i.e. confirms it goes through a checkpoint (or adds one).
 * The checkpoints themselves must keep calling the hold check.
 */
import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");

/** entry point → files allowed to call it (the definition file included). */
export const PINNED: Record<string, string[]> = {
  // G3 inside (assertExecutable) — every caller, authenticated or not.
  "runGatewayInvoke(": ["app/api/gateway/invoke/route.ts", "lib/gateway/invoke.ts", "lib/mcp/tools.ts", "lib/stuck-watch/admin-handlers.ts"],
  // G4 inside (assertApprovalExecutionAuthority before + after the claim, assertTicketNotHeld).
  "executeApproval(": ["lib/admin-mcp/fulfill-admin.ts", "lib/approvals/fulfill.ts", "lib/config-change-request/service.ts"],
  // G5 inside.
  "postWake(": ["lib/slack/mention-ingress.ts"],
  // G1 inside.
  "resolveEmployeeCredential(": ["app/api/gateway/invoke/route.ts", "app/api/mcp/route.ts", "lib/auth/employee-credential.ts", "lib/mcp-oauth/resource-server.ts"],
  // G2 inside (resolveOAuthAccessToken).
  "resolveMcpCredential(": ["app/api/mcp/route.ts", "lib/mcp-oauth/resource-server.ts"],
  "resolveOAuthAccessToken(": ["lib/mcp-oauth/resource-server.ts"],
  "assertExecutable(": ["lib/bindings.ts", "lib/data/bindings.ts", "lib/gateway/invoke.ts"],
  // stuckWatch.retry → runW2FulfillRetry → W2 eligibility (approval_held) + G4.
  "runW2FulfillRetry(": ["lib/stuck-watch/admin-handlers.ts", "lib/stuck-watch/w2-unfulfilled.ts"],
  "checkSubscriptionPrincipal(": ["lib/mcp-events/principal.ts", "lib/mcp-events/service.ts"],
  "handleTokenRequest(": ["app/api/oauth/token/route.ts", "lib/mcp-oauth/token-endpoint.ts"],
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
  ["W2 / stuckWatch.retry", "lib/stuck-watch/w2-unfulfilled.ts", /heldTicketMarker\(approval\.metadata\)/],
  ["G5 wake", "lib/slack/mention-ingress.ts", /checkOperable\(\{[^}]*phase: "wake"/],
  ["G5 MCP Events", "lib/mcp-events/principal.ts", /checkOperable\(\{[^}]*phase: "mcp_events"/],
  ["pre-send Slack", "lib/gateway/adapters/slack.ts", /preSendHoldCode\(/],
  ["pre-send Slack file", "lib/gateway/adapters/slack-file-upload.ts", /preSendHoldCode\(/],
  ["pre-send SNS", "lib/gateway/adapters/sns.ts", /preSendHoldCode\(/],
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

export function callersIn(files: Array<{ path: string; text: string }>, entry: string): string[] {
  const re = new RegExp(`(^|[^A-Za-z0-9_$.])${entry.replace(/[(]/g, "\\(")}`, "m");
  return files.filter((f) => re.test(f.text)).map((f) => f.path).sort();
}

const files = ["lib", "app"].flatMap((d) => sources(join(ROOT, d))).map((p) => ({ path: relative(ROOT, p), text: readFileSync(p, "utf8") }));

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
test("self-check: a new file calling an entry point is detected", () => {
  const fake = [...files, { path: "lib/new/skips-the-check.ts", text: "await runGatewayInvoke({ employeeId })" }];
  expect(callersIn(fake, "runGatewayInvoke(")).toContain("lib/new/skips-the-check.ts");
  expect(callersIn(fake, "runGatewayInvoke(")).not.toEqual([...PINNED["runGatewayInvoke("]].sort());
});

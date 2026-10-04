/**
 * #254 follow-up 3: every agent wake MUST go through withMcpHandoff.
 *
 * Three layers (see PR):
 *  1. Type: deliverAgentWake() only accepts McpHandoffWakeBody<T>, a branded type that only
 *     withMcpHandoff() produces → a new channel wake that skips the wrapper fails tsc / next build.
 *  2. Runtime: deliverAgentWake() refuses (throws, sends nothing) a body that did not come
 *     out of withMcpHandoff() — even if someone casts around the type.
 *  3. Static scan (this file): no raw fetch() to a wake / callback destination anywhere in
 *     lib/ or app/ except the shared sender; the brand cannot be forged outside the module.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { withMcpHandoff } from "@/lib/mcp/endpoint-handoff";
import { deliverAgentWake } from "@/lib/mcp/wake-delivery";

const ROOT = join(import.meta.dir, "..", "..");
const SENDER = "lib/mcp/wake-delivery.ts";
const BRAND_MODULE = "lib/mcp/endpoint-handoff.ts";
const FLAG = "MCP_ENDPOINT_HANDOFF_ENABLED";

/** Files that send an agent wake today. Each must use the shared path. */
const KNOWN_WAKE_SENDERS = [
  "lib/slack/mention-ingress.ts", // Slack: mention / internal IM / user-token IM / user-token channel
  "lib/approvals/resolve-side-effects.ts", // approval.resolved: Slack / LINE / Telegram / Web / proxy
];

// ── scanner ────────────────────────────────────────────────────────────────
const WAKE_DESTINATION = /\b(wakeWebhookUrl|wake_webhook_url|callbackUrl|callback_url|getWakeWebhookSecret)\b/;
const FETCH_CALL = /\bfetch\(\s*([^,)]*)/g;
const WAKE_ARG = /wake|callback_?url/i;
const BRAND_FORGE = /\bas\s+(unknown\s+as\s+)?McpHandoffWakeBody\b|<McpHandoffWakeBody\b|\bMCP_HANDOFF_WAKE\b|\bHANDED_OFF_WAKES\b|\bmarkHandedOffForTests\b/;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

export function scanSource(rel: string, raw: string): string[] {
  if (rel === SENDER) return [];
  const src = stripComments(raw);
  const problems: string[] = [];
  const fetches = [...src.matchAll(FETCH_CALL)];
  if (fetches.length && WAKE_DESTINATION.test(src)) {
    problems.push(`${rel}: fetch() in a file that reads a wake destination — use deliverAgentWake(withMcpHandoff(...))`);
  }
  for (const m of fetches) {
    if (WAKE_ARG.test(m[1] || "")) problems.push(`${rel}: fetch(${m[1].trim()}) looks like a wake — use deliverAgentWake`);
  }
  if (rel !== BRAND_MODULE && BRAND_FORGE.test(src)) {
    problems.push(`${rel}: McpHandoffWakeBody may only be produced by withMcpHandoff()`);
  }
  if (/\bdeliverAgentWake\(/.test(src) && !/\bwithMcpHandoff\(/.test(src)) {
    problems.push(`${rel}: deliverAgentWake() without withMcpHandoff() in the same module`);
  }
  return problems;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".next" || entry.name === "__fixtures__") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

describe("static scan: no wake bypasses withMcpHandoff", () => {
  test("lib/ + app/ (+ middleware) are clean", () => {
    const files = [...walk(join(ROOT, "lib")), ...walk(join(ROOT, "app")), join(ROOT, "middleware.ts")];
    const problems = files.flatMap((f) => scanSource(relative(ROOT, f), readFileSync(f, "utf8")));
    expect(problems).toEqual([]);
  });

  test("known wake senders use deliverAgentWake + withMcpHandoff (no raw fetch)", () => {
    for (const rel of KNOWN_WAKE_SENDERS) {
      const src = stripComments(readFileSync(join(ROOT, rel), "utf8"));
      expect({ rel, deliver: /\bdeliverAgentWake\(/.test(src) }).toEqual({ rel, deliver: true });
      expect({ rel, wrap: /\bwithMcpHandoff\(/.test(src) }).toEqual({ rel, wrap: true });
      expect({ rel, fetch: /\bfetch\(/.test(src) }).toEqual({ rel, fetch: false });
    }
  });

  test("approval machine e-mail (a wake too) takes its endpoint lines from the shared module", () => {
    const src = stripComments(readFileSync(join(ROOT, "lib/approvals/resolve-side-effects.ts"), "utf8"));
    expect(src).toContain("mcpHandoffMachineLines()");
    expect(src).not.toContain("resolveMcpEndpointUrl()");
  });

  // The scanner itself must catch the bypasses we care about (future LINE / Telegram wakes etc.).
  test("scanner self-check: flags raw fetch wakes, forged brands and unwrapped delivery", () => {
    const bad: Array<[string, string]> = [
      ["lib/line/wake.ts", "export async function wakeLine(b: Binding) { await fetch(b.wakeWebhookUrl, { method: 'POST' }); }"],
      ["lib/telegram/wake.ts", "const lineWakeUrl = x; await fetch(lineWakeUrl, {});"],
      ["lib/approvals/x.ts", "const callbackUrl = e.callbackUrl; await fetch(callbackUrl, {});"],
      ["lib/x/forge.ts", "deliverAgentWake({ url, body: payload as McpHandoffWakeBody<P>, headers: {}, timeoutMs: 1 }); withMcpHandoff;"],
      ["lib/x/unwrapped.ts", "await deliverAgentWake({ url, body, headers: {}, timeoutMs: 1 });"],
    ];
    for (const [rel, src] of bad) expect({ rel, flagged: scanSource(rel, src).length > 0 }).toEqual({ rel, flagged: true });
    const good = "const body = await withMcpHandoff(p, ctx); await deliverAgentWake({ url: t.wakeWebhookUrl, body, headers: {}, timeoutMs: 1 });";
    expect(scanSource("lib/line/wake.ts", good)).toEqual([]);
    // Unrelated outbound calls (Slack Web API, LINE push, Telegram answerCallbackQuery) are fine.
    expect(scanSource("lib/notify/x.ts", "await fetch(`${API}/answerCallbackQuery`, {}); await fetch(`${SLACK_API}/chat.postMessage`, {});")).toEqual([]);
  });
});

// ── runtime ────────────────────────────────────────────────────────────────
let savedFetch: typeof fetch;
let savedFlag: string | undefined;
let sent: Array<{ url: string; init: RequestInit | undefined }> = [];
beforeEach(() => {
  savedFetch = globalThis.fetch;
  savedFlag = process.env[FLAG];
  sent = [];
  globalThis.fetch = (async (input, init) => {
    sent.push({ url: String(input), init });
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = savedFetch;
  if (savedFlag === undefined) delete process.env[FLAG];
  else process.env[FLAG] = savedFlag;
});

const CTX = { orgId: "org_enf", employeeId: "emp_enf", surface: "line" as const, kind: "conversation" as const, trigger: "test" };

describe("runtime: deliverAgentWake only sends wrapped bodies", () => {
  test("unwrapped body (cast around the type) → rejected, nothing sent", async () => {
    const raw = { type: "line.message", text: "hi" };
    await expect(
      deliverAgentWake({ url: "https://example.test/wake", body: raw as never, headers: {}, timeoutMs: 1000 })
    ).rejects.toThrow("wake_without_mcp_handoff");
    // A copy of a wrapped body is not the wrapped body either.
    const wrapped = await withMcpHandoff({ type: "x" }, CTX);
    await expect(
      deliverAgentWake({ url: "https://example.test/wake", body: { ...wrapped } as never, headers: {}, timeoutMs: 1000 })
    ).rejects.toThrow("wake_without_mcp_handoff");
    expect(sent.length).toBe(0);
  });

  test("flag OFF: wrapped body is the same object → request byte-identical to the raw payload", async () => {
    delete process.env[FLAG];
    const raw = { type: "approval.resolved", approvalId: "apr_1", nested: { a: 1 } };
    const body = await withMcpHandoff(raw, CTX);
    expect(body).toBe(raw as typeof body);
    await deliverAgentWake({ url: "https://example.test/wake", body, headers: { "content-type": "application/json" }, timeoutMs: 1000 });
    expect(sent.length).toBe(1);
    expect(sent[0].init?.method).toBe("POST");
    expect(sent[0].init?.body).toBe(JSON.stringify(raw));
    expect(sent[0].init?.headers).toEqual({ "content-type": "application/json" });
  });

  test("flag ON: wrapped body carries mcpHandoff", async () => {
    process.env[FLAG] = "true";
    const body = await withMcpHandoff({ type: "x" }, CTX);
    await deliverAgentWake({ url: "https://example.test/wake", body, headers: {}, timeoutMs: 1000 });
    expect(JSON.parse(String(sent[0].init?.body)).mcpHandoff.schema).toBe("staffpass.mcp_handoff.v1");
  });
});

// ── type level (checked by `npx tsc --noEmit` / `next build`, never executed) ──
export function _typeLevelEnforcement(): void {
  if (Date.now() > 0) return;
  // @ts-expect-error — a wake body that did not go through withMcpHandoff() does not type-check.
  void deliverAgentWake({ url: "https://example.test/wake", body: { type: "line.message" }, headers: {}, timeoutMs: 1 });
}

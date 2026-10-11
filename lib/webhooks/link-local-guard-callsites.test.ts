/**
 * Link-local / metadata block at the two legacy call sites, NO flag
 * (Kimura 2026-10-05 08:57):
 *  - approval.resolved callback (employee.callbackUrl, resolve-side-effects)
 *  - conversation wake webhook (postWake, mention-ingress)
 * WEBHOOK_HARDENING_ENABLED OFF: still fetch (redirects still followed, http /
 * any port / private ranges still allowed) but through the guard dispatcher,
 * so a link-local / metadata destination is refused at connect time on every
 * hop → category address_blocked only. ON: #270 hardened path unchanged.
 *
 * Bun's fetch ignores `dispatcher`, so the fake fetch below behaves like
 * undici: for every hop it runs the dispatcher's connector (guard connector →
 * base connector whose net.connect lookup is guardedLookup) before "sending".
 * The real-undici version of the same scenarios is in link-local-guard.test.ts.
 */
import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY = "test-notification-key-0123456789abcdef-webhooks";

const { DEMO_ORG, getRuntimeAudit, getRuntimeEmployees } = await import("@/lib/demo-data");
const { createApproval, resolveApproval } = await import("@/lib/data/approvals");
const { updateWakeWebhook } = await import("@/lib/data");
const { bindEmployeeSlackIdentity, revokeEmployeeSlackIdentity } = await import("@/lib/data/slack-identities");
const { runApprovalResolveSideEffects } = await import("@/lib/approvals/resolve-side-effects");
const { handleSlackEventsRequest } = await import("@/lib/slack/mention-ingress");
const ob = await import("@/lib/webhooks/outbound");
const g = await import("@/lib/webhooks/link-local-guard");
type PinnedRequest = import("@/lib/mcp-events/transport").PinnedRequest;

const ORG = DEMO_ORG.id;
const ENV = ["WEBHOOK_HARDENING_ENABLED", "MCP_EVENTS_ENABLED", "MCP_ENDPOINT_HANDOFF_ENABLED", "NEXT_PUBLIC_APP_URL", "SLACK_SIGNING_SECRET"];
const saved: Record<string, string | undefined> = {};
type Answer = { address: string; family: number };
/** What the (guarded) connect-time DNS lookup answers. */
let names: Record<string, Answer[]> = {};
/** Receiver responses by URL (default 200); a 30x with location is followed. */
let responders: Record<string, () => Response> = {};
type Call = { url: string; init: RequestInit & { dispatcher?: unknown } };
let fetchCalls: Call[] = [];
let connected: string[] = [];
let delivered: string[] = [];
/** #270 flag-ON transport (pinned, injected). */
let hardenedDns: Array<{ address: string; family: 4 | 6 }> = [{ address: "93.184.216.34", family: 4 }];
const sent: PinnedRequest[] = [];
const originalFetch = globalThis.fetch;

function guardedConnectHop(url: URL): Promise<void> {
  // Like undici's connector → net.connect: IP literals connect directly (no
  // lookup), hostnames go through the connector's lookup (guardedLookup).
  const base = ((opts: { hostname: string }, cb: (e: Error | null, s?: unknown) => void) => {
    if (isIP(opts.hostname.replace(/^\[|\]$/g, ""))) return cb(null, {});
    g.guardedLookup(opts.hostname, {}, (err: NodeJS.ErrnoException | null) => (err ? cb(err) : cb(null, {})));
  }) as never;
  const connect = g.createGuardedConnect(base) as unknown as (o: object, cb: (e: Error | null) => void) => void;
  return new Promise((ok, fail) => connect({ hostname: url.hostname, port: url.port, protocol: url.protocol },
    (err) => (err ? fail(new TypeError("fetch failed", { cause: err })) : ok())));
}

beforeEach(() => {
  for (const k of ENV) saved[k] = process.env[k];
  for (const k of ENV) delete process.env[k];
  names = { "callback.example.com": [{ address: "93.184.216.34", family: 4 }], "wake.example.com": [{ address: "93.184.216.34", family: 4 }] };
  responders = {}; fetchCalls = []; connected = []; delivered = []; sent.length = 0;
  hardenedDns = [{ address: "93.184.216.34", family: 4 }];
  g.__setLinkLocalGuardResolverForTests((host, _o, cb) => {
    const a = names[host];
    if (!a) return cb(Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" }), []);
    cb(null, a);
  });
  globalThis.fetch = (async (input: unknown, init?: RequestInit & { dispatcher?: unknown }) => {
    fetchCalls.push({ url: String(input), init: init || {} });
    let url = new URL(String(input));
    for (let hop = 0; hop < 5; hop++) {
      if (init?.dispatcher === g.linkLocalGuardDispatcher()) await guardedConnectHop(url);
      connected.push(url.href);
      if (!/(callback|wake)\.example\.com|10\.0\.0\.5|redirector\.example\.com/.test(url.host)) return Response.json({ ok: true }); // unrelated fetches (Slack API etc.)
      const res = (responders[url.href] || (() => Response.json({ ok: true })))();
      const loc = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && loc) { url = new URL(loc, url); continue; }
      delivered.push(url.href);
      return res;
    }
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  ob.__setOutboundWebhookTransportForTests({
    lookup: async () => hardenedDns,
    request: async (r) => { sent.push(r); return { status: 200, body: Buffer.from("{}") }; },
  });
});
afterEach(async () => {
  globalThis.fetch = originalFetch;
  g.__setLinkLocalGuardResolverForTests(null);
  ob.__setOutboundWebhookTransportForTests(null);
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

// ---------- approval callback ----------
const employee = (callbackUrl: string) => ({ ...getRuntimeEmployees().find((e) => e.id === "emp_sales")!, callbackUrl });
async function callback(callbackUrl: string) {
  const { approval } = await createApproval({
    orgId: ORG, employeeId: "emp_sales", credentialId: "cred_t", title: "T", purpose: "mail.send",
    summary: "S", risk: "high", tool: "mail.send", jobId: "job_ll",
  });
  const resolved = (await resolveApproval(approval.id, "approved", "web:approver@example.com", ORG, {}))!;
  const r = await runApprovalResolveSideEffects({ approval: resolved, decision: "approved", actorEmail: "approver@example.com", employee: employee(callbackUrl), surface: "web" });
  return { r, approval: resolved };
}
const wakeAudit = (id: string) => getRuntimeAudit().find((e) => e.action === "agent.approval_wake" && e.metadata?.approvalId === id);

describe("approval callback, flag OFF (no flag for the guard)", () => {
  test("normal public host still delivered; fetch carries the guard dispatcher and nothing else changes", async () => {
    const { r } = await callback("https://callback.example.com/hook");
    expect(r.callback).toEqual({ ok: true, skipped: false });
    expect(fetchCalls).toHaveLength(1);
    const { init } = fetchCalls[0];
    expect(init.dispatcher).toBe(g.linkLocalGuardDispatcher());
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "content-type": "application/json", "user-agent": "Staffpass-ApprovalHook/1.0" });
    expect(init.redirect).toBeUndefined();
    expect(delivered).toEqual(["https://callback.example.com/hook"]);
  });
  test("hostname resolving to 169.254.169.254 → address_blocked, nothing delivered, no address in the result", async () => {
    names["callback.example.com"] = [{ address: "169.254.169.254", family: 4 }];
    const { r } = await callback("https://callback.example.com/hook");
    expect(r.callback).toEqual({ ok: false, skipped: false, error: "address_blocked" });
    expect(delivered).toEqual([]);
    expect(JSON.stringify(r)).not.toMatch(/169\.254|ERR_STAFFPASS/);
  });
  test("redirect to the metadata address (literal and hostname) → address_blocked; wake audit category only", async () => {
    process.env.MCP_ENDPOINT_HANDOFF_ENABLED = "true";
    process.env.NEXT_PUBLIC_APP_URL = "https://staffpass.example.test";
    names["metadata.attacker.test"] = [{ address: "169.254.169.254", family: 4 }];
    for (const to of ["http://169.254.169.254/latest/meta-data/iam/", "http://metadata.attacker.test/latest/", "http://[::ffff:a9fe:a9fe]/latest/"]) {
      responders["https://callback.example.com/hook"] = () => new Response(null, { status: 302, headers: { location: to } });
      delivered = [];
      const { r, approval } = await callback("https://callback.example.com/hook");
      expect([to, r.callback]).toEqual([to, { ok: false, skipped: false, error: "address_blocked" }]);
      expect(delivered).toEqual([]);
      expect(wakeAudit(approval.id)?.metadata).toMatchObject({ reason: "wake_failed", category: "address_blocked" });
      expect(JSON.stringify(wakeAudit(approval.id)?.metadata)).not.toMatch(/169\.254|a9fe|attacker/);
    }
  });
  test("IPv6 forms (resolved and literal) → address_blocked", async () => {
    for (const address of ["fd00:ec2::254", "fe80::1", "::ffff:169.254.169.254", "64:ff9b::a9fe:a9fe", "fd20:ce::254"]) {
      names["callback.example.com"] = [{ address, family: 6 }];
      const { r } = await callback("https://callback.example.com/hook");
      expect([address, r.callback]).toEqual([address, { ok: false, skipped: false, error: "address_blocked" }]);
    }
    for (const url of ["http://[fd00:ec2::254]/", "http://[::ffff:169.254.169.254]/", "http://169.254.170.2/v2/credentials", "http://100.100.100.200/latest/meta-data/"]) {
      const { r } = await callback(url);
      expect([url, r.callback]).toEqual([url, { ok: false, skipped: false, error: "address_blocked" }]);
    }
    expect(delivered).toEqual([]);
  });
  test("private 10.x, http, non-443 port, and redirects to allowed hosts still work with the flag OFF", async () => {
    names["redirector.example.com"] = [{ address: "10.0.0.7", family: 4 }];
    let { r } = await callback("http://10.0.0.5:8080/hook");
    expect(r.callback).toEqual({ ok: true, skipped: false });
    responders["http://redirector.example.com:8081/hook"] = () => new Response(null, { status: 307, headers: { location: "http://10.0.0.5:8080/final" } });
    ({ r } = await callback("http://redirector.example.com:8081/hook"));
    expect(r.callback).toEqual({ ok: true, skipped: false });
    expect(delivered).toEqual(["http://10.0.0.5:8080/hook", "http://10.0.0.5:8080/final"]);
  });
});

describe("approval callback, flag ON: #270 behaviour unchanged", () => {
  beforeEach(() => { process.env.WEBHOOK_HARDENING_ENABLED = "true"; });
  test("pinned transport only (never fetch / the guard dispatcher); metadata AND 10.x answers → address_blocked; http / :8080 → invalid_url", async () => {
    let { r } = await callback("https://callback.example.com/hook");
    expect(r.callback).toEqual({ ok: true, skipped: false });
    expect(sent).toHaveLength(1);
    expect(fetchCalls.filter((c) => c.url.includes("callback.example.com"))).toHaveLength(0);
    for (const answer of ["169.254.169.254", "10.0.0.5"]) {
      hardenedDns = [{ address: answer, family: 4 as const }];
      ({ r } = await callback("https://callback.example.com/hook"));
      expect([answer, r.callback]).toEqual([answer, { ok: false, skipped: false, error: "address_blocked" }]);
    }
    ({ r } = await callback("http://10.0.0.5:8080/hook"));
    expect(r.callback).toEqual({ ok: false, skipped: false, error: "invalid_url" });
    expect(sent).toHaveLength(1);
  });
});

// ---------- conversation wake webhook ----------
const SIGNING_SECRET = "slack-events-signing-secret-for-ll";
const BOUND_USER = "U_LLWAKE";
const TEAM = "T_DEMO";
async function withWake(url: string, fn: () => Promise<void>) {
  process.env.SLACK_SIGNING_SECRET = SIGNING_SECRET;
  const emp = getRuntimeEmployees().find((e) => e.id === "emp_comm")!;
  const previous = emp.allowedAccounts;
  emp.allowedAccounts = [{ service: "slack", accountId: BOUND_USER }];
  await revokeEmployeeSlackIdentity({ employeeId: emp.id, orgId: ORG });
  await bindEmployeeSlackIdentity({ employeeId: emp.id, orgId: ORG, slackUserId: BOUND_USER, slackTeamId: TEAM, displayName: "LL", userToken: "xoxp-test" });
  await updateWakeWebhook(emp.id, { orgId: ORG, url, secret: "wake-secret-ll" });
  try { await fn(); } finally {
    await revokeEmployeeSlackIdentity({ employeeId: emp.id, orgId: ORG });
    await updateWakeWebhook(emp.id, { orgId: ORG, url: null, secret: "" });
    emp.allowedAccounts = previous;
  }
}
async function mention() {
  const eventId = `Ev_ll_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const body = { type: "event_callback", team_id: TEAM, event_id: eventId,
    event: { type: "message", user: "U_HUMAN_LL", text: `<@${BOUND_USER}> お願い`, ts: "1787911800.300001", channel: "C_LL" } };
  const rawBody = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v0=${createHmac("sha256", SIGNING_SECRET).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;
  await handleSlackEventsRequest({ rawBody, timestamp, signature });
  return eventId;
}
const wakeEvents = (eventId: string) => getRuntimeAudit().filter((e) => e.action === "slack.mention_wake" && e.metadata?.eventId === eventId);
const wakeFetches = (host: string) => fetchCalls.filter((c) => c.url.includes(host));

describe("conversation wake webhook, flag OFF (no flag for the guard)", () => {
  test("normal public host still woken; fetch carries the guard dispatcher", async () => {
    await withWake("https://wake.example.com/hook", async () => {
      const id = await mention();
      expect(wakeFetches("wake.example.com")).toHaveLength(1);
      expect(wakeFetches("wake.example.com")[0].init.dispatcher).toBe(g.linkLocalGuardDispatcher());
      expect(delivered).toEqual(["https://wake.example.com/hook"]);
      expect(wakeEvents(id).some((e) => e.metadata?.reason === "wake_failed")).toBe(false);
    });
  });
  test("hostname resolving to 169.254.169.254 / IPv6 metadata forms → wake_failed address_blocked, nothing delivered", async () => {
    await withWake("https://wake.example.com/hook", async () => {
      for (const [address, family] of [["169.254.169.254", 4], ["fd00:ec2::254", 6], ["::ffff:169.254.169.254", 6], ["fe80::1", 6]] as const) {
        names["wake.example.com"] = [{ address, family }];
        const id = await mention();
        const fail = wakeEvents(id).find((e) => e.metadata?.reason === "wake_failed");
        expect([address, fail?.metadata?.category]).toEqual([address, "address_blocked"]);
        expect(JSON.stringify(fail?.metadata)).not.toMatch(/169\.254|ec2|ffff|fe80|ERR_STAFFPASS/);
      }
      expect(delivered).toEqual([]);
    });
  });
  test("redirect to the metadata address → address_blocked", async () => {
    await withWake("https://wake.example.com/hook", async () => {
      responders["https://wake.example.com/hook"] = () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } });
      const id = await mention();
      expect(wakeEvents(id).find((e) => e.metadata?.reason === "wake_failed")?.metadata).toMatchObject({ category: "address_blocked" });
      expect(delivered).toEqual([]);
    });
  });
  test("private 10.x over http on a non-443 port is still allowed with the flag OFF", async () => {
    await withWake("http://10.0.0.5:8080/wake", async () => {
      const id = await mention();
      expect(delivered).toEqual(["http://10.0.0.5:8080/wake"]);
      expect(wakeEvents(id).some((e) => e.metadata?.reason === "wake_failed")).toBe(false);
    });
  });
});

describe("conversation wake webhook, flag ON: #270 behaviour unchanged", () => {
  beforeEach(() => { process.env.WEBHOOK_HARDENING_ENABLED = "true"; });
  test("pinned transport only; metadata answer and 10.x answer → address_blocked", async () => {
    await withWake("https://wake.example.com/hook", async () => {
      await mention();
      expect(sent).toHaveLength(1);
      expect(wakeFetches("wake.example.com")).toHaveLength(0);
      for (const answer of ["169.254.169.254", "10.0.0.5"]) {
        hardenedDns = [{ address: answer, family: 4 as const }];
        const id = await mention();
        expect([answer, wakeEvents(id).find((e) => e.metadata?.reason === "wake_failed")?.metadata?.category]).toEqual([answer, "address_blocked"]);
      }
      expect(sent).toHaveLength(1);
    });
  });
});

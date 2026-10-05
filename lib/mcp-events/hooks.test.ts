/**
 * One shared emit point, no per-channel code: the decision side effects
 * (lib/approvals/resolve-side-effects.ts — called by Web, Slack, LINE, Telegram
 * and proxy approve) emit approval.decided; closing an approval as expired
 * (lib/comm-reply-dedup/approvals.ts auditApprovalClosed) emits
 * approval.expired. Double wakes: an approval already closed as expired at
 * fulfil time emits no approval.decided; the legacy callback carries the same
 * eventId (flag ON only) so a receiver can dedupe. Demo mode, no network.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";

process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY = "test-notification-key-0123456789abcdef-mcpevents";
process.env.MCP_EVENTS_ENABLED = "true";

const { DEMO_ORG } = await import("@/lib/demo-data");
const { getBinding, getEmployeeById } = await import("@/lib/data");
const { createApproval, resolveApproval, closeApprovalWithoutSend } = await import("@/lib/data/approvals");
const { runApprovalResolveSideEffects } = await import("@/lib/approvals/resolve-side-effects");
const { auditApprovalClosed } = await import("@/lib/comm-reply-dedup/approvals");
const svc = await import("@/lib/mcp-events/service");
const store = await import("@/lib/mcp-events/store");
type PinnedRequest = import("@/lib/mcp-events/transport").PinnedRequest;

const ORG = DEMO_ORG.id;
const posts: PinnedRequest[] = [];
const callbacks: Array<Record<string, unknown>> = [];
const originalFetch = globalThis.fetch;

beforeEach(async () => {
  store.__resetMcpEventsStoreForTests();
  posts.length = 0; callbacks.length = 0;
  svc.__setMcpEventsTransportForTests({
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    request: async (req) => {
      posts.push(req);
      const body = JSON.parse(req.body.toString()) as Record<string, unknown>;
      return body.type === "verification"
        ? { status: 200, body: Buffer.from(JSON.stringify({ challenge: body.challenge })) }
        : { status: 200, body: Buffer.alloc(0) };
    },
  });
  globalThis.fetch = (async (input: unknown, init?: { body?: string }) => {
    if (String(input).startsWith("https://callback.example.com/")) callbacks.push(JSON.parse(String(init?.body)));
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const b = (await getBinding("emp_sales"))!;
  const cred = { employeeId: "emp_sales", orgId: ORG, generation: b.credentialGeneration, credentialId: null, fingerprint: b.credentialFingerprint!, binding: b, secretPrefix: "gb_emp_" };
  for (const name of ["approval.decided", "approval.expired"]) {
    const r = await svc.handleEventsSubscribe(cred, { name, arguments: {}, delivery: { mode: "webhook", url: `https://hooks.example.com/${name}`, secret: `whsec_${randomBytes(32).toString("base64")}` } });
    if (!r.ok) throw new Error(JSON.stringify(r));
  }
  posts.length = 0;
});
afterEach(() => { svc.__setMcpEventsTransportForTests(null); globalThis.fetch = originalFetch; });
afterAll(() => { delete process.env.MCP_EVENTS_ENABLED; });

async function approved() {
  const { approval } = await createApproval({ orgId: ORG, employeeId: "emp_sales", credentialId: "cred_t", title: "T", purpose: "mail.send", summary: "S", risk: "medium", tool: "mail.send", jobId: "job_h" });
  return (await resolveApproval(approval.id, "approved", "slack:U1", ORG))!;
}
const events = () => posts.filter((p) => !String(p.headers["webhook-id"]).startsWith("msg_verification_")).map((p) => JSON.parse(p.body.toString()));

describe("approval.decided from the shared decision side effects", () => {
  for (const surface of ["slack", "line", "telegram", "web"] as const) test(`decided on ${surface} → same event shape`, async () => {
    const approval = await approved();
    await runApprovalResolveSideEffects({ approval, decision: "approved", actorEmail: `${surface}:actor`, employee: null, surface });
    await svc.__flushMcpEventsBackgroundForTests();
    const got = events();
    expect(got).toHaveLength(1);
    expect(got[0].name).toBe("approval.decided");
    expect(Object.keys(got[0].data).sort()).toEqual(["approvalId", "decidedAt", "employeeId", "fulfillment", "jobId", "risk", "status", "tool"]);
    expect(JSON.stringify(got[0])).not.toContain(surface + ":actor");
  });

  test("approval already closed as expired at fulfil → no approval.decided (expired event only)", async () => {
    const approval = await approved();
    const closed = await closeApprovalWithoutSend({ approval, from: ["approved"], to: "expired", meta: { reason: "test" } });
    expect(closed).toBeTruthy();
    await auditApprovalClosed({ ...approval, status: "expired" }, "approval.expired", { reason: "approval_ttl_elapsed" });
    await runApprovalResolveSideEffects({ approval, decision: "approved", actorEmail: "web:a@example.com", employee: null, surface: "web" });
    await svc.__flushMcpEventsBackgroundForTests();
    expect(events().map((e) => e.name)).toEqual(["approval.expired"]);
  });

  test("legacy callbackUrl carries the same eventId (flag ON) for receiver-side dedupe", async () => {
    const approval = await approved();
    const employee = { ...(await getEmployeeById("emp_sales"))!, callbackUrl: "https://callback.example.com/hook" };
    await runApprovalResolveSideEffects({ approval, decision: "approved", actorEmail: "web:a@example.com", employee, surface: "web" });
    await svc.__flushMcpEventsBackgroundForTests();
    expect(callbacks).toHaveLength(1);
    expect(callbacks[0].eventId).toBe(events()[0].eventId);
    process.env.MCP_EVENTS_ENABLED = "false";
    try {
      callbacks.length = 0;
      const second = await approved();
      await runApprovalResolveSideEffects({ approval: second, decision: "approved", actorEmail: "web:a@example.com", employee, surface: "web" });
      expect(callbacks).toHaveLength(1);
      expect("eventId" in callbacks[0]).toBe(false);
    } finally { process.env.MCP_EVENTS_ENABLED = "true"; }
  });
});

describe("approval.expired from the shared close point", () => {
  test("expired → approval.expired with the close reason; superseded → nothing", async () => {
    const { approval } = await createApproval({ orgId: ORG, employeeId: "emp_sales", credentialId: "cred_t", title: "T", purpose: "comm.reply", summary: "S", risk: "low", tool: "comm.reply", jobId: "job_e" });
    await auditApprovalClosed({ ...approval, status: "superseded" }, "approval.superseded", { reason: "newer_reply_sent" });
    await svc.__flushMcpEventsBackgroundForTests();
    expect(events()).toHaveLength(0);
    await auditApprovalClosed({ ...approval, status: "expired" }, "approval.expired", { reason: "approval_ttl_elapsed" });
    await svc.__flushMcpEventsBackgroundForTests();
    const got = events();
    expect(got).toHaveLength(1);
    expect(got[0].data).toMatchObject({ approvalId: approval.id, status: "expired", reason: "ttl_elapsed" });
  });
});

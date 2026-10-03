/**
 * Customer Portal: only org owner / admin may open it; org is resolved
 * server-side from the session (never from client input).
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";

let session: Record<string, unknown> = {};
let demo = false;
const lookups: string[] = [];
const portalCalls: Array<Record<string, unknown>> = [];

mock.module("@/lib/auth/session", () => ({
  getSessionContext: async () => session,
}));
mock.module("@/lib/mode", () => ({
  isDemoMode: () => demo,
  isStripeConfigured: () => true,
}));
mock.module("@/lib/data/subscriptions", () => ({
  getOrgStripeCustomerId: async (orgId: string) => {
    lookups.push(orgId);
    return orgId === ORG ? "cus_org" : "cus_other";
  },
}));
let stripeOn = true;
mock.module("@/lib/stripe", () => ({
  getStripe: () =>
    stripeOn
      ? {
          billingPortal: {
            sessions: {
              create: async (args: Record<string, unknown>) => {
                portalCalls.push(args);
                return { url: "https://billing.stripe.test/p/1" };
              },
            },
          },
        }
      : null,
  getAppUrl: () => "https://staffpass.example",
}));

const routeModule = await import("./route");
// The handler intentionally ignores the request (no client-supplied org/plan
// input is read); call it with a request anyway to prove that.
const POST = routeModule.POST as unknown as (req: Request) => Promise<Response>;

function req(body?: unknown) {
  return new Request("https://staffpass.example/api/billing/portal", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function member(role: string) {
  return {
    demo: false,
    userId: "user-1",
    email: "u@customer.test",
    orgId: ORG,
    member: { id: "m1", orgId: ORG, role, status: "active" },
  };
}

beforeEach(() => {
  demo = false;
  stripeOn = true;
  lookups.length = 0;
  portalCalls.length = 0;
});

describe("POST /api/billing/portal role gate", () => {
  for (const role of ["owner", "admin"]) {
    test(`${role} → 200 with portal url for the session org's customer`, async () => {
      session = member(role);
      const res = await POST(req());
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.url).toBe("https://billing.stripe.test/p/1");
      expect(portalCalls[0]?.customer).toBe("cus_org");
    });
  }

  test("member → 403, no Stripe portal session, no customer lookup", async () => {
    session = member("member");
    const res = await POST(req());
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("admin_required");
    expect(portalCalls.length).toBe(0);
    expect(lookups.length).toBe(0);
  });

  test("unknown / missing role → 403", async () => {
    session = { ...member("member"), member: { id: "m1", orgId: ORG } };
    expect((await POST(req())).status).toBe(403);
    expect(portalCalls.length).toBe(0);
  });

  test("logged in but no active membership → 401/403, no portal", async () => {
    session = { demo: false, userId: "user-1", email: "x@y", orgId: null, member: null };
    const res = await POST(req());
    expect([401, 403]).toContain(res.status);
    expect(portalCalls.length).toBe(0);
  });

  test("member row from a different org than session org → 403", async () => {
    session = {
      ...member("owner"),
      member: { id: "m1", orgId: OTHER_ORG, role: "owner", status: "active" },
    };
    expect((await POST(req())).status).toBe(403);
    expect(portalCalls.length).toBe(0);
  });

  test("client-supplied orgId / customer in body are ignored", async () => {
    session = member("owner");
    const res = await POST(req({ orgId: OTHER_ORG, org_id: OTHER_ORG, customer: "cus_other" }));
    expect(res.status).toBe(200);
    expect(lookups).toEqual([ORG]);
    expect(portalCalls[0]?.customer).toBe("cus_org");
  });

  test("member is rejected even when Stripe is not configured (stub path)", async () => {
    stripeOn = false;
    session = member("member");
    expect((await POST(req())).status).toBe(403);
  });

  test("DEMO keeps the stub/preview behavior", async () => {
    demo = true;
    stripeOn = false;
    session = { demo: true, userId: null, email: "owner@example.com", orgId: "org_demo", member: null };
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect((await res.json()).stub).toBe(true);
  });
});

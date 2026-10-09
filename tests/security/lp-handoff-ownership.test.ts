/**
 * LP handoff ownership binding.
 *
 * Handoff endpoints must act only on the caller's own journey (resolved from
 * the signed guest cookie), never on a journeyId / handoffId alone.
 */
import { describe, expect, test, beforeEach, mock } from "bun:test";
// IP_HASH_KEY is required (no dev fallback); fixture key for this test process.
process.env.IP_HASH_KEY = "test-ip-hash-key-fixture-0123456789";

const OWN_JOURNEY = { id: "journey-own", tenantId: "t", tokenHash: "h", activeAgent: "ai" };
let cookieJar: Record<string, string> = {};
const handoffs: Record<string, { id: string; journeyId: string; status: string; reason: string; summaryDraft: string; createdAt: string }> = {
  "h-own": { id: "h-own", journeyId: "journey-own", status: "pending_confirmation", reason: "r", summaryDraft: "s", createdAt: "x" },
  "h-other": { id: "h-other", journeyId: "journey-other", status: "pending_confirmation", reason: "r", summaryDraft: "s", createdAt: "x" },
};
const calls: string[] = [];

mock.module("next/headers", () => ({
  cookies: async () => ({ get: (n: string) => (cookieJar[n] ? { value: cookieJar[n] } : undefined) }),
}));
mock.module("@/lib/lp/journeys", () => ({
  parseGuestCookie: (v: string) => (v.includes(".") ? { token: v.split(".")[0], signature: v.split(".")[1] } : null),
  verifySignature: (_t: string, sig: string) => sig === "good",
  hashToken: (t: string) => `hash:${t}`,
  getJourneyByTokenHash: async (h: string) => (h === "hash:tok" ? OWN_JOURNEY : null),
}));
mock.module("@/lib/lp/handoffs", () => ({
  getHandoff: async (id: string) => handoffs[id] ?? null,
  createHandoff: async (input: { journeyId: string }) => { calls.push(`create:${input.journeyId}`); return { id: "new", status: "pending_confirmation" }; },
  confirmHandoff: async (input: { handoffId: string }) => { calls.push(`confirm:${input.handoffId}`); return { id: input.handoffId, status: "confirmed", confirmedAt: "x" }; },
  cancelHandoff: async (id: string) => { calls.push(`cancel:${id}`); return true; },
}));
mock.module("@/lib/lp/outbox-processor", () => ({ enqueueHandoffNotification: async () => {} }));

process.env.LP_HANDOFF_ENABLED = "true";
const route = await import("@/app/api/lp/handoff/route");

function req(method: string, url: string, body?: unknown, csrf = "c1") {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json", "x-csrf-token": csrf },
    body: body ? JSON.stringify(body) : undefined,
  }) as never;
}

beforeEach(() => {
  cookieJar = { lp_guest: "tok.good", lp_csrf: "c1" };
  calls.length = 0;
});

describe("LP handoff ownership", () => {
  test("POST without guest cookie is rejected", async () => {
    cookieJar = {};
    const res = await route.POST(req("POST", "http://x/api/lp/handoff", { reason: "r", summaryDraft: "s" }));
    expect(res.status).toBe(401);
    expect(calls).toEqual([]);
  });

  test("POST with bad signature is rejected", async () => {
    cookieJar = { lp_guest: "tok.bad", lp_csrf: "c1" };
    const res = await route.POST(req("POST", "http://x/api/lp/handoff", { reason: "r", summaryDraft: "s" }));
    expect(res.status).toBe(401);
  });

  test("POST without matching CSRF token is rejected", async () => {
    const res = await route.POST(req("POST", "http://x/api/lp/handoff", { reason: "r", summaryDraft: "s" }, "wrong"));
    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });

  test("POST ignores a journeyId in the body and uses the cookie's journey", async () => {
    const res = await route.POST(req("POST", "http://x/api/lp/handoff", { journeyId: "journey-other", reason: "r", summaryDraft: "s" }));
    expect(res.status).toBe(200);
    expect(calls).toEqual(["create:journey-own"]);
  });

  test("GET of another guest's handoff returns 404", async () => {
    const res = await route.GET(req("GET", "http://x/api/lp/handoff?id=h-other"));
    expect(res.status).toBe(404);
  });

  test("GET of own handoff succeeds", async () => {
    const res = await route.GET(req("GET", "http://x/api/lp/handoff?id=h-own"));
    expect(res.status).toBe(200);
  });

  test("PUT on another guest's handoff returns 404 and does not confirm", async () => {
    const res = await route.PUT(req("PUT", "http://x/api/lp/handoff", { handoffId: "h-other", summaryFinal: "s" }));
    expect(res.status).toBe(404);
    expect(calls).toEqual([]);
  });

  test("DELETE on another guest's handoff returns 404 and does not cancel", async () => {
    const res = await route.DELETE(req("DELETE", "http://x/api/lp/handoff?id=h-other"));
    expect(res.status).toBe(404);
    expect(calls).toEqual([]);
  });

  test("DELETE on own handoff cancels it", async () => {
    const res = await route.DELETE(req("DELETE", "http://x/api/lp/handoff?id=h-own"));
    expect(res.status).toBe(200);
    expect(calls).toEqual(["cancel:h-own"]);
  });
});

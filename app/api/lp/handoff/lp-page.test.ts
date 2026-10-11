import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

/** AI 相談 handoff: confirm link returns B visitors to B; the handoff email records the page. */
let journeyLpPage: string | null = null;
const notified: Array<{ lpPage: unknown }> = [];
const HANDOFF = { id: "h1", journeyId: "journey_1", status: "pending_confirmation", reason: "r", summaryDraft: "s" };

mock.module("@/lib/lp/guest-session", () => ({
  resolveGuestJourney: async () => ({ ok: true, journey: { id: "journey_1", lpPage: journeyLpPage } }),
}));
mock.module("@/lib/lp/handoffs", () => ({
  createHandoff: async () => HANDOFF,
  getHandoff: async () => HANDOFF,
  confirmHandoff: async () => ({ ...HANDOFF, status: "confirmed", confirmedAt: "2026-10-12T00:00:00Z" }),
  cancelHandoff: async () => true,
}));
mock.module("@/lib/lp/outbox-processor", () => ({
  enqueueHandoffNotification: async (_h: unknown, lpPage?: unknown) => {
    notified.push({ lpPage });
    return "ob1";
  },
}));

const ENV = ["LP_HANDOFF_ENABLED", "IP_HASH_KEY"];
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
afterAll(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
beforeEach(() => {
  journeyLpPage = null;
  notified.length = 0;
  process.env.LP_HANDOFF_ENABLED = "true";
  process.env.IP_HASH_KEY = "k".repeat(40);
});

const route = await import("./route");
const { NextRequest } = await import("next/server");
const req = (method: string, body: Record<string, unknown>) =>
  new NextRequest("https://staffpass.example/api/lp/handoff", { method, headers: { "content-type": "application/json", "x-csrf-token": "c" }, body: JSON.stringify(body) });

describe("handoff lpPage", () => {
  test("POST confirmUrl: B gets from=ai-employee-corp, original / tampered unchanged", async () => {
    const url = async (lpPage?: unknown) => ((await (await route.POST(req("POST", { reason: "r", summaryDraft: "s", lpPage }))).json()) as { confirmUrl: string }).confirmUrl;
    expect(await url("ai-employee-corp")).toBe("/lp/ai-employee/handoff/confirm?id=h1&from=ai-employee-corp");
    expect(await url()).toBe("/lp/ai-employee/handoff/confirm?id=h1");
    expect(await url("//evil.example")).toBe("/lp/ai-employee/handoff/confirm?id=h1");
    journeyLpPage = "ai-employee-corp";
    expect(await url("ai-employee")).toBe("/lp/ai-employee/handoff/confirm?id=h1&from=ai-employee-corp");
  });
  test("PUT: notification gets the allowlisted page (journey first, then body, tampered → default)", async () => {
    const put = (lpPage?: unknown) => route.PUT(req("PUT", { handoffId: "h1", summaryFinal: "s", lpPage }));
    await put("ai-employee-corp");
    await put("<b>x</b>");
    journeyLpPage = "ai-employee-corp";
    await put("ai-employee");
    expect(notified.map((n) => n.lpPage)).toEqual(["ai-employee-corp", "ai-employee", "ai-employee-corp"]);
  });
});

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

/**
 * /api/journeys stores the allowlisted lpPage on the journey (AI 相談 log);
 * /api/chat/turn answers with the B prompt: journey.lpPage wins over the body.
 */
let journeyLpPage: string | null = null;
const created: Array<Record<string, unknown>> = [];
const systems: string[] = [];

mock.module("next/headers", () => ({
  cookies: async () => ({
    get: (n: string) => ({ lp_guest: { value: "tok.good" }, lp_csrf: { value: "c1" } } as Record<string, { value: string }>)[n],
    set: () => undefined,
  }),
}));
mock.module("@/lib/lp/journeys", () => ({
  parseGuestCookie: (v: string) => ({ token: v.split(".")[0], signature: v.split(".")[1] }),
  verifySignature: (_t: string, s: string) => s === "good",
  hashToken: (t: string) => `hash:${t}`,
  getJourneyByTokenHash: async () => ({ id: "j1", tenantId: "t", tokenHash: "hash:tok", activeAgent: "sales", kbReleaseId: null, lpPage: journeyLpPage }),
  incrementTurnCount: async () => 1,
  recordChatTurn: async () => true,
  createJourney: async (input: Record<string, unknown>) => {
    created.push(input);
    return { id: "j1", expiresAt: "2026-10-13T00:00:00Z", kbReleaseId: null };
  },
  generateGuestToken: () => ({ token: "tok", tokenHash: "hash:tok" }),
  generateCsrfToken: () => "c1",
  formatGuestCookieValue: (t: string) => `${t}.good`,
}));
mock.module("@/lib/lp/knowledge-base", () => ({
  getPublishedRelease: async () => null,
  searchKnowledgeBase: async () => ({ status: "not_found", passages: [] }),
}));

const realFetch = globalThis.fetch;
globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
  systems.push((JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> }).messages[0].content);
  return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "先行100枠があります。日報から始められます。" }, finish_reason: "stop" }], usage: {} }), { status: 200 });
}) as typeof fetch;

const ENV = ["LP_CHAT_ENABLED", "OPENAI_API_KEY", "IP_HASH_KEY", "LP_CHAT_TOOLS_ENABLED", "LP_HANDOFF_ENABLED", "LP_INQUIRY_BOT_PROTECTION_ENABLED"];
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
afterAll(() => {
  globalThis.fetch = realFetch;
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
beforeEach(() => {
  journeyLpPage = null;
  created.length = 0;
  systems.length = 0;
  process.env.LP_CHAT_ENABLED = "true";
  process.env.OPENAI_API_KEY = "sk-test-not-real";
  delete process.env.LP_CHAT_TOOLS_ENABLED;
  delete process.env.LP_HANDOFF_ENABLED;
  delete process.env.LP_INQUIRY_BOT_PROTECTION_ENABLED;
});

const journeys = await import("@/app/api/journeys/route");
const turn = await import("./route");
const { buildSystemPrompt } = await import("@/lib/lp/chat-prompt");
const CAPS = { toolsEnabled: false, handoffEnabled: false };

const start = (body: Record<string, unknown>) =>
  journeys.POST(new Request("https://staffpass.example/api/journeys", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ aiDisclosureAccepted: true, privacyVersion: "2026-10", ...body }) }));
const say = (body: Record<string, unknown>) =>
  turn.POST(new Request("https://staffpass.example/api/chat/turn", { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": "c1" }, body: JSON.stringify({ text: "料金は？", clientTurnId: "t1", ...body }) }));

describe("POST /api/journeys lpPage", () => {
  test("B recorded; missing / tampered → ai-employee", async () => {
    for (const [lpPage, want] of [["ai-employee-corp", "ai-employee-corp"], [undefined, "ai-employee"], ["https://evil.example", "ai-employee"], ["AI-EMPLOYEE-CORP", "ai-employee"], [["ai-employee-corp"], "ai-employee"]] as const) {
      created.length = 0;
      const res = await start({ lpPage });
      expect(res.status).toBe(201);
      expect(created[0].lpPage).toBe(want);
    }
  });
});

describe("POST /api/chat/turn lpPage", () => {
  test("journey says B → B prompt and no 先行100枠 in the reply (even if the body claims A)", async () => {
    journeyLpPage = "ai-employee-corp";
    const res = await say({ lpPage: "ai-employee" });
    const data = (await res.json()) as { reply: string };
    expect(systems[0]).toBe(buildSystemPrompt(CAPS, "ai-employee-corp"));
    expect(data.reply).not.toContain("先行100枠");
  });
  test("no journey value (DB flag OFF) → allowlisted body value", async () => {
    await say({ lpPage: "ai-employee-corp" });
    expect(systems[0]).toBe(buildSystemPrompt(CAPS, "ai-employee-corp"));
  });
  test("tampered body → original prompt; reply untouched on page A", async () => {
    const res = await say({ lpPage: "<script>" });
    expect(systems[0]).toBe(buildSystemPrompt(CAPS));
    expect(((await res.json()) as { reply: string }).reply).toContain("先行100枠");
  });
});

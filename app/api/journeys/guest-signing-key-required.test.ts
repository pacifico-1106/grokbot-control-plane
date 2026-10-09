/**
 * Routes fail closed (503 guest_sessions_unavailable, clear message, no crash) when GUEST_SIGNING_KEY
 * is missing. POST /api/journeys refuses BEFORE creating a journey row. Harness copied from
 * guest-session-roundtrip.test.ts.
 */
import { describe, expect, test, beforeEach, afterAll, mock } from "bun:test";
import {
  RequestCookies,
  ResponseCookies,
  parseSetCookie,
} from "next/dist/compiled/@edge-runtime/cookies";

// ---- browser cookie jar + next/headers mock ------------------------------------------------
let browserJar: Record<string, string> = {}; // name -> raw (still URL-encoded) value
let responseHeaders = new Headers();
let responseCookies = new ResponseCookies(responseHeaders);

function cookieHeader(): string {
  return Object.entries(browserJar).map(([n, v]) => `${n}=${v}`).join("; ");
}

mock.module("next/headers", () => ({
  cookies: async () => {
    const reqCookies = new RequestCookies(new Headers({ cookie: cookieHeader() }));
    return {
      get: (name: string) => reqCookies.get(name),
      set: (...args: Parameters<ResponseCookies["set"]>) => responseCookies.set(...args),
    };
  },
}));

/** Apply Set-Cookie headers like a browser: store the raw name=value pair. */
function storeSetCookies() {
  for (const raw of responseHeaders.getSetCookie()) {
    const parsed = parseSetCookie(raw);
    if (!parsed) continue;
    const rawValue = raw.slice(raw.indexOf("=") + 1).split(";")[0];
    browserJar[parsed.name] = rawValue;
  }
  responseHeaders = new Headers();
  responseCookies = new ResponseCookies(responseHeaders);
}

// ---- in-memory Supabase fake -----------------------------------------------------------------
type Row = Record<string, unknown>;
const tables: Record<string, Row[]> = {};

function query(table: string) {
  const rows = (tables[table] ??= []);
  let op: "select" | "insert" | "update" = "select";
  let payload: Row | null = null;
  const filters: Array<(r: Row) => boolean> = [];
  const run = () => {
    if (op === "insert") {
      const row = { id: crypto.randomUUID(), ...payload };
      rows.push(row);
      return [row];
    }
    const matched = rows.filter((r) => filters.every((f) => f(r)));
    if (op === "update") matched.forEach((r) => Object.assign(r, payload));
    return matched;
  };
  const b = {
    insert(p: Row) { op = "insert"; payload = p; return b; },
    update(p: Row) { op = "update"; payload = p; return b; },
    select() { return b; },
    eq(col: string, v: unknown) { filters.push((r) => r[col] === v); return b; },
    gt(col: string, v: string) { filters.push((r) => String(r[col]) > v); return b; },
    async single() { const d = run(); return d.length === 1 ? { data: d[0], error: null } : { data: null, error: { code: "PGRST116" } }; },
    async maybeSingle() { const d = run(); return { data: d[0] ?? null, error: null }; },
    then(res: (v: { data: Row[]; error: null }) => unknown, rej?: (e: unknown) => unknown) {
      try { return Promise.resolve(res({ data: run(), error: null })); } catch (e) { return rej ? rej(e) : Promise.reject(e); }
    },
  };
  return b;
}

const fakeAdmin = {
  from: (t: string) => query(t),
  rpc: async () => ({ data: [], error: null }),
};
mock.module("@/lib/supabase", () => ({
  createSupabaseAdminClient: () => fakeAdmin,
  createSupabaseServerClient: () => null,
}));

// ---- env + routes ----------------------------------------------------------------------------
const envKeys = ["LP_CHAT_ENABLED", "OPENAI_API_KEY", "GUEST_SIGNING_KEY", "LP_INQUIRY_BOT_PROTECTION_ENABLED", "LP_HANDOFF_ENABLED"] as const;
const envBackup = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
process.env.LP_CHAT_ENABLED = "1";
process.env.OPENAI_API_KEY = "sk-test-not-real";
process.env.GUEST_SIGNING_KEY = "test-signing-key-0123456789abcdef";
delete process.env.LP_INQUIRY_BOT_PROTECTION_ENABLED;
process.env.LP_HANDOFF_ENABLED = "1";
const KEY = "test-signing-key-0123456789abcdef";

const journeysRoute = await import("@/app/api/journeys/route");
const turnRoute = await import("@/app/api/chat/turn/route");

const realFetch = globalThis.fetch;
const openAiCalls: string[] = [];
globalThis.fetch = (async (url: string | URL | Request) => {
  openAiCalls.push(String(url));
  if (!String(url).startsWith("https://api.openai.com/")) throw new Error("unexpected_network");
  return new Response(
    JSON.stringify({
      choices: [{ message: { role: "assistant", content: "AI相談窓口です。どの業務を任せたいですか。" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}) as typeof fetch;

afterAll(() => {
  globalThis.fetch = realFetch;
  for (const k of envKeys) {
    if (envBackup[k] === undefined) delete process.env[k];
    else process.env[k] = envBackup[k];
  }
});

const handoffRoute = await import("@/app/api/lp/handoff/route");
const { resolveGuestJourney } = await import("@/lib/lp/guest-session");
const { createHmac } = await import("node:crypto");

beforeEach(() => {
  browserJar = {};
  responseHeaders = new Headers();
  responseCookies = new ResponseCookies(responseHeaders);
  for (const k of Object.keys(tables)) delete tables[k];
  openAiCalls.length = 0;
  process.env.GUEST_SIGNING_KEY = KEY;
});

function journeyReq() {
  return new Request("https://staffpass.example/api/journeys", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ aiDisclosureAccepted: true, privacyVersion: "2026-09" }),
  });
}

async function startJourney(): Promise<string> {
  const res = await journeysRoute.POST(journeyReq());
  expect(res.status).toBe(201);
  const data = (await res.json()) as { csrfToken: string };
  storeSetCookies();
  return data.csrfToken;
}

function sendTurn(csrf: string) {
  return turnRoute.POST(
    new Request("https://staffpass.example/api/chat/turn", {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": csrf },
      body: JSON.stringify({ text: "請求書の処理を任せたい", clientTurnId: crypto.randomUUID() }),
    })
  );
}

function handoffPost(csrf: string) {
  return handoffRoute.POST(
    new Request("https://staffpass.example/api/lp/handoff", {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": csrf },
      body: JSON.stringify({ reason: "相談したい", summaryDraft: "x" }),
    }) as never
  );
}

const rowCount = () => Object.values(tables).reduce((n, r) => n + r.length, 0);

describe("GUEST_SIGNING_KEY missing: guest routes fail closed, gracefully", () => {
  for (const missing of [undefined, "", "replace_me"] as const) {
    test(`POST /api/journeys -> 503 before any journey row (key=${JSON.stringify(missing)})`, async () => {
      if (missing === undefined) delete process.env.GUEST_SIGNING_KEY;
      else process.env.GUEST_SIGNING_KEY = missing;
      const res = await journeysRoute.POST(journeyReq());
      expect(res.status).toBe(503);
      const body = (await res.json()) as { ok: boolean; error: string; message: string };
      expect(body.ok).toBe(false);
      expect(body.error).toBe("guest_sessions_unavailable");
      expect(body.message.length).toBeGreaterThan(0);
      expect(rowCount()).toBe(0);
      expect(responseHeaders.getSetCookie().length).toBe(0);
    });
  }

  test("POST /api/chat/turn -> 503 (not 500, not invalid_session) once the key goes away", async () => {
    const csrf = await startJourney();
    delete process.env.GUEST_SIGNING_KEY;
    const res = await sendTurn(csrf);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("guest_sessions_unavailable");
    expect(body.message.length).toBeGreaterThan(0);
    expect(openAiCalls.length).toBe(0);
  });

  test("cookie forged with the removed dev key is never accepted (missing key -> 503, set key -> 401)", async () => {
    const token = `guest_${"a".repeat(64)}`;
    const forged = createHmac("sha256", "dev-fallback-key-not-for-production").update(token).digest("hex");
    browserJar.lp_guest = `${token}.${forged}`;
    browserJar.lp_csrf = "c";
    delete process.env.GUEST_SIGNING_KEY;
    expect((await sendTurn("c")).status).toBe(503);
    process.env.GUEST_SIGNING_KEY = KEY;
    const res = await sendTurn("c");
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_session");
    expect(openAiCalls.length).toBe(0);
  });

  test("resolveGuestJourney -> 503 guest_sessions_unavailable", async () => {
    const csrf = await startJourney();
    delete process.env.GUEST_SIGNING_KEY;
    const req = new Request("https://staffpass.example/x", { headers: { "x-csrf-token": csrf } });
    const r = await resolveGuestJourney(req, { requireCsrf: true });
    expect(r).toMatchObject({ ok: false, status: 503, error: "guest_sessions_unavailable" });
  });

  test("POST /api/lp/handoff -> 503 with a message, no crash", async () => {
    const csrf = await startJourney();
    const before = rowCount();
    delete process.env.GUEST_SIGNING_KEY;
    const res = await handoffPost(csrf);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; message?: string };
    expect(body.error).toBe("guest_sessions_unavailable");
    expect(typeof body.message).toBe("string");
    expect(rowCount()).toBe(before);
  });

  test("key configured: journey + first turn still work", async () => {
    const csrf = await startJourney();
    const res = await sendTurn(csrf);
    expect(res.status).toBe(200);
  });
});

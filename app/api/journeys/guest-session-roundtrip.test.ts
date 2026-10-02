/**
 * LP guest session round trip: POST /api/journeys -> browser cookie jar -> POST /api/chat/turn.
 *
 * Regression for prod 2026-10-02: every chat message returned 「無効なセッションです」 because
 * /api/journeys passed the full Set-Cookie string (formatGuestCookie) to cookies().set() as the
 * *value*, so the lp_guest cookie the browser sent back never parsed into a valid token.signature.
 *
 * Cookies are serialized/parsed with Next's own @edge-runtime/cookies implementation so the test
 * sees exactly what the browser stores and what the route reads back.
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
const envKeys = ["LP_CHAT_ENABLED", "OPENAI_API_KEY", "GUEST_SIGNING_KEY", "LP_INQUIRY_BOT_PROTECTION_ENABLED"] as const;
const envBackup = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
process.env.LP_CHAT_ENABLED = "1";
process.env.OPENAI_API_KEY = "sk-test-not-real";
process.env.GUEST_SIGNING_KEY = "test-signing-key-0123456789abcdef";
delete process.env.LP_INQUIRY_BOT_PROTECTION_ENABLED;

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

beforeEach(() => {
  browserJar = {};
  responseHeaders = new Headers();
  responseCookies = new ResponseCookies(responseHeaders);
  for (const k of Object.keys(tables)) delete tables[k];
  openAiCalls.length = 0;
});

async function startJourney(): Promise<string> {
  const res = await journeysRoute.POST(
    new Request("https://staffpass.example/api/journeys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ aiDisclosureAccepted: true, privacyVersion: "2026-09" }),
    })
  );
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

describe("LP guest session round trip", () => {
  test("lp_guest cookie value is token.signature only (no Set-Cookie attributes inside the value)", async () => {
    await startJourney();
    const value = new RequestCookies(new Headers({ cookie: cookieHeader() })).get("lp_guest")?.value ?? "";
    expect(value).toMatch(/^guest_[0-9a-f]{64}\.[0-9a-f]{64}$/);
    expect(value).not.toContain("lp_guest=");
    expect(value).not.toContain("Path=");
  });

  test("first chat turn after starting a journey is accepted (not invalid_session)", async () => {
    const csrf = await startJourney();
    expect(browserJar.lp_csrf).toBe(csrf);
    const res = await sendTurn(csrf);
    const body = (await res.json()) as { ok: boolean; error?: string; reply?: string; turnNumber?: number };
    expect(body.error).toBeUndefined();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.reply).toContain("AI相談窓口");
    expect(body.turnNumber).toBe(1);
    expect(openAiCalls.length).toBe(1);
    expect(tables.lp_chat_turns?.length).toBe(1);
  });

  test("tampered signature is still rejected as invalid_session", async () => {
    const csrf = await startJourney();
    browserJar.lp_guest = browserJar.lp_guest.replace(/.$/, (c) => (c === "0" ? "1" : "0"));
    const res = await sendTurn(csrf);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_session");
    expect(openAiCalls.length).toBe(0);
  });

  test("CSRF header must match the lp_csrf cookie", async () => {
    await startJourney();
    const res = await sendTurn("wrong");
    expect(res.status).toBe(403);
    expect(openAiCalls.length).toBe(0);
  });
});

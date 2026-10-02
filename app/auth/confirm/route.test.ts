import { beforeEach, expect, mock, test } from "bun:test";

let verifyCalls: unknown[] = [];
let verifyError: { message: string } | null = null;
mock.module("@/lib/mode", () => ({ isDemoMode: () => false }));
mock.module("@/lib/auth/route-supabase", () => ({
  createRouteSupabase: async () => ({
    auth: {
      verifyOtp: async (args: unknown) => {
        verifyCalls.push(args);
        return { data: {}, error: verifyError };
      },
      exchangeCodeForSession: async (code: string) => {
        verifyCalls.push({ code });
        return { data: {}, error: verifyError };
      },
    },
  }),
}));

const { GET, POST } = await import("./route");
const { resetRateLimitsForTest } = await import("@/lib/auth/auth-flow");
const BASE = "https://staffpass.sealith.com";
const TH = "f".repeat(56);

function post(fields: Record<string, string>, headers: Record<string, string> = { origin: BASE }) {
  const body = new URLSearchParams(fields);
  return new Request(`${BASE}/auth/confirm`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body,
  });
}

beforeEach(() => {
  verifyCalls = [];
  verifyError = null;
  resetRateLimitsForTest();
});

test("GET never consumes the token (scanner-safe interstitial)", async () => {
  const res = await GET(new Request(`${BASE}/auth/confirm?token_hash=${TH}&type=invite`));
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  expect(await res.text()).toContain('action="/auth/confirm"');
  expect(verifyCalls).toEqual([]);
});

test("GET with bad type / token → /auth/forgot?error=link_invalid", async () => {
  for (const q of [`token_hash=${TH}&type=signup`, `token_hash=${TH}`, "type=invite", "token_hash=%3Cx%3E&type=invite"]) {
    const res = await GET(new Request(`${BASE}/auth/confirm?${q}`));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${BASE}/auth/forgot?error=link_invalid`);
  }
  expect(verifyCalls).toEqual([]);
});

test("POST invite verifies server-side and sends to set-password", async () => {
  const res = await POST(post({ token_hash: TH, type: "invite" }));
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toBe(`${BASE}/auth/set-password?flow=invite`);
  expect(verifyCalls).toEqual([{ type: "invite", token_hash: TH }]);
});

test("POST recovery / magiclink destinations", async () => {
  expect((await POST(post({ token_hash: TH, type: "recovery" }))).headers.get("location")).toBe(
    `${BASE}/auth/set-password?flow=recovery`
  );
  expect((await POST(post({ token_hash: TH, type: "magiclink" }))).headers.get("location")).toBe(`${BASE}/app`);
});

test("POST cross-origin is rejected before touching Supabase (login CSRF)", async () => {
  const res = await POST(post({ token_hash: TH, type: "invite" }, { origin: "https://evil.example" }));
  expect(res.status).toBe(403);
  const res2 = await POST(post({ token_hash: TH, type: "invite" }, {}));
  expect(res2.status).toBe(403);
  expect(verifyCalls).toEqual([]);
});

test("verify error → generic link_invalid (no provider text)", async () => {
  verifyError = { message: "Email link is invalid or has expired" };
  const res = await POST(post({ token_hash: TH, type: "invite" }));
  expect(res.headers.get("location")).toBe(`${BASE}/auth/forgot?error=link_invalid`);
});

test("rate limited per IP", async () => {
  verifyError = { message: "x" };
  for (let i = 0; i < 10; i++) await POST(post({ token_hash: TH, type: "invite" }, { origin: BASE, "x-real-ip": "203.0.113.9" }));
  const res = await POST(post({ token_hash: TH, type: "invite" }, { origin: BASE, "x-real-ip": "203.0.113.9" }));
  expect(res.headers.get("location")).toBe(`${BASE}/auth/forgot?error=rate_limited`);
  expect(verifyCalls.length).toBe(10);
});

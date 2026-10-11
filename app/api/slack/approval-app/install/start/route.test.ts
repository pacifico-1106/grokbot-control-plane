/**
 * 2026-10-12 (木村): /api/slack/approval-app/install/start without a login
 * redirects to /login?next=/api/slack/approval-app/install/start (was 401 JSON).
 * A logged-in non-admin still gets 403 JSON; flag OFF still 404. The login
 * route only follows a same-origin `next` (no open redirect).
 */
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { NextResponse } from "next/server";

type Gate =
  | { ok: true; orgId: string; email: string }
  | { ok: false; reason: "auth_required" | "admin_required"; response: NextResponse };
let gate: Gate;
let adminCalls = 0;
const real = await import("@/lib/auth/require-org");
mock.module("@/lib/auth/require-org", () => ({
  ...real,
  requireOrgAdminSession: async () => {
    adminCalls += 1;
    return gate;
  },
}));

const { GET } = await import("./route");
const { POST: loginPOST } = await import("@/app/api/auth/login/route");
const ORIGIN = "https://staffpass.sealith.com";
const START = `${ORIGIN}/api/slack/approval-app/install/start`;

beforeEach(() => {
  process.env.SLACK_SHARED_APPROVAL_APP_ENABLED = "true";
  adminCalls = 0;
});
afterEach(() => {
  delete process.env.SLACK_SHARED_APPROVAL_APP_ENABLED;
});

test("not logged in → 303 to /login?next=/api/slack/approval-app/install/start, no-store, no state cookie", async () => {
  gate = { ok: false, reason: "auth_required", response: real.authRequiredResponse() };
  const res = await GET(new Request(START));
  expect(res.status).toBe(303);
  const loc = new URL(res.headers.get("location")!);
  expect(loc.origin).toBe(ORIGIN);
  expect(loc.pathname).toBe("/login");
  expect(loc.searchParams.get("next")).toBe("/api/slack/approval-app/install/start");
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("set-cookie")).toBeNull();
});

test("logged in but not owner/admin → still 403 JSON (utf-8), no redirect", async () => {
  gate = {
    ok: false,
    reason: "admin_required",
    response: NextResponse.json({ ok: false, error: "admin_required" }, { status: 403 }),
  };
  const res = await GET(new Request(START));
  expect(res.status).toBe(403);
  expect(res.headers.get("location")).toBeNull();
});

test("flag OFF → 404 before any session read", async () => {
  process.env.SLACK_SHARED_APPROVAL_APP_ENABLED = "false";
  gate = { ok: false, reason: "auth_required", response: real.authRequiredResponse() };
  const res = await GET(new Request(START));
  expect(res.status).toBe(404);
  expect(adminCalls).toBe(0);
});

test("the request's query never reaches next (fixed path only)", async () => {
  gate = { ok: false, reason: "auth_required", response: real.authRequiredResponse() };
  const res = await GET(new Request(`${START}?next=https://evil.example&x=1`));
  const loc = new URL(res.headers.get("location")!);
  expect(loc.searchParams.get("next")).toBe("/api/slack/approval-app/install/start");
  expect(res.headers.get("location")).not.toContain("evil");
});

function loginForm(next: string) {
  return new Request(`${ORIGIN}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN },
    body: new URLSearchParams({ email: "a@example.com", password: "x", next }),
  });
}

test("login (demo) follows the install next back to install/start", async () => {
  const res = await loginPOST(loginForm("/api/slack/approval-app/install/start"));
  expect(res.status).toBe(303);
  const loc = new URL(res.headers.get("location")!);
  expect(loc.origin).toBe(ORIGIN);
  expect(loc.pathname).toBe("/api/slack/approval-app/install/start");
});

test("login refuses open-redirect next values → /app on our origin", async () => {
  for (const next of ["https://evil.example/x", "//evil.example/x", "/\\evil.example/x", "javascript:alert(1)"]) {
    const res = await loginPOST(loginForm(next));
    const loc = new URL(res.headers.get("location")!);
    expect({ next, origin: loc.origin, path: loc.pathname }).toEqual({ next, origin: ORIGIN, path: "/app" });
  }
});

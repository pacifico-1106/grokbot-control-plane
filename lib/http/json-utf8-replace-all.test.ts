/**
 * 2026-10-12 (木村, #327 remainder b): every non-test NextResponse.json call is
 * replaced by jsonUtf8. Bodies, status codes and init headers stay the same;
 * only content-type gains the charset. The two mcp-oauth metadata routes keep
 * METADATA_HEADERS as they are (pinned in app/api/oauth/meta/discovery.test.ts).
 */
import { describe, expect, test } from "bun:test";
import { NextResponse } from "next/server";
import { jsonUtf8, JSON_UTF8_CONTENT_TYPE } from "@/lib/http/json-utf8";
import { JSON_UTF8_LEGACY_ALLOWLIST } from "../../eslint-rules/json-utf8-allowlist.mjs";

function headersExceptContentType(res: Response): Array<[string, string]> {
  return [...res.headers.entries()].filter(([k]) => k !== "content-type").sort();
}

describe("jsonUtf8 is NextResponse.json + charset (same body, status, headers)", () => {
  const cases: Array<{ name: string; body: unknown; init?: ResponseInit }> = [
    { name: "no init", body: { ok: true, message: "日本語" } },
    { name: "status only", body: { ok: false, error: "auth_required" }, init: { status: 401 } },
    { name: "status + statusText", body: { ok: false }, init: { status: 503, statusText: "Service Unavailable" } },
    { name: "headers object", body: [1, 2], init: { status: 200, headers: { "cache-control": "no-store", "x-request-id": "r1" } } },
    { name: "Headers instance", body: null, init: { status: 409, headers: new Headers({ "retry-after": "30", "set-cookie": "a=1; Path=/" }) } },
    { name: "header tuples", body: "text", init: { headers: [["vary", "origin"], ["cache-control", "private"]] } },
    { name: "caller content-type (replaced by the charset one)", body: {}, init: { headers: { "content-type": "application/json" } } },
  ];
  for (const c of cases) {
    test(c.name, async () => {
      const a = NextResponse.json(c.body, c.init);
      const b = jsonUtf8(c.body, c.init);
      expect(b.status).toBe(a.status);
      expect(b.statusText).toBe(a.statusText);
      expect(await b.text()).toBe(await a.text());
      expect(headersExceptContentType(b)).toEqual(headersExceptContentType(a));
      expect(b.headers.get("content-type")).toBe(JSON_UTF8_CONTENT_TYPE);
    });
  }
});

describe("call sites", () => {
  test("legacy allowlist is empty (every call site replaced)", () => {
    expect(JSON_UTF8_LEGACY_ALLOWLIST).toEqual([]);
  });

  test("a public route (/api/health) answers with charset=utf-8, same body shape", async () => {
    const { GET } = await import("@/app/api/health/route");
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(JSON_UTF8_CONTENT_TYPE);
    expect(Object.keys(await res.json()).sort()).toEqual(["demo", "ok", "resendConfigured", "runtimeMode", "stripeConfigured", "supabaseConfigured"]);
  });

  test("flag-off 404 of install/start carries the charset", async () => {
    const saved = process.env.SLACK_SHARED_APPROVAL_APP_ENABLED;
    process.env.SLACK_SHARED_APPROVAL_APP_ENABLED = "false";
    try {
      const { GET } = await import("@/app/api/slack/approval-app/install/start/route");
      const res = await GET(new Request("http://localhost/api/slack/approval-app/install/start"));
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toBe(JSON_UTF8_CONTENT_TYPE);
      expect(await res.json()).toEqual({ error: "not_found" });
    } finally {
      if (saved === undefined) delete process.env.SLACK_SHARED_APPROVAL_APP_ENABLED;
      else process.env.SLACK_SHARED_APPROVAL_APP_ENABLED = saved;
    }
  });
});

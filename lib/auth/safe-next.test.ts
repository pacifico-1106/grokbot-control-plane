/**
 * 2026-10-12 (木村): the login `next` validation, shared by /api/auth/login,
 * /login and the approval-app install redirect. Only same-origin paths pass;
 * everything else falls back to /app (no open redirect).
 */
import { describe, expect, test } from "bun:test";
import { loginRedirectUrl, safeNextDestination, safeNextPath } from "@/lib/auth/safe-next";

const BASE = "https://staffpass.sealith.com/api/auth/login";
const EVIL = [
  "https://evil.example/app",
  "//evil.example/app",
  "/\\evil.example/app",
  "\\\\evil.example",
  "///evil.example",
  "javascript:alert(1)",
  "data:text/html,x",
  "http://staffpass.sealith.com/app",
  "https://staffpass.sealith.com.evil.example/app",
  "https://user@evil.example/app",
  "\t//evil.example",
];

describe("safeNextDestination (request origin)", () => {
  test("same-origin paths pass with query and hash", () => {
    expect(safeNextDestination("/api/slack/approval-app/install/start", BASE)).toBe("/api/slack/approval-app/install/start");
    expect(safeNextDestination("/app/settings?tab=slack#x", BASE)).toBe("/app/settings?tab=slack#x");
    expect(safeNextDestination("https://staffpass.sealith.com/app/x", BASE)).toBe("/app/x");
  });
  test("open redirects are refused → /app", () => {
    for (const value of EVIL) expect({ value, out: safeNextDestination(value, BASE) }).toEqual({ value, out: "/app" });
  });
  test("empty / garbage → /app", () => {
    expect(safeNextDestination("", BASE)).toBe("/app");
    expect(safeNextDestination("http://[::1", BASE)).toBe("/app");
  });
});

describe("safeNextPath (no request: relative paths only)", () => {
  test("relative paths pass; absolute URLs and protocol-relative refused", () => {
    expect(safeNextPath("/api/slack/approval-app/install/start")).toBe("/api/slack/approval-app/install/start");
    expect(safeNextPath(undefined)).toBe("/app");
    for (const value of EVIL) expect({ value, out: safeNextPath(value) }).toEqual({ value, out: "/app" });
    expect(safeNextPath("https://staffpass.sealith.com/app")).toBe("/app");
  });
});

describe("loginRedirectUrl", () => {
  test("builds /login?next=<path> on the request origin; refuses a foreign next", () => {
    const url = loginRedirectUrl("/api/slack/approval-app/install/start", "https://staffpass.sealith.com/api/slack/approval-app/install/start");
    expect(url.origin).toBe("https://staffpass.sealith.com");
    expect(url.pathname).toBe("/login");
    expect(url.searchParams.get("next")).toBe("/api/slack/approval-app/install/start");
    expect(loginRedirectUrl("//evil.example", "https://staffpass.sealith.com/x").searchParams.get("next")).toBe("/app");
  });
});

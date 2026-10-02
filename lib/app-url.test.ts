import { describe, expect, test } from "bun:test";
import {
  STAFFPASS_PUBLIC_ORIGIN,
  authConfirmUrl,
  isLoopbackHostname,
  resolveAppOrigin,
  resolveAuthRedirectOrigin,
} from "./app-url";

describe("resolveAppOrigin (fail-safe in production)", () => {
  test("VERCEL_ENV=production with NEXT_PUBLIC_APP_URL missing → canonical, never localhost", () => {
    expect(resolveAppOrigin({ VERCEL_ENV: "production" })).toBe(STAFFPASS_PUBLIC_ORIGIN);
    expect(resolveAppOrigin({ VERCEL_ENV: "production", NODE_ENV: "production" })).toBe(
      "https://staffpass.sealith.com"
    );
  });

  test("VERCEL_ENV=production ignores loopback / http / garbage NEXT_PUBLIC_APP_URL", () => {
    for (const bad of [
      "http://localhost:3000",
      "https://localhost:3000",
      "http://127.0.0.1:3000",
      "https://app.localhost",
      "http://staffpass.sealith.com",
      "https://[::1]:3000",
      "javascript:alert(1)",
      "   ",
    ]) {
      expect(resolveAppOrigin({ VERCEL_ENV: "production", NEXT_PUBLIC_APP_URL: bad })).toBe(
        STAFFPASS_PUBLIC_ORIGIN
      );
    }
  });

  test("VERCEL_ENV=production honours an explicit public https override (trailing slash stripped)", () => {
    expect(
      resolveAppOrigin({ VERCEL_ENV: "production", NEXT_PUBLIC_APP_URL: "https://staffpass.sealith.com/" })
    ).toBe("https://staffpass.sealith.com");
  });

  test("non-Vercel NODE_ENV=production without config → canonical", () => {
    expect(resolveAppOrigin({ NODE_ENV: "production" })).toBe(STAFFPASS_PUBLIC_ORIGIN);
  });

  test("local dev keeps localhost fallback; configured value wins", () => {
    expect(resolveAppOrigin({ NODE_ENV: "development" })).toBe("http://localhost:3000");
    expect(resolveAppOrigin({ NEXT_PUBLIC_APP_URL: "http://localhost:4000/" })).toBe(
      "http://localhost:4000"
    );
    expect(resolveAppOrigin({ VERCEL_URL: "foo-git-x.vercel.app" })).toBe("https://foo-git-x.vercel.app");
  });

  test("loopback detection", () => {
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("127.0.0.2")).toBe(true);
    expect(isLoopbackHostname("[::1]")).toBe(true);
    expect(isLoopbackHostname("staffpass.sealith.com")).toBe(false);
  });
});

describe("auth redirect origin", () => {
  test("production is pinned to the canonical host (matches Supabase allowlist)", () => {
    expect(
      resolveAuthRedirectOrigin({ VERCEL_ENV: "production", NEXT_PUBLIC_APP_URL: "https://other.example" })
    ).toBe(STAFFPASS_PUBLIC_ORIGIN);
    expect(authConfirmUrl({ VERCEL_ENV: "production" })).toBe(
      "https://staffpass.sealith.com/auth/confirm"
    );
  });
  test("dev uses the local origin", () => {
    expect(authConfirmUrl({ NODE_ENV: "development" })).toBe("http://localhost:3000/auth/confirm");
  });
});

describe("callers never emit localhost in production", () => {
  test("getAppOrigin / getAppUrl / buildPollUrl", async () => {
    const saved = { ...process.env };
    try {
      process.env.VERCEL_ENV = "production";
      process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
      const { getAppOrigin, buildPollUrl } = await import("./approvals/tokens");
      const { getAppUrl } = await import("./stripe");
      expect(getAppOrigin()).toBe(STAFFPASS_PUBLIC_ORIGIN);
      expect(getAppUrl()).toBe(STAFFPASS_PUBLIC_ORIGIN);
      expect(buildPollUrl("apr_1", "st_x").startsWith("https://staffpass.sealith.com/api/approvals/status?")).toBe(true);
    } finally {
      for (const k of ["VERCEL_ENV", "NEXT_PUBLIC_APP_URL"]) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });
});

import { describe, expect, test } from "bun:test";
import { trustedClientIp, trustedClientIpFromHeaders } from "./client-ip";

function req(headers: Record<string, string>) {
  return new Request("https://staffpass.sealith.com/api/lp/ai-employee/inquiry", {
    method: "POST",
    headers,
  });
}

describe("trustedClientIp", () => {
  test("ignores attacker-controlled cf-connecting-ip", () => {
    expect(
      trustedClientIp(
        req({
          "cf-connecting-ip": "1.1.1.1",
          "x-vercel-forwarded-for": "203.0.113.7",
          "x-forwarded-for": "9.9.9.9",
        })
      )
    ).toBe("203.0.113.7");
    expect(trustedClientIp(req({ "cf-connecting-ip": "1.1.1.1" }))).toBeNull();
    expect(
      trustedClientIpFromHeaders(
        new Headers({ "cf-connecting-ip": "1.1.1.1", "x-real-ip": "198.51.100.9" })
      )
    ).toBe("198.51.100.9");
  });

  test("prefers x-vercel-forwarded-for over x-real-ip over X-Forwarded-For", () => {
    expect(
      trustedClientIp(
        req({
          "x-vercel-forwarded-for": "203.0.113.7",
          "x-real-ip": "198.51.100.9",
          "x-forwarded-for": "9.9.9.9",
        })
      )
    ).toBe("203.0.113.7");
    expect(
      trustedClientIp(req({ "x-real-ip": "198.51.100.9", "x-forwarded-for": "9.9.9.9" }))
    ).toBe("198.51.100.9");
    expect(trustedClientIp(req({ "x-forwarded-for": "9.9.9.9, 10.0.0.1" }))).toBe("9.9.9.9");
  });
});

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
  });

  test("X-Forwarded-For uses the rightmost hop (platform-appended), not the spoofable leftmost", () => {
    expect(trustedClientIp(req({ "x-forwarded-for": "9.9.9.9, 10.0.0.1" }))).toBe("10.0.0.1");
    expect(
      trustedClientIp(req({ "x-forwarded-for": "1.1.1.1, 8.8.8.8, 203.0.113.9" }))
    ).toBe("203.0.113.9");
  });

  test("rotating a spoofed XFF prefix does not change the key when a platform header is set", () => {
    const a = trustedClientIp(
      req({ "x-real-ip": "203.0.113.9", "x-forwarded-for": "1.1.1.1, 203.0.113.9" })
    );
    const b = trustedClientIp(
      req({ "x-real-ip": "203.0.113.9", "x-forwarded-for": "2.2.2.2, 203.0.113.9" })
    );
    expect(a).toBe("203.0.113.9");
    expect(a).toBe(b);
  });

  test("rotating a spoofed XFF prefix does not change the rightmost-hop fallback", () => {
    const a = trustedClientIp(req({ "x-forwarded-for": "1.1.1.1, 198.51.100.9" }));
    const b = trustedClientIp(req({ "x-forwarded-for": "9.9.9.9, 198.51.100.9" }));
    expect(a).toBe("198.51.100.9");
    expect(a).toBe(b);
  });
});

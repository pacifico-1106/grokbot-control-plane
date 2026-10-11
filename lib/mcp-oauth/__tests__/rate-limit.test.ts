import { afterEach, beforeEach, expect, test } from "bun:test";
import { clientIp, ipHash } from "@/lib/mcp-oauth/rate-limit";

const r = (h: Record<string, string>) => new Request("https://staffpass.sealith.com/oauth/authorize", { headers: h });
let saved: string | undefined;
beforeEach(() => {
  saved = process.env.IP_HASH_KEY;
  process.env.IP_HASH_KEY = "k".repeat(32);
});
afterEach(() => {
  if (saved === undefined) delete process.env.IP_HASH_KEY;
  else process.env.IP_HASH_KEY = saved;
});

test("hardening 7: key comes from the platform IP (ipAddress → x-real-ip), never from client-chosen X-Forwarded-For", () => {
  expect(clientIp(r({ "x-real-ip": "203.0.113.9", "x-forwarded-for": "6.6.6.6, 203.0.113.9" }))).toBe("203.0.113.9");
  expect(clientIp(r({ "x-forwarded-for": "6.6.6.6" }))).toBe("unknown");
  expect(clientIp(r({}))).toBe("unknown");
});

test("rotating X-Forwarded-For does not rotate the bucket", () => {
  const a = ipHash(r({ "x-real-ip": "203.0.113.9", "x-forwarded-for": "1.1.1.1" }));
  const b = ipHash(r({ "x-real-ip": "203.0.113.9", "x-forwarded-for": "2.2.2.2" }));
  expect(a).toBeTruthy();
  expect(a).toBe(b);
  expect(ipHash(r({ "x-real-ip": "198.51.100.1" }))).not.toBe(a);
});

test("missing / short IP_HASH_KEY → null (callers fail closed with 503)", () => {
  process.env.IP_HASH_KEY = "short";
  expect(ipHash(r({ "x-real-ip": "203.0.113.9" }))).toBeNull();
});

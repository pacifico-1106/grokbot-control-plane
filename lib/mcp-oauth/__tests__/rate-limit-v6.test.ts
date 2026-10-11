/** #318 follow-up: OAuth IP buckets treat an IPv6 /64 as one client. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { ipHash, ipRateKey } from "@/lib/mcp-oauth/rate-limit";

const r = (ip: string) => new Request("https://staffpass.sealith.com/api/oauth/token", { headers: { "x-real-ip": ip } });
let saved: string | undefined;
beforeEach(() => {
  saved = process.env.IP_HASH_KEY;
  process.env.IP_HASH_KEY = "k".repeat(32);
});
afterEach(() => {
  if (saved === undefined) delete process.env.IP_HASH_KEY;
  else process.env.IP_HASH_KEY = saved;
});

test("ipRateKey: IPv6 → its /64 (any spelling); IPv4 and IPv4-mapped → the IPv4 address; junk → unknown", () => {
  expect(ipRateKey("2001:db8:1:2::1")).toBe("2001:db8:1:2::/64");
  expect(ipRateKey("2001:0DB8:0001:0002:aaaa:bbbb:cccc:dddd")).toBe("2001:db8:1:2::/64");
  expect(ipRateKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
  expect(ipRateKey("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
  expect(ipRateKey("[2001:db8:1:2::9]")).toBe("2001:db8:1:2::/64");
  expect(ipRateKey("203.0.113.5")).toBe("203.0.113.5");
  expect(ipRateKey("::ffff:203.0.113.5")).toBe("203.0.113.5");
  expect(ipRateKey("::ffff:cb00:7105")).toBe("203.0.113.5");
  expect(ipRateKey("")).toBe("unknown");
  expect(ipRateKey("unknown")).toBe("unknown");
  expect(ipRateKey("not-an-ip")).toBe("unknown");
});

test("ipHash: same /64 → same bucket; different /64 → different; v4 unchanged per address", () => {
  expect(ipHash(r("2001:db8:1:2::1"))).toBe(ipHash(r("2001:db8:1:2:ffff:ffff:ffff:ffff")));
  expect(ipHash(r("2001:db8:1:2::1"))).not.toBe(ipHash(r("2001:db8:1:3::1")));
  expect(ipHash(r("203.0.113.5"))).toBe(ipHash(r("::ffff:203.0.113.5")));
  expect(ipHash(r("203.0.113.5"))).not.toBe(ipHash(r("203.0.113.6")));
});

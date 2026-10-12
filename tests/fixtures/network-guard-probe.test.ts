/**
 * Probe run by lib/security/test-network-guard.test.ts as a plain `bun test <file>`
 * (no --preload flag, parent env carrying FAKE notify / credential values). It must
 * see the repo-wide preload (bunfig.toml): those env vars deleted, and every real
 * network path refused, naming the host only. It performs a request only after the
 * guard marker is confirmed, and every target is a fake / reserved host.
 */
import { expect, test } from "bun:test";

const KEYS = (process.env.PROBE_EXPECT_SCRUBBED ?? "").split(",").filter(Boolean);

async function refusal(run: () => unknown): Promise<string> {
  try {
    await run();
    return "NOT_REFUSED";
  } catch (e) {
    return String((e as Error).message);
  }
}

test("probe: notify / credential env stripped and every network path refused", async () => {
  const guarded = (globalThis as { __STAFFPASS_NETWORK_GUARD__?: boolean }).__STAFFPASS_NETWORK_GUARD__ === true;
  const leftover = KEYS.filter((k) => process.env[k] !== undefined);
  console.log(`PROBE guarded=${guarded} leftover=${leftover.join(",") || "-"}`);
  expect(guarded).toBe(true);
  expect(leftover).toEqual([]);

  const results: Record<string, string> = {};
  results.fetch = await refusal(() => fetch("https://hooks.slack.com/services/T000/B000/probe"));
  const https = await import("node:https");
  results.https = await refusal(() => https.request("https://hooks.slack.com/services/T000/B000/probe"));
  const http = await import("node:http");
  results.http = await refusal(() => http.get({ hostname: "api.resend.com", path: "/" }));
  const net = await import("node:net");
  results.net = await refusal(() => net.connect({ host: "smtp.resend.com", port: 587 }));
  const tls = await import("node:tls");
  results.tls = await refusal(() => tls.connect({ host: "api.stripe.com", port: 443 }));
  const undici = await import("undici");
  results.undici = await refusal(() => undici.request("https://api.telegram.org/bot0/sendMessage"));
  results.undiciAgent = await refusal(() =>
    new undici.Agent().request({ origin: "https://api.line.me", path: "/", method: "GET" })
  );
  const dns = await import("node:dns/promises");
  results.dns = await refusal(() => dns.lookup("hooks.slack.com"));
  console.log(`PROBE results=${JSON.stringify(results)}`);
  expect(results.fetch).toContain("network_forbidden_in_local_tests: hooks.slack.com");
  expect(results.fetch).not.toContain("/services/");
  expect(results.https).toContain("hooks.slack.com");
  expect(results.http).toContain("api.resend.com");
  expect(results.net).toContain("smtp.resend.com");
  expect(results.tls).toContain("api.stripe.com");
  expect(results.undici).toContain("api.telegram.org");
  expect(results.undiciAgent).toContain("api.line.me");
  expect(results.dns).toContain("hooks.slack.com");
  // the probe triggered these on purpose; don't fail the file in the guard's afterAll
  (globalThis as { __STAFFPASS_NETWORK_ATTEMPTS_RESET__?: () => void }).__STAFFPASS_NETWORK_ATTEMPTS_RESET__?.();
});

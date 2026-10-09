/**
 * Run under real Node (bundled by lib/webhooks/link-local-guard.test.ts):
 * native fetch + the guard dispatcher, exactly like the two flag-OFF call
 * sites, against a local 127.0.0.1 server. The injected resolver maps test
 * hostnames; blocked destinations must fail at connect time with
 * address_blocked and never reach a server. Prints one JSON line per case.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { __setLinkLocalGuardResolverForTests, withLinkLocalGuard } from "../../lib/webhooks/link-local-guard";
import { categorizeFetchError } from "../../lib/webhooks/outbound";

const answers: Record<string, Array<{ address: string; family: number }>> = {
  "allowed.test": [{ address: "127.0.0.1", family: 4 }],
  "meta.test": [{ address: "169.254.169.254", family: 4 }],
  "mixed.test": [{ address: "127.0.0.1", family: 4 }, { address: "169.254.170.2", family: 4 }],
  "imds6.test": [{ address: "fd00:ec2::254", family: 6 }],
  "mapped.test": [{ address: "::ffff:169.254.169.254", family: 6 }],
  "nat64.test": [{ address: "64:ff9b::a9fe:a9fe", family: 6 }],
  "gcp6.test": [{ address: "fd20:ce::254", family: 6 }],
};
__setLinkLocalGuardResolverForTests((host, _options, cb) => {
  const a = answers[host];
  if (!a) return cb(Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" }), []);
  cb(null, a);
});

let hits: string[] = [];
const server = http.createServer((req, res) => {
  const u = new URL(req.url || "/", "http://x");
  hits.push(u.pathname);
  if (u.pathname === "/redir") { res.writeHead(302, { location: u.searchParams.get("to") || "/" }); res.end(); return; }
  res.end("ok");
});

async function main() {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  const at = (host: string, path = "/ok") => `http://${host}:${port}${path}`;
  const redir = (to: string) => at("allowed.test", `/redir?to=${encodeURIComponent(to)}`);
  const cases: Array<[string, string]> = [
    ["allowed host (resolves to 127.0.0.1)", at("allowed.test")],
    ["allowed host, redirect to allowed host", redir(at("allowed.test"))],
    ["hostname resolving to 169.254.169.254", at("meta.test")],
    ["hostname with one 169.254.170.2 answer among allowed ones", at("mixed.test")],
    ["redirect to a hostname resolving to 169.254.169.254", redir(at("meta.test"))],
    ["redirect to http://169.254.169.254/ literal", redir("http://169.254.169.254/latest/meta-data/")],
    ["redirect to http://[::ffff:169.254.169.254]/ literal", redir("http://[::ffff:169.254.169.254]/latest/meta-data/")],
    ["redirect to http://[fd00:ec2::254]/ literal", redir("http://[fd00:ec2::254]/latest/meta-data/")],
    ["direct http://169.254.169.254/ literal", "http://169.254.169.254/latest/meta-data/"],
    ["direct http://100.100.100.200/ literal", "http://100.100.100.200/latest/meta-data/"],
    ["direct http://[fe80::1]/ literal", "http://[fe80::1]/"],
    ["hostname resolving to fd00:ec2::254", at("imds6.test")],
    ["hostname resolving to ::ffff:169.254.169.254", at("mapped.test")],
    ["hostname resolving to 64:ff9b::a9fe:a9fe", at("nat64.test")],
    ["hostname resolving to fd20:ce::254", at("gcp6.test")],
  ];
  for (const [name, url] of cases) {
    hits = [];
    let result: string;
    try {
      const res = await fetch(url, withLinkLocalGuard({ method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(5000) }));
      await res.arrayBuffer();
      result = String(res.status);
    } catch (e) {
      result = categorizeFetchError(e);
    }
    console.log(JSON.stringify({ name, result, hits }));
  }
  server.close();
  process.exit(0);
}
void main();

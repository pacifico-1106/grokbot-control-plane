/**
 * Probe for lib/security/test-network-guard.test.ts (run as its own `bun test`):
 * the 5 outbound channels the first guard (#353) left open — Bun.fetch,
 * node:http2, node:dgram, curl / wget through child_process (and Bun.spawn),
 * Bun.connect (and Bun.udpSocket) — each refuses a real host loudly, naming the
 * host only, and still works against loopback. Never collected by a bare
 * `bun test` (*.fixture.ts). Runs nothing that connects unless the channel guard is installed.
 */
import { afterAll, describe, expect, test } from "bun:test";
import * as http2 from "node:http2";
import * as dgram from "node:dgram";
import * as cp from "node:child_process";

const SECRET_PATH = "services/T000/B000/probe-secret-path";
// Gate on the channel guard itself (the attempts reader ships with it), not only the
// #353 marker: on a runtime without it, nothing below may run (it would really connect).
const guarded =
  (globalThis as { __STAFFPASS_NETWORK_GUARD__?: boolean }).__STAFFPASS_NETWORK_GUARD__ === true &&
  typeof (globalThis as { __STAFFPASS_NETWORK_ATTEMPTS__?: unknown }).__STAFFPASS_NETWORK_ATTEMPTS__ === "function";
const attempts = () => ((globalThis as { __STAFFPASS_NETWORK_ATTEMPTS__?: () => string[] }).__STAFFPASS_NETWORK_ATTEMPTS__?.() ?? []);
const refusedSync = (fn: () => unknown, host: string) => {
  let err: unknown = null;
  try { fn(); } catch (e) { err = e; }
  expect(String(err)).toContain(`network_forbidden_in_local_tests: ${host}`);
  expect(String(err)).not.toContain("probe-secret-path");
};
const curlOk = Boolean(Bun.which("curl"));

test("the guard is installed (else nothing below may touch the network)", () => {
  expect(guarded).toBe(true);
  expect(typeof (globalThis as { __STAFFPASS_NETWORK_ATTEMPTS__?: unknown }).__STAFFPASS_NETWORK_ATTEMPTS__).toBe("function");
});

describe.if(guarded)("closed channels", () => {
  test("Bun.fetch to hooks.slack.com rejects and is recorded by host (no path)", async () => {
    let threw = false;
    try { await Bun.fetch(`https://hooks.slack.com/${SECRET_PATH}`); } catch { threw = true; }
    expect(threw).toBe(true);
    expect(attempts()).toContain("hooks.slack.com");
    expect(attempts().join(" ")).not.toContain("probe-secret-path");
    let threwHttp = false;
    try { await Bun.fetch(`http://plain.example.com/${SECRET_PATH}`); } catch { threwHttp = true; }
    expect(threwHttp).toBe(true);
    expect(attempts()).toContain("plain.example.com");
  });

  test("Bun.fetch to loopback still works", async () => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
    try {
      expect(await (await Bun.fetch(`http://127.0.0.1:${server.port}/`)).text()).toBe("ok");
    } finally { server.stop(true); }
  });

  test("node:http2 connect to a real host throws, naming the host", () => {
    refusedSync(() => http2.connect(`https://push.example.com/${SECRET_PATH}`), "push.example.com");
  });

  test("node:http2 connect to loopback is allowed", async () => {
    const server = http2.createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    const session = http2.connect(`http://127.0.0.1:${port}`);
    await new Promise<void>((r) => session.once("connect", () => r()));
    session.close();
    await new Promise<void>((r) => server.close(() => r()));
  });

  test("node:dgram send / connect to a real address throws; loopback allowed", async () => {
    const s = dgram.createSocket("udp4");
    refusedSync(() => s.send(Buffer.from("x"), 53, "8.8.8.8"), "8.8.8.8");
    refusedSync(() => s.send(Buffer.from("x"), 0, 1, 53, "dns.example.com"), "dns.example.com");
    refusedSync(() => s.connect(53, "1.1.1.1"), "1.1.1.1");
    const peer = dgram.createSocket("udp4");
    await new Promise<void>((r) => peer.bind(0, "127.0.0.1", () => r()));
    const got = new Promise<string>((r) => peer.once("message", (m) => r(String(m))));
    s.send(Buffer.from("loop"), (peer.address() as { port: number }).port, "127.0.0.1");
    expect(await got).toBe("loop");
    s.close(); peer.close();
  });

  test("curl / wget through child_process (every entry point, shell strings, bare specifier) throw, naming the host", async () => {
    const url = `https://hooks.slack.com/${SECRET_PATH}`;
    refusedSync(() => cp.spawnSync("curl", ["-s", url]), "hooks.slack.com");
    refusedSync(() => cp.spawn("/usr/bin/curl", ["-s", "-X", "POST", url]), "hooks.slack.com");
    refusedSync(() => cp.execSync(`curl -s ${url}`), "hooks.slack.com");
    refusedSync(() => cp.exec(`wget -q -O- http://example.com/${SECRET_PATH}`), "example.com");
    refusedSync(() => cp.execFile("wget", ["-q", url]), "hooks.slack.com");
    refusedSync(() => cp.execFileSync("curl", ["--data", "x", url]), "hooks.slack.com");
    refusedSync(() => cp.spawnSync("sh", ["-c", `echo hi && curl -s ${url}`]), "hooks.slack.com");
    refusedSync(() => cp.spawnSync("bash", ["-lc", `curl -fsS api.telegram.org/bot0/sendMessage`]), "api.telegram.org");
    const bare = (await import("child_process")) as typeof cp;
    refusedSync(() => bare.spawnSync("curl", [url]), "hooks.slack.com");
  });

  test("Bun.spawn / Bun.spawnSync with curl throw too", () => {
    const url = `https://hooks.slack.com/${SECRET_PATH}`;
    refusedSync(() => Bun.spawn(["curl", "-s", url]), "hooks.slack.com");
    refusedSync(() => Bun.spawnSync({ cmd: ["wget", url] }), "hooks.slack.com");
  });

  test("child_process stays usable: non-network commands and curl to loopback run", async () => {
    expect(cp.spawnSync("echo", ["hi"], { encoding: "utf8" }).stdout.trim()).toBe("hi");
    expect(cp.execSync("echo ok", { encoding: "utf8" }).trim()).toBe("ok");
    expect(Bun.spawnSync(["echo", "x"]).stdout.toString().trim()).toBe("x");
    if (curlOk) {
      const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("loop") });
      try {
        const r = Bun.spawn(["curl", "-s", `http://127.0.0.1:${server.port}/`], { stdout: "pipe" });
        expect((await new Response(r.stdout).text()).trim()).toBe("loop");
      } finally { server.stop(true); }
    }
  });

  test("Bun.connect to a real host throws, naming the host; unix sockets refused; loopback allowed", async () => {
    let err: unknown = null;
    try { await Bun.connect({ hostname: "smtp.example.com", port: 25, socket: { data() {} } }); } catch (e) { err = e; }
    expect(String(err)).toContain("network_forbidden_in_local_tests: smtp.example.com");
    err = null;
    try { await Bun.connect({ unix: "/var/run/docker.sock", socket: { data() {} } }); } catch (e) { err = e; }
    expect(String(err)).toContain("network_forbidden_in_local_tests: unix:");
    const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const sock = await Bun.connect({ hostname: "127.0.0.1", port: listener.port, socket: { data() {} } });
    sock.end(); listener.stop(true);
  });

  test("Bun.udpSocket send to a real address throws; loopback allowed", async () => {
    const s = await Bun.udpSocket({});
    refusedSync(() => s.send("x", 53, "8.8.8.8"), "8.8.8.8");
    const peer = await Bun.udpSocket({ hostname: "127.0.0.1" });
    expect(s.send("x", peer.port, "127.0.0.1")).toBe(true);
    s.close(); peer.close();
  });
});

afterAll(() => {
  // every refusal above was deliberate; the harness checks the file passed
  (globalThis as { __STAFFPASS_NETWORK_ATTEMPTS_RESET__?: () => void }).__STAFFPASS_NETWORK_ATTEMPTS_RESET__?.();
});

/**
 * #254 follow-up 1: every MCP / app origin comes from resolveAppOrigin()
 * (never a hardcoded host, never request headers).
 * Env unset on production → exactly the current production values.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import {
  staffpassMcpServerCardUrl,
  staffpassMcpUrl,
} from "@/lib/mcp/public";
import {
  staffpassAdminMcpServerCardUrl,
  staffpassAdminMcpUrl,
} from "@/lib/mcp/admin-public";
import { buildAdminServerCard, buildServerCard } from "@/lib/mcp/server-card";

const ROOT = join(import.meta.dir, "..", "..");
const PROD_ORIGIN = "https://staffpass.sealith.com";
const ALT = "https://alt-origin.example.test";
const PROD_ENVS: Array<Record<string, string | undefined>> = [
  { VERCEL_ENV: "production" },
  { NODE_ENV: "production" },
  // A mis-set loopback value on a production deploy still resolves to the canonical host.
  { VERCEL_ENV: "production", NEXT_PUBLIC_APP_URL: "http://localhost:3000" },
];

const ENV_KEYS = ["NEXT_PUBLIC_APP_URL", "VERCEL_ENV", "MCP_ENDPOINT_HANDOFF_ENABLED"];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function readJson(rel: string): unknown {
  return JSON.parse(readFileSync(join(ROOT, rel), "utf8"));
}

describe("public MCP URLs come from resolveAppOrigin()", () => {
  test("env unset on production → current production values (unchanged)", () => {
    for (const env of PROD_ENVS) {
      expect(staffpassMcpUrl(env)).toBe(`${PROD_ORIGIN}/api/mcp`);
      expect(staffpassMcpServerCardUrl(env)).toBe(`${PROD_ORIGIN}/.well-known/mcp/server-card.json`);
      expect(staffpassAdminMcpUrl(env)).toBe(`${PROD_ORIGIN}/api/mcp/admin`);
      expect(staffpassAdminMcpServerCardUrl(env)).toBe(`${PROD_ORIGIN}/.well-known/mcp/admin-server-card.json`);
    }
  });

  test("configured origin is used (no hardcode)", () => {
    const env = { VERCEL_ENV: "production", NEXT_PUBLIC_APP_URL: `${ALT}/` };
    expect(staffpassMcpUrl(env)).toBe(`${ALT}/api/mcp`);
    expect(staffpassMcpServerCardUrl(env)).toBe(`${ALT}/.well-known/mcp/server-card.json`);
    expect(staffpassAdminMcpUrl(env)).toBe(`${ALT}/api/mcp/admin`);
    expect(staffpassAdminMcpServerCardUrl(env)).toBe(`${ALT}/.well-known/mcp/admin-server-card.json`);
  });
});

describe("server cards (was public/.well-known static JSON with a hardcoded host)", () => {
  test("env unset on production → byte-for-byte the previous static cards", () => {
    const card = readJson("lib/mcp/__fixtures__/server-card.production.json");
    const admin = readJson("lib/mcp/__fixtures__/admin-server-card.production.json");
    for (const env of PROD_ENVS) {
      expect(buildServerCard(env)).toEqual(card as Record<string, unknown>);
      expect(buildAdminServerCard(env)).toEqual(admin as Record<string, unknown>);
    }
  });

  test("configured origin flows into every URL of both cards", () => {
    const env = { VERCEL_ENV: "production", NEXT_PUBLIC_APP_URL: ALT };
    const card = buildServerCard(env) as { websiteUrl: string; documentationUrl: string; transport: { url: string } };
    expect(card.websiteUrl).toBe(ALT);
    expect(card.documentationUrl).toBe(`${ALT}/docs/mcp`);
    expect(card.transport.url).toBe(`${ALT}/api/mcp`);
    const admin = buildAdminServerCard(env) as { websiteUrl: string; documentationUrl: string; transport: { url: string } };
    expect(admin.websiteUrl).toBe(ALT);
    expect(admin.transport.url).toBe(`${ALT}/api/mcp/admin`);
    expect(JSON.stringify(card) + JSON.stringify(admin)).not.toContain("sealith.com");
  });

  test("served at the same well-known paths from config (route handlers)", async () => {
    process.env.NEXT_PUBLIC_APP_URL = ALT;
    const { GET: card } = await import("@/app/.well-known/mcp/server-card.json/route");
    const { GET: admin } = await import("@/app/.well-known/mcp/admin-server-card.json/route");
    const a = (await (await card()).json()) as { transport: { url: string } };
    const b = (await (await admin()).json()) as { transport: { url: string } };
    expect(a.transport.url).toBe(`${ALT}/api/mcp`);
    expect(b.transport.url).toBe(`${ALT}/api/mcp/admin`);
  });
});

describe("MCP discovery (GET) and initialize use the configured origin", () => {
  test("employee MCP GET serverInfo: websiteUrl + mcpEndpoint from config", async () => {
    process.env.NEXT_PUBLIC_APP_URL = ALT;
    const { GET } = await import("@/app/api/mcp/route");
    const info = (await (await GET()).json()) as { websiteUrl: string; mcpEndpoint: string };
    expect(info.websiteUrl).toBe(ALT);
    expect(info.mcpEndpoint).toBe(`${ALT}/api/mcp`);
  });

  test("admin MCP GET serverInfo: websiteUrl + mcpEndpoint from config", async () => {
    process.env.NEXT_PUBLIC_APP_URL = ALT;
    const { GET } = await import("@/app/api/mcp/admin/route");
    const info = (await (await GET()).json()) as { websiteUrl: string; mcpEndpoint: string };
    expect(info.websiteUrl).toBe(ALT);
    expect(info.mcpEndpoint).toBe(`${ALT}/api/mcp/admin`);
  });

  test("Host / X-Forwarded-Host headers are never used", async () => {
    process.env.NEXT_PUBLIC_APP_URL = ALT;
    const { POST } = await import("@/app/api/mcp/route");
    const res = await POST(new Request("https://evil.example/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", host: "evil.example", "x-forwarded-host": "evil.example" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    }));
    const text = await res.text();
    expect(text).not.toContain("evil.example");
    expect(text).not.toContain("sealith.com");
    const { GET } = await import("@/app/api/mcp/route");
    expect(await (await GET()).text()).not.toContain("evil.example");
  });

  test("staffpass_health: publicOrigin from config even with the handoff flag OFF", async () => {
    delete process.env.MCP_ENDPOINT_HANDOFF_ENABLED;
    process.env.NEXT_PUBLIC_APP_URL = ALT;
    const { callStaffpassMcpTool } = await import("@/lib/mcp/tools");
    const r = await callStaffpassMcpTool("staffpass_health", {}, {
      employeeId: "emp_sales", orgId: "00000000-0000-0000-0000-000000000001", generation: 1,
      credentialId: "cred_sales", fingerprint: "fp", binding: null, secretPrefix: "gb_emp_x",
    } as never);
    const h = JSON.parse((r.content[0] as { text: string }).text) as Record<string, unknown>;
    expect(h.publicOrigin).toBe(ALT);
    expect(h.mcpEndpoint).toBe("/api/mcp");
  });

  test("Admin MCP credential issue response: mcpUrl from config (source)", () => {
    const src = readFileSync(join(ROOT, "app/api/admin-mcp/issue/route.ts"), "utf8");
    expect(src).toContain("staffpassAdminMcpUrl()");
    expect(src).not.toContain("STAFFPASS_ADMIN_MCP_URL");
  });

  test("dashboard / docs components get the URL from config (client component via prop)", () => {
    const setup = readFileSync(join(ROOT, "components/mcp/McpSetupContent.tsx"), "utf8");
    expect(setup).toContain("staffpassMcpUrl()");
    const admin = readFileSync(join(ROOT, "components/AdminMcpConnect.tsx"), "utf8");
    expect(admin).toContain("adminMcpUrl");
    expect(admin).not.toContain("STAFFPASS_ADMIN_MCP_URL");
  });
});

describe("setup links / LP checkout origin allowlist", () => {
  test("setup link base URL: production with env unset → canonical; configured → that origin", async () => {
    const { resolveSetupLinkBaseUrl } = await import("@/lib/security/setup-links");
    expect(resolveSetupLinkBaseUrl({ VERCEL_ENV: "production" })).toBe(PROD_ORIGIN);
    expect(resolveSetupLinkBaseUrl({ VERCEL_ENV: "production", NEXT_PUBLIC_APP_URL: ALT })).toBe(ALT);
    // Legacy override names keep precedence, but production still refuses loopback / non-https.
    expect(resolveSetupLinkBaseUrl({ VERCEL_ENV: "production", STAFFPASS_PUBLIC_ORIGIN: "http://127.0.0.1:3000" })).toBe(PROD_ORIGIN);
    expect(resolveSetupLinkBaseUrl({ VERCEL_ENV: "production", NEXT_PUBLIC_BASE_URL: ALT })).toBe(ALT);
  });

  test("LP checkout allowlist: app origin from resolveAppOrigin + canonical constant (no literal)", () => {
    const src = readFileSync(join(ROOT, "app/api/lp/ai-employee/checkout/route.ts"), "utf8");
    expect(src).toContain("resolveAppOrigin()");
    expect(src).not.toContain("https://staffpass.sealith.com");
  });
});

describe("no hardcoded app / MCP origin outside lib/app-url.ts (tests and docs excluded)", () => {
  const SKIP = new Set(["node_modules", ".next", ".git", "__fixtures__"]);
  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full, out);
      else if (/\.(ts|tsx|json)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
    }
    return out;
  }
  test("staffpass.sealith.com appears only in lib/app-url.ts (comments excluded)", () => {
    const files = [...walk(join(ROOT, "lib")), ...walk(join(ROOT, "app")), ...walk(join(ROOT, "components")), ...walk(join(ROOT, "public"))];
    const hits: string[] = [];
    for (const file of files) {
      const rel = relative(ROOT, file);
      if (rel === "lib/app-url.ts") continue;
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        const t = line.trim();
        if (t.startsWith("*") || t.startsWith("//") || t.startsWith("/*")) return;
        if (/staffpass\.sealith\.com/.test(line)) hits.push(`${rel}:${i + 1}`);
      });
    }
    expect(hits).toEqual([]);
  });
});

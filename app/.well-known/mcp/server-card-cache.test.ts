/**
 * #256 (木村 decision 2): the dynamic MCP server-card routes under /.well-known/mcp/ are
 * revalidated about once an hour (ISR, revalidate = 3600) and say so with a matching
 * Cache-Control. They no longer render on every request (force-dynamic removed).
 * Cards are config-derived (resolveAppOrigin), never request-derived, so caching is safe.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  SERVER_CARD_CACHE_CONTROL,
  SERVER_CARD_REVALIDATE_SECONDS,
  buildAdminServerCard,
  buildServerCard,
} from "@/lib/mcp/server-card";

const ALT = "https://card-cache.example.test";
const ROUTES = [
  { name: "server-card.json", path: "server-card.json/route.ts", build: buildServerCard },
  { name: "admin-server-card.json", path: "admin-server-card.json/route.ts", build: buildAdminServerCard },
] as const;

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved.NEXT_PUBLIC_APP_URL = process.env.NEXT_PUBLIC_APP_URL;
  process.env.NEXT_PUBLIC_APP_URL = ALT;
});
afterEach(() => {
  if (saved.NEXT_PUBLIC_APP_URL === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
  else process.env.NEXT_PUBLIC_APP_URL = saved.NEXT_PUBLIC_APP_URL;
});

async function load(path: string) {
  return (await import(`./${path}`)) as { GET: () => Promise<Response>; revalidate?: unknown; dynamic?: unknown; runtime?: unknown };
}

describe("server cards: revalidate 3600 + matching Cache-Control", () => {
  test("the shared constants: 3600 s, and Cache-Control max-age / s-maxage equal it", () => {
    expect(SERVER_CARD_REVALIDATE_SECONDS).toBe(3600);
    expect(SERVER_CARD_CACHE_CONTROL).toBe("public, max-age=3600, s-maxage=3600");
  });

  for (const r of ROUTES) {
    test(`${r.name}: exports revalidate = 3600 and is no longer force-dynamic`, async () => {
      const mod = await load(r.path);
      expect(mod.revalidate).toBe(3600);
      expect(mod.revalidate).toBe(SERVER_CARD_REVALIDATE_SECONDS);
      expect(mod.dynamic).not.toBe("force-dynamic");
      expect(mod.runtime).toBe("nodejs");
    });

    test(`${r.name}: revalidate is a static literal (Next.js segment config must be statically analyzable)`, () => {
      const src = readFileSync(fileURLToPath(new URL(`./${r.path}`, import.meta.url)), "utf8");
      expect(src).toMatch(/^export const revalidate = 3600;$/m);
      expect(src).not.toContain("force-dynamic");
    });

    test(`${r.name}: GET sends the matching Cache-Control and the same config-derived card`, async () => {
      const mod = await load(r.path);
      const res = await mod.GET();
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe(SERVER_CARD_CACHE_CONTROL);
      const maxAge = /(?:^|[ ,])max-age=(\d+)/.exec(res.headers.get("cache-control") || "")?.[1];
      const sMaxAge = /s-maxage=(\d+)/.exec(res.headers.get("cache-control") || "")?.[1];
      expect(Number(maxAge)).toBe(mod.revalidate as number);
      expect(Number(sMaxAge)).toBe(mod.revalidate as number);
      expect(res.headers.get("content-type") || "").toContain("application/json");
      expect(await res.json()).toEqual(r.build());
      expect(JSON.stringify(r.build())).toContain(ALT);
    });
  }
});

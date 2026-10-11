/**
 * LP cron secrets are compared in constant time (木村 2026-10-04).
 * Every app/api/cron/lp-* route checks CRON_SECRET through the shared helper
 * lib/security/cron-secret.ts (SHA-256 both sides + timingSafeEqual, no length
 * leak) instead of a local comparison, and a wrong, missing, different-length or
 * multi-byte secret gets exactly the same 401 response as before (no throw, no
 * 500, no different body). LP specifics kept via explicit helper options:
 * lp-inquiry-cleanup also accepts the raw secret (allowRawSecret), lp-handoff-
 * outbox also accepts the `x-cron-secret` header (rawSecretHeader), and both
 * keep the untrimmed CRON_SECRET (trimSecret: false) and their 401 bodies
 * (no 503) for unset / placeholder secrets.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { NextRequest } from "next/server";
import { GET as cleanupGET } from "./lp-inquiry-cleanup/route";
import { GET as outboxGET, POST as outboxPOST } from "./lp-handoff-outbox/route";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const CRON_DIR = join(ROOT, "app", "api", "cron");
const SECRET = "s3cret-value-0123456789";
const KEYS = ["CRON_SECRET", "LP_INQUIRY_CLEANUP_ENABLED", "LP_HANDOFF_ENABLED"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const req = (path: string, headers: Record<string, string> = {}) =>
  new NextRequest(`https://example.test/api/cron/${path}`, { headers });

/** wrong secrets: same length, shorter, longer, empty, multi-byte (same char length, more bytes), prefix */
const WRONG: Array<[string, Record<string, string>]> = [
  ["same length", { authorization: `Bearer ${SECRET.slice(0, -1)}X` }],
  ["shorter", { authorization: `Bearer ${SECRET.slice(0, 5)}` }],
  ["longer", { authorization: `Bearer ${SECRET}0` }],
  ["empty bearer", { authorization: "Bearer " }],
  ["multi-byte same char length", { authorization: `Bearer ${SECRET.slice(0, -1)}é` }],
  ["missing header", {}],
];

describe("LP cron routes: inventory and source", () => {
  const lpCrons = readdirSync(CRON_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith("lp-"))
    .map((e) => e.name)
    .sort();

  test("the LP crons are exactly these two (a new one must be added here)", () => {
    expect(lpCrons).toEqual(["lp-handoff-outbox", "lp-inquiry-cleanup"]);
  });

  test("each checks CRON_SECRET through the shared helper (no local comparison, no node:crypto)", () => {
    for (const name of lpCrons) {
      const text = readFileSync(join(CRON_DIR, name, "route.ts"), "utf8");
      expect(`${name}:${/import \{[^}]*\bcheckCronRequest\b[^}]*\} from "@\/lib\/security\/cron-secret"/.test(text)}`).toBe(`${name}:true`);
      expect(`${name}:${/\bcheckCronRequest\s*\(/.test(text)}`).toBe(`${name}:true`);
      expect(`${name}:${/trimSecret:\s*false/.test(text)}`).toBe(`${name}:true`);
      // the local comparisons from before the helper are gone
      expect(`${name}:${/from "node:crypto"/.test(text)}`).toBe(`${name}:false`);
      expect(`${name}:${/\b(?:secretsEqual|safeEqual|timingSafeEqual|createHash)\b/.test(text)}`).toBe(`${name}:false`);
      expect(`${name}:${/process\.env\.CRON_SECRET\b/.test(text)}`).toBe(`${name}:false`);
      // no direct comparison of the secret / token / header with ===, !==, == or !=
      expect(
        `${name}:${/(?:[!=]==?)\s*(?:cronSecret|secret|token|`Bearer)|(?:cronSecret|secret|token|authHeader)\s*[!=]==?(?!=)/.test(text)}`
      ).toBe(`${name}:false`);
    }
  });

  test("route-specific options: inquiry allows the raw secret, outbox keeps x-cron-secret", () => {
    const inquiry = readFileSync(join(CRON_DIR, "lp-inquiry-cleanup", "route.ts"), "utf8");
    const outbox = readFileSync(join(CRON_DIR, "lp-handoff-outbox", "route.ts"), "utf8");
    expect(inquiry).toMatch(/allowRawSecret:\s*true/);
    expect(inquiry).not.toMatch(/rawSecretHeader/);
    expect(outbox).toMatch(/rawSecretHeader:\s*"x-cron-secret"/);
    expect(outbox).not.toMatch(/allowRawSecret/);
  });
});

describe("lp-inquiry-cleanup: CRON_SECRET", () => {
  for (const [label, headers] of WRONG) {
    test(`${label} -> 401 {"error":"unauthorized"}`, async () => {
      process.env.CRON_SECRET = SECRET;
      const res = await cleanupGET(req("lp-inquiry-cleanup", headers));
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
    });
  }

  test("CRON_SECRET unset or a replace_me placeholder -> 401 even with a matching header", async () => {
    delete process.env.CRON_SECRET;
    let res = await cleanupGET(req("lp-inquiry-cleanup", { authorization: "Bearer " }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    process.env.CRON_SECRET = "replace_me_cron_secret";
    res = await cleanupGET(req("lp-inquiry-cleanup", { authorization: "Bearer replace_me_cron_secret" }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  test("correct secret passes the gate (flag off -> skipped, no DB access)", async () => {
    process.env.CRON_SECRET = SECRET;
    delete process.env.LP_INQUIRY_CLEANUP_ENABLED;
    const res = await cleanupGET(req("lp-inquiry-cleanup", { authorization: `Bearer ${SECRET}` }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      skipped: true,
      reason: "feature_flag_off",
      message: "LP_INQUIRY_CLEANUP_ENABLED is OFF",
    });
  });

  test("unchanged: the bare secret (no Bearer prefix) is still accepted", async () => {
    process.env.CRON_SECRET = SECRET;
    delete process.env.LP_INQUIRY_CLEANUP_ENABLED;
    const res = await cleanupGET(req("lp-inquiry-cleanup", { authorization: SECRET }));
    expect(res.status).toBe(200);
  });

  test("still 401: lowercase bearer, double space, Bearer twice, raw secret + suffix", async () => {
    process.env.CRON_SECRET = SECRET;
    for (const authorization of [`bearer ${SECRET}`, `Bearer  ${SECRET}`, `Bearer Bearer ${SECRET}`, `${SECRET}x`]) {
      const res = await cleanupGET(req("lp-inquiry-cleanup", { authorization }));
      expect(`${authorization}:${res.status}`).toBe(`${authorization}:401`);
      expect(await res.json()).toEqual({ error: "unauthorized" });
    }
  });

  test("stricter: `Bearer ` in the middle of the header no longer matches (old .replace quirk)", async () => {
    process.env.CRON_SECRET = SECRET;
    delete process.env.LP_INQUIRY_CLEANUP_ENABLED;
    for (const authorization of [`${SECRET.slice(0, 4)}Bearer ${SECRET.slice(4)}`, `${SECRET}Bearer `]) {
      const res = await cleanupGET(req("lp-inquiry-cleanup", { authorization }));
      expect(`${authorization}:${res.status}`).toBe(`${authorization}:401`);
      expect(await res.json()).toEqual({ error: "unauthorized" });
    }
  });

  test("unchanged: CRON_SECRET is not trimmed, so a padded secret matches nothing (401)", async () => {
    process.env.CRON_SECRET = ` ${SECRET} `;
    for (const authorization of [`Bearer ${SECRET}`, SECRET]) {
      const res = await cleanupGET(req("lp-inquiry-cleanup", { authorization }));
      expect(`${authorization}:${res.status}`).toBe(`${authorization}:401`);
      expect(await res.json()).toEqual({ error: "unauthorized" });
    }
  });

  test("unchanged: unset / placeholder -> 401 also for the raw form (never 503)", async () => {
    delete process.env.CRON_SECRET;
    let res = await cleanupGET(req("lp-inquiry-cleanup", { authorization: SECRET }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    process.env.CRON_SECRET = "replace_me_cron_secret";
    res = await cleanupGET(req("lp-inquiry-cleanup", { authorization: "replace_me_cron_secret" }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });
});

describe("lp-handoff-outbox: CRON_SECRET", () => {
  for (const [label, headers] of [
    ...WRONG,
    ["x-cron-secret wrong", { "x-cron-secret": `${SECRET}0` }] as [string, Record<string, string>],
    ["x-cron-secret multi-byte", { "x-cron-secret": `${SECRET.slice(0, -1)}é` }] as [string, Record<string, string>],
    ["x-cron-secret with Bearer prefix", { "x-cron-secret": `Bearer ${SECRET}` }] as [string, Record<string, string>],
    ["raw secret in Authorization", { authorization: SECRET }] as [string, Record<string, string>],
    ["lowercase bearer", { authorization: `bearer ${SECRET}` }] as [string, Record<string, string>],
  ]) {
    test(`${label} -> 401 {"error":"unauthorized"} (GET and POST)`, async () => {
      process.env.CRON_SECRET = SECRET;
      for (const handler of [outboxGET, outboxPOST]) {
        const res = await handler(req("lp-handoff-outbox", headers));
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: "unauthorized" });
      }
    });
  }

  test("CRON_SECRET unset -> 401 (never 503), GET and POST, either header form", async () => {
    delete process.env.CRON_SECRET;
    for (const handler of [outboxGET, outboxPOST]) {
      for (const headers of [{ authorization: "Bearer " }, { "x-cron-secret": "" }, {}] as Record<string, string>[]) {
        const res = await handler(req("lp-handoff-outbox", headers));
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: "unauthorized" });
      }
    }
  });

  test("stricter: a replace_me placeholder CRON_SECRET authenticates nothing (401), GET and POST", async () => {
    process.env.CRON_SECRET = "replace_me_cron_secret";
    delete process.env.LP_HANDOFF_ENABLED;
    for (const handler of [outboxGET, outboxPOST]) {
      for (const headers of [
        { authorization: "Bearer replace_me_cron_secret" },
        { "x-cron-secret": "replace_me_cron_secret" },
      ] as Record<string, string>[]) {
        const res = await handler(req("lp-handoff-outbox", headers));
        expect(`${JSON.stringify(headers)}:${res.status}`).toBe(`${JSON.stringify(headers)}:401`);
        expect(await res.json()).toEqual({ error: "unauthorized" });
      }
    }
  });

  test("stricter (both LP crons): a whitespace-led ` replace_me` CRON_SECRET is the placeholder too (401)", async () => {
    process.env.CRON_SECRET = " replace_me";
    delete process.env.LP_HANDOFF_ENABLED;
    delete process.env.LP_INQUIRY_CLEANUP_ENABLED;
    for (const headers of [{ authorization: "Bearer  replace_me" }, { "x-cron-secret": " replace_me" }] as Record<string, string>[]) {
      const res = await outboxPOST(req("lp-handoff-outbox", headers));
      expect(`${JSON.stringify(headers)}:${res.status}`).toBe(`${JSON.stringify(headers)}:401`);
      expect(await res.json()).toEqual({ error: "unauthorized" });
    }
    const res = await cleanupGET(req("lp-inquiry-cleanup", { authorization: "Bearer  replace_me" }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  test("unchanged: CRON_SECRET is not trimmed, so a padded secret matches nothing (401)", async () => {
    process.env.CRON_SECRET = ` ${SECRET} `;
    for (const headers of [{ authorization: `Bearer ${SECRET}` }, { "x-cron-secret": SECRET }] as Record<string, string>[]) {
      const res = await outboxPOST(req("lp-handoff-outbox", headers));
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
    }
  });

  test("correct secret (Bearer or x-cron-secret) passes the gate (flag off -> skipped)", async () => {
    process.env.CRON_SECRET = SECRET;
    delete process.env.LP_HANDOFF_ENABLED;
    const accepted: Record<string, string>[] = [{ authorization: `Bearer ${SECRET}` }, { "x-cron-secret": SECRET }];
    for (const handler of [outboxGET, outboxPOST]) {
      for (const headers of accepted) {
        const res = await handler(req("lp-handoff-outbox", headers));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ status: "skipped", reason: "feature_disabled" });
      }
    }
  });
});

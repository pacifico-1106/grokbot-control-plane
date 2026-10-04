/**
 * The five non-LP crons use the shared constant-time CRON_SECRET check
 * (lib/security/cron-secret.ts; 木村 2026-10-04 decision 3). Status codes and
 * bodies for wrong / missing / unset secrets are unchanged; a `replace_me…`
 * placeholder CRON_SECRET no longer authenticates anything (401).
 *
 * The LP crons (lp-inquiry-cleanup, lp-handoff-outbox) are deliberately not
 * covered here: PR #261 changes lp-inquiry-cleanup and they move to the helper
 * after it merges.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY ||= "test-notification-key-0123456789abcdef-cron";

const ROUTES = ["telegram-digest", "expire-trials", "stuck-watch-w1", "stuck-watch-w2", "decision-t2-expiry"] as const;
type Handler = (req: Request) => Promise<Response>;
const handlers: Record<string, Handler> = {
  "telegram-digest": (await import("@/app/api/cron/telegram-digest/route")).GET,
  "expire-trials": (await import("@/app/api/cron/expire-trials/route")).GET,
  "stuck-watch-w1": (await import("@/app/api/cron/stuck-watch-w1/route")).GET,
  "stuck-watch-w2": (await import("@/app/api/cron/stuck-watch-w2/route")).GET,
  "decision-t2-expiry": (await import("@/app/api/cron/decision-t2-expiry/route")).GET,
};

const SECRET = "s3cret-value-0123456789";
const saved = process.env.CRON_SECRET;
afterEach(() => {
  if (saved === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = saved;
});
const call = (name: string, headers: Record<string, string> = {}) =>
  handlers[name](new Request(`https://example.test/api/cron/${name}`, { headers }));
const src = (name: string) =>
  readFileSync(new URL(`../../app/api/cron/${name}/route.ts`, import.meta.url), "utf8");

const WRONG: Array<[string, Record<string, string>]> = [
  ["same length", { authorization: `Bearer ${SECRET.slice(0, -1)}X` }],
  ["shorter", { authorization: `Bearer ${SECRET.slice(0, 5)}` }],
  ["longer", { authorization: `Bearer ${SECRET}0` }],
  ["empty bearer", { authorization: "Bearer " }],
  ["multi-byte", { authorization: `Bearer ${SECRET.slice(0, -1)}é` }],
  ["raw secret without Bearer", { authorization: SECRET }],
  ["lowercase bearer", { authorization: `bearer ${SECRET}` }],
  ["missing header", {}],
];

describe("non-LP crons: source uses the shared helper", () => {
  for (const name of ROUTES) {
    test(`${name} imports rejectUnauthorizedCron and has no direct secret comparison`, () => {
      const text = src(name);
      expect(text).toMatch(/import \{[^}]*\brejectUnauthorizedCron\b[^}]*\} from "@\/lib\/security\/cron-secret"/);
      expect(text).toMatch(/rejectUnauthorizedCron\(req\)/);
      expect(text).not.toContain("process.env.CRON_SECRET");
      expect(text).not.toMatch(/[!=]==?\s*`Bearer/);
    });
  }
});

describe("non-LP crons: responses", () => {
  for (const name of ROUTES) {
    test(`${name}: CRON_SECRET unset -> 503 cron_not_configured (unchanged)`, async () => {
      delete process.env.CRON_SECRET;
      const res = await call(name, { authorization: `Bearer ${SECRET}` });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ ok: false, error: "cron_not_configured" });
    });

    for (const [label, headers] of WRONG) {
      test(`${name}: ${label} -> 401 unauthorized (unchanged)`, async () => {
        process.env.CRON_SECRET = SECRET;
        const res = await call(name, headers);
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ ok: false, error: "unauthorized" });
      });
    }

    test(`${name}: placeholder CRON_SECRET + matching Bearer placeholder -> 401 (new: placeholder never authenticates)`, async () => {
      process.env.CRON_SECRET = "replace_me_cron_secret";
      const res = await call(name, { authorization: "Bearer replace_me_cron_secret" });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ ok: false, error: "unauthorized" });
    });

    test(`${name}: exact Bearer secret passes the auth gate`, async () => {
      process.env.CRON_SECRET = SECRET;
      const res = await call(name, { authorization: `Bearer ${SECRET}` });
      expect(`${name}:${res.status}`).not.toBe(`${name}:401`);
      expect(`${name}:${res.status}`).not.toBe(`${name}:503`);
    });
  }
});

/**
 * Shared CRON_SECRET check (木村 2026-10-04, decisions 3 and 4).
 *
 * - Constant time without leaking the secret's length: SHA-256 both sides,
 *   then timingSafeEqual over the two 32-byte digests.
 * - `Authorization: Bearer <CRON_SECRET>` is required (exact, case-sensitive
 *   prefix), the same as the five non-LP crons already require today.
 * - CRON_SECRET unset/blank -> "not_configured" (route answers 503, unchanged).
 * - CRON_SECRET still the `replace_me…` placeholder -> nothing authenticates
 *   ("unauthorized", 401), even a request that presents the placeholder.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  checkCronAuthorization,
  cronSecretsEqual,
  readCronSecret,
  rejectUnauthorizedCron,
} from "./cron-secret";

const SECRET = "s3cret-value-0123456789";
const saved = process.env.CRON_SECRET;
afterEach(() => {
  if (saved === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = saved;
});

describe("cronSecretsEqual (SHA-256 both sides, then timingSafeEqual)", () => {
  test("equal strings match", () => {
    expect(cronSecretsEqual(`Bearer ${SECRET}`, `Bearer ${SECRET}`)).toBe(true);
  });
  test("same length / shorter / longer / empty / multi-byte do not match and never throw", () => {
    const expected = `Bearer ${SECRET}`;
    for (const presented of [
      `Bearer ${SECRET.slice(0, -1)}X`,
      `Bearer ${SECRET.slice(0, 5)}`,
      `Bearer ${SECRET}0`,
      "",
      `Bearer ${SECRET.slice(0, -1)}é`,
      `bearer ${SECRET}`,
      SECRET,
    ]) {
      expect(`${presented}:${cronSecretsEqual(presented, expected)}`).toBe(`${presented}:false`);
    }
  });
  test("source hashes both sides with sha256 and has no length short-circuit", () => {
    const text = readFileSync(new URL("./cron-secret.ts", import.meta.url), "utf8");
    expect(text).toMatch(/import \{[^}]*\bcreateHash\b[^}]*\} from "node:crypto"/);
    expect(text).toMatch(/import \{[^}]*\btimingSafeEqual\b[^}]*\} from "node:crypto"/);
    expect(text).toMatch(/createHash\("sha256"\)/);
    expect(text).toMatch(/timingSafeEqual\s*\(/);
    expect(text).not.toMatch(/\.length\s*!==|\.length\s*===/);
    expect(text).not.toMatch(/(?:[!=]==?)\s*`Bearer|(?:secret|presented|expected|authorization)\s*[!=]==(?!=)\s*(?:secret|presented|expected|authorization|`)/);
  });
});

describe("readCronSecret", () => {
  test("unset / blank -> unset", () => {
    delete process.env.CRON_SECRET;
    expect(readCronSecret()).toEqual({ state: "unset" });
    process.env.CRON_SECRET = "   ";
    expect(readCronSecret()).toEqual({ state: "unset" });
  });
  test("replace_me placeholder -> placeholder", () => {
    process.env.CRON_SECRET = "replace_me_cron_secret";
    expect(readCronSecret()).toEqual({ state: "placeholder" });
    process.env.CRON_SECRET = "  replace_me  ";
    expect(readCronSecret()).toEqual({ state: "placeholder" });
  });
  test("real value is trimmed (as the routes do today)", () => {
    process.env.CRON_SECRET = `  ${SECRET}\n`;
    expect(readCronSecret()).toEqual({ state: "set", secret: SECRET });
  });
});

describe("checkCronAuthorization", () => {
  test("exact `Bearer <secret>` -> ok", () => {
    process.env.CRON_SECRET = SECRET;
    expect(checkCronAuthorization(`Bearer ${SECRET}`)).toBe("ok");
  });
  test("trimmed secret is what is compared (as today)", () => {
    process.env.CRON_SECRET = ` ${SECRET} `;
    expect(checkCronAuthorization(`Bearer ${SECRET}`)).toBe("ok");
  });
  test("unset -> not_configured, whatever is presented", () => {
    delete process.env.CRON_SECRET;
    expect(checkCronAuthorization(null)).toBe("not_configured");
    expect(checkCronAuthorization("Bearer ")).toBe("not_configured");
  });
  test("placeholder -> unauthorized, even when the placeholder is presented", () => {
    process.env.CRON_SECRET = "replace_me_cron_secret";
    expect(checkCronAuthorization("Bearer replace_me_cron_secret")).toBe("unauthorized");
    expect(checkCronAuthorization("replace_me_cron_secret")).toBe("unauthorized");
    expect(checkCronAuthorization(null)).toBe("unauthorized");
  });
  test("wrong / missing / no Bearer / lowercase bearer / extra space -> unauthorized", () => {
    process.env.CRON_SECRET = SECRET;
    for (const h of [null, "", SECRET, `bearer ${SECRET}`, `Bearer  ${SECRET}`, `Bearer ${SECRET} `, `Bearer ${SECRET}x`, "Bearer wrong"]) {
      expect(`${h}:${checkCronAuthorization(h)}`).toBe(`${h}:unauthorized`);
    }
  });
});

describe("rejectUnauthorizedCron (same bodies/status codes as the routes return today)", () => {
  const req = (headers: Record<string, string> = {}) => new Request("https://example.test/api/cron/x", { headers });
  test("ok -> null (route continues)", () => {
    process.env.CRON_SECRET = SECRET;
    expect(rejectUnauthorizedCron(req({ authorization: `Bearer ${SECRET}` }))).toBeNull();
  });
  test("unset -> 503 cron_not_configured", async () => {
    delete process.env.CRON_SECRET;
    const res = rejectUnauthorizedCron(req({ authorization: `Bearer ${SECRET}` }));
    expect(res?.status).toBe(503);
    expect(await res?.json()).toEqual({ ok: false, error: "cron_not_configured" });
  });
  test("wrong / placeholder -> 401 unauthorized", async () => {
    process.env.CRON_SECRET = SECRET;
    const wrong = rejectUnauthorizedCron(req({ authorization: "Bearer nope" }));
    expect(wrong?.status).toBe(401);
    expect(await wrong?.json()).toEqual({ ok: false, error: "unauthorized" });
    process.env.CRON_SECRET = "replace_me";
    const ph = rejectUnauthorizedCron(req({ authorization: "Bearer replace_me" }));
    expect(ph?.status).toBe(401);
    expect(await ph?.json()).toEqual({ ok: false, error: "unauthorized" });
  });
});

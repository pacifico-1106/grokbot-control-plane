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
  checkCronRequest,
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

/**
 * Options for the LP crons (木村 2026-10-04, PR stacked on #264). Defaults are
 * unchanged, so the five non-LP crons above keep exact `Bearer <secret>`.
 */
describe("checkCronAuthorization options (LP crons)", () => {
  test("default still rejects the raw secret without `Bearer `", () => {
    process.env.CRON_SECRET = SECRET;
    expect(checkCronAuthorization(SECRET)).toBe("unauthorized");
    expect(checkCronAuthorization(SECRET, {})).toBe("unauthorized");
    expect(checkCronAuthorization(SECRET, { allowRawSecret: false })).toBe("unauthorized");
  });
  test("allowRawSecret: exact `Bearer <secret>` or exact raw secret -> ok", () => {
    process.env.CRON_SECRET = SECRET;
    expect(checkCronAuthorization(`Bearer ${SECRET}`, { allowRawSecret: true })).toBe("ok");
    expect(checkCronAuthorization(SECRET, { allowRawSecret: true })).toBe("ok");
  });
  test("allowRawSecret: anything else is still unauthorized (no prefix/substring match)", () => {
    process.env.CRON_SECRET = SECRET;
    for (const h of [
      null,
      "",
      "Bearer ",
      `bearer ${SECRET}`,
      `Bearer  ${SECRET}`,
      `${SECRET}x`,
      SECRET.slice(0, -1),
      `${SECRET.slice(0, -1)}é`,
      `${SECRET.slice(0, 4)}Bearer ${SECRET.slice(4)}`,
      `x Bearer ${SECRET}`,
      `Bearer Bearer ${SECRET}`,
    ]) {
      expect(`${h}:${checkCronAuthorization(h, { allowRawSecret: true })}`).toBe(`${h}:unauthorized`);
    }
  });
  test("allowRawSecret: unset -> not_configured, placeholder -> unauthorized (raw or Bearer)", () => {
    delete process.env.CRON_SECRET;
    expect(checkCronAuthorization(SECRET, { allowRawSecret: true })).toBe("not_configured");
    process.env.CRON_SECRET = "replace_me_cron_secret";
    expect(checkCronAuthorization("replace_me_cron_secret", { allowRawSecret: true })).toBe("unauthorized");
    expect(checkCronAuthorization("Bearer replace_me_cron_secret", { allowRawSecret: true })).toBe("unauthorized");
  });
  test("trimSecret: false compares the untrimmed CRON_SECRET (LP behaviour before the helper)", () => {
    process.env.CRON_SECRET = ` ${SECRET} `;
    expect(checkCronAuthorization(`Bearer ${SECRET}`, { trimSecret: false })).toBe("unauthorized");
    expect(checkCronAuthorization(SECRET, { trimSecret: false, allowRawSecret: true })).toBe("unauthorized");
    process.env.CRON_SECRET = SECRET;
    expect(checkCronAuthorization(`Bearer ${SECRET}`, { trimSecret: false })).toBe("ok");
  });
  test("trimSecret: false still treats blank as unset and a leading replace_me as placeholder", () => {
    process.env.CRON_SECRET = "   ";
    expect(readCronSecret({ trim: false })).toEqual({ state: "unset" });
    expect(checkCronAuthorization("Bearer    ", { trimSecret: false })).toBe("not_configured");
    process.env.CRON_SECRET = "replace_me ";
    expect(readCronSecret({ trim: false })).toEqual({ state: "placeholder" });
    process.env.CRON_SECRET = " replace_me";
    expect(readCronSecret({ trim: false })).toEqual({ state: "placeholder" });
    expect(checkCronAuthorization("Bearer  replace_me", { trimSecret: false, allowRawSecret: true })).toBe("unauthorized");
    expect(checkCronAuthorization(" replace_me", { trimSecret: false, allowRawSecret: true })).toBe("unauthorized");
    process.env.CRON_SECRET = ` ${SECRET}`;
    expect(readCronSecret({ trim: false })).toEqual({ state: "set", secret: ` ${SECRET}` });
  });
});

describe("checkCronRequest (Authorization + optional raw-secret header)", () => {
  const r = (headers: Record<string, string> = {}) => new Request("https://example.test/api/cron/x", { headers });
  test("without rawSecretHeader it is checkCronAuthorization on the Authorization header", () => {
    process.env.CRON_SECRET = SECRET;
    expect(checkCronRequest(r({ authorization: `Bearer ${SECRET}` }))).toBe("ok");
    expect(checkCronRequest(r({ "x-cron-secret": SECRET }))).toBe("unauthorized");
    expect(checkCronRequest(r({ authorization: SECRET }))).toBe("unauthorized");
    expect(checkCronRequest(r({ authorization: SECRET }), { allowRawSecret: true })).toBe("ok");
  });
  test("rawSecretHeader: exact raw secret in that header -> ok; Bearer in Authorization still ok", () => {
    process.env.CRON_SECRET = SECRET;
    const opts = { rawSecretHeader: "x-cron-secret" };
    expect(checkCronRequest(r({ "x-cron-secret": SECRET }), opts)).toBe("ok");
    expect(checkCronRequest(r({ authorization: `Bearer ${SECRET}` }), opts)).toBe("ok");
    expect(checkCronRequest(r({ authorization: "Bearer nope", "x-cron-secret": SECRET }), opts)).toBe("ok");
    expect(checkCronRequest(r({ authorization: `Bearer ${SECRET}`, "x-cron-secret": "nope" }), opts)).toBe("ok");
  });
  test("rawSecretHeader: wrong / Bearer-prefixed / empty value, raw secret in Authorization -> unauthorized", () => {
    process.env.CRON_SECRET = SECRET;
    const opts = { rawSecretHeader: "x-cron-secret" };
    for (const headers of [
      {},
      { "x-cron-secret": `${SECRET}0` },
      { "x-cron-secret": `Bearer ${SECRET}` },
      { "x-cron-secret": `${SECRET.slice(0, -1)}é` },
      { "x-cron-secret": "" },
      { authorization: SECRET },
    ] as Record<string, string>[]) {
      expect(`${JSON.stringify(headers)}:${checkCronRequest(r(headers), opts)}`).toBe(`${JSON.stringify(headers)}:unauthorized`);
    }
  });
  test("rawSecretHeader: unset -> not_configured, placeholder -> unauthorized", () => {
    const opts = { rawSecretHeader: "x-cron-secret" };
    delete process.env.CRON_SECRET;
    expect(checkCronRequest(r({ "x-cron-secret": "" }), opts)).toBe("not_configured");
    process.env.CRON_SECRET = "replace_me";
    expect(checkCronRequest(r({ "x-cron-secret": "replace_me" }), opts)).toBe("unauthorized");
    expect(checkCronRequest(r({ authorization: "Bearer replace_me" }), opts)).toBe("unauthorized");
  });
  test("source: every candidate is compared before the results are combined (no short-circuit on the secret)", () => {
    const text = readFileSync(new URL("./cron-secret.ts", import.meta.url), "utf8");
    // the comparisons are collected first, then reduced; no `cronSecretsEqual(...) ||` chains
    expect(text).not.toMatch(/cronSecretsEqual\([^)]*\)\s*(?:\|\||&&)/);
    expect(text).not.toMatch(/(?:\|\||&&)\s*cronSecretsEqual\(/);
  });
});

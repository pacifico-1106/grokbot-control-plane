/**
 * 木村 10/12 08:31 (#349 item 1): the release fresh-login check must use the auth time of
 * THIS session (signature-verified JWT amr[].timestamp), not auth.users.last_sign_in_at
 * (per user: a stolen old session would pass after the real user signs in elsewhere).
 * Only claims from getClaims() (verified) count; never a decoded-unverified token.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const auth = await import("@/lib/safety/hold-release-auth");
const now = new Date("2026-10-12T00:10:00Z");
const sec = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const claims = (o: Record<string, unknown>) => async () => ({ sub: "user_1", session_id: "sess_old", ...o });

describe("verifyReleaseAuthentication uses THIS session's verified auth time", () => {
  test("fresh amr timestamp (≤ 5 min) on a verified session → ok", async () => {
    const v = await auth.verifyReleaseAuthentication({ surface: "web", userId: "user_1" }, now,
      { getVerifiedClaims: claims({ amr: [{ method: "password", timestamp: sec("2026-10-12T00:07:00Z") }] }) });
    expect(v.ok).toBe(true);
  });

  test("old session + fresh sign-in on ANOTHER device (user.last_sign_in_at fresh) → refused", async () => {
    // this session authenticated 3 days ago; the user's last_sign_in_at (other device) is 1 minute ago
    const v = await auth.verifyReleaseAuthentication(
      { surface: "web", userId: "user_1", lastSignInAt: "2026-10-12T00:09:00Z" } as never, now,
      { getVerifiedClaims: claims({ amr: [{ method: "password", timestamp: sec("2026-10-09T00:00:00Z") }] }) });
    expect(v).toMatchObject({ ok: false, code: "fresh_login_required" });
  });

  test("a token refresh (new iat) does not advance the auth time", async () => {
    const v = await auth.verifyReleaseAuthentication({ surface: "web", userId: "user_1" }, now, {
      getVerifiedClaims: claims({ iat: sec("2026-10-12T00:09:30Z"), amr: [{ method: "password", timestamp: sec("2026-10-12T00:00:00Z") }] }),
    });
    expect(v).toMatchObject({ ok: false, code: "fresh_login_required" });
  });

  test("an unverified / forged JWT → refused (verifier returns nothing)", async () => {
    for (const getVerifiedClaims of [async () => null, async () => { throw new Error("invalid JWT signature"); }]) {
      const v = await auth.verifyReleaseAuthentication({ surface: "web", userId: "user_1" }, now, { getVerifiedClaims });
      expect(v).toMatchObject({ ok: false, code: "session_unverified", httpStatus: 401 });
    }
  });

  test("claims for another user, or no usable amr → refused", async () => {
    const fresh = [{ method: "password", timestamp: sec("2026-10-12T00:09:00Z") }];
    expect(await auth.verifyReleaseAuthentication({ surface: "web", userId: "user_1" }, now,
      { getVerifiedClaims: async () => ({ sub: "user_2", amr: fresh }) })).toMatchObject({ ok: false, code: "session_unverified" });
    expect(await auth.verifyReleaseAuthentication({ surface: "web", userId: null }, now,
      { getVerifiedClaims: claims({ amr: fresh }) })).toMatchObject({ ok: false, code: "session_unverified" });
    for (const amr of [undefined, [], ["password"], [{ method: "password" }], [{ method: "password", timestamp: "x" }]]) {
      expect(await auth.verifyReleaseAuthentication({ surface: "web", userId: "user_1" }, now,
        { getVerifiedClaims: claims({ amr, iat: sec("2026-10-12T00:09:59Z") }) })).toMatchObject({ ok: false, code: "fresh_login_required" });
    }
  });

  test("the newest amr entry counts (e.g. password long ago, MFA just now)", async () => {
    const v = await auth.verifyReleaseAuthentication({ surface: "web", userId: "user_1" }, now, {
      getVerifiedClaims: claims({ amr: [{ method: "password", timestamp: sec("2026-10-01T00:00:00Z") }, { method: "totp", timestamp: sec("2026-10-12T00:08:00Z") }] }),
    });
    expect(v.ok).toBe(true);
  });

  test("non-web surfaces stay refused before any claim is read", async () => {
    let read = 0;
    for (const surface of ["slack", "line", "telegram", "ops_console", "mcp"]) {
      const v = await auth.verifyReleaseAuthentication({ surface, userId: "user_1" }, now,
        { getVerifiedClaims: async () => { read++; return { sub: "user_1", amr: [{ method: "password", timestamp: sec("2026-10-12T00:09:00Z") }] }; } });
      expect(v).toMatchObject({ ok: false, code: "hold_release_web_only" });
    }
    expect(read).toBe(0);
  });

  test("the default verifier uses auth.getClaims() (verified) and never getSession() / a decoded token", async () => {
    let sessionCalls = 0;
    const forged = { auth: {
      getClaims: async () => ({ data: null, error: new Error("invalid signature") }),
      getSession: async () => { sessionCalls++; return { data: { session: { user: { id: "user_1" } } }, error: null }; },
    } };
    expect(await auth.verifiedClaimsFromClient(forged as never)).toBeNull();
    const good = { auth: { getClaims: async () => ({ data: { claims: { sub: "user_1", amr: [] } }, error: null }) } };
    expect(await auth.verifiedClaimsFromClient(good as never)).toMatchObject({ sub: "user_1" });
    expect(sessionCalls).toBe(0);
    const src = readFileSync(new URL("./hold-release-auth.ts", import.meta.url), "utf8");
    for (const banned of ["getSession(", "last_sign_in_at", "lastSignInAt", "atob(", "jwtDecode", "decodeJwt", "base64url"]) {
      expect(src.includes(banned)).toBe(false);
    }
  });
});

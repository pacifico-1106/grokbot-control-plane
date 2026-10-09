/**
 * #294 木村 22:13 (3): `redeemSetupLink` has no caller outside its own tests →
 * deleted, together with the hard-coded dev signing-secret fallback. Without
 * SETUP_LINK_SIGNING_SECRET the minter refuses (no link signed with a public
 * constant); guidance still works, just without a setupUrl.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import * as setupLinks from "@/lib/security/setup-links";

const ENV = "SETUP_LINK_SIGNING_SECRET";
const DEV_FALLBACK = ["staffpass", "setup", "link", "dev", "secret"].join("-");
let saved: string | undefined;

beforeEach(() => {
  saved = process.env[ENV];
});
afterEach(() => {
  if (saved === undefined) delete process.env[ENV];
  else process.env[ENV] = saved;
});

function decode(token: string): { payload: string; signature: string } {
  const [b64, signature] = token.split(".");
  return { payload: Buffer.from(b64, "base64url").toString("utf-8"), signature };
}

describe("redeemSetupLink and the dev-secret fallback are gone", () => {
  test("redeemSetupLink is no longer exported", () => {
    expect("redeemSetupLink" in setupLinks).toBe(false);
  });

  test("the source has no hard-coded fallback secret", () => {
    const src = readFileSync("lib/security/setup-links.ts", "utf8");
    expect(src).not.toContain(DEV_FALLBACK);
    expect(src).not.toMatch(/SETUP_LINK_SIGNING_SECRET\s*\|\|/);
    expect(src).not.toContain("redeemSetupLink");
  });
});

describe("no signing secret → refuse to mint", () => {
  for (const value of [undefined, "", "   "]) {
    test(`secret ${JSON.stringify(value)} → mintSetupLink throws setup_link_signing_secret_missing`, () => {
      if (value === undefined) delete process.env[ENV];
      else process.env[ENV] = value;
      let error: unknown = null;
      try {
        setupLinks.mintSetupLink({ kind: "org_kickoff", orgId: "org_a" });
      } catch (e) {
        error = e;
      }
      expect(error).not.toBeNull();
      expect((error as { code?: string }).code).toBe("setup_link_signing_secret_missing");
      expect(String((error as Error).message)).not.toContain(DEV_FALLBACK);
    });
  }

  test("a token signed with the old public fallback is never produced", () => {
    delete process.env[ENV];
    let minted: { token: string } | null = null;
    try {
      minted = setupLinks.mintSetupLink({ kind: "org_kickoff", orgId: "org_a" });
    } catch {
      minted = null;
    }
    if (minted) {
      const { payload, signature } = decode(minted.token);
      expect(signature).not.toBe(createHmac("sha256", DEV_FALLBACK).update(payload).digest("hex"));
    }
    expect(minted).toBeNull();
  });

  test("buildSetupGuidance(mintLink) without a secret → guidance only (no setupUrl), no throw", () => {
    delete process.env[ENV];
    const guidance = setupLinks.buildSetupGuidance("org_kickoff", { mintLink: true, orgId: "org_a" });
    expect(guidance.setupUrl).toBeUndefined();
    expect(guidance.expiresAt).toBeUndefined();
    expect(guidance.nextStepJa.length).toBeGreaterThan(10);
  });
});

describe("with a secret: signed with that secret, tenant-scoped", () => {
  test("signature = HMAC-SHA256(secret, payload); another secret does not match", () => {
    const secret = ["fixture", "setup", "secret", String(Date.now())].join("-");
    process.env[ENV] = secret;
    const link = setupLinks.mintSetupLink({ kind: "org_kickoff", orgId: "org_a" });
    const { payload, signature } = decode(link.token);
    expect(signature).toBe(createHmac("sha256", secret).update(payload).digest("hex"));
    expect(signature).not.toBe(createHmac("sha256", `${secret}x`).update(payload).digest("hex"));
    expect(JSON.parse(payload).orgId).toBe("org_a");
  });

  test("the secret is read at mint time (rotating the env takes effect without reload)", () => {
    process.env[ENV] = "fixture-secret-one";
    const a = decode(setupLinks.mintSetupLink({ kind: "org_kickoff", orgId: "org_a" }).token);
    process.env[ENV] = "fixture-secret-two";
    const b = decode(setupLinks.mintSetupLink({ kind: "org_kickoff", orgId: "org_a" }).token);
    expect(a.signature).toBe(createHmac("sha256", "fixture-secret-one").update(a.payload).digest("hex"));
    expect(b.signature).toBe(createHmac("sha256", "fixture-secret-two").update(b.payload).digest("hex"));
  });
});

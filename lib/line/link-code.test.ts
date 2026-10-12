import { afterEach, describe, expect, test } from "bun:test";
import {
  LINE_LINK_CODE_TTL_MS,
  consumeLineLinkCode,
  formatLineLinkCode,
  generateLineLinkCode,
  getPendingLineLinkCode,
  hashLineLinkCode,
  issueLineLinkCode,
  parseLineLinkCodeText,
  resetDemoLineLinkCodes,
  resolveLinkCodeSecret,
} from "./link-code";

afterEach(() => resetDemoLineLinkCodes());

const base = { orgId: "org-a", channelId: "chn-line-a", memberId: "mem_1", issuedByUserId: "user-1" };

describe("link code format", () => {
  test("8 symbols from an unambiguous alphabet, displayed with SP- prefix", () => {
    for (let i = 0; i < 50; i++) {
      const code = generateLineLinkCode();
      expect(code).toMatch(/^[2-9A-HJ-NP-Z]{8}$/);
      expect(formatLineLinkCode(code)).toBe(`SP-${code.slice(0, 4)}-${code.slice(4)}`);
    }
  });

  test("parses the code only when the whole message is the SP code", () => {
    expect(parseLineLinkCodeText("SP-ABCD-EFGH")).toBe("ABCDEFGH");
    expect(parseLineLinkCodeText("  sp abcd efgh \n")).toBe("ABCDEFGH");
    expect(parseLineLinkCodeText("SPABCDEFGH")).toBe("ABCDEFGH");
    expect(parseLineLinkCodeText("ＳＰ－ＡＢＣＤ－ＥＦＧＨ")).toBe("ABCDEFGH");
    // Not a code: revision notes, missing prefix, ambiguous symbols, extra text.
    expect(parseLineLinkCodeText("ABCDEFGH")).toBeNull();
    expect(parseLineLinkCodeText("SP-ABCD-EFG1")).toBeNull();
    expect(parseLineLinkCodeText("SP-ABCD-EFGH お願いします")).toBeNull();
    expect(parseLineLinkCodeText("件名を変更してください")).toBeNull();
    expect(parseLineLinkCodeText("")).toBeNull();
  });
});

describe("secret handling (fail-closed)", () => {
  test("production requires a real VOTER_BINDING_SECRET", () => {
    expect(() => resolveLinkCodeSecret(undefined, false)).toThrow();
    expect(() => resolveLinkCodeSecret("  ", false)).toThrow();
    expect(() => resolveLinkCodeSecret("dev-secret", false)).toThrow();
    expect(resolveLinkCodeSecret("s3cret-value", false)).toBe("s3cret-value");
    expect(resolveLinkCodeSecret(undefined, true)).toBe("dev-secret");
  });

  test("hash is keyed and never contains the code", () => {
    const h1 = hashLineLinkCode("ABCDEFGH", "k1");
    expect(h1).not.toContain("ABCDEFGH");
    expect(h1).not.toBe(hashLineLinkCode("ABCDEFGH", "k2"));
    expect(h1).toBe(hashLineLinkCode("ABCDEFGH", "k1"));
  });
});

describe("issue / consume (demo store)", () => {
  test("a code is consumed once, by the channel and org it was issued for", async () => {
    const issued = await issueLineLinkCode(base);
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    expect(issued.display).toBe(formatLineLinkCode(issued.code));

    const wrongChannel = await consumeLineLinkCode({ orgId: "org-a", channelId: "chn-other", code: issued.code, lineUserId: "U1" });
    expect(wrongChannel.ok).toBe(false);
    const wrongOrg = await consumeLineLinkCode({ orgId: "org-b", channelId: "chn-line-a", code: issued.code, lineUserId: "U1" });
    expect(wrongOrg.ok).toBe(false);

    const first = await consumeLineLinkCode({ orgId: "org-a", channelId: "chn-line-a", code: issued.code, lineUserId: "U1" });
    expect(first).toEqual({ ok: true, memberId: "mem_1", issuedByUserId: "user-1" });
    const replay = await consumeLineLinkCode({ orgId: "org-a", channelId: "chn-line-a", code: issued.code, lineUserId: "U2" });
    expect(replay.ok).toBe(false);
  });

  test("an unknown code is rejected", async () => {
    await issueLineLinkCode(base);
    const res = await consumeLineLinkCode({ orgId: "org-a", channelId: "chn-line-a", code: "ZZZZZZZZ", lineUserId: "U1" });
    expect(res).toEqual({ ok: false, reason: "invalid_or_expired" });
  });

  test("an expired code is rejected", async () => {
    const t0 = Date.now();
    const issued = await issueLineLinkCode({ ...base, now: t0 });
    if (!issued.ok) throw new Error("issue failed");
    const res = await consumeLineLinkCode({
      orgId: "org-a", channelId: "chn-line-a", code: issued.code, lineUserId: "U1", now: t0 + LINE_LINK_CODE_TTL_MS + 1,
    });
    expect(res.ok).toBe(false);
  });

  test("issuing a new code invalidates the member's previous code for that channel", async () => {
    const a = await issueLineLinkCode(base);
    const b = await issueLineLinkCode(base);
    if (!a.ok || !b.ok) throw new Error("issue failed");
    expect((await consumeLineLinkCode({ orgId: "org-a", channelId: "chn-line-a", code: a.code, lineUserId: "U1" })).ok).toBe(false);
    expect((await consumeLineLinkCode({ orgId: "org-a", channelId: "chn-line-a", code: b.code, lineUserId: "U1" })).ok).toBe(true);
  });

  test("pending status exposes only the expiry, never the code", async () => {
    expect(await getPendingLineLinkCode(base)).toBeNull();
    const issued = await issueLineLinkCode(base);
    if (!issued.ok) throw new Error("issue failed");
    const pending = await getPendingLineLinkCode(base);
    expect(pending).toEqual({ expiresAt: issued.expiresAt });
    expect(JSON.stringify(pending)).not.toContain(issued.code);
  });
});

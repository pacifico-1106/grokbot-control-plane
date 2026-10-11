import { describe, expect, test } from "bun:test";
// IP_HASH_KEY is required (no dev fallback); fixture key for this test process.
process.env.IP_HASH_KEY = "test-ip-hash-key-fixture-0123456789";
import { normalizeEmail, keyedHash } from "./email-normalize";
import { isDisposableDomain } from "./disposable-domains";

describe("normalizeEmail", () => {
  test("gmail dot-trick variants collapse to one mailbox", () => {
    const a = normalizeEmail("Sop.Uxap.E9.05@gmail.com")!;
    const b = normalizeEmail("sopuxape905+x@googlemail.com")!;
    expect(a.normalized).toBe("sopuxape905@gmail.com");
    expect(b.normalized).toBe("sopuxape905@gmail.com");
    expect(a.signals).toContain("gmail_dot_trick");
    expect(b.signals).toContain("plus_tag");
  });
  test("consecutive / edge dots flagged", () => {
    const signals = normalizeEmail("d.u.f.fi.n..hayde.n@gmail.com")!.signals;
    expect(signals).toContain("invalid_dots");
    expect(signals).toContain("gmail_dot_trick");
    expect(normalizeEmail(".a@example.com")!.signals).toContain("invalid_dots");
  });
  test("non-gmail keeps dots; corporate untouched", () => {
    expect(normalizeEmail("John.Kelly@Example.co.jp")!.normalized).toBe("john.kelly@example.co.jp");
    expect(normalizeEmail("john.kelly@example.co.jp")!.signals).toEqual([]);
  });
  test("invalid inputs", () => {
    expect(normalizeEmail("")).toBeNull();
    expect(normalizeEmail("a@")).toBeNull();
    expect(normalizeEmail("@b.com")).toBeNull();
    expect(normalizeEmail("a@localhost")).toBeNull();
  });
  test("disposable domains incl. subdomains", () => {
    expect(normalizeEmail("x@mailinator.com")!.signals).toContain("disposable_domain");
    expect(isDisposableDomain("in.yopmail.com")).toBe(true);
    expect(isDisposableDomain("gmail.com")).toBe(false);
    expect(isDisposableDomain("foo.example", new Set(["foo.example"]))).toBe(true);
  });
  test("keyed hash is stable hex and does not contain the input", () => {
    const h = keyedHash("em:sopuxape905@gmail.com");
    expect(h).toMatch(/^[0-9a-f]{32}$/);
    expect(h).toBe(keyedHash("em:sopuxape905@gmail.com"));
  });
});

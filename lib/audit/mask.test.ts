import { describe, expect, test } from "bun:test";
import { clipAuditText, extractEmail, maskEmail, opaqueAuditId, sanitizeAuditDisplayText } from "./mask";

describe("audit email mask", () => {
  test("masks local part and keeps domain", () => {
    expect(maskEmail("alice@example.com")).toBe("a***@example.com");
    expect(maskEmail("a@example.com")).toBe("*@example.com");
    expect(maskEmail("WEB:Bob@Example.com")).toBe("b***@example.com");
  });

  test("does not treat slack actor keys as email", () => {
    expect(maskEmail("slack:U0123ABC")).toBeNull();
    expect(extractEmail("slack:U0123ABC")).toBeNull();
  });

  test("sanitizes pollPath, statusToken, and emails in free text", () => {
    const dirty =
      "sent to alice@example.com pollPath=/api/approvals/status?id=x&token=SECRET statusToken=st_secret";
    const clean = sanitizeAuditDisplayText(dirty);
    expect(clean).toContain("a***@example.com");
    expect(clean).not.toContain("alice@example.com");
    expect(clean).not.toContain("SECRET");
    expect(clean).not.toContain("st_secret");
    expect(clean).not.toContain("/api/approvals/status");
    expect(clean).toContain("[redacted]");
  });

  test("clips with ellipsis", () => {
    expect(clipAuditText("short", 80)).toBe("short");
    expect(clipAuditText("abcdefghij", 8)).toBe("abcdefg…");
  });

  test("opaqueAuditId rejects emails, paths, and free text", () => {
    expect(opaqueAuditId("brand_new_code")).toBe("brand_new_code");
    expect(opaqueAuditId("apr_deadbeef")).toBe("apr_deadbeef");
    expect(opaqueAuditId("alice@example.com")).toBeNull();
    expect(opaqueAuditId("/api/approvals/status?id=x&token=SECRET")).toBeNull();
    expect(opaqueAuditId("sent to alice with token SECRET")).toBeNull();
  });
});

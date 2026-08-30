import { describe, expect, test } from "bun:test";
import { evaluateSod, isSendConfirmSodWarn, sodNeedsOperatorAck } from "./sod";

describe("separation of duties", () => {
  test("safe and one non-browser high-risk domain stay ok", () => {
    expect(evaluateSod(["mail:draft", "files:read"]).level).toBe("ok");
    expect(evaluateSod(["mail:send", "mail:draft"]).level).toBe("ok");
  });

  test("browser-only access warns and does not require operator ack", () => {
    const verdict = evaluateSod(["browser:use", "tools:read"]);
    expect(verdict.level).toBe("warn");
    expect(sodNeedsOperatorAck(verdict)).toBe(false);
  });

  test("mail.send + calendar.confirm is warn, not force_human", () => {
    const verdict = evaluateSod(["mail:send", "calendar:confirm", "slack:post"]);
    expect(verdict.level).toBe("warn");
    expect(verdict.domains).toEqual(["comm_external", "commit"]);
    expect(isSendConfirmSodWarn(verdict)).toBe(true);
    expect(sodNeedsOperatorAck(verdict)).toBe(true);
    expect(verdict.level === "warn" ? verdict.reason : "").toContain("責任は事業者");
  });

  test("two high-risk domains including money still force human approval", () => {
    const verdict = evaluateSod(["mail:send", "commerce:order"]);
    expect(verdict.level).toBe("force_human");
    expect(verdict.domains).toEqual(["comm_external", "money"]);
    expect(sodNeedsOperatorAck(verdict)).toBe(true);
  });

  test("send+confirm with browser still warn", () => {
    const verdict = evaluateSod(["mail:send", "calendar:confirm", "browser:use"]);
    expect(verdict.level).toBe("warn");
    expect(isSendConfirmSodWarn(verdict)).toBe(true);
    expect(sodNeedsOperatorAck(verdict)).toBe(true);
  });

  test("send + confirm + order stays force_human", () => {
    const verdict = evaluateSod(["mail:send", "calendar:confirm", "commerce:order"]);
    expect(verdict.level).toBe("force_human");
    expect(isSendConfirmSodWarn(verdict)).toBe(false);
  });
});

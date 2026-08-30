import { describe, expect, test } from "bun:test";
import {
  evaluateSod,
  isComboSodWarn,
  isSendConfirmSodWarn,
  sodNeedsOperatorAck,
  SOD_OPERATOR_RESPONSIBILITY_JA,
} from "./sod";

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

  test("money+commit, money+comm_external, destructive+money are warn", () => {
    const moneyCommit = evaluateSod(["commerce:order", "calendar:confirm"]);
    expect(moneyCommit.level).toBe("warn");
    expect(moneyCommit.domains).toEqual(["money", "commit"]);
    expect(sodNeedsOperatorAck(moneyCommit)).toBe(true);
    expect(moneyCommit.level === "warn" ? moneyCommit.reason : "").toBe(SOD_OPERATOR_RESPONSIBILITY_JA);

    const moneySend = evaluateSod(["mail:send", "commerce:order"]);
    expect(moneySend.level).toBe("warn");
    expect(moneySend.domains).toEqual(["comm_external", "money"]);
    expect(sodNeedsOperatorAck(moneySend)).toBe(true);

    const destructiveMoney = evaluateSod(["files:write", "commerce:order"]);
    expect(destructiveMoney.level).toBe("warn");
    expect(destructiveMoney.domains).toEqual(["destructive", "money"]);
    expect(sodNeedsOperatorAck(destructiveMoney)).toBe(true);
  });

  test("never returns force_human", () => {
    expect(evaluateSod(["mail:send", "commerce:order"]).level).not.toBe("force_human");
    expect(evaluateSod(["mail:send", "calendar:confirm", "commerce:order"]).level).toBe("warn");
    expect(evaluateSod(["files:write", "mail:send", "browser:use"]).level).toBe("warn");
  });

  test("send+confirm with browser still warn", () => {
    const verdict = evaluateSod(["mail:send", "calendar:confirm", "browser:use"]);
    expect(verdict.level).toBe("warn");
    expect(isSendConfirmSodWarn(verdict)).toBe(true);
    expect(sodNeedsOperatorAck(verdict)).toBe(true);
  });

  test("org policy can drop a domain so 2+ no longer warns", () => {
    const mixed = ["mail:send", "commerce:order"] as const;
    expect(evaluateSod([...mixed]).level).toBe("warn");
    expect(
      evaluateSod([...mixed], { domains: ["comm_external", "destructive", "commit"] }).level
    ).toBe("ok");
  });

  test("missing policy uses strict default; explicit empty domains skip combo warn", () => {
    expect(evaluateSod(["mail:send", "commerce:order"], null).level).toBe("warn");
    expect(evaluateSod(["mail:send", "commerce:order"], { domains: [] }).level).toBe("ok");
  });

  test("combo warn vs browser-only", () => {
    expect(isComboSodWarn(evaluateSod(["mail:send", "commerce:order"]))).toBe(true);
    expect(isComboSodWarn(evaluateSod(["browser:use"]))).toBe(false);
  });

  test("browser + another high-risk domain warns under default policy", () => {
    const verdict = evaluateSod(["browser:use", "mail:send"]);
    expect(verdict.level).toBe("warn");
    expect(sodNeedsOperatorAck(verdict)).toBe(true);
    const custom = evaluateSod(["browser:use", "mail:send"], { domains: ["money"] });
    expect(custom.level).toBe("ok");
  });
});

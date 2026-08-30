import { describe, expect, test } from "bun:test";
import { evaluateSod } from "./sod";
import { resolveApprovalPolicy, samePolicyFields, sodAckRequired, sodAckRequiredOnPatch } from "./sod-override";

const mixed = evaluateSod(["mail:send", "commerce:order"]);
const safe = evaluateSod(["mail:draft", "files:read"]);

describe("resolveApprovalPolicy", () => {
  test("force_human without ack stays always_human (fail-closed)", () => {
    expect(mixed.level).toBe("force_human");
    expect(
      resolveApprovalPolicy({ verdict: mixed, requested: "risk_based" })
    ).toBe("always_human");
    expect(
      resolveApprovalPolicy({
        verdict: mixed,
        requested: "auto",
        acknowledged: false,
      })
    ).toBe("always_human");
  });

  test("force_human with ack keeps the requested policy", () => {
    expect(
      resolveApprovalPolicy({
        verdict: mixed,
        requested: "risk_based",
        acknowledged: true,
      })
    ).toBe("risk_based");
    expect(
      resolveApprovalPolicy({
        verdict: mixed,
        requested: "auto",
        acknowledged: true,
      })
    ).toBe("auto");
    expect(
      resolveApprovalPolicy({
        verdict: mixed,
        requested: "always_human",
        acknowledged: true,
      })
    ).toBe("always_human");
  });

  test("ok / warn never rewrite the requested policy", () => {
    expect(safe.level).toBe("ok");
    expect(
      resolveApprovalPolicy({ verdict: safe, requested: "auto" })
    ).toBe("auto");
    expect(
      resolveApprovalPolicy({
        verdict: { level: "warn" },
        requested: "risk_based",
      })
    ).toBe("risk_based");
  });
});

describe("sodAckRequired", () => {
  test("send+confirm warn requires ack and never rewrites policy", () => {
    const combo = evaluateSod(["mail:send", "calendar:confirm"]);
    expect(combo.level).toBe("warn");
    expect(
      resolveApprovalPolicy({ verdict: combo, requested: "risk_based" })
    ).toBe("risk_based");
    expect(sodAckRequired({ verdict: combo, requested: "risk_based" })).toBe(true);
    expect(
      sodAckRequired({
        verdict: combo,
        requested: "risk_based",
        acknowledged: true,
      })
    ).toBe(false);
    expect(sodAckRequired({ verdict: combo, requested: "always_human" })).toBe(false);
    expect(
      sodAckRequired({ verdict: { level: "warn" }, requested: "risk_based" })
    ).toBe(false);
  });

  test("required only when mixed, not always_human, and no ack", () => {
    expect(
      sodAckRequired({ verdict: mixed, requested: "risk_based" })
    ).toBe(true);
    expect(
      sodAckRequired({
        verdict: mixed,
        requested: "always_human",
      })
    ).toBe(false);
    expect(
      sodAckRequired({
        verdict: mixed,
        requested: "risk_based",
        acknowledged: true,
      })
    ).toBe(false);
    expect(
      sodAckRequired({ verdict: safe, requested: "risk_based" })
    ).toBe(false);
  });
});

describe("samePolicyFields", () => {
  test("true when scopes match regardless of order and policy is unchanged", () => {
    expect(
      samePolicyFields(
        { scopes: ["mail:send", "commerce:order"], approvalPolicy: "risk_based" },
        { scopes: ["commerce:order", "mail:send"], approvalPolicy: "risk_based" }
      )
    ).toBe(true);
  });

  test("false when scopes or approvalPolicy differ", () => {
    expect(
      samePolicyFields(
        { scopes: ["mail:send"], approvalPolicy: "risk_based" },
        { scopes: ["mail:send", "commerce:order"], approvalPolicy: "risk_based" }
      )
    ).toBe(false);
    expect(
      samePolicyFields(
        { scopes: ["mail:send"], approvalPolicy: "risk_based" },
        { scopes: ["mail:send"], approvalPolicy: "always_human" }
      )
    ).toBe(false);
  });
});

describe("sodAckRequiredOnPatch", () => {
  const mixedScopes = ["mail:send", "commerce:order"] as const;

  test("unchanged manager-style patch does not require ack", () => {
    expect(
      sodAckRequiredOnPatch({
        existing: { scopes: [...mixedScopes], approvalPolicy: "risk_based" },
        posted: { scopes: ["commerce:order", "mail:send"], approvalPolicy: "risk_based" },
        verdict: mixed,
        acknowledged: false,
      })
    ).toBe(false);
  });

  test("changing scopes without ack still requires it", () => {
    expect(
      sodAckRequiredOnPatch({
        existing: { scopes: ["mail:send"], approvalPolicy: "risk_based" },
        posted: { scopes: [...mixedScopes], approvalPolicy: "risk_based" },
        verdict: mixed,
        acknowledged: false,
      })
    ).toBe(true);
  });

  test("changing approvalPolicy without ack still requires it", () => {
    expect(
      sodAckRequiredOnPatch({
        existing: { scopes: ["mail:send", "commerce:order"], approvalPolicy: "always_human" },
        posted: { scopes: ["mail:send", "commerce:order"], approvalPolicy: "risk_based" },
        verdict: mixed,
        acknowledged: false,
      })
    ).toBe(true);
  });
});

const sendConfirm = evaluateSod(["mail:send", "calendar:confirm", "slack:post"]);

describe("send+confirm warn does not rewrite policy", () => {
  test("evaluateSod is warn", () => {
    expect(sendConfirm.level).toBe("warn");
  });

  test("without ack still keeps requested risk_based (no silent always_human)", () => {
    expect(
      resolveApprovalPolicy({ verdict: sendConfirm, requested: "risk_based" })
    ).toBe("risk_based");
    expect(
      resolveApprovalPolicy({
        verdict: sendConfirm,
        requested: "auto",
        acknowledged: false,
      })
    ).toBe("auto");
  });

  test("with ack keeps requested policy", () => {
    expect(
      resolveApprovalPolicy({
        verdict: sendConfirm,
        requested: "risk_based",
        acknowledged: true,
      })
    ).toBe("risk_based");
  });

  test("sod_ack_required still blocks save until ack", () => {
    expect(
      sodAckRequired({ verdict: sendConfirm, requested: "risk_based" })
    ).toBe(true);
    expect(
      sodAckRequired({
        verdict: sendConfirm,
        requested: "risk_based",
        acknowledged: true,
      })
    ).toBe(false);
    expect(
      sodAckRequired({
        verdict: sendConfirm,
        requested: "always_human",
      })
    ).toBe(false);
  });
});

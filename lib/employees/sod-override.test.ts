import { describe, expect, test } from "bun:test";
import { evaluateSod } from "./sod";
import { resolveApprovalPolicy, sodAckRequired } from "./sod-override";

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

import { describe, expect, test } from "bun:test";
import {
  evaluateMouthRouting,
  extractInternalPartyIds,
  isInternalRoutingSafe,
  resolvePreferredMouth,
  shouldApplyMouthRouting,
  summarizeMouthRouting,
  defaultMouthRoutingPolicy,
} from "@/lib/gateway/mouth-routing";
import type { DualAudience, DualEgressVerdict } from "@/lib/types";

describe("resolvePreferredMouth", () => {
  test("returns first matching priority surface", () => {
    expect(resolvePreferredMouth(["line", "slack"], ["slack", "line"])).toBe("slack");
    expect(resolvePreferredMouth(["line", "mail"], ["slack", "line"])).toBe("line");
  });

  test("returns first available if no priority match", () => {
    expect(resolvePreferredMouth(["mail", "phone"], ["slack", "line"])).toBe("mail");
  });

  test("returns null for empty available", () => {
    expect(resolvePreferredMouth([], ["slack", "line"])).toBeNull();
  });

  test("uses default priority when not specified", () => {
    expect(resolvePreferredMouth(["slack", "line"])).toBe("slack");
    expect(resolvePreferredMouth(["line", "mail"])).toBe("line");
  });
});

describe("extractInternalPartyIds", () => {
  test("extracts resolved internal party identifiers", () => {
    const dualAudience: DualAudience = {
      internalFacing: "internal",
      externalFacing: "external",
      channelMixed: true,
      partySignals: [
        { kind: "slack_user", identifier: "U_INTERNAL_1", audience: "internal", resolved: true },
        { kind: "slack_user", identifier: "U_INTERNAL_2", audience: "internal", resolved: true },
        { kind: "slack_user", identifier: "U_EXTERNAL", audience: "external", resolved: true },
        { kind: "slack_user", identifier: "U_UNKNOWN", audience: "unknown", resolved: false },
      ],
      hasInternalParty: true,
      hasExternalParty: true,
    };

    const ids = extractInternalPartyIds(dualAudience);
    expect(ids).toEqual(["U_INTERNAL_1", "U_INTERNAL_2"]);
  });

  test("returns empty array when no internal parties", () => {
    const dualAudience: DualAudience = {
      internalFacing: "external",
      externalFacing: "external",
      channelMixed: true,
      partySignals: [
        { kind: "slack_user", identifier: "U_EXTERNAL", audience: "external", resolved: true },
      ],
      hasInternalParty: false,
      hasExternalParty: true,
    };

    expect(extractInternalPartyIds(dualAudience)).toEqual([]);
  });

  test("returns empty array for null dualAudience", () => {
    expect(extractInternalPartyIds(null)).toEqual([]);
  });
});

describe("isInternalRoutingSafe", () => {
  test("safe for non-mixed channels", () => {
    const dualAudience: DualAudience = {
      internalFacing: "internal",
      externalFacing: "internal",
      channelMixed: false,
      partySignals: [],
      hasInternalParty: true,
      hasExternalParty: false,
    };

    expect(isInternalRoutingSafe(dualAudience)).toEqual({ safe: true });
  });

  test("unsafe when external party present (fail-closed)", () => {
    const dualAudience: DualAudience = {
      internalFacing: "internal",
      externalFacing: "external",
      channelMixed: true,
      partySignals: [
        { kind: "slack_user", identifier: "U_INTERNAL", audience: "internal", resolved: true },
        { kind: "slack_user", identifier: "U_EXTERNAL", audience: "external", resolved: true },
      ],
      hasInternalParty: true,
      hasExternalParty: true,
    };

    const result = isInternalRoutingSafe(dualAudience);
    expect(result.safe).toBe(false);
    expect(result.reason).toBe("external_party_present");
  });

  test("unsafe when no internal party", () => {
    const dualAudience: DualAudience = {
      internalFacing: "external",
      externalFacing: "external",
      channelMixed: true,
      partySignals: [],
      hasInternalParty: false,
      hasExternalParty: false,
    };

    const result = isInternalRoutingSafe(dualAudience);
    expect(result.safe).toBe(false);
    expect(result.reason).toBe("no_internal_party");
  });

  test("unsafe for null dualAudience", () => {
    const result = isInternalRoutingSafe(null);
    expect(result.safe).toBe(false);
    expect(result.reason).toBe("no_dual_audience");
  });
});

describe("shouldApplyMouthRouting", () => {
  test("returns true when dual evaluated with differing decisions", () => {
    const dualEgress: DualEgressVerdict = {
      internalDecision: {
        decision: "allow",
        audience: "internal",
        effectiveAudience: "internal",
        informationClass: "internal",
        fidelity: "summary",
        namedRecipients: false,
        reason: "internal_internal_summary_allow",
        messageJa: "社内向けの社内情報です。開示できます。",
      },
      externalDecision: {
        decision: "summarize",
        audience: "external",
        effectiveAudience: "external",
        informationClass: "internal",
        fidelity: "summary",
        namedRecipients: false,
        reason: "external_internal_summary",
        messageJa: "社外向けのため社内情報は要約のみ開示します。",
      },
      dualEvaluated: true,
      effectiveDecision: {
        decision: "summarize",
        audience: "external",
        effectiveAudience: "external",
        informationClass: "internal",
        fidelity: "summary",
        namedRecipients: false,
        reason: "external_internal_summary",
        messageJa: "社外向けのため社内情報は要約のみ開示します。",
      },
    };

    expect(shouldApplyMouthRouting(dualEgress)).toBe(true);
  });

  test("returns false when not dual evaluated", () => {
    const dualEgress: DualEgressVerdict = {
      internalDecision: {
        decision: "allow",
        audience: "internal",
        effectiveAudience: "internal",
        informationClass: "public",
        fidelity: "source",
        namedRecipients: false,
        reason: "internal_public_allow",
        messageJa: "公開情報のため社内へ開示できます。",
      },
      externalDecision: {
        decision: "allow",
        audience: "internal",
        effectiveAudience: "internal",
        informationClass: "public",
        fidelity: "source",
        namedRecipients: false,
        reason: "internal_public_allow",
        messageJa: "公開情報のため社内へ開示できます。",
      },
      dualEvaluated: false,
      effectiveDecision: {
        decision: "allow",
        audience: "internal",
        effectiveAudience: "internal",
        informationClass: "public",
        fidelity: "source",
        namedRecipients: false,
        reason: "internal_public_allow",
        messageJa: "公開情報のため社内へ開示できます。",
      },
    };

    expect(shouldApplyMouthRouting(dualEgress)).toBe(false);
  });

  test("returns false when decisions are same", () => {
    const dualEgress: DualEgressVerdict = {
      internalDecision: {
        decision: "allow",
        audience: "external",
        effectiveAudience: "external",
        informationClass: "public",
        fidelity: "source",
        namedRecipients: false,
        reason: "external_public_allow",
        messageJa: "公開情報のため社外へ開示できます。",
      },
      externalDecision: {
        decision: "allow",
        audience: "external",
        effectiveAudience: "external",
        informationClass: "public",
        fidelity: "source",
        namedRecipients: false,
        reason: "external_public_allow",
        messageJa: "公開情報のため社外へ開示できます。",
      },
      dualEvaluated: true,
      effectiveDecision: {
        decision: "allow",
        audience: "external",
        effectiveAudience: "external",
        informationClass: "public",
        fidelity: "source",
        namedRecipients: false,
        reason: "external_public_allow",
        messageJa: "公開情報のため社外へ開示できます。",
      },
    };

    expect(shouldApplyMouthRouting(dualEgress)).toBe(false);
  });
});

describe("evaluateMouthRouting", () => {
  const mixedChannelDualAudience: DualAudience = {
    internalFacing: "internal",
    externalFacing: "external",
    channelMixed: true,
    partySignals: [
      { kind: "slack_user", identifier: "U_INTERNAL", audience: "internal", resolved: true },
      { kind: "slack_user", identifier: "U_EXTERNAL", audience: "external", resolved: true },
    ],
    hasInternalParty: true,
    hasExternalParty: true,
  };

  const internalOnlyDualAudience: DualAudience = {
    internalFacing: "internal",
    externalFacing: "internal",
    channelMixed: true,
    partySignals: [
      { kind: "slack_user", identifier: "U_INTERNAL_1", audience: "internal", resolved: true },
      { kind: "slack_user", identifier: "U_INTERNAL_2", audience: "internal", resolved: true },
    ],
    hasInternalParty: true,
    hasExternalParty: false,
  };

  test("split delivery when internal allows and external summarizes", () => {
    const dualEgress: DualEgressVerdict = {
      internalDecision: {
        decision: "allow",
        audience: "internal",
        effectiveAudience: "internal",
        informationClass: "internal",
        fidelity: "summary",
        namedRecipients: false,
        reason: "internal_internal_summary_allow",
        messageJa: "社内向けの社内情報です。",
      },
      externalDecision: {
        decision: "summarize",
        audience: "external",
        effectiveAudience: "external",
        informationClass: "internal",
        fidelity: "summary",
        namedRecipients: false,
        reason: "external_internal_summary",
        messageJa: "社外向けのため要約のみ。",
      },
      dualEvaluated: true,
      effectiveDecision: {
        decision: "summarize",
        audience: "external",
        effectiveAudience: "external",
        informationClass: "internal",
        fidelity: "summary",
        namedRecipients: false,
        reason: "external_internal_summary",
        messageJa: "社外向けのため要約のみ。",
      },
    };

    const result = evaluateMouthRouting({
      dualEgress,
      dualAudience: internalOnlyDualAudience,
    });

    expect(result.channelRoute).not.toBeNull();
    expect(result.channelRoute?.path.kind).toBe("channel");
    expect(result.channelRoute?.contentVariant).toBe("summary_only");
    expect(result.channelRoute?.audience).toBe("external");

    expect(result.internalRoute).not.toBeNull();
    expect(result.internalRoute?.path.kind).toBe("dm");
    expect(result.internalRoute?.contentVariant).toBe("external_safe");
    expect(result.internalRoute?.audience).toBe("internal");

    expect(result.splitDelivery).toBe(true);
    expect(result.internalHeld).toBe(false);
  });

  test("internal held when external party present (fail-closed)", () => {
    const dualEgress: DualEgressVerdict = {
      internalDecision: {
        decision: "allow",
        audience: "internal",
        effectiveAudience: "internal",
        informationClass: "internal",
        fidelity: "summary",
        namedRecipients: false,
        reason: "internal_internal_summary_allow",
        messageJa: "社内向けの社内情報です。",
      },
      externalDecision: {
        decision: "summarize",
        audience: "external",
        effectiveAudience: "external",
        informationClass: "internal",
        fidelity: "summary",
        namedRecipients: false,
        reason: "external_internal_summary",
        messageJa: "社外向けのため要約のみ。",
      },
      dualEvaluated: true,
      effectiveDecision: {
        decision: "summarize",
        audience: "external",
        effectiveAudience: "external",
        informationClass: "internal",
        fidelity: "summary",
        namedRecipients: false,
        reason: "external_internal_summary",
        messageJa: "社外向けのため要約のみ。",
      },
    };

    const result = evaluateMouthRouting({
      dualEgress,
      dualAudience: mixedChannelDualAudience,
    });

    expect(result.channelRoute).not.toBeNull();
    expect(result.internalRoute?.path.kind).toBe("hold_approval");
    expect(result.internalHeld).toBe(true);
    expect(result.holdReason).toBe("external_party_present");
  });

  test("no internal route when decisions are same", () => {
    const dualEgress: DualEgressVerdict = {
      internalDecision: {
        decision: "allow",
        audience: "external",
        effectiveAudience: "external",
        informationClass: "public",
        fidelity: "source",
        namedRecipients: false,
        reason: "external_public_allow",
        messageJa: "公開情報のため社外へ開示できます。",
      },
      externalDecision: {
        decision: "allow",
        audience: "external",
        effectiveAudience: "external",
        informationClass: "public",
        fidelity: "source",
        namedRecipients: false,
        reason: "external_public_allow",
        messageJa: "公開情報のため社外へ開示できます。",
      },
      dualEvaluated: true,
      effectiveDecision: {
        decision: "allow",
        audience: "external",
        effectiveAudience: "external",
        informationClass: "public",
        fidelity: "source",
        namedRecipients: false,
        reason: "external_public_allow",
        messageJa: "公開情報のため社外へ開示できます。",
      },
    };

    const result = evaluateMouthRouting({
      dualEgress,
      dualAudience: mixedChannelDualAudience,
    });

    expect(result.channelRoute).not.toBeNull();
    expect(result.internalRoute).toBeNull();
    expect(result.splitDelivery).toBe(false);
  });

  test("channel route null when effective decision is deny", () => {
    const dualEgress: DualEgressVerdict = {
      internalDecision: {
        decision: "needs_approval",
        audience: "internal",
        effectiveAudience: "internal",
        informationClass: "confidential",
        fidelity: "summary",
        namedRecipients: false,
        reason: "internal_confidential_summary",
        messageJa: "機密情報の社内開示には上長承認が必要です。",
      },
      externalDecision: {
        decision: "deny",
        audience: "external",
        effectiveAudience: "external",
        informationClass: "confidential",
        fidelity: "summary",
        namedRecipients: false,
        reason: "external_confidential_denied",
        messageJa: "機密情報の社外開示は拒否しました。",
      },
      dualEvaluated: true,
      effectiveDecision: {
        decision: "deny",
        audience: "external",
        effectiveAudience: "external",
        informationClass: "confidential",
        fidelity: "summary",
        namedRecipients: false,
        reason: "external_confidential_denied",
        messageJa: "機密情報の社外開示は拒否しました。",
      },
    };

    const result = evaluateMouthRouting({
      dualEgress,
      dualAudience: internalOnlyDualAudience,
    });

    expect(result.channelRoute).toBeNull();
    expect(result.internalRoute).not.toBeNull();
    expect(result.internalRoute?.path.kind).toBe("hold_approval");
  });

  test("uses thread path when threadId provided and preferDmForInternal is false", () => {
    const dualEgress: DualEgressVerdict = {
      internalDecision: {
        decision: "allow",
        audience: "internal",
        effectiveAudience: "internal",
        informationClass: "internal",
        fidelity: "summary",
        namedRecipients: false,
        reason: "internal_internal_summary_allow",
        messageJa: "社内向けの社内情報です。",
      },
      externalDecision: {
        decision: "summarize",
        audience: "external",
        effectiveAudience: "external",
        informationClass: "internal",
        fidelity: "summary",
        namedRecipients: false,
        reason: "external_internal_summary",
        messageJa: "社外向けのため要約のみ。",
      },
      dualEvaluated: true,
      effectiveDecision: {
        decision: "summarize",
        audience: "external",
        effectiveAudience: "external",
        informationClass: "internal",
        fidelity: "summary",
        namedRecipients: false,
        reason: "external_internal_summary",
        messageJa: "社外向けのため要約のみ。",
      },
    };

    const policy = defaultMouthRoutingPolicy();
    policy.rules[0].preferDmForInternal = false;

    const result = evaluateMouthRouting({
      dualEgress,
      dualAudience: internalOnlyDualAudience,
      policy,
      threadId: "1234567890.123456",
    });

    expect(result.internalRoute?.path.kind).toBe("limited_thread");
    if (result.internalRoute?.path.kind === "limited_thread") {
      expect(result.internalRoute.path.parentThreadId).toBe("1234567890.123456");
    }
  });
});

describe("summarizeMouthRouting", () => {
  test("summarizes channel-only routing", () => {
    const decision = evaluateMouthRouting({
      dualEgress: {
        internalDecision: {
          decision: "allow",
          audience: "external",
          effectiveAudience: "external",
          informationClass: "public",
          fidelity: "source",
          namedRecipients: false,
          reason: "external_public_allow",
          messageJa: "公開情報。",
        },
        externalDecision: {
          decision: "allow",
          audience: "external",
          effectiveAudience: "external",
          informationClass: "public",
          fidelity: "source",
          namedRecipients: false,
          reason: "external_public_allow",
          messageJa: "公開情報。",
        },
        dualEvaluated: false,
        effectiveDecision: {
          decision: "allow",
          audience: "external",
          effectiveAudience: "external",
          informationClass: "public",
          fidelity: "source",
          namedRecipients: false,
          reason: "external_public_allow",
          messageJa: "公開情報。",
        },
      },
      dualAudience: null,
    });

    const summary = summarizeMouthRouting(decision);
    expect(summary).toContain("channel:");
    expect(summary).not.toContain("dm:");
  });

  test("summarizes split delivery", () => {
    const dualAudience: DualAudience = {
      internalFacing: "internal",
      externalFacing: "internal",
      channelMixed: true,
      partySignals: [
        { kind: "slack_user", identifier: "U_INTERNAL", audience: "internal", resolved: true },
      ],
      hasInternalParty: true,
      hasExternalParty: false,
    };

    const decision = evaluateMouthRouting({
      dualEgress: {
        internalDecision: {
          decision: "allow",
          audience: "internal",
          effectiveAudience: "internal",
          informationClass: "internal",
          fidelity: "summary",
          namedRecipients: false,
          reason: "internal_internal_summary_allow",
          messageJa: "社内情報。",
        },
        externalDecision: {
          decision: "summarize",
          audience: "external",
          effectiveAudience: "external",
          informationClass: "internal",
          fidelity: "summary",
          namedRecipients: false,
          reason: "external_internal_summary",
          messageJa: "要約のみ。",
        },
        dualEvaluated: true,
        effectiveDecision: {
          decision: "summarize",
          audience: "external",
          effectiveAudience: "external",
          informationClass: "internal",
          fidelity: "summary",
          namedRecipients: false,
          reason: "external_internal_summary",
          messageJa: "要約のみ。",
        },
      },
      dualAudience,
    });

    const summary = summarizeMouthRouting(decision);
    expect(summary).toContain("channel:");
    expect(summary).toContain("dm:");
    expect(summary).toContain("split:true");
  });
});

describe("defaultMouthRoutingPolicy", () => {
  test("creates valid default policy", () => {
    const policy = defaultMouthRoutingPolicy();

    expect(policy.version).toBe(1);
    expect(policy.policyId).toBeTruthy();
    expect(policy.rules.length).toBeGreaterThan(0);
    expect(policy.rules[0].preferDmForInternal).toBe(true);
    expect(policy.rules[0].holdOnUnknownInternal).toBe(true);
    expect(policy.defaultMouthPriority).toEqual(["slack", "line"]);
  });
});

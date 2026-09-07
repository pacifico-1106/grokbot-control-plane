import { describe, expect, test } from "bun:test";
import { dualDecisionsDiffer, evaluateDualEgress, evaluateEgressMatrix } from "@/lib/gateway/egress";
import { resolveInformationDisclosure } from "@/lib/gateway/information-class";
import { DEMO_ORG } from "@/lib/demo-data";
import type { DualAudience } from "@/lib/types";

describe("egress matrix", () => {
  test("external × public → allow", () => {
    expect(
      evaluateEgressMatrix({
        audience: "external",
        informationClass: "public",
        fidelity: "source",
        namedRecipients: true,
      }).decision
    ).toBe("allow");
  });

  test("external × internal + summary → summarize; source → deny", () => {
    expect(
      evaluateEgressMatrix({
        audience: "external",
        informationClass: "internal",
        fidelity: "summary",
        namedRecipients: false,
      }).decision
    ).toBe("summarize");
    expect(
      evaluateEgressMatrix({
        audience: "external",
        informationClass: "internal",
        fidelity: "source",
        namedRecipients: false,
      }).decision
    ).toBe("deny");
  });

  test("external × confidential or verbatim → deny", () => {
    expect(
      evaluateEgressMatrix({
        audience: "unknown",
        informationClass: "confidential",
        fidelity: "summary",
        namedRecipients: false,
      }).decision
    ).toBe("deny");
    expect(
      evaluateEgressMatrix({
        audience: "external",
        informationClass: "verbatim",
        fidelity: "source",
        namedRecipients: true,
      }).decision
    ).toBe("deny");
  });

  test("internal × public or internal summary → allow", () => {
    expect(
      evaluateEgressMatrix({
        audience: "internal",
        informationClass: "public",
        fidelity: "source",
        namedRecipients: false,
      }).decision
    ).toBe("allow");
    expect(
      evaluateEgressMatrix({
        audience: "internal",
        informationClass: "internal",
        fidelity: "summary",
        namedRecipients: false,
      }).decision
    ).toBe("allow");
  });

  test("internal × confidential summary → needs_approval", () => {
    expect(
      evaluateEgressMatrix({
        audience: "internal",
        informationClass: "confidential",
        fidelity: "summary",
        namedRecipients: false,
      }).decision
    ).toBe("needs_approval");
  });

  test("internal × verbatim unnamed deny; named needs_approval", () => {
    expect(
      evaluateEgressMatrix({
        audience: "internal",
        informationClass: "verbatim",
        fidelity: "source",
        namedRecipients: false,
      }).decision
    ).toBe("deny");
    expect(
      evaluateEgressMatrix({
        audience: "internal",
        informationClass: "verbatim",
        fidelity: "source",
        namedRecipients: true,
      }).decision
    ).toBe("needs_approval");
  });
});

describe("information class defaults", () => {
  test("unclassified asset → confidential", async () => {
    const result = await resolveInformationDisclosure({
      orgId: DEMO_ORG.id,
      tool: "knowledge.search",
      body: {
        tool: "knowledge.search",
        purpose: "knowledge.lookup",
        jobId: "job_asset",
        args: { assetRef: "kb/does-not-exist" },
      },
    });
    expect(result.informationClass).toBe("confidential");
  });

  test("tagged public asset is public", async () => {
    const result = await resolveInformationDisclosure({
      orgId: DEMO_ORG.id,
      tool: "knowledge.search",
      body: {
        tool: "knowledge.search",
        purpose: "knowledge.lookup",
        jobId: "job_faq",
        args: { assetRef: "kb/public-faq" },
      },
    });
    expect(result.informationClass).toBe("public");
  });

  test("claiming public cannot lower confidential default", async () => {
    const result = await resolveInformationDisclosure({
      orgId: DEMO_ORG.id,
      tool: "comm.send",
      body: {
        tool: "comm.send",
        purpose: "comm.internal",
        jobId: "job_claim",
        informationClass: "public",
        args: { informationClass: "public" },
      },
    });
    expect(result.informationClass).toBe("confidential");
  });

  test("calendar.read busy/free defaults to internal summary", async () => {
    const result = await resolveInformationDisclosure({
      orgId: DEMO_ORG.id,
      tool: "calendar.read",
      body: { tool: "calendar.read", purpose: "comm.internal", jobId: "job_cal" },
    });
    expect(result.informationClass).toBe("internal");
    expect(result.fidelity).toBe("summary");
  });

  test("comm.reply / slack.post to internal default to internal summary", async () => {
    for (const tool of ["comm.reply", "slack.post"] as const) {
      const result = await resolveInformationDisclosure({
        orgId: DEMO_ORG.id,
        tool,
        audience: "internal",
        body: { tool, purpose: "comm.internal", jobId: `job_${tool}` },
      });
      expect(result.informationClass).toBe("internal");
      expect(result.fidelity).toBe("summary");
    }
  });

  test("comm.reply to external or unknown stays confidential source", async () => {
    for (const audience of ["external", "unknown"] as const) {
      const result = await resolveInformationDisclosure({
        orgId: DEMO_ORG.id,
        tool: "comm.reply",
        audience,
        body: { tool: "comm.reply", purpose: "comm.internal", jobId: "job_ext" },
      });
      expect(result.informationClass).toBe("confidential");
      expect(result.fidelity).toBe("source");
    }
  });

  test("mail.send / calendar.confirm / commerce.order stay confidential even internally", async () => {
    for (const tool of ["mail.send", "calendar.confirm", "commerce.order"] as const) {
      const result = await resolveInformationDisclosure({
        orgId: DEMO_ORG.id,
        tool,
        audience: "internal",
        body: { tool, purpose: "ops.admin", jobId: `job_${tool}` },
      });
      expect(result.informationClass).toBe("confidential");
      expect(result.fidelity).toBe("source");
    }
  });

  test("explicit confidential still raises the internal default", async () => {
    const result = await resolveInformationDisclosure({
      orgId: DEMO_ORG.id,
      tool: "comm.reply",
      audience: "internal",
      body: {
        tool: "comm.reply",
        purpose: "comm.internal",
        jobId: "job_raise",
        informationClass: "confidential",
      },
    });
    expect(result.informationClass).toBe("confidential");
  });
});

describe("S2 dual egress evaluation", () => {
  const mixedChannelDual: DualAudience = {
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

  const pureInternalDual: DualAudience = {
    internalFacing: "internal",
    externalFacing: "internal",
    channelMixed: false,
    partySignals: [
      { kind: "slack_user", identifier: "U_INTERNAL", audience: "internal", resolved: true },
    ],
    hasInternalParty: true,
    hasExternalParty: false,
  };

  test("mixed channel with internal + external party → two distinct decisions (internal + confidential)", () => {
    const result = evaluateDualEgress({
      audience: "external",
      dualAudience: mixedChannelDual,
      informationClass: "confidential",
      fidelity: "summary",
      namedRecipients: false,
    });

    expect(result.dualEvaluated).toBe(true);
    expect(result.internalDecision.decision).toBe("needs_approval");
    expect(result.internalDecision.effectiveAudience).toBe("internal");
    expect(result.externalDecision.decision).toBe("deny");
    expect(result.externalDecision.effectiveAudience).toBe("external");
    expect(result.effectiveDecision.decision).toBe("deny");
  });

  test("mixed channel with public info → both allow, but recorded separately", () => {
    const result = evaluateDualEgress({
      audience: "external",
      dualAudience: mixedChannelDual,
      informationClass: "public",
      fidelity: "source",
      namedRecipients: false,
    });

    expect(result.dualEvaluated).toBe(true);
    expect(result.internalDecision.decision).toBe("allow");
    expect(result.externalDecision.decision).toBe("allow");
    expect(result.effectiveDecision.decision).toBe("allow");
    expect(dualDecisionsDiffer(result)).toBe(false);
  });

  test("mixed channel with internal info → internal allow, external summarize", () => {
    const result = evaluateDualEgress({
      audience: "external",
      dualAudience: mixedChannelDual,
      informationClass: "internal",
      fidelity: "summary",
      namedRecipients: false,
    });

    expect(result.dualEvaluated).toBe(true);
    expect(result.internalDecision.decision).toBe("allow");
    expect(result.externalDecision.decision).toBe("summarize");
    expect(result.effectiveDecision.decision).toBe("summarize");
    expect(dualDecisionsDiffer(result)).toBe(true);
  });

  test("pure internal channel → single path, dualEvaluated=false", () => {
    const result = evaluateDualEgress({
      audience: "internal",
      dualAudience: pureInternalDual,
      informationClass: "confidential",
      fidelity: "summary",
      namedRecipients: false,
    });

    expect(result.dualEvaluated).toBe(false);
    expect(result.internalDecision.decision).toBe("needs_approval");
    expect(result.externalDecision.decision).toBe("needs_approval");
    expect(result.effectiveDecision.decision).toBe("needs_approval");
    expect(dualDecisionsDiffer(result)).toBe(false);
  });

  test("null dualAudience → single path fallback", () => {
    const result = evaluateDualEgress({
      audience: "external",
      dualAudience: null,
      informationClass: "confidential",
      fidelity: "summary",
      namedRecipients: false,
    });

    expect(result.dualEvaluated).toBe(false);
    expect(result.effectiveDecision.decision).toBe("deny");
  });

  test("unknown party in mixed channel → fail-closed external", () => {
    const unknownDual: DualAudience = {
      internalFacing: "external",
      externalFacing: "external",
      channelMixed: true,
      partySignals: [
        { kind: "slack_user", identifier: "U_UNKNOWN", audience: "unknown", resolved: false },
      ],
      hasInternalParty: false,
      hasExternalParty: true,
    };

    const result = evaluateDualEgress({
      audience: "external",
      dualAudience: unknownDual,
      informationClass: "confidential",
      fidelity: "summary",
      namedRecipients: false,
    });

    expect(result.dualEvaluated).toBe(true);
    expect(result.internalDecision.effectiveAudience).toBe("external");
    expect(result.externalDecision.effectiveAudience).toBe("external");
    expect(result.effectiveDecision.decision).toBe("deny");
  });

  test("effectiveDecision always uses external-facing path for channel posts", () => {
    const result = evaluateDualEgress({
      audience: "external",
      dualAudience: mixedChannelDual,
      informationClass: "internal",
      fidelity: "source",
      namedRecipients: false,
    });

    expect(result.dualEvaluated).toBe(true);
    expect(result.internalDecision.decision).toBe("allow");
    expect(result.externalDecision.decision).toBe("deny");
    expect(result.effectiveDecision).toEqual(result.externalDecision);
  });
});

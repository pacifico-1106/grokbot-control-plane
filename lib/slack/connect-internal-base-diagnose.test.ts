/**
 * Tests for Connect internal-base setup checklist diagnostics.
 */
import { describe, test, expect } from "bun:test";
import { DEMO_ORG } from "@/lib/demo-data";
import {
  diagnoseConnectInternalBase,
  diagnoseChannelInternalBaseReadiness,
} from "./connect-internal-base-diagnose";

describe("diagnoseConnectInternalBase", () => {
  test("returns incomplete when channelId is missing", async () => {
    const result = await diagnoseConnectInternalBase(DEMO_ORG.id, null);
    expect(result.ok).toBe(false);
    expect(result.channelId).toBe(null);
    expect(result.summaryJa).toContain("channelId");
  });

  test("returns incomplete when channel is not classified", async () => {
    const result = await diagnoseConnectInternalBase(DEMO_ORG.id, "C_NEW_CONNECT");
    expect(result.ok).toBe(false);
    expect(result.channelId).toBe("C_NEW_CONNECT");
    expect(result.channel).toBe(null);
    const classifyStep = result.checklist.find((item) => item.step === "channel_classify");
    expect(classifyStep?.ok).toBe(false);
    expect(classifyStep?.nextTool).toBe("channels.classify");
  });

  test("returns ok for demo shared_external channel with parties", async () => {
    const result = await diagnoseConnectInternalBase(DEMO_ORG.id, "C_SHARED");
    expect(result.channelId).toBe("C_SHARED");
    expect(result.channel).not.toBe(null);
    expect(result.channel?.classification).toBe("shared_external");
    expect(result.channel?.mixed).toBe(true);
    const classifyStep = result.checklist.find((item) => item.step === "channel_classify");
    expect(classifyStep?.ok).toBe(true);
  });

  test("includes IC guidance in result", async () => {
    const result = await diagnoseConnectInternalBase(DEMO_ORG.id, "C_SHARED");
    expect(result.icGuidanceJa).toContain("IC");
    expect(result.icGuidanceJa).toContain("raise-only");
    expect(result.icGuidanceJa).toContain("assetRef");
  });

  test("checklist includes employee post contract documentation", async () => {
    const result = await diagnoseConnectInternalBase(DEMO_ORG.id, "C_SHARED");
    const postContract = result.checklist.find((item) => item.step === "employee_post_contract");
    expect(postContract).toBeTruthy();
    expect(postContract?.nextStepJa).toContain("wake.channel");
    expect(postContract?.nextStepJa).toContain("wake.user");
    expect(postContract?.nextStepJa).toContain("wake.ts");
  });

  test("checklist includes connectivity probe hint", async () => {
    const result = await diagnoseConnectInternalBase(DEMO_ORG.id, "C_SHARED");
    const probe = result.checklist.find((item) => item.step === "connectivity_probe");
    expect(probe).toBeTruthy();
    expect(probe?.nextTool).toBe("setup.slackStatus");
    expect(probe?.nextStepJa).toContain("staffpass_whoami");
  });
});

describe("diagnoseChannelInternalBaseReadiness", () => {
  test("returns not ready for unclassified channel", async () => {
    const result = await diagnoseChannelInternalBaseReadiness(DEMO_ORG.id, "C_UNKNOWN");
    expect(result.readyForConnect).toBe(false);
    expect(result.classified).toBe(false);
    expect(result.nextStepJa).toContain("channels.classify");
  });

  test("returns ready for demo shared_external channel", async () => {
    const result = await diagnoseChannelInternalBaseReadiness(DEMO_ORG.id, "C_SHARED");
    expect(result.channelId).toBe("C_SHARED");
    expect(result.classified).toBe(true);
    expect(result.isSharedExternal).toBe(true);
    expect(result.isMixed).toBe(true);
    expect(result.hasPartiesOrIar).toBe(true);
    expect(result.readyForConnect).toBe(true);
    expect(result.summaryJa).toContain("準備完了");
  });

  test("includes IC guidance in result", async () => {
    const result = await diagnoseChannelInternalBaseReadiness(DEMO_ORG.id, "C_SHARED");
    expect(result.icGuidanceJa).toContain("IC");
    expect(result.icGuidanceJa).toContain("raise-only");
  });

  test("returns partiesHint when no parties or IAR", async () => {
    const result = await diagnoseChannelInternalBaseReadiness(DEMO_ORG.id, "C_INTERNAL");
    expect(result.isSharedExternal).toBe(false);
  });
});

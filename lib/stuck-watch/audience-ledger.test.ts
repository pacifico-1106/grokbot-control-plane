import { afterEach, describe, expect, test } from "bun:test";
import { upsertOrgChannel, upsertOrgParty } from "@/lib/data/directory";
import { setOrgInternalAudienceRule, clearDemoRule } from "@/lib/data/internal-audience-rule";
import { resetDemoStuckWatchPolicy } from "@/lib/data/stuck-watch-policy";
import { DEMO_ORG, pushRuntimeAuditEvent } from "@/lib/demo-data";
import { runGatewayInvoke } from "@/lib/gateway/invoke";
import {
  attemptAudienceLedgerRetry,
  isEgressDeniedAudienceMissing,
  orgHasInternalAudienceLedger,
  supplementInvokeBodyFromLedger,
} from "@/lib/stuck-watch/audience-ledger";
import { defaultStuckWatchPolicy, normalizeStuckWatchPolicy } from "@/lib/stuck-watch/validate";
import { setOrgStuckWatchPolicy } from "@/lib/data/stuck-watch-policy";

describe("isEgressDeniedAudienceMissing", () => {
  test("unknown audience is missing", () => {
    expect(isEgressDeniedAudienceMissing({ audience: "unknown" })).toBe(true);
  });

  test("external effective audience is missing for补完", () => {
    expect(
      isEgressDeniedAudienceMissing({
        audience: "external",
        effectiveAudience: "external",
      })
    ).toBe(true);
  });

  test("internal audience is not missing", () => {
    expect(
      isEgressDeniedAudienceMissing({
        audience: "internal",
        effectiveAudience: "internal",
      })
    ).toBe(false);
  });
});

describe("orgHasInternalAudienceLedger", () => {
  test("demo org has parties ledger", async () => {
    expect(await orgHasInternalAudienceLedger(DEMO_ORG.id)).toBe(true);
  });
});

describe("supplementInvokeBodyFromLedger", () => {
  afterEach(() => {
    clearDemoRule();
  });

  test("infers slackTeamId from single-team org rule", async () => {
    await setOrgInternalAudienceRule(
      DEMO_ORG.id,
      { slackTeamIds: ["TONLYTEAM"], autoSlackTeamInternal: true },
      "test"
    );
    const body = await supplementInvokeBodyFromLedger(DEMO_ORG.id, {
      tool: "comm.reply",
      purpose: "comm.internal",
      jobId: "job_supp",
      args: { slackUserId: "U_TEST", slackChannelId: "C_SHARED" },
    });
    expect(body.conversation?.slackTeamId).toBe("TONLYTEAM");
  });

  test("syncs channel classification from parties ledger", async () => {
    const channelId = `C_PARTY_SYNC_${Date.now()}`;
    await upsertOrgParty({
      orgId: DEMO_ORG.id,
      kind: "slack_channel",
      identifier: channelId,
      audience: "internal",
    });
    await upsertOrgChannel({
      orgId: DEMO_ORG.id,
      surface: "slack",
      externalId: channelId,
      classification: "unknown",
      skipInspect: true,
    });

    await supplementInvokeBodyFromLedger(DEMO_ORG.id, {
      tool: "comm.reply",
      purpose: "comm.internal",
      jobId: "job_sync",
      conversation: { surface: "slack", slackChannelId: channelId },
    });

    const { getOrgChannel } = await import("@/lib/data/directory");
    const channel = await getOrgChannel(DEMO_ORG.id, "slack", channelId);
    expect(channel?.classification).toBe("internal");
  });
});

describe("attemptAudienceLedgerRetry via invoke", () => {
  afterEach(() => {
    clearDemoRule();
    resetDemoStuckWatchPolicy();
  });

  test("egress_denied + unknown channel + party internal → auto补完 → needs_approval (not config_drift)", async () => {
    await setOrgStuckWatchPolicy(
      DEMO_ORG.id,
      normalizeStuckWatchPolicy({
        ...defaultStuckWatchPolicy(),
        inferInternalAudienceFromLedger: true,
      })
    );

    const channelId = `C_AUTO_SUPP_${Date.now()}`;
    await upsertOrgParty({
      orgId: DEMO_ORG.id,
      kind: "slack_channel",
      identifier: channelId,
      audience: "internal",
    });
    await upsertOrgChannel({
      orgId: DEMO_ORG.id,
      surface: "slack",
      externalId: channelId,
      classification: "unknown",
      skipInspect: true,
    });

    const result = await runGatewayInvoke({
      employeeId: "emp_comm",
      credentialId: "cred_comm",
      body: {
        tool: "comm.reply",
        purpose: "comm.internal",
        jobId: `job_auto_supp_${Date.now()}`,
        informationClass: "confidential",
        conversation: {
          surface: "slack",
          orgId: DEMO_ORG.id,
          slackChannelId: channelId,
          threadId: "1787911797.502889",
        },
        args: {
          slackChannelId: channelId,
          text: "機密の社内返信",
          threadId: "1787911797.502889",
        },
      },
    });

    expect(result.body.audienceLedgerSupplementAttempted).toBe(true);
    expect(result.body.audienceLedgerSupplementSucceeded).toBe(true);
    expect(result.body.code).not.toBe("egress_denied");
    expect(result.body.needs_approval).toBe(true);
    expect(result.body.faultClass).not.toBe("config_drift");
  });

  test("egress_denied on shared channel →补完 fails → config_drift + W4 audit", async () => {
    await setOrgStuckWatchPolicy(
      DEMO_ORG.id,
      normalizeStuckWatchPolicy({
        ...defaultStuckWatchPolicy(),
        inferInternalAudienceFromLedger: true,
      })
    );

    const result = await runGatewayInvoke({
      employeeId: "emp_comm",
      credentialId: "cred_comm",
      body: {
        tool: "comm.reply",
        purpose: "comm.internal",
        jobId: `job_drift_${Date.now()}`,
        conversation: {
          surface: "slack",
          orgId: DEMO_ORG.id,
          slackChannelId: "C_SHARED",
        },
        args: { slackChannelId: "C_SHARED", text: "混在chへの機密" },
        informationClass: "confidential",
      },
    });

    expect(result.httpStatus).toBe(403);
    expect(result.body.code).toBe("egress_denied");
    expect(result.body.faultClass).toBe("config_drift");
    expect(result.body.stuckHint).toBe("fix");
    expect(result.body.audienceLedgerSupplementFailed).toBe(true);

    const { listAuditEventsForStuckWatch } = await import("@/lib/data/audit");
    const audits = await listAuditEventsForStuckWatch(DEMO_ORG.id, 50);
    const w4 = audits.find((row) => row.action === "stuck_watch.w4_notify");
    expect(w4).toBeDefined();
    const retry = audits.find(
      (row) => row.action === "stuck_watch.audience_ledger_retry"
    );
    expect(retry).toBeDefined();
  });

  test("does not loop: second invoke with _audienceLedgerSupplemented skips补完", async () => {
    const skipped = await attemptAudienceLedgerRetry(
      {
        orgId: DEMO_ORG.id,
        employeeId: "emp_comm",
        body: {
          tool: "comm.reply",
          purpose: "comm.internal",
          jobId: "job_no_loop",
          _audienceLedgerSupplemented: true,
        },
        egress: { audience: "unknown" },
        tool: "comm.reply",
        purpose: "comm.internal",
        jobId: "job_no_loop",
      },
      async () => ({ httpStatus: 200, body: { ok: true } })
    );
    expect(skipped.attempted).toBe(false);
    expect(skipped.skippedReason).toBe("already_supplemented");
  });

  test("inferInternalAudienceFromLedger=false skips auto补完", async () => {
    await setOrgStuckWatchPolicy(
      DEMO_ORG.id,
      normalizeStuckWatchPolicy({
        ...defaultStuckWatchPolicy(),
        inferInternalAudienceFromLedger: false,
      })
    );

    const result = await runGatewayInvoke({
      employeeId: "emp_comm",
      credentialId: "cred_comm",
      body: {
        tool: "comm.reply",
        purpose: "comm.internal",
        jobId: `job_no_infer_${Date.now()}`,
        conversation: {
          surface: "slack",
          orgId: DEMO_ORG.id,
          slackChannelId: "C_SHARED",
        },
        args: { slackChannelId: "C_SHARED", text: "test" },
      },
    });

    expect(result.body.code).toBe("egress_denied");
    expect(result.body.audienceLedgerSupplementAttempted).toBeUndefined();
    expect(result.body.faultClass).toBe("config_drift");
  });
});

describe("classify with hasInternalLedger on egress_denied", () => {
  test("first egress_denied with ledger classifies ops_fault", async () => {
    pushRuntimeAuditEvent({
      orgId: DEMO_ORG.id,
      employeeId: "emp_comm",
      credentialId: "cred_comm",
      action: "tool.invoke",
      purpose: "comm.internal",
      summary: "denied",
      metadata: {
        tool: "comm.reply",
        code: "egress_denied",
        egress: { audience: "unknown" },
        hasInternalLedger: true,
      },
    });

    const { classifyInvokeFailure } = await import("@/lib/stuck-watch/classify");
    const result = classifyInvokeFailure({
      code: "egress_denied",
      egress: { audience: "unknown" },
      hasInternalLedger: true,
    });
    expect(result.faultClass).toBe("ops_fault");
    expect(result.stuckHint).toBe("retryable");
  });
});

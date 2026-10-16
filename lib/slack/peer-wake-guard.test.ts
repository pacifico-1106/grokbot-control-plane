import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  bindEmployeeSlackIdentity,
  revokeEmployeeSlackIdentity,
  setDemoSlackIdentityStatusForTests,
} from "@/lib/data/slack-identities";
import { listThreads, resetDemoAiPeerWake, upsertAllowlist } from "@/lib/data/ai-peer-wake";
import { updateWakeWebhook } from "@/lib/data";
import { DEMO_ORG, getRuntimeAudit, getRuntimeEmployees } from "@/lib/demo-data";
import { applyPeerWakeGuard } from "@/lib/slack/peer-wake-guard";
import type { SlackMentionTarget } from "@/lib/data/slack-identities";
import { aiPeerWakeCap, isAiPeerWakeAllowlistEnabled, isAiPeerWakeThreadGuardEnabled } from "@/lib/feature-flags";
import { demoSetEmployeeHold } from "@/lib/safety/hold";

const TEAM = "T_DEMO";
const CHANNEL = "C_CLOUD";
const ANDO = "U_ANDO";
const YASAKA = "U_YASAKA";

const envKeys = [
  "AI_PEER_WAKE_ALLOWLIST_ENABLED",
  "AI_PEER_WAKE_THREAD_GUARD_ENABLED",
  "AI_PEER_WAKE_CAP",
] as const;
const saved: Record<string, string | undefined> = {};

function target(employeeId: string, slackUserId: string): SlackMentionTarget {
  return {
    employeeId,
    orgId: DEMO_ORG.id,
    slackUserId,
    slackTeamId: TEAM,
    displayName: employeeId,
    grokBotAgentId: null,
    wakeWebhookUrl: "https://example.test/wake",
    hasWakeWebhook: true,
  };
}

async function bind(employeeId: string, slackUserId: string) {
  const emp = getRuntimeEmployees().find((e) => e.id === employeeId);
  if (!emp) throw new Error(`missing ${employeeId}`);
  const previous = emp.allowedAccounts;
  emp.allowedAccounts = [{ service: "slack", accountId: slackUserId }];
  await revokeEmployeeSlackIdentity({ employeeId, orgId: DEMO_ORG.id });
  await bindEmployeeSlackIdentity({
    employeeId,
    orgId: DEMO_ORG.id,
    slackUserId,
    slackTeamId: TEAM,
    displayName: emp.displayName,
    userToken: "xoxp-test",
  });
  await updateWakeWebhook(employeeId, { orgId: DEMO_ORG.id, url: "https://example.test/wake", secret: "s" });
  return async () => {
    await revokeEmployeeSlackIdentity({ employeeId, orgId: DEMO_ORG.id });
    await updateWakeWebhook(employeeId, { orgId: DEMO_ORG.id, url: null, secret: "" });
    emp.allowedAccounts = previous;
  };
}

beforeEach(() => {
  for (const key of envKeys) saved[key] = process.env[key];
  delete process.env.AI_PEER_WAKE_ALLOWLIST_ENABLED;
  delete process.env.AI_PEER_WAKE_THREAD_GUARD_ENABLED;
  delete process.env.AI_PEER_WAKE_CAP;
  resetDemoAiPeerWake();
});

afterEach(() => {
  resetDemoAiPeerWake();
  for (const key of envKeys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("AI peer-wake flags default OFF", () => {
  test("allowlist and thread guard are off; cap is 4", () => {
    expect(isAiPeerWakeAllowlistEnabled()).toBe(false);
    expect(isAiPeerWakeThreadGuardEnabled()).toBe(false);
    expect(aiPeerWakeCap()).toBe(4);
  });
});

describe("applyPeerWakeGuard", () => {
  test("flags OFF: AI speaker still returns every target (no-op)", async () => {
    const restore = await bind("emp_comm", ANDO);
    try {
      const targets = [target("emp_sns", YASAKA)];
      const auditBefore = getRuntimeAudit().length;
      const result = await applyPeerWakeGuard({
        speakerId: ANDO,
        teamId: TEAM,
        channelId: CHANNEL,
        threadTs: "1787911797.502889",
        eventTs: "1787911800.000001",
        eventId: "Ev_off",
        targets,
      });
      expect(result.allowed).toEqual(targets);
      expect(result.skipped).toEqual([]);
      expect(await listThreads(DEMO_ORG.id)).toEqual([]);
      expect(getRuntimeAudit().slice(auditBefore).some((e) => String(e.action).startsWith("slack.peer_wake."))).toBe(false);
    } finally {
      await restore();
    }
  });

  test("flags OFF: held AI speaker still wakes the other AI (byte-identical to main)", async () => {
    const restore = await bind("emp_comm", ANDO);
    demoSetEmployeeHold("emp_comm", { kind: "stopped", holdId: "hold_peer_off" });
    try {
      const targets = [target("emp_sns", YASAKA)];
      const result = await applyPeerWakeGuard({
        speakerId: ANDO,
        teamId: TEAM,
        channelId: CHANNEL,
        threadTs: "1787911797.502889",
        eventTs: "1787911800.000021",
        eventId: "Ev_off_held",
        targets,
      });
      expect(result.allowed).toEqual(targets);
    } finally {
      demoSetEmployeeHold("emp_comm", null);
      await restore();
    }
  });

  test("allowlist ON, no pair: AI speaker does not wake the other AI", async () => {
    process.env.AI_PEER_WAKE_ALLOWLIST_ENABLED = "1";
    const restoreA = await bind("emp_comm", ANDO);
    const restoreB = await bind("emp_sns", YASAKA);
    try {
      const result = await applyPeerWakeGuard({
        speakerId: ANDO,
        teamId: TEAM,
        channelId: CHANNEL,
        threadTs: "1787911797.502889",
        eventTs: "1787911800.000002",
        eventId: "Ev_deny",
        targets: [target("emp_sns", YASAKA)],
      });
      expect(result.allowed).toEqual([]);
      expect(result.skipReason).toBe("allowlist_denied");
      expect(getRuntimeAudit().some((e) => e.action === "slack.peer_wake.denied" && e.metadata?.reason === "allowlist_denied")).toBe(true);
    } finally {
      await restoreB();
      await restoreA();
    }
  });

  test("allowlist ON, pair exists: AI speaker wakes the allowlisted target", async () => {
    process.env.AI_PEER_WAKE_ALLOWLIST_ENABLED = "1";
    const restoreA = await bind("emp_comm", ANDO);
    const restoreB = await bind("emp_sns", YASAKA);
    await upsertAllowlist({
      orgId: DEMO_ORG.id,
      fromEmployeeId: "emp_comm",
      toEmployeeId: "emp_sns",
      createdBy: "member:mem_1",
    });
    try {
      const result = await applyPeerWakeGuard({
        speakerId: ANDO,
        teamId: TEAM,
        channelId: CHANNEL,
        threadTs: "1787911797.502889",
        eventTs: "1787911800.000003",
        eventId: "Ev_ok",
        targets: [target("emp_sns", YASAKA)],
      });
      expect(result.allowed.map((t) => t.employeeId)).toEqual(["emp_sns"]);
    } finally {
      await restoreB();
      await restoreA();
    }
  });

  test("allowlist ON, channel-specific pair does not match another channel", async () => {
    process.env.AI_PEER_WAKE_ALLOWLIST_ENABLED = "1";
    const restoreA = await bind("emp_comm", ANDO);
    const restoreB = await bind("emp_sns", YASAKA);
    await upsertAllowlist({
      orgId: DEMO_ORG.id,
      fromEmployeeId: "emp_comm",
      toEmployeeId: "emp_sns",
      slackChannelId: "C_OTHER",
      createdBy: "member:mem_1",
    });
    try {
      const result = await applyPeerWakeGuard({
        speakerId: ANDO,
        teamId: TEAM,
        channelId: CHANNEL,
        threadTs: null,
        eventTs: "1787911800.000004",
        eventId: "Ev_ch",
        targets: [target("emp_sns", YASAKA)],
      });
      expect(result.allowed).toEqual([]);
      expect(result.skipReason).toBe("allowlist_denied");
    } finally {
      await restoreB();
      await restoreA();
    }
  });

  test("allowlist ON: human speaker is not filtered", async () => {
    process.env.AI_PEER_WAKE_ALLOWLIST_ENABLED = "1";
    const restoreB = await bind("emp_sns", YASAKA);
    try {
      const targets = [target("emp_sns", YASAKA)];
      const result = await applyPeerWakeGuard({
        speakerId: "U_HUMAN",
        teamId: TEAM,
        channelId: CHANNEL,
        threadTs: "1787911797.502889",
        eventTs: "1787911800.000005",
        eventId: "Ev_human",
        targets,
      });
      expect(result.allowed).toEqual(targets);
    } finally {
      await restoreB();
    }
  });

  test("thread guard ON: 5th AI→AI wake in the same thread is capped", async () => {
    process.env.AI_PEER_WAKE_THREAD_GUARD_ENABLED = "1";
    const restoreA = await bind("emp_comm", ANDO);
    const restoreB = await bind("emp_sns", YASAKA);
    const input = {
      speakerId: ANDO,
      teamId: TEAM,
      channelId: CHANNEL,
      threadTs: "1787911797.502889",
      eventTs: "1787911800.000010",
      targets: [target("emp_sns", YASAKA)],
    };
    try {
      for (let i = 1; i <= 4; i++) {
        const result = await applyPeerWakeGuard({ ...input, eventId: `Ev_cap_${i}` });
        expect(result.allowed.map((t) => t.employeeId)).toEqual(["emp_sns"]);
      }
      const fifth = await applyPeerWakeGuard({ ...input, eventId: "Ev_cap_5" });
      expect(fifth.allowed).toEqual([]);
      expect(fifth.skipReason).toBe("thread_capped");
      expect(getRuntimeAudit().some((e) => e.action === "slack.peer_wake.denied" && e.metadata?.reason === "thread_capped")).toBe(true);
      expect(JSON.stringify(getRuntimeAudit().filter((e) => e.action === "slack.peer_wake.denied").map((e) => e.metadata))).not.toMatch(/hello <@|secret|xoxp|token/i);
    } finally {
      await restoreB();
      await restoreA();
    }
  });

  test("allowlist ON: needs_reauth AI speaker is still an AI (fail-closed, not treated as human)", async () => {
    process.env.AI_PEER_WAKE_ALLOWLIST_ENABLED = "1";
    const restoreA = await bind("emp_comm", ANDO);
    const restoreB = await bind("emp_sns", YASAKA);
    setDemoSlackIdentityStatusForTests("emp_comm", "needs_reauth");
    try {
      const result = await applyPeerWakeGuard({
        speakerId: ANDO,
        teamId: TEAM,
        channelId: CHANNEL,
        threadTs: "1787911797.502889",
        eventTs: "1787911800.000030",
        eventId: "Ev_reauth",
        targets: [target("emp_sns", YASAKA)],
      });
      expect(result.allowed).toEqual([]);
      expect(result.skipReason).toBe("allowlist_denied");
    } finally {
      await restoreB();
      await restoreA();
    }
  });

  test("allowlist ON: held AI speaker cannot wake another AI", async () => {
    process.env.AI_PEER_WAKE_ALLOWLIST_ENABLED = "1";
    const restoreA = await bind("emp_comm", ANDO);
    const restoreB = await bind("emp_sns", YASAKA);
    await upsertAllowlist({
      orgId: DEMO_ORG.id,
      fromEmployeeId: "emp_comm",
      toEmployeeId: "emp_sns",
      createdBy: "member:mem_1",
    });
    demoSetEmployeeHold("emp_comm", { kind: "stopped", holdId: "hold_peer_on" });
    try {
      const result = await applyPeerWakeGuard({
        speakerId: ANDO,
        teamId: TEAM,
        channelId: CHANNEL,
        threadTs: "1787911797.502889",
        eventTs: "1787911800.000031",
        eventId: "Ev_held",
        targets: [target("emp_sns", YASAKA)],
      });
      expect(result.allowed).toEqual([]);
      expect(result.skipReason).toBe("speaker_held");
    } finally {
      demoSetEmployeeHold("emp_comm", null);
      await restoreB();
      await restoreA();
    }
  });
});

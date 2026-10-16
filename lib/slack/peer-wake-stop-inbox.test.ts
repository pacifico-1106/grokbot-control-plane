import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { claimPeerWake, resetDemoAiPeerWake } from "@/lib/data/ai-peer-wake";
import { bindEmployeeSlackIdentity, revokeEmployeeSlackIdentity } from "@/lib/data/slack-identities";
import { DEMO_ORG, getRuntimeEmployees } from "@/lib/demo-data";
import { stopPeerWakeFromInbox } from "@/lib/slack/peer-wake-stop-inbox";

const saved = process.env.AI_PEER_WAKE_THREAD_GUARD_ENABLED;

mock.module("@/lib/approval-workflow/data", () => ({
  getMemberIdFromVoterBinding: async (orgId: string, ext: { userId: string }) => {
    if (orgId !== DEMO_ORG.id) return null;
    if (ext.userId === "U_APPROVER") return "mem_1";
    return null;
  },
}));

beforeEach(() => {
  delete process.env.AI_PEER_WAKE_THREAD_GUARD_ENABLED;
  resetDemoAiPeerWake();
});

afterEach(async () => {
  resetDemoAiPeerWake();
  await revokeEmployeeSlackIdentity({ employeeId: "emp_comm", orgId: DEMO_ORG.id }).catch(() => undefined);
  if (saved === undefined) delete process.env.AI_PEER_WAKE_THREAD_GUARD_ENABLED;
  else process.env.AI_PEER_WAKE_THREAD_GUARD_ENABLED = saved;
});

async function claim() {
  const r = await claimPeerWake({
    orgId: DEMO_ORG.id,
    teamId: "T_DEMO",
    channelId: "C_CLOUD",
    threadTs: "1787911797.502889",
    eventTs: "1787911800.000001",
    cap: 4,
    windowSeconds: 1800,
  });
  if (r.state !== "allowed") throw new Error("claim");
  return r;
}

describe("stopPeerWakeFromInbox", () => {
  test("flag OFF refuses", async () => {
    const r = await stopPeerWakeFromInbox({ orgId: DEMO_ORG.id, channelId: "ch", userId: "U_APPROVER", stopRef: "0123456789abcdef" });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("flag_off");
  });

  test("AI Slack identity cannot stop", async () => {
    process.env.AI_PEER_WAKE_THREAD_GUARD_ENABLED = "1";
    const emp = getRuntimeEmployees().find((e) => e.id === "emp_comm");
    if (!emp) throw new Error("emp");
    emp.allowedAccounts = [{ service: "slack", accountId: "U_ANDO" }];
    await bindEmployeeSlackIdentity({
      employeeId: "emp_comm",
      orgId: DEMO_ORG.id,
      slackUserId: "U_ANDO",
      slackTeamId: "T_DEMO",
      displayName: "安藤",
      userToken: "xoxp",
    });
    const claimed = await claim();
    const r = await stopPeerWakeFromInbox({ orgId: DEMO_ORG.id, channelId: "ch", userId: "U_ANDO", stopRef: claimed.stopRef });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("actor_is_employee");
  });

  test("human member with voter binding can stop", async () => {
    process.env.AI_PEER_WAKE_THREAD_GUARD_ENABLED = "1";
    const claimed = await claim();
    const r = await stopPeerWakeFromInbox({ orgId: DEMO_ORG.id, channelId: "ch", userId: "U_APPROVER", stopRef: claimed.stopRef });
    expect(r.ok).toBe(true);
    expect(r.code).toBe("stopped");
  });

  test("needs_reauth AI Slack identity still cannot stop", async () => {
    process.env.AI_PEER_WAKE_THREAD_GUARD_ENABLED = "1";
    const { setDemoSlackIdentityStatusForTests } = await import("@/lib/data/slack-identities");
    const emp = getRuntimeEmployees().find((e) => e.id === "emp_comm");
    if (!emp) throw new Error("emp");
    emp.allowedAccounts = [{ service: "slack", accountId: "U_ANDO" }];
    await bindEmployeeSlackIdentity({
      employeeId: "emp_comm",
      orgId: DEMO_ORG.id,
      slackUserId: "U_ANDO",
      slackTeamId: "T_DEMO",
      displayName: "安藤",
      userToken: "xoxp",
    });
    setDemoSlackIdentityStatusForTests("emp_comm", "needs_reauth");
    const claimed = await claim();
    const r = await stopPeerWakeFromInbox({ orgId: DEMO_ORG.id, channelId: "ch", userId: "U_ANDO", stopRef: claimed.stopRef });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("actor_is_employee");
  });
});

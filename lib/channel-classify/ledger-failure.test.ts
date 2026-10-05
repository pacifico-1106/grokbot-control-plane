/**
 * Ledger failures are reported, never swallowed (PR-B):
 * - resolveAudience's ext-shared ledger write failing → notice; audience stays external
 * - attemptAudienceLedgerRetry's ledger read failing → notice; caller keeps the deny
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const realDirectory = await import("@/lib/data/directory");
const realBotToken = await import("@/lib/slack/bot-token");
const realPolicy = await import("@/lib/data/stuck-watch-policy");
let failUpsert = false;
let failList = false;
mock.module("@/lib/data/directory", () => ({
  ...realDirectory,
  upsertOrgChannel: async (input: Parameters<typeof realDirectory.upsertOrgChannel>[0]) => {
    if (failUpsert) throw new Error("ledger_write_down");
    return realDirectory.upsertOrgChannel(input);
  },
  listOrgParties: async (orgId?: string | null) => {
    if (failList) throw new Error("ledger_read_down");
    return realDirectory.listOrgParties(orgId);
  },
}));
mock.module("@/lib/slack/bot-token", () => ({
  ...realBotToken,
  inspectSlackChannelExtShared: async () => true,
}));
mock.module("@/lib/data/stuck-watch-policy", () => ({
  ...realPolicy,
  getOrgStuckWatchPolicy: async (orgId: string) => ({ ...(await realPolicy.getOrgStuckWatchPolicy(orgId)), inferInternalAudienceFromLedger: true }),
}));

const { DEMO_ORG } = await import("@/lib/demo-data");
const { resolveAudience } = await import("@/lib/gateway/audience");
const { attemptAudienceLedgerRetry } = await import("@/lib/stuck-watch/audience-ledger");
const { setStuckNotifyDepsForTests } = await import("@/lib/channel-classify/stuck-notify");
const { resetDemoChannelClassifyStore } = await import("@/lib/data/channel-classify");

const notices: string[] = [];

beforeEach(() => {
  process.env.CHANNEL_STUCK_NOTIFY_ENABLED = "true";
  failUpsert = false;
  failList = false;
  notices.length = 0;
  resetDemoChannelClassifyStore();
  setStuckNotifyDepsForTests({
    listChannels: async () => [{ id: "nc1", orgId: DEMO_ORG.id, provider: "slack", isDefault: true, enabled: true, config: {}, secrets: {} } as never],
    send: async (_c, text) => { notices.push(text); return { ok: true }; },
    audit: async () => undefined,
    mail: async () => ({ ok: true }),
  });
});

afterAll(() => {
  delete process.env.CHANNEL_STUCK_NOTIFY_ENABLED;
  setStuckNotifyDepsForTests(null);
});

describe("ledger failures are reported", () => {
  test("ext-shared ledger write fails → audience still external, notice sent", async () => {
    failUpsert = true;
    const resolved = await resolveAudience({ surface: "slack", orgId: DEMO_ORG.id, slackChannelId: "C0LEDGERFAIL1" });
    expect(resolved.effectiveAudience).toBe("external");
    await new Promise((r) => setTimeout(r, 20));
    expect(notices.length).toBe(1);
    expect(notices[0]).toContain("C0LEDGERFAIL1");
  });

  test("ledger read fails during the retry → not attempted (deny kept), notice sent", async () => {
    failList = true;
    let ran = 0;
    const result = await attemptAudienceLedgerRetry(
      {
        orgId: DEMO_ORG.id,
        employeeId: "emp_comm",
        body: { tool: "comm.reply", conversation: { surface: "slack", slackChannelId: "C0LEDGERFAIL2" }, args: {} } as never,
        egress: { audience: "unknown", reason: "external_confidential_denied" },
        tool: "comm.reply",
        purpose: "comm.internal",
        jobId: "job_ledger_fail",
      },
      async () => { ran += 1; return { httpStatus: 200, body: { ok: true } }; }
    );
    expect(result.attempted).toBe(false);
    expect(result.skippedReason).toBe("ledger_error");
    expect(ran).toBe(0);
    expect(notices.length).toBe(1);
  });
});

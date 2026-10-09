/**
 * Follow-up to PR-B (N4): backfill paces Slack calls (per-method minimum
 * interval, sequential users.info, gap between channels), stops on a Slack
 * ratelimited response (Retry-After respected, not reported as a failure),
 * and stops at a per-run time budget.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEMO_ORG } from "@/lib/demo-data";
import { resetDemoChannelClassifyStore } from "@/lib/data/channel-classify";
import { backfillOrgChannelProposals, setBackfillDepsForTests } from "@/lib/channel-classify/backfill";
import { setChannelFactsDepsForTests, SLACK_MIN_INTERVAL_MS, type SlackApi } from "@/lib/channel-classify/facts";
import { setProposalDepsForTests } from "@/lib/channel-classify/proposals";
import { setStuckNotifyDepsForTests } from "@/lib/channel-classify/stuck-notify";
import { resetChannelClassifyBudgetFallbackForTests } from "@/lib/channel-classify/budget";

const ORG = DEMO_ORG.id;
let clock = 0;
let calls: Array<{ method: string; at: number }> = [];
let inFlightUsers = 0;
let maxConcurrentUsers = 0;
let notices: string[] = [];
let rateLimitOn: string | null = null;

const channels = Array.from({ length: 6 }, (_, i) => ({ id: `C0PACE${String(i).padStart(4, "0")}`, is_channel: true, is_im: false }));

const slack: SlackApi = async (method, params) => {
  calls.push({ method, at: clock });
  if (rateLimitOn === method) return { ok: false, error: "ratelimited", retry_after: 30 };
  if (method === "users.conversations") return { ok: true, channels, response_metadata: { next_cursor: "" } };
  if (method === "conversations.info") return { ok: true, channel: { id: params.channel, is_channel: true, is_private: false, is_shared: false, is_ext_shared: false } };
  if (method === "conversations.members") return { ok: true, members: ["U0PA", "U0PB", "U0PC"], response_metadata: { next_cursor: "" } };
  if (method === "users.info") {
    inFlightUsers += 1;
    maxConcurrentUsers = Math.max(maxConcurrentUsers, inFlightUsers);
    await Promise.resolve();
    inFlightUsers -= 1;
    return { ok: true, user: { id: params.user, team_id: "T0HOMETEAM" } };
  }
  return { ok: false };
};

beforeEach(() => {
  process.env.CHANNEL_CLASSIFY_PROPOSALS_ENABLED = "true";
  process.env.CHANNEL_STUCK_NOTIFY_ENABLED = "true";
  clock = 0;
  calls = [];
  inFlightUsers = 0;
  maxConcurrentUsers = 0;
  notices = [];
  rateLimitOn = null;
  resetDemoChannelClassifyStore();
  resetChannelClassifyBudgetFallbackForTests();
  setBackfillDepsForTests({ now: () => clock, sleep: async (ms) => { clock += ms; } });
  setChannelFactsDepsForTests({ slackApi: slack, resolveToken: async () => "xoxb-fixture", homeTeamIds: async () => ["T0HOMETEAM"] });
  setProposalDepsForTests({ notifyApproval: async () => true, hasApprover: async () => true });
  setStuckNotifyDepsForTests({
    listChannels: async () => [{ id: "nc1", orgId: ORG, provider: "slack", isDefault: true, enabled: true, config: {}, secrets: {} } as never],
    send: async (_c, text) => { notices.push(text); return { ok: true }; },
    audit: async () => undefined,
    mail: async () => ({ ok: true }),
  });
});

afterEach(() => {
  delete process.env.CHANNEL_CLASSIFY_PROPOSALS_ENABLED;
  delete process.env.CHANNEL_STUCK_NOTIFY_ENABLED;
  setBackfillDepsForTests(null);
  setChannelFactsDepsForTests(null);
  setProposalDepsForTests(null);
  setStuckNotifyDepsForTests(null);
});

describe("N4 backfill pacing", () => {
  test("same-method calls are spaced by at least the per-method minimum interval; users.info sequential", async () => {
    const result = await backfillOrgChannelProposals(ORG);
    expect(result.ok).toBe(true);
    expect(result.created).toBeGreaterThan(0);
    const byMethod = new Map<string, number[]>();
    for (const c of calls) byMethod.set(c.method, [...(byMethod.get(c.method) ?? []), c.at]);
    for (const [method, times] of byMethod) {
      const min = SLACK_MIN_INTERVAL_MS[method as keyof typeof SLACK_MIN_INTERVAL_MS];
      expect(min).toBeGreaterThan(0);
      for (let i = 1; i < times.length; i += 1) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(min);
    }
    expect(maxConcurrentUsers).toBe(1);
  });

  test("Slack ratelimited → run stops with stoppedReason rate_limited + retryAfterSeconds; no backfill_failed notice", async () => {
    rateLimitOn = "conversations.members";
    const result = await backfillOrgChannelProposals(ORG);
    expect(result.stoppedReason).toBe("rate_limited");
    expect(result.retryAfterSeconds).toBe(30);
    expect(result.created).toBe(0);
    expect(calls.filter((c) => c.method === "conversations.info").length).toBe(1); // stopped after the first channel
    expect(notices.filter((t) => t.includes("backfill")).length).toBe(0);
  });

  test("ratelimited on the channel listing → stopped, not failed", async () => {
    rateLimitOn = "users.conversations";
    const result = await backfillOrgChannelProposals(ORG);
    expect(result.stoppedReason).toBe("rate_limited");
    expect(notices.length).toBe(0);
  });

  test("time budget: a deadline before the next channel stops the run (stoppedReason time_budget)", async () => {
    const result = await backfillOrgChannelProposals(ORG, { deadlineMs: 1 });
    expect(result.stoppedReason).toBe("time_budget");
    expect(result.created).toBeLessThan(channels.length);
  });
});

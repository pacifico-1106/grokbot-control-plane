/** Backfill for channels the org's Slack bot already joined (PR-B). */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEMO_ORG } from "@/lib/demo-data";
import { getApprovalById } from "@/lib/data";
import { upsertOrgChannel } from "@/lib/data/directory";
import { resetDemoChannelClassifyStore } from "@/lib/data/channel-classify";
import { backfillOrgChannelProposals } from "@/lib/channel-classify/backfill";
import { setChannelFactsDepsForTests, type SlackApi } from "@/lib/channel-classify/facts";
import { setProposalDepsForTests } from "@/lib/channel-classify/proposals";
import { setStuckNotifyDepsForTests } from "@/lib/channel-classify/stuck-notify";

const ORG = DEMO_ORG.id;
const notices: string[] = [];

const slack: SlackApi = async (method, params) => {
  if (method === "users.conversations") {
    return {
      ok: true,
      channels: [
        { id: "C0BACKFILL01", is_channel: true, is_im: false },
        { id: "C0BACKFILL02", is_channel: true, is_im: false },
        { id: "D0BACKFILLIM", is_im: true },
      ],
      response_metadata: { next_cursor: "" },
    };
  }
  if (method === "conversations.info") return { ok: true, channel: { id: params.channel, is_channel: true, is_private: false, is_shared: false, is_ext_shared: false } };
  if (method === "conversations.members") return { ok: true, members: ["U0A"], response_metadata: { next_cursor: "" } };
  if (method === "users.info") return { ok: true, user: { id: params.user, team_id: "T0HOMETEAM" } };
  return { ok: false };
};

beforeEach(() => {
  process.env.CHANNEL_CLASSIFY_PROPOSALS_ENABLED = "true";
  process.env.CHANNEL_STUCK_NOTIFY_ENABLED = "true";
  notices.length = 0;
  resetDemoChannelClassifyStore();
  setChannelFactsDepsForTests({ slackApi: slack, resolveToken: async () => "xoxb-fixture", homeTeamIds: async () => ["T0HOMETEAM"] });
  setProposalDepsForTests({ notifyApproval: async () => true });
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
  setChannelFactsDepsForTests(null);
  setProposalDepsForTests(null);
  setStuckNotifyDepsForTests(null);
});

describe("backfillOrgChannelProposals", () => {
  test("proposes for unregistered joined channels only (IM skipped, registered skipped)", async () => {
    await upsertOrgChannel({ orgId: ORG, surface: "slack", externalId: "C0BACKFILL02", classification: "internal", skipInspect: true });
    const result = await backfillOrgChannelProposals(ORG);
    expect(result.ok).toBe(true);
    expect(result.created).toBe(1);
    expect(result.scanned).toBe(3);
    const approval = await getApprovalById(result.approvalIds[0], ORG);
    expect((approval?.metadata?.channelClassifyProposal as { trigger?: string }).trigger).toBe("backfill");
    // re-run: pending → nothing new
    expect((await backfillOrgChannelProposals(ORG)).created).toBe(0);
  });

  test("Slack listing failure → ok:false and a backfill_failed notice (not swallowed)", async () => {
    setChannelFactsDepsForTests({ slackApi: async () => { throw new Error("slack down"); }, resolveToken: async () => "xoxb-fixture" });
    const result = await backfillOrgChannelProposals(ORG);
    expect(result.ok).toBe(false);
    expect(notices.length).toBe(1);
    expect(notices[0]).toContain("backfill");
  });

  test("flag OFF → nothing", async () => {
    delete process.env.CHANNEL_CLASSIFY_PROPOSALS_ENABLED;
    const result = await backfillOrgChannelProposals(ORG);
    expect(result).toMatchObject({ ok: true, skipped: "flag_off", created: 0 });
  });
});

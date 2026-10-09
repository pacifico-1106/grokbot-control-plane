/**
 * #292 木村 22:13 answers:
 * (1) A staff config.change_request (channel_classification) must NOT lift the
 *     30-day rejected-card suppression. Only an admin channels.classify request does.
 * (2) Card / notice wording: 「却下するのは、この AI 社員に対応させたくないときだけ。
 *     分類が違うときは、正しい区分で分類し直してください」 on the shared_external card,
 *     and the same sentence in the wake-skip and egress-deny notices.
 */
import { describe, expect, test } from "bun:test";
import { DEMO_ORG } from "@/lib/demo-data";
import { decideWakeSkipSuppression } from "@/lib/channel-classify/reject-suppression";
import { unverifiedFacts } from "@/lib/channel-classify/core";

const ORG = DEMO_ORG.id;
const DAY = 24 * 60 * 60 * 1000;
const W = "却下するのは、この AI 社員に対応させたくないときだけ。分類が違うときは、正しい区分で分類し直してください";

describe("22:13 (1): a staff config.change_request never lifts the suppression", () => {
  const now = Date.now();
  const iso = (ms: number) => new Date(ms).toISOString();
  const ch = "C0CFGLIFT01";
  const rejected = {
    id: "apr_rejected_card",
    orgId: ORG,
    tool: "channels.classify",
    status: "rejected",
    createdAt: iso(now - 2 * DAY),
    resolvedAt: iso(now - DAY),
    metadata: { adminMutation: { surface: "slack", externalId: ch }, proposalRequester: { kind: "system", source: "wake_skipped" } },
  };
  const configChange = (status: string, createdMs: number) => ({
    id: `apr_cfg_${status}_${createdMs}`,
    orgId: ORG,
    tool: "config.change_request",
    status,
    createdAt: iso(createdMs),
    resolvedAt: status === "pending" ? null : iso(createdMs + 1000),
    metadata: {
      configChange: {
        requestedBy: { kind: "staff", name: "fixture staff" },
        proposal: { kind: "channel_classification", surface: "slack", externalId: ch, classification: "internal" },
      },
    },
  });
  type Rows = Parameters<typeof decideWakeSkipSuppression>[0]["rows"];
  const decide = (rows: unknown[]) => decideWakeSkipSuppression({ rows: rows as Rows, orgId: ORG, channelId: ch, nowMs: now }).suppressed;

  test("pending staff config change for this channel after the rejection → still suppressed", () => {
    expect(decide([rejected, configChange("pending", now)])).toBe(true);
  });
  test("approved staff config change for this channel after the rejection → still suppressed", () => {
    expect(decide([rejected, configChange("approved", now - 1000)])).toBe(true);
  });
  test("even with an admin_agent-looking requester inside configChange it does not lift (tool must be channels.classify)", () => {
    const forged = { ...configChange("pending", now), metadata: { ...configChange("pending", now).metadata, adminRequester: { kind: "admin_agent", actorId: "x" }, adminMutation: { surface: "slack", externalId: ch } } };
    expect(decide([rejected, forged])).toBe(true);
  });
  test("control: an admin channels.classify request for this channel still lifts", () => {
    const admin = {
      id: "apr_admin",
      orgId: ORG,
      tool: "channels.classify",
      status: "pending",
      createdAt: iso(now),
      resolvedAt: null,
      metadata: { adminMutation: { surface: "slack", externalId: ch }, adminRequester: { kind: "admin_agent", actorId: "a" } },
    };
    expect(decide([rejected, admin])).toBe(false);
  });
});

describe("22:13 (2): reject guidance wording", () => {
  test("shared_external card for an unregistered channel shows the new warning, not 「社内専用なら却下」", async () => {
    const { buildChannelClassifyCardSummaryJa } = await import("@/lib/channel-classify/approval-card");
    const summary = await buildChannelClassifyCardSummaryJa(
      ORG,
      { surface: "slack", externalId: "C0WORDCARD1", classification: "shared_external", mixed: true },
      { requester: "system", facts: unverifiedFacts({ surface: "slack", externalId: "C0WORDCARD1" }, "channel", 3) }
    );
    expect(summary).toContain(W);
    expect(summary).toContain("後で internal に戻せません");
    expect(summary).not.toContain("社内専用なら却下");
  });

  test("the wake-skip notice and the egress-deny notice carry the same sentence", async () => {
    const { buildStuckNoticeTextJa } = await import("@/lib/channel-classify/stuck-notify");
    const notice = buildStuckNoticeTextJa(
      { orgId: ORG, kind: "unclassified_channel_wake_skipped", ref: { surface: "slack", externalId: "C0WORDING1" }, reason: "channel_not_classified", approvalId: "apr_wording_1", proposalState: "created" },
      { surface: "slack", externalId: "C0WORDING1" },
      "channel_not_classified"
    );
    expect(notice).toContain(W);
    const { buildUnregisteredDenyNoticeJa } = await import("@/lib/channel-classify/core");
    const deny = buildUnregisteredDenyNoticeJa({ ref: { surface: "slack", externalId: "C0WORDING1" }, reason: "unclassified_channel", approvalId: "apr_wording_2", proposalState: "created" });
    expect(deny).toContain(W);
    for (const text of [notice, deny]) {
      expect(text).not.toContain("社外と共有されているなら却下");
      expect(text).not.toContain("社内専用なら却下");
      // still says how to file the external classification
      expect(text).toContain("classification=shared_external");
    }
  });

  test("the shared constant is the exact sentence 木村 gave", async () => {
    const mod = await import("@/lib/channel-classify/reject-guidance");
    expect(mod.CLASSIFY_REJECT_GUIDANCE_JA).toBe(W);
  });
});

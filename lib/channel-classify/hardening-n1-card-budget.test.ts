/**
 * Follow-up to PR-B (N1): the parties.upsert slack_user card shares the same
 * overall Slack time budget as the channel card, and hitting the budget aborts
 * the background Slack calls too (no orphaned requests keep running).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEMO_ORG } from "@/lib/demo-data";
import {
  buildChannelClassifyCardSummaryJa,
  buildPartyUpsertCardSummaryJa,
  setCardBudgetMsForTests,
} from "@/lib/channel-classify/approval-card";
import { setChannelFactsDepsForTests, type SlackApi } from "@/lib/channel-classify/facts";

const ORG = DEMO_ORG.id;
let signals: Array<AbortSignal | undefined> = [];
let callsAfterAbort = 0;

/** A Slack that never answers until the caller aborts. */
const hangingSlack: SlackApi = (method, _params, _token, signal) => {
  signals.push(signal);
  if (signal?.aborted) callsAfterAbort += 1;
  return new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
};

beforeEach(() => {
  signals = [];
  callsAfterAbort = 0;
  setCardBudgetMsForTests(50);
  setChannelFactsDepsForTests({ slackApi: hangingSlack, resolveToken: async () => "xoxb-fixture", homeTeamIds: async () => ["T0HOME"] });
});

afterEach(() => {
  setCardBudgetMsForTests(null);
  setChannelFactsDepsForTests(null);
});

describe("N1 card time budget", () => {
  test("parties.upsert slack_user: hanging users.info → card returns within the budget with 確認できません, call aborted", async () => {
    const started = Date.now();
    const summary = await buildPartyUpsertCardSummaryJa(ORG, { kind: "slack_user", identifier: "U0CARDHANG1", audience: "internal" });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(summary).toContain("確認できません");
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((s) => s?.aborted === true)).toBe(true);
  });

  test("channels.classify slack card: hanging conversations.info → aborted, and no further Slack call starts after the abort", async () => {
    const summary = await buildChannelClassifyCardSummaryJa(ORG, { surface: "slack", externalId: "C0CARDHANG1", classification: "internal", mixed: false });
    expect(summary).toContain("確認できません");
    await new Promise((r) => setTimeout(r, 30));
    expect(signals.every((s) => s?.aborted === true)).toBe(true);
    expect(callsAfterAbort).toBe(0);
  });

  test("parties.upsert slack_channel uses the same budget and abort", async () => {
    const summary = await buildPartyUpsertCardSummaryJa(ORG, { kind: "slack_channel", identifier: "C0CARDHANG2", audience: "internal" });
    expect(summary).toContain("確認できません");
    expect(signals.every((s) => s?.aborted === true)).toBe(true);
  });

  test("a slow members walk stops at the abort (no users.info after the budget)", async () => {
    const methods: string[] = [];
    const slowSlack: SlackApi = async (method, params, _token, signal) => {
      methods.push(method);
      if (method === "conversations.info") return { ok: true, channel: { id: params.channel, is_channel: true, is_private: false } };
      if (method === "conversations.members") return { ok: true, members: Array.from({ length: 30 }, (_, i) => `U0SLOW${i}`), response_metadata: { next_cursor: "" } };
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, 40);
        signal?.addEventListener("abort", () => { clearTimeout(t); reject(new Error("aborted")); }, { once: true });
      });
      return { ok: true, user: { id: params.user, team_id: "T0HOME" } };
    };
    setChannelFactsDepsForTests({ slackApi: slowSlack, resolveToken: async () => "xoxb-fixture", homeTeamIds: async () => ["T0HOME"] });
    await buildChannelClassifyCardSummaryJa(ORG, { surface: "slack", externalId: "C0CARDSLOW1", classification: "internal", mixed: false });
    const countAtReturn = methods.length;
    await new Promise((r) => setTimeout(r, 150));
    expect(methods.length).toBe(countAtReturn);
    expect(methods.filter((m) => m === "users.info").length).toBeLessThan(30);
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runGatewayInvoke } from "@/lib/gateway/invoke";
import { DEMO_ORG } from "@/lib/demo-data";
import { getApprovalById, listAuditEvents, resolveApproval } from "@/lib/data";
import { getEmployee } from "@/lib/data/employees";
import { upsertOrgChannel } from "@/lib/data/directory";
import { fulfillApprovedInvoke } from "@/lib/approvals/fulfill";
import { __resetChannelScopeDemoStore, upsertAutoClassifiedChannel, upsertEmployeeChannelMembership } from "./data";
import { evaluateRemovedChannelGate, REMOVED_CHANNEL_DENY_CODE, sendViaForPostingAs } from "./removed-gate";
import type { MembershipVia } from "./types";

const ORG = DEMO_ORG.id;
const EMP = "emp_comm";
const saved = process.env.P1_CHANNEL_SCOPE_ENABLED;
let n = 0;
let via: MembershipVia = "bot";
const chan = () => `C0RMV${Date.now().toString(36).toUpperCase()}${(n += 1)}`;

function postPublic(channel: string, tool = "slack.post") {
  return runGatewayInvoke({
    employeeId: EMP,
    credentialId: "cred_comm",
    body: {
      tool,
      purpose: "comm.internal",
      jobId: `job_cs6_${Date.now()}_${(n += 1)}`,
      conversation: { surface: "slack", orgId: ORG, slackChannelId: channel },
      args: { assetRef: "kb/public-faq", slackChannelId: channel },
    },
  });
}

async function manualInternal(): Promise<string> {
  const c = chan();
  await upsertOrgChannel({ orgId: ORG, surface: "slack", externalId: c, classification: "shared_external", mixed: true, skipInspect: true });
  return c;
}

const setState = (c: string, state: "member" | "left" | "removed", v: MembershipVia = via) =>
  upsertEmployeeChannelMembership({ orgId: ORG, employeeId: EMP, externalId: c, via: v, state });

beforeEach(async () => {
  process.env.P1_CHANNEL_SCOPE_ENABLED = "1";
  __resetChannelScopeDemoStore();
  via = sendViaForPostingAs((await getEmployee(EMP, ORG))?.postingAs);
});
afterEach(() => {
  if (saved === undefined) delete process.env.P1_CHANNEL_SCOPE_ENABLED;
  else process.env.P1_CHANNEL_SCOPE_ENABLED = saved;
});

describe("evaluateRemovedChannelGate", () => {
  test("flag OFF ⇒ never denied, no lookup", async () => {
    const c = chan();
    await setState(c, "removed");
    delete process.env.P1_CHANNEL_SCOPE_ENABLED;
    expect(await evaluateRemovedChannelGate({ orgId: ORG, employeeId: EMP, slackChannelId: c, postingAs: "bot" })).toEqual({
      denied: false,
      reason: "flag_off",
    });
  });

  test("removed for the posting via ⇒ denied; other via / left / rejoin ⇒ not denied", async () => {
    const gate = (c: string, postingAs: string) => evaluateRemovedChannelGate({ orgId: ORG, employeeId: EMP, slackChannelId: c, postingAs });
    expect((await gate("D0DM123", "bot")).reason).toBe("not_a_channel");
    const c = chan();
    expect((await gate(c, "bot")).reason).toBe("not_removed");
    await setState(c, "removed", "bot");
    expect(await gate(c, "bot")).toMatchObject({ denied: true, reason: "removed", via: "bot", channelId: c });
    // The user token is still in the channel: posting as the user is not blocked by the bot removal.
    expect((await gate(c, "user")).denied).toBe(false);
    await setState(c, "left", "bot");
    expect((await gate(c, "bot")).denied).toBe(false);
    await setState(c, "removed", "bot");
    await setState(c, "member", "bot");
    expect((await gate(c, "bot")).denied).toBe(false);
    const u = chan();
    await setState(u, "removed", "user");
    expect(await gate(u, "user")).toMatchObject({ denied: true, via: "user" });
  });
});

describe("Gateway invoke + approval fulfill", () => {
  test("send to a channel the employee was removed from ⇒ 403 deny + audit", async () => {
    const c = await manualInternal();
    expect((await postPublic(c)).body.ok).toBe(true); // baseline: allowed by the matrix
    await setState(c, "removed");
    for (const tool of ["slack.post", "comm.reply"]) {
      const r = await postPublic(c, tool);
      expect(r.httpStatus).toBe(403);
      expect(r.body).toMatchObject({ ok: false, code: REMOVED_CHANNEL_DENY_CODE, needs_approval: false });
    }
    const audits = await listAuditEvents(ORG, 30);
    expect(audits.some((a) => a.action === "channel_scope.removed_channel_denied")).toBe(true);
  });

  test("flag OFF ⇒ legacy (not denied)", async () => {
    const c = await manualInternal();
    await setState(c, "removed");
    delete process.env.P1_CHANNEL_SCOPE_ENABLED;
    expect((await postPublic(c)).body.ok).toBe(true);
  });

  test("approval granted before the removal is not executed", async () => {
    const c = chan();
    await upsertAutoClassifiedChannel({
      orgId: ORG,
      externalId: c,
      auto: { classification: "shared_external", mixed: true, externalTeamIds: ["T0PEER"] },
      source: "auto_join",
    });
    const queued = await postPublic(c);
    expect(queued.body.code).toBe("needs_approval"); // CS4 Connect gate
    await setState(c, "removed");
    const approval = await getApprovalById(String(queued.body.approvalId), ORG);
    const approved = await resolveApproval(approval!.id, "approved", "owner@example.com", ORG, { actorId: "mem_human_owner" });
    const fulfillment = await fulfillApprovedInvoke(approved!);
    expect(fulfillment).toMatchObject({ ok: false, error: REMOVED_CHANNEL_DENY_CODE });
  });
});

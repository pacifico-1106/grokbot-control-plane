/**
 * Admin MCP: channels.remove / parties.remove — demo mode (PR-E).
 *
 * Covers: registry (tools/list === callable, approvalClass admin, always_human,
 * plan scopes, audit action, approval kind), flag OFF (default) at request and
 * again at fulfillment, org scoping from the credential only (another org's
 * row = not found, no ticket), missing rows, repeated deletion (idempotent),
 * Slack IM route removed BEFORE the channel row (and nothing deleted if that
 * fails), the channel / party is treated as external (fail-closed) afterwards,
 * slack_user auto DM routes removed before the party row.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { fulfillApprovedAdmin } from "@/lib/admin-mcp/fulfill-admin";
import { auditActionForAdminTool } from "@/lib/admin-mcp/audit-class";
import { getToolApprovalKind } from "@/lib/approval-kind-routes/tool-kind-map";
import { PLAN_ADMIN_SCOPES, READ_ONLY_ADMIN_TOOLS } from "@/lib/billing/plan-scopes";
import { getApprovalById, listApprovals, resolveApproval } from "@/lib/data";
import { resetDemoAdminAgent } from "@/lib/data/admin-agents";
import { getOrgChannel, getOrgParty, upsertOrgChannel, upsertOrgParty } from "@/lib/data/directory";
import { getSlackImEmployeeRoute, upsertSlackImEmployeeRoute } from "@/lib/data/slack-im-routes";
import { DEMO_ORG, getRuntimeAudit } from "@/lib/demo-data";
import { validateReplyRecipient } from "@/lib/gateway/reply-recipient-validate";
import { ADMIN_MCP_TOOL_NAMES } from "@/lib/mcp/admin-public";
import { ADMIN_MCP_TOOLS, callAdminMcpTool, isAdminMcpToolName } from "@/lib/mcp/admin-tools";
import type { ResolvedAdminCredential } from "@/lib/auth/admin-credential";

const CH_REMOVE = "channels.remove";
const PTY_REMOVE = "parties.remove";
const FLAG = "ADMIN_MCP_DIRECTORY_REMOVE_TOOLS_ENABLED";
const ORG_A = DEMO_ORG.id;
const ORG_B = "org_directory_remove_other_tenant";
const ADMIN_GROK = "grok_admin_directory_remove";

let saved: Record<string, string | undefined> = {};
let seq = 0;

function cred(orgId = ORG_A): ResolvedAdminCredential {
  const agent = resetDemoAdminAgent({ grokBotAgentId: ADMIN_GROK, status: "linked" });
  return {
    orgId,
    adminAgentId: agent.id,
    grokBotAgentId: agent.grokBotAgentId,
    actorId: agent.id,
    generation: agent.credentialGeneration,
    via: "bearer",
    agent,
  };
}

function data(result: { structuredContent?: unknown }): Record<string, unknown> {
  return result.structuredContent as Record<string, unknown>;
}

function uid(prefix: string): string {
  seq += 1;
  return `${prefix}${Date.now().toString(36).toUpperCase()}${seq}`;
}

async function approve(approvalId: string, orgId = ORG_A) {
  const approved = await resolveApproval(approvalId, "approved", "owner@example.com", orgId, { actorId: "mem_human_dr" });
  expect(approved).not.toBeNull();
  return approved!;
}

async function approveAndFulfill(approvalId: string, orgId = ORG_A) {
  return fulfillApprovedAdmin(await approve(approvalId, orgId));
}

async function approvalCount(orgId = ORG_A): Promise<number> {
  return (await listApprovals(orgId)).length;
}

async function loadModule() {
  return import("@/lib/admin-mcp/directory-remove-tools");
}

beforeEach(() => {
  saved = {
    flag: process.env[FLAG],
    reply: process.env.P0_REPLY_POLICY_ENHANCED,
    autoroute: process.env.SLACK_DM_AUTOROUTE_ENABLED,
  };
  process.env[FLAG] = "true";
});

afterEach(async () => {
  const restore = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  restore(FLAG, saved.flag);
  restore("P0_REPLY_POLICY_ENHANCED", saved.reply);
  restore("SLACK_DM_AUTOROUTE_ENABLED", saved.autoroute);
  try {
    (await loadModule()).setDirectoryRemoveDepsForTests(null);
  } catch {
    // module missing on main (fail-first run)
  }
});

describe("registry", () => {
  test("exact names are advertised and callable, always_human, approvalClass admin, no orgId", () => {
    for (const name of [CH_REMOVE, PTY_REMOVE]) {
      expect((ADMIN_MCP_TOOL_NAMES as readonly string[]).includes(name)).toBe(true);
      expect(isAdminMcpToolName(name)).toBe(true);
      const def = ADMIN_MCP_TOOLS.find((t) => t.name === name);
      expect(def).toBeDefined();
      expect(def!.approvalClass).toBe("admin");
      expect(def!.description).toContain("always_human");
      expect(def!.description).toContain("approvalClass admin");
      expect(Object.keys(def!.inputSchema.properties)).not.toContain("orgId");
      expect(def!.inputSchema.additionalProperties).toBe(false);
      expect((READ_ONLY_ADMIN_TOOLS as readonly string[]).includes(name)).toBe(false);
      expect(getToolApprovalKind(name)).toBe("account");
    }
    expect(auditActionForAdminTool(CH_REMOVE)).toBe("admin.channel");
    expect(auditActionForAdminTool(PTY_REMOVE)).toBe("admin.parties");
    const advertised = ADMIN_MCP_TOOLS.map((t) => t.name);
    expect(advertised).toEqual([...ADMIN_MCP_TOOL_NAMES]);
  });

  test("plan scopes follow channels.classify / parties.upsert", () => {
    for (const plan of Object.keys(PLAN_ADMIN_SCOPES) as Array<keyof typeof PLAN_ADMIN_SCOPES>) {
      const scopes = PLAN_ADMIN_SCOPES[plan] as readonly string[];
      expect({ plan, ok: scopes.includes(CH_REMOVE) }).toEqual({ plan, ok: scopes.includes("channels.classify") });
      expect({ plan, ok: scopes.includes(PTY_REMOVE) }).toEqual({ plan, ok: scopes.includes("parties.upsert") });
    }
  });
});

describe("flag OFF (default)", () => {
  test("request is refused with a code, no ticket, nothing deleted", async () => {
    delete process.env[FLAG];
    const channel = await upsertOrgChannel({ orgId: ORG_A, surface: "slack", externalId: uid("C"), classification: "internal", skipInspect: true });
    const party = await upsertOrgParty({ orgId: ORG_A, kind: "email_domain", identifier: `${uid("d").toLowerCase()}.example.jp`, audience: "internal" });
    const before = await approvalCount();
    const ch = data(await callAdminMcpTool(CH_REMOVE, { channelId: channel.id }, cred()));
    const pt = data(await callAdminMcpTool(PTY_REMOVE, { partyId: party.id }, cred()));
    expect(ch.code).toBe("directory_remove_tools_disabled");
    expect(pt.code).toBe("directory_remove_tools_disabled");
    expect(String(ch.nextStepJa || "")).not.toBe("");
    expect(await approvalCount()).toBe(before);
    expect(await getOrgChannel(ORG_A, "slack", channel.externalId)).not.toBeNull();
    expect(await getOrgParty(ORG_A, "email_domain", party.identifier)).not.toBeNull();
  });

  test("flag turned OFF after approval: fulfillment refuses and deletes nothing", async () => {
    const channel = await upsertOrgChannel({ orgId: ORG_A, surface: "slack", externalId: uid("C"), classification: "internal", skipInspect: true });
    const out = data(await callAdminMcpTool(CH_REMOVE, { channelId: channel.id }, cred()));
    expect(out.code).toBe("needs_approval");
    delete process.env[FLAG];
    const fulfillment = await approveAndFulfill(String(out.approvalId));
    expect(fulfillment?.ok).toBe(false);
    expect(fulfillment?.error).toBe("directory_remove_tools_disabled");
    expect(await getOrgChannel(ORG_A, "slack", channel.externalId)).not.toBeNull();
  });
});

describe("org scoping and validation", () => {
  test("orgId / unknown arguments are rejected (org comes from the credential)", async () => {
    const channel = await upsertOrgChannel({ orgId: ORG_A, surface: "slack", externalId: uid("C"), classification: "internal", skipInspect: true });
    const before = await approvalCount();
    const ch = data(await callAdminMcpTool(CH_REMOVE, { channelId: channel.id, orgId: ORG_B }, cred()));
    expect(ch.code).toBe("unexpected_argument");
    const pt = data(await callAdminMcpTool(PTY_REMOVE, { partyId: "x", orgId: ORG_B }, cred()));
    expect(pt.code).toBe("unexpected_argument");
    expect(await approvalCount()).toBe(before);
  });

  test("another org's channel / party cannot be removed (same not-found as a missing id, no ticket)", async () => {
    const otherChannel = await upsertOrgChannel({ orgId: ORG_B, surface: "slack", externalId: uid("C"), classification: "internal", skipInspect: true });
    const otherParty = await upsertOrgParty({ orgId: ORG_B, kind: "slack_user", identifier: uid("U"), audience: "internal" });
    const before = await approvalCount();
    const byId = data(await callAdminMcpTool(CH_REMOVE, { channelId: otherChannel.id }, cred()));
    const byExternal = data(await callAdminMcpTool(CH_REMOVE, { externalId: otherChannel.externalId }, cred()));
    const party = data(await callAdminMcpTool(PTY_REMOVE, { partyId: otherParty.id }, cred()));
    const partyByIdent = data(await callAdminMcpTool(PTY_REMOVE, { kind: "slack_user", identifier: otherParty.identifier }, cred()));
    expect(byId.code).toBe("channel_not_found");
    expect(byExternal.code).toBe("channel_not_found");
    expect(party.code).toBe("party_not_found");
    expect(partyByIdent.code).toBe("party_not_found");
    expect(JSON.stringify([byId, byExternal, party, partyByIdent])).not.toContain(ORG_B);
    expect(await approvalCount()).toBe(before);
    expect(await getOrgChannel(ORG_B, "slack", otherChannel.externalId)).not.toBeNull();
    expect(await getOrgParty(ORG_B, "slack_user", otherParty.identifier)).not.toBeNull();
  });

  test("missing id → not found; no selector → missing_required_fields; invalid surface / kind rejected", async () => {
    const before = await approvalCount();
    expect(data(await callAdminMcpTool(CH_REMOVE, { channelId: "chn_does_not_exist" }, cred())).code).toBe("channel_not_found");
    expect(data(await callAdminMcpTool(CH_REMOVE, { externalId: uid("C") }, cred())).code).toBe("channel_not_found");
    expect(data(await callAdminMcpTool(PTY_REMOVE, { partyId: "pty_does_not_exist" }, cred())).code).toBe("party_not_found");
    expect(data(await callAdminMcpTool(CH_REMOVE, {}, cred())).code).toBe("missing_required_fields");
    expect(data(await callAdminMcpTool(PTY_REMOVE, {}, cred())).code).toBe("missing_required_fields");
    expect(data(await callAdminMcpTool(PTY_REMOVE, { identifier: "x" }, cred())).code).toBe("missing_required_fields");
    expect(data(await callAdminMcpTool(CH_REMOVE, { externalId: "C1", surface: "fax" }, cred())).code).toBe("invalid_surface");
    expect(data(await callAdminMcpTool(PTY_REMOVE, { kind: "pager", identifier: "x" }, cred())).code).toBe("invalid_party_kind");
    expect(await approvalCount()).toBe(before);
  });
});

describe("channels.remove", () => {
  test("queues a ticket with a card (what is deleted, external afterwards); nothing deleted before approval", async () => {
    const channel = await upsertOrgChannel({ orgId: ORG_A, surface: "slack", externalId: uid("C"), classification: "internal", skipInspect: true });
    const res = await callAdminMcpTool(CH_REMOVE, { externalId: channel.externalId }, cred());
    const out = data(res);
    expect(res.isError).toBe(false);
    expect(out.code).toBe("needs_approval");
    expect(out.always_human).toBe(true);
    const summary = String(out.summary);
    expect(summary).toContain(channel.externalId);
    expect(summary).toContain("社内");
    expect(summary).toContain("社外扱い");
    const approval = await getApprovalById(String(out.approvalId), ORG_A);
    expect(approval?.status).toBe("pending");
    expect(approval?.metadata?.adminTool).toBe(CH_REMOVE);
    expect(await getOrgChannel(ORG_A, "slack", channel.externalId)).not.toBeNull();
  });

  test("fulfillment deletes the row, writes the admin audit, and the channel is then treated as external (fail-closed)", async () => {
    process.env.P0_REPLY_POLICY_ENHANCED = "true";
    const channel = await upsertOrgChannel({ orgId: ORG_A, surface: "slack", externalId: uid("C"), classification: "internal", skipInspect: true });
    const ctx = { slackChannelId: channel.externalId };
    const beforeCheck = await validateReplyRecipient({ orgId: ORG_A, employee: null, context: ctx });
    expect(beforeCheck.reason).not.toBe("fail_closed_unknown_recipient");
    const out = data(await callAdminMcpTool(CH_REMOVE, { channelId: channel.id }, cred()));
    const approvalId = String(out.approvalId);
    const fulfillment = await approveAndFulfill(approvalId);
    expect(fulfillment?.ok).toBe(true);
    expect(fulfillment?.channelId).toBe(channel.id);
    expect(await getOrgChannel(ORG_A, "slack", channel.externalId)).toBeNull();
    const audit = getRuntimeAudit().find((e) => e.action === "admin.channel" && e.metadata?.approvalId === approvalId);
    expect(audit?.orgId).toBe(ORG_A);
    expect(audit?.metadata?.op).toBe("remove");
    expect(audit?.metadata?.before).toEqual({ classification: "internal", mixed: false });
    const afterCheck = await validateReplyRecipient({ orgId: ORG_A, employee: null, context: ctx });
    expect(afterCheck.failClosed).toBe(true);
    expect(afterCheck.audience).toBe("external");
    expect(afterCheck.reason).toBe("fail_closed_unknown_recipient");
  });

  test("Slack IM: the DM ingress route is removed BEFORE the channel row", async () => {
    const dm = uid("D");
    await upsertOrgChannel({ orgId: ORG_A, surface: "slack", externalId: dm, classification: "internal", skipInspect: true });
    await upsertSlackImEmployeeRoute({ orgId: ORG_A, slackChannelId: dm, slackTeamId: "T0DEMO", employeeId: "emp_comm" });
    const mod = await loadModule();
    const calls: string[] = [];
    const real = await import("@/lib/data/directory");
    const routes = await import("@/lib/data/slack-im-routes");
    mod.setDirectoryRemoveDepsForTests({
      deleteSlackImEmployeeRoute: async (input) => {
        calls.push("route");
        return routes.deleteSlackImEmployeeRoute(input);
      },
      deleteOrgChannel: async (orgId, id) => {
        calls.push("channel");
        return real.deleteOrgChannel(orgId, id);
      },
    });
    const out = data(await callAdminMcpTool(CH_REMOVE, { externalId: dm }, cred()));
    expect(String(out.summary)).toContain("DM");
    const fulfillment = await approveAndFulfill(String(out.approvalId));
    expect(fulfillment?.ok).toBe(true);
    expect(calls).toEqual(["route", "channel"]);
    expect(await getSlackImEmployeeRoute(ORG_A, dm)).toBeNull();
    expect(await getOrgChannel(ORG_A, "slack", dm)).toBeNull();
  });

  test("Slack IM: if the route delete fails, the channel row is kept (fail-closed)", async () => {
    const dm = uid("D");
    await upsertOrgChannel({ orgId: ORG_A, surface: "slack", externalId: dm, classification: "internal", skipInspect: true });
    await upsertSlackImEmployeeRoute({ orgId: ORG_A, slackChannelId: dm, slackTeamId: "T0DEMO", employeeId: "emp_comm" });
    const mod = await loadModule();
    let channelDeletes = 0;
    mod.setDirectoryRemoveDepsForTests({
      deleteSlackImEmployeeRoute: async () => {
        throw new Error("slack_im_route_delete_failed");
      },
      deleteOrgChannel: async () => {
        channelDeletes += 1;
        return true;
      },
    });
    const out = data(await callAdminMcpTool(CH_REMOVE, { externalId: dm }, cred()));
    const fulfillment = await approveAndFulfill(String(out.approvalId));
    expect(fulfillment?.ok).toBe(false);
    expect(channelDeletes).toBe(0);
    expect(await getOrgChannel(ORG_A, "slack", dm)).not.toBeNull();
    expect(await getSlackImEmployeeRoute(ORG_A, dm)).not.toBeNull();
  });

  test("repeat: a second request after removal is not found; a second approved ticket is a no-op and does not touch a re-created row", async () => {
    const externalId = uid("C");
    const channel = await upsertOrgChannel({ orgId: ORG_A, surface: "slack", externalId, classification: "internal", skipInspect: true });
    const first = data(await callAdminMcpTool(CH_REMOVE, { channelId: channel.id }, cred()));
    const second = data(await callAdminMcpTool(CH_REMOVE, { channelId: channel.id }, cred()));
    expect(second.code).toBe("needs_approval");
    expect((await approveAndFulfill(String(first.approvalId)))?.ok).toBe(true);
    const before = await approvalCount();
    expect(data(await callAdminMcpTool(CH_REMOVE, { channelId: channel.id }, cred())).code).toBe("channel_not_found");
    expect(await approvalCount()).toBe(before);
    // Someone classifies the same Slack channel again → new row, new id.
    const recreated = await upsertOrgChannel({ orgId: ORG_A, surface: "slack", externalId, classification: "shared_external", skipInspect: true });
    expect(recreated.id).not.toBe(channel.id);
    const again = await approveAndFulfill(String(second.approvalId));
    expect(again?.ok).toBe(true);
    expect(String(again?.summaryJa)).toContain("すでに削除");
    expect((await getOrgChannel(ORG_A, "slack", externalId))?.id).toBe(recreated.id);
  });
});

describe("parties.remove", () => {
  test("queue → card → fulfillment deletes the party; recipient is then unknown → external (fail-closed)", async () => {
    process.env.P0_REPLY_POLICY_ENHANCED = "true";
    const identifier = uid("U");
    const party = await upsertOrgParty({ orgId: ORG_A, kind: "slack_user", identifier, audience: "internal" });
    const out = data(await callAdminMcpTool(PTY_REMOVE, { kind: "slack_user", identifier }, cred()));
    expect(out.code).toBe("needs_approval");
    expect(String(out.summary)).toContain(identifier);
    expect(String(out.summary)).toContain("社外扱い");
    expect(await getOrgParty(ORG_A, "slack_user", identifier)).not.toBeNull();
    const approvalId = String(out.approvalId);
    const fulfillment = await approveAndFulfill(approvalId);
    expect(fulfillment?.ok).toBe(true);
    expect(fulfillment?.partyId).toBe(party.id);
    expect(await getOrgParty(ORG_A, "slack_user", identifier)).toBeNull();
    const audit = getRuntimeAudit().find((e) => e.action === "admin.parties" && e.metadata?.approvalId === approvalId);
    expect(audit?.metadata?.op).toBe("remove");
    expect(audit?.metadata?.before).toEqual({ audience: "internal" });
    const check = await validateReplyRecipient({
      orgId: ORG_A,
      employee: null,
      context: {},
      recipientIdentifier: identifier,
      recipientKind: "slack_user",
    });
    expect(check.failClosed).toBe(true);
    expect(check.audience).toBe("external");
  });

  test("slack_user with auto DM routes (SLACK_DM_AUTOROUTE_ENABLED): routes removed before the party", async () => {
    process.env.SLACK_DM_AUTOROUTE_ENABLED = "true";
    const identifier = uid("U");
    const dm = uid("D");
    await upsertOrgParty({ orgId: ORG_A, kind: "slack_user", identifier, audience: "internal" });
    await upsertOrgChannel({ orgId: ORG_A, surface: "slack", externalId: dm, classification: "internal", skipInspect: true });
    await upsertSlackImEmployeeRoute({
      orgId: ORG_A,
      slackChannelId: dm,
      slackTeamId: "T0DEMO",
      employeeId: "emp_comm",
      source: "auto_party",
      counterpartSlackUserId: identifier,
    });
    const mod = await loadModule();
    const calls: string[] = [];
    const autoroute = await import("@/lib/slack/dm-autoroute");
    const real = await import("@/lib/data/directory");
    mod.setDirectoryRemoveDepsForTests({
      removeAutoDmRoutesForCounterpart: async (input) => {
        calls.push("routes");
        return autoroute.removeAutoDmRoutesForCounterpart(input);
      },
      deleteOrgParty: async (orgId, id) => {
        calls.push("party");
        return real.deleteOrgParty(orgId, id);
      },
    });
    const out = data(await callAdminMcpTool(PTY_REMOVE, { kind: "slack_user", identifier }, cred()));
    const fulfillment = await approveAndFulfill(String(out.approvalId));
    expect(fulfillment?.ok).toBe(true);
    expect(calls).toEqual(["routes", "party"]);
    expect(await getSlackImEmployeeRoute(ORG_A, dm)).toBeNull();
    expect((await getOrgChannel(ORG_A, "slack", dm))?.classification).toBe("unknown");
    expect(await getOrgParty(ORG_A, "slack_user", identifier)).toBeNull();
  });

  test("slack_user: if removing its DM routes fails, the party is kept (dm_route_remove_failed)", async () => {
    const identifier = uid("U");
    await upsertOrgParty({ orgId: ORG_A, kind: "slack_user", identifier, audience: "internal" });
    const mod = await loadModule();
    let partyDeletes = 0;
    mod.setDirectoryRemoveDepsForTests({
      removeAutoDmRoutesForCounterpart: async () => ({ status: "error", reason: "unexpected_error", items: [] }),
      deleteOrgParty: async () => {
        partyDeletes += 1;
        return true;
      },
    });
    const out = data(await callAdminMcpTool(PTY_REMOVE, { kind: "slack_user", identifier }, cred()));
    const fulfillment = await approveAndFulfill(String(out.approvalId));
    expect(fulfillment?.ok).toBe(false);
    expect(fulfillment?.error).toBe("dm_route_remove_failed");
    expect(partyDeletes).toBe(0);
    expect(await getOrgParty(ORG_A, "slack_user", identifier)).not.toBeNull();
  });

  test("repeat: second request after removal is not found; second approved ticket is a no-op", async () => {
    const identifier = `${uid("d").toLowerCase()}.example.jp`;
    const party = await upsertOrgParty({ orgId: ORG_A, kind: "email_domain", identifier, audience: "external" });
    const first = data(await callAdminMcpTool(PTY_REMOVE, { partyId: party.id }, cred()));
    const second = data(await callAdminMcpTool(PTY_REMOVE, { partyId: party.id }, cred()));
    expect((await approveAndFulfill(String(first.approvalId)))?.ok).toBe(true);
    expect(data(await callAdminMcpTool(PTY_REMOVE, { partyId: party.id }, cred())).code).toBe("party_not_found");
    const again = await approveAndFulfill(String(second.approvalId));
    expect(again?.ok).toBe(true);
    expect(String(again?.summaryJa)).toContain("すでに削除");
  });
});

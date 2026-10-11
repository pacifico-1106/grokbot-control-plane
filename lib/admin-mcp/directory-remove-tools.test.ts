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

/* ------------------------------------------------------------------------ *
 * 木村 review 2026-10-05 10:39 (before the flag goes ON): a delete must never
 * make resolveAudience judge the destination LESS restrictive (external /
 * mixed / guest / outside-domain → internal). Checked at request AND at
 * fulfillment (state may change in between). Each refusal is double-checked
 * against the real resolveAudience: deleting the row directly WOULD turn the
 * destination internal.
 * ------------------------------------------------------------------------ */
import { deleteOrgChannel, deleteOrgParty } from "@/lib/data/directory";
import { clearDemoRule, setOrgInternalAudienceRule } from "@/lib/data/internal-audience-rule";
import { resolveAudience } from "@/lib/gateway/audience";
import type { ConversationContext } from "@/lib/types";

const RELAX = "directory_remove_relaxes_audience";
const OWN_TEAM = "T0OWNTEAM1";

async function audienceOf(ctx: Partial<ConversationContext>) {
  return (await resolveAudience({ surface: "slack", orgId: ORG_A, ...ctx } as ConversationContext)).audience;
}
function expectRelaxRefusal(out: Record<string, unknown>) {
  expect(out.ok).toBe(false);
  expect(out.code).toBe(RELAX);
  expect(out.retryable).toBe(false);
  expect(String(out.nextStepJa || "")).not.toBe("");
  expect(out.audienceBefore).toBe("external");
  expect(out.audienceAfter).toBe("internal");
}

describe("post-delete audience: a delete never relaxes external / mixed / guest / outside-domain to internal", () => {
  afterEach(() => clearDemoRule());

  // --- channels.remove ---
  for (const kind of [
    { label: "shared_external", classification: "shared_external" as const, mixed: false },
    { label: "mixed (classified internal, mixed flag)", classification: "internal" as const, mixed: true },
    { label: "unknown classification", classification: "unknown" as const, mixed: false },
  ]) {
    test(`channel ${kind.label} + slack_channel party internal → refused at request, no ticket, row kept (real resolver would turn internal)`, async () => {
      const externalId = uid("C");
      const speaker = uid("U");
      // party first: once the channel row is shared / mixed, the party ledger refuses an internal slack_channel
      await upsertOrgParty({ orgId: ORG_A, kind: "slack_channel", identifier: externalId, audience: "internal" });
      const channel = await upsertOrgChannel({ orgId: ORG_A, surface: "slack", externalId, classification: kind.classification, mixed: kind.mixed, skipInspect: true });
      await upsertOrgParty({ orgId: ORG_A, kind: "slack_user", identifier: speaker, audience: "internal" });
      expect(await audienceOf({ slackChannelId: externalId, slackUserId: speaker })).toBe("external");
      const before = await approvalCount();
      const res = await callAdminMcpTool(CH_REMOVE, { channelId: channel.id }, cred());
      expect(res.isError).toBe(true);
      expectRelaxRefusal(data(res));
      expect(await approvalCount()).toBe(before);
      expect(await getOrgChannel(ORG_A, "slack", externalId)).not.toBeNull();
      // oracle: deleting the row directly would make the destination internal
      await deleteOrgChannel(ORG_A, channel.id);
      expect(await audienceOf({ slackChannelId: externalId, slackUserId: speaker })).toBe("internal");
    });
  }

  test("channel shared_external without an internal party → allowed (stays external after the delete)", async () => {
    const channel = await upsertOrgChannel({ orgId: ORG_A, surface: "slack", externalId: uid("C"), classification: "shared_external", mixed: true, skipInspect: true });
    const out = data(await callAdminMcpTool(CH_REMOVE, { channelId: channel.id }, cred()));
    expect(out.code).toBe("needs_approval");
    expect(String(out.summary)).toContain("削除後の判定: 社外");
    expect((await approveAndFulfill(String(out.approvalId)))?.ok).toBe(true);
  });

  test("channel internal + party internal → allowed (internal → internal is not less restrictive)", async () => {
    const externalId = uid("C");
    const channel = await upsertOrgChannel({ orgId: ORG_A, surface: "slack", externalId, classification: "internal", skipInspect: true });
    await upsertOrgParty({ orgId: ORG_A, kind: "slack_channel", identifier: externalId, audience: "internal" });
    const out = data(await callAdminMcpTool(CH_REMOVE, { channelId: channel.id }, cred()));
    expect(out.code).toBe("needs_approval");
    expect((await approveAndFulfill(String(out.approvalId)))?.ok).toBe(true);
  });

  test("fulfil-time recheck: the channel became shared_external after the request (party internal) → refused at fulfillment, row kept", async () => {
    const externalId = uid("C");
    const speaker = uid("U");
    await upsertOrgParty({ orgId: ORG_A, kind: "slack_channel", identifier: externalId, audience: "internal" });
    await upsertOrgParty({ orgId: ORG_A, kind: "slack_user", identifier: speaker, audience: "internal" });
    const channel = await upsertOrgChannel({ orgId: ORG_A, surface: "slack", externalId, classification: "internal", skipInspect: true });
    const out = data(await callAdminMcpTool(CH_REMOVE, { channelId: channel.id }, cred()));
    expect(out.code).toBe("needs_approval");
    // Slack Connect detected / reclassified between request and approval
    await upsertOrgChannel({ orgId: ORG_A, surface: "slack", externalId, classification: "shared_external", mixed: true, skipInspect: true });
    expect(await audienceOf({ slackChannelId: externalId, slackUserId: speaker })).toBe("external");
    const fulfillment = await approveAndFulfill(String(out.approvalId));
    expect(fulfillment?.ok).toBe(false);
    expect(fulfillment?.error).toBe(RELAX);
    expect((fulfillment as Record<string, unknown>)?.retryable).toBe(false);
    expect(String(fulfillment?.nextStepJa || "")).not.toBe("");
    expect(await getOrgChannel(ORG_A, "slack", externalId)).not.toBeNull();
    expect(await audienceOf({ slackChannelId: externalId, slackUserId: speaker })).toBe("external");
  });

  test("unknown row → refused at request AND at fulfil; nextStepJa says to classify it first with channels.classify (木村 #287 decision)", async () => {
    const UNKNOWN_NEXT_STEP_PREFIX = "このチャネルは台帳で未分類（unknown）です。削除ではなく、先に channels.classify で分類してください";
    const externalId = uid("C");
    await upsertOrgParty({ orgId: ORG_A, kind: "slack_channel", identifier: externalId, audience: "internal" });
    const channel = await upsertOrgChannel({ orgId: ORG_A, surface: "slack", externalId, classification: "unknown", skipInspect: true });
    const res = data(await callAdminMcpTool(CH_REMOVE, { channelId: channel.id }, cred()));
    expectRelaxRefusal(res);
    expect(res.beforeKind).toBe("unknown");
    expect(res.nextTool).toBe("channels.classify");
    expect(String(res.nextStepJa).startsWith(UNKNOWN_NEXT_STEP_PREFIX)).toBe(true);
    // fulfil: classified internal at request time, unknown by approval time
    await upsertOrgChannel({ orgId: ORG_A, surface: "slack", externalId, classification: "internal", skipInspect: true });
    const out = data(await callAdminMcpTool(CH_REMOVE, { channelId: channel.id }, cred()));
    expect(out.code).toBe("needs_approval");
    await upsertOrgChannel({ orgId: ORG_A, surface: "slack", externalId, classification: "unknown", skipInspect: true });
    const fulfillment = (await approveAndFulfill(String(out.approvalId))) as Record<string, unknown> | null;
    expect(fulfillment?.ok).toBe(false);
    expect(fulfillment?.error).toBe(RELAX);
    expect(fulfillment?.nextTool).toBe("channels.classify");
    // fulfil prefixes the refusal message (existing shape: messageJa + nextStepJa)
    expect(String(fulfillment?.nextStepJa)).toContain(UNKNOWN_NEXT_STEP_PREFIX);
    expect(await getOrgChannel(ORG_A, "slack", externalId)).not.toBeNull();
  });

  test("shared_external / mixed refusals keep the generic wording (no unknown-specific step)", async () => {
    const externalId = uid("C");
    await upsertOrgParty({ orgId: ORG_A, kind: "slack_channel", identifier: externalId, audience: "internal" });
    const channel = await upsertOrgChannel({ orgId: ORG_A, surface: "slack", externalId, classification: "shared_external", skipInspect: true });
    const res = data(await callAdminMcpTool(CH_REMOVE, { channelId: channel.id }, cred()));
    expectRelaxRefusal(res);
    expect(String(res.nextStepJa)).not.toContain("未分類（unknown）");
  });

  // --- parties.remove ---
  test("outside-domain: mail_address external in an internal domain (rule) → refused; oracle turns internal once Slack verifies the own team", async () => {
    const domain = `${uid("d").toLowerCase()}.example.jp`;
    const email = `contractor@${domain}`;
    await setOrgInternalAudienceRule(ORG_A, { emailDomains: [domain] }, "test");
    const party = await upsertOrgParty({ orgId: ORG_A, kind: "mail_address", identifier: email, audience: "external" });
    expect(await audienceOf({ surface: "mail", email })).toBe("external");
    const before = await approvalCount();
    const res = await callAdminMcpTool(PTY_REMOVE, { partyId: party.id }, cred());
    expectRelaxRefusal(data(res));
    expect(await approvalCount()).toBe(before);
    expect(await getOrgParty(ORG_A, "mail_address", email)).not.toBeNull();
    await deleteOrgParty(ORG_A, party.id);
    expect(await audienceOf({ surface: "mail", email })).toBe("internal");
  });

  test("mail_address external under an internal email_domain party → refused", async () => {
    const domain = `${uid("d").toLowerCase()}.example.jp`;
    const email = `guest@${domain}`;
    await upsertOrgParty({ orgId: ORG_A, kind: "email_domain", identifier: domain, audience: "internal" });
    const party = await upsertOrgParty({ orgId: ORG_A, kind: "mail_address", identifier: email, audience: "external" });
    expectRelaxRefusal(data(await callAdminMcpTool(PTY_REMOVE, { kind: "mail_address", identifier: email }, cred())));
    await deleteOrgParty(ORG_A, party.id);
    expect(await audienceOf({ surface: "mail", email })).toBe("internal");
  });

  test("email_domain external whose domain is internal by the org rule → refused", async () => {
    const domain = `${uid("d").toLowerCase()}.example.jp`;
    await setOrgInternalAudienceRule(ORG_A, { emailDomains: [domain] }, "test");
    const party = await upsertOrgParty({ orgId: ORG_A, kind: "email_domain", identifier: domain, audience: "external" });
    expect(await audienceOf({ surface: "mail", email: `someone@${domain}` })).toBe("external");
    expectRelaxRefusal(data(await callAdminMcpTool(PTY_REMOVE, { partyId: party.id }, cred())));
    await deleteOrgParty(ORG_A, party.id);
    expect(await audienceOf({ surface: "mail", email: `someone@${domain}` })).toBe("internal");
  });

  test("guest: slack_user external while own-workspace users are auto-internal → refused; oracle turns internal once Slack verifies the own team", async () => {
    await setOrgInternalAudienceRule(ORG_A, { slackTeamIds: [OWN_TEAM], autoSlackTeamInternal: true }, "test");
    const guest = uid("U");
    const party = await upsertOrgParty({ orgId: ORG_A, kind: "slack_user", identifier: guest, audience: "external" });
    expect(await audienceOf({ slackUserId: guest, slackTeamId: OWN_TEAM })).toBe("external");
    const res = await callAdminMcpTool(PTY_REMOVE, { partyId: party.id }, cred());
    expectRelaxRefusal(data(res));
    expect(await getOrgParty(ORG_A, "slack_user", guest)).not.toBeNull();
    // The guard above refused with no Slack bot token at all: it never depends
    // on Slack being reachable (team rule ON → a slack_user delete may relax).
    await deleteOrgParty(ORG_A, party.id);
    // Oracle. Since #298 (7214eb7) resolveAudience trusts only the team Slack
    // itself reports (users.info); the AI-supplied slackTeamId is ignored, so
    // without a verifiable team the row-less guest stays external…
    expect(await audienceOf({ slackUserId: guest, slackTeamId: OWN_TEAM })).toBe("external");
    // …and in production Slack reports a guest of the own workspace with the
    // own team id → the row-less guest is judged internal. That relaxation is
    // exactly what the refusal above prevents.
    const { upsertConversationAdapter } = await import("@/lib/data/conversation-adapters");
    const { resetSlackUserTeamCacheForTests } = await import("@/lib/slack/bot-token");
    await upsertConversationAdapter({ orgId: ORG_A, surface: "slack", enabled: true, secrets: { botToken: "xoxb-guest-oracle" } });
    const realFetch = globalThis.fetch;
    let slackTeam: string | null = OWN_TEAM;
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      if (url.includes("users.info")) {
        return slackTeam
          ? Response.json({ ok: true, user: { id: guest, team_id: slackTeam } })
          : Response.json({ ok: false, error: "user_not_found" });
      }
      return Response.json({ ok: false, error: "not_mocked" });
    }) as typeof fetch;
    try {
      resetSlackUserTeamCacheForTests();
      expect(await audienceOf({ slackUserId: guest })).toBe("internal");
      // AI-supplied slackTeamId alone never makes it internal (fail-closed):
      // users.info cannot find the user → external…
      resetSlackUserTeamCacheForTests();
      slackTeam = null;
      expect(await audienceOf({ slackUserId: guest, slackTeamId: OWN_TEAM })).toBe("external");
      // …and Slack reports another workspace → external, whatever the AI claims.
      resetSlackUserTeamCacheForTests();
      slackTeam = "T0OTHERTEAM";
      expect(await audienceOf({ slackUserId: guest, slackTeamId: OWN_TEAM })).toBe("external");
    } finally {
      globalThis.fetch = realFetch;
      resetSlackUserTeamCacheForTests();
      await upsertConversationAdapter({ orgId: ORG_A, surface: "slack", enabled: false, secrets: {} });
    }
  });

  test("allowed: external slack_user without an auto-internal team, external phone / line, external slack_channel party", async () => {
    for (const p of [
      { kind: "slack_user" as const, identifier: uid("U") },
      { kind: "phone" as const, identifier: `+8190${String(Date.now()).slice(-8)}` },
      { kind: "line" as const, identifier: uid("Uline") },
      { kind: "slack_channel" as const, identifier: uid("C") },
    ]) {
      const party = await upsertOrgParty({ orgId: ORG_A, ...p, audience: "external" });
      const out = data(await callAdminMcpTool(PTY_REMOVE, { partyId: party.id }, cred()));
      expect([p.kind, out.code]).toEqual([p.kind, "needs_approval"]);
      expect(String(out.summary)).toContain("削除後の判定: 社外");
    }
  });

  test("fulfil-time recheck: the org rule made the domain internal after the request → refused at fulfillment, party kept", async () => {
    const domain = `${uid("d").toLowerCase()}.example.jp`;
    const email = `vendor@${domain}`;
    const party = await upsertOrgParty({ orgId: ORG_A, kind: "mail_address", identifier: email, audience: "external" });
    const out = data(await callAdminMcpTool(PTY_REMOVE, { partyId: party.id }, cred()));
    expect(out.code).toBe("needs_approval");
    await setOrgInternalAudienceRule(ORG_A, { emailDomains: [domain] }, "test");
    const fulfillment = await approveAndFulfill(String(out.approvalId));
    expect(fulfillment?.ok).toBe(false);
    expect(fulfillment?.error).toBe(RELAX);
    expect((fulfillment as Record<string, unknown>)?.retryable).toBe(false);
    expect(await getOrgParty(ORG_A, "mail_address", email)).not.toBeNull();
  });
});

/* ------------------------------------------------------------------------ *
 * After #276: org_channels.surface includes telegram, and channels.list /
 * parties.list do not return row ids — the remove tools select rows by what
 * the lists return (externalId + surface / kind + identifier).
 * ------------------------------------------------------------------------ */
import { CHANNEL_LEDGER_SURFACES } from "@/lib/channel-classify/core";

describe("aligned with #276 (telegram surface, list → remove by natural key)", () => {
  test("channels.remove surface enum = the ledger surfaces (incl. telegram); descriptions point to channels.list / parties.list keys", () => {
    const ch = ADMIN_MCP_TOOLS.find((t) => t.name === CH_REMOVE)!;
    const pt = ADMIN_MCP_TOOLS.find((t) => t.name === PTY_REMOVE)!;
    const props = ch.inputSchema.properties as Record<string, { enum?: string[]; description?: string }>;
    expect(props.surface.enum).toEqual([...CHANNEL_LEDGER_SURFACES]);
    expect(props.surface.enum).toContain("telegram");
    expect(ch.description).toContain("channels.list");
    expect(String(props.externalId.description)).toContain("channels.list");
    expect(String(props.channelId.description)).toContain("not returned by channels.list");
    const pprops = pt.inputSchema.properties as Record<string, { description?: string }>;
    expect(pt.description).toContain("parties.list");
    expect(String(pprops.partyId.description)).toContain("not returned by parties.list");
  });

  test("telegram: a row found with channels.list is removed by externalId + surface", async () => {
    const externalId = `-100${String(Date.now()).slice(-9)}${++seq}`;
    await upsertOrgChannel({ orgId: ORG_A, surface: "telegram", externalId, classification: "shared_external", skipInspect: true });
    const listed = data(await callAdminMcpTool("channels.list", { surface: "telegram", limit: 200 }, cred()));
    const item = (listed.items as Array<Record<string, unknown>>).find((i) => i.externalId === externalId)!;
    expect(item).toBeDefined();
    expect("id" in item).toBe(false);
    const out = data(await callAdminMcpTool(CH_REMOVE, { externalId: String(item.externalId), surface: String(item.surface) }, cred()));
    expect(out.code).toBe("needs_approval");
    expect(String(out.summary)).toContain("telegram");
    expect((await approveAndFulfill(String(out.approvalId)))?.ok).toBe(true);
    expect(await getOrgChannel(ORG_A, "telegram", externalId)).toBeNull();
  });

  test("a party found with parties.list is removed by kind + identifier", async () => {
    const identifier = `${uid("d").toLowerCase()}.example.jp`;
    await upsertOrgParty({ orgId: ORG_A, kind: "email_domain", identifier, audience: "internal" });
    const listed = data(await callAdminMcpTool("parties.list", { kind: "email_domain", limit: 200 }, cred()));
    const item = (listed.items as Array<Record<string, unknown>>).find((i) => i.identifier === identifier)!;
    expect(item).toBeDefined();
    const out = data(await callAdminMcpTool(PTY_REMOVE, { kind: String(item.kind), identifier: String(item.identifier) }, cred()));
    expect(out.code).toBe("needs_approval");
    expect((await approveAndFulfill(String(out.approvalId)))?.ok).toBe(true);
    expect(await getOrgParty(ORG_A, "email_domain", identifier)).toBeNull();
  });
});

describe("self-approval", () => {
  test("the requesting admin agent cannot approve its own channels.remove / parties.remove ticket; rows kept, ticket pending", async () => {
    const c = cred();
    const channel = await upsertOrgChannel({ orgId: ORG_A, surface: "slack", externalId: uid("C"), classification: "internal", skipInspect: true });
    const identifier = `${uid("selfappr").toLowerCase()}.example.com`;
    await upsertOrgParty({ orgId: ORG_A, kind: "email_domain", identifier, audience: "external" });
    const tickets = [
      data(await callAdminMcpTool(CH_REMOVE, { externalId: channel.externalId }, c)),
      data(await callAdminMcpTool(PTY_REMOVE, { kind: "email_domain", identifier }, c)),
    ];
    for (const out of tickets) {
      expect(out.code).toBe("needs_approval");
      let thrown: unknown = null;
      try {
        await resolveApproval(String(out.approvalId), "approved", "agent", ORG_A, { actorId: c.actorId, grokBotAgentId: c.grokBotAgentId });
      } catch (error) {
        thrown = error;
      }
      expect((thrown as { code?: string } | null)?.code).toBe("self_approval_denied");
      expect((await getApprovalById(String(out.approvalId), ORG_A))?.status).toBe("pending");
    }
    expect(await getOrgChannel(ORG_A, "slack", channel.externalId)).not.toBeNull();
    expect(await getOrgParty(ORG_A, "email_domain", identifier)).not.toBeNull();
  });
});

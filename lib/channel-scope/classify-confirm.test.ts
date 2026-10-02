import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { callAdminMcpTool } from "@/lib/mcp/admin-tools";
import { fulfillApprovedAdmin } from "@/lib/admin-mcp/fulfill-admin";
import { listAuditEvents, resolveApproval } from "@/lib/data";
import { DEMO_ORG } from "@/lib/demo-data";
import { resetDemoAdminAgent } from "@/lib/data/admin-agents";
import type { ResolvedAdminCredential } from "@/lib/auth/admin-credential";
import { __resetChannelScopeDemoStore, getChannelScopeChannel, upsertAutoClassifiedChannel } from "./data";
import { evaluateConnectEgressGate } from "./egress-gate";

const ORG = DEMO_ORG.id;
const saved = process.env.P1_CHANNEL_SCOPE_ENABLED;
let n = 0;
const chan = () => `C0CLS${Date.now().toString(36).toUpperCase()}${(n += 1)}`;

function demoCred(): ResolvedAdminCredential {
  const agent = resetDemoAdminAgent({ grokBotAgentId: "grok_admin_demo", status: "linked" });
  return { orgId: ORG, adminAgentId: agent.id, grokBotAgentId: agent.grokBotAgentId, actorId: agent.id, generation: agent.credentialGeneration, via: "bearer", agent };
}

async function classifyApproved(externalId: string, classification: string) {
  const queued = await callAdminMcpTool("channels.classify", { surface: "slack", externalId, classification, mixed: true }, demoCred());
  const approvalId = String((queued.structuredContent as Record<string, unknown>).approvalId);
  const approved = await resolveApproval(approvalId, "approved", "owner@example.com", ORG, { actorId: "mem_human_owner" });
  return fulfillApprovedAdmin(approved!);
}

beforeEach(() => {
  process.env.P1_CHANNEL_SCOPE_ENABLED = "1";
  __resetChannelScopeDemoStore();
});
afterEach(() => {
  if (saved === undefined) delete process.env.P1_CHANNEL_SCOPE_ENABLED;
  else process.env.P1_CHANNEL_SCOPE_ENABLED = saved;
});

describe("channels.classify confirms auto rows (CS4)", () => {
  test("approved classify sets human_confirmed_at, keeps source, lifts the Connect send gate", async () => {
    const c = chan();
    await upsertAutoClassifiedChannel({ orgId: ORG, externalId: c, auto: { classification: "shared_external", mixed: true, externalTeamIds: ["T0PEER"] }, source: "auto_join" });
    expect((await evaluateConnectEgressGate({ orgId: ORG, employeeId: "emp_comm", slackChannelId: c })).required).toBe(true);
    const fulfillment = await classifyApproved(c, "shared_external");
    expect(fulfillment?.ok).toBe(true);
    const row = await getChannelScopeChannel(ORG, "slack", c);
    expect(row?.humanConfirmedAt).toBeTruthy();
    expect(row?.source).toBe("auto_join");
    expect((await evaluateConnectEgressGate({ orgId: ORG, employeeId: "emp_comm", slackChannelId: c })).reason).toBe("human_confirmed");
    const audits = await listAuditEvents(ORG, 30);
    expect(audits.some((a) => a.action === "channel_scope.human_confirmed" && a.metadata?.externalId === c)).toBe(true);
  });

  test("a Connect row still cannot be classified internal by a human (existing guard)", async () => {
    const c = chan();
    await upsertAutoClassifiedChannel({ orgId: ORG, externalId: c, auto: { classification: "shared_external", mixed: true, externalTeamIds: [] }, source: "auto_join" });
    const queued = await callAdminMcpTool("channels.classify", { surface: "slack", externalId: c, classification: "internal" }, demoCred());
    const approvalId = String((queued.structuredContent as Record<string, unknown>).approvalId);
    const approved = await resolveApproval(approvalId, "approved", "owner@example.com", ORG, { actorId: "mem_human_owner" });
    const fulfillment = await fulfillApprovedAdmin(approved!);
    expect(fulfillment?.ok).toBe(false);
    expect((await getChannelScopeChannel(ORG, "slack", c))?.humanConfirmedAt ?? null).toBeNull();
  });

  test("flag OFF ⇒ classify behaves as before (no confirmation write)", async () => {
    const c = chan();
    await upsertAutoClassifiedChannel({ orgId: ORG, externalId: c, auto: { classification: "shared_external", mixed: true, externalTeamIds: [] }, source: "auto_join" });
    delete process.env.P1_CHANNEL_SCOPE_ENABLED;
    const fulfillment = await classifyApproved(c, "shared_external");
    expect(fulfillment?.ok).toBe(true);
    process.env.P1_CHANNEL_SCOPE_ENABLED = "1";
    expect((await getChannelScopeChannel(ORG, "slack", c))?.humanConfirmedAt ?? null).toBeNull();
  });
});

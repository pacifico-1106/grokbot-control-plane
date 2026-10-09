/**
 * Tenant isolation (BOLA): the org that drives audience resolution must come
 * only from the authenticated principal (the 社員証's employee / the approval
 * row), never from the AI-supplied `conversation.orgId`.
 *
 * Fail-first: before the fix an org-A employee sending conversation.orgId=B got
 * B's internal verdict, wrote into B's channel ledger, used B's Slack bot token
 * and had its approval snapshot carry B. After the fix a mismatching org is
 * refused (403 conversation_org_mismatch) with the same answer whether B exists
 * or not, one IDs-only audit row under A, and a matching org changes nothing.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { DEMO_ORG } from "@/lib/demo-data";
import { parseConversationContext, resolveAudience } from "@/lib/gateway/audience";
import { runGatewayInvoke } from "@/lib/gateway/invoke";
import { conversationKeyInputFromBody } from "@/lib/comm-reply-dedup/conversation-key";
import { getOrgChannel, upsertOrgChannel } from "@/lib/data/directory";
import { upsertConversationAdapter } from "@/lib/data/conversation-adapters";
import { getApprovalById, listAuditEvents, resolveApproval } from "@/lib/data";
import { fulfillApprovedInvoke, parseInvokeSnapshot } from "@/lib/approvals/fulfill";
import { callStaffpassMcpTool } from "@/lib/mcp/tools";
import type { ResolvedEmployeeCredential } from "@/lib/auth/employee-credential";
import type { GatewayInvokeRequest } from "@/lib/types";

const ORG_A = DEMO_ORG.id;
const ORG_B = "org_tenant_b_isolation";
const ORG_GHOST = "org_tenant_never_existed";
const B_TOKEN = "xoxb-ORG-B-SECRET";
const B_CHANNEL = "C0BONLYINTERNAL";

const originalFetch = globalThis.fetch;
let slackAuth: string[] = [];

function mockSlack(extShared: boolean) {
  slackAuth = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    slackAuth.push(new Headers(init?.headers).get("authorization") || "");
    if (url.includes("conversations.info")) {
      return Response.json({ ok: true, channel: { id: B_CHANNEL, is_ext_shared: extShared } });
    }
    if (url.includes("chat.postMessage")) {
      return Response.json({ ok: true, channel: B_CHANNEL, ts: "1787960001.000001" });
    }
    return Response.json({ ok: false, error: "unexpected_fetch" });
  }) as typeof fetch;
}

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await upsertConversationAdapter({ orgId: ORG_B, surface: "slack", enabled: false, secrets: {} }).catch(() => undefined);
  await upsertConversationAdapter({ orgId: ORG_A, surface: "slack", enabled: false, secrets: {} }).catch(() => undefined);
});

function slackBody(orgId: string | undefined, channel = B_CHANNEL, jobId = `job_bola_${Math.random().toString(36).slice(2)}`): GatewayInvokeRequest {
  return {
    tool: "comm.reply",
    purpose: "comm.internal",
    jobId,
    conversation: { surface: "slack", ...(orgId !== undefined ? { orgId } : {}), slackChannelId: channel },
    args: { slackChannelId: channel, text: "社外秘の本文（テスト）" },
  };
}

function sha(v: string) {
  return createHash("sha256").update(v).digest("hex");
}

describe("parse layer: conversation.orgId never overrides the authenticated org", () => {
  test("parseConversationContext uses the passed org even when conversation.orgId=B", () => {
    const ctx = parseConversationContext(slackBody(ORG_B), ORG_A);
    expect(ctx?.orgId).toBe(ORG_A);
  });

  test("org-A context with conversation.orgId=B does NOT get B's internal verdict", async () => {
    await upsertOrgChannel({ orgId: ORG_B, surface: "slack", externalId: B_CHANNEL, classification: "internal", skipInspect: true });
    const ctx = parseConversationContext(slackBody(ORG_B), ORG_A)!;
    const verdict = await resolveAudience(ctx);
    expect(verdict.audience).not.toBe("internal");
    expect(verdict.effectiveAudience).toBe("external");
  });

  test("no write lands in B's ledger and B's Slack bot token is never used", async () => {
    const channel = "C0BEXTSHARED01";
    await upsertConversationAdapter({ orgId: ORG_B, surface: "slack", enabled: true, secrets: { botToken: B_TOKEN } });
    mockSlack(true);
    const ctx = parseConversationContext(slackBody(ORG_B, channel), ORG_A)!;
    await resolveAudience(ctx);
    expect(await getOrgChannel(ORG_B, "slack", channel)).toBeNull();
    expect(slackAuth.some((h) => h.includes(B_TOKEN))).toBe(false);
  });

  test("dedup key input stays bound to the authenticated org", () => {
    const input = conversationKeyInputFromBody(slackBody(ORG_B), ORG_A);
    expect(input?.orgId).toBe(ORG_A);
    const plain = conversationKeyInputFromBody(slackBody(undefined), ORG_A);
    expect(input).toEqual(plain);
  });
});

describe("gateway runGatewayInvoke (shared by HTTP and MCP)", () => {
  test("org-A employee with conversation.orgId=B → 403 conversation_org_mismatch, nothing touched in B", async () => {
    await upsertOrgChannel({ orgId: ORG_B, surface: "slack", externalId: B_CHANNEL, classification: "internal", skipInspect: true });
    await upsertConversationAdapter({ orgId: ORG_B, surface: "slack", enabled: true, secrets: { botToken: B_TOKEN } });
    mockSlack(false);
    const body = slackBody(ORG_B);
    const result = await runGatewayInvoke({ employeeId: "emp_comm", credentialId: "cred_comm", body });
    expect(result.httpStatus).toBe(403);
    expect(result.body.code).toBe("conversation_org_mismatch");
    expect(result.body.ok).toBe(false);
    expect(String(result.body.nextStepJa || "")).toMatch(/[ぁ-んァ-ン一-龯]/);
    expect(slackAuth.length).toBe(0);
    // no approval / snapshot was created
    expect(result.body.approvalId ?? null).toBeNull();
    // no leak of B's verdict
    expect(JSON.stringify(result.body)).not.toContain(ORG_B);
    expect(result.body.egress).toBeUndefined();
  });

  test("same response whether org B exists or not (no existence oracle)", async () => {
    await upsertOrgChannel({ orgId: ORG_B, surface: "slack", externalId: B_CHANNEL, classification: "internal", skipInspect: true });
    const jobId = `job_bola_oracle_${Date.now()}`;
    const existing = await runGatewayInvoke({ employeeId: "emp_comm", credentialId: "cred_comm", body: slackBody(ORG_B, B_CHANNEL, jobId) });
    const ghost = await runGatewayInvoke({ employeeId: "emp_comm", credentialId: "cred_comm", body: slackBody(ORG_GHOST, B_CHANNEL, jobId) });
    expect(existing.httpStatus).toBe(403);
    expect(ghost.httpStatus).toBe(existing.httpStatus);
    expect(ghost.body).toEqual(existing.body);
  });

  test("exactly one audit row, under the authenticated org only, with the supplied org hashed", async () => {
    const jobId = `job_bola_audit_${Date.now()}`;
    await runGatewayInvoke({ employeeId: "emp_comm", credentialId: "cred_comm", body: slackBody(ORG_B, B_CHANNEL, jobId) });
    const rows = (await listAuditEvents(ORG_A, 1000)).filter(
      (r) => r.action === "gateway.conversation_org_mismatch" && (r.metadata as Record<string, unknown>)?.jobId === jobId
    );
    expect(rows.length).toBe(1);
    const raw = JSON.stringify(rows[0]);
    expect(raw).not.toContain(ORG_B);
    expect(raw).not.toContain("社外秘");
    const md = rows[0].metadata as Record<string, unknown>;
    expect(md.suppliedOrgIdSha256).toBe(sha(ORG_B));
    expect(md.tool).toBe("comm.reply");
    const inB = (await listAuditEvents(ORG_B, 1000)).filter((r) => JSON.stringify(r).includes(jobId));
    expect(inB.length).toBe(0);
  });

  test("conversation.orgId equal to the authenticated org (any case/space) behaves exactly as when absent", async () => {
    const ch = "C0UNREGSAMEORG";
    const absent = await runGatewayInvoke({ employeeId: "emp_comm", credentialId: "cred_comm", body: slackBody(undefined, ch, "job_same_a") });
    const same = await runGatewayInvoke({ employeeId: "emp_comm", credentialId: "cred_comm", body: slackBody(ORG_A, ch, "job_same_b") });
    const padded = await runGatewayInvoke({ employeeId: "emp_comm", credentialId: "cred_comm", body: slackBody(`  ${ORG_A.toUpperCase()} `, ch, "job_same_c") });
    expect(absent.httpStatus).toBe(403);
    expect(absent.body.code).toBe("egress_denied");
    for (const r of [same, padded]) {
      expect(r.httpStatus).toBe(absent.httpStatus);
      expect(r.body.code).toBe(absent.body.code);
      expect(r.body.error).toBe(absent.body.error);
      expect(r.body.egress).toEqual(absent.body.egress);
    }
  });

  test("same-org needs_approval: snapshot carries the authenticated org", async () => {
    const body: GatewayInvokeRequest = {
      ...slackBody(ORG_A, "C_INTERNAL"),
      informationClass: "confidential",
    };
    const queued = await runGatewayInvoke({ employeeId: "emp_comm", credentialId: "cred_comm", body });
    expect(queued.httpStatus).toBe(402);
    const stored = await getApprovalById(String(queued.body.approvalId), ORG_A);
    expect(parseInvokeSnapshot(stored?.metadata)?.conversation?.orgId).toBe(ORG_A);
  });
});

function demoCred(): ResolvedEmployeeCredential {
  return {
    employeeId: "emp_comm",
    orgId: ORG_A,
    credentialId: "cred_emp_comm",
    generation: 1,
    fingerprint: "fixture-hash",
    secretPrefix: "gb_emp_fixture",
    binding: { employeeId: "emp_comm", orgId: ORG_A },
  } as unknown as ResolvedEmployeeCredential;
}

describe("MCP staffpass_invoke path", () => {
  test("conversation.orgId=B → isError tool result with conversation_org_mismatch; B never touched", async () => {
    await upsertConversationAdapter({ orgId: ORG_B, surface: "slack", enabled: true, secrets: { botToken: B_TOKEN } });
    mockSlack(true);
    const result = await callStaffpassMcpTool(
      "staffpass_invoke",
      {
        tool: "comm.reply",
        purpose: "comm.internal",
        jobId: `job_mcp_bola_${Date.now()}`,
        conversation: { surface: "slack", orgId: ORG_B, slackChannelId: "C0BMCP0001" },
        payload: { slackChannelId: "C0BMCP0001", text: "本文" },
      },
      demoCred()
    );
    const data = result.structuredContent as Record<string, unknown>;
    expect(result.isError).toBe(true);
    expect(data.code).toBe("conversation_org_mismatch");
    expect(slackAuth.some((h) => h.includes(B_TOKEN))).toBe(false);
    expect(await getOrgChannel(ORG_B, "slack", "C0BMCP0001")).toBeNull();
  });
});

describe("approval fulfil path", () => {
  test("a pending approval whose snapshot carries a forged conversation.orgId is refused at fulfil (row org wins)", async () => {
    const queued = await runGatewayInvoke({
      employeeId: "emp_comm",
      credentialId: "cred_comm",
      body: { ...slackBody(undefined, "C_INTERNAL"), informationClass: "confidential" },
    });
    expect(queued.httpStatus).toBe(402);
    const approvalId = String(queued.body.approvalId);
    // Simulate a prod row created before the fix with a forged org in the snapshot.
    const stored = await getApprovalById(approvalId, ORG_A);
    type SnapMeta = { invoke: { conversation: { orgId?: string } } };
    (stored!.metadata as unknown as SnapMeta).invoke.conversation.orgId = ORG_B;
    await upsertConversationAdapter({ orgId: ORG_A, surface: "slack", enabled: true, secrets: { botToken: "xoxb-org-a" } });
    await upsertConversationAdapter({ orgId: ORG_B, surface: "slack", enabled: true, secrets: { botToken: B_TOKEN } });
    mockSlack(true);
    const approved = await resolveApproval(approvalId, "approved", "ando@example.com", ORG_A);
    (approved!.metadata as unknown as SnapMeta).invoke.conversation.orgId = ORG_B;
    const fulfillment = await fulfillApprovedInvoke(approved!);
    expect(fulfillment?.ok).toBe(false);
    expect(fulfillment?.error).toBe("fulfill_blocked_conversation_org_mismatch");
    expect(slackAuth.length).toBe(0);
    const rows = (await listAuditEvents(ORG_A, 1000)).filter(
      (r) => (r.metadata as Record<string, unknown>)?.approvalId === approvalId &&
        (r.metadata as Record<string, unknown>)?.code === "fulfill_blocked_conversation_org_mismatch"
    );
    expect(rows.length).toBe(1);
    expect(JSON.stringify(rows[0])).not.toContain(ORG_B);
  });

  test("snapshot built from a forged body is bound to the approval row org", async () => {
    // Even if a forged body reached buildInvokeSnapshot, the conversation org is the row's.
    const { buildInvokeSnapshot } = await import("@/lib/approvals/fulfill");
    const snap = buildInvokeSnapshot({
      tool: "comm.reply",
      purpose: "comm.internal",
      jobId: "job_snap",
      orgId: ORG_A,
      employeeId: "emp_comm",
      body: slackBody(ORG_B, "C_INTERNAL"),
    } as never);
    expect(snap.conversation?.orgId).toBe(ORG_A);
  });
});

/**
 * 木村's repro (2026-10-09, main e0aeda1), pinned on every path:
 *   CBINTERNAL is internal in org B's ledger. An org-A employee's comm.reply
 *   to it WITHOUT conversation.orgId is denied; WITH conversation.orgId=B it
 *   was allowed and auto-posted with no approval (MCP and HTTP).
 * Paths here: MCP, fulfil after approval, stuck-watch admin re-run, ledger
 * retry (HTTP is in app/api/gateway/invoke/conversation-org-binding.route.test.ts).
 * Plus: AI-supplied slackTeamId / speakerTeamId can no longer make a speaker
 * internal; only a Slack-verified team (users.info, org's own token) or the
 * ledger counts, anything unverifiable stays external.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetSlackUserTeamCacheForTests } from "@/lib/slack/bot-token";
import { DEMO_ORG, pushRuntimeAuditEvent } from "@/lib/demo-data";
import { createApproval, getApprovalById, resolveApproval } from "@/lib/data";
import { upsertOrgChannel } from "@/lib/data/directory";
import { upsertConversationAdapter } from "@/lib/data/conversation-adapters";
import { setOrgInternalAudienceRule, clearDemoRule } from "@/lib/data/internal-audience-rule";
import { fulfillApprovedInvoke } from "@/lib/approvals/fulfill";
import { callStaffpassMcpTool } from "@/lib/mcp/tools";
import { runGatewayInvoke } from "@/lib/gateway/invoke";
import { parseConversationContext, resolveAudience } from "@/lib/gateway/audience";
import { runStuckWatchRetry } from "@/lib/stuck-watch/admin-handlers";
import { supplementInvokeBodyFromLedger } from "@/lib/stuck-watch/audience-ledger";
import { w1ItemId } from "@/lib/stuck-watch/w1-mention-unanswered";
import type { ResolvedEmployeeCredential } from "@/lib/auth/employee-credential";
import type { GatewayInvokeRequest } from "@/lib/types";

const ORG_A = DEMO_ORG.id;
const ORG_B = "org_kimura_repro_b";
const CH = "CBINTERNAL";
const A_TOKEN = "xoxb-org-a-repro";
const originalFetch = globalThis.fetch;
let posts: Array<{ auth: string; channel: string }> = [];
let usersInfoTeam: string | null = null;
let slackCalls: string[] = [];

function mockSlack() {
  posts = [];
  slackCalls = [];
  delete process.env.SLACK_BOT_TOKEN;
  delete process.env.SLACK_CONVERSATION_BOT_TOKEN;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const auth = new Headers(init?.headers).get("authorization") || "";
    slackCalls.push(`${url.split("/api/")[1] ?? url} ${auth}`);
    if (url.includes("chat.postMessage")) {
      const payload = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
      posts.push({ auth, channel: String(payload.channel) });
      return Response.json({ ok: true, channel: payload.channel, ts: "1787960001.000001" });
    }
    if (url.includes("users.info")) {
      return usersInfoTeam
        ? Response.json({ ok: true, user: { id: "U0SPEAKER", team_id: usersInfoTeam } })
        : Response.json({ ok: false, error: "user_not_found" });
    }
    if (url.includes("conversations.info")) {
      return Response.json({ ok: true, channel: { id: CH, is_ext_shared: false } });
    }
    return Response.json({ ok: false, error: "unexpected_fetch" });
  }) as typeof fetch;
}

beforeEach(async () => {
  resetSlackUserTeamCacheForTests();
  await upsertOrgChannel({ orgId: ORG_B, surface: "slack", externalId: CH, classification: "internal", skipInspect: true });
  await upsertConversationAdapter({ orgId: ORG_A, surface: "slack", enabled: true, secrets: { botToken: A_TOKEN } });
  usersInfoTeam = null;
  mockSlack();
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  clearDemoRule();
  await upsertConversationAdapter({ orgId: ORG_A, surface: "slack", enabled: false, secrets: {} }).catch(() => undefined);
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

function mcpReply(orgId?: string) {
  return callStaffpassMcpTool(
    "staffpass_invoke",
    {
      tool: "comm.reply",
      purpose: "comm.internal",
      jobId: `job_kimura_mcp_${Math.random().toString(36).slice(2, 8)}`,
      conversation: { surface: "slack", ...(orgId ? { orgId } : {}), slackChannelId: CH },
      payload: { slackChannelId: CH, text: "木村 repro 本文" },
    },
    demoCred()
  );
}

describe("木村 repro — MCP staffpass_invoke", () => {
  test("without conversation.orgId: denied, nothing posted (baseline, unchanged)", async () => {
    const r = await mcpReply();
    const data = r.structuredContent as Record<string, unknown>;
    expect(r.isError).toBe(true);
    expect(data.code).toBe("egress_denied");
    expect(posts.length).toBe(0);
  });

  test("with conversation.orgId=B: refused (conversation_org_mismatch), nothing posted, B never consulted", async () => {
    const r = await mcpReply(ORG_B);
    const data = r.structuredContent as Record<string, unknown>;
    expect(posts.length).toBe(0);
    expect(r.isError).toBe(true);
    expect(data.code).toBe("conversation_org_mismatch");
    expect(JSON.stringify(data)).not.toContain("internal_internal");
  });

  test("with conversation.orgId=A (matching): identical to omitting it", async () => {
    const r = await mcpReply(ORG_A);
    const data = r.structuredContent as Record<string, unknown>;
    expect(data.code).toBe("egress_denied");
    expect(posts.length).toBe(0);
  });
});

describe("木村 repro — fulfil after approval", () => {
  test("comm.reply (confidential) with orgId=B: no approval is created and nothing is ever posted", async () => {
    const body: GatewayInvokeRequest = {
      tool: "comm.reply",
      purpose: "comm.internal",
      jobId: `job_kimura_ful_${Date.now()}`,
      informationClass: "confidential",
      conversation: { surface: "slack", orgId: ORG_B, slackChannelId: CH },
      args: { slackChannelId: CH, text: "承認後に投稿される本文" },
    };
    const queued = await runGatewayInvoke({ employeeId: "emp_comm", credentialId: "cred_comm", body });
    if (queued.httpStatus === 402 && queued.body.approvalId) {
      // main: B's verdict made this an ordinary approval; approve + fulfil like a human would.
      const approved = await resolveApproval(String(queued.body.approvalId), "approved", "ando@example.com", ORG_A);
      await fulfillApprovedInvoke(approved!);
    }
    expect(posts.length).toBe(0);
    expect(queued.httpStatus).toBe(403);
    expect(queued.body.code).toBe("conversation_org_mismatch");
  });

  test("a pre-fix pending approval whose snapshot names B is refused at fulfil after approval (row org wins)", async () => {
    const jobId = `job_kimura_prefix_${Date.now()}`;
    const { approval } = await createApproval({
      orgId: ORG_A,
      employeeId: "emp_comm",
      credentialId: "cred_comm",
      title: "pre-fix forged snapshot",
      purpose: "comm.internal",
      summary: "s",
      risk: "medium",
      tool: "comm.reply",
      jobId,
      metadata: {
        invoke: {
          tool: "comm.reply", purpose: "comm.internal", jobId, employeeId: "emp_comm", orgId: ORG_A, postingAs: "bot",
          conversation: { surface: "slack", orgId: ORG_B, slackChannelId: CH },
          args: { slackChannelId: CH, text: "承認後に投稿される本文" },
        },
      },
    } as never);
    const approved = await resolveApproval(approval.id, "approved", "ando@example.com", ORG_A);
    const f = await fulfillApprovedInvoke(approved!);
    expect(posts.length).toBe(0);
    expect(f?.ok).toBe(false);
    expect(f?.error).toBe("fulfill_blocked_conversation_org_mismatch");
    expect((await getApprovalById(approval.id, ORG_A))?.status).toBe("approved");
  });
});

describe("木村 repro — stuck-watch admin re-run (pre-fix snapshot)", () => {
  test("re-run discards the snapshot's conversation.orgId and uses the approval row org: denied, nothing posted", async () => {
    const jobId = `job_kimura_sw_${Date.now()}`;
    const ts = `${Math.floor(Date.now() / 1000)}.000100`;
    const wakeChannel = `CWAKESW${Date.now().toString(36).toUpperCase()}`;
    const itemId = w1ItemId(wakeChannel, ts);
    pushRuntimeAuditEvent({
      orgId: ORG_A, employeeId: "emp_comm", credentialId: null, action: "slack.mention_wake", purpose: "slack.mention",
      summary: "wake", metadata: { reason: "woke", channel: wakeChannel, ts }, createdAt: new Date(Date.now() - 20 * 60_000).toISOString(),
    });
    const { approval } = await createApproval({
      orgId: ORG_A, employeeId: "emp_comm", credentialId: "cred_comm", title: "pre-fix", purpose: "comm.internal",
      summary: "s", risk: "medium", tool: "comm.reply", jobId,
      metadata: {
        invoke: {
          tool: "comm.reply", purpose: "comm.internal", jobId, employeeId: "emp_comm", orgId: ORG_A, postingAs: "bot",
          conversation: { surface: "slack", orgId: ORG_B, slackChannelId: CH },
          args: { slackChannelId: CH, text: "stuck-watch 再実行の本文" },
        },
      },
    } as never);
    await resolveApproval(approval.id, "rejected", "ando@example.com", ORG_A);
    pushRuntimeAuditEvent({
      orgId: ORG_A, employeeId: "emp_comm", credentialId: "cred_comm", action: "tool.invoke", purpose: "comm.internal",
      summary: "post failed", metadata: { tool: "comm.reply", code: "slack_post_failed", jobId },
      createdAt: new Date(Date.now() - 19 * 60_000).toISOString(),
    });
    const retry = await runStuckWatchRetry(ORG_A, { itemId }, "admin_test");
    expect(posts.length).toBe(0);
    expect(retry.ok).toBe(false);
    const invoked = (retry.retry ?? {}) as Record<string, unknown>;
    expect(JSON.stringify(invoked)).not.toContain("internal_internal");
  });
});

describe("audience-ledger retry: orgId is ALWAYS the auth org", () => {
  test("supplementInvokeBodyFromLedger overwrites an already-set conversation.orgId", async () => {
    const out = await supplementInvokeBodyFromLedger(ORG_A, {
      tool: "comm.reply", purpose: "comm.internal", jobId: "j",
      conversation: { surface: "slack", orgId: ORG_B, slackChannelId: CH },
    } as GatewayInvokeRequest);
    expect((out.conversation as Record<string, unknown>).orgId).toBe(ORG_A);
  });
});

describe("slackTeamId / speakerTeamId: only a server-verified team counts", () => {
  const ctxWith = (team: Record<string, string>) =>
    parseConversationContext(
      { tool: "comm.reply", purpose: "comm.internal", conversation: { surface: "slack", slackUserId: "U0SPEAKER", ...team } } as GatewayInvokeRequest,
      ORG_A
    )!;

  beforeEach(async () => {
    await setOrgInternalAudienceRule(ORG_A, { slackTeamIds: ["T0AINTERNAL"], autoSlackTeamInternal: true }, "test");
  });

  test("AI-claimed speakerTeamId / slackTeamId / args.teamId of the internal team, Slack says another team → not internal", async () => {
    usersInfoTeam = "T0OUTSIDER";
    const claims: Array<Record<string, string>> = [{ speakerTeamId: "T0AINTERNAL" }, { slackTeamId: "T0AINTERNAL" }];
    for (const team of claims) {
      const v = await resolveAudience(ctxWith(team));
      expect(v.audience).not.toBe("internal");
      expect(v.effectiveAudience).toBe("external");
    }
  });

  test("unverifiable (users.info fails / no token) → not internal even with a claimed internal team", async () => {
    usersInfoTeam = null;
    const v = await resolveAudience(ctxWith({ speakerTeamId: "T0AINTERNAL" }));
    expect(v.audience).not.toBe("internal");
    await upsertConversationAdapter({ orgId: ORG_A, surface: "slack", enabled: false, secrets: {} });
    const v2 = await resolveAudience(ctxWith({ speakerTeamId: "T0AINTERNAL" }));
    expect(v2.audience).not.toBe("internal");
  });

  test("Slack-verified internal team (users.info with A's own token) → internal, no AI claim needed", async () => {
    usersInfoTeam = "T0AINTERNAL";
    const v = await resolveAudience(ctxWith({}));
    expect(v.audience).toBe("internal");
    expect(slackCalls.some((c) => c.startsWith("users.info") && c.endsWith(`Bearer ${A_TOKEN}`))).toBe(true);
  });

  test("gateway: comm.reply to a Slack user with a forged internal speakerTeamId is not auto-posted", async () => {
    usersInfoTeam = "T0OUTSIDER";
    const r = await runGatewayInvoke({
      employeeId: "emp_comm", credentialId: "cred_comm",
      body: {
        tool: "comm.reply", purpose: "comm.internal", jobId: `job_team_${Date.now()}`,
        conversation: { surface: "slack", slackChannelId: "C0UNREGTEAM", speakerId: "U0SPEAKER", speakerTeamId: "T0AINTERNAL" },
        args: { slackChannelId: "C0UNREGTEAM", text: "本文" },
      } as GatewayInvokeRequest,
    });
    expect(posts.length).toBe(0);
    expect(r.httpStatus).not.toBe(200);
  });
});

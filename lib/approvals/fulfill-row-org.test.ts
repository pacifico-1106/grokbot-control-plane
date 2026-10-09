/**
 * Fulfil posts under the approval ROW's org only. A snapshot whose top-level
 * orgId names another org (forged / pre-fix) must never select that org's
 * Slack token.
 */
import { afterEach, expect, test } from "bun:test";
import { DEMO_ORG } from "@/lib/demo-data";
import { createApproval, resolveApproval } from "@/lib/data";
import { upsertConversationAdapter } from "@/lib/data/conversation-adapters";
import { fulfillApprovedInvoke } from "@/lib/approvals/fulfill";

const ORG_B = "org_fulfil_row_org_b";
const originalFetch = globalThis.fetch;

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await upsertConversationAdapter({ orgId: DEMO_ORG.id, surface: "slack", enabled: false, secrets: {} }).catch(() => undefined);
  await upsertConversationAdapter({ orgId: ORG_B, surface: "slack", enabled: false, secrets: {} }).catch(() => undefined);
});

test("snapshot.orgId=B on an org-A approval: refused, B's token never used", async () => {
  delete process.env.SLACK_BOT_TOKEN;
  delete process.env.SLACK_CONVERSATION_BOT_TOKEN;
  await upsertConversationAdapter({ orgId: DEMO_ORG.id, surface: "slack", enabled: true, secrets: { botToken: "xoxb-row-a" } });
  await upsertConversationAdapter({ orgId: ORG_B, surface: "slack", enabled: true, secrets: { botToken: "xoxb-row-b" } });
  const auths: string[] = [];
  globalThis.fetch = (async (input, init) => {
    if (String(input).includes("chat.postMessage")) {
      auths.push(new Headers(init?.headers).get("authorization") || "");
      return Response.json({ ok: true, channel: "C_INTERNAL", ts: "1787960009.000001" });
    }
    return Response.json({ ok: false, error: "unexpected" });
  }) as typeof fetch;
  const jobId = `job_row_org_${Math.random().toString(36).slice(2, 8)}`;
  const { approval } = await createApproval({
    orgId: DEMO_ORG.id, employeeId: "emp_comm", credentialId: "cred_comm", title: "row org", purpose: "comm.internal",
    summary: "s", risk: "medium", tool: "comm.reply", jobId,
    metadata: {
      invoke: {
        tool: "comm.reply", purpose: "comm.internal", jobId, employeeId: "emp_comm", orgId: ORG_B, postingAs: "bot",
        conversation: { surface: "slack", slackChannelId: "C_INTERNAL" },
        args: { slackChannelId: "C_INTERNAL", text: "承認済みの本文" },
      },
    },
  } as never);
  const approved = await resolveApproval(approval.id, "approved", "ando@example.com", DEMO_ORG.id);
  const result = await fulfillApprovedInvoke(approved!);
  // execution-authority refuses the mismatched snapshot before any Slack call.
  expect(result?.ok).toBe(false);
  expect(result?.error).toBe("approval_target_mismatch");
  expect(auths).toEqual([]);
});

test("snapshot without orgId on an org-A approval: posts with A's token", async () => {
  delete process.env.SLACK_BOT_TOKEN;
  delete process.env.SLACK_CONVERSATION_BOT_TOKEN;
  await upsertConversationAdapter({ orgId: DEMO_ORG.id, surface: "slack", enabled: true, secrets: { botToken: "xoxb-row-a" } });
  await upsertConversationAdapter({ orgId: ORG_B, surface: "slack", enabled: true, secrets: { botToken: "xoxb-row-b" } });
  const auths: string[] = [];
  globalThis.fetch = (async (input, init) => {
    if (String(input).includes("chat.postMessage")) {
      auths.push(new Headers(init?.headers).get("authorization") || "");
      return Response.json({ ok: true, channel: "C_INTERNAL", ts: "1787960009.000002" });
    }
    return Response.json({ ok: false, error: "unexpected" });
  }) as typeof fetch;
  const jobId = `job_row_org_${Math.random().toString(36).slice(2, 8)}`;
  const { approval } = await createApproval({
    orgId: DEMO_ORG.id, employeeId: "emp_comm", credentialId: "cred_comm", title: "row org", purpose: "comm.internal",
    summary: "s", risk: "medium", tool: "comm.reply", jobId,
    metadata: {
      invoke: {
        tool: "comm.reply", purpose: "comm.internal", jobId, employeeId: "emp_comm", postingAs: "bot",
        conversation: { surface: "slack", slackChannelId: "C_INTERNAL" },
        args: { slackChannelId: "C_INTERNAL", text: "承認済みの本文" },
      },
    },
  } as never);
  const approved = await resolveApproval(approval.id, "approved", "ando@example.com", DEMO_ORG.id);
  const result = await fulfillApprovedInvoke(approved!);
  expect(auths).toEqual(["Bearer xoxb-row-a"]);
  expect(result?.ok).toBe(true);
});

/**
 * comm.reply honours an explicit per-tool `always_human` setting
 * (employee.toolApprovalDefaults["comm.reply"] === "always_human").
 *
 * Before this change the setting was ignored twice:
 *   1. lib/gateway/tools.ts toolRequiresHumanApproval returned false for every
 *      audience-gated tool (slack.* / comm.*) before reading the hint.
 *   2. lib/employees/approval-presets.ts normalizeToolApprovalDefaults kept only
 *      `deny` for non-choosable outbound tools, so a stored `always_human`
 *      was dropped on write and on read (DB row mapper).
 * Stricter-only: auto / risk_based / unset keep the audience × class decision,
 * deny keeps the immediate 403, egress deny keeps winning (no approval card).
 * Scope: all four audience-gated tools — comm.reply, plus comm.send /
 * slack.post / slack.post_external (木村 2026-10-04, same PR #249).
 *
 * Demo mode, dummy ids, Slack fetch mocked, no network.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { ResolvedEmployeeCredential } from "@/lib/auth/employee-credential";
import { fulfillApprovedInvoke, parseFulfillment } from "@/lib/approvals/fulfill";
import { getApprovalById, resolveApproval } from "@/lib/data";
import { upsertConversationAdapter } from "@/lib/data/conversation-adapters";
import { mapEmployeeRow } from "@/lib/data/mappers";
import { DEMO_ORG, getRuntimeEmployees } from "@/lib/demo-data";
import { normalizeToolApprovalDefaults } from "@/lib/employees/approval-presets";
import { getEmployeeById, updateEmployeePolicy } from "@/lib/data/employees";
import { runGatewayInvoke } from "@/lib/gateway/invoke";
import {
  AUDIENCE_GATED_ALWAYS_HUMAN_HINT_TOOL_IDS,
  GATEWAY_TOOL_DEFS,
  isAudienceGatedTool,
  listGatewayToolIds,
  toolRequiresHumanApproval,
} from "@/lib/gateway/tools";
import { callStaffpassMcpTool } from "@/lib/mcp/tools";
import type { ApprovalPolicy, Employee, GatewayInvokeRequest } from "@/lib/types";

type Hint = ApprovalPolicy | "deny";
const restorers: Array<() => void> = [];
const originalFetch = globalThis.fetch;

function setHints(hints: Record<string, Hint> | undefined) {
  const emp = getRuntimeEmployees().find((item) => item.id === "emp_comm");
  expect(emp).toBeTruthy();
  const previous = { ...emp! };
  Object.assign(emp!, { toolApprovalDefaults: hints as Employee["toolApprovalDefaults"] });
  restorers.push(() => Object.assign(emp!, previous));
  expect(emp!.approvalPolicy).toBe("risk_based"); // not the employee-wide always_human path
}

/** Enable the Slack adapter with a mocked chat.postMessage; returns posted payloads. */
async function mockSlack() {
  delete process.env.SLACK_BOT_TOKEN;
  delete process.env.SLACK_CONVERSATION_BOT_TOKEN;
  await upsertConversationAdapter({ orgId: DEMO_ORG.id, surface: "slack", enabled: true, secrets: { botToken: "xoxb-reply-ah-test" } });
  const posts: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (input, init) => {
    if (String(input).includes("chat.postMessage")) {
      const payload = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
      posts.push(payload);
      return Response.json({ ok: true, channel: String(payload.channel || "C_INTERNAL"), ts: `1787911800.0000${posts.length}` });
    }
    return Response.json({ ok: true });
  }) as typeof fetch;
  return posts;
}

afterEach(async () => {
  while (restorers.length) restorers.pop()!();
  globalThis.fetch = originalFetch;
  await upsertConversationAdapter({ orgId: DEMO_ORG.id, surface: "slack", enabled: false, secrets: {} }).catch(() => undefined);
});

const jid = (s: string) => `job_reply_ah_${s}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
const THREAD = "1787911797.502889";

/** Internal channel thread reply: egress allow → auto-posts when no setting forces approval. */
function channelReply(jobId = jid("ch"), text = "社内スレッドへの返信です。"): GatewayInvokeRequest {
  return {
    tool: "comm.reply",
    purpose: "comm.internal",
    jobId,
    conversation: { surface: "slack", orgId: DEMO_ORG.id, slackChannelId: "C_INTERNAL", threadId: THREAD },
    args: { slackChannelId: "C_INTERNAL", text, threadId: THREAD },
  };
}

/** Internal DM to an internal member (explicit DM intent) — the "no approval needed" path. */
function dmReply(jobId = jid("dm")): GatewayInvokeRequest {
  return {
    tool: "comm.reply",
    purpose: "comm.internal",
    jobId,
    conversation: { surface: "slack", orgId: DEMO_ORG.id, slackUserId: "U_YAMADA" },
    args: { text: "DMへの返信です。", dm: true },
  };
}

const invoke = (body: GatewayInvokeRequest) =>
  runGatewayInvoke({ employeeId: "emp_comm", credentialId: "cred_comm", body });

describe("toolRequiresHumanApproval: comm.reply", () => {
  const def = GATEWAY_TOOL_DEFS["comm.reply"];
  test("explicit always_human → true (before: false, hint ignored)", () => {
    expect(toolRequiresHumanApproval(def, { "comm.reply": "always_human" })).toBe(true);
  });
  test("unset / auto / risk_based → unchanged (false; audience × class decides)", () => {
    expect(toolRequiresHumanApproval(def)).toBe(false);
    expect(toolRequiresHumanApproval(def, {})).toBe(false);
    expect(toolRequiresHumanApproval(def, { "comm.reply": "auto" })).toBe(false);
    expect(toolRequiresHumanApproval(def, { "comm.reply": "risk_based" })).toBe(false);
  });
});

describe("normalizeToolApprovalDefaults / DB mapper keep comm.reply always_human", () => {
  test("always_human survives normalization (before: dropped)", () => {
    expect(normalizeToolApprovalDefaults({ "comm.reply": "always_human" })["comm.reply"]).toBe("always_human");
  });
  test("auto / risk_based for comm.reply are still ignored; deny still kept", () => {
    expect(normalizeToolApprovalDefaults({ "comm.reply": "auto" })["comm.reply"]).toBeUndefined();
    expect(normalizeToolApprovalDefaults({ "comm.reply": "risk_based" })["comm.reply"]).toBeUndefined();
    expect(normalizeToolApprovalDefaults({ "comm.reply": "deny" })["comm.reply"]).toBe("deny");
    expect(normalizeToolApprovalDefaults({})["comm.reply"]).toBeUndefined();
  });
  test("DB row mapper keeps a stored comm.reply always_human", () => {
    const emp = mapEmployeeRow({
      id: "emp_x", org_id: DEMO_ORG.id, display_name: "x", status: "active", scopes: [],
      tool_approval_defaults: { "comm.reply": "always_human" },
    });
    expect(emp.toolApprovalDefaults?.["comm.reply"]).toBe("always_human");
  });
});

describe("gateway: comm.reply with always_human always goes to human approval", () => {
  test("control: internal thread reply without a setting auto-posts (unchanged)", async () => {
    setHints(undefined);
    const posts = await mockSlack();
    const r = await invoke(channelReply());
    expect(r.httpStatus).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.needs_approval).not.toBe(true);
    expect((r.body.egress as { decision?: string } | undefined)?.decision).toBe("allow");
    expect(posts.length).toBe(1);
  });

  for (const hint of ["auto", "risk_based"] as const) {
    test(`control: ${hint} → auto-posts as before`, async () => {
      setHints({ "comm.reply": hint });
      const posts = await mockSlack();
      const r = await invoke(channelReply());
      expect(r.httpStatus).toBe(200);
      expect(r.body.needs_approval).not.toBe(true);
      expect(posts.length).toBe(1);
    });
  }

  test("always_human: internal thread reply → 402 needs_approval, nothing posted (before: 200 auto-posted)", async () => {
    setHints({ "comm.reply": "always_human" });
    const posts = await mockSlack();
    const r = await invoke(channelReply());
    expect(r.httpStatus).toBe(402);
    expect(r.body.needs_approval).toBe(true);
    expect(String(r.body.approvalId || "")).toBeTruthy();
    expect(posts.length).toBe(0);
    const stored = await getApprovalById(String(r.body.approvalId), DEMO_ORG.id);
    expect(stored?.status).toBe("pending");
    expect(stored?.tool).toBe("comm.reply");
  });

  test("control: internal DM reply without a setting auto-posts (unchanged)", async () => {
    setHints(undefined);
    const posts = await mockSlack();
    const r = await invoke(dmReply());
    expect(r.httpStatus).toBe(200);
    expect(r.body.needs_approval).not.toBe(true);
    expect(posts.length).toBe(1);
  });

  test("always_human: internal DM reply (normally no approval) → 402, nothing posted (before: 200 auto-posted)", async () => {
    setHints({ "comm.reply": "always_human" });
    const posts = await mockSlack();
    const r = await invoke(dmReply());
    expect(r.httpStatus).toBe(402);
    expect(r.body.needs_approval).toBe(true);
    expect(posts.length).toBe(0);
  });

  test("deny → 403 tool_denied_by_tool_setting, no approval card (unchanged)", async () => {
    setHints({ "comm.reply": "deny" });
    const posts = await mockSlack();
    const r = await invoke(channelReply());
    expect(r.httpStatus).toBe(403);
    expect(r.body.code).toBe("tool_denied_by_tool_setting");
    expect(r.body.needs_approval).toBe(false);
    expect(r.body.approvalId).toBeUndefined();
    expect(posts.length).toBe(0);
  });

  test("egress deny still wins over always_human (no approval card for a denied audience)", async () => {
    setHints({ "comm.reply": "always_human" });
    const r = await invoke({
      tool: "comm.reply",
      purpose: "comm.internal",
      jobId: jid("shared"),
      conversation: { surface: "slack", orgId: DEMO_ORG.id, slackChannelId: "C_SHARED" },
      args: { slackChannelId: "C_SHARED", text: "社外混在への返信" },
    });
    expect(r.httpStatus).toBe(403);
    expect(r.body.code).toBe("egress_denied");
    expect(r.body.needs_approval).not.toBe(true);
  });

});

describe("approved re-run follows the existing approved-execution pattern", () => {
  async function queueAndApprove(text = "承認対象の返信本文") {
    setHints({ "comm.reply": "always_human" });
    const body = channelReply(jid("approve"), text);
    const queued = await invoke(body);
    expect(queued.httpStatus).toBe(402);
    const approvalId = String(queued.body.approvalId || "");
    const approved = await resolveApproval(approvalId, "approved", "ando@example.com", DEMO_ORG.id);
    expect(approved?.status).toBe("approved");
    return { body, approvalId, approved: approved! };
  }

  test("re-invoke with approvalId → posts the approved text once, no new approval", async () => {
    const { body, approvalId } = await queueAndApprove();
    const posts = await mockSlack();
    const r = await invoke({ ...body, approvalId });
    expect(r.httpStatus).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.needs_approval).not.toBe(true);
    expect(posts.length).toBe(1);
    expect(posts[0].text).toBe("承認対象の返信本文");
    expect(posts[0].thread_ts).toBe(THREAD);
    // a second re-run does not post again
    const again = await invoke({ ...body, approvalId });
    expect(again.httpStatus).toBe(200);
    expect(again.body.needs_approval).not.toBe(true);
    expect(posts.length).toBe(1);
  });

  test("approve-time fulfillment posts once; re-invoke afterwards reuses it (no double post)", async () => {
    const { body, approvalId, approved } = await queueAndApprove();
    const posts = await mockSlack();
    const f = await fulfillApprovedInvoke(approved);
    expect(f?.ok).toBe(true);
    expect(posts.length).toBe(1);
    const r = await invoke({ ...body, approvalId });
    expect(r.httpStatus).toBe(200);
    expect(r.body.needs_approval).not.toBe(true);
    expect(posts.length).toBe(1);
    expect(parseFulfillment((await getApprovalById(approvalId, DEMO_ORG.id))?.metadata)?.ok).toBe(true);
  });

  test("re-run uses the approved snapshot, not a replacement text in the request", async () => {
    const { body, approvalId } = await queueAndApprove("承認された本文");
    const posts = await mockSlack();
    const r = await invoke({ ...body, args: { ...body.args, text: "差し替えた本文" }, approvalId });
    expect(r.httpStatus).toBe(200);
    expect(posts.length).toBe(1);
    expect(posts[0].text).toBe("承認された本文");
  });

  test("an approval for another job does not unlock this reply (new approval required)", async () => {
    const { approvalId } = await queueAndApprove();
    const posts = await mockSlack();
    const r = await invoke({ ...channelReply(jid("other")), approvalId });
    expect(r.httpStatus).toBe(402);
    expect(r.body.needs_approval).toBe(true);
    expect(posts.length).toBe(0);
  });

  test("still pending (not approved) approvalId does not unlock the reply", async () => {
    setHints({ "comm.reply": "always_human" });
    const body = channelReply(jid("pending"));
    const queued = await invoke(body);
    const posts = await mockSlack();
    const r = await invoke({ ...body, approvalId: String(queued.body.approvalId) });
    expect(r.httpStatus).toBe(402);
    expect(posts.length).toBe(0);
  });

  test("deny set after approval stops the approved re-run (unchanged deny re-check)", async () => {
    const { body, approvalId } = await queueAndApprove();
    setHints({ "comm.reply": "deny" });
    const posts = await mockSlack();
    const r = await invoke({ ...body, approvalId });
    expect(r.httpStatus).toBe(403);
    expect(posts.length).toBe(0);
  });
});

describe("employee MCP staffpass_invoke", () => {
  function cred(): ResolvedEmployeeCredential {
    return {
      employeeId: "emp_comm",
      orgId: DEMO_ORG.id,
      credentialId: "cred_comm",
      generation: 1,
      fingerprint: "fixture-hash",
      secretPrefix: "gb_emp_fixture",
      binding: {
        status: "linked",
        employeeId: "emp_comm",
        orgId: DEMO_ORG.id,
        credentialGeneration: 1,
        grokBotAgentId: "agent_test",
        grokBotWorkspaceId: null,
        credentialFingerprint: null,
        lastSuccessAt: null,
        lastError: null,
        wakeWebhookUrl: null,
        hasWakeWebhook: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    };
  }

  test("comm.reply with always_human returns needs_approval with poll fields, nothing posted", async () => {
    setHints({ "comm.reply": "always_human" });
    const posts = await mockSlack();
    const res = await callStaffpassMcpTool(
      "staffpass_invoke",
      {
        tool: "comm.reply",
        purpose: "comm.internal",
        jobId: jid("mcp"),
        conversation: { surface: "slack", orgId: DEMO_ORG.id, slackChannelId: "C_INTERNAL", threadId: THREAD },
        payload: { slackChannelId: "C_INTERNAL", text: "MCP経由の返信", threadId: THREAD },
      },
      cred()
    );
    const data = res.structuredContent as Record<string, unknown>;
    expect(data.needs_approval).toBe(true);
    expect(String(data.approvalId || "")).toBeTruthy();
    expect("statusToken" in data).toBe(true);
    expect(res.isError).toBe(false);
    expect(posts.length).toBe(0);
  });
});

describe("hint list covers exactly the four audience-gated tools", () => {
  test("AUDIENCE_GATED_ALWAYS_HUMAN_HINT_TOOL_IDS = comm.reply, comm.send, slack.post, slack.post_external", () => {
    expect([...AUDIENCE_GATED_ALWAYS_HUMAN_HINT_TOOL_IDS].sort()).toEqual(
      ["comm.reply", "comm.send", "slack.post", "slack.post_external"]
    );
    expect(listGatewayToolIds().filter((id) => isAudienceGatedTool(id)).sort()).toEqual(
      [...AUDIENCE_GATED_ALWAYS_HUMAN_HINT_TOOL_IDS].sort()
    );
  });
});

/**
 * comm.send / slack.post / slack.post_external — same contract as comm.reply.
 * Fixture: internal channel thread + public asset (kb/public-faq) so that with
 * no setting all three tools auto-post (egress allow) today. comm.send without
 * an asset defaults to confidential → needs_approval already, which would not
 * show the gap.
 */
const EXTRA_TOOLS = ["comm.send", "slack.post", "slack.post_external"] as const;
type ExtraTool = (typeof EXTRA_TOOLS)[number];

function toolChannelBody(tool: ExtraTool, jobId: string, text = "社内連絡です。"): GatewayInvokeRequest {
  return {
    tool,
    purpose: "comm.internal",
    jobId,
    conversation: { surface: "slack", orgId: DEMO_ORG.id, slackChannelId: "C_INTERNAL", threadId: THREAD },
    args: { slackChannelId: "C_INTERNAL", text, threadId: THREAD, assetRef: "kb/public-faq" },
  };
}

function toolDmBody(tool: ExtraTool, jobId: string): GatewayInvokeRequest {
  return {
    tool,
    purpose: "comm.internal",
    jobId,
    conversation: { surface: "slack", orgId: DEMO_ORG.id, slackUserId: "U_YAMADA" },
    args: { text: "DMです。", dm: true, assetRef: "kb/public-faq" },
  };
}

let seq = 0;
const jobFor = (tool: string, tag: string) => `job_ah_${tool.replace(/\W/g, "_")}_${tag}_${Date.now()}_${++seq}`;

for (const tool of EXTRA_TOOLS) {
  describe(`${tool}: per-tool always_human`, () => {
    const def = GATEWAY_TOOL_DEFS[tool];

    test("toolRequiresHumanApproval: always_human → true (before: false)", () => {
      expect(toolRequiresHumanApproval(def, { [tool]: "always_human" })).toBe(true);
    });

    test("toolRequiresHumanApproval: unset / auto / risk_based → false (unchanged)", () => {
      expect(toolRequiresHumanApproval(def)).toBe(false);
      expect(toolRequiresHumanApproval(def, { [tool]: "auto" })).toBe(false);
      expect(toolRequiresHumanApproval(def, { [tool]: "risk_based" })).toBe(false);
    });

    test("normalize: always_human kept (before: dropped); auto / risk_based still dropped; deny kept", () => {
      expect(normalizeToolApprovalDefaults({ [tool]: "always_human" })[tool]).toBe("always_human");
      expect(normalizeToolApprovalDefaults({ [tool]: "auto" })[tool]).toBeUndefined();
      expect(normalizeToolApprovalDefaults({ [tool]: "risk_based" })[tool]).toBeUndefined();
      expect(normalizeToolApprovalDefaults({ [tool]: "deny" })[tool]).toBe("deny");
      expect(normalizeToolApprovalDefaults({})[tool]).toBeUndefined();
    });

    test("DB read: row mapper keeps a stored always_human (before: dropped)", () => {
      const emp = mapEmployeeRow({
        id: "emp_x", org_id: DEMO_ORG.id, display_name: "x", status: "active", scopes: [],
        tool_approval_defaults: { [tool]: "always_human" },
      });
      expect(emp.toolApprovalDefaults?.[tool]).toBe("always_human");
    });

    test("save: updateEmployeePolicy keeps always_human and the gateway then asks for approval", async () => {
      setHints(undefined); // registers restore of the whole runtime employee
      const before = await getEmployeeById("emp_comm");
      expect(before).toBeTruthy();
      const saved = await updateEmployeePolicy({
        orgId: DEMO_ORG.id,
        employeeId: "emp_comm",
        scopes: before!.scopes,
        allowedPurposes: before!.allowedPurposes,
        approvalPolicy: before!.approvalPolicy,
        actionLimits: before!.actionLimits,
        toolApprovalDefaults: { [tool]: "always_human" },
      });
      expect(saved?.toolApprovalDefaults?.[tool]).toBe("always_human");
      expect((await getEmployeeById("emp_comm"))?.toolApprovalDefaults?.[tool]).toBe("always_human");
      const posts = await mockSlack();
      const r = await invoke(toolChannelBody(tool, jobFor(tool, "saved")));
      expect(r.httpStatus).toBe(402);
      expect(posts.length).toBe(0);
    });

    test("control: unset → auto-posts (unchanged)", async () => {
      setHints(undefined);
      const posts = await mockSlack();
      const r = await invoke(toolChannelBody(tool, jobFor(tool, "unset")));
      expect(r.httpStatus).toBe(200);
      expect(r.body.needs_approval).not.toBe(true);
      expect((r.body.egress as { decision?: string } | undefined)?.decision).toBe("allow");
      expect(posts.length).toBe(1);
    });

    for (const hint of ["auto", "risk_based"] as const) {
      test(`control: ${hint} → auto-posts (unchanged)`, async () => {
        setHints({ [tool]: hint });
        const posts = await mockSlack();
        const r = await invoke(toolChannelBody(tool, jobFor(tool, hint)));
        expect(r.httpStatus).toBe(200);
        expect(r.body.needs_approval).not.toBe(true);
        expect(posts.length).toBe(1);
      });
    }

    test("always_human: internal thread → 402 needs_approval, nothing posted (before: 200 auto-posted)", async () => {
      setHints({ [tool]: "always_human" });
      const posts = await mockSlack();
      const r = await invoke(toolChannelBody(tool, jobFor(tool, "ah")));
      expect(r.httpStatus).toBe(402);
      expect(r.body.needs_approval).toBe(true);
      expect(posts.length).toBe(0);
      const stored = await getApprovalById(String(r.body.approvalId), DEMO_ORG.id);
      expect(stored?.status).toBe("pending");
      expect(stored?.tool).toBe(tool);
    });

    test("always_human: internal DM → 402, nothing posted (before: 200 auto-posted)", async () => {
      setHints({ [tool]: "always_human" });
      const posts = await mockSlack();
      const r = await invoke(toolDmBody(tool, jobFor(tool, "dm")));
      expect(r.httpStatus).toBe(402);
      expect(r.body.needs_approval).toBe(true);
      expect(posts.length).toBe(0);
    });

    test("deny → 403 tool_denied_by_tool_setting, no approval card (unchanged)", async () => {
      setHints({ [tool]: "deny" });
      const posts = await mockSlack();
      const r = await invoke(toolChannelBody(tool, jobFor(tool, "deny")));
      expect(r.httpStatus).toBe(403);
      expect(r.body.code).toBe("tool_denied_by_tool_setting");
      expect(r.body.needs_approval).toBe(false);
      expect(r.body.approvalId).toBeUndefined();
      expect(posts.length).toBe(0);
    });

    test("approved re-run with approvalId → no new approval, approved content posted once", async () => {
      setHints({ [tool]: "always_human" });
      const body = toolChannelBody(tool, jobFor(tool, "approve"), "承認された本文");
      const queued = await invoke(body);
      expect(queued.httpStatus).toBe(402);
      const approvalId = String(queued.body.approvalId || "");
      const approved = await resolveApproval(approvalId, "approved", "ando@example.com", DEMO_ORG.id);
      expect(approved?.status).toBe("approved");
      const posts = await mockSlack();
      const r = await invoke({ ...body, args: { ...body.args, text: "差し替えた本文" }, approvalId });
      expect(r.httpStatus).toBe(200);
      expect(r.body.ok).toBe(true);
      expect(r.body.needs_approval).not.toBe(true);
      expect(posts.length).toBe(1);
      expect(posts[0].text).toBe("承認された本文");
      const again = await invoke({ ...body, approvalId });
      expect(again.httpStatus).toBe(200);
      expect(again.body.needs_approval).not.toBe(true);
      expect(posts.length).toBe(1);
    });

    test("approve-time fulfillment posts once; re-run afterwards reuses it (no double post)", async () => {
      setHints({ [tool]: "always_human" });
      const body = toolChannelBody(tool, jobFor(tool, "fulfill"));
      const queued = await invoke(body);
      expect(queued.httpStatus).toBe(402);
      const approvalId = String(queued.body.approvalId || "");
      const approved = await resolveApproval(approvalId, "approved", "ando@example.com", DEMO_ORG.id);
      const posts = await mockSlack();
      const f = await fulfillApprovedInvoke(approved!);
      expect(f?.ok).toBe(true);
      expect(posts.length).toBe(1);
      const r = await invoke({ ...body, approvalId });
      expect(r.httpStatus).toBe(200);
      expect(r.body.needs_approval).not.toBe(true);
      expect(posts.length).toBe(1);
    });
  });
}

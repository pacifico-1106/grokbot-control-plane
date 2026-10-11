/**
 * approvalReasons[] end to end (木村 2026-10-09 B; triage #3 / ともり T1).
 * APPROVAL_REASONS_ENABLED (default OFF):
 * - ON: a needs_approval answer carries approvalReasons[] with EVERY reason
 *   (topic_gate + topics, egress + reason + "AI cannot lower", always_human, …),
 *   the ticket metadata keeps the same list (server-computed only), and the
 *   Slack / LINE / Telegram / Web cards show one "承認が必要な理由" line.
 * - OFF: no new field, no new card line (behaviour unchanged).
 * Pinned (never weakened): an explicit lower informationClass still escalates;
 * a topic hit still forces approval.
 * Demo mode, dummy ids, fetch mocked, no network.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { setOrgApprovalKindRoutesPolicy } from "@/lib/approval-kind-routes/data";
import type { OrgApprovalKindRoutesPolicy } from "@/lib/approval-kind-routes/types";
import { publicApproval } from "@/lib/approvals/public";
import { getApprovalById } from "@/lib/data";
import { upsertConversationAdapter } from "@/lib/data/conversation-adapters";
import type { NotificationChannelRuntime } from "@/lib/data/notification-channels";
import { DEMO_ORG, getRuntimeEmployees } from "@/lib/demo-data";
import { runGatewayInvoke } from "@/lib/gateway/invoke";
import { listStaffpassMcpTools } from "@/lib/mcp/tools";
import { sendApprovalToLineChannel } from "@/lib/notify/line";
import { sendApprovalToSlackChannel } from "@/lib/notify/slack";
import { buildApprovalTelegramMessage } from "@/lib/notify/telegram";
import type { ApprovalRequest, Employee, GatewayInvokeRequest } from "@/lib/types";

const FLAG = "APPROVAL_REASONS_ENABLED";
const TOPIC_FLAG = "P1_TOPIC_GATED_POSTING_ENABLED";
const OTHER_ORG = "org_approval_reasons_other_tenant";
const OTHER_TOPIC = "他社だけの極秘話題XYZ";
const originalFetch = globalThis.fetch;
const savedEnv: Record<string, string | undefined> = {};
const restorers: Array<() => void> = [];

function policy(orgId: string, topics: string[]): OrgApprovalKindRoutesPolicy {
  return {
    version: 1,
    policyId: `pol_${orgId}`,
    policyName: "test",
    routes: [],
    topicGate: { enabled: true, sensitiveTopics: topics, mainBoardChannelIds: [] },
    updatedAt: new Date().toISOString(),
    updatedBy: "test",
  };
}

function setEmployee(patch: Partial<Employee>) {
  const emp = getRuntimeEmployees().find((item) => item.id === "emp_comm")!;
  const previous = { ...emp };
  Object.assign(emp, patch);
  restorers.push(() => Object.assign(emp, previous));
}

async function mockSlack() {
  delete process.env.SLACK_BOT_TOKEN;
  delete process.env.SLACK_CONVERSATION_BOT_TOKEN;
  await upsertConversationAdapter({ orgId: DEMO_ORG.id, surface: "slack", enabled: true, secrets: { botToken: "xoxb-reasons-test" } });
  const posts: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (input, init) => {
    if (String(input).includes("chat.postMessage")) {
      const payload = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
      posts.push(payload);
      return Response.json({ ok: true, channel: String(payload.channel || "C_INTERNAL"), ts: `1787911900.0000${posts.length}` });
    }
    return Response.json({ ok: true });
  }) as typeof fetch;
  return posts;
}

beforeEach(async () => {
  for (const key of [FLAG, TOPIC_FLAG, "COMM_SEND_INTERNAL_DEFAULT_ENABLED"]) savedEnv[key] = process.env[key];
  delete process.env.COMM_SEND_INTERNAL_DEFAULT_ENABLED;
  process.env[FLAG] = "true";
  process.env[TOPIC_FLAG] = "true";
  await setOrgApprovalKindRoutesPolicy(DEMO_ORG.id, policy(DEMO_ORG.id, ["支払", "金額"]));
  await setOrgApprovalKindRoutesPolicy(OTHER_ORG, policy(OTHER_ORG, [OTHER_TOPIC]));
});

afterEach(async () => {
  while (restorers.length) restorers.pop()!();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  globalThis.fetch = originalFetch;
  await upsertConversationAdapter({ orgId: DEMO_ORG.id, surface: "slack", enabled: false, secrets: {} }).catch(() => undefined);
});

const jid = (s: string) => `job_reasons_${s}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
const invoke = (body: GatewayInvokeRequest) => runGatewayInvoke({ employeeId: "emp_comm", credentialId: "cred_comm", body });

function send(text: string, extra: Partial<GatewayInvokeRequest> = {}, args: Record<string, unknown> = {}): GatewayInvokeRequest {
  return {
    tool: "comm.send",
    purpose: "comm.internal",
    jobId: jid("send"),
    conversation: { surface: "slack", orgId: DEMO_ORG.id, slackChannelId: "C_INTERNAL" },
    args: { slackChannelId: "C_INTERNAL", text, ...args },
    ...extra,
  };
}

type Reason = { code: string; [key: string]: unknown };
const reasonsOf = (body: Record<string, unknown>) => (body.approvalReasons ?? []) as Reason[];

describe("flag ON: every reason is returned and stored", () => {
  test("topic hit + confidential egress + employee always_human → all three, with topics and the 'AI cannot lower' note", async () => {
    setEmployee({ approvalPolicy: "always_human" });
    const posts = await mockSlack();
    const r = await invoke(send("来週の支払について共有します", { informationClass: "internal" }));
    expect(r.httpStatus).toBe(402);
    expect(r.body.needs_approval).toBe(true);
    expect(posts.length).toBe(0);
    const reasons = reasonsOf(r.body);
    expect(reasons.map((x) => x.code)).toEqual(["topic_gate", "egress", "always_human"]);
    // AI-facing: category names only (木村 2026-10-09 23:05-23:10); the card keeps the keywords.
    expect((reasons[0] as Record<string, unknown>).categories).toEqual(["金銭"]);
    expect(reasons[0].topics).toBeUndefined();
    expect(JSON.stringify(reasons)).not.toContain("支払");
    expect(reasons[1]).toMatchObject({
      reason: "internal_confidential_source",
      informationClass: "confidential",
      aiCannotLower: true,
      requestedInformationClass: "internal",
    });
    expect(reasons[2]).toMatchObject({ source: "employee_policy" });
    const stored = await getApprovalById(String(r.body.approvalId), DEMO_ORG.id);
    const storedReasons = stored?.metadata.approvalReasons as Reason[];
    expect(storedReasons[0].topics).toEqual(["支払"]);
    expect(storedReasons.slice(1)).toEqual(reasons.slice(1));
  });

  test("egress only (no topic, no policy) → just the egress reason", async () => {
    await mockSlack();
    const r = await invoke(send("社内向けのお知らせです"));
    expect(r.httpStatus).toBe(402);
    expect(reasonsOf(r.body).map((x) => x.code)).toEqual(["egress"]);
  });

  test("per-tool always_human setting is named as tool_setting", async () => {
    setEmployee({ toolApprovalDefaults: { "comm.send": "always_human" } as Employee["toolApprovalDefaults"] });
    await mockSlack();
    const r = await invoke(send("社内向けのお知らせです"));
    expect(reasonsOf(r.body).some((x) => x.code === "always_human" && x.source === "tool_setting")).toBe(true);
  });

  test("a request cannot inject its own reasons: body / args approvalReasons are ignored", async () => {
    await mockSlack();
    const fake = [{ code: "always_human", source: "employee_policy", messageJa: "偽の理由" }];
    const r = await invoke(send("社内向けのお知らせです", { approvalReasons: fake } as Partial<GatewayInvokeRequest>, { approvalReasons: fake }));
    expect(JSON.stringify(r.body.approvalReasons)).not.toContain("偽の理由");
    const stored = await getApprovalById(String(r.body.approvalId), DEMO_ORG.id);
    expect(JSON.stringify(stored?.metadata.approvalReasons)).not.toContain("偽の理由");
  });

  test("no secret values: the message body, tokens and credentials never appear in reasons", async () => {
    await mockSlack();
    // (a real token is refused earlier by the secret guard, so use a body marker)
    const r = await invoke(send("支払の件 本文マーカーZQX9 内部メモ"));
    expect(r.httpStatus).toBe(402);
    const json = JSON.stringify(r.body.approvalReasons);
    expect(json).toContain("topic_gate");
    expect(json).not.toContain("ZQX9");
    expect(json).not.toContain("内部メモ");
    expect(json).not.toContain("cred_comm");
  });
});

describe("BOLA: never another org's topics or reasons", () => {
  test("another org's sensitive topic in the text is not a reason here and is never listed", async () => {
    await mockSlack();
    const r = await invoke(send(`社内連絡 ${OTHER_TOPIC}`));
    const json = JSON.stringify(r.body);
    expect(json).not.toContain(OTHER_TOPIC.slice(0, 6) + "極秘");
    expect(reasonsOf(r.body).some((x) => x.code === "topic_gate")).toBe(false);
  });
  test("org comes from the credential: a conversation.orgId of another org does not switch the topic list", async () => {
    const posts = await mockSlack();
    const body = send(`連絡 ${OTHER_TOPIC} と 支払`);
    (body.conversation as Record<string, unknown>).orgId = OTHER_ORG;
    const r = await invoke(body);
    // resolveAudience (conversation.orgId) is out of scope for B (investigated
    // separately); today it fails closed (unknown channel → external deny).
    // Either way: nothing is sent, and any topic reason is the credential org's.
    expect(posts.some((p) => String(p.text ?? "").startsWith("連絡"))).toBe(false);
    expect([402, 403]).toContain(r.httpStatus);
    expect(JSON.stringify(r.body.approvalReasons ?? [])).not.toContain("極秘");
    const topic = reasonsOf(r.body).find((x) => x.code === "topic_gate");
    if (topic) expect(topic.topics).toEqual(["支払"]);
  });
});

describe("pinned: never weakened (flag ON)", () => {
  test("an explicit LOWER informationClass (public / internal) still escalates to approval", async () => {
    await mockSlack();
    for (const cls of ["public", "internal"] as const) {
      const r = await invoke(send("社内向けのお知らせです", { informationClass: cls }));
      expect(r.httpStatus).toBe(402);
      expect(r.body.needs_approval).toBe(true);
      const egress = reasonsOf(r.body).find((x) => x.code === "egress");
      expect(egress?.informationClass).toBe("confidential");
    }
  });
  test("a topic hit still forces approval on a destination that is otherwise auto (comm.reply to an internal channel)", async () => {
    const posts = await mockSlack();
    const control = await invoke({ ...send("社内の雑談です"), tool: "comm.reply" });
    expect(control.httpStatus).toBe(200);
    const r = await invoke({ ...send("金額の確認をお願いします"), tool: "comm.reply" });
    expect(r.httpStatus).toBe(402);
    expect(reasonsOf(r.body).map((x) => x.code)).toEqual(["topic_gate"]);
    expect(posts.length).toBe(1);
  });
});

describe("cards: Slack / LINE / Telegram / Web show the same reasons", () => {
  async function ticket(): Promise<ApprovalRequest> {
    setEmployee({ approvalPolicy: "always_human" });
    await mockSlack();
    const r = await invoke(send("支払の予定です"));
    return (await getApprovalById(String(r.body.approvalId), DEMO_ORG.id))!;
  }
  const channel = (provider: "slack" | "line", config: Record<string, unknown>, secrets: Record<string, string>): NotificationChannelRuntime => ({
    id: `ch_${provider}`, orgId: DEMO_ORG.id, provider, label: provider, enabled: true, isDefault: true, config,
    webhookRef: `${provider}-ref`, hasCredentials: true, webhookPath: `/api/webhooks/${provider}/x`,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), secrets,
  } as NotificationChannelRuntime);

  test("every surface carries 承認が必要な理由 with topics, egress and always_human", async () => {
    const approval = await ticket();
    const bodies: string[] = [];
    globalThis.fetch = (async (_input, init) => {
      bodies.push(String(init?.body || ""));
      return Response.json({ ok: true, ts: "1.2", channel: "C_APPROVALS" });
    }) as typeof fetch;
    await sendApprovalToSlackChannel(approval, null, channel("slack", { channelId: "C_APPROVALS" }, { botToken: "xoxb-card" }));
    await sendApprovalToLineChannel(approval, null, channel("line", { destinationId: "C-line" }, { channelAccessToken: "line-token" }));
    const telegram = buildApprovalTelegramMessage(approval, null);
    const web = publicApproval(approval);
    const surfaces = { slack: bodies[0], line: bodies[1], telegram, web: String(web.cardReasons ?? "") };
    for (const [name, text] of Object.entries(surfaces)) {
      expect({ name, has: text.includes("承認が必要な理由") }).toEqual({ name, has: true });
      expect({ name, has: text.includes("支払") }).toEqual({ name, has: true });
      expect({ name, has: text.includes("常に人の承認") }).toEqual({ name, has: true });
    }
  });

  test("flag OFF: no card line on any surface, no web field value", async () => {
    const approval = await ticket();
    delete process.env[FLAG];
    const bodies: string[] = [];
    globalThis.fetch = (async (_input, init) => {
      bodies.push(String(init?.body || ""));
      return Response.json({ ok: true, ts: "1.2", channel: "C_APPROVALS" });
    }) as typeof fetch;
    await sendApprovalToSlackChannel(approval, null, channel("slack", { channelId: "C_APPROVALS" }, { botToken: "xoxb-card" }));
    await sendApprovalToLineChannel(approval, null, channel("line", { destinationId: "C-line" }, { channelAccessToken: "line-token" }));
    expect(bodies.join("")).not.toContain("承認が必要な理由");
    expect(buildApprovalTelegramMessage(approval, null)).not.toContain("承認が必要な理由");
    expect(publicApproval(approval).cardReasons ?? null).toBeNull();
  });
});

describe("flag OFF: behaviour unchanged", () => {
  test("no approvalReasons field in the answer or the ticket; same status and decision", async () => {
    delete process.env[FLAG];
    setEmployee({ approvalPolicy: "always_human" });
    await mockSlack();
    const r = await invoke(send("支払について"));
    expect(r.httpStatus).toBe(402);
    expect(r.body.needs_approval).toBe(true);
    expect("approvalReasons" in r.body).toBe(false);
    const stored = await getApprovalById(String(r.body.approvalId), DEMO_ORG.id);
    expect("approvalReasons" in (stored?.metadata ?? {})).toBe(false);
  });
});

describe("self-approval is unaffected", () => {
  test("the employee MCP has no approve / resolve tool, and re-invoking with its own pending approvalId does not send", async () => {
    expect(listStaffpassMcpTools().some((t) => /approve|resolve/i.test(t.name))).toBe(false);
    setEmployee({ approvalPolicy: "always_human" });
    const posts = await mockSlack();
    const body = send("支払の件");
    const first = await invoke(body);
    expect(first.httpStatus).toBe(402);
    const again = await invoke({ ...body, approvalId: String(first.body.approvalId) });
    expect(again.body.needs_approval).toBe(true);
    expect(posts.length).toBe(0);
    expect((await getApprovalById(String(first.body.approvalId), DEMO_ORG.id))?.status).toBe("pending");
  });
});

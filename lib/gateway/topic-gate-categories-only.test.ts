/**
 * 木村 2026-10-09 23:05-23:10: topic-gate keyword leak. Wherever a topic-gate hit goes back to
 * the AI (402 body: message, topicGate, approvalReasons[].topic_gate; HTTP route; MCP
 * staffpass_invoke; status poll) only CATEGORY names appear (same mapping as
 * staffpass_sensitive_topics), never the tenant's keywords. The approver card and audit rows
 * keep the matched keywords.
 *
 * `summary` is excluded from the keyword walk: it echoes the AI's OWN outbound text (which
 * necessarily contains the word it wrote) and is the card summary. It must still carry no
 * topic-gate wording with the keyword.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const VALID_SECRET = "gb_emp_topiccat_valid";
mock.module("@/lib/auth/employee-credential", () => ({
  extractEmployeeSecret(req: Request): string | null {
    const m = /^Bearer\s+(.+)$/i.exec((req.headers.get("authorization") || "").trim());
    return m?.[1]?.trim() || null;
  },
  async resolveEmployeeCredential(req: Request) {
    const raw = /^Bearer\s+(.+)$/i.exec((req.headers.get("authorization") || "").trim())?.[1]?.trim();
    if (raw === VALID_SECRET) {
      return { ok: true, credential: { employeeId: "emp_comm", credentialId: "cred_comm", orgId: "org_demo" } };
    }
    return { ok: false, code: "invalid_credential", httpStatus: 401, message: "invalid" };
  },
}));

const { setOrgApprovalKindRoutesPolicy } = await import("@/lib/approval-kind-routes/data");
const { upsertConversationAdapter } = await import("@/lib/data/conversation-adapters");
const { getApprovalById } = await import("@/lib/data/approvals");
const { listAuditEvents } = await import("@/lib/data/audit");
const { DEMO_ORG } = await import("@/lib/demo-data");
const { runGatewayInvoke } = await import("@/lib/gateway/invoke");
const { callStaffpassMcpTool } = await import("@/lib/mcp/tools");
const { publicApproval } = await import("@/lib/approvals/public");
const { cardApprovalReasonsLine } = await import("@/lib/approvals/approval-reasons");
const gatewayRoute = await import("@/app/api/gateway/invoke/route");
const statusRoute = await import("@/app/api/approvals/status/route");

const OTHER_ORG = "org_topiccat_other";
const UNMAPPED = "ZQXKEY"; // maps to no category → その他の機密事項
const MAPPED = "支払"; // → 金銭
const UNUSED = "UNUSEDSECRETWORD"; // in the list, never in the text
const OTHER_ORG_WORD = "OTHERORGWORD";
const KEYWORDS = [UNMAPPED, MAPPED, UNUSED];
const originalFetch = globalThis.fetch;
const saved: Record<string, string | undefined> = {};
const FLAGS = ["P1_TOPIC_GATED_POSTING_ENABLED", "APPROVAL_REASONS_ENABLED", "SLACK_BOT_TOKEN", "SLACK_CONVERSATION_BOT_TOKEN"];

function policy(orgId: string, topics: string[]) {
  return {
    version: 1,
    policyId: `pol_${orgId}`,
    policyName: "test",
    routes: [],
    topicGate: { enabled: true, sensitiveTopics: topics, mainBoardChannelIds: [] },
    updatedAt: new Date().toISOString(),
    updatedBy: "test",
  } as never;
}

beforeEach(async () => {
  for (const k of FLAGS) saved[k] = process.env[k];
  delete process.env.SLACK_BOT_TOKEN;
  delete process.env.SLACK_CONVERSATION_BOT_TOKEN;
  process.env.P1_TOPIC_GATED_POSTING_ENABLED = "true";
  process.env.APPROVAL_REASONS_ENABLED = "true";
  await setOrgApprovalKindRoutesPolicy(DEMO_ORG.id, policy(DEMO_ORG.id, KEYWORDS));
  await setOrgApprovalKindRoutesPolicy(OTHER_ORG, policy(OTHER_ORG, [OTHER_ORG_WORD]));
  await upsertConversationAdapter({ orgId: DEMO_ORG.id, surface: "slack", enabled: true, secrets: { botToken: "xoxb-topiccat-test" } });
  globalThis.fetch = (async () => Response.json({ ok: true, ts: "1787912000.00001" })) as unknown as typeof fetch;
});

afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  globalThis.fetch = originalFetch;
  await upsertConversationAdapter({ orgId: DEMO_ORG.id, surface: "slack", enabled: false, secrets: {} }).catch(() => undefined);
});

let seq = 0;
function body(text: string, conv: Record<string, unknown> = {}) {
  seq += 1;
  return {
    tool: "comm.send",
    purpose: "comm.internal",
    jobId: `job_topiccat_${Date.now()}_${seq}`,
    conversation: { surface: "slack", orgId: DEMO_ORG.id, slackChannelId: "C_INTERNAL", ...conv },
    args: { slackChannelId: "C_INTERNAL", text },
  };
}

/** Every string in the payload except the echo of the AI's own text (`summary`). */
function aiStrings(value: unknown, path = "", out: Array<[string, string]> = []): Array<[string, string]> {
  if (typeof value === "string") out.push([path, value]);
  else if (Array.isArray(value)) value.forEach((v, i) => aiStrings(v, `${path}[${i}]`, out));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (k === "summary") continue;
      aiStrings(v, `${path}.${k}`, out);
    }
  }
  return out;
}
function expectNoKeyword(payload: unknown, words: string[]) {
  const leaks = aiStrings(payload).filter(([, s]) => words.some((w) => s.toLowerCase().includes(w.toLowerCase())));
  expect(leaks).toEqual([]);
  // the echoed summary never carries topic-gate wording with a keyword
  const summary = String((payload as Record<string, unknown>)?.summary ?? "");
  for (const w of words) expect(summary).not.toContain(`機密話題（${w}`);
}
const invoke = (b: Record<string, unknown>) =>
  runGatewayInvoke({ employeeId: "emp_comm", credentialId: "cred_comm", body: b as never });

describe("402 body (runGatewayInvoke): categories only", () => {
  test("unmapped keyword hit → その他の機密事項; no keyword anywhere the AI reads", async () => {
    const r = await invoke(body(`${UNMAPPED} の件です`));
    expect(r.httpStatus).toBe(402);
    const b = r.body as Record<string, unknown>;
    expectNoKeyword(b, KEYWORDS);
    expect(b.topicGate).toMatchObject({ categories: ["その他の機密事項"] });
    expect((b.topicGate as Record<string, unknown>).matchedTopics).toBeUndefined();
    const reasons = b.approvalReasons as Array<Record<string, unknown>>;
    const tg = reasons.find((x) => x.code === "topic_gate")!;
    expect(tg.categories).toEqual(["その他の機密事項"]);
    expect(tg.topics).toBeUndefined();
    expect(String(b.message)).toContain("その他の機密事項");
  });

  test("mapped keyword hit (支払) → 金銭; the keyword is not echoed outside summary", async () => {
    const r = await invoke(body(`来週の${MAPPED}について共有します`));
    expect(r.httpStatus).toBe(402);
    const b = r.body as Record<string, unknown>;
    expectNoKeyword(b, KEYWORDS);
    expect(b.topicGate).toMatchObject({ categories: ["金銭"] });
    expect(String(b.message)).toContain("金銭");
  });

  test("approval reasons flag OFF → message + topicGate still categories only", async () => {
    delete process.env.APPROVAL_REASONS_ENABLED;
    const r = await invoke(body(`${UNMAPPED} の件です`));
    expect(r.httpStatus).toBe(402);
    const b = r.body as Record<string, unknown>;
    expect(b.approvalReasons).toBeUndefined();
    expectNoKeyword(b, KEYWORDS);
    expect(b.topicGate).toMatchObject({ categories: ["その他の機密事項"] });
  });

  test("BOLA: conversation.orgId pointing at another org never surfaces that org's keywords", async () => {
    const r = await invoke(body(`${OTHER_ORG_WORD} と ${UNMAPPED}`, { orgId: OTHER_ORG }));
    expectNoKeyword(r.body, [...KEYWORDS, OTHER_ORG_WORD]);
  });
});

describe("HTTP route + MCP + status poll: categories only", () => {
  test("POST /api/gateway/invoke → 402 body has no keyword", async () => {
    const res = await gatewayRoute.POST(
      new Request("https://staffpass.example/api/gateway/invoke", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${VALID_SECRET}` },
        body: JSON.stringify(body(`${UNMAPPED} の件です`)),
      })
    );
    expect(res.status).toBe(402);
    const b = (await res.json()) as Record<string, unknown>;
    expectNoKeyword(b, KEYWORDS);
    expect(b.topicGate).toMatchObject({ categories: ["その他の機密事項"] });
  });

  test("MCP staffpass_invoke → structuredContent and text have no keyword", async () => {
    const b = body(`${UNMAPPED} の件です`);
    const res = await callStaffpassMcpTool(
      "staffpass_invoke",
      { tool: b.tool, purpose: b.purpose, jobId: b.jobId, conversation: b.conversation, payload: b.args },
      {
        employeeId: "emp_comm",
        orgId: DEMO_ORG.id,
        credentialId: "cred_comm",
        generation: 1,
        fingerprint: "fixture-hash",
        secretPrefix: "gb_emp_fixture",
        binding: { status: "linked", employeeId: "emp_comm", orgId: DEMO_ORG.id, credentialGeneration: 1 },
      } as never
    );
    const data = res.structuredContent as Record<string, unknown>;
    expect(data.needs_approval).toBe(true);
    expectNoKeyword(data, KEYWORDS);
    const parsedText = JSON.parse(res.content[0].text) as Record<string, unknown>;
    expectNoKeyword(parsedText, KEYWORDS);
  });

  test("status poll (GET /api/approvals/status) has no keyword outside the echoed summary", async () => {
    const r = await invoke(body(`${UNMAPPED} の件です`));
    const b = r.body as Record<string, string>;
    const res = await statusRoute.GET(
      new Request(`https://staffpass.example/api/approvals/status?id=${encodeURIComponent(b.approvalId)}&token=${encodeURIComponent(b.statusToken)}`)
    );
    expect(res.status).toBe(200);
    expectNoKeyword(await res.json(), KEYWORDS);
  });
});

describe("approver card + audit keep the matched keywords", () => {
  test("stored approval metadata / card line show the keyword; audit row keeps matchedTopics", async () => {
    const r = await invoke(body(`${UNMAPPED} の件です`));
    const approvalId = String((r.body as Record<string, unknown>).approvalId);
    const approval = await getApprovalById(approvalId, DEMO_ORG.id);
    expect(approval).not.toBeNull();
    const card = cardApprovalReasonsLine(approval!.metadata, approval!.summary);
    expect(card ?? "").toContain(UNMAPPED);
    expect(publicApproval(approval!).cardReasons ?? "").toContain(UNMAPPED);
    const meta = approval!.metadata as Record<string, unknown>;
    expect((meta.topicGate as Record<string, unknown>).matchedTopics).toEqual([UNMAPPED]);
    const audits = (await listAuditEvents(DEMO_ORG.id, 1_000_000)).filter(
      (a) => a.action === "topic_gate.triggered" && (a.metadata as Record<string, unknown>)?.jobId === approval!.jobId
    );
    expect(audits.length).toBe(1);
    expect((audits[0].metadata as Record<string, unknown>).matchedTopics).toEqual([UNMAPPED]);
  });
});

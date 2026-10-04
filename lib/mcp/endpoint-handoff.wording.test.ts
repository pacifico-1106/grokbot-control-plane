/**
 * #256 (木村 decision 5): Staffpass is "the employee ID badge for AI agents" and is not tied to
 * one agent product. Everything the MCP handoff generates — the last-resort human notice, the
 * stage-1 reconnect prompt to the agent, and the machine-readable handoff block — must be
 * neutral: never "Grok Bot" / "Grok". Same text on every channel (Slack / LINE / Telegram).
 * Real channel paths are exercised with all outbound HTTP mocked (no real API calls).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ApprovalRequest } from "@/lib/types";
import type { McpHandoff, McpHandoffSurface } from "@/lib/mcp/endpoint-handoff";

const { DEMO_ORG, getRuntimeAudit, getRuntimeEmployees, pushRuntimeAuditEvent } = await import("@/lib/demo-data");
const {
  buildMcpHandoff,
  buildNotConnectedNextStepJa,
  buildNotConnectedNotice,
  processMcpNotConnectedWatchForOrg,
  recordMcpClientSeen,
  renderNotConnectedNotice,
  resetMcpClientSeenThrottleForTests,
  withMcpHandoff,
} = await import("@/lib/mcp/endpoint-handoff");
const { buildReconnectPromptJa } = await import("@/lib/mcp/endpoint-handoff-block");
const { upsertNotificationChannel } = await import("@/lib/data/notification-channels");
const { setOrgStuckWatchPolicy, resetDemoStuckWatchPolicy } = await import("@/lib/data/stuck-watch-policy");
const { createApproval } = await import("@/lib/data/approvals");
const { runApprovalResolveSideEffects } = await import("@/lib/approvals/resolve-side-effects");
const { fulfillApprovedAdmin } = await import("@/lib/admin-mcp/fulfill-admin");

const FLAG = "MCP_ENDPOINT_HANDOFF_ENABLED";
const ORIGIN = "https://wording.example.test";
const MCP_URL = `${ORIGIN}/api/mcp`;
const MIN = 60_000;
const CALLBACK_URL = "https://example.test/callback/wording";
const GROK = /grok/i;
const CHANNELS = ["slack", "line", "telegram"] as const;
const FORMATS = ["slack", "line", "telegram", "plain"] as const;

type Call = { url: string; body: string };
let calls: Call[] = [];
let savedFetch: typeof fetch;
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = [FLAG, "NEXT_PUBLIC_APP_URL"];

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.NEXT_PUBLIC_APP_URL = ORIGIN;
  process.env[FLAG] = "true";
  getRuntimeAudit().splice(0);
  resetMcpClientSeenThrottleForTests();
  savedFetch = globalThis.fetch;
  calls = [];
  globalThis.fetch = (async (input, init) => {
    calls.push({ url: String(input), body: String(init?.body || "") });
    return Response.json({ ok: true, channel: "C_WD", ts: "1.2", result: { message_id: 9 } });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = savedFetch;
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetDemoStuckWatchPolicy();
});

function decode(format: "slack" | "telegram" | "line", text: string): string {
  if (format === "line") return text;
  let t = text;
  if (format === "slack") t = t.replace(/^```\n?/gm, "").replace(/\n?```$/gm, "");
  if (format === "telegram") t = t.replace(/<\/?code>/g, "");
  return t.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

function pushWake(employeeId: string, at: number, extra: Record<string, unknown> = {}) {
  return pushRuntimeAuditEvent({
    orgId: DEMO_ORG.id, employeeId, credentialId: null, action: "slack.mention_wake", purpose: "slack.mention",
    summary: "wake", createdAt: new Date(at).toISOString(),
    metadata: { reason: "woke", surface: "slack", mcpHandoff: true, channel: "C_WD", ts: String(at / 1000), ...extra },
  });
}

/** The channel-independent part of a block: everything except wake (per channel) and connection (state, timestamps). */
function textOf(h: McpHandoff): string {
  return JSON.stringify({ ...h, wake: undefined, connection: undefined });
}

describe("notice: neutral wording (no Grok), addressed to the employee's AI agent chat", () => {
  const notice = (surface: McpHandoffSurface, via?: "reconnect_wake" | "no_followup_wake") =>
    buildNotConnectedNotice({ employeeId: "emp_ops", displayName: "運用太郎", surface, minutesSinceWake: 12, via });

  test("the one action names the employee's AI agent chat; the line says MCP サーバー（コネクタ）", () => {
    const n = notice("slack");
    expect(n.headline).toContain("AI社員「運用太郎」の AI エージェントが Staffpass MCP に接続していません");
    expect(n.action).toBe("やることは 1 つです。この社員（運用太郎）の AI エージェントのチャットに、次の 1 行をそのまま送ってください。");
    expect(n.copyLine).toBe(
      `Staffpass MCP に接続して: MCP サーバー（コネクタ）に ${MCP_URL} を追加し（Streamable HTTP、認証は発行済みの社員証を Authorization: Bearer で設定）、staffpass_whoami を呼んで employeeId=emp_ops が返ることを確認して。`,
    );
    expect(n.action).not.toContain("メイン");
  });

  for (const surface of [...CHANNELS, "web", "admin_proxy"] as const) {
    for (const via of [undefined, "reconnect_wake", "no_followup_wake"] as const) {
      test(`surface=${surface} via=${via ?? "default"}: no Grok in any field or rendering`, () => {
        const n = notice(surface, via);
        for (const v of Object.values(n)) expect(v).not.toMatch(GROK);
        for (const f of FORMATS) expect(renderNotConnectedNotice(n, f)).not.toMatch(GROK);
        expect(buildNotConnectedNextStepJa({ employeeId: "emp_ops", surface, minutesSinceWake: 12, via })).not.toMatch(GROK);
      });
    }
  }

  test("real stage-2 delivery on Slack / LINE / Telegram: no Grok, and the same text on every channel", async () => {
    const PROVIDERS = [
      { provider: "slack", api: "https://slack.com/api/chat.postMessage", config: { channelId: "C_WD_MOUTH" }, secrets: { botToken: "xoxb-wd", signingSecret: "s" } },
      { provider: "line", api: "https://api.line.me/", config: { destinationId: "G_WD_MOUTH" }, secrets: { channelAccessToken: "line-wd", channelSecret: "s" } },
      { provider: "telegram", api: "https://api.telegram.org/", config: { chatId: "-10099" }, secrets: { botToken: "tg-wd", webhookSecret: "s" } },
    ] as const;
    const decoded: string[] = [];
    for (const p of PROVIDERS) {
      getRuntimeAudit().splice(0);
      calls = [];
      const mouth = await upsertNotificationChannel({ orgId: DEMO_ORG.id, provider: p.provider, label: `WD ${p.provider}`, enabled: true, config: p.config, secrets: p.secrets });
      await setOrgStuckWatchPolicy(DEMO_ORG.id, { notifyMouth: mouth.id });
      const t0 = Date.now();
      pushWake("emp_ops", t0 - 20 * MIN);
      await processMcpNotConnectedWatchForOrg(DEMO_ORG.id, { now: new Date(t0) });
      pushWake("emp_ops", t0 + 2 * MIN, { mcpReconnectRequired: true });
      const r = await processMcpNotConnectedWatchForOrg(DEMO_ORG.id, { now: new Date(t0 + 13 * MIN) });
      expect(r.find((x) => x.employeeId === "emp_ops")?.stage).toBe("notified");
      const sent = calls.filter((c) => c.url.startsWith(p.api));
      expect(sent.length).toBe(1);
      const json = JSON.parse(sent[0].body) as { text?: string; messages?: Array<{ text: string }> };
      const text = p.provider === "line" ? String(json.messages?.[0]?.text || "") : String(json.text || "");
      expect(text).not.toMatch(GROK);
      expect(text).toContain("AI エージェントのチャット");
      expect(text).toContain("MCP サーバー（コネクタ）");
      decoded.push(decode(p.provider, text));
    }
    expect(decoded.length).toBe(3);
    expect(new Set(decoded).size).toBe(1);
    const name = getRuntimeEmployees().find((e) => e.id === "emp_ops")?.displayName;
    expect(decoded[0]).toContain(`この社員（${name}）の AI エージェントのチャットに、次の 1 行をそのまま送ってください。`);
  });
});

describe("reconnect prompt (to the agent): neutral, MCP サーバー（コネクタ）", () => {
  test("pure prompt", () => {
    const p = buildReconnectPromptJa(MCP_URL, "emp_ops");
    expect(p).not.toMatch(GROK);
    expect(p).toContain(`MCP サーバー（コネクタ）設定に ${MCP_URL} が登録され`);
    expect(p).toContain("この件は会話の相手には伝えないでください。");
  });
});

describe("handoff block: neutral wording, identical on Slack / LINE / Telegram", () => {
  test("pure block (with and without reconnectRequired)", () => {
    for (const reconnectRequired of [false, true]) {
      const h = buildMcpHandoff({ employeeId: "emp_ops", reconnectRequired });
      expect(JSON.stringify(h)).not.toMatch(GROK);
      const step = h.setupSteps.find((s) => s.id === "register_mcp_server")!;
      expect(step.ja).toBe(`AI エージェントの MCP サーバー（コネクタ）設定に Staffpass を追加し、URL に ${MCP_URL} を指定する（transport: Streamable HTTP）。`);
      expect(h.ifNotConnectedJa).toContain(`管理者に「AI エージェントの MCP サーバー（コネクタ）設定に ${MCP_URL} を登録し、発行済みの社員証を Authorization: Bearer に設定してください」と伝えてください。`);
    }
  });

  for (const reconnectRequired of [false, true]) {
    test(`withMcpHandoff per channel (reconnectRequired=${reconnectRequired}): no Grok, same text`, async () => {
      if (reconnectRequired) {
        pushWake("emp_ops", Date.now() - 20 * MIN);
        expect((await processMcpNotConnectedWatchForOrg(DEMO_ORG.id)).find((r) => r.employeeId === "emp_ops")?.stage).toBe("armed");
      }
      const texts: string[] = [];
      for (const surface of CHANNELS) {
        const body = await withMcpHandoff({ type: "wake" }, { orgId: DEMO_ORG.id, employeeId: "emp_ops", surface, kind: "conversation", trigger: "t" });
        const h = body.mcpHandoff as McpHandoff;
        expect(h.wake?.surface).toBe(surface);
        expect(Boolean(h.reconnectRequired)).toBe(reconnectRequired);
        expect(JSON.stringify(body)).not.toMatch(GROK);
        texts.push(textOf(h));
      }
      expect(new Set(texts).size).toBe(1);
      expect(texts[0]).toContain("MCP サーバー（コネクタ）");
    });
  }

  test("real approval.resolved wake on Slack / LINE / Telegram (after arming): no Grok, same block text", async () => {
    const emp = getRuntimeEmployees().find((e) => e.id === "emp_sales")!;
    const texts: string[] = [];
    for (const surface of CHANNELS) {
      getRuntimeAudit().splice(0);
      calls = [];
      const a = (await createApproval({ orgId: DEMO_ORG.id, employeeId: "emp_sales", credentialId: "cred_sales", title: "wd",
        purpose: "fixture", summary: "Fixture", risk: "low", tool: "comm.reply", jobId: crypto.randomUUID() })).approval;
      for (const e of getRuntimeAudit()) e.createdAt = new Date(Date.now() - 60 * MIN).toISOString();
      pushWake("emp_sales", Date.now() - 20 * MIN);
      expect((await processMcpNotConnectedWatchForOrg(DEMO_ORG.id)).find((r) => r.employeeId === "emp_sales")?.stage).toBe("armed");
      await runApprovalResolveSideEffects({ approval: { ...a, status: "rejected" } as ApprovalRequest, decision: "rejected",
        actorEmail: `${surface}:approver`, employee: { ...emp, callbackUrl: CALLBACK_URL }, surface });
      const cb = calls.filter((c) => c.url === CALLBACK_URL);
      expect(cb.length).toBe(1);
      expect(cb[0].body).not.toMatch(GROK);
      const h = (JSON.parse(cb[0].body) as { mcpHandoff: McpHandoff }).mcpHandoff;
      expect(h.wake?.surface).toBe(surface);
      expect(h.reconnectRequired).toBe(true);
      expect(h.reconnectPromptJa).toContain("MCP サーバー（コネクタ）");
      texts.push(textOf(h));
    }
    expect(new Set(texts).size).toBe(1);
  });

  test("employees.issue result: the handoff block and the line it adds are neutral", async () => {
    const r = await fulfillApprovedAdmin({
      id: `apr_wd_${Math.random().toString(36).slice(2, 8)}`, orgId: DEMO_ORG.id, employeeId: "emp_ops", credentialId: null,
      title: "employees.issue", summary: "employees.issue", purpose: "admin.employees.issue", risk: "high", tool: "employees.issue",
      status: "approved", createdAt: new Date().toISOString(),
      metadata: { approvalClass: "admin", adminTool: "employees.issue",
        adminMutation: { displayName: "文言太郎", roleLabel: "テスト", scopes: ["mail:draft"], expiresInDays: 30 } },
    } as unknown as ApprovalRequest);
    expect(r?.ok).toBe(true);
    expect(JSON.stringify(r?.mcpHandoff)).not.toMatch(GROK);
    const added = String(r?.nextStepJa).slice(String(r?.nextStepJa).indexOf("MCP 接続先:"));
    expect(added).toContain(MCP_URL);
    expect(added).not.toMatch(GROK);
  });
});

describe("connection audit (the seen signal #254 records): neutral summary", () => {
  test("mcp.client_seen summary names the AI agent, not a product", async () => {
    await recordMcpClientSeen({ employeeId: "emp_wd_seen", orgId: DEMO_ORG.id, credentialId: "cred_wd", generation: 1 }, "tools/list");
    const e = getRuntimeAudit().find((a) => a.action === "mcp.client_seen" && a.employeeId === "emp_wd_seen");
    expect(e?.summary).toBe("AI エージェントが社員証で Staffpass MCP に接続");
    expect(e?.summary).not.toMatch(GROK);
  });
});

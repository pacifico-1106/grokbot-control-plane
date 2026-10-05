/**
 * Service-neutral guidance text (木村, follow-up to #256 open decision 1).
 * Staffpass is 「AIエージェントの社員証」 and supports agents other than Grok Bot, so every guidance /
 * message text returned by MCP or the API must not assume Grok Bot. API field names
 * (grokBotAgentId / grokBotWorkspaceId) stay unchanged for compatibility.
 * The only intended remaining mention is the server-card note, where Grok Bot is one example.
 * UI / LP / terms / billing copy is out of scope (separate review).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ApprovalRequest } from "@/lib/types";

const { DEMO_ORG, getRuntimeAudit, setGatewayStatus } = await import("@/lib/demo-data");
const { fulfillApprovedAdmin } = await import("@/lib/admin-mcp/fulfill-admin");
const { ADMIN_MCP_TOOLS } = await import("@/lib/mcp/admin-tools");
const { assertExecutable, ensureBindingRow } = await import("@/lib/bindings");
const { POST: issuePost } = await import("@/app/api/employees/issue/route");
const { POST: linkPost } = await import("@/app/api/employees/[id]/link/route");
const { POST: gatewayLinkPost } = await import("@/app/api/gateway/link/route");
const { GET: gatewayHealthGet } = await import("@/app/api/gateway/health/route");

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FLAG = "MCP_ENDPOINT_HANDOFF_ENABLED";
/** Field / column names and ids that legitimately contain "grok" (kept for compatibility). */
const IDENTIFIERS = [/\w*[gG]rokBot(AgentId|WorkspaceId)\w*/g, /grok_bot_(agent|workspace)_id/g];
function withoutIdentifiers(text: string): string {
  return IDENTIFIERS.reduce((t, re) => t.replace(re, ""), text);
}
const GROK = /grok/i;

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved[FLAG] = process.env[FLAG];
  delete process.env[FLAG];
});
afterEach(() => {
  if (saved[FLAG] === undefined) delete process.env[FLAG];
  else process.env[FLAG] = saved[FLAG];
});

function adminApproval(tool: string, mutation: Record<string, unknown>): ApprovalRequest {
  return {
    id: `apr_wording_${tool}_${Math.random().toString(36).slice(2, 8)}`,
    orgId: DEMO_ORG.id, employeeId: "emp_ops", credentialId: null, title: tool, summary: tool,
    purpose: `admin.${tool}`, risk: "high", tool, status: "approved", createdAt: new Date().toISOString(),
    metadata: { approvalClass: "admin", adminTool: tool, adminMutation: mutation },
  } as unknown as ApprovalRequest;
}

describe("Admin MCP: employees.issue / link (results, audit, tool descriptions)", () => {
  test("employees.issue nextStepJa: an AI agent, its ID (grokBotAgentId)", async () => {
    const r = await fulfillApprovedAdmin(adminApproval("employees.issue", {
      displayName: "文言一郎", roleLabel: "テスト", scopes: ["mail:draft"], expiresInDays: 30,
    }));
    expect(r?.ok).toBe(true);
    expect(r?.nextStepJa).toContain("AI エージェントを1体用意して、管理MCPの link にその AI エージェントの ID（grokBotAgentId）を渡してください。");
    expect(withoutIdentifiers(String(r?.nextStepJa))).not.toMatch(GROK);
    expect(withoutIdentifiers(JSON.stringify(r))).not.toMatch(GROK);
  });

  test("link: audit summary is neutral; metadata keeps grokBotAgentId", async () => {
    const r = await fulfillApprovedAdmin(adminApproval("link", { employeeId: "emp_sns", grokBotAgentId: "agent_wording_mcp" }));
    expect(r?.ok).toBe(true);
    expect(withoutIdentifiers(JSON.stringify(r))).not.toMatch(GROK);
    const audit = getRuntimeAudit().find((e) => e.action === "admin.link" && e.employeeId === "emp_sns");
    expect(audit?.summary).toBe("AI エージェントを連携（人承認後）");
    expect(audit?.metadata?.grokBotAgentId).toBe("agent_wording_mcp");
  });

  test("tools/list descriptions for employees.issue and link are neutral; schemas keep the field names", () => {
    const issue = ADMIN_MCP_TOOLS.find((t) => t.name === "employees.issue")!;
    const link = ADMIN_MCP_TOOLS.find((t) => t.name === "link")!;
    for (const t of [issue, link]) expect(withoutIdentifiers(t.description)).not.toMatch(GROK);
    expect(issue.description).toContain("prepare one AI agent");
    expect(issue.description).toContain("grokBotAgentId");
    expect(link.description).toContain("AI agent ID (grokBotAgentId)");
    const schema = link.inputSchema as { properties: Record<string, unknown>; required: string[] };
    expect(Object.keys(schema.properties)).toEqual(["employeeId", "grokBotAgentId", "grokBotWorkspaceId", "jobId"]);
    expect(schema.required).toEqual(["employeeId", "grokBotAgentId"]);
  });

  test("every Admin MCP tool description is neutral", () => {
    for (const t of ADMIN_MCP_TOOLS) expect({ tool: t.name, hit: GROK.test(withoutIdentifiers(t.description)) }).toEqual({ tool: t.name, hit: false });
  });
});

describe("REST: employees issue / link, gateway link / health", () => {
  test("POST /api/employees/issue notice is neutral", async () => {
    const body = await (await issuePost(new Request("https://x.invalid/api/employees/issue", {
      method: "POST", body: JSON.stringify({ displayName: "文言二郎", roleLabel: "テスト", scopes: ["mail:draft"] }),
    }))).json();
    expect(body.ok).toBe(true);
    expect(body.notice).toBe("この秘密値は一度だけ表示されます。AI エージェント側の連携設定に貼り付け、安全に保管してください。employeeId は生涯不変です。Instructions / Routine の承認待ちルールも必ず貼ってください。");
    expect(withoutIdentifiers(JSON.stringify({ ...body, credential: undefined }))).not.toMatch(GROK);
  });

  test("POST /api/employees/[id]/link message is neutral; still accepts grokBotAgentId", async () => {
    const res = await linkPost(new Request("https://x.invalid/api/employees/emp_ops/link", {
      method: "POST", body: JSON.stringify({ grokBotAgentId: "agent_wording_rest" }),
    }), { params: Promise.resolve({ id: "emp_ops" }) });
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.message).toBe("AI エージェントを連携しました（employeeId は不変）");
    expect(body.binding.grokBotAgentId).toBe("agent_wording_rest");
    expect(withoutIdentifiers(JSON.stringify(body))).not.toMatch(GROK);
  });

  test("POST /api/gateway/link messages and the audit they write are neutral (demo)", async () => {
    const messages: string[] = [];
    for (const action of ["connect", "handshake", "disconnect"]) {
      const body = await (await gatewayLinkPost(new Request("https://x.invalid/api/gateway/link", {
        method: "POST", body: JSON.stringify({ action }),
      }))).json();
      messages.push(String(body.message));
    }
    expect(messages).toEqual(["AI エージェントへ連携→戻る を待機中", "AI エージェントへ連携完了（デモ）", "連携解除済み"]);
    setGatewayStatus("linked");
    expect(getRuntimeAudit()[0].summary).toBe("AI エージェント連携ステータスが linked になりました");
    for (const e of getRuntimeAudit().filter((a) => a.action === "gateway.link_changed")) expect(e.summary).not.toMatch(GROK);
  });

  test("GET /api/gateway/health note is neutral (demo)", async () => {
    const body = await (await gatewayHealthGet()).json();
    expect(body.note).toBe("DEMO mode — Partner API / AI agent handshake is stubbed. Keys optional.");
    expect(JSON.stringify(body)).not.toMatch(GROK);
  });

  test("invoke refusal for an unlinked badge is neutral (fail-closed code unchanged)", () => {
    ensureBindingRow("emp_wording_unbound", DEMO_ORG.id);
    const d = assertExecutable("emp_wording_unbound");
    expect(d).toEqual({ ok: false, code: "unbound", message: "employee not linked to an AI agent; refuse invoke (fail-closed)" });
  });
});

/**
 * The employee server card. On main it is the static public/.well-known/mcp/server-card.json;
 * #256 replaces it with lib/mcp/server-card.ts (+ a production fixture). Read whichever exists so
 * this test keeps guarding the note after #256 lands (see PR body: conflict notes).
 */
async function loadServerCard(): Promise<{ notes: string[] }> {
  const builder = join(ROOT, "lib/mcp/server-card.ts");
  if (existsSync(builder)) {
    const mod = (await import(builder)) as { buildServerCard: (env: Record<string, string | undefined>) => { notes: string[] } };
    return mod.buildServerCard({ VERCEL_ENV: "production" });
  }
  return JSON.parse(readFileSync(join(ROOT, "public/.well-known/mcp/server-card.json"), "utf8")) as { notes: string[] };
}

describe("server card note: neutral, Grok Bot only as an example", () => {
  test("server-card notes", async () => {
    const card = await loadServerCard();
    expect(card.notes[0]).toBe("Public HTTPS only — register this URL in your AI agent's MCP connector settings (e.g. Grok Bot Plugins); no local stdio.");
    const grokNotes = card.notes.filter((n) => GROK.test(n));
    expect(grokNotes).toEqual([card.notes[0]]);
    expect(card.notes[0].replace("(e.g. Grok Bot Plugins)", "")).not.toMatch(GROK);
    expect(JSON.stringify(card)).not.toContain("grok.com");
  });
});

/**
 * Source scan: string literals in MCP / API code paths must not name Grok (identifiers and
 * comments excluded). lib/mcp/endpoint-handoff*.ts are covered by #256 (endpoint-handoff.wording.test.ts).
 */
const SCAN_DIRS = ["app/api", "lib/mcp", "lib/admin-mcp", "lib/gateway", "lib/approvals"];
const SCAN_FILES = [
  "lib/bindings.ts", "lib/data/bindings.ts", "lib/demo-data.ts",
  // Server cards: static JSON on main; lib/mcp/server-card.ts + fixtures after #256 (scanned via lib/mcp).
  "public/.well-known/mcp/server-card.json", "public/.well-known/mcp/admin-server-card.json",
  "lib/mcp/__fixtures__/server-card.production.json", "lib/mcp/__fixtures__/admin-server-card.production.json",
];
const SKIP_FILES = new Set(["lib/mcp/endpoint-handoff.ts", "lib/mcp/endpoint-handoff-block.ts"]);
const ALLOWED_LINES: Array<[string, string]> = [
  ["public/.well-known/mcp/server-card.json", "(e.g. Grok Bot Plugins)"],
  ["lib/mcp/server-card.ts", "(e.g. Grok Bot Plugins)"],
  ["lib/mcp/__fixtures__/server-card.production.json", "(e.g. Grok Bot Plugins)"],
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walk(rel, out);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && statSync(join(ROOT, rel)).isFile()) out.push(rel);
  }
  return out;
}

describe("source scan (MCP / API paths)", () => {
  test("no Grok in non-comment lines except field names and the server-card example", () => {
    const files = [...SCAN_DIRS.flatMap((d) => walk(d)), ...SCAN_FILES.filter((f) => existsSync(join(ROOT, f)))].filter((f) => !SKIP_FILES.has(f));
    expect(files.length).toBeGreaterThan(50);
    const hits: string[] = [];
    for (const file of files) {
      readFileSync(join(ROOT, file), "utf8").split("\n").forEach((line, i) => {
        const t = line.trim();
        if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;
        if (!GROK.test(withoutIdentifiers(line))) return;
        if (ALLOWED_LINES.some(([f, s]) => f === file && line.includes(s))) return;
        hits.push(`${file}:${i + 1}: ${t.slice(0, 120)}`);
      });
    }
    expect(hits).toEqual([]);
  });
});

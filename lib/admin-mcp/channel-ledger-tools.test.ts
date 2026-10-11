/**
 * PR-B admin MCP: channels.list / parties.list (read-only, org from the
 * credential only, paginated, no secrets / message content) and request-time
 * validation + always-on approval card for channels.classify / parties.upsert.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ADMIN_MCP_TOOLS, callAdminMcpTool } from "@/lib/mcp/admin-tools";
import { ADMIN_MCP_TOOL_NAMES } from "@/lib/mcp/admin-public";
import { READ_ONLY_ADMIN_TOOLS, PLAN_ADMIN_SCOPES } from "@/lib/billing/plan-scopes";
import { ADMIN_TOOL_AUDIT_ACTION } from "@/lib/admin-mcp/audit-class";
import { DEMO_ORG } from "@/lib/demo-data";
import { resetDemoAdminAgent } from "@/lib/data/admin-agents";
import { listApprovals } from "@/lib/data";
import { upsertOrgChannel, upsertOrgParty } from "@/lib/data/directory";
import { setChannelFactsDepsForTests } from "@/lib/channel-classify/facts";
import type { ResolvedAdminCredential } from "@/lib/auth/admin-credential";

const OTHER = "org_ledger_other_fixture";

function cred(): ResolvedAdminCredential {
  const agent = resetDemoAdminAgent({ grokBotAgentId: "admin_agent_ledger", status: "linked" });
  return { orgId: DEMO_ORG.id, adminAgentId: agent.id, grokBotAgentId: agent.grokBotAgentId, actorId: agent.id, generation: agent.credentialGeneration, via: "bearer", agent };
}

function data(result: { structuredContent?: unknown }): Record<string, unknown> {
  return result.structuredContent as Record<string, unknown>;
}

afterEach(() => setChannelFactsDepsForTests(null));

async function seed() {
  for (const id of ["C0LIST0001", "C0LIST0002", "C0LIST0003"]) {
    await upsertOrgChannel({ orgId: DEMO_ORG.id, surface: "slack", externalId: id, classification: "internal", skipInspect: true });
  }
  await upsertOrgChannel({ orgId: OTHER, surface: "slack", externalId: "C0FOREIGN01", classification: "internal", skipInspect: true });
  await upsertOrgParty({ orgId: DEMO_ORG.id, kind: "slack_user", identifier: "U0LISTPARTY1", audience: "internal" });
  await upsertOrgParty({ orgId: OTHER, kind: "slack_user", identifier: "U0FOREIGNP1", audience: "internal" });
}

describe("registry", () => {
  test("channels.list / parties.list are advertised, read-only (no approvalClass), plan-ungated", () => {
    for (const name of ["channels.list", "parties.list"]) {
      expect((ADMIN_MCP_TOOL_NAMES as readonly string[]).includes(name)).toBe(true);
      const def = ADMIN_MCP_TOOLS.find((t) => t.name === name);
      expect(def).toBeDefined();
      expect(def?.approvalClass).toBeUndefined();
      expect(/read-only/i.test(def?.description || "")).toBe(true);
      expect((def?.inputSchema as { additionalProperties?: boolean }).additionalProperties).toBe(false);
      expect(Object.keys((def?.inputSchema as { properties: Record<string, unknown> }).properties)).not.toContain("orgId");
      expect((READ_ONLY_ADMIN_TOOLS as readonly string[]).includes(name)).toBe(true);
      for (const plan of Object.keys(PLAN_ADMIN_SCOPES) as Array<keyof typeof PLAN_ADMIN_SCOPES>) {
        expect((PLAN_ADMIN_SCOPES[plan] as readonly string[]).includes(name)).toBe(true);
      }
    }
  });

  test("server card and docs list both tools; classify / upsert keep their audit actions and titles", () => {
    const card = readFileSync(fileURLToPath(new URL("../../public/.well-known/mcp/admin-server-card.json", import.meta.url)), "utf8");
    const docs = readFileSync(fileURLToPath(new URL("../../docs/channel-classify-proposals.md", import.meta.url)), "utf8");
    for (const name of ["channels.list", "parties.list", "channels.classify", "parties.upsert"]) {
      expect(card).toContain(`"${name}"`);
      expect(docs).toContain(name);
    }
    expect(ADMIN_TOOL_AUDIT_ACTION["channels.classify"]).toBe("admin.channel");
    expect(ADMIN_TOOL_AUDIT_ACTION["parties.upsert"]).toBe("admin.parties");
  });
});

describe("channels.list", () => {
  test("org from the credential only (an orgId argument is refused), no secrets", async () => {
    await seed();
    const r = await callAdminMcpTool("channels.list", {}, cred());
    const body = data(r);
    expect(body.ok).toBe(true);
    const items = body.items as Array<Record<string, unknown>>;
    expect(items.some((i) => i.externalId === "C0LIST0001")).toBe(true);
    expect(items.some((i) => i.externalId === "C0FOREIGN01")).toBe(false);
    for (const item of items) {
      expect(Object.keys(item).sort()).toEqual(["classification", "createdAt", "externalId", "mixed", "surface", "updatedAt"]);
    }
    const spoof = await callAdminMcpTool("channels.list", { orgId: OTHER }, cred());
    expect(spoof.isError).toBe(true);
    expect(data(spoof).code).toBe("unknown_argument");
  });

  test("paginates with an opaque cursor; bad cursor / limit rejected", async () => {
    await seed();
    const page1 = data(await callAdminMcpTool("channels.list", { limit: 2 }, cred()));
    expect((page1.items as unknown[]).length).toBe(2);
    expect(typeof page1.nextCursor).toBe("string");
    const page2 = data(await callAdminMcpTool("channels.list", { limit: 2, cursor: page1.nextCursor }, cred()));
    expect((page2.items as unknown[]).length).toBeGreaterThan(0);
    const ids1 = (page1.items as Array<{ externalId: string }>).map((i) => i.externalId);
    const ids2 = (page2.items as Array<{ externalId: string }>).map((i) => i.externalId);
    expect(ids1.some((id) => ids2.includes(id))).toBe(false);
    expect(data(await callAdminMcpTool("channels.list", { cursor: "not-a-cursor" }, cred())).code).toBe("invalid_cursor");
    expect(data(await callAdminMcpTool("channels.list", { limit: 1000 }, cred())).code).toBe("invalid_limit");
    expect(data(await callAdminMcpTool("channels.list", { surface: "slak" }, cred())).code).toBe("invalid_surface");
  });
});

describe("parties.list", () => {
  test("org-scoped, filtered, whitelisted fields", async () => {
    await seed();
    const body = data(await callAdminMcpTool("parties.list", { kind: "slack_user" }, cred()));
    expect(body.ok).toBe(true);
    const items = body.items as Array<Record<string, unknown>>;
    expect(items.some((i) => i.identifier === "U0LISTPARTY1")).toBe(true);
    expect(items.some((i) => i.identifier === "U0FOREIGNP1")).toBe(false);
    for (const item of items) expect(Object.keys(item).sort()).toEqual(["audience", "createdAt", "identifier", "kind", "updatedAt"]);
    expect(data(await callAdminMcpTool("parties.list", { kind: "slack-user" }, cred())).code).toBe("invalid_kind");
  });
});

describe("request-time validation (no ticket on a typo)", () => {
  test("channels.classify invalid classification / surface → error with allowed + nextStep, no approval created", async () => {
    const before = (await listApprovals(DEMO_ORG.id)).length;
    const r = await callAdminMcpTool("channels.classify", { externalId: "C0TYPO0001", classification: "internl" }, cred());
    expect(r.isError).toBe(true);
    const body = data(r);
    expect(body.code).toBe("invalid_classification");
    expect(body.allowed).toEqual(["internal", "shared_external", "unknown"]);
    expect(String(body.nextStep)).toContain("channels.classify");
    const s = data(await callAdminMcpTool("channels.classify", { externalId: "C0TYPO0001", surface: "slak", classification: "internal" }, cred()));
    expect(s.code).toBe("invalid_surface");
    expect((await listApprovals(DEMO_ORG.id)).length).toBe(before);
  });

  test("parties.upsert invalid kind / audience → error, no approval created", async () => {
    const before = (await listApprovals(DEMO_ORG.id)).length;
    expect(data(await callAdminMcpTool("parties.upsert", { kind: "slackuser", identifier: "U0X" }, cred())).code).toBe("invalid_kind");
    expect(data(await callAdminMcpTool("parties.upsert", { kind: "slack_user", identifier: "U0X", audience: "internl" }, cred())).code).toBe("invalid_audience");
    expect((await listApprovals(DEMO_ORG.id)).length).toBe(before);
  });
});

describe("approval card (always, independent of P1_CONFIG_CHANGE_REQUEST_ENABLED)", () => {
  test("channels.classify card shows before → after and the sharing state (Connect / guests); ≤ 400 chars; no token", async () => {
    delete process.env.P1_CONFIG_CHANGE_REQUEST_ENABLED;
    setChannelFactsDepsForTests({
      resolveToken: async () => "xoxb-secret-fixture-token",
      homeTeamIds: async () => ["T0HOMETEAM"],
      slackApi: async (method, params) => {
        if (method === "conversations.info") return { ok: true, channel: { id: params.channel, is_channel: true, is_private: true, is_shared: true, is_ext_shared: true } };
        if (method === "conversations.members") return { ok: true, members: ["U0IN", "U0GUEST"], response_metadata: { next_cursor: "" } };
        if (method === "users.info") return params.user === "U0GUEST" ? { ok: true, user: { id: "U0GUEST", team_id: "T0HOMETEAM", is_restricted: true } } : { ok: true, user: { id: params.user, team_id: "T0HOMETEAM" } };
        return { ok: false };
      },
    });
    const r = data(await callAdminMcpTool("channels.classify", { externalId: "C0CARD0001", classification: "shared_external", mixed: true }, cred()));
    expect(r.code).toBe("needs_approval");
    const summary = String(r.summary);
    expect(summary).toContain("未登録");
    expect(summary).toContain("shared_external");
    expect(summary).toContain("Slack Connect");
    expect(summary).toContain("ゲスト");
    expect(summary.length).toBeLessThanOrEqual(400);
    expect(summary).not.toContain("xoxb");
  });

  test("parties.upsert card shows before → after", async () => {
    await upsertOrgParty({ orgId: DEMO_ORG.id, kind: "slack_user", identifier: "U0CARDP001", audience: "external" });
    const r = data(await callAdminMcpTool("parties.upsert", { kind: "slack_user", identifier: "U0CARDP001", audience: "internal" }, cred()));
    expect(r.code).toBe("needs_approval");
    const summary = String(r.summary);
    expect(summary).toContain("external");
    expect(summary).toContain("internal");
    expect(summary).toContain("U0CARDP001");
  });
});

describe("09:34 additions: org from the credential only, titles", () => {
  test("channels.classify / parties.upsert with an orgId argument → unknown_argument, no approval created", async () => {
    const before = (await listApprovals(DEMO_ORG.id)).length;
    const c = await callAdminMcpTool("channels.classify", { externalId: "C0ORGARG01", classification: "internal", orgId: OTHER }, cred());
    expect(c.isError).toBe(true);
    expect(data(c).code).toBe("unknown_argument");
    expect(data(c).field).toBe("orgId");
    expect(String(data(c).nextStep)).toContain("channels.classify");
    const p = await callAdminMcpTool("parties.upsert", { kind: "slack_user", identifier: "U0ORGARG1", audience: "internal", orgId: OTHER }, cred());
    expect(data(p).code).toBe("unknown_argument");
    expect((await listApprovals(DEMO_ORG.id)).length).toBe(before);
  });

  test("the queued ticket belongs to the credential's org and stores normalized args", async () => {
    const r = data(await callAdminMcpTool("channels.classify", { externalId: " C0NORM0001 ", classification: "internal" }, cred()));
    expect(r.code).toBe("needs_approval");
    const row = (await listApprovals(DEMO_ORG.id)).find((a) => a.id === r.approvalId);
    expect(row?.orgId).toBe(DEMO_ORG.id);
    expect(row?.metadata?.adminMutation).toMatchObject({ surface: "slack", externalId: "C0NORM0001", classification: "internal", mixed: false });
  });

  test("TOOL_TITLE_JA has a Japanese title for classify / upsert / both list tools", async () => {
    const { ADMIN_TOOL_TITLE_JA } = await import("@/lib/admin-mcp/queue");
    for (const name of ["channels.classify", "parties.upsert", "channels.list", "parties.list"]) {
      expect(typeof ADMIN_TOOL_TITLE_JA[name]).toBe("string");
    }
  });
});

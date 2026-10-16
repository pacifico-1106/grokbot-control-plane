/**
 * L-8: owner/admin LINE conversation connect. Flags default OFF → 404.
 * Same-org BOLA. No Admin MCP tool. LINE is mocked.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createCommAccount,
  resetDemoCommAccounts,
  setCommAccountSecrets,
} from "@/lib/comm/accounts";
import { DEMO_ORG, getRuntimeMembers } from "@/lib/demo-data";

const ENV = [
  "COMM_ACCOUNTS_ENABLED",
  "LINE_CONVERSATION_ENABLED",
  "LINE_WEBHOOK_AUTO_SETUP_ENABLED",
  "NOTIFICATION_CONFIG_ENCRYPTION_KEY",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_APP_URL",
] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));

const BOT = `U${"b".repeat(32)}`;
const TOKEN = "A".repeat(120);
const SECRET = "0123456789abcdef0123456789abcdef";
const SECRETS = { channelAccessToken: TOKEN, channelSecret: SECRET };
const ORIGIN = "https://staffpass.sealith.com";

const origFetch = globalThis.fetch;
let calls: string[];

beforeEach(() => {
  process.env.COMM_ACCOUNTS_ENABLED = "true";
  process.env.LINE_CONVERSATION_ENABLED = "true";
  process.env.LINE_WEBHOOK_AUTO_SETUP_ENABLED = "true";
  process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY = "k".repeat(40);
  process.env.NEXT_PUBLIC_APP_URL = ORIGIN;
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  resetDemoCommAccounts();
  calls = [];
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push(`${init?.method || "GET"} ${String(url)}`);
    if (String(url).endsWith("/v2/bot/info")) {
      return new Response(JSON.stringify({ userId: BOT, displayName: "営業AI（AIスタッフ）" }), { status: 200 });
    }
    if (String(url).includes("/webhook/test")) {
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = origFetch;
  resetDemoCommAccounts();
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const ctx = (id = "emp_comm") => ({ params: Promise.resolve({ id }) });
const req = (method: "GET" | "POST", id = "emp_comm", member = "mem_1", body?: Record<string, unknown>) =>
  new Request(`https://staffpass.test/api/employees/${id}/comm-account`, {
    method,
    headers: { "content-type": "application/json", "x-member-id": member },
    body: method === "POST" ? JSON.stringify(body ?? SECRETS) : undefined,
  });

describe("/api/employees/[id]/comm-account", () => {
  test("flags OFF → 404 feature_disabled (no LINE call)", async () => {
    const { POST, GET } = await import("@/app/api/employees/[id]/comm-account/route");
    process.env.LINE_WEBHOOK_AUTO_SETUP_ENABLED = "";
    expect((await POST(req("POST"), ctx())).status).toBe(404);
    expect((await GET(req("GET"), ctx())).status).toBe(404);
    expect(calls).toEqual([]);
  });

  test("unknown employee (BOLA / same-org) → 404", async () => {
    const { POST } = await import("@/app/api/employees/[id]/comm-account/route");
    const res = await POST(req("POST", "emp_other_org"), ctx("emp_other_org"));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ ok: false, error: "employee_not_found" });
    expect(calls).toEqual([]);
  });

  test("member (not owner/admin) → 403", async () => {
    const { POST } = await import("@/app/api/employees/[id]/comm-account/route");
    const member = getRuntimeMembers().find((m) => m.id === "mem_3")!;
    const prevCap = member.capabilities;
    member.capabilities = [...(prevCap ?? []), "view_employees"];
    try {
      const res = await POST(req("POST", "emp_comm", "mem_3"), ctx());
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe("admin_required");
      expect(calls).toEqual([]);
    } finally {
      member.capabilities = prevCap;
    }
  });

  test("owner connects: stores bot userId and returns the conversation webhook URL", async () => {
    const { POST } = await import("@/app/api/employees/[id]/comm-account/route");
    const res = await POST(req("POST", "emp_comm", "mem_1"), ctx());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      botUserId: string;
      webhookUrl: string;
      account: { botUserId: string; webhookPath: string };
    };
    expect(body.ok).toBe(true);
    expect(body.botUserId).toBe(BOT);
    expect(body.account.botUserId).toBe(BOT);
    expect(body.webhookUrl).toMatch(new RegExp(`^${ORIGIN}/api/webhooks/line/c/[A-Za-z0-9_-]{43}$`));
    expect(body.account.webhookPath.startsWith("/api/webhooks/line/c/")).toBe(true);
    expect(calls).toEqual([
      "GET https://api.line.me/v2/bot/info",
      "PUT https://api.line.me/v2/bot/channel/webhook/endpoint",
      "POST https://api.line.me/v2/bot/channel/webhook/test",
    ]);
    expect(JSON.stringify(body)).not.toContain(TOKEN);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("admin can connect; GET never returns the token", async () => {
    const { POST, GET } = await import("@/app/api/employees/[id]/comm-account/route");
    const admin = getRuntimeMembers().find((m) => m.id === "mem_2")!;
    const prev = admin.role;
    admin.role = "admin";
    try {
      expect((await POST(req("POST", "emp_comm", "mem_2"), ctx())).status).toBe(200);
      const res = await GET(req("GET", "emp_comm", "mem_2"), ctx());
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.account.botUserId).toBe(BOT);
      expect(JSON.stringify(body)).not.toContain(TOKEN);
      expect(JSON.stringify(body)).not.toContain(SECRET);
    } finally {
      admin.role = prev;
    }
  });

  test("re-setup without secrets decrypts the stored token", async () => {
    const created = await createCommAccount({
      orgId: DEMO_ORG.id,
      employeeId: "emp_comm",
      surface: "line",
      externalAccountId: BOT,
      createdByMemberId: "mem_1",
    });
    if (!created.ok) throw new Error(created.reason);
    await setCommAccountSecrets({ orgId: DEMO_ORG.id, accountId: created.account.id, secrets: SECRETS, memberId: "mem_1" });
    const { POST } = await import("@/app/api/employees/[id]/comm-account/route");
    const res = await POST(req("POST", "emp_comm", "mem_1", {}), ctx());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; webhookUrl: string };
    expect(body.ok).toBe(true);
    expect(body.webhookUrl).toBe(`${ORIGIN}/api/webhooks/line/c/${created.account.webhookRef}`);
  });

  test("Admin MCP / employee MCP source has no comm-account connect tool", () => {
    const admin = readFileSync(join(process.cwd(), "lib/mcp/admin-tools.ts"), "utf8");
    const emp = readFileSync(join(process.cwd(), "lib/mcp/tools.ts"), "utf8");
    expect(admin).not.toMatch(/comm-account|setupLineConversationWebhook|line-webhook-setup/);
    expect(emp).not.toMatch(/comm-account|setupLineConversationWebhook|line-webhook-setup/);
  });
});

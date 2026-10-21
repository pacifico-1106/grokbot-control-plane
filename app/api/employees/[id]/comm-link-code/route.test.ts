/**
 * Kimura 10/14: conversation link codes are issued on the admin employee
 * detail page only. Owner / approvers, same-org BOLA. No admin MCP.
 * Flags COMM_ACCOUNTS_ENABLED + LINE_CONVERSATION_ENABLED default OFF.
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
import { resetDemoConversationLinkCodes } from "@/lib/comm/conversation-link-code";
import { resetDemoLineLinkCodes } from "@/lib/line/link-code";

const ENV = [
  "COMM_ACCOUNTS_ENABLED",
  "LINE_CONVERSATION_ENABLED",
  "NOTIFICATION_CONFIG_ENCRYPTION_KEY",
  "NEXT_PUBLIC_SUPABASE_URL",
  "VOTER_BINDING_SECRET",
] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));

const BOT = `U${"1".repeat(32)}`;
const SECRETS = { channelAccessToken: "A".repeat(120), channelSecret: "0123456789abcdef0123456789abcdef" };

beforeEach(async () => {
  process.env.COMM_ACCOUNTS_ENABLED = "true";
  process.env.LINE_CONVERSATION_ENABLED = "true";
  process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY = "k".repeat(40);
  process.env.VOTER_BINDING_SECRET = "v".repeat(48);
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  resetDemoCommAccounts();
  resetDemoLineLinkCodes();
  resetDemoConversationLinkCodes();
  const created = await createCommAccount({
    orgId: DEMO_ORG.id,
    employeeId: "emp_comm",
    surface: "line",
    externalAccountId: BOT,
    createdByMemberId: "mem_1",
  });
  if (!created.ok) throw new Error(created.reason);
  await setCommAccountSecrets({
    orgId: DEMO_ORG.id,
    accountId: created.account.id,
    secrets: SECRETS,
    memberId: "mem_1",
  });
});
afterEach(() => {
  resetDemoLineLinkCodes();
  resetDemoConversationLinkCodes();
  resetDemoCommAccounts();
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const ctx = (id = "emp_comm") => ({ params: Promise.resolve({ id }) });
const post = (id = "emp_comm", member = "mem_1", body: Record<string, unknown> = {}) =>
  new Request(`https://staffpass.test/api/employees/${id}/comm-link-code`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-member-id": member },
    body: JSON.stringify(body),
  });
const get = (id = "emp_comm", member = "mem_1") =>
  new Request(`https://staffpass.test/api/employees/${id}/comm-link-code`, {
    headers: { "x-member-id": member },
  });

describe("/api/employees/[id]/comm-link-code", () => {
  test("flags OFF → 404 feature_disabled", async () => {
    const { POST, GET } = await import("@/app/api/employees/[id]/comm-link-code/route");
    process.env.LINE_CONVERSATION_ENABLED = "";
    expect((await POST(post(), ctx())).status).toBe(404);
    expect((await GET(get(), ctx())).status).toBe(404);
  });

  test("unknown employee (BOLA / same-org) → 404, no code", async () => {
    const { POST } = await import("@/app/api/employees/[id]/comm-link-code/route");
    const res = await POST(post("emp_other_org"), ctx("emp_other_org"));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ ok: false, error: "employee_not_found" });
  });

  test("member without owner/approver rights → 403", async () => {
    const { POST } = await import("@/app/api/employees/[id]/comm-link-code/route");
    const viewer = getRuntimeMembers().find((m) => m.id === "mem_3")!;
    const prevCap = viewer.capabilities;
    const prevRole = viewer.role;
    viewer.capabilities = ["view_dashboard", "view_employees"];
    viewer.role = "member";
    try {
      const res = await POST(post("emp_comm", "mem_3"), ctx());
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe("approver_required");
    } finally {
      viewer.capabilities = prevCap;
      viewer.role = prevRole;
    }
  });

  test("owner issues a code for themselves; body.memberId of another person is ignored", async () => {
    const { POST } = await import("@/app/api/employees/[id]/comm-link-code/route");
    const res = await POST(post("emp_comm", "mem_1", { memberId: "mem_2" }), ctx());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; display: string; memberId: string };
    expect(body.ok).toBe(true);
    expect(body.memberId).toBe("mem_1");
    expect(body.display).toMatch(/^SP-/);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("admin without approve_actions → 403", async () => {
    const { POST } = await import("@/app/api/employees/[id]/comm-link-code/route");
    const admin = getRuntimeMembers().find((m) => m.id === "mem_3")!;
    const prevCap = admin.capabilities;
    const prevRole = admin.role;
    admin.capabilities = ["view_dashboard", "view_employees", "manage_team"];
    admin.role = "admin";
    try {
      const res = await POST(post("emp_comm", "mem_3"), ctx());
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe("approver_required");
    } finally {
      admin.capabilities = prevCap;
      admin.role = prevRole;
    }
  });

  test("approver (approve_actions) can issue", async () => {
    const { POST } = await import("@/app/api/employees/[id]/comm-link-code/route");
    const res = await POST(post("emp_comm", "mem_2"), ctx());
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  test("admin MCP source has no conversation link-code issue tool", () => {
    const src = readFileSync(join(process.cwd(), "lib/mcp/admin-tools.ts"), "utf8");
    expect(src).not.toMatch(/issueLineLinkCode|comm-link-code|conversation_link_code/);
  });

  test("M1: issue/pending do not pass comm-account id as line_approver_link_codes.channel_id", () => {
    const src = readFileSync(join(process.cwd(), "app/api/employees/[id]/comm-link-code/route.ts"), "utf8");
    expect(src).not.toMatch(/channelId:\s*found\.account\.id/);
    expect(src).toMatch(/issueConversationLinkCode|getPendingConversationLinkCode/);
  });
});

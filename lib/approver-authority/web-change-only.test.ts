/**
 * #279 decision 3 (木村 2026-10-09 22:48): SoD warn policy and Slack
 * conversation-adapter dashboard saves are gated only when a field actually
 * changes. Unreadable previous value → changed (gated). A bot token in the
 * request → changed (gated; tokens cannot be compared).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { scopedModuleMocks } from "../../tests/helpers/scoped-module-mock";
import { DEMO_ORG, resetRuntimeMembers, upsertRuntimeMember } from "@/lib/demo-data";
import type { OrgMember } from "@/lib/types";

let unreadable = false;
const real = { ...(await import("@/lib/approver-authority/web-prev-state")) };
const mocks = scopedModuleMocks();
await mocks.mock("@/lib/approver-authority/web-prev-state", {
  readPrevSodWarnPolicy: async (orgId: string) => (unreadable ? null : real.readPrevSodWarnPolicy(orgId)),
  readPrevSlackAdapter: async (orgId: string) => (unreadable ? null : real.readPrevSlackAdapter(orgId)),
});

const { PUT: putSod } = await import("@/app/api/settings/sod-warn-policy/route");
const { PUT: putAdapters } = await import("@/app/api/settings/conversation-adapters/route");
const { upsertConversationAdapter } = await import("@/lib/data/conversation-adapters");
const { resetDemoDesignatedAdminsForTests } = await import("@/lib/approver-authority/designated-admins");

const ORG = DEMO_ORG.id;
const ADMIN = "mem_wco_plain_admin"; // not owner, not designated → refused whenever the gate runs
const FLAG = "APPROVER_AUTHORITY_ENABLED";
const ALL = ["comm_external", "money", "destructive", "commit"] as const;
let saved: string | undefined;

beforeEach(async () => {
  saved = process.env[FLAG];
  process.env[FLAG] = "true";
  unreadable = false;
  resetRuntimeMembers();
  upsertRuntimeMember({ id: ADMIN, orgId: ORG, email: `${ADMIN}@fixture.invalid`, displayName: ADMIN, role: "admin", status: "active", capabilities: ["view_dashboard", "manage_team"] as OrgMember["capabilities"] }, { audit: false });
  resetDemoDesignatedAdminsForTests();
  DEMO_ORG.sodWarnPolicy = { domains: [...ALL] };
  await upsertConversationAdapter({ orgId: ORG, surface: "slack", label: "会話Bot", enabled: true, config: {}, secrets: { botToken: "xoxb-fixture-not-real-0000" } });
});
afterEach(() => {
  if (saved === undefined) delete process.env[FLAG];
  else process.env[FLAG] = saved;
  unreadable = false;
  DEMO_ORG.sodWarnPolicy = { domains: [...ALL] };
  resetRuntimeMembers();
  resetDemoDesignatedAdminsForTests();
});

const req = (url: string, body: Record<string, unknown>) =>
  new Request(url, { method: "PUT", headers: { "content-type": "application/json", "x-member-id": ADMIN }, body: JSON.stringify({ actorMemberId: ADMIN, ...body }) });
const sod = (body: Record<string, unknown>) => putSod(req("http://localhost/api/settings/sod-warn-policy", body));
const adapter = (body: Record<string, unknown>) => putAdapters(req("http://localhost/api/settings/conversation-adapters", { surface: "slack", ...body }));
const gated = async (res: Response) => res.status === 403 && ((await res.json()) as { error?: string }).error === "approver_authority_denied";

describe("PUT /api/settings/sod-warn-policy", () => {
  test("unchanged (same domains, any order) → allowed without the gate", async () => {
    const res = await sod({ domains: ["commit", "money", "destructive", "comm_external"] });
    expect(await gated(res)).toBe(false);
    expect(res.status).toBe(200);
  });
  test("changed → gated", async () => {
    expect(await gated(await sod({ domains: ["money"] }))).toBe(true);
    expect(DEMO_ORG.sodWarnPolicy.domains).toEqual([...ALL]);
  });
  test("previous value unreadable → treated as changed → gated", async () => {
    unreadable = true;
    expect(await gated(await sod({ domains: [...ALL] }))).toBe(true);
  });
});

describe("PUT /api/settings/conversation-adapters", () => {
  test("unchanged (same label / enabled, no token) → allowed without the gate", async () => {
    const res = await adapter({ label: "会話Bot", enabled: true });
    expect(await gated(res)).toBe(false);
    expect(res.status).toBe(200);
  });
  test("changed (enabled or label) → gated", async () => {
    expect(await gated(await adapter({ label: "会話Bot", enabled: false }))).toBe(true);
    expect(await gated(await adapter({ label: "別の名前", enabled: true }))).toBe(true);
  });
  test("previous value unreadable → treated as changed → gated", async () => {
    unreadable = true;
    expect(await gated(await adapter({ label: "会話Bot", enabled: true }))).toBe(true);
  });
  test("a bot token in the request always counts as changed → gated (even the same label / enabled)", async () => {
    expect(await gated(await adapter({ label: "会話Bot", enabled: true, botToken: "xoxb-fixture-not-real-0000" }))).toBe(true);
  });
});

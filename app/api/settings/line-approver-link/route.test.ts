/**
 * /api/settings/line-approver-link — issue a one-time LINE link code for the
 * signed-in member (G1/G4). Flag LINE_APPROVER_LINK_ENABLED, default OFF.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const ORG = "org_demo";
type Session = {
  demo: boolean; userId: string | null; email: string | null; orgId: string | null;
  member: Record<string, unknown> | null;
};
let session: Session;
let audits: Array<Record<string, unknown>>;

const activeMember = (over: Record<string, unknown> = {}) => ({
  id: "mem_3", orgId: ORG, userId: "auth-3", email: "a@example.com", role: "member",
  capabilities: ["approve_actions"], status: "active", ...over,
});

mock.module("@/lib/auth/session", () => ({ getSessionContext: async () => session }));
mock.module("@/lib/data", () => ({
  listNotificationChannels: async (orgId: string) =>
    orgId === ORG
      ? [
          { id: "chn-line-1", orgId: ORG, provider: "line", enabled: true },
          { id: "chn-tg-1", orgId: ORG, provider: "telegram", enabled: true },
        ]
      : [],
  appendAuditEvent: async (event: Record<string, unknown>) => { audits.push(event); },
}));

const { GET, POST } = await import("./route");
const { consumeLineLinkCode, parseLineLinkCodeText, resetDemoLineLinkCodes } = await import("@/lib/line/link-code");
const raw = (display: string) => parseLineLinkCodeText(display) as string;
const { resetDemoVoterBindings, upsertProofVerifiedVoterBinding } = await import("@/lib/approval-workflow/voter-binding");

const post = (body: unknown) =>
  POST(new Request("http://x/api/settings/line-approver-link", { method: "POST", body: JSON.stringify(body) }));
const get = (channelId: string) => GET(new Request(`http://x/api/settings/line-approver-link?channelId=${channelId}`));

beforeEach(() => {
  process.env.LINE_APPROVER_LINK_ENABLED = "true";
  session = { demo: false, userId: "auth-3", email: "a@example.com", orgId: ORG, member: activeMember() };
  audits = [];
  resetDemoLineLinkCodes();
  resetDemoVoterBindings?.();
});
afterEach(() => { delete process.env.LINE_APPROVER_LINK_ENABLED; });

describe("flag + auth", () => {
  test("flag OFF → 404 for GET and POST", async () => {
    delete process.env.LINE_APPROVER_LINK_ENABLED;
    expect((await post({ channelId: "chn-line-1" })).status).toBe(404);
    expect((await get("chn-line-1")).status).toBe(404);
  });
  test("no session → 401", async () => {
    session = { demo: false, userId: null, email: null, orgId: null, member: null };
    expect((await post({ channelId: "chn-line-1" })).status).toBe(401);
  });
  test("member without approve_actions → 403", async () => {
    session.member = activeMember({ capabilities: ["view_dashboard"] });
    expect((await post({ channelId: "chn-line-1" })).status).toBe(403);
  });
  test("suspended member → 401", async () => {
    session.member = activeMember({ status: "suspended" });
    expect((await post({ channelId: "chn-line-1" })).status).toBe(401);
  });
});

describe("issue", () => {
  test("non-LINE or foreign channel → 404", async () => {
    expect((await post({ channelId: "chn-tg-1" })).status).toBe(404);
    expect((await post({ channelId: "chn-other-org" })).status).toBe(404);
  });
  test("issues a code for the session member only; audit never contains the code", async () => {
    const res = await post({ channelId: "chn-line-1", memberId: "mem_1" /* ignored */ });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; code: string; expiresAt: string };
    expect(json.code).toMatch(/^SP-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
    const consumed = await consumeLineLinkCode({ orgId: ORG, channelId: "chn-line-1", code: raw(json.code), lineUserId: "U1" });
    expect(consumed.ok && consumed.memberId).toBe("mem_3");
    expect(audits).toHaveLength(1);
    expect((audits[0].metadata as Record<string, unknown>).event).toBe("line_approver_link_code_issued");
    expect(JSON.stringify(audits[0])).not.toContain(json.code.replace(/^SP-/, "").replace("-", ""));
    expect(JSON.stringify(audits[0])).not.toContain(json.code);
  });
});

describe("status", () => {
  test("pending then linked", async () => {
    const issued = (await (await post({ channelId: "chn-line-1" })).json()) as { code: string };
    let status = (await (await get("chn-line-1")).json()) as { pending: unknown; linked: string[] };
    expect(status.pending).not.toBeNull();
    expect(status.linked).toEqual([]);
    expect(JSON.stringify(status)).not.toContain(issued.code);
    await consumeLineLinkCode({ orgId: ORG, channelId: "chn-line-1", code: raw(issued.code), lineUserId: "U9" });
    await upsertProofVerifiedVoterBinding({
      orgId: ORG, provider: "line", channelKey: "chn-line-1", externalUserId: "U9", memberId: "mem_3",
    });
    status = (await (await get("chn-line-1")).json()) as { pending: unknown; linked: string[] };
    expect(status.pending).toBeNull();
    expect(status.linked).toEqual(["U9"]);
  });
  test("foreign channel → 404", async () => {
    expect((await get("chn-other-org")).status).toBe(404);
  });
});

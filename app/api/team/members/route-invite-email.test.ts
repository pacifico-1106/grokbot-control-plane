/**
 * POST /api/team/members sends the invite email only for a NEW invite that the
 * guard accepted (never on edits, never on denials), and reports the outcome.
 * Flag OFF → response shape unchanged (no inviteEmail field).
 */
import { beforeEach, expect, mock, test } from "bun:test";
import { DEMO_ORG, getRuntimeMembers, resetRuntimeMembers } from "@/lib/demo-data";

let sent: Array<Record<string, unknown>> = [];
let outcome: "sent" | "existing_account" | "failed" | "disabled" = "sent";

mock.module("next/cache", () => ({ revalidatePath: () => {} }));
mock.module("@/lib/billing/entitlements", () => ({
  assertBillingAllows: async () => ({ ok: true, entitlements: {} }),
}));
mock.module("@/lib/auth/invite-email", () => ({
  sendMemberInviteEmail: async (i: Record<string, unknown>) => {
    sent.push(i);
    return outcome;
  },
}));

const { POST } = await import("./route");

beforeEach(() => {
  resetRuntimeMembers();
  sent = [];
  outcome = "sent";
});

const post = (body: Record<string, unknown>) =>
  POST(new Request("https://fixture.invalid/api/team/members", {
    method: "POST",
    headers: { "content-type": "application/json", "x-member-id": "mem_1" },
    body: JSON.stringify(body),
  }));

test("new invite accepted by the guard → invite email sent once, outcome in the response", async () => {
  const res = await post({ email: "New.Person@Fixture.Invalid", displayName: "New", role: "member", capabilities: ["view_dashboard"] });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(body.inviteEmail).toBe("sent");
  expect(sent.length).toBe(1);
  expect(sent[0].email).toBe("new.person@fixture.invalid");
  expect(sent[0].orgId).toBe(DEMO_ORG.id);
  expect(sent[0].memberId).toBe(body.member.id);
});

test("editing an existing member never sends an invite email", async () => {
  const target = getRuntimeMembers().find((m) => m.id !== "mem_1")!;
  const res = await post({ id: target.id, email: target.email, displayName: target.displayName, role: target.role, capabilities: target.capabilities });
  expect(res.status).toBe(200);
  expect(sent).toEqual([]);
  expect((await res.json()).inviteEmail).toBeUndefined();
});

test("denied invite (privileged capability by a non-owner path) sends nothing", async () => {
  const res = await POST(new Request("https://fixture.invalid/api/team/members", {
    method: "POST",
    headers: { "content-type": "application/json", "x-member-id": "mem_1" },
    body: JSON.stringify({ email: "x@fixture.invalid", displayName: "X", role: "bogus-role", capabilities: ["view_dashboard"] }),
  }));
  expect(res.ok).toBe(false);
  expect(sent).toEqual([]);
});

test("flag OFF / demo (disabled) → response has no inviteEmail field", async () => {
  outcome = "disabled";
  const res = await post({ email: "other@fixture.invalid", displayName: "Other", role: "member", capabilities: ["view_dashboard"] });
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect("inviteEmail" in body).toBe(false);
  expect(sent.length).toBe(1);
});

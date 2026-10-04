/**
 * Invite email (one click for the invitee): with MEMBER_INVITE_ACTIVATION_ENABLED
 * a NEW invite sends the Supabase Auth invite (Invite template → /auth/confirm
 * → set password → /app, where the invite is bound). OFF / demo: nothing sent.
 * An address that already has an Auth account gets no email (it signs in and
 * the gate binds the invite). The outcome is audited, no tokens / links logged.
 */
import { afterEach, beforeEach, expect, mock, test } from "bun:test";

let invites: Array<{ email: string; opts: unknown }> = [];
let inviteError: { message: string; status?: number } | null = null;
let audits: Array<Record<string, unknown>> = [];

mock.module("../mode", () => ({ isDemoMode: () => false }));
mock.module("../data/audit", () => ({
  appendAuditEvent: async (e: Record<string, unknown>) => {
    audits.push(e);
  },
}));
mock.module("../supabase", () => ({
  createSupabaseAdminClient: () => ({
    auth: {
      admin: {
        inviteUserByEmail: async (email: string, opts?: unknown) => {
          invites.push({ email, opts });
          return inviteError ? { data: { user: null }, error: inviteError } : { data: { user: { id: "u_new" } }, error: null };
        },
      },
    },
  }),
}));

const FLAG = "MEMBER_INVITE_ACTIVATION_ENABLED";
const saved = process.env[FLAG];
beforeEach(() => {
  invites = [];
  audits = [];
  inviteError = null;
  process.env[FLAG] = "true";
});
afterEach(() => {
  if (saved === undefined) delete process.env[FLAG];
  else process.env[FLAG] = saved;
});

const input = { orgId: "o_1", memberId: "m_1", email: " Ｕehara@Fixture.Invalid ", actorEmail: "owner@fixture.invalid" };
const load = () => import("./invite-email");

test("flag ON: sends the Supabase invite to the normalized address and audits 'sent'", async () => {
  const { sendMemberInviteEmail } = await load();
  expect(await sendMemberInviteEmail(input)).toBe("sent");
  expect(invites.map((i) => i.email)).toEqual(["uehara@fixture.invalid"]);
  expect(audits.length).toBe(1);
  expect(audits[0].action).toBe("member.invite_email");
  expect(audits[0].orgId).toBe("o_1");
  expect((audits[0].metadata as Record<string, unknown>).outcome).toBe("sent");
  expect((audits[0].metadata as Record<string, unknown>).memberId).toBe("m_1");
  expect(JSON.stringify(audits[0])).not.toMatch(/token|https?:\/\//i);
});

test("existing Auth account → existing_account (no throw); other errors → failed", async () => {
  const { sendMemberInviteEmail } = await load();
  inviteError = { message: "A user with this email address has already been registered", status: 422 };
  expect(await sendMemberInviteEmail(input)).toBe("existing_account");
  inviteError = { message: "Email rate limit exceeded", status: 429 };
  expect(await sendMemberInviteEmail(input)).toBe("failed");
  expect(audits.map((a) => (a.metadata as Record<string, unknown>).outcome)).toEqual(["existing_account", "failed"]);
});

test("flag OFF (default): nothing sent, nothing audited", async () => {
  delete process.env[FLAG];
  const { sendMemberInviteEmail } = await load();
  expect(await sendMemberInviteEmail(input)).toBe("disabled");
  expect(invites).toEqual([]);
  expect(audits).toEqual([]);
});

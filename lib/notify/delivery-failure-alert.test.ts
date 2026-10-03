import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

type Ch = { id: string; orgId: string; provider: "slack" | "telegram" | "line"; botToken?: string };
let channelsByOrg: Record<string, Ch[]> = {};
let members: Array<{ orgId: string; email: string; role: string; status: string }> = [];
const sentTexts: Array<{ channelId: string; text: string }> = [];

mock.module("@/lib/data/notification-channels", () => ({
  getEnabledNotificationChannels: async (orgId: string) => channelsByOrg[orgId] ?? [],
}));
mock.module("@/lib/data/members", () => ({
  listMembers: async () => members,
}));
mock.module("@/lib/data/audit", () => ({ appendAuditEvent: async () => {} }));
mock.module("@/lib/notify/slack", () => ({
  sendSlackTextToChannel: async (c: Ch, text: string) => {
    sentTexts.push({ channelId: c.id, text });
    return { ok: true };
  },
}));
mock.module("@/lib/notify/telegram", () => ({
  sendTelegramTextToChannel: async (c: Ch, text: string) => {
    sentTexts.push({ channelId: c.id, text });
    return { ok: true };
  },
}));
mock.module("@/lib/notify/line", () => ({
  sendLineText: async (c: Ch, text: string) => {
    sentTexts.push({ channelId: c.id, text });
    return { ok: true };
  },
}));

const mod = await import("./delivery-failure-alert");
const { alertApprovalDeliveryFailure, resetApprovalAlertThrottleForTests, setApprovalAlertDepsForTests, APPROVAL_ALERT_WINDOW_MS } = mod;

const audits: Array<Record<string, unknown>> = [];
const mails: Array<{ to: string | string[]; text?: string; subject: string }> = [];

beforeEach(() => {
  process.env.APPROVAL_DELIVERY_FAILURE_ALERT = "true";
  process.env.PLATFORM_OPS_ORG_ID = "org_ops";
  delete process.env.APPROVAL_ALERT_OPS_EMAILS;
  resetApprovalAlertThrottleForTests();
  audits.length = 0;
  mails.length = 0;
  sentTexts.length = 0;
  channelsByOrg = {
    org_a: [
      { id: "ch_fail", orgId: "org_a", provider: "slack", botToken: "xoxb-SECRET-A" },
      { id: "ch_tg", orgId: "org_a", provider: "telegram", botToken: "tg-SECRET" },
      // defensive: a mis-scoped row from another org must never be used
      { id: "ch_other", orgId: "org_b", provider: "slack", botToken: "xoxb-SECRET-B" },
    ],
  };
  members = [
    { orgId: "org_a", email: "owner@a.example", role: "owner", status: "active" },
    { orgId: "org_a", email: "admin@a.example", role: "admin", status: "active" },
    { orgId: "org_a", email: "member@a.example", role: "member", status: "active" },
    { orgId: "org_a", email: "invited@a.example", role: "admin", status: "invited" },
    { orgId: "org_b", email: "owner@b.example", role: "owner", status: "active" },
  ];
  setApprovalAlertDepsForTests({
    writer: async (e) => {
      audits.push(e as unknown as Record<string, unknown>);
    },
    mailer: async (m) => {
      mails.push({ to: m.to, text: m.text, subject: m.subject });
      return { ok: true, id: "m1" };
    },
  });
});

afterEach(() => {
  delete process.env.APPROVAL_DELIVERY_FAILURE_ALERT;
  delete process.env.PLATFORM_OPS_ORG_ID;
  delete process.env.APPROVAL_ALERT_OPS_EMAILS;
});

describe("APPROVAL_DELIVERY_FAILURE_ALERT", () => {
  test("flag OFF (default): no audit, no message, no mail", async () => {
    delete process.env.APPROVAL_DELIVERY_FAILURE_ALERT;
    const r = await alertApprovalDeliveryFailure({ orgId: "org_a", kind: "delivery_failed", approvalId: "apr_1", channelId: "ch_fail", reason: "channel_not_found" });
    expect(r.status).toBe("flag_off");
    expect(audits).toHaveLength(0);
    expect(sentTexts).toHaveLength(0);
    expect(mails).toHaveLength(0);
  });

  test("delivery failure: tenant audit (admin class), other inbox only, same-org admins, ops mirror", async () => {
    const r = await alertApprovalDeliveryFailure({ orgId: "org_a", kind: "delivery_failed", approvalId: "apr_1", provider: "slack", channelId: "ch_fail", reason: "channel_not_found" });
    expect(r.status).toBe("sent");
    const tenant = audits.find((a) => a.orgId === "org_a")!;
    expect(tenant.action).toBe("admin.notificationChannel");
    expect((tenant.metadata as Record<string, unknown>).auditClass).toBe("admin");
    expect((tenant.metadata as Record<string, unknown>).event).toBe("approval_delivery.failed");
    expect((tenant.metadata as Record<string, unknown>).approvalGranted).toBe(false);
    // failing inbox and cross-org inbox are never used
    expect(sentTexts.map((s) => s.channelId)).toEqual(["ch_tg"]);
    expect(r.fallbackChannels).toBe(1);
    // only active owner/admin of org_a
    expect(mails[0].to).toEqual(["owner@a.example", "admin@a.example"]);
    const ops = audits.find((a) => a.orgId === "org_ops")!;
    expect((ops.metadata as Record<string, unknown>).targetOrgId).toBe("org_a");
    expect((ops.metadata as Record<string, unknown>).event).toBe("approval_delivery.failed.ops_mirror");
    expect(r.opsMirrored).toBe(true);
  });

  test("no tokens or secrets in any audit / message / mail", async () => {
    process.env.APPROVAL_ALERT_OPS_EMAILS = "ops@staffpass.example";
    await alertApprovalDeliveryFailure({ orgId: "org_a", kind: "button_failed", approvalId: "apr_1", channelId: "ch_fail", reason: "delivery_mismatch" });
    const blob = JSON.stringify({ audits, sentTexts, mails });
    expect(blob).not.toContain("SECRET");
    expect(blob).not.toContain("xoxb");
    expect(blob).toContain("approval_button.failed");
    expect(mails.some((m) => JSON.stringify(m.to).includes("ops@staffpass.example"))).toBe(true);
  });

  test("throttle: one alert per org×kind×inbox per window; suppressed count carried", async () => {
    const t0 = 1_000_000;
    const a = await alertApprovalDeliveryFailure({ orgId: "org_a", kind: "delivery_failed", channelId: "ch_fail", reason: "x", now: t0 });
    const b = await alertApprovalDeliveryFailure({ orgId: "org_a", kind: "delivery_failed", channelId: "ch_fail", reason: "x", now: t0 + 1000 });
    // different org is not throttled by org_a
    const c = await alertApprovalDeliveryFailure({ orgId: "org_b", kind: "delivery_failed", channelId: "ch_fail", reason: "x", now: t0 + 1000 });
    const d = await alertApprovalDeliveryFailure({ orgId: "org_a", kind: "delivery_failed", channelId: "ch_fail", reason: "x", now: t0 + APPROVAL_ALERT_WINDOW_MS + 1 });
    expect([a.status, b.status, c.status, d.status]).toEqual(["sent", "suppressed", "sent", "sent"]);
    const last = audits.filter((x) => x.orgId === "org_a").pop()!;
    expect((last.metadata as Record<string, unknown>).suppressedSinceLast).toBe(1);
  });

  test("org B alert never reaches org A inboxes or admins", async () => {
    channelsByOrg.org_b = [{ id: "ch_b", orgId: "org_b", provider: "slack" }];
    await alertApprovalDeliveryFailure({ orgId: "org_b", kind: "delivery_failed", channelId: "ch_bfail", reason: "x" });
    expect(sentTexts.map((s) => s.channelId)).toEqual(["ch_b"]);
    expect(mails[0].to).toEqual(["owner@b.example"]);
    expect(audits.filter((a) => a.orgId === "org_a")).toHaveLength(0);
  });

  test("ops org itself: no self-mirror; untrusted reason is reduced to a code", async () => {
    process.env.PLATFORM_OPS_ORG_ID = "org_a";
    const r = await alertApprovalDeliveryFailure({ orgId: "org_a", kind: "delivery_failed", reason: "<script>alert(1)</script>" });
    expect(r.opsMirrored).toBe(false);
    expect(audits).toHaveLength(1);
    const reason = String((audits[0].metadata as Record<string, unknown>).reason);
    expect(reason).not.toMatch(/[<>()]/);
    expect(reason.length).toBeLessThanOrEqual(64);
  });

  test("never throws; audit failure → status error", async () => {
    setApprovalAlertDepsForTests({ writer: async () => { throw new Error("db down"); } });
    const r = await alertApprovalDeliveryFailure({ orgId: "org_a", kind: "delivery_failed", reason: "x" });
    expect(r.status).toBe("error");
  });

  test("invalid org id → no-op", async () => {
    const r = await alertApprovalDeliveryFailure({ orgId: "", kind: "delivery_failed", reason: "x" });
    expect(r.status).toBe("invalid");
    expect(audits).toHaveLength(0);
  });
});

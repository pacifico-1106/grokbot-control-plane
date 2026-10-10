/** #318 follow-up: the DCR global-cap alert uses the existing ops channels (PLATFORM_OPS_ORG_ID audit mirror + APPROVAL_ALERT_OPS_EMAILS). */
import { afterEach, beforeEach, expect, mock, test } from "bun:test";

const mails: Array<Record<string, unknown>> = [];
const audits: Array<Record<string, unknown>> = [];
const realResend = await import("@/lib/resend");
mock.module("@/lib/resend", () => ({ ...realResend, sendTransactionalEmail: async (m: Record<string, unknown>) => (mails.push(m), { ok: true }) }));
const realAudit = await import("@/lib/data/audit");
mock.module("@/lib/data/audit", () => ({ ...realAudit, appendAuditEvent: async (e: Record<string, unknown>) => void audits.push(e) }));
const { notifyOpsDcrGlobalCapReached } = await import("@/lib/mcp-oauth/notify");

const ENV = ["PLATFORM_OPS_ORG_ID", "APPROVAL_ALERT_OPS_EMAILS"];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV) (saved[k] = process.env[k]), delete process.env[k];
  mails.length = 0;
  audits.length = 0;
});
afterEach(() => {
  for (const k of ENV) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
});

test("mirrors to the ops org audit log and mails the ops list, counts only", async () => {
  process.env.PLATFORM_OPS_ORG_ID = "org_ops";
  process.env.APPROVAL_ALERT_OPS_EMAILS = "ops@example.com, bad, ops2@example.com";
  const r = await notifyOpsDcrGlobalCapReached({ count: 500, cap: 500 });
  expect(r).toBe("sent_ops");
  expect(audits).toHaveLength(1);
  expect(audits[0]).toMatchObject({ orgId: "org_ops", action: "oauth.dcr_global_cap_reached" });
  expect(mails).toHaveLength(1);
  expect(mails[0].to).toEqual(["ops@example.com", "ops2@example.com"]);
  expect(String(mails[0].text)).toContain("500");
});

test("no ops channel configured → undelivered (never throws)", async () => {
  expect(await notifyOpsDcrGlobalCapReached({ count: 500, cap: 500 })).toBe("undelivered");
  expect(mails).toHaveLength(0);
});

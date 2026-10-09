/**
 * 木村 #5: a browser session cookie's org must never override the 社員証
 * (badge) org inside runGatewayInvoke.
 * - cookie org present and different from the badge org → refused
 *   (403 session_org_mismatch), one IDs-only audit row in the BADGE org;
 * - cookie == badge, badge only (no cookie) → unchanged;
 * - billing / plan gate / audit / approval row always use the badge org.
 * "Cookie only" (no badge) never reaches runGatewayInvoke: the HTTP route
 * refuses it with 401 credential_required (app/api/gateway/invoke/route.test.ts).
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import * as realSession from "@/lib/auth/session";
import { DEMO_ORG } from "@/lib/demo-data";

let sessionOrg: string | null = null;
mock.module("@/lib/auth/session", () => ({
  ...realSession,
  getCurrentOrgId: async () => sessionOrg,
}));

const { runGatewayInvoke } = await import("@/lib/gateway/invoke");
const { getApprovalById, listAuditEvents } = await import("@/lib/data");

const OTHER = "org_cookie_other_tenant";

afterEach(() => {
  sessionOrg = null;
});

function reply(jobId: string, channel = "C0UNREGSESSION", extra: Record<string, unknown> = {}) {
  return runGatewayInvoke({
    employeeId: "emp_comm",
    credentialId: "cred_comm",
    body: {
      tool: "comm.reply",
      purpose: "comm.internal",
      jobId,
      conversation: { surface: "slack", slackChannelId: channel },
      args: { slackChannelId: channel, text: "本文" },
      ...extra,
    },
  });
}

describe("session cookie org vs badge org", () => {
  test("cookie org ≠ badge org → 403 session_org_mismatch, one IDs-only audit row in the badge org", async () => {
    sessionOrg = OTHER;
    const jobId = `job_sess_mm_${Date.now()}`;
    const r = await reply(jobId);
    expect(r.httpStatus).toBe(403);
    expect(r.body.code).toBe("session_org_mismatch");
    expect(JSON.stringify(r.body)).not.toContain(OTHER);
    const rows = (await listAuditEvents(DEMO_ORG.id, 1000)).filter(
      (e) => e.action === "gateway.session_org_mismatch" && (e.metadata as Record<string, unknown>)?.jobId === jobId
    );
    expect(rows.length).toBe(1);
    expect(JSON.stringify(rows[0])).not.toContain(OTHER);
    expect((await listAuditEvents(OTHER, 1000)).filter((e) => JSON.stringify(e).includes(jobId)).length).toBe(0);
  });

  test("cookie org == badge org → unchanged", async () => {
    sessionOrg = DEMO_ORG.id;
    const r = await reply(`job_sess_eq_${Date.now()}`);
    expect(r.httpStatus).toBe(403);
    expect(r.body.code).toBe("egress_denied");
  });

  test("badge only (no cookie) → unchanged", async () => {
    sessionOrg = null;
    const r = await reply(`job_sess_none_${Date.now()}`);
    expect(r.httpStatus).toBe(403);
    expect(r.body.code).toBe("egress_denied");
  });

  test("badge only: the approval row is created in the badge org", async () => {
    sessionOrg = null;
    const r = await reply(`job_sess_apr_${Date.now()}`, "C_INTERNAL", { informationClass: "confidential" });
    expect(r.httpStatus).toBe(402);
    const row = await getApprovalById(String(r.body.approvalId), DEMO_ORG.id);
    expect(row?.orgId).toBe(DEMO_ORG.id);
  });
});

/**
 * PR-2: slack/notify admin.* writers persist the six-field contract when ON.
 * Uses the shared helper the same way notify/channels does.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEMO_ORG, getRuntimeAudit } from "@/lib/demo-data";

const FLAG = "ADMIN_AUDIT_SIX_FIELD_WRITE_ENABLED";
const saved: { flag?: string } = {};

beforeEach(() => {
  saved.flag = process.env[FLAG];
  delete process.env[FLAG];
});

afterEach(() => {
  if (saved.flag === undefined) delete process.env[FLAG];
  else process.env[FLAG] = saved.flag;
});

describe("slack/notify six-field writes", () => {
  test("flag ON: owner-notice style write has target / reason / result and no secrets", async () => {
    process.env[FLAG] = "true";
    const { appendAdminAuditEvent, humanAdminActor } = await import("@/lib/audit/admin-audit");
    await appendAdminAuditEvent({
      orgId: DEMO_ORG.id,
      employeeId: null,
      credentialId: null,
      action: "admin.policy",
      purpose: "approver_authority.owner_notice",
      summary: "承認の事後通知（オーナー 1 人）",
      actor: humanAdminActor("owner@example.com"),
      target: { type: "approval", id: "apr_notice" },
      reason: { code: "approved", labelJa: "承認されて実行しました" },
      result: "success",
      metadata: { approvalId: "apr_notice", tool: "members.promoteOwner" },
    });
    const row = getRuntimeAudit().find((e) => e.purpose === "approver_authority.owner_notice");
    expect(row).toBeTruthy();
    expect(row!.metadata?.target).toEqual({ type: "approval", id: "apr_notice" });
    expect((row!.metadata?.reason as { code?: string }).code).toBe("approved");
    expect(row!.metadata?.result).toBe("success");
    expect(JSON.stringify(row!.metadata)).not.toMatch(/gb_adm_|xoxb-|Bearer /);
  });
});

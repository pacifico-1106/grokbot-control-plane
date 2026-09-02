import { describe, expect, test } from "bun:test";
import {
  SELF_APPROVAL_DENIED,
  assertNotSelfApproval,
  isSelfApproval,
  parseAdminRequester,
} from "@/lib/admin-mcp/self-approval";
import { createApproval, resolveApproval } from "@/lib/data";
import { DEMO_ORG } from "@/lib/demo-data";
import { ADMIN_AUDIT_CLASS } from "@/lib/admin-mcp/audit-class";

describe("admin self-approval denied", () => {
  test("same grokBotAgentId is rejected", () => {
    const requester = {
      kind: "admin_agent" as const,
      grokBotAgentId: "grok_admin_1",
      actorId: "adm_1",
    };
    expect(isSelfApproval(requester, { grokBotAgentId: "grok_admin_1" })).toBe(true);
    expect(isSelfApproval(requester, { grokBotAgentId: "grok_other" })).toBe(false);
    expect(isSelfApproval(requester, { actor: "owner@example.com" })).toBe(false);
  });

  test("same actorId is rejected; human email is allowed", () => {
    const requester = {
      kind: "admin_agent" as const,
      grokBotAgentId: "grok_admin_1",
      actorId: "adm_1",
    };
    expect(isSelfApproval(requester, { actorId: "adm_1" })).toBe(true);
    expect(isSelfApproval(requester, { actor: "owner@example.com", actorId: "mem_1" })).toBe(false);
  });

  test("resolveApproval throws when admin agent approves itself", async () => {
    const created = await createApproval({
      orgId: DEMO_ORG.id,
      employeeId: "",
      credentialId: "adm_demo",
      title: "権限の更新",
      purpose: "admin.policy",
      summary: "self-approve fixture",
      risk: "high",
      tool: "policy.patch",
      jobId: `job_self_${Date.now()}`,
      metadata: {
        auditClass: ADMIN_AUDIT_CLASS,
        always_human: true,
        adminTool: "policy.patch",
        adminRequester: {
          kind: "admin_agent",
          grokBotAgentId: "grok_admin_demo",
          actorId: "adm_demo",
        },
      },
    });
    expect(parseAdminRequester(created.approval.metadata)?.grokBotAgentId).toBe("grok_admin_demo");
    expect(() =>
      assertNotSelfApproval(created.approval.metadata, {
        grokBotAgentId: "grok_admin_demo",
        actorId: "adm_demo",
      })
    ).toThrow(SELF_APPROVAL_DENIED);

    let denied = false;
    try {
      await resolveApproval(created.approval.id, "approved", "adm_demo", DEMO_ORG.id, {
        grokBotAgentId: "grok_admin_demo",
        actorId: "adm_demo",
      });
    } catch (error) {
      denied = error instanceof Error && error.message === SELF_APPROVAL_DENIED;
    }
    expect(denied).toBe(true);

    const human = await resolveApproval(
      created.approval.id,
      "approved",
      "owner@example.com",
      DEMO_ORG.id,
      { actorId: "mem_1" }
    );
    expect(human?.status).toBe("approved");
  });
});

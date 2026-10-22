/**
 * TENANT_SETTINGS_HEALTH_ENABLED (default OFF): whoami / health と
 * 管理MCP setup.tenantHealth に、自テナント設定の読取専用ヘルスを足す。
 * Fail-first: 実装前はこのファイルは flag ON の期待で落ちる。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEMO_ORG } from "@/lib/demo-data";
import type { ResolvedEmployeeCredential } from "@/lib/auth/employee-credential";
import type { ResolvedAdminCredential } from "@/lib/auth/admin-credential";
import { resetDemoAdminAgent } from "@/lib/data/admin-agents";
import { clearDemoRule, setOrgInternalAudienceRule } from "@/lib/data/internal-audience-rule";
import { resetDemoMailPolicy, setOrgMailPolicy } from "@/lib/data/mail-policy";
import { resetDemoReplyPolicy } from "@/lib/data/reply-policy";
import { resetDemoSchedulingPolicy } from "@/lib/data/scheduling-policy";
import { defaultMailPolicy, normalizeMailPolicy } from "@/lib/mail-policy/validate";
import {
  isTenantSettingsHealthEnabled,
  isTenantSettingsHealthEnabledForOrg,
  tenantSettingsHealthOrgIds,
} from "@/lib/feature-flags";
import { callStaffpassMcpTool, listStaffpassMcpTools, STAFFPASS_MCP_TOOLS } from "@/lib/mcp/tools";
import { callAdminMcpTool, listAdminMcpToolsForOrg } from "@/lib/mcp/admin-tools";
import {
  attachTenantSettingsHealth,
  buildTenantSettingsHealth,
  type TenantHealthStores,
  type TenantSettingsHealth,
} from "@/lib/setup/tenant-health";

const FLAG = "TENANT_SETTINGS_HEALTH_ENABLED";
const ORG_IDS = "TENANT_SETTINGS_HEALTH_ORG_IDS";
const OTHER_ORG = "org_other_tenant_health";
const OTHER_DOMAIN = "other-tenant-secret.example";
const FULL_EMAIL = "owner@example.com";
const LEAK_NEEDLES = [
  FULL_EMAIL,
  "gb_emp_",
  "gb_adm_demo",
  "xoxb-",
  "secret_hash",
  "secretPrefix",
  "credentialFingerprint",
  OTHER_ORG,
  OTHER_DOMAIN,
];

const SETTING_IDS = [
  "internal_domains",
  "mail_policy",
  "reply_policy",
  "scheduling_policy",
  "voter_bindings",
  "notification_channels",
  "gateway",
  "admin_agent",
] as const;

function demoEmpCred(
  extra: Partial<ResolvedEmployeeCredential> = {}
): ResolvedEmployeeCredential {
  return {
    employeeId: "emp_comm",
    orgId: DEMO_ORG.id,
    credentialId: "cred_emp_comm",
    generation: 1,
    fingerprint: "fixture-hash",
    secretPrefix: "gb_emp_fixture",
    binding: {
      status: "linked",
      employeeId: "emp_comm",
      orgId: DEMO_ORG.id,
      credentialGeneration: 1,
      grokBotAgentId: "agent_test",
      grokBotWorkspaceId: null,
      credentialFingerprint: null,
      lastSuccessAt: null,
      lastError: null,
      wakeWebhookUrl: null,
      hasWakeWebhook: false,
      createdAt: "2026-10-16T00:00:00.000Z",
      updatedAt: "2026-10-16T00:00:00.000Z",
    },
    ...extra,
  };
}

function demoAdmCred(): ResolvedAdminCredential {
  const agent = resetDemoAdminAgent({
    grokBotAgentId: "grok_admin_demo",
    status: "linked",
  });
  return {
    orgId: DEMO_ORG.id,
    adminAgentId: agent.id,
    grokBotAgentId: agent.grokBotAgentId,
    actorId: agent.id,
    generation: agent.credentialGeneration,
    via: "bearer",
    agent,
  };
}

function parseTool(result: { content: Array<{ text: string }>; structuredContent?: unknown }) {
  expect(result.content[0]?.text).toBe(JSON.stringify(result.structuredContent, null, 2));
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

function asHealth(value: unknown): TenantSettingsHealth {
  expect(value && typeof value === "object").toBe(true);
  return value as TenantSettingsHealth;
}

function setting(health: TenantSettingsHealth, id: string) {
  const row = health.settings.find((item) => item.id === id);
  expect(row).toBeTruthy();
  return row!;
}

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved[FLAG] = process.env[FLAG];
  saved[ORG_IDS] = process.env[ORG_IDS];
  delete process.env[FLAG];
  delete process.env[ORG_IDS];
  clearDemoRule();
  resetDemoMailPolicy();
  resetDemoReplyPolicy();
  resetDemoSchedulingPolicy();
});

afterEach(() => {
  saved[FLAG] === undefined ? delete process.env[FLAG] : (process.env[FLAG] = saved[FLAG]);
  saved[ORG_IDS] === undefined ? delete process.env[ORG_IDS] : (process.env[ORG_IDS] = saved[ORG_IDS]);
  clearDemoRule();
  resetDemoMailPolicy();
  resetDemoReplyPolicy();
  resetDemoSchedulingPolicy();
});

describe("flag helpers default OFF", () => {
  test("unset / false / empty org list fail closed", () => {
    expect(isTenantSettingsHealthEnabled()).toBe(false);
    expect(isTenantSettingsHealthEnabledForOrg(DEMO_ORG.id)).toBe(false);
    expect(isTenantSettingsHealthEnabledForOrg(null)).toBe(false);
    expect(isTenantSettingsHealthEnabledForOrg("")).toBe(false);
    expect(tenantSettingsHealthOrgIds()).toEqual([]);
    process.env[FLAG] = "false";
    expect(isTenantSettingsHealthEnabled()).toBe(false);
    process.env[FLAG] = "1";
    expect(isTenantSettingsHealthEnabled()).toBe(true);
    expect(isTenantSettingsHealthEnabledForOrg(null)).toBe(false);
    process.env[ORG_IDS] = OTHER_ORG;
    expect(isTenantSettingsHealthEnabledForOrg(DEMO_ORG.id)).toBe(false);
    expect(isTenantSettingsHealthEnabledForOrg(OTHER_ORG)).toBe(true);
  });
});

describe("flag OFF: responses unchanged (regression)", () => {
  test("staffpass_whoami has no tenantSettingsHealth key", async () => {
    const unset = await callStaffpassMcpTool("staffpass_whoami", {}, demoEmpCred());
    const parsed = parseTool(unset);
    expect(Object.prototype.hasOwnProperty.call(parsed, "tenantSettingsHealth")).toBe(false);
    expect(unset.content[0].text).not.toContain("tenantSettingsHealth");
    expect(unset.content[0].text).not.toContain("mailMode");
    process.env[FLAG] = "false";
    const off = await callStaffpassMcpTool("staffpass_whoami", {}, demoEmpCred());
    expect(off.content[0].text).toBe(unset.content[0].text);
    process.env[FLAG] = "0";
    const zero = await callStaffpassMcpTool("staffpass_whoami", {}, demoEmpCred());
    expect(zero.content[0].text).toBe(unset.content[0].text);
  });

  test("staffpass_health has no tenantSettingsHealth key", async () => {
    const unset = await callStaffpassMcpTool("staffpass_health", {}, demoEmpCred());
    const parsed = parseTool(unset);
    expect(Object.prototype.hasOwnProperty.call(parsed, "tenantSettingsHealth")).toBe(false);
    expect(unset.content[0].text).not.toContain("tenantSettingsHealth");
  });

  test("employee tools/list identity is unchanged", () => {
    expect(listStaffpassMcpTools()).toBe(STAFFPASS_MCP_TOOLS);
    expect(listStaffpassMcpTools().some((t) => t.name === "setup.tenantHealth")).toBe(false);
  });

  test("admin tools/list does not advertise setup.tenantHealth", () => {
    const names = listAdminMcpToolsForOrg(DEMO_ORG.id).map((t) => t.name);
    expect(names).not.toContain("setup.tenantHealth");
    expect(listAdminMcpToolsForOrg(null).map((t) => t.name)).not.toContain("setup.tenantHealth");
  });

  test("admin call is refused without mutating settings", async () => {
    const before = await buildTenantSettingsHealth(DEMO_ORG.id).catch(() => null);
    const result = await callAdminMcpTool("setup.tenantHealth", {}, demoAdmCred());
    const parsed = parseTool(result);
    expect(result.isError).toBe(true);
    expect(parsed.code).toBe("feature_disabled");
    expect(parsed.ok).toBe(false);
    const afterIar = await import("@/lib/data/internal-audience-rule").then((m) =>
      m.getOrgInternalAudienceRule(DEMO_ORG.id)
    );
    expect(afterIar.emailDomains).toEqual([]);
    if (before && before.ok) {
      const after = await buildTenantSettingsHealth(DEMO_ORG.id);
      expect(after).toEqual(before);
    }
  });
});

describe("buildTenantSettingsHealth (org-scoped, read-only)", () => {
  test("Mode A: empty IAR + default mail → missing/degraded internal_domains and draft_only", async () => {
    const health = await buildTenantSettingsHealth(DEMO_ORG.id);
    expect(health.ok).toBe(true);
    expect(health.readOnly).toBe(true);
    expect(health.orgId).toBe(DEMO_ORG.id);
    expect(health.mailMode).toBe("A");
    expect(health.settings.map((s) => s.id)).toEqual([...SETTING_IDS]);
    const domains = setting(health, "internal_domains");
    expect(["missing", "degraded"]).toContain(domains.status);
    expect(domains.effect).toBe("draft_only");
    const mail = setting(health, "mail_policy");
    expect(["missing", "degraded"]).toContain(mail.status);
    expect(mail.effect).toBe("draft_only");
    expect(["blocks", "draft_only", "silent_default"]).toContain(setting(health, "reply_policy").effect);
    expect(setting(health, "reply_policy").status).toBe("missing");
    expect(setting(health, "reply_policy").effect).toBe("silent_default");
    expect(setting(health, "scheduling_policy").status).toBe("missing");
    expect(setting(health, "scheduling_policy").effect).toBe("silent_default");
    expect(setting(health, "voter_bindings").effect).toBe("blocks");
    expect(setting(health, "notification_channels").effect).toBe("blocks");
    expect(setting(health, "gateway").status).toBe("ok");
    expect(setting(health, "admin_agent").status).toBe("ok");
    const dumped = JSON.stringify(health);
    for (const needle of LEAK_NEEDLES) expect(dumped).not.toContain(needle);
    expect(dumped).not.toMatch(/[^\s@]+@[^\s@]+\.[^\s@]+/);
  });

  test("Mode B: IAR domains set, no internal mail rule → mail_policy degraded draft_only", async () => {
    await setOrgInternalAudienceRule(DEMO_ORG.id, { emailDomains: ["acme.example"] }, "test");
    const health = await buildTenantSettingsHealth(DEMO_ORG.id);
    expect(health.mailMode).toBe("B");
    expect(setting(health, "internal_domains").status).toBe("ok");
    expect(setting(health, "internal_domains").domains).toEqual(["acme.example"]);
    const mail = setting(health, "mail_policy");
    expect(mail.status).toBe("degraded");
    expect(mail.effect).toBe("draft_only");
    expect(JSON.stringify(health)).not.toContain(FULL_EMAIL);
    expect(JSON.stringify(health)).not.toContain(OTHER_DOMAIN);
  });

  test("internal rule present → mailMode ok", async () => {
    await setOrgInternalAudienceRule(DEMO_ORG.id, { emailDomains: ["acme.example"] }, "test");
    await setOrgMailPolicy(
      DEMO_ORG.id,
      normalizeMailPolicy({
        ...defaultMailPolicy(),
        policyId: "mpp_internal",
        policyName: "Internal",
        rules: [
          {
            id: "mpr_internal",
            audience: "internal",
            sendMode: "needs_approval",
            attachmentPolicyRef: "inherit_d1",
          },
          ...defaultMailPolicy().rules,
        ],
      })
    );
    const health = await buildTenantSettingsHealth(DEMO_ORG.id);
    expect(health.mailMode).toBe("ok");
    expect(setting(health, "internal_domains").status).toBe("ok");
    expect(setting(health, "mail_policy").status).toBe("ok");
  });

  test("strict tenant isolation: other org is never queried or leaked", async () => {
    const seen: string[] = [];
    const stores: TenantHealthStores = {
      getInternalAudienceRule: async (orgId) => {
        seen.push(`iar:${orgId}`);
        if (orgId !== DEMO_ORG.id) throw new Error("cross_tenant_read");
        return {
          version: 1,
          emailDomains: ["acme.example"],
          slackTeamIds: [],
          autoSlackTeamInternal: false,
          updatedAt: "2026-10-16T00:00:00.000Z",
          updatedBy: "test",
        };
      },
      getEffectiveMailPolicy: async (orgId) => {
        seen.push(`mail:${orgId}`);
        if (orgId !== DEMO_ORG.id) throw new Error("cross_tenant_read");
        return { policy: defaultMailPolicy(), source: "default", employeeOverride: null, orgPolicy: null };
      },
      getEffectiveReplyPolicy: async (orgId) => {
        seen.push(`reply:${orgId}`);
        if (orgId !== DEMO_ORG.id) throw new Error("cross_tenant_read");
        return {
          policy: { version: 1, afterHoursMode: "draft_only" } as never,
          source: "default",
          employeeOverride: null,
          orgPolicy: null,
        };
      },
      getEffectiveSchedulingPolicy: async (orgId) => {
        seen.push(`sched:${orgId}`);
        if (orgId !== DEMO_ORG.id) throw new Error("cross_tenant_read");
        return {
          policy: { version: 1, confirmAutomation: "always_human" } as never,
          source: "default",
          employeeOverride: null,
          orgPolicy: null,
        };
      },
      listEmailDomainParties: async (orgId) => {
        seen.push(`parties:${orgId}`);
        if (orgId !== DEMO_ORG.id) throw new Error("cross_tenant_read");
        return [{ domain: "acme.example", audience: "internal" }];
      },
      listNotificationChannels: async (orgId) => {
        seen.push(`notify:${orgId}`);
        if (orgId !== DEMO_ORG.id) throw new Error("cross_tenant_read");
        return [];
      },
      listVoterBindings: async (orgId) => {
        seen.push(`voters:${orgId}`);
        if (orgId !== DEMO_ORG.id) throw new Error("cross_tenant_read");
        return { activeCount: 0, pendingCount: 0 };
      },
      getGatewayStatus: async (orgId) => {
        seen.push(`gw:${orgId}`);
        if (orgId !== DEMO_ORG.id) throw new Error("cross_tenant_read");
        return "linked";
      },
      getAdminAgentStatus: async (orgId) => {
        seen.push(`adm:${orgId}`);
        if (orgId !== DEMO_ORG.id) throw new Error("cross_tenant_read");
        return "linked";
      },
    };
    const health = await buildTenantSettingsHealth(DEMO_ORG.id, stores);
    expect(health.orgId).toBe(DEMO_ORG.id);
    expect(seen.every((item) => item.endsWith(`:${DEMO_ORG.id}`))).toBe(true);
    expect(seen.some((item) => item.includes(OTHER_ORG))).toBe(false);
    expect(JSON.stringify(health)).not.toContain(OTHER_ORG);
  });

  test("store failure is fail-closed (not treated as empty default / Mode A)", async () => {
    const health = await buildTenantSettingsHealth(DEMO_ORG.id, {
      getInternalAudienceRule: async () => {
        throw new Error("iar_unavailable");
      },
      getEffectiveMailPolicy: async () => {
        throw new Error("mail_unavailable");
      },
      getEffectiveReplyPolicy: async () => {
        throw new Error("reply_unavailable");
      },
      getEffectiveSchedulingPolicy: async () => {
        throw new Error("sched_unavailable");
      },
      listEmailDomainParties: async () => {
        throw new Error("parties_unavailable");
      },
      listNotificationChannels: async () => {
        throw new Error("notify_unavailable");
      },
      listVoterBindings: async () => {
        throw new Error("voters_unavailable");
      },
      getGatewayStatus: async () => {
        throw new Error("gw_unavailable");
      },
      getAdminAgentStatus: async () => {
        throw new Error("adm_unavailable");
      },
    });
    expect(health.ok).toBe(true);
    expect(health.mailMode).toBe("unavailable");
    for (const id of SETTING_IDS) {
      const row = setting(health, id);
      expect(row.status).toBe("degraded");
      expect(row.effect).toBe("blocks");
    }
  });

  test("does not mutate IAR or mail policy", async () => {
    await setOrgInternalAudienceRule(DEMO_ORG.id, { emailDomains: ["acme.example"] }, "test");
    await buildTenantSettingsHealth(DEMO_ORG.id);
    const { getOrgInternalAudienceRule } = await import("@/lib/data/internal-audience-rule");
    const { getOrgMailPolicy } = await import("@/lib/data/mail-policy");
    expect((await getOrgInternalAudienceRule(DEMO_ORG.id)).emailDomains).toEqual(["acme.example"]);
    expect((await getOrgMailPolicy(DEMO_ORG.id)).policyId).toBe(defaultMailPolicy().policyId);
  });
});

describe("attachTenantSettingsHealth", () => {
  test("flag OFF returns the same object", async () => {
    const payload = { ok: true, orgId: DEMO_ORG.id };
    const out = await attachTenantSettingsHealth(DEMO_ORG.id, payload);
    expect(out).toBe(payload);
    expect(Object.prototype.hasOwnProperty.call(out, "tenantSettingsHealth")).toBe(false);
  });

  test("missing orgId fail-closed (no report)", async () => {
    process.env[FLAG] = "1";
    const payload = { ok: true };
    const out = await attachTenantSettingsHealth("", payload);
    expect(out).toBe(payload);
    const none = await attachTenantSettingsHealth(null, { ok: true });
    expect(Object.prototype.hasOwnProperty.call(none, "tenantSettingsHealth")).toBe(false);
  });
});

describe("flag ON: employee whoami / health", () => {
  test("whoami and health attach the same org-scoped report", async () => {
    process.env[FLAG] = "1";
    const whoami = parseTool(await callStaffpassMcpTool("staffpass_whoami", {}, demoEmpCred()));
    const health = parseTool(await callStaffpassMcpTool("staffpass_health", {}, demoEmpCred()));
    expect(whoami.orgId).toBe(DEMO_ORG.id);
    expect(health.orgId).toBe(DEMO_ORG.id);
    const whoamiHealth = asHealth(whoami.tenantSettingsHealth);
    const healthHealth = asHealth(health.tenantSettingsHealth);
    expect(whoamiHealth.orgId).toBe(DEMO_ORG.id);
    expect(healthHealth.orgId).toBe(DEMO_ORG.id);
    expect(whoamiHealth.mailMode).toBe("A");
    expect(healthHealth).toEqual(whoamiHealth);
    expect(JSON.stringify(whoami)).not.toContain(FULL_EMAIL);
    expect(JSON.stringify(health)).not.toContain(FULL_EMAIL);
    for (const needle of LEAK_NEEDLES) {
      expect(JSON.stringify(whoami)).not.toContain(needle);
      expect(JSON.stringify(health)).not.toContain(needle);
    }
  });

  test("_ORG_IDS other tenant → caller payload unchanged", async () => {
    const off = (await callStaffpassMcpTool("staffpass_whoami", {}, demoEmpCred())).content[0].text;
    process.env[FLAG] = "1";
    process.env[ORG_IDS] = OTHER_ORG;
    const gated = (await callStaffpassMcpTool("staffpass_whoami", {}, demoEmpCred())).content[0].text;
    expect(gated).toBe(off);
    expect(gated).not.toContain("tenantSettingsHealth");
  });

  test("employee.orgId vs cred.orgId mismatch is fail-closed", async () => {
    process.env[FLAG] = "1";
    const parsed = parseTool(
      await callStaffpassMcpTool("staffpass_whoami", {}, demoEmpCred({ orgId: OTHER_ORG }))
    );
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("employee_not_found");
    expect(JSON.stringify(parsed)).not.toContain("tenantSettingsHealth");
    expect(JSON.stringify(parsed)).not.toContain(DEMO_ORG.name);
    expect(JSON.stringify(parsed)).not.toContain("acme.example");
  });
});

describe("flag ON: admin setup.tenantHealth", () => {
  test("tools/list includes the tool only for the allowed org", () => {
    process.env[FLAG] = "1";
    expect(listAdminMcpToolsForOrg(DEMO_ORG.id).some((t) => t.name === "setup.tenantHealth")).toBe(true);
    expect(listAdminMcpToolsForOrg(null).some((t) => t.name === "setup.tenantHealth")).toBe(false);
    process.env[ORG_IDS] = OTHER_ORG;
    expect(listAdminMcpToolsForOrg(DEMO_ORG.id).some((t) => t.name === "setup.tenantHealth")).toBe(false);
    expect(listAdminMcpToolsForOrg(OTHER_ORG).some((t) => t.name === "setup.tenantHealth")).toBe(true);
  });

  test("returns the same JSON as employee whoami and ignores args.orgId", async () => {
    process.env[FLAG] = "1";
    const whoami = asHealth(
      parseTool(await callStaffpassMcpTool("staffpass_whoami", {}, demoEmpCred())).tenantSettingsHealth
    );
    const admin = parseTool(
      await callAdminMcpTool("setup.tenantHealth", { orgId: OTHER_ORG }, demoAdmCred())
    );
    expect(admin.ok).toBe(true);
    expect(admin.readOnly).toBe(true);
    expect(admin.orgId).toBe(DEMO_ORG.id);
    expect(admin.mailMode).toBe(whoami.mailMode);
    expect(admin.settings).toEqual(whoami.settings);
    expect(JSON.stringify(admin)).not.toContain(OTHER_ORG);
    expect(JSON.stringify(admin)).not.toContain(FULL_EMAIL);
  });

  test("tool is read-only (no approvalClass, description says read-only)", () => {
    process.env[FLAG] = "1";
    const tool = listAdminMcpToolsForOrg(DEMO_ORG.id).find((t) => t.name === "setup.tenantHealth");
    expect(tool).toBeTruthy();
    expect(tool!.approvalClass).toBeUndefined();
    expect(tool!.description).toContain("read-only");
    expect(tool!.description).not.toContain("always_human");
  });
});

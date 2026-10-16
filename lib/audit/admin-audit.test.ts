import { describe, expect, test } from "bun:test";
import { DEMO_ORG } from "@/lib/demo-data";
import { getRuntimeAudit } from "@/lib/demo-data";
import {
  appendAdminAuditEvent,
  assertAdminAuditIdentity,
  humanAdminActor,
  adminAgentAuditActor,
} from "@/lib/audit/admin-audit";

describe("admin audit identity helper", () => {
  test("human actor requires actor_email and actorKind", () => {
    expect(() =>
      assertAdminAuditIdentity({
        action: "admin.link",
        metadata: { actorKind: "human" },
      })
    ).toThrow(/actor_email|actorEmail/);

    const ok = humanAdminActor("owner@example.com", "mem_owner");
    expect(ok).toEqual({
      actorKind: "human",
      actorEmail: "owner@example.com",
      actorMemberId: "mem_owner",
    });
    expect(() =>
      assertAdminAuditIdentity({
        action: "admin.link",
        actorEmail: ok.actorEmail,
        metadata: { actorKind: "human" },
      })
    ).not.toThrow();
  });

  test("admin_agent actor requires adminAgentId and generation", () => {
    expect(() =>
      assertAdminAuditIdentity({
        action: "admin.channel",
        metadata: { actorKind: "admin_agent" },
      })
    ).toThrow(/adminAgentId|generation/);

    expect(() =>
      assertAdminAuditIdentity({
        action: "admin.channel",
        metadata: { actorKind: "admin_agent", adminAgentId: "adm_1" },
      })
    ).toThrow(/generation/);

    const ok = adminAgentAuditActor("adm_1", 3);
    expect(ok).toEqual({
      actorKind: "admin_agent",
      adminAgentId: "adm_1",
      generation: 3,
    });
    expect(() =>
      assertAdminAuditIdentity({
        action: "admin.channel",
        metadata: { actorKind: "admin_agent", adminAgentId: "adm_1", generation: 3 },
      })
    ).not.toThrow();
  });

  test("actorKind is required on every admin.* write", () => {
    expect(() =>
      assertAdminAuditIdentity({
        action: "admin.policy",
        actorEmail: "owner@example.com",
        metadata: {},
      })
    ).toThrow(/actorKind/);
  });

  test("refuses secrets, full hashes, and full secret prefixes", () => {
    expect(() =>
      assertAdminAuditIdentity({
        action: "admin.link",
        actorEmail: "owner@example.com",
        metadata: {
          actorKind: "human",
          oneTimeSecret: "gb_adm_deadbeef_secret",
        },
      })
    ).toThrow(/secret/i);

    expect(() =>
      assertAdminAuditIdentity({
        action: "admin.link",
        actorEmail: "owner@example.com",
        metadata: {
          actorKind: "human",
          secretHash: "c".repeat(64),
        },
      })
    ).toThrow(/hash/i);

    expect(() =>
      assertAdminAuditIdentity({
        action: "admin.link",
        actorEmail: "owner@example.com",
        metadata: {
          actorKind: "human",
          secretPrefix: "gb_adm_rawsecr",
        },
      })
    ).toThrow(/prefix/i);

    expect(() =>
      assertAdminAuditIdentity({
        action: "admin.link",
        actorEmail: "owner@example.com",
        metadata: {
          actorKind: "human",
          secretHashPrefix: "c".repeat(12),
          prefix: "gb_adm_",
        },
      })
    ).not.toThrow();
  });

  test("refuses nested secrets, long hex, and sp_at_ except allowed prefix fields", () => {
    expect(() =>
      assertAdminAuditIdentity({
        action: "admin.link",
        actorEmail: "owner@example.com",
        metadata: {
          actorKind: "human",
          nested: { inner: { note: "gb_emp_deadbeefdeadbeef" } },
        },
      })
    ).toThrow(/secret/i);

    expect(() =>
      assertAdminAuditIdentity({
        action: "admin.revoke",
        actorEmail: "owner@example.com",
        metadata: {
          actorKind: "human",
          items: [{ token: "sp_at_" + "a".repeat(24) }],
        },
      })
    ).toThrow(/secret/i);

    expect(() =>
      assertAdminAuditIdentity({
        action: "admin.link",
        actorEmail: "owner@example.com",
        metadata: {
          actorKind: "human",
          note: "a".repeat(64),
        },
      })
    ).toThrow(/hash|hex|secret/i);

    expect(() =>
      assertAdminAuditIdentity({
        action: "admin.link",
        actorEmail: "owner@example.com",
        summary: `rotated ${"c".repeat(64)}`,
        metadata: { actorKind: "human" },
      })
    ).toThrow(/hash|hex|secret/i);

    expect(() =>
      assertAdminAuditIdentity({
        action: "admin.link",
        actorEmail: "owner@example.com",
        metadata: {
          actorKind: "human",
          secretHashPrefix: "c".repeat(12),
          prefix: "gb_adm_",
        },
      })
    ).not.toThrow();
  });

  test("appendAdminAuditEvent persists actorKind and identity", async () => {
    const before = getRuntimeAudit().length;
    await appendAdminAuditEvent({
      orgId: DEMO_ORG.id,
      employeeId: null,
      credentialId: null,
      action: "admin.link",
      purpose: "admin.link",
      summary: "helper write",
      actor: humanAdminActor("owner@example.com", "mem_1"),
      metadata: { secretHashPrefix: "c".repeat(12) },
    });
    const row = getRuntimeAudit()[0];
    expect(getRuntimeAudit().length).toBeGreaterThan(before);
    expect(row.action).toBe("admin.link");
    expect(row.metadata?.actorKind).toBe("human");
    expect(row.actorEmail ?? row.metadata?.actorEmail).toBe("owner@example.com");
    expect(JSON.stringify(row.metadata)).not.toContain("c".repeat(64));
  });

  test("resolveAdminAuditActor falls back to human when no admin agent exists", async () => {
    const { resolveAdminAuditActor } = await import("@/lib/audit/admin-audit");
    const actor = await resolveAdminAuditActor({
      orgId: "org_does_not_exist",
      fallbackHuman: { email: "system@example.com" },
    });
    expect(actor).toEqual({ actorKind: "human", actorEmail: "system@example.com" });
  });

  test("resolveAdminAuditActor refuses unidentified actors instead of writing system", async () => {
    const { resolveAdminAuditActor } = await import("@/lib/audit/admin-audit");
    await expect(resolveAdminAuditActor({ orgId: "org_does_not_exist" })).rejects.toThrow(
      /admin_audit_actor_missing/
    );
  });

  test("sanitizeAdminRevokeReason refuses secrets and long hex", async () => {
    const { sanitizeAdminRevokeReason } = await import("@/lib/audit/admin-audit");
    expect(sanitizeAdminRevokeReason("key leaked")).toEqual({ ok: true, reason: "key leaked" });
    expect(sanitizeAdminRevokeReason("gb_adm_deadbeefdeadbeef").ok).toBe(false);
    expect(sanitizeAdminRevokeReason("sp_at_" + "b".repeat(20)).ok).toBe(false);
    expect(sanitizeAdminRevokeReason("c".repeat(64)).ok).toBe(false);
  });

  test("ensureAdminRevokeAudit writes admin.revoke when that generation has none", async () => {
    const { ensureAdminRevokeAudit, humanAdminActor } = await import("@/lib/audit/admin-audit");
    const before = getRuntimeAudit().filter(
      (e) => e.action === "admin.revoke" && e.metadata?.generation === 9
    ).length;
    await ensureAdminRevokeAudit({
      orgId: DEMO_ORG.id,
      credentialId: "adm_1",
      generation: 9,
      actor: humanAdminActor("owner@example.com", "mem_owner"),
      reason: "backfill",
    });
    const rows = getRuntimeAudit().filter(
      (e) => e.action === "admin.revoke" && e.metadata?.generation === 9
    );
    expect(rows.length).toBe(before + 1);
    await ensureAdminRevokeAudit({
      orgId: DEMO_ORG.id,
      credentialId: "adm_1",
      generation: 9,
      actor: humanAdminActor("owner@example.com", "mem_owner"),
      reason: "backfill-again",
    });
    const after = getRuntimeAudit().filter(
      (e) => e.action === "admin.revoke" && e.metadata?.generation === 9
    );
    expect(after.length).toBe(before + 1);
  });
});

/**
 * PR-1: web-direct denial records the human actor's email when the who flag is ON.
 * Flag OFF keeps resolveAdminAuditActor({ orgId }) — org admin agent, empty email.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEMO_ORG, getRuntimeAudit, resetRuntimeMembers, upsertRuntimeMember } from "@/lib/demo-data";
import type { OrgMember } from "@/lib/types";

const WHO = "ADMIN_AUDIT_WHO_REQUIRED_ENABLED";
const WHO_ORGS = "ADMIN_AUDIT_WHO_REQUIRED_ORG_IDS";
const AUTH = "APPROVER_AUTHORITY_ENABLED";
const ORG = DEMO_ORG.id;
const ADMIN = "mem_wd_who_admin";
const OTHER = "mem_wd_other_org";
const caps = ["view_dashboard", "view_employees", "hire_issue_credentials", "manage_team"] as OrgMember["capabilities"];
const saved: { who?: string; orgs?: string; auth?: string } = {};

beforeEach(async () => {
  saved.who = process.env[WHO];
  saved.orgs = process.env[WHO_ORGS];
  saved.auth = process.env[AUTH];
  delete process.env[WHO];
  delete process.env[WHO_ORGS];
  process.env[AUTH] = "true";
  resetRuntimeMembers();
  upsertRuntimeMember(
    {
      id: ADMIN,
      orgId: ORG,
      email: "wd-admin@fixture.invalid",
      displayName: ADMIN,
      role: "admin",
      status: "active",
      capabilities: caps,
    },
    { audit: false }
  );
  upsertRuntimeMember(
    {
      id: OTHER,
      orgId: "org_foreign",
      email: "foreign@fixture.invalid",
      displayName: OTHER,
      role: "owner",
      status: "active",
      capabilities: caps,
    },
    { audit: false }
  );
});

afterEach(() => {
  if (saved.who === undefined) delete process.env[WHO];
  else process.env[WHO] = saved.who;
  if (saved.orgs === undefined) delete process.env[WHO_ORGS];
  else process.env[WHO_ORGS] = saved.orgs;
  if (saved.auth === undefined) delete process.env[AUTH];
  else process.env[AUTH] = saved.auth;
  resetRuntimeMembers();
});

function latestDenial() {
  return getRuntimeAudit().find(
    (e) => e.orgId === ORG && e.action === "admin.policy" && e.purpose === "approver_authority.web_denied"
  );
}

describe("web-direct denial who", () => {
  test("flag OFF: denial still uses org-only resolve (empty email, admin_agent)", async () => {
    const { assertWebActorApproverAuthority } = await import("@/lib/approver-authority/web-direct");
    const r = await assertWebActorApproverAuthority({
      orgId: ORG,
      memberId: ADMIN,
      changes: [{ tool: "setup.slackApprover.set", adminMutation: {} }],
      surface: "settings.notification_channels",
    });
    expect(r.ok).toBe(false);
    const row = latestDenial();
    expect(row).toBeTruthy();
    expect(row!.metadata?.actorKind).toBe("admin_agent");
    expect(row!.actorEmail ?? null).toBeNull();
    expect(row!.metadata?.actorLabel).toBeUndefined();
  });

  test("flag ON: denial writes the human actor email, not the org admin agent", async () => {
    process.env[WHO] = "true";
    const { assertWebActorApproverAuthority } = await import("@/lib/approver-authority/web-direct");
    const r = await assertWebActorApproverAuthority({
      orgId: ORG,
      memberId: ADMIN,
      actorEmail: "wd-admin@fixture.invalid",
      changes: [{ tool: "setup.slackApprover.set", adminMutation: {} }],
      surface: "settings.notification_channels",
    });
    expect(r.ok).toBe(false);
    const row = latestDenial();
    expect(row).toBeTruthy();
    expect(row!.metadata?.actorKind).toBe("human");
    expect(row!.actorEmail).toBe("wd-admin@fixture.invalid");
    expect(row!.metadata?.actorMemberId).toBe(ADMIN);
  });

  test("flag ON: looks up email from the same-org member when actorEmail is omitted", async () => {
    process.env[WHO] = "true";
    const { assertWebActorApproverAuthority } = await import("@/lib/approver-authority/web-direct");
    const r = await assertWebActorApproverAuthority({
      orgId: ORG,
      memberId: ADMIN,
      changes: [{ tool: "setup.slackApprover.set", adminMutation: {} }],
    });
    expect(r.ok).toBe(false);
    const row = latestDenial();
    expect(row!.actorEmail).toBe("wd-admin@fixture.invalid");
    expect(row!.metadata?.actorKind).toBe("human");
  });

  test("flag ON: never uses another org's member email (tenant isolation)", async () => {
    process.env[WHO] = "true";
    const { assertWebActorApproverAuthority } = await import("@/lib/approver-authority/web-direct");
    const r = await assertWebActorApproverAuthority({
      orgId: ORG,
      memberId: OTHER,
      changes: [{ tool: "setup.slackApprover.set", adminMutation: {} }],
    });
    expect(r.ok).toBe(false);
    const row = latestDenial();
    expect(row).toBeTruthy();
    expect(row!.actorEmail).not.toBe("foreign@fixture.invalid");
    expect(row!.metadata?.actorKind).toBe("system");
    expect(String(row!.metadata?.actorLabel || "").trim().length).toBeGreaterThan(0);
    expect(String(row!.metadata?.actorLabel)).not.toMatch(/@/);
  });
});

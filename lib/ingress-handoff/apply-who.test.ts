/**
 * PR-1: ingress apply (job / webhook-ish, no human session) writes a displayable who.
 * Flag ON → actorKind=system + actorLabel.
 * Flag OFF → today's org admin_agent with empty email.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { applyIngressHandoff } from "@/lib/ingress-handoff/apply";
import { DEMO_ORG, getRuntimeAudit } from "@/lib/demo-data";
import type { IngressHandoffRule } from "@/lib/types";

const FLAG = "ADMIN_AUDIT_WHO_REQUIRED_ENABLED";
const ORGS = "ADMIN_AUDIT_WHO_REQUIRED_ORG_IDS";
const saved: { flag?: string; orgs?: string } = {};

const RULE: IngressHandoffRule = {
  id: "ihr_who",
  applyTo: "all",
  body: "full",
  attachment: "file",
  attachmentApproval: "manager",
  sealith: "off",
  audit: { jobId: true, sealithTransferId: false },
};

beforeEach(() => {
  saved.flag = process.env[FLAG];
  saved.orgs = process.env[ORGS];
  delete process.env[FLAG];
  delete process.env[ORGS];
});

afterEach(() => {
  if (saved.flag === undefined) delete process.env[FLAG];
  else process.env[FLAG] = saved.flag;
  if (saved.orgs === undefined) delete process.env[ORGS];
  else process.env[ORGS] = saved.orgs;
});

async function applyGated(jobId: string) {
  return applyIngressHandoff(
    RULE,
    {
      text: "who apply",
      attachments: [{ id: "F1", name: "file.pdf", mimetype: "application/pdf", size: 1000 }],
    },
    { orgId: DEMO_ORG.id, jobId }
  );
}

function latestApply(jobId: string) {
  return getRuntimeAudit().find(
    (e) =>
      e.orgId === DEMO_ORG.id &&
      e.action === "admin.ingressHandoff" &&
      e.metadata?.jobId === jobId
  );
}

describe("ingress apply who", () => {
  test("flag OFF: gated apply stays admin_agent with empty email (regression)", async () => {
    const jobId = `who_off_${Date.now()}`;
    const applied = await applyGated(jobId);
    expect(applied.pendingManagerApproval).toBe(true);
    const row = latestApply(jobId);
    expect(row).toBeTruthy();
    expect(row!.metadata?.actorKind).toBe("admin_agent");
    expect(row!.actorEmail ?? null).toBeNull();
    expect(row!.metadata?.actorLabel).toBeUndefined();
  });

  test("flag ON: gated apply is system + actorLabel and never fabricates email", async () => {
    process.env[FLAG] = "true";
    const jobId = `who_on_${Date.now()}`;
    const applied = await applyGated(jobId);
    expect(applied.pendingManagerApproval).toBe(true);
    const row = latestApply(jobId);
    expect(row).toBeTruthy();
    expect(row!.metadata?.actorKind).toBe("system");
    expect(String(row!.metadata?.actorLabel || "").trim().length).toBeGreaterThan(0);
    expect(String(row!.metadata?.actorLabel)).not.toMatch(/@/);
    expect(row!.actorEmail ?? null).toBeNull();
    expect(JSON.stringify(row!.metadata)).not.toMatch(/gb_adm_|gb_emp_|sp_at_/);
  });
});

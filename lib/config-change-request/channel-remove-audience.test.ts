/**
 * 木村 six-PR review (2026-10-09) "Others" / #287: the employee-side
 * config change request kind=channel_remove gets the same post-delete
 * audience guard as admin channels.remove — refuse at filing (no ticket) and
 * re-check at fulfilment (row kept) when deleting the row would turn the
 * destination internal. Unknown rows: classify first.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEMO_ORG } from "@/lib/demo-data";
import { resolveApproval } from "@/lib/data/approvals";
import { listAuditEvents } from "@/lib/data/audit";
import { deleteOrgChannel, getOrgChannel, upsertOrgChannel, upsertOrgParty } from "@/lib/data/directory";
import { fulfillIfApproved } from "@/lib/approvals/fulfill";
import { resolveAudience } from "@/lib/gateway/audience";
import type { ConversationContext } from "@/lib/types";
import { createConfigChangeRequest, isPendingConfigChange, type ConfigChangeDeps } from "@/lib/config-change-request/service";

const FLAG = "P1_CONFIG_CHANGE_REQUEST_ENABLED";
const ORG = DEMO_ORG.id;
const RELAX = "directory_remove_relaxes_audience";
const flagBackup = process.env[FLAG];
beforeEach(() => {
  process.env[FLAG] = "1";
});
afterEach(() => {
  if (flagBackup === undefined) delete process.env[FLAG];
  else process.env[FLAG] = flagBackup;
});

const deps: Partial<ConfigChangeDeps> = {
  resolveApprover: async () => ({ ok: true, surface: "slack_dm", channelId: "nc_test" }),
  notify: async () => true,
};
const requester = { name: "田中", slackUserId: "U0TANAKA" };
let seq = 0;
const uniq = (p: string) => `${p}${Date.now().toString(36).toUpperCase()}${++seq}`;
const audienceOf = async (slackChannelId: string, slackUserId: string) =>
  (await resolveAudience({ surface: "slack", orgId: ORG, slackChannelId, slackUserId } as ConversationContext)).audience;
const fileRemove = (externalId: string) =>
  createConfigChangeRequest(
    { orgId: ORG, employeeId: "emp_comm", credentialId: null, args: { kind: "channel_remove", jobId: uniq("job-"), requestedBy: requester, channel: { externalId } } },
    deps
  );
async function approveAndFulfil(approvalId: string) {
  const approved = await resolveApproval(approvalId, "approved", "owner@example.com", ORG, { actorId: "user_owner" });
  expect(approved?.status).toBe("approved");
  return fulfillIfApproved(approved!, "approved");
}

describe("config change channel_remove: post-delete audience guard", () => {
  for (const kind of [
    { label: "shared_external", classification: "shared_external" as const, mixed: false },
    { label: "mixed", classification: "internal" as const, mixed: true },
    { label: "unknown", classification: "unknown" as const, mixed: false },
  ]) {
    test(`${kind.label} row + internal slack_channel party → refused at filing, no ticket, row kept, audited`, async () => {
      const externalId = uniq("C");
      const speaker = uniq("U");
      await upsertOrgParty({ orgId: ORG, kind: "slack_channel", identifier: externalId, audience: "internal" });
      await upsertOrgChannel({ orgId: ORG, surface: "slack", externalId, classification: kind.classification, mixed: kind.mixed, skipInspect: true });
      await upsertOrgParty({ orgId: ORG, kind: "slack_user", identifier: speaker, audience: "internal" });
      expect(await audienceOf(externalId, speaker)).toBe("external");
      const res = (await fileRemove(externalId)) as Record<string, unknown>;
      expect(isPendingConfigChange(res as never)).toBe(false);
      expect(res.ok).toBe(false);
      expect(res.code).toBe(RELAX);
      expect(res.applied).toBe(false);
      expect(res.retryable).toBe(false);
      expect(res.audienceBefore).toBe("external");
      expect(res.audienceAfter).toBe("internal");
      expect(String(res.nextStepJa || "")).not.toBe("");
      if (kind.classification === "unknown") {
        expect(String(res.nextStepJa)).toContain("未分類（unknown）");
        expect(String(res.nextStepJa)).toContain("channel_classification");
      }
      const row = await getOrgChannel(ORG, "slack", externalId);
      expect(row).not.toBeNull();
      const events = await listAuditEvents(ORG, 50);
      expect(events.some((e) => e.action === "config.change_refused" && e.metadata?.code === RELAX && e.metadata?.externalId === externalId)).toBe(true);
      // oracle
      await deleteOrgChannel(ORG, row!.id);
      expect(await audienceOf(externalId, speaker)).toBe("internal");
    });
  }

  test("shared_external without an internal party → still filed (stays external after the delete)", async () => {
    const externalId = uniq("C");
    await upsertOrgChannel({ orgId: ORG, surface: "slack", externalId, classification: "shared_external", mixed: true, skipInspect: true });
    const res = await fileRemove(externalId);
    expect(isPendingConfigChange(res)).toBe(true);
  });

  test("fulfil-time recheck: became shared_external after filing (party internal) → not applied, row kept", async () => {
    const externalId = uniq("C");
    const speaker = uniq("U");
    await upsertOrgParty({ orgId: ORG, kind: "slack_channel", identifier: externalId, audience: "internal" });
    await upsertOrgParty({ orgId: ORG, kind: "slack_user", identifier: speaker, audience: "internal" });
    await upsertOrgChannel({ orgId: ORG, surface: "slack", externalId, classification: "internal", skipInspect: true });
    const res = await fileRemove(externalId);
    if (!isPendingConfigChange(res)) throw new Error(`expected needs_approval, got ${res.code}`);
    await upsertOrgChannel({ orgId: ORG, surface: "slack", externalId, classification: "shared_external", mixed: true, skipInspect: true });
    const fulfil = await approveAndFulfil(res.approvalId);
    expect(fulfil?.ok).toBe(false);
    expect(fulfil?.error).toBe(RELAX);
    expect(await getOrgChannel(ORG, "slack", externalId)).not.toBeNull();
    expect(await audienceOf(externalId, speaker)).toBe("external");
  });

  test("internal row → filed and removed as before", async () => {
    const externalId = uniq("C");
    await upsertOrgChannel({ orgId: ORG, surface: "slack", externalId, classification: "internal", skipInspect: true });
    const res = await fileRemove(externalId);
    if (!isPendingConfigChange(res)) throw new Error(`expected needs_approval, got ${res.code}`);
    expect((await approveAndFulfil(res.approvalId))?.ok).toBe(true);
    expect(await getOrgChannel(ORG, "slack", externalId)).toBeNull();
  });
});

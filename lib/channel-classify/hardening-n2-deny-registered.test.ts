/**
 * Follow-up to PR-B (N2): the deny nextStep only shows a classification=internal
 * example for a channel the org has NOT registered (or registered as unknown,
 * not mixed). A registered shared_external / mixed channel gets its own
 * wording (no "make it internal" suggestion). Lookups are scoped to the org.
 */
import { describe, expect, test } from "bun:test";
import { DEMO_ORG } from "@/lib/demo-data";
import { upsertOrgChannel, upsertOrgParty } from "@/lib/data/directory";
import { egressDenyNextStep } from "@/lib/channel-classify/deny-hook";

const ORG = DEMO_ORG.id;
const OTHER = "org_n2_other_fixture";
const deny = { decision: "deny", reason: "external_confidential_denied", audience: "external" };
const body = (conversation: Record<string, unknown>) => ({ tool: "comm.reply", conversation, args: {} }) as never;

describe("N2 deny nextStep vs registration", () => {
  test("unregistered channel → channels.classify with the internal example (unchanged)", async () => {
    const next = await egressDenyNextStep(body({ surface: "slack", slackChannelId: "C0N2UNREG01" }), deny, ORG);
    expect(next?.tool).toBe("channels.classify");
    expect(next?.example?.arguments).toMatchObject({ classification: "internal" });
    expect(next?.messageJa).toContain("classification=internal");
  });

  test("registered shared_external (mixed) → no internal example, separate wording", async () => {
    await upsertOrgChannel({ orgId: ORG, surface: "slack", externalId: "C0N2SHARED1", classification: "shared_external", mixed: true, skipInspect: true });
    const next = await egressDenyNextStep(body({ surface: "slack", slackChannelId: "C0N2SHARED1" }), deny, ORG);
    expect(next).not.toBeNull();
    expect(next?.tool).toBe("channels.list");
    expect(next?.registered).toMatchObject({ classification: "shared_external", mixed: true });
    expect(next?.messageJa).not.toContain("classification=internal");
    expect(next?.messageJa).toContain("登録済み");
    expect(JSON.stringify(next?.example ?? {})).not.toContain("\"internal\"");
  });

  test("registered via a slack_channel party with external audience → registered wording", async () => {
    await upsertOrgParty({ orgId: ORG, kind: "slack_channel", identifier: "C0N2PARTY01", audience: "external" });
    const next = await egressDenyNextStep(body({ surface: "slack", slackChannelId: "C0N2PARTY01" }), deny, ORG);
    expect(next?.messageJa).not.toContain("classification=internal");
  });

  test("LINE / Telegram registered shared_external → no internal example", async () => {
    await upsertOrgChannel({ orgId: ORG, surface: "line", externalId: "Cn2linegroup01", classification: "shared_external", mixed: true, skipInspect: true });
    const next = await egressDenyNextStep(body({ surface: "line", lineId: "Cn2linegroup01" }), deny, ORG);
    expect(next?.messageJa).not.toContain("classification=internal");
  });

  test("registered unknown (not mixed) → internal example still offered", async () => {
    await upsertOrgChannel({ orgId: ORG, surface: "slack", externalId: "C0N2UNKNOWN", classification: "unknown", mixed: false, skipInspect: true });
    const next = await egressDenyNextStep(body({ surface: "slack", slackChannelId: "C0N2UNKNOWN" }), deny, ORG);
    expect(next?.tool).toBe("channels.classify");
  });

  test("BOLA: another org's registration of the same id never changes this org's answer (and vice versa)", async () => {
    await upsertOrgChannel({ orgId: OTHER, surface: "slack", externalId: "C0N2CROSS01", classification: "shared_external", mixed: true, skipInspect: true });
    const mine = await egressDenyNextStep(body({ surface: "slack", slackChannelId: "C0N2CROSS01" }), deny, ORG);
    expect(mine?.tool).toBe("channels.classify");
    expect(mine?.registered).toBeUndefined();
  });

  test("no org → conservative: no internal example", async () => {
    const next = await egressDenyNextStep(body({ surface: "slack", slackChannelId: "C0N2NOORG01" }), deny, "");
    expect(next?.messageJa ?? "").not.toContain("classification=internal");
  });
});

/**
 * The "woke" audit must record who spoke (speakerId / speakerTeamId) so that
 * later actions (e.g. config.change_request) can be checked against the real
 * Slack sender instead of a self-declared name.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { bindEmployeeSlackIdentity, revokeEmployeeSlackIdentity } from "@/lib/data/slack-identities";
import { updateWakeWebhook } from "@/lib/data";
import { DEMO_ORG, getRuntimeAudit, getRuntimeEmployees } from "@/lib/demo-data";
import { processSlackMentionEnvelope, setSlackMentionClaimInsertForTests } from "@/lib/slack/mention-ingress";

const BOUND_USER = "U_SPK_BOT";
const SPEAKER = "U_SPK_HUMAN";
const TEAM = "T_DEMO";
const CHANNEL = "C_SPK_AUDIT";

let savedFetch: typeof fetch;
let savedSigning: string | undefined;
beforeEach(() => {
  savedFetch = globalThis.fetch;
  savedSigning = process.env.SLACK_SIGNING_SECRET;
  process.env.SLACK_SIGNING_SECRET = "slack-signing-secret-fixture";
  globalThis.fetch = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = savedFetch;
  setSlackMentionClaimInsertForTests(null);
  if (savedSigning === undefined) delete process.env.SLACK_SIGNING_SECRET;
  else process.env.SLACK_SIGNING_SECRET = savedSigning;
});

test("mention wake audit carries speakerId and speakerTeamId", async () => {
  const emp = getRuntimeEmployees().find((item) => item.id === "emp_comm");
  if (!emp) throw new Error("missing emp_comm");
  const previous = emp.allowedAccounts;
  emp.allowedAccounts = [{ service: "slack", accountId: BOUND_USER }];
  await revokeEmployeeSlackIdentity({ employeeId: emp.id, orgId: DEMO_ORG.id });
  await bindEmployeeSlackIdentity({
    employeeId: emp.id, orgId: DEMO_ORG.id, slackUserId: BOUND_USER, slackTeamId: TEAM,
    displayName: "話者テスト", userToken: "xoxp-test",
  });
  await updateWakeWebhook(emp.id, { orgId: DEMO_ORG.id, url: "https://example.test/wake/spk", secret: "k" });
  try {
    const ts = `1787911900.${String(Date.now()).slice(-6)}`;
    const outcome = await processSlackMentionEnvelope({
      type: "event_callback",
      team_id: TEAM,
      event_id: `Ev_spk_${Date.now()}`,
      event: { type: "message", user: SPEAKER, text: `<@${BOUND_USER}> 指示を変えて`, ts, channel: CHANNEL },
    });
    expect(outcome.woke).toBe(1);
    const woke = getRuntimeAudit().find(
      (event) => event.action === "slack.mention_wake" && event.metadata?.reason === "woke" && event.metadata?.ts === ts
    );
    expect(woke).toBeDefined();
    expect(woke?.metadata.speakerId).toBe(SPEAKER);
    expect(woke?.metadata.speakerTeamId).toBe(TEAM);
    expect(woke?.metadata.channel).toBe(CHANNEL);
  } finally {
    await revokeEmployeeSlackIdentity({ employeeId: emp.id, orgId: DEMO_ORG.id });
    await updateWakeWebhook(emp.id, { orgId: DEMO_ORG.id, url: null, secret: "" });
    emp.allowedAccounts = previous;
  }
});

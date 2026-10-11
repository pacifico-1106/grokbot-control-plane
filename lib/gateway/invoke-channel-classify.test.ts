/**
 * PR-B at the gateway deny site: the deny is never weakened, nextStep points
 * at channels.classify (always, informational), and the stuck notification is
 * attempted only with CHANNEL_STUCK_NOTIFY_ENABLED. A notifier failure keeps
 * the 403.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { DEMO_ORG } from "@/lib/demo-data";
import { runGatewayInvoke } from "@/lib/gateway/invoke";
import { setStuckNotifyDepsForTests } from "@/lib/channel-classify/stuck-notify";
import { resetDemoChannelClassifyStore } from "@/lib/data/channel-classify";

let attempts = 0;

afterEach(() => {
  delete process.env.CHANNEL_STUCK_NOTIFY_ENABLED;
  setStuckNotifyDepsForTests(null);
  resetDemoChannelClassifyStore();
  attempts = 0;
});

function invoke(channel: string) {
  return runGatewayInvoke({
    employeeId: "emp_comm",
    credentialId: "cred_comm",
    body: {
      tool: "comm.reply",
      purpose: "comm.internal",
      jobId: `job_unreg_${channel}_${Date.now()}`,
      conversation: { surface: "slack", orgId: DEMO_ORG.id, slackChannelId: channel },
      args: { slackChannelId: channel, text: "SECRET-BODY-NEVER-IN-NOTICE" },
    },
  });
}

describe("gateway deny in an unregistered channel", () => {
  test("403 egress_denied with nextStep → channels.classify (flag OFF: no notice attempt)", async () => {
    setStuckNotifyDepsForTests({
      listChannels: async () => { attempts += 1; return []; },
      send: async () => ({ ok: true }),
      audit: async () => undefined,
      mail: async () => ({ ok: true }),
    });
    const result = await invoke("C0UNREGGW001");
    expect(result.httpStatus).toBe(403);
    expect(result.body.code).toBe("egress_denied");
    expect(result.body.error).toBe("external_confidential_denied");
    const next = result.body.nextStep as { tool?: string; externalId?: string; example?: { arguments?: Record<string, unknown> } };
    expect(next?.tool).toBe("channels.classify");
    expect(next?.externalId).toBe("C0UNREGGW001");
    expect(next?.example?.arguments?.externalId).toBe("C0UNREGGW001");
    expect(String(result.body.nextStepJa)).toContain("channels.classify");
    expect(attempts).toBe(0);
  });

  test("flag ON + notifier throwing → still 403 egress_denied (fail-closed), notice attempted", async () => {
    process.env.CHANNEL_STUCK_NOTIFY_ENABLED = "true";
    setStuckNotifyDepsForTests({
      listChannels: async () => { attempts += 1; throw new Error("db down"); },
      send: async () => { throw new Error("boom"); },
      audit: async () => { throw new Error("audit down"); },
      mail: async () => { throw new Error("mail down"); },
    });
    const result = await invoke("C0UNREGGW002");
    expect(result.httpStatus).toBe(403);
    expect(result.body.code).toBe("egress_denied");
    expect(result.body.ok).toBe(false);
    expect(attempts).toBeGreaterThan(0);
  });
});

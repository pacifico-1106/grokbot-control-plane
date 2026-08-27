import { describe, expect, test } from "bun:test";
import { incrementActionCounter } from "@/lib/data/action-counters";
import { upsertConversationAdapter } from "@/lib/data/conversation-adapters";
import { getRuntimeEmployees } from "@/lib/demo-data";
import { runGatewayInvoke } from "@/lib/gateway/invoke";
import { DEMO_ORG } from "@/lib/demo-data";

describe("Gateway audience egress", () => {
  test("slack.post alias cannot bypass: external dest still deny for confidential", async () => {
    const result = await runGatewayInvoke({
      employeeId: "emp_comm",
      credentialId: "cred_comm",
      body: {
        tool: "slack.post",
        purpose: "comm.internal",
        jobId: `job_alias_${Date.now()}`,
        conversation: {
          surface: "slack",
          orgId: DEMO_ORG.id,
          slackChannelId: "C_SHARED",
        },
        args: { slackChannelId: "C_SHARED" },
      },
    });
    expect(result.httpStatus).toBe(403);
    expect(result.body.code).toBe("egress_denied");
    expect(result.body.ok).toBe(false);
  });

  test("slack.post to internal public is allowed (not mayAuto via tool name alone)", async () => {
    const result = await runGatewayInvoke({
      employeeId: "emp_comm",
      credentialId: "cred_comm",
      body: {
        tool: "slack.post",
        purpose: "comm.internal",
        jobId: `job_internal_${Date.now()}`,
        conversation: {
          surface: "slack",
          orgId: DEMO_ORG.id,
          slackChannelId: "C_INTERNAL",
        },
        args: { assetRef: "kb/public-faq", slackChannelId: "C_INTERNAL" },
      },
    });
    expect(result.body.ok).toBe(true);
    expect((result.body.egress as { decision?: string } | undefined)?.decision).toBe("allow");
    expect((result.body.result as { delivery?: string } | undefined)?.delivery).toBe("stub");
  });

  test("slack.post_external alias still summarize/deny by destination, not always_human", async () => {
    const allow = await runGatewayInvoke({
      employeeId: "emp_comm",
      credentialId: "cred_comm",
      body: {
        tool: "slack.post_external",
        purpose: "comm.internal",
        jobId: `job_ext_allow_${Date.now()}`,
        conversation: {
          surface: "slack",
          orgId: DEMO_ORG.id,
          slackChannelId: "C_INTERNAL",
        },
        args: { assetRef: "kb/public-faq", slackChannelId: "C_INTERNAL" },
      },
    });
    expect(allow.body.ok).toBe(true);

    const summarized = await runGatewayInvoke({
      employeeId: "emp_comm",
      credentialId: "cred_comm",
      body: {
        tool: "slack.post_external",
        purpose: "comm.internal",
        jobId: `job_ext_sum_${Date.now()}`,
        conversation: {
          surface: "slack",
          orgId: DEMO_ORG.id,
          slackChannelId: "C_SHARED",
        },
        args: {
          assetRef: "kb/handbook",
          disclosure: "summary",
          slackChannelId: "C_SHARED",
        },
      },
    });
    expect(summarized.body.ok).toBe(true);
    expect((summarized.body.egress as { decision?: string } | undefined)?.decision).toBe("summarize");
  });

  test("comm.send without destination fail-closes as external unknown", async () => {
    const result = await runGatewayInvoke({
      employeeId: "emp_comm",
      credentialId: "cred_comm",
      body: {
        tool: "comm.send",
        purpose: "comm.internal",
        jobId: `job_nodest_${Date.now()}`,
        conversation: { surface: "slack", orgId: DEMO_ORG.id },
      },
    });
    expect(result.httpStatus).toBe(403);
    expect(result.body.code).toBe("egress_denied");
  });

  test("external × public via comm.send allows", async () => {
    const result = await runGatewayInvoke({
      employeeId: "emp_comm",
      credentialId: "cred_comm",
      body: {
        tool: "comm.send",
        purpose: "comm.internal",
        jobId: `job_pub_${Date.now()}`,
        conversation: {
          surface: "mail",
          orgId: DEMO_ORG.id,
          email: "buyer@customer.example",
        },
        args: { assetRef: "kb/public-faq" },
      },
    });
    expect(result.body.ok).toBe(true);
    expect((result.body.egress as { decision?: string } | undefined)?.decision).toBe("allow");
  });

  test("SoD force_human still queues even if matrix would allow", async () => {
    const result = await runGatewayInvoke({
      employeeId: "emp_sales",
      credentialId: "cred_sales",
      body: {
        tool: "slack.post",
        purpose: "sales.outreach",
        jobId: `job_sod_egress_${Date.now()}`,
        conversation: {
          surface: "slack",
          orgId: DEMO_ORG.id,
          slackChannelId: "C_INTERNAL",
        },
        args: { assetRef: "kb/public-faq", slackChannelId: "C_INTERNAL" },
      },
    });
    expect(result.httpStatus).toBe(402);
    expect(result.body.needs_approval).toBe(true);
    expect(String(result.body.summary)).toContain("権限混在社員");
  });

  test("action-limit 2× still denies even if matrix would allow", async () => {
    const employee = getRuntimeEmployees().find((item) => item.id === "emp_comm");
    expect(employee).toBeTruthy();
    const previous = employee!.actionLimits;
    employee!.actionLimits = { "slack.post": { perDay: 1 } };
    try {
      await incrementActionCounter({
        orgId: DEMO_ORG.id,
        employeeId: "emp_comm",
        credentialId: "cred_comm",
        tool: "slack.post",
        jobId: "job_limit_seed_1",
        purpose: "comm.internal",
      });
      await incrementActionCounter({
        orgId: DEMO_ORG.id,
        employeeId: "emp_comm",
        credentialId: "cred_comm",
        tool: "slack.post",
        jobId: "job_limit_seed_2",
        purpose: "comm.internal",
      });
      const result = await runGatewayInvoke({
        employeeId: "emp_comm",
        credentialId: "cred_comm",
        body: {
          tool: "slack.post",
          purpose: "comm.internal",
          jobId: `job_limit_${Date.now()}`,
          conversation: {
            surface: "slack",
            orgId: DEMO_ORG.id,
            slackChannelId: "C_INTERNAL",
          },
          args: { assetRef: "kb/public-faq", slackChannelId: "C_INTERNAL" },
        },
      });
      expect(result.httpStatus).toBe(403);
      expect(result.body.code).toBe("action_limit_denied");
    } finally {
      employee!.actionLimits = previous;
    }
  });

  test("model cannot self-declare public to bypass confidential default", async () => {
    const result = await runGatewayInvoke({
      employeeId: "emp_comm",
      credentialId: "cred_comm",
      body: {
        tool: "slack.post",
        purpose: "comm.internal",
        jobId: `job_claim_public_${Date.now()}`,
        conversation: {
          surface: "slack",
          orgId: DEMO_ORG.id,
          slackChannelId: "C_SHARED",
        },
        informationClass: "public",
        args: { informationClass: "public", slackChannelId: "C_SHARED" },
      },
    });
    expect(result.httpStatus).toBe(403);
    expect(result.body.code).toBe("egress_denied");
  });

  test("slack.post with enabled adapter posts live and surfaces Slack API failure", async () => {
    await upsertConversationAdapter({
      orgId: DEMO_ORG.id,
      surface: "slack",
      enabled: true,
      secrets: { botToken: "xoxb-test" },
    });
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () =>
        Response.json({ ok: true, channel: "C_INTERNAL", ts: "1503435956.000247" })) as typeof fetch;
      const sent = await runGatewayInvoke({
        employeeId: "emp_comm",
        credentialId: "cred_comm",
        body: {
          tool: "slack.post",
          purpose: "comm.internal",
          jobId: `job_live_${Date.now()}`,
          conversation: {
            surface: "slack",
            orgId: DEMO_ORG.id,
            slackChannelId: "C_INTERNAL",
          },
          args: { assetRef: "kb/public-faq", slackChannelId: "C_INTERNAL", text: "公開FAQ" },
        },
      });
      expect(sent.body.ok).toBe(true);
      expect((sent.body.result as { delivery?: string } | undefined)?.delivery).toBe("slack");

      globalThis.fetch = (async () =>
        Response.json({ ok: false, error: "not_in_channel" })) as typeof fetch;
      const failed = await runGatewayInvoke({
        employeeId: "emp_comm",
        credentialId: "cred_comm",
        body: {
          tool: "slack.post",
          purpose: "comm.internal",
          jobId: `job_fail_${Date.now()}`,
          conversation: {
            surface: "slack",
            orgId: DEMO_ORG.id,
            slackChannelId: "C_INTERNAL",
          },
          args: { assetRef: "kb/public-faq", slackChannelId: "C_INTERNAL", text: "公開FAQ" },
        },
      });
      expect(failed.httpStatus).toBe(502);
      expect(failed.body.code).toBe("slack_post_failed");
      expect(failed.body.ok).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
      await upsertConversationAdapter({
        orgId: DEMO_ORG.id,
        surface: "slack",
        enabled: false,
        secrets: {},
      });
    }
  });
});

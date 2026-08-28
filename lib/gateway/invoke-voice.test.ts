import { describe, expect, test } from "bun:test";
import { DEMO_ORG } from "@/lib/demo-data";
import { VOICE_FORBIDDEN_CODE, VOICE_FORBIDDEN_MESSAGE_JA } from "@/lib/employees/voice";
import { runGatewayInvoke } from "@/lib/gateway/invoke";

describe("Gateway voice floor on outbound comm", () => {
  test("slack.post to C_SHARED with 了解 → 403 voice_forbidden_phrase", async () => {
    const result = await runGatewayInvoke({
      employeeId: "emp_comm",
      credentialId: "cred_comm",
      body: {
        tool: "slack.post",
        purpose: "comm.internal",
        jobId: `job_voice_ext_${Date.now()}`,
        conversation: {
          surface: "slack",
          orgId: DEMO_ORG.id,
          slackChannelId: "C_SHARED",
        },
        args: {
          assetRef: "kb/public-faq",
          slackChannelId: "C_SHARED",
          text: "了解しました。公開FAQです。",
        },
      },
    });
    expect(result.httpStatus).toBe(403);
    expect(result.body.code).toBe(VOICE_FORBIDDEN_CODE);
    expect(result.body.ok).toBe(false);
    expect(result.body.message).toBe(VOICE_FORBIDDEN_MESSAGE_JA);
    expect((result.body.voice as { register?: string; floorApplied?: boolean } | undefined)?.register).toBe("polite");
    expect((result.body.voice as { floorApplied?: boolean } | undefined)?.floorApplied).toBe(true);
  });

  test("slack.post to C_INTERNAL public with 了解 on frank employee → allow", async () => {
    const result = await runGatewayInvoke({
      employeeId: "emp_comm",
      credentialId: "cred_comm",
      body: {
        tool: "slack.post",
        purpose: "comm.internal",
        jobId: `job_voice_int_${Date.now()}`,
        conversation: {
          surface: "slack",
          orgId: DEMO_ORG.id,
          slackChannelId: "C_INTERNAL",
        },
        args: {
          assetRef: "kb/public-faq",
          slackChannelId: "C_INTERNAL",
          text: "了解。社内向けです。",
        },
      },
    });
    expect(result.body.ok).toBe(true);
    expect((result.body.egress as { decision?: string } | undefined)?.decision).toBe("allow");
    expect((result.body.voice as { register?: string; floorApplied?: boolean } | undefined)?.register).toBe("frank");
    expect((result.body.voice as { floorApplied?: boolean } | undefined)?.floorApplied).toBe(false);
  });
});

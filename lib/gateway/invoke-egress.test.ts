import { describe, expect, test } from "bun:test";
import { incrementActionCounter } from "@/lib/data/action-counters";
import { getApprovalById, getApprovalStatusByToken, resolveApproval } from "@/lib/data";
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

  test("acked mixed-domain employee with risk_based does not blanket-queue slack.post", async () => {
    const sales = getRuntimeEmployees().find((item) => item.id === "emp_sales");
    expect(sales).toBeTruthy();
    expect(sales!.sodLevel).toBe("force_human");
    const previous = sales!.approvalPolicy;
    sales!.approvalPolicy = "risk_based";
    try {
      const result = await runGatewayInvoke({
        employeeId: "emp_sales",
        credentialId: "cred_sales",
        body: {
          tool: "slack.post",
          purpose: "sales.outreach",
          jobId: `job_sod_ack_${Date.now()}`,
          conversation: {
            surface: "slack",
            orgId: DEMO_ORG.id,
            slackChannelId: "C_INTERNAL",
          },
          args: { assetRef: "kb/public-faq", slackChannelId: "C_INTERNAL" },
        },
      });
      expect(result.body.needs_approval).not.toBe(true);
      expect(result.body.ok).toBe(true);
      expect((result.body.egress as { decision?: string } | undefined)?.decision).toBe("allow");

      const send = await runGatewayInvoke({
        employeeId: "emp_sales",
        credentialId: "cred_sales",
        body: {
          tool: "mail.send",
          purpose: "sales.outreach",
          jobId: `job_sod_ack_send_${Date.now()}`,
        },
      });
      expect(send.httpStatus).toBe(402);
      expect(send.body.needs_approval).toBe(true);
    } finally {
      sales!.approvalPolicy = previous;
    }
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
      expect(failed.body.code).toBe("slack_not_in_channel");
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

  test("prior approval of needs_approval egress still posts Slack conversation (full text)", async () => {
    const jobId = `job_prior_conf_${Date.now()}`;
    const threadTs = "1787911797.502889";
    const body = {
      tool: "comm.reply",
      purpose: "comm.internal",
      jobId,
      conversation: {
        surface: "slack" as const,
        orgId: DEMO_ORG.id,
        slackChannelId: "C_INTERNAL",
        threadId: threadTs,
      },
      args: {
        slackChannelId: "C_INTERNAL",
        text: "顧客への返信本文",
        threadId: threadTs,
      },
    };
    const queued = await runGatewayInvoke({
      employeeId: "emp_comm",
      credentialId: "cred_comm",
      body,
    });
    expect(queued.httpStatus).toBe(402);
    expect(queued.body.needs_approval).toBe(true);
    expect((queued.body.egress as { decision?: string } | undefined)?.decision).toBe(
      "needs_approval"
    );
    const approvalId = String(queued.body.approvalId || "");
    expect(approvalId).toBeTruthy();
    const approved = await resolveApproval(
      approvalId,
      "approved",
      "ando@example.com",
      DEMO_ORG.id
    );
    expect(approved?.status).toBe("approved");

    await upsertConversationAdapter({
      orgId: DEMO_ORG.id,
      surface: "slack",
      enabled: true,
      secrets: { botToken: "xoxb-test" },
    });
    const originalFetch = globalThis.fetch;
    let postedUrl = "";
    let postedAuth = "";
    let postedPayload: Record<string, unknown> = {};
    try {
      globalThis.fetch = (async (input, init) => {
        postedUrl = String(input);
        postedAuth = String(
          (init?.headers as Record<string, string> | undefined)?.authorization || ""
        );
        postedPayload = JSON.parse(String(init?.body || "{}"));
        return Response.json({
          ok: true,
          channel: "C_INTERNAL",
          ts: "1787911800.000001",
        });
      }) as typeof fetch;
      const sent = await runGatewayInvoke({
        employeeId: "emp_comm",
        credentialId: "cred_comm",
        body: { ...body, approvalId },
      });
      expect(sent.body.ok).toBe(true);
      expect((sent.body.egress as { decision?: string } | undefined)?.decision).toBe(
        "needs_approval"
      );
      expect(postedUrl).toBe("https://slack.com/api/chat.postMessage");
      expect(postedAuth).toBe("Bearer xoxb-test");
      expect(postedPayload.channel).toBe("C_INTERNAL");
      expect(postedPayload.thread_ts).toBe(threadTs);
      expect(String(postedPayload.text)).toBe("顧客への返信本文");
      expect(String(postedPayload.text)).not.toContain("【要約のみ】");
      const delivery = sent.body.conversationDelivery as
        | { delivery?: string; ts?: string; channel?: string }
        | undefined;
      expect(delivery?.delivery).toBe("slack");
      expect(delivery?.ts).toBe("1787911800.000001");
      expect((sent.body.result as { accepted?: boolean; delivery?: string } | undefined)?.accepted).toBe(
        true
      );
      expect((sent.body.result as { delivery?: string } | undefined)?.delivery).toBe("slack");
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

  test("comm.reply approval summary includes channel and full body", async () => {
    const bodyText = "メンションへの返信本文です。";
    const result = await runGatewayInvoke({
      employeeId: "emp_comm",
      credentialId: "cred_comm",
      body: {
        tool: "comm.reply",
        purpose: "comm.internal",
        jobId: `job_artifact_reply_${Date.now()}`,
        conversation: {
          surface: "slack",
          orgId: DEMO_ORG.id,
          slackChannelId: "C_INTERNAL",
          threadId: "1787911797.502889",
        },
        args: {
          slackChannelId: "C_INTERNAL",
          channelName: "internal-cs",
          text: bodyText,
          threadId: "1787911797.502889",
        },
      },
    });
    expect(result.httpStatus).toBe(402);
    expect(result.body.needs_approval).toBe(true);
    const summary = String(result.body.summary);
    expect(summary).toContain("チャネル: C_INTERNAL");
    expect(summary).toContain("internal-cs");
    expect(summary).toContain(bodyText);
    expect(summary).toContain("情報区分: 機密");
    expect(summary).toContain("相手先: 社内");
    const approvalId = String(result.body.approvalId || "");
    const stored = await getApprovalById(approvalId, DEMO_ORG.id);
    expect(stored?.summary).toContain(bodyText);
    expect((stored?.metadata as { artifact?: { body?: string } }).artifact?.body).toBe(
      bodyText
    );
  });

  test("mail.send approval summary includes to and subject", async () => {
    const result = await runGatewayInvoke({
      employeeId: "emp_sales",
      credentialId: "cred_sales",
      body: {
        tool: "mail.send",
        purpose: "sales.outreach",
        jobId: `job_artifact_mail_${Date.now()}`,
        args: {
          assetRef: "kb/public-faq",
          to: "buyer@customer.example",
          subject: "見積フォロー",
          body: "先日の見積のご確認をお願いします。",
        },
      },
    });
    expect(result.httpStatus).toBe(402);
    expect(result.body.needs_approval).toBe(true);
    const summary = String(result.body.summary);
    expect(summary).toContain("宛先: buyer@customer.example");
    expect(summary).toContain("件名: 見積フォロー");
    expect(summary).toContain("先日の見積のご確認をお願いします。");
  });

  test("egress deny still 403 and does not queue an approval", async () => {
    const result = await runGatewayInvoke({
      employeeId: "emp_comm",
      credentialId: "cred_comm",
      body: {
        tool: "comm.reply",
        purpose: "comm.internal",
        jobId: `job_deny_${Date.now()}`,
        conversation: {
          surface: "slack",
          orgId: DEMO_ORG.id,
          slackChannelId: "C_SHARED",
        },
        args: { slackChannelId: "C_SHARED", text: "機密を社外へ" },
      },
    });
    expect(result.httpStatus).toBe(403);
    expect(result.body.code).toBe("egress_denied");
    expect(result.body.ok).toBe(false);
    expect(result.body.needs_approval).not.toBe(true);
  });

  test("revision_requested allows same jobId re-submit as a new pending ticket", async () => {
    const jobId = `job_rev_${Date.now()}`;
    const first = await runGatewayInvoke({
      employeeId: "emp_comm",
      credentialId: "cred_comm",
      body: {
        tool: "comm.reply",
        purpose: "comm.internal",
        jobId,
        conversation: {
          surface: "slack",
          orgId: DEMO_ORG.id,
          slackChannelId: "C_INTERNAL",
          threadId: "1787911797.502889",
        },
        args: { slackChannelId: "C_INTERNAL", text: "初稿の返信" },
      },
    });
    expect(first.httpStatus).toBe(402);
    const firstId = String(first.body.approvalId || "");
    const revised = await resolveApproval(
      firstId,
      "revision_requested",
      "ando@example.com",
      DEMO_ORG.id,
      { revisionNote: "金額表記を削除してください" }
    );
    expect(revised?.status).toBe("revision_requested");
    const polled = await getApprovalStatusByToken(
      firstId,
      String(first.body.statusToken || "")
    );
    expect(polled?.status).toBe("revision_requested");
    const second = await runGatewayInvoke({
      employeeId: "emp_comm",
      credentialId: "cred_comm",
      body: {
        tool: "comm.reply",
        purpose: "comm.internal",
        jobId,
        conversation: {
          surface: "slack",
          orgId: DEMO_ORG.id,
          slackChannelId: "C_INTERNAL",
          threadId: "1787911797.502889",
        },
        args: { slackChannelId: "C_INTERNAL", text: "修正後の返信" },
      },
    });
    expect(second.httpStatus).toBe(402);
    expect(second.body.needs_approval).toBe(true);
    expect(String(second.body.approvalId)).not.toBe(firstId);
    expect(String(second.body.summary)).toContain("修正後の返信");
    expect((await getApprovalById(firstId, DEMO_ORG.id))?.status).toBe(
      "revision_requested"
    );
    expect((await getApprovalById(String(second.body.approvalId), DEMO_ORG.id))?.status).toBe(
      "pending"
    );
  });

  test("postingAs=user without bound token fails slack_identity_unbound (not stub)", async () => {
    const emp = getRuntimeEmployees().find((item) => item.id === "emp_comm");
    if (!emp) throw new Error("missing emp_comm");
    const previous = emp.postingAs;
    emp.postingAs = "user";
    try {
      const result = await runGatewayInvoke({
        employeeId: "emp_comm",
        credentialId: "cred_comm",
        body: {
          tool: "slack.post",
          purpose: "comm.internal",
          jobId: `job_unbound_${Date.now()}`,
          conversation: {
            surface: "slack",
            orgId: DEMO_ORG.id,
            slackChannelId: "C_INTERNAL",
          },
          args: { assetRef: "kb/public-faq", slackChannelId: "C_INTERNAL", text: "hello" },
        },
      });
      expect(result.httpStatus).toBe(502);
      expect(result.body.code).toBe("slack_identity_unbound");
      expect(result.body.ok).toBe(false);
    } finally {
      emp.postingAs = previous;
    }
  });

});

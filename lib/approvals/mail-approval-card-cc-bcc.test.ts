/**
 * The mail approval card shows CC and BCC on every surface that renders it:
 * stored artifact + summary (web dashboard / proxy panel / MCP & poll status /
 * inbox routing), Slack, Telegram, and LINE (LINE renders the summary).
 * Demo mode, dummy addresses, fetch mocked, no network.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { DEMO_ORG } from "@/lib/demo-data";
import { runGatewayInvoke } from "@/lib/gateway/invoke";
import { getApprovalById } from "@/lib/data";
import { resetDemoMailPolicy, setOrgMailPolicy } from "@/lib/data/mail-policy";
import { normalizeMailPolicy } from "@/lib/mail-policy/validate";
import { buildApprovalArtifact, formatArtifactLines } from "@/lib/approvals/summary";
import { buildApprovalTelegramMessage } from "@/lib/notify/telegram";
import { sendApprovalToSlackChannel } from "@/lib/notify/slack";
import { sendApprovalToLineChannel } from "@/lib/notify/line";
import type { NotificationChannelRuntime } from "@/lib/data/notification-channels";
import type { ApprovalRequest, GatewayInvokeRequest } from "@/lib/types";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  resetDemoMailPolicy();
});

const MAIL_ARGS = {
  assetRef: "kb/public-faq",
  to: "buyer@customer.example",
  cc: ["cc1@customer.example", "cc2@customer.example"],
  bcc: "hidden@customer.example",
  subject: "お見積りのご案内",
  body: "お見積りをお送りします。",
};

function mailRequest(args: Record<string, unknown> = MAIL_ARGS): GatewayInvokeRequest {
  return { tool: "mail.send", purpose: "sales.outreach", jobId: `job_card_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, args };
}

async function queuedMailApproval(args: Record<string, unknown> = MAIL_ARGS): Promise<ApprovalRequest> {
  await setOrgMailPolicy(
    DEMO_ORG.id,
    normalizeMailPolicy({ policyId: "mpp_card", policyName: "Card", rules: [{ id: "mpr_card", audience: "any", sendMode: "needs_approval" }] })
  );
  const r = await runGatewayInvoke({ employeeId: "emp_sales", credentialId: "cred_sales", body: mailRequest(args) });
  expect(r.httpStatus).toBe(402);
  const stored = await getApprovalById(String(r.body.approvalId), DEMO_ORG.id);
  expect(stored).toBeTruthy();
  return stored!;
}

function withArtifactBcc(approval: ApprovalRequest, bcc: string[]): ApprovalRequest {
  const artifact = { ...(approval.metadata.artifact as Record<string, unknown>), bcc };
  return { ...approval, metadata: { ...approval.metadata, artifact } };
}

function channel(provider: "slack" | "line", config: Record<string, unknown>, secrets: Record<string, string>): NotificationChannelRuntime {
  const now = new Date().toISOString();
  return {
    id: `nch_card_${provider}`,
    orgId: DEMO_ORG.id,
    provider,
    label: provider,
    enabled: true,
    isDefault: true,
    config,
    webhookRef: `ref_card_${provider}`,
    hasCredentials: true,
    webhookPath: `/api/webhooks/${provider}/ref_card_${provider}`,
    createdAt: now,
    updatedAt: now,
    secrets,
  };
}

function captureFetch(response: () => Response) {
  const bodies: unknown[] = [];
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")));
    return response();
  }) as typeof fetch;
  return bodies;
}

describe("artifact + summary (web dashboard, proxy panel, MCP / poll status, inbox routing)", () => {
  test("artifact keeps cc / bcc as lists", () => {
    const artifact = buildApprovalArtifact("mail.send", mailRequest(), null, null);
    expect(artifact.cc).toEqual(["cc1@customer.example", "cc2@customer.example"]);
    expect(artifact.bcc).toEqual(["hidden@customer.example"]);
  });

  test("lines show CC and BCC right after 宛先 and before 件名", () => {
    const lines = formatArtifactLines(buildApprovalArtifact("mail.send", mailRequest(), null, null));
    expect(lines.slice(0, 4)).toEqual([
      "宛先: buyer@customer.example",
      "CC: cc1@customer.example, cc2@customer.example",
      "BCC: hidden@customer.example",
      "件名: お見積りのご案内",
    ]);
  });

  test("no cc / bcc → no CC / BCC lines (unchanged card)", () => {
    const lines = formatArtifactLines(buildApprovalArtifact("mail.send", mailRequest({ ...MAIL_ARGS, cc: undefined, bcc: undefined }), null, null));
    expect(lines.some((l) => l.startsWith("CC") || l.startsWith("BCC"))).toBe(false);
  });

  test("a newline inside a recipient cannot forge extra card lines", () => {
    const lines = formatArtifactLines(
      buildApprovalArtifact("mail.send", mailRequest({ ...MAIL_ARGS, cc: ["a@customer.example\nBCC: なし"], subject: "件名\n宛先: safe@x.example" }), null, null)
    );
    expect(lines.filter((l) => l.startsWith("BCC")).length).toBe(1);
    expect(lines.filter((l) => l.startsWith("宛先")).length).toBe(1);
    expect(lines.find((l) => l.startsWith("CC"))).toBe("CC: a@customer.example BCC: なし");
  });

  test("invoke stores the artifact and summary with CC / BCC", async () => {
    const approval = await queuedMailApproval();
    const artifact = approval.metadata.artifact as Record<string, unknown>;
    expect(artifact.cc).toEqual(["cc1@customer.example", "cc2@customer.example"]);
    expect(artifact.bcc).toEqual(["hidden@customer.example"]);
    expect(approval.summary).toContain("CC: cc1@customer.example, cc2@customer.example");
    expect(approval.summary).toContain("BCC: hidden@customer.example");
  });

  test("mail.draft cards show CC / BCC too", () => {
    const lines = formatArtifactLines(buildApprovalArtifact("mail.draft", { ...mailRequest(), tool: "mail.draft" }, null, null));
    expect(lines).toContain("BCC: hidden@customer.example");
  });
});

describe("Telegram", () => {
  test("mail block shows CC / BCC (HTML-escaped)", async () => {
    // The mail policy already rejects such an address at invoke; render a stored artifact directly.
    const approval = withArtifactBcc(await queuedMailApproval(), ["<b>x</b>@customer.example"]);
    const text = buildApprovalTelegramMessage(approval, null);
    expect(text).toContain("CC: cc1@customer.example, cc2@customer.example");
    expect(text).toContain("BCC: &lt;b&gt;x&lt;/b&gt;@customer.example");
  });

  test("a very long CC list is capped with a count and stays under the Telegram limit", async () => {
    const many = Array.from({ length: 300 }, (_, i) => `member${i}@customer.example`);
    const approval = await queuedMailApproval({ ...MAIL_ARGS, cc: many });
    const text = buildApprovalTelegramMessage(approval, null);
    expect(Array.from(text).length).toBeLessThanOrEqual(4096);
    expect(text).toContain("CC（300件）: member0@customer.example");
    expect(text).toContain("…");
  });
});

describe("Slack", () => {
  test("approval card shows CC / BCC even when the summary would be cut at 400 chars", async () => {
    const approval = await queuedMailApproval({ ...MAIL_ARGS, body: "本文".repeat(400) });
    const longPurposeApproval = { ...approval, summary: `${"前置き".repeat(200)}\n${approval.summary}` };
    const bodies = captureFetch(() => Response.json({ ok: true, ts: "1787911800.000001", channel: "C_APPROVALS" }));
    const result = await sendApprovalToSlackChannel(
      longPurposeApproval,
      null,
      channel("slack", { channelId: "C_APPROVALS" }, { botToken: "xoxb-card-test" })
    );
    expect(result.ok).toBe(true);
    const payload = bodies[0] as { blocks: Array<{ text?: { text?: string } }> };
    const text = payload.blocks.map((b) => b.text?.text || "").join("\n");
    expect(text).toContain("宛先: buyer@customer.example");
    expect(text).toContain("CC: cc1@customer.example, cc2@customer.example");
    expect(text).toContain("BCC: hidden@customer.example");
    for (const block of payload.blocks) expect((block.text?.text || "").length).toBeLessThanOrEqual(3000);
  });

  test("recipients are mrkdwn-escaped", async () => {
    const approval = withArtifactBcc(await queuedMailApproval(), ["<!channel>@customer.example"]);
    const bodies = captureFetch(() => Response.json({ ok: true, ts: "1787911800.000002", channel: "C_APPROVALS" }));
    await sendApprovalToSlackChannel(approval, null, channel("slack", { channelId: "C_APPROVALS" }, { botToken: "xoxb-card-test" }));
    const text = JSON.stringify(bodies[0]);
    expect(text).not.toContain("<!channel>");
    expect(text).toContain("&lt;!channel&gt;@customer.example");
  });

  test("non-mail approvals keep the previous Slack card", async () => {
    const approval: ApprovalRequest = {
      id: "apr_card_slack_plain", orgId: DEMO_ORG.id, employeeId: "emp_comm", credentialId: "cred_comm",
      title: "承認依頼: slack.post", purpose: "comm.internal", summary: "社内連絡の下書き", risk: "low", status: "pending",
      tool: "slack.post", jobId: "job_card_plain", revisionNote: null, revisionCount: 0, parentApprovalId: null,
      telegramRef: "c4r6d8p1a2i3", telegramMessageId: null, metadata: {}, statusToken: "st", pollPath: "/x",
      createdAt: new Date().toISOString(), resolvedAt: null, resolvedBy: null,
    };
    const bodies = captureFetch(() => Response.json({ ok: true, ts: "1787911800.000003", channel: "C_APPROVALS" }));
    await sendApprovalToSlackChannel(approval, null, channel("slack", { channelId: "C_APPROVALS" }, { botToken: "xoxb-card-test" }));
    const text = JSON.stringify(bodies[0]);
    expect(text).toContain("社内連絡の下書き");
    expect(text).not.toContain("CC:");
  });
});

describe("LINE (renders approval.summary; lib/notify/line.ts unchanged)", () => {
  test("flex card shows CC / BCC through the summary", async () => {
    const approval = await queuedMailApproval();
    const bodies = captureFetch(() => new Response("{}", { status: 200 }));
    const result = await sendApprovalToLineChannel(
      { ...approval, telegramRef: approval.telegramRef || "l1n2e3r4e5f6" },
      null,
      channel("line", { destinationId: "U_card_test" }, { channelAccessToken: "line-card-test-token" })
    );
    expect(result.ok).toBe(true);
    const text = JSON.stringify(bodies[0]);
    expect(text).toContain("CC: cc1@customer.example, cc2@customer.example");
    expect(text).toContain("BCC: hidden@customer.example");
  });
});

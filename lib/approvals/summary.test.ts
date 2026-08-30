import { describe, expect, test } from "bun:test";
import {
  buildApprovalArtifact,
  buildArtifactLines,
  buildRichApprovalSummary,
} from "@/lib/approvals/summary";
import type { ConversationContext, EgressVerdict } from "@/lib/types";

const internalConfidential: EgressVerdict = {
  decision: "needs_approval",
  audience: "internal",
  effectiveAudience: "internal",
  informationClass: "confidential",
  fidelity: "source",
  namedRecipients: false,
  reason: "internal_confidential_source",
  messageJa: "機密情報の社内開示には上長の承認が必要です。",
};

const slackConversation: ConversationContext = {
  surface: "slack",
  orgId: "org_demo",
  slackChannelId: "C0587BUT3B8",
  threadId: "1787911797.502889",
};

describe("buildArtifactLines", () => {
  test("comm.reply includes channel, thread, full body, class, and audience", () => {
    const lines = buildArtifactLines(
      "comm.reply",
      {
        tool: "comm.reply",
        purpose: "comm.internal",
        jobId: "job-mention",
        conversation: slackConversation,
        args: {
          slackChannelId: "C0587BUT3B8",
          channelName: "cs-mentions",
          text: "お問い合わせありがとうございます。対応します。",
          threadId: "1787911797.502889",
        },
      },
      internalConfidential,
      slackConversation
    );
    const text = lines.join("\n");
    expect(text).toContain("チャネル: C0587BUT3B8（cs-mentions）");
    expect(text).toContain("スレッド: 1787911797.502889");
    expect(text).toContain("本文:");
    expect(text).toContain("お問い合わせありがとうございます。対応します。");
    expect(text).toContain("情報区分: 機密");
    expect(text).toContain("相手先: 社内");
  });

  test("mail.send includes to, subject, and body", () => {
    const lines = buildArtifactLines(
      "mail.send",
      {
        tool: "mail.send",
        purpose: "sales.outreach",
        jobId: "job-mail",
        args: {
          to: "buyer@customer.example",
          subject: "見積フォロー",
          body: "先日の見積のご確認をお願いします。",
        },
      },
      null,
      null
    );
    const text = lines.join("\n");
    expect(text).toContain("宛先: buyer@customer.example");
    expect(text).toContain("件名: 見積フォロー");
    expect(text).toContain("先日の見積のご確認をお願いします。");
  });

  test("calendar.confirm includes datetime, counterpart, title", () => {
    const lines = buildArtifactLines(
      "calendar.confirm",
      {
        tool: "calendar.confirm",
        purpose: "sales.outreach",
        jobId: "job-cal",
        args: {
          datetime: "2026-08-29T10:00:00+09:00",
          counterpart: "山田",
          title: "見積打ち合わせ",
        },
      },
      null,
      null
    );
    expect(lines.join("\n")).toContain("日時: 2026-08-29T10:00:00+09:00");
    expect(lines.join("\n")).toContain("相手: 山田");
    expect(lines.join("\n")).toContain("タイトル: 見積打ち合わせ");
  });

  test("commerce.order includes vendor, amount, and what", () => {
    const artifact = buildApprovalArtifact(
      "commerce.order",
      {
        tool: "commerce.order",
        purpose: "ops.admin",
        jobId: "job-order",
        amountJpy: 4800,
        args: { vendor: "Amazon", what: "A4コピー用紙 5冊" },
      },
      null,
      null
    );
    expect(artifact.vendor).toBe("Amazon");
    expect(artifact.what).toBe("A4コピー用紙 5冊");
    expect(artifact.amountJpy).toBe(4800);
    const text = buildArtifactLines(
      "commerce.order",
      {
        tool: "commerce.order",
        purpose: "ops.admin",
        jobId: "job-order",
        amountJpy: 4800,
        args: { vendor: "Amazon", what: "A4コピー用紙 5冊" },
      },
      null,
      null
    ).join("\n");
    expect(text).toContain("発注先: Amazon");
    expect(text).toContain("内容: A4コピー用紙 5冊");
    expect(text).toContain("¥4,800");
  });

  test("rich summary includes extraLines so dashboard and Telegram share the same card", () => {
    const extraLines = buildArtifactLines(
      "comm.reply",
      {
        tool: "comm.reply",
        purpose: "comm.internal",
        jobId: "job-card",
        args: { text: "返信本文", slackChannelId: "C0587BUT3B8" },
      },
      internalConfidential,
      slackConversation
    );
    const summary = buildRichApprovalSummary({
      tool: "comm.reply",
      purpose: "comm.internal",
      jobId: "job-card",
      employeeDisplayName: "社内連絡AI社員",
      risk: "high",
      extraLines,
    });
    expect(summary).toContain("チャネル: C0587BUT3B8");
    expect(summary).toContain("返信本文");
    expect(summary).toContain("情報区分: 機密");
    expect(summary).toContain("相手先: 社内");
  });
});

describe("sns.publish artifact", () => {
  test("includes 本文, 媒体, 公開予定", () => {
    const lines = buildArtifactLines(
      "sns.publish",
      {
        tool: "sns.publish",
        purpose: "sns.publish",
        jobId: "job-sns",
        args: {
          surface: "x",
          text: "今週のリリースをお知らせします。",
          scheduledAt: "2026-09-01T09:00:00+09:00",
        },
      },
      null,
      null
    );
    const text = lines.join("\n");
    expect(text).toContain("媒体: X");
    expect(text).toContain("公開予定: 2026-09-01T09:00:00+09:00");
    expect(text).toContain("本文:");
    expect(text).toContain("今週のリリースをお知らせします。");
  });
});

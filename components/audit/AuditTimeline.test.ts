import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AuditRowView } from "@/lib/audit/types";
import { AuditTimeline } from "./AuditTimeline";

const row: AuditRowView = {
  id: "aud_1",
  createdAt: "2026-10-16T03:34:00.000Z",
  createdAtJst: "2026-10-16 12:34 JST",
  createdAtJstPrecise: "2026-10-16 12:34:00 JST",
  actor: { kind: "ai", name: "営業AI社員", emailMasked: null, employeeId: "emp_sales" },
  action: { id: "comm.reply", labelJa: "Slackにメッセージを送信" },
  target: { kind: "none", labelJa: "—", rawId: null },
  summary: "チャネルへ返信",
  summaryDetail: "チャネルへ返信",
  approval: {
    needed: null,
    approvalId: "apr_1",
    status: "unknown",
    approverName: null,
    approverEmailMasked: null,
  },
  result: { kind: "success", reasonCode: null, reasonJa: null },
  safeMeta: {
    purpose: "sales.outreach",
    jobId: "job_1",
    risk: null,
    informationClass: null,
    audience: null,
    approvalIdPrefix: "apr_1",
  },
};

describe("AuditTimeline", () => {
  test("list shows Japanese operation and result, never a metadata dump", () => {
    const html = renderToStaticMarkup(createElement(AuditTimeline, { rows: [row] }));
    expect(html).toContain("Slackにメッセージを送信");
    expect(html).toContain("成功");
    expect(html).toContain("営業AI社員");
    expect(html).toContain("2026-10-16 12:34 JST");
    expect(html).not.toContain("<pre");
    expect(html).not.toContain("pollPath");
    expect(html).not.toContain("statusToken");
  });
});

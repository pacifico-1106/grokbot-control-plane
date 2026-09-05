import { describe, expect, test } from "bun:test";
import { evaluateSod, SOD_OPERATOR_RESPONSIBILITY_JA } from "./sod";
import {
  MENTION_REPLY_AUTO,
  MENTION_REPLY_WAIT,
  buildPolicyPreview,
} from "./policy-preview";

describe("buildPolicyPreview", () => {
  test("secretary defaults: auto Slack, no mail send, no confirm, no order", () => {
    const rows = buildPolicyPreview({
      scopes: ["tools:read", "mail:draft", "calendar:propose", "slack:post"],
      allowedPurposes: ["ops.admin", "calendar.propose", "comm.internal"],
      approvalPolicy: "risk_based",
      allowedAccounts: [],
    });
    const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
    expect(byId.slack.label).toBe("メンション返信");
    expect(byId.slack.value).toBe(MENTION_REPLY_AUTO);
    expect(byId.slack.tone).toBe("ok");
    expect(byId.mail.value).toBe("できない");
    expect(byId.calendar.value).toBe("できない");
    expect(byId.order.value).toBe("できない");
    expect(byId.browser.value).toBe("できない");
    expect(byId.external.value).toContain("機密は出さない");
  });

  test("always_human with slack scope waits for mention replies", () => {
    const rows = buildPolicyPreview({
      scopes: ["slack:post"],
      approvalPolicy: "always_human",
    });
    expect(rows.find((row) => row.id === "slack")?.value).toBe(MENTION_REPLY_WAIT);
    expect(rows.find((row) => row.id === "slack")?.tone).toBe("warn");
  });

  test("mail.send + calendar.confirm warn keeps mention replies auto on risk_based", () => {
    const scopes = ["slack:post", "mail:send", "calendar:confirm"] as const;
    expect(evaluateSod([...scopes]).level).toBe("warn");
    const rows = buildPolicyPreview({
      scopes,
      approvalPolicy: "risk_based",
      liveSod: evaluateSod([...scopes]),
    });
    expect(rows.find((row) => row.id === "slack")?.value).toBe(MENTION_REPLY_AUTO);
    expect(rows.find((row) => row.id === "slack")?.tone).toBe("ok");
    expect(rows.find((row) => row.id === "combo")?.value).toBe(SOD_OPERATOR_RESPONSIBILITY_JA);
    expect(rows.find((row) => row.id === "mail")?.value).toBe("必ず人が見る");
    expect(rows.find((row) => row.id === "calendar")?.value).toBe("必ず人が見る");
  });

  test("liveSod force_human does not blanket mention replies when risk_based", () => {
    const forced = buildPolicyPreview({
      scopes: ["slack:post"],
      approvalPolicy: "risk_based",
      liveSod: { level: "force_human", domains: [] },
    });
    expect(forced.find((row) => row.id === "slack")?.value).toBe(MENTION_REPLY_AUTO);
    const human = buildPolicyPreview({
      scopes: ["slack:post"],
      approvalPolicy: "always_human",
      liveSod: { level: "ok", domains: [] },
    });
    expect(human.find((row) => row.id === "slack")?.value).toBe(MENTION_REPLY_WAIT);
    const ok = buildPolicyPreview({
      scopes: ["slack:post"],
      approvalPolicy: "risk_based",
      liveSod: { level: "ok", domains: [] },
    });
    expect(ok.find((row) => row.id === "slack")?.value).toBe(MENTION_REPLY_AUTO);
  });

  test("mail.send / calendar.confirm / commerce.order default to tool-forced", () => {
    const rows = buildPolicyPreview({
      scopes: ["mail:send", "calendar:confirm", "commerce:order"],
      approvalPolicy: "risk_based",
    });
    const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
    expect(byId.mail).toEqual({
      id: "mail",
      label: "メール送信",
      value: "必ず人が見る",
      tone: "danger",
    });
    expect(byId.calendar.value).toBe("必ず人が見る");
    expect(byId.order.value).toBe("必ず人が見る");
    expect(byId.order.tone).toBe("danger");
    expect(byId.combo.value).toContain("責任は事業者");
  });

  test("per-tool risk_based / auto shows on mail, calendar, and order", () => {
    const rows = buildPolicyPreview({
      scopes: ["mail:send", "calendar:confirm", "commerce:order", "slack:post"],
      approvalPolicy: "risk_based",
      toolApprovalDefaults: {
        "mail.send": "risk_based",
        "calendar.confirm": "auto",
        "commerce.order": "auto",
      },
    });
    const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
    expect(byId.mail.value).toBe("危ないときだけ人が見る");
    expect(byId.calendar.value).toBe("自動");
    expect(byId.order.value).toBe("自動");
    expect(byId.slack.value).toBe(MENTION_REPLY_AUTO);
    expect(byId.combo.value).toContain("責任は事業者");
  });

  test("mention reply stays auto under risk_based + slack:post even with money/destructive", () => {
    const scopes = ["slack:post", "commerce:order", "files:write"] as const;
    expect(evaluateSod([...scopes]).level).toBe("warn");
    const rows = buildPolicyPreview({
      scopes,
      approvalPolicy: "risk_based",
      liveSod: evaluateSod([...scopes]),
    });
    expect(rows.find((row) => row.id === "slack")?.value).toBe(MENTION_REPLY_AUTO);
    expect(rows.find((row) => row.id === "combo")?.value).toBe(SOD_OPERATOR_RESPONSIBILITY_JA);
  });

  test("browser without accounts does not run; with accounts warns shared session", () => {
    const none = buildPolicyPreview({
      scopes: ["browser:use"],
      approvalPolicy: "risk_based",
      allowedAccounts: [],
    });
    expect(none.find((row) => row.id === "browser")?.value).toBe(
      "動かない（許可アカウント無し）"
    );
    const some = buildPolicyPreview({
      scopes: ["browser:use"],
      approvalPolicy: "risk_based",
      allowedAccounts: [{ service: "google", accountId: "ops@example.com" }],
    });
    expect(some.find((row) => row.id === "browser")?.value).toBe("共有セッション注意");
    expect(some.find((row) => row.id === "browser")?.tone).toBe("warn");
  });

  test("postingAs bot vs unbound user", () => {
    const bot = buildPolicyPreview({
      scopes: ["slack:post"],
      approvalPolicy: "risk_based",
      postingAs: "bot",
    });
    expect(bot.find((row) => row.id === "postingAs")).toEqual({
      id: "postingAs",
      label: "投稿名義",
      value: "会社のBot（アプリDM向け推奨・窓口一貫・退席非依存）",
      tone: "ok",
    });
    const unbound = buildPolicyPreview({
      scopes: ["slack:post"],
      approvalPolicy: "risk_based",
      postingAs: "user",
      slackLinked: false,
    });
    expect(unbound.find((row) => row.id === "postingAs")?.value).toBe(
      "この社員（未連携・チャネル向け推奨・名義明確・OAuth依存）"
    );
    const linked = buildPolicyPreview({
      scopes: ["slack:post"],
      approvalPolicy: "risk_based",
      postingAs: "user",
      slackLinked: true,
    });
    expect(linked.find((row) => row.id === "postingAs")?.value).toBe(
      "この社員（チャネル向け推奨・名義明確・OAuth依存）"
    );
  });

  test("sns.publish preview is 承認待ち by default", () => {
    const rows = buildPolicyPreview({
      scopes: ["sns:publish"],
      approvalPolicy: "always_human",
    });
    expect(rows.find((row) => row.id === "sns")).toEqual({
      id: "sns",
      label: "SNS投稿",
      value: "承認待ち",
      tone: "warn",
    });
    expect(rows.find((row) => row.id === "mail")?.value).toBe("できない");
  });
});

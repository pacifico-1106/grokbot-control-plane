import { describe, expect, test } from "bun:test";
import { buildPolicyPreview } from "./policy-preview";

describe("buildPolicyPreview", () => {
  test("secretary defaults: auto Slack, no mail send, no confirm, no order", () => {
    const rows = buildPolicyPreview({
      scopes: ["tools:read", "mail:draft", "calendar:propose", "slack:post"],
      allowedPurposes: ["ops.admin", "calendar.propose", "comm.internal"],
      approvalPolicy: "risk_based",
      allowedAccounts: [],
    });
    const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
    expect(byId.slack.value).toBe("自動で出す");
    expect(byId.slack.tone).toBe("ok");
    expect(byId.mail.value).toBe("できない");
    expect(byId.calendar.value).toBe("できない");
    expect(byId.order.value).toBe("できない");
    expect(byId.browser.value).toBe("できない");
    expect(byId.external.value).toContain("機密は出さない");
  });

  test("always_human with slack scope is human-reviewed Slack", () => {
    const rows = buildPolicyPreview({
      scopes: ["slack:post"],
      approvalPolicy: "always_human",
    });
    expect(rows.find((row) => row.id === "slack")?.value).toBe("人が見てから");
  });

  test("mail.send / calendar.confirm / commerce.order are tool-forced", () => {
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
    expect(byId.order.value).toBe("必ず人が見る · お金が動く");
    expect(byId.order.tone).toBe("danger");
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
});

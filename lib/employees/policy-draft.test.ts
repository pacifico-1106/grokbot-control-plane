import { describe, expect, test } from "bun:test";
import { suggestEmployeeApprovalPolicy } from "./approval-presets";
import {
  buildEmployeePolicyDraft,
  jobTextImpliesCommerceOrder,
} from "./policy-draft";

const SECRETARY_JOB =
  "秘書として、メールの下書きと社内Slackの返信、日程の候補を出してほしい。顧客との会議は人が確定する。";

describe("suggestEmployeeApprovalPolicy", () => {
  test("mail.send does not bump employee-level always_human", () => {
    expect(
      suggestEmployeeApprovalPolicy({
        scopes: ["mail:draft", "mail:send"],
      })
    ).toBe("risk_based");
  });

  test("tool-force scopes stay risk_based unless the user asked always_human", () => {
    expect(
      suggestEmployeeApprovalPolicy({
        scopes: ["mail:send", "calendar:confirm", "commerce:order", "browser:use"],
      })
    ).toBe("risk_based");
    expect(
      suggestEmployeeApprovalPolicy({
        scopes: ["mail:send"],
        explicitAlwaysHuman: true,
      })
    ).toBe("always_human");
  });
});

describe("jobTextImpliesCommerceOrder", () => {
  test("generic secretary / bizdev language does not invent commerce.order", () => {
    expect(jobTextImpliesCommerceOrder(SECRETARY_JOB)).toBe(false);
    expect(
      jobTextImpliesCommerceOrder("事業開発として候補の提案と社内連絡をしてほしい")
    ).toBe(false);
    expect(jobTextImpliesCommerceOrder("in order to follow up with a client")).toBe(false);
  });

  test("explicit purchase language still matches", () => {
    expect(jobTextImpliesCommerceOrder("購買で発注まで行う")).toBe(true);
    expect(jobTextImpliesCommerceOrder("消耗品を購入してよい")).toBe(true);
  });
});

describe("buildEmployeePolicyDraft secretary", () => {
  test("Japanese secretary job: drafts, internal Slack, calendar propose; no order/confirm", () => {
    const draft = buildEmployeePolicyDraft(SECRETARY_JOB);
    expect(draft.policy.roleLabel).toBe("秘書");
    expect(draft.policy.scopes).toContain("mail:draft");
    expect(draft.policy.scopes).toContain("slack:post");
    expect(draft.policy.scopes).toContain("calendar:propose");
    expect(draft.policy.scopes).not.toContain("commerce:order");
    expect(draft.policy.scopes).not.toContain("calendar:confirm");
    expect(draft.policy.approvalPolicy).toBe("risk_based");
    expect(draft.policy.allowedPurposes).toContain("comm.internal");
    expect(draft.policy.allowedPurposes).toContain("calendar.propose");
    expect(draft.policy.allowedPurposes.every((p) => !p.includes(":"))).toBe(true);
    expect(draft.policy.allowedPurposes.join(",").includes("mail:")).toBe(false);
    expect(draft.policy.allowedPurposes.join(",").includes("commerce:")).toBe(false);
  });

  test("optional mail.send keeps employee risk_based and still no commerce.order", () => {
    const draft = buildEmployeePolicyDraft(
      "秘書としてメールの下書きと、必要ならメール送信。社内Slackに返信。日程候補の提案。"
    );
    expect(draft.policy.scopes).toContain("mail:send");
    expect(draft.policy.scopes).toContain("mail:draft");
    expect(draft.policy.scopes).not.toContain("commerce:order");
    expect(draft.policy.scopes).not.toContain("calendar:confirm");
    expect(draft.policy.approvalPolicy).toBe("risk_based");
    expect(draft.warnings).toContain("mail_send_requested");
    expect(draft.warnings).not.toContain("always_human_recommended");
    expect(draft.policy.allowedPurposes.every((p) => !p.includes(":"))).toBe(true);
  });

  test("does not dump job text or scopes into purposes", () => {
    const draft = buildEmployeePolicyDraft(
      "いろいろ調べて日程の候補を出したり社内に返信したりする人"
    );
    expect(draft.policy.allowedPurposes).not.toContain(
      "いろいろ調べて日程の候補を出したり社内に返信したりする人"
    );
    for (const purpose of draft.policy.allowedPurposes) {
      expect(purpose.includes(":")).toBe(false);
      expect(purpose.includes(" ")).toBe(false);
    }
  });
});

describe("buildEmployeePolicyDraft neighboring roles", () => {
  test("bizdev does not invent commerce.order", () => {
    const draft = buildEmployeePolicyDraft(
      "事業開発として候補の提案と社内連絡をしてほしい"
    );
    expect(draft.policy.scopes).not.toContain("commerce:order");
    expect(draft.policy.approvalPolicy).toBe("risk_based");
  });

  test("sales quote is not an order", () => {
    const draft = buildEmployeePolicyDraft(
      "営業として見積メールの下書きを作り、送信前に必ず承認してほしい"
    );
    expect(draft.policy.scopes).toContain("commerce:quote");
    expect(draft.policy.scopes).not.toContain("commerce:order");
  });

  test("purchasing still gets commerce.order; explicit always_human stays", () => {
    const draft = buildEmployeePolicyDraft(
      "購買で発注まで行うが、毎回人間の承認が必要"
    );
    expect(draft.policy.scopes).toContain("commerce:order");
    expect(draft.policy.approvalPolicy).toBe("always_human");
  });
});

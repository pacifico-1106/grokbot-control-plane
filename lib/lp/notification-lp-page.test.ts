import { describe, expect, test } from "bun:test";
import { renderNotificationHtml } from "@/lib/lp/notification-outbox";
import { lpPageNoticeLine, lpRefNoticeLine } from "@/lib/lp/lp-page";

/** Outbox emails show the lead page; old entries (no lpPage) render exactly as before; DB values are re-checked. */
const entry = (notificationType: string, payload: Record<string, unknown>) => ({ notificationType, payload }) as never;

describe("renderNotificationHtml lead page row", () => {
  test("inquiry: B row; original row; missing → no row (old entries unchanged)", () => {
    expect(renderNotificationHtml(entry("inquiry_received", { plan: "intern", lpPage: "ai-employee-corp" }))).toContain("/lp/ai-employee-corp");
    expect(renderNotificationHtml(entry("inquiry_received", { plan: "intern", lpPage: "ai-employee" }))).toContain("流入ページ");
    expect(renderNotificationHtml(entry("inquiry_received", { plan: "intern" }))).not.toContain("流入ページ");
  });
  test("handoff: B row (outbox html) and plain-text line (cron Slack / email text)", () => {
    expect(renderNotificationHtml(entry("handoff_created", { summary: "s", lpPage: "ai-employee-corp" }))).toContain("/lp/ai-employee-corp");
    expect(lpPageNoticeLine("ai-employee-corp")).toBe("流入ページ: /lp/ai-employee-corp（Staffpass（AIエージェントの社員証）パターンB）");
    expect(lpPageNoticeLine("ai-employee")).toBe("流入ページ: /lp/ai-employee（AI社員 導入パック）");
    expect(lpPageNoticeLine(undefined)).toBeNull();
    expect(lpPageNoticeLine("<script>")).toBeNull();
  });
  test("ref row: shown when valid, dropped when not", () => {
    expect(renderNotificationHtml(entry("inquiry_received", { plan: "intern", lpPage: "ai-employee-corp", lpRef: "partner_01" }))).toContain("partner_01");
    const bad = renderNotificationHtml(entry("inquiry_received", { plan: "intern", lpPage: "ai-employee-corp", lpRef: "<img src=x>" }));
    expect(bad).not.toContain("img");
    expect(bad).not.toContain("紹介元");
    expect(lpRefNoticeLine("partner_01")).toBe("紹介元(ref): partner_01");
    expect(lpRefNoticeLine("a b")).toBeNull();
  });
  test("inquiry footer: new wording when the 流入ページ row is present; old entries keep the old footer", () => {
    const b = renderNotificationHtml(entry("inquiry_received", { plan: "intern", lpPage: "ai-employee-corp" }));
    expect(b).toContain("LP の相談フォームから送信（流入ページは下記）");
    expect(b).not.toContain("/lp/ai-employee/consult から");
    const old = renderNotificationHtml(entry("inquiry_received", { plan: "intern" }));
    expect(old).toContain("このメールは /lp/ai-employee/consult から自動送信されました。");
    expect(old).not.toContain("流入ページは下記");
  });
  test("a tampered stored value is never echoed", () => {
    const h = renderNotificationHtml(entry("inquiry_received", { plan: "intern", lpPage: "<script>alert(1)</script>" }));
    expect(h).not.toContain("script");
    expect(h).not.toContain("流入ページ");
  });
});

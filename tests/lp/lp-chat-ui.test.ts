import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isSafeLpPath, parseChatCard, readCsrfCookie } from "@/lib/lp/client-session";

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");

describe("LP chat client helpers", () => {
  test("readCsrfCookie finds lp_csrf among other cookies", () => {
    expect(readCsrfCookie("a=1; lp_csrf=abc%3D; b=2")).toBe("abc=");
    expect(readCsrfCookie("lp_csrfx=nope")).toBeNull();
    expect(readCsrfCookie("")).toBeNull();
  });

  test("isSafeLpPath only allows same-site LP paths", () => {
    expect(isSafeLpPath("/lp/ai-employee/checkout?plan=intern")).toBe(true);
    expect(isSafeLpPath("/lp/ai-employee/handoff/confirm?id=x")).toBe(true);
    for (const bad of [
      "https://evil.example/lp/ai-employee/",
      "//evil.example/lp/ai-employee/",
      "/app/settings",
      "/lp/ai-employee/\\evil",
      "javascript:alert(1)",
      "/lp/ai-employee/\nx",
      42,
      null,
    ]) {
      expect(isSafeLpPath(bad)).toBe(false);
    }
  });

  test("parseChatCard drops proposal cards with off-site checkout links", () => {
    expect(
      parseChatCard({ type: "proposal_card", sku: "intern", displayName: "x", checkoutUrl: "https://evil.example" })
    ).toBeNull();
    const ok = parseChatCard({
      type: "proposal_card",
      sku: "intern",
      displayName: "インターン",
      setupAmountExTax: 100000,
      monthlyAmountExTax: 50000,
      checkoutUrl: "/lp/ai-employee/checkout?plan=intern",
      purchaseEnabled: true,
    });
    expect(ok).toEqual({
      type: "proposal_card",
      sku: "intern",
      displayName: "インターン",
      setupAmountExTax: 100000,
      monthlyAmountExTax: 50000,
      checkoutUrl: "/lp/ai-employee/checkout?plan=intern",
      note: undefined,
    });
  });

  test("parseChatCard clamps handoff preview to API limits and ignores unknown types", () => {
    const card = parseChatCard({ type: "handoff_preview", reason: "r".repeat(900), summaryDraft: "s".repeat(5000) });
    expect(card?.type).toBe("handoff_preview");
    if (card?.type === "handoff_preview") {
      expect(card.reason.length).toBe(500);
      expect(card.summaryDraft.length).toBe(2000);
    }
    expect(parseChatCard({ type: "purchase_now" })).toBeNull();
    expect(parseChatCard("x")).toBeNull();
  });
});

describe("LP chat UI is gated by flags", () => {
  test("LP page renders the launcher only behind isLpChatEnabled()", () => {
    const page = read("app/lp/ai-employee/page.tsx");
    expect(page).toMatch(/\{isLpChatEnabled\(\) && \(\s*<ChatLauncher/);
    expect(page.match(/<ChatLauncher/g)?.length).toBe(1);
  });

  test("handoff confirm page 404s when LP_HANDOFF_ENABLED is off and is noindex", () => {
    const page = read("app/lp/ai-employee/handoff/confirm/page.tsx");
    expect(page).toContain("if (!isLpHandoffEnabled()) notFound();");
    expect(page).toContain('export const dynamic = "force-dynamic"');
    expect(page).toMatch(/robots:\s*\{\s*index:\s*false/);
  });

  test("client UI never confirms a handoff or purchase without an explicit button", () => {
    const launcher = read("app/lp/ai-employee/ChatLauncher.tsx");
    // The launcher may only create a pending handoff (POST); confirmation is PUT on the confirm page.
    expect(launcher).not.toMatch(/method:\s*"PUT"/);
    expect(launcher).not.toContain("/api/lp/ai-employee/checkout");
    expect(launcher).not.toContain("dangerouslySetInnerHTML");
    const confirm = read("app/lp/ai-employee/handoff/confirm/HandoffConfirmClient.tsx");
    expect(confirm).not.toContain("dangerouslySetInnerHTML");
    expect(confirm).toContain("[LP_CSRF_HEADER]: token");
  });
});

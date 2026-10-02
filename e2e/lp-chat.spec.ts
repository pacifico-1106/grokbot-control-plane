import { test, expect } from "@playwright/test";

/**
 * LP chat (PR-1d) with default flags (LP_CHAT_ENABLED / LP_HANDOFF_ENABLED OFF).
 * Proves the feature is invisible and its endpoints are closed until GO.
 *
 * Set E2E_LP_CHAT_ON=1 against a preview with the flags ON to run the
 * consent-step check instead.
 */
const flagsOn = process.env.E2E_LP_CHAT_ON === "1";

test.describe("LP chat flags OFF", () => {
  test.skip(flagsOn, "flags are ON in this environment");

  test("LP renders without the chat launcher", async ({ page }) => {
    const res = await page.goto("/lp/ai-employee");
    expect(res?.ok()).toBeTruthy();
    await expect(page.getByTestId("lp-chat-launcher")).toHaveCount(0);
  });

  test("handoff confirm page is 404", async ({ page }) => {
    const res = await page.goto("/lp/ai-employee/handoff/confirm?id=00000000-0000-0000-0000-000000000000");
    expect(res?.status()).toBe(404);
  });

  test("chat and handoff APIs are closed", async ({ request }) => {
    const journey = await request.post("/api/journeys", {
      data: { aiDisclosureAccepted: true, privacyVersion: "2026-09" },
    });
    expect(journey.status()).toBe(503);
    const turn = await request.post("/api/chat/turn", { data: { text: "hi" } });
    expect(turn.status()).toBe(503);
    const handoff = await request.get("/api/lp/handoff?id=00000000-0000-0000-0000-000000000000");
    expect(handoff.status()).toBe(404);
  });
});

test.describe("LP chat flags ON", () => {
  test.skip(!flagsOn, "set E2E_LP_CHAT_ON=1 against a flag-ON preview");

  test("launcher opens to the AI disclosure / consent step", async ({ page }) => {
    await page.goto("/lp/ai-employee");
    await page.getByTestId("lp-chat-launcher").click();
    const panel = page.getByTestId("lp-chat-panel");
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("応答するのはAIです");
    await expect(page.getByTestId("lp-chat-consent").getByRole("button", { name: "相談をはじめる" })).toBeDisabled();
  });

  test("confirm page without a session shows not-found message", async ({ page }) => {
    await page.goto("/lp/ai-employee/handoff/confirm?id=00000000-0000-0000-0000-000000000000");
    await expect(page.getByTestId("handoff-missing")).toBeVisible();
  });
});

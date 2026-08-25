import { test, expect } from "@playwright/test";

/**
 * DEMO-mode smoke: no real Supabase/Stripe/Resend keys required.
 * Middleware pass-through when placeholders / missing env → /app routes load.
 */
test.describe("DEMO smoke", () => {
  test("landing `/` loads", async ({ page }) => {
    const res = await page.goto("/");
    expect(res?.ok()).toBeTruthy();
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      "AIを、社員として雇う"
    );
  });

  test("`/login` loads (DEMO pass-through)", async ({ page }) => {
    const res = await page.goto("/login");
    expect(res?.ok()).toBeTruthy();
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      "AI社員"
    );
    await expect(page.getByText("デモモード", { exact: false })).toBeVisible();
  });

  test("`/app` dashboard loads", async ({ page }) => {
    const res = await page.goto("/app");
    expect(res?.ok()).toBeTruthy();
    await expect(page).toHaveURL(/\/app\/?$/);
  });

  test("`/app/employees/new` hire flow shell loads", async ({ page }) => {
    const res = await page.goto("/app/employees/new");
    expect(res?.ok()).toBeTruthy();
    await expect(page).toHaveURL(/\/app\/employees\/new/);
    await expect(
      page.getByRole("heading", { name: "AI社員を雇う" })
    ).toBeVisible();
  });

  test("`/docs/mcp` public MCP setup loads", async ({ page }) => {
    const res = await page.goto("/docs/mcp");
    expect(res?.ok()).toBeTruthy();
    await expect(
      page.getByRole("heading", { name: "Grok Bot とつなぐ（MCP）" })
    ).toBeVisible();
    await expect(page.getByText("https://staffpass.sealith.com/api/mcp")).toBeVisible();
    await expect(page.getByRole("heading", { name: "持ち込みGrok" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "運用代行" })).toBeVisible();
  });

  test("`/app/integrations` shows MCP setup", async ({ page }) => {
    const res = await page.goto("/app/integrations");
    expect(res?.ok()).toBeTruthy();
    await expect(page.getByText("https://staffpass.sealith.com/api/mcp")).toBeVisible();
    await expect(page.getByText("持ち込みGrok")).toBeVisible();
  });
});

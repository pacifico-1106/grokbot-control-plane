import { test, expect, type Page } from "@playwright/test";

/**
 * Pattern B floating video → large dialog (八坂さん 10/12 02:31).
 * Open, close by ✕ / backdrop / Esc, focus return, scroll lock, focus trap; A unchanged.
 */
async function openFromPromo(page: Page) {
  await page.goto("/lp/ai-employee-corp");
  const trigger = page.getByTestId("lp-video-expand");
  await expect(trigger).toBeVisible();
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "StaffPass MV" });
  await expect(dialog).toBeVisible();
  return { trigger, dialog };
}

for (const vp of [{ name: "pc", width: 1440, height: 900 }, { name: "mobile", width: 390, height: 844 }]) {
  test.describe(`B video modal (${vp.name})`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test("opens with autoplay iframe, locks scroll, traps focus", async ({ page }) => {
      const { dialog } = await openFromPromo(page);
      await expect(dialog).toHaveAttribute("aria-modal", "true");
      const iframe = dialog.locator("iframe");
      await expect(iframe).toHaveAttribute("src", /youtube-nocookie\.com\/embed\/UFKh_CK9uxw\?autoplay=1/);
      await expect(iframe).toHaveAttribute("allow", "autoplay; encrypted-media; picture-in-picture; fullscreen");
      expect(await page.evaluate(() => getComputedStyle(document.body).overflow)).toBe("hidden");
      const box = await iframe.boundingBox();
      expect(box).not.toBeNull();
      expect(Math.abs(box!.width / box!.height - 16 / 9)).toBeLessThan(0.02);
      if (vp.name === "mobile") expect(box!.width).toBeGreaterThan(vp.width - 40);
      else expect(box!.width).toBeLessThanOrEqual(1100);
      await expect(page.getByRole("button", { name: "動画を閉じる" })).toBeFocused();
      for (let i = 0; i < 4; i++) {
        await page.keyboard.press("Tab");
        expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true);
        await page.keyboard.press("Shift+Tab");
        expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true);
      }
    });

    for (const how of ["close-button", "backdrop", "escape"] as const) {
      test(`closes by ${how}, stops the video, returns focus and the small player`, async ({ page }) => {
        const { trigger, dialog } = await openFromPromo(page);
        if (how === "close-button") await page.getByRole("button", { name: "動画を閉じる" }).click();
        if (how === "backdrop") await page.getByTestId("lp-video-modal-backdrop").click({ position: { x: 5, y: 5 } });
        if (how === "escape") await page.keyboard.press("Escape");
        await expect(dialog).toHaveCount(0);
        await expect(page.locator('iframe[src*="UFKh_CK9uxw"]')).toHaveCount(0);
        await expect(trigger).toBeVisible();
        await expect(trigger).toBeFocused();
        expect(await page.evaluate(() => getComputedStyle(document.body).overflow)).not.toBe("hidden");
      });
    }

    test("a click inside the video area does not close it", async ({ page }) => {
      const { dialog } = await openFromPromo(page);
      await dialog.getByText("StaffPass MV").click();
      await expect(dialog).toBeVisible();
    });
  });
}

test("A: no modal trigger, inline player unchanged", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/lp/ai-employee");
  await expect(page.locator('iframe[src="https://www.youtube-nocookie.com/embed/l4fVZ1-VRcU?rel=0"]')).toBeVisible();
  await expect(page.getByTestId("lp-video-expand")).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

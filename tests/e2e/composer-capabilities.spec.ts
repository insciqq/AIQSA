import { expect, test } from "@playwright/test";

for (const theme of ["light", "dark"]) {
  test(`composer capabilities wrap with reachable controls · ${theme}`, async ({ page, context }) => {
    test.setTimeout(120_000);
    await context.addCookies([{ name: "aiqsa.theme", value: theme, url: "http://127.0.0.1:3000" }]);
    await page.goto("/ui-v2-fixture?fixture=composer&state=capabilities");
    await page.getByRole("textbox", { name: "Message" }).fill("Preserve this draft");
    for (const width of [320, 360, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: width === 768 ? 430 : 900 });
      const chips = page.getByLabel("Active capabilities");
      await expect(chips).toBeVisible();
      await expect.poll(() => chips.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return element.scrollWidth <= element.clientWidth + 1 && [...element.children].every((child) => {
          const rect = child.getBoundingClientRect();
          return rect.left >= box.left - 1 && rect.right <= box.right + 1;
        });
      })).toBe(true);
      await expect(page.getByRole("button", { name: "Change Skills mode" })).toHaveAccessibleDescription(/Skills: Auto · 3 pinned \(always loaded\)/);
      await expect(page.getByRole("button", { name: "Add", exact: true })).toBeInViewport();
      await expect(page.getByRole("button", { name: "Send message" })).toBeInViewport();
      // Workspace is ambient (2026-10-20): no chip, menu or toggle.
      await expect(chips.getByRole("button", { name: /Workspace/ })).toHaveCount(0);
      const mcp = page.getByRole("button", { name: "Change MCP mode" });
      await mcp.click();
      const details = page.getByRole("menu", { name: "MCP tools" });
      await expect(details).toBeInViewport();
      await page.keyboard.press("Escape");
      await expect(mcp).toBeFocused();
      await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue("Preserve this draft");
    }
    // Actual composer width, independent of a wide desktop viewport and at enlarged text.
    await page.addStyleTag({ content: ".v2-composer-wrap { width: 340px; } html { font-size: 32px; }" });
    await expect.poll(() => page.getByLabel("Active capabilities").evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await expect(page.getByRole("button", { name: "Change Skills mode" })).toBeInViewport();
  });
}

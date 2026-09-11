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
      await expect(page.getByRole("button", { name: "Manage selected Skills" })).toHaveText("Skills: 3");
      await expect(page.getByRole("button", { name: "Add", exact: true })).toBeInViewport();
      await expect(page.getByRole("button", { name: "Send message" })).toBeInViewport();
      const workspace = page.getByRole("button", { name: /Workspace details/ });
      await workspace.click();
      const details = page.getByRole("menu", { name: "Workspace" });
      await expect(details).toBeInViewport();
      await expect(details).toContainText("Workspace ready");
      await expect(details).toContainText("Internet: Off");
      await expect(details.getByRole("menuitemcheckbox", { name: /Turn off Workspace/ })).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(workspace).toBeFocused();
      await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue("Preserve this draft");
    }
    // Actual composer width, independent of a wide desktop viewport and at enlarged text.
    await page.addStyleTag({ content: ".v2-composer-wrap { width: 340px; } html { font-size: 32px; }" });
    await expect.poll(() => page.getByLabel("Active capabilities").evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await expect(page.getByRole("button", { name: "Manage selected Skills" })).toBeInViewport();
  });
}

test("Workspace running and failed states remain visible from the closed chip on touch", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: "http://127.0.0.1:3000", viewport: { width: 360, height: 740 }, hasTouch: true });
  const page = await context.newPage();
  try {
    for (const state of ["workspace-running", "workspace-failed"]) {
      await page.goto(`/ui-v2-fixture?fixture=composer&state=${state}`);
      const chip = page.getByRole("button", { name: /Workspace details/ });
      await expect(chip).toContainText(state === "workspace-running" ? "Running" : "Unavailable");
      await expect(chip.locator(".v2-composer-workspace-signal")).toBeVisible();
      const box = await chip.boundingBox();
      expect(box?.height).toBeGreaterThanOrEqual(44);
      expect(box?.width).toBeGreaterThanOrEqual(44);
    }
  } finally { await context.close(); }
});

import { expect, test } from "@playwright/test";
import { matrixCatalog } from "./shell/catalog";
import { installMatrixCatalogFixture } from "./shell/catalogFixture";
import { expectNoHorizontalOverflow } from "./support/layoutAssertions";
import { signInWithLocalToken } from "./support/localAuth";

for (const viewport of [
  { width: 1440, height: 900, touch: false },
  { width: 820, height: 1180, touch: true },
  { width: 1180, height: 820, touch: true },
  { width: 390, height: 844, touch: true },
  { width: 844, height: 390, touch: true }
]) {
  test.describe(`Agent control at ${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport, hasTouch: viewport.touch });
    for (const theme of ["light", "dark"] as const) {
      test(`toggles directly and keeps details accessible in ${theme}`, async ({ page, context }, testInfo) => {
        await context.addCookies([{ name: "aiqsa.theme", value: theme, url: testInfo.project.use.baseURL! }]);
        const catalog = {
          ...matrixCatalog,
          defaults: { ...matrixCatalog.defaults, workspaceEnabled: true },
          models: matrixCatalog.models.map((model) => ({ ...model, agentAvailable: true }))
        };
        await installMatrixCatalogFixture(page, { folders: [], chats: [] }, { catalog });
        await page.route("**/api/workspace", (route) => route.fulfill({ json: { workspace: {
          available: true, agentAvailable: true, enabled: true, internetEnabled: true, sessionState: null
        } } }));
        await page.route("**/api/me/mcp", (route) => route.fulfill({ json: { servers: [] } }));
        // Geometry checks cannot dispatch a paid run if an interaction regresses.
        await page.route("**/api/chats/*/messages", (route) => route.request().method() === "POST"
          ? route.fulfill({ status: 409, json: { error: "unexpected_agent_toggle_run" } }) : route.fallback());
        await signInWithLocalToken(page);
        const draft = page.getByRole("textbox", { name: "Message" });
        const toggle = page.getByRole("button", { name: "Agent", exact: true });
        const details = page.getByRole("button", { name: "Agent details", exact: true });
        await draft.fill("Inspect the project and prepare a short report.");
        await expect(toggle).toHaveAttribute("aria-pressed", "false");
        await expect(toggle).toBeEnabled();
        await toggle.click();
        await expect(toggle).toHaveAttribute("aria-pressed", "true");
        await expect(page.getByRole("menu", { name: "Agent", exact: true })).toHaveCount(0);
        await expect(draft).toHaveValue("Inspect the project and prepare a short report.");
        await expect(toggle).toBeInViewport();
        await expect(details).toBeInViewport();
        if (viewport.touch) {
          for (const control of [toggle, details]) {
            const box = await control.boundingBox();
            expect(box!.width).toBeGreaterThanOrEqual(44);
            expect(box!.height).toBeGreaterThanOrEqual(44);
          }
        }
        await expectNoHorizontalOverflow(page);
        await page.screenshot({ path: testInfo.outputPath("agent-on.png") });
        await toggle.focus();
        await page.keyboard.press("Space");
        await expect(toggle).toHaveAttribute("aria-pressed", "false");
        await page.keyboard.press("Tab");
        await expect(details).toBeFocused();
        await page.keyboard.press("Enter");
        const menu = page.getByRole("menu", { name: "Agent", exact: true });
        await expect(menu).toBeVisible();
        await expect(menu).toContainText("Uses the selected model, Skills, MCP mode");
        await page.screenshot({ path: testInfo.outputPath("agent-details.png") });
        await page.keyboard.press("Escape");
        await expect(menu).toHaveCount(0);
        await expect(details).toBeFocused();
        await expect(draft).toHaveValue("Inspect the project and prepare a short report.");
        await expect(toggle).toHaveAttribute("aria-pressed", "false");
        await expectNoHorizontalOverflow(page);
      });
    }
  });
}

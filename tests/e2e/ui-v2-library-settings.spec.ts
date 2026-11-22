import { expect, test, type BrowserContext } from "@playwright/test";
import { authenticateWithLocalToken } from "./support/localAuth";

const modes = [
  { height: 900, name: "desktop", width: 1440 },
  { height: 844, name: "mobile", width: 390 }
] as const;

async function setTheme(
  context: BrowserContext,
  theme: "dark" | "light"
) {
  await context.addCookies([{
    name: "aiqsa.theme",
    value: theme,
    url: "http://127.0.0.1:3000"
  }]);
}

test("Library tab state is keyboard-owned and dirty resource exit remains explicit", async ({ page }) => {
  await page.goto("/ui-v2-fixture?fixture=library&state=dirty");
  const assistants = page.getByRole("tab", { name: "Assistants" });
  await assistants.press("End");
  const confirmation = page.getByRole("alertdialog", { name: "Unsaved Assistant draft" });
  await expect(confirmation).toBeVisible();
  await expect(assistants).toHaveAttribute("aria-selected", "true");
  await confirmation.getByRole("button", { name: "Keep editing" }).click();
  await expect(assistants).toBeFocused();

  await assistants.press("End");
  await confirmation.getByRole("button", { name: "Discard changes" }).click();
  await expect(page.getByRole("tab", { name: "Files" })).toHaveAttribute("aria-selected", "true");
});

test("Files keep one privacy disclosure and a reachable mobile row menu", async ({ page }) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto("/ui-v2-fixture?fixture=library&state=files");

  const panel = page.getByTestId("library-files-panel");
  await expect(panel.getByText(/Files are private and visible only to you\./)).toBeVisible();
  await expect(panel.getByText("Upload · Private")).toHaveCount(0);
  const more = panel.getByRole("button", { name: "More actions for sales_q3.csv" });
  const moreBox = await more.boundingBox();
  expect(moreBox?.height).toBeGreaterThanOrEqual(44);
  expect(moreBox?.width).toBeGreaterThanOrEqual(44);
  await more.click();
  await page.getByRole("menuitem", { name: "Open in chat" }).click();
  await expect(page.getByText("The chat is open again.")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

for (const theme of ["dark", "light"] as const) {
  for (const mode of modes) {
    test(`Skills is an inline Library section · ${theme} · ${mode.name}`, async ({ context, page }) => {
      await setTheme(context, theme);
      await page.setViewportSize(mode);
      await page.route("**/api/me/skills**", async (route) => {
        await route.fulfill({
          contentType: "application/json",
          json: {
            nextCursor: null,
            publishableWorkspaces: [],
            skills: [{
              archived: false,
              description: "Checks every factual claim before the answer is sent.",
              id: "careful-editor",
              instructionCharacterCount: 42,
              instructionApproxTokens: 11,
              name: "Careful editor",
              owned: true,
              ownerDisplayName: "You",
              scope: { kind: "owner" },
              updatedAt: "2026-09-03T10:00:00.000Z",
              version: 1
            }],
            viewer: { canPublishInstallation: false }
          }
        });
      });

      await page.goto("/ui-v2-fixture?fixture=library&state=skills");

      await expect(page.getByTestId("skill-library-section")).toBeVisible();
      await expect(page.getByRole("dialog", { name: "Skills" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Open Careful editor" })).toBeVisible();
      await page.getByRole("button", { name: "Always use Careful editor" }).click();
      const selection = page.getByRole("region", { name: "Selected Skills" });
      await expect(selection).toContainText("1 always included · ≈11 instruction tokens");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    });
  }
}

test("Settings is a page without a modal layer, has a three-value theme registry, and owns Account discard", async ({ page }) => {
  await page.goto("/ui-v2-fixture?fixture=settings&state=dirty");
  const settings = page.getByTestId("library-v2");
  await expect(settings.getByTestId("settings-account-panel")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await settings.getByRole("tab", { name: "General", exact: true }).click();
  const confirmation = page.getByRole("dialog", { name: "Unsaved account changes" });
  await expect(confirmation).toBeVisible();
  // The confirmation isolates the page beneath it, where Account is still the selected section.
  await expect(settings.getByRole("tab", { name: "Account", exact: true, includeHidden: true }))
    .toHaveAttribute("aria-selected", "true");
  await confirmation.getByRole("button", { name: "Confirm discard changes" }).click();
  await expect(confirmation).toHaveCount(0);
  await expect(settings.getByRole("tab", { name: "General", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("radio")).toHaveCount(3);
  await expect(page.getByRole("radio", { name: /System theme/ })).toBeVisible();
  await expect(page.getByRole("radio", { name: /Light theme/ })).toBeVisible();
  await expect(page.getByRole("radio", { name: /Dark theme/ })).toBeVisible();
});

for (const theme of ["dark", "light"] as const) {
  for (const mode of modes) {
    test(`Control Center theme parity · ${theme} · ${mode.name}`, async ({ context, page }) => {
      await setTheme(context, theme);
      await page.setViewportSize(mode);
      await authenticateWithLocalToken(page.request, "The Control Center parity case needs the disposable local admin session.");
      await page.goto("/admin");
      const root = page.locator("main");
      await expect(root).toBeVisible();
      await expect(page.getByRole("heading", { name: "Overview", level: 1 })).toBeVisible();
      const colors = await root.evaluate((element) => {
        const toSrgbBytes = (color: string) => {
          const canvas = document.createElement("canvas");
          canvas.width = 1;
          canvas.height = 1;
          const context = canvas.getContext("2d", { willReadFrequently: true });
          if (!context) return null;
          context.fillStyle = color;
          context.fillRect(0, 0, 1, 1);
          return Array.from(context.getImageData(0, 0, 1, 1).data.slice(0, 3));
        };
        const style = getComputedStyle(element);
        const rootStyle = getComputedStyle(document.documentElement);
        return {
          background: toSrgbBytes(style.backgroundColor),
          expected: toSrgbBytes(rootStyle.backgroundColor),
          theme: document.documentElement.dataset.theme
        };
      });
      expect(colors.theme).toBe(theme);
      expect(colors.background).toStrictEqual(colors.expected);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    });
  }
}

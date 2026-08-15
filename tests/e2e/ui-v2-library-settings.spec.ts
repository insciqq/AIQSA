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
  await expect(page.getByRole("tab", { name: "Memory" })).toHaveAttribute("aria-selected", "true");
});

test("administrator-disabled Memory preserves exact-fact management", async ({ page }) => {
  await page.goto("/ui-v2-fixture?fixture=library&state=memory-disabled");
  await expect(page.getByText("Memory is disabled by the administrator")).toBeVisible();
  for (const control of await page.getByRole("switch").all()) await expect(control).toBeDisabled();
  await expect(page.getByRole("button", { name: "Manage memories" })).toBeEnabled();
  await expect(page.getByRole("button", { name: /Forget:/ }).first()).toBeEnabled();
  expect((await page.locator("body").innerText()).toLocaleLowerCase()).not.toContain("temperature");
  expect((await page.locator("body").innerText()).toLocaleLowerCase()).not.toContain("profile");
});

test("Settings has one modal layer, a three-value theme registry, and MCP discard ownership", async ({ page }) => {
  await page.goto("/ui-v2-fixture?fixture=settings&state=dirty");
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
  await page.getByRole("button", { name: "Appearance" }).click();
  const confirmation = page.getByRole("alertdialog", { name: "Unsaved MCP changes" });
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole("button", { name: "Discard changes" }).click();
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
      await expect(page.getByRole("heading", { name: "Control Center" })).toBeVisible();
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

import { expect, test, type BrowserContext } from "@playwright/test";
import { memoryConsumerSettingsFixture } from "../support/memoryFixtures";
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
  await expect(page.getByRole("tab", { name: "Skill library" })).toHaveAttribute("aria-selected", "true");
});

test("Files keep one privacy disclosure and a reachable mobile row menu", async ({ page }) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto("/ui-v2-fixture?fixture=library&state=files");

  const panel = page.getByTestId("library-files-panel");
  await expect(panel.getByText("Files are private and visible only to you.")).toBeVisible();
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
      await page.getByRole("button", { name: "Use Careful editor" }).click();
      await expect(page.getByText(/1 selected · up to 8/)).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    });
  }
}

test("administrator-disabled Memory preserves its exact-fact management entry point", async ({ page }) => {
  await page.goto("/ui-v2-fixture?fixture=library&state=memory-disabled");
  await expect(page.locator(".v2-memory-state")).toHaveText("Memory needs administrator setup");
  for (const control of await page.getByRole("switch").all()) await expect(control).toBeDisabled();
  await expect(page.getByRole("button", { name: "Add memory" })).toBeEnabled();
  await expect(page.getByText("Works as a platform engineer on the ingest team.")).toBeVisible();
  await expect(page.getByRole("button", { name: /Memory actions: Works as/ })).toBeEnabled();
  expect((await page.locator("body").innerText()).toLocaleLowerCase()).not.toContain("temperature");
  expect((await page.locator("body").innerText()).toLocaleLowerCase()).not.toContain("profile");
});

for (const theme of ["dark", "light"] as const) {
  for (const mode of modes) {
    test(`Memory owns direct row CRUD and bounded layout · ${theme} · ${mode.name}`, async ({ context, page }) => {
      await setTheme(context, theme);
      await page.setViewportSize(mode);
      await page.goto("/ui-v2-fixture?fixture=library&state=memory");

      const panel = page.getByTestId("library-memory-panel");
      await expect(panel.getByText("Works as a platform engineer on the ingest team.")).toBeVisible();
      const longToggle = panel.getByRole("button", { name: "Show all 375 characters" });
      await expect(longToggle).toHaveAttribute("aria-expanded", "false");
      await longToggle.click();
      await expect(panel.getByRole("button", { name: "Show less" })).toHaveAttribute("aria-expanded", "true");

      await panel.getByRole("button", { name: /Memory actions: Works as a platform engineer/ }).click();
      await panel.getByRole("menuitem", { name: "Edit" }).click();
      const editor = panel.getByRole("textbox", { name: /Edit Works as a platform engineer/ });
      await expect(editor).toBeFocused();
      await editor.fill("Works as a platform engineer on the reliability team.");
      await panel.getByRole("button", { name: "Save", exact: true }).click();
      await expect(panel.getByText("Works as a platform engineer on the reliability team.")).toBeVisible();

      await panel.getByRole("button", { name: /Memory actions: Works as a platform engineer on the reliability team/ }).click();
      await panel.getByRole("menuitem", { name: "Forget" }).click();
      const confirmation = panel.getByRole("group", { name: /Forget Works as a platform engineer/ });
      await expect(confirmation).toContainText("This cannot be undone.");
      await confirmation.getByRole("button", { name: "Forget" }).click();
      await expect(panel.getByText("Works as a platform engineer on the reliability team.")).toHaveCount(0);

      await panel.getByRole("button", { name: "Add memory" }).click();
      const newMemory = panel.getByRole("textbox", { name: "New memory" });
      await expect(newMemory).toBeFocused();
      await newMemory.fill("Needs evidence-backed release notes.");
      await panel.getByRole("button", { name: "Save memory" }).click();
      await expect(panel.getByText("Needs evidence-backed release notes.")).toBeVisible();

      if (mode.name === "mobile") {
        const addBox = await panel.getByRole("button", { name: "Add memory" }).boundingBox();
        const settingsBox = await panel.getByRole("button", { name: "Memory settings" }).boundingBox();
        const searchBox = await panel.getByRole("searchbox", { name: "Search memories" }).boundingBox();
        expect(addBox?.height).toBeGreaterThanOrEqual(44);
        expect(settingsBox?.height).toBeGreaterThanOrEqual(44);
        expect(searchBox?.height).toBeGreaterThanOrEqual(40);
        expect((addBox?.width ?? 0) > (settingsBox?.width ?? 0) * 4).toBe(true);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    });
  }
}

for (const theme of ["dark", "light"] as const) {
  for (const mode of modes) {
    test(`Memory settings owns five controls and confirmed reset · ${theme} · ${mode.name}`, async ({ context, page }) => {
      let resetRequests = 0;
      await setTheme(context, theme);
      await page.setViewportSize(mode);
      await page.route("**/api/me/memory/settings", async (route) => {
        await route.fulfill({
          contentType: "application/json",
          json: memoryConsumerSettingsFixture({
            settings: {
              decayEnabled: true,
              learnAutomatically: true,
              referenceChatHistory: true,
              synthesisEnabled: true,
              useMemoryFacts: true
            },
            status: "ON"
          })
        });
      });
      await page.route("**/api/me/memory/reset", async (route) => {
        resetRequests += 1;
        await route.fulfill({ contentType: "application/json", json: { status: "COMPLETE" } });
      });
      await page.goto("/ui-v2-fixture?fixture=settings&state=memory");

      const settings = page.getByRole("dialog", { name: "Settings" });
      await expect(settings.getByTestId("settings-memory-status")).toContainText("Memory is on");
      await expect(settings.getByRole("switch")).toHaveCount(5);
      await expect(settings.getByRole("button", { name: "Pause" })).toHaveCount(0);
      await expect(settings.getByRole("button", { name: "Open in Library" })).toBeEnabled();

      await settings.getByRole("button", { name: "Forget everything…" }).click();
      let confirmation = page.getByRole("alertdialog", { name: "Forget everything?" });
      await expect(confirmation.getByRole("button", { name: "Keep my memories" })).toBeFocused();
      await confirmation.press("Escape");
      await expect(confirmation).toHaveCount(0);
      await expect(settings.getByRole("button", { name: "Forget everything…" })).toBeFocused();

      await settings.getByRole("button", { name: "Forget everything…" }).click();
      confirmation = page.getByRole("alertdialog", { name: "Forget everything?" });
      await confirmation.getByRole("button", { name: "Forget everything" }).click();
      await expect.poll(() => resetRequests).toBe(1);
      await expect(settings.getByText("Personal Memory was reset.")).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    });
  }
}

test("Settings has one modal layer, a three-value theme registry, and MCP discard ownership", async ({ page }) => {
  await page.goto("/ui-v2-fixture?fixture=settings&state=dirty");
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
  await page.getByRole("button", { name: "General" }).click();
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

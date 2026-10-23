import { randomUUID } from "node:crypto";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { chooseSearchStrategy } from "./shell/composer";
import { deleteOwnedChatPermanently } from "./support/chatCleanup";
import { expectNoHorizontalOverflow } from "./support/layoutAssertions";
import { signInWithLocalToken } from "./support/localAuth";
import { activeChatId, selectFakeModel, sendAndExpect } from "./support/workspace";

/*
 * Projects and Knowledge are removed (operator decisions 2026-10-22 and
 * 2026-10-23); native Anthropic stays. An old Project address opens the new
 * chat without revealing anything, no surface offers either area, and an
 * ordinary chat still sends. Screenshots are viewport shots.
 */

test.setTimeout(120_000);
test.use({ trace: "off" });

const DESKTOP = { height: 900, width: 1440 } as const;
const PHONE_PORTRAIT = { height: 844, width: 390 } as const;

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const size = page.viewportSize();
  await page.screenshot({
    animations: "disabled",
    path: testInfo.outputPath(`${name}-${size?.width ?? 0}x${size?.height ?? 0}.png`)
  });
}

/** Neither the rail nor the drawer offers Projects; Studio stays as the positive control. */
async function expectNoProjectsDestination(page: Page): Promise<void> {
  const rail = page.getByRole("navigation", { name: "Workspace", exact: true });
  if (await rail.isVisible()) {
    await expect(rail.getByRole("button", { name: "Studio", exact: true })).toBeVisible();
    await expect(rail.getByRole("button", { name: "Projects", exact: true })).toHaveCount(0);
  } else {
    const drawer = page.getByRole("complementary", { name: "Chat navigation" });
    if (!(await drawer.isVisible())) await page.getByRole("button", { name: "Open sidebar" }).click();
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole("button", { name: "Studio", exact: true })).toBeVisible();
    await expect(drawer.getByRole("button", { name: "Projects", exact: true })).toHaveCount(0);
    await expect(async () => {
      if (await drawer.isVisible()) await page.keyboard.press("Escape");
      await expect(drawer).toBeHidden({ timeout: 1_000 });
    }).toPass({ timeout: 10_000 });
  }
  await expect(page.getByRole("button", { name: "Projects", exact: true })).toHaveCount(0);
}

/** An old Project chat address lands on the new chat with a working composer. */
async function expectOldProjectAddressOpensNewChat(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await signInWithLocalToken(page);
  await page.goto(`/p/project-${randomUUID()}/c/chat-${randomUUID()}`);
  await expect(page).toHaveURL((url) => url.pathname === "/");
  await expect(page.getByTestId("app-shell")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("textbox", { exact: true, name: "Message" })).toBeVisible();
  await expect(page.getByTestId("conversation-thread")).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
  await shot(page, testInfo, name);
}

/** The new chat's composer offers no Knowledge: no chip, no Add menu row, no `/` command. */
async function expectComposerWithoutKnowledge(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const composer = page.getByTestId("composer-v2");
  const field = composer.getByLabel("Message", { exact: true });
  await expect(field).toBeVisible({ timeout: 30_000 });
  await expect(composer.getByRole("button", { name: "Choose Knowledge" })).toHaveCount(0);

  const add = composer.getByRole("button", { name: "Add", exact: true });
  await add.click();
  const addMenu = page.locator('.v2-composer-layer[data-kind="add"]');
  await expect(addMenu.getByRole("menuitem", { name: /^Attach files/u })).toBeVisible();
  await expect(addMenu).not.toContainText(/Knowledge/u);
  await expectNoHorizontalOverflow(page);
  await shot(page, testInfo, name);
  await page.keyboard.press("Escape");
  await expect(addMenu).toHaveCount(0);

  const palette = page.getByRole("listbox", { name: "Commands" });
  await field.focus();
  await page.keyboard.type("/");
  await expect(palette).toBeVisible();
  await expect(palette.getByRole("option", { name: /^Attach files/u })).toBeVisible();
  await page.keyboard.type("knowledge");
  await expect(field).toHaveValue("/knowledge");
  await expect(page.getByRole("option", { name: /Knowledge/u })).toHaveCount(0);
  await field.fill("");
  await page.keyboard.press("Escape");
  await expect(palette).toBeHidden();
}

test.describe("desktop", () => {
  test.use({ viewport: DESKTOP });

  test("an old Project chat address opens the new chat", async ({ page }, testInfo) => {
    await expectOldProjectAddressOpensNewChat(page, testInfo, "old-project-address-desktop");
  });

  test("the new chat offers no Projects or Knowledge and still sends an answer", async ({ page }, testInfo) => {
    let chatId: string | null = null;
    try {
      await signInWithLocalToken(page);
      await expectNoProjectsDestination(page);
      await expectComposerWithoutKnowledge(page, testInfo, "new-chat-add-menu-desktop");

      // Regression guard: removing the areas leaves an ordinary chat working.
      await selectFakeModel(page);
      const searchChip = page.getByRole("button", { name: /^Choose web search/u });
      if (await searchChip.isVisible()) await chooseSearchStrategy(page, "Off");
      const prompt = `Removed areas regression ${randomUUID().slice(0, 8)}`;
      await sendAndExpect(page, prompt, `Fake answer: ${prompt}`);
      chatId = await activeChatId(page);
      await expect(page).toHaveURL((url) => url.pathname === `/c/${chatId}`);
      await expect(page.getByRole("textbox", { exact: true, name: "Message" })).toBeVisible();
    } finally {
      if (chatId) await deleteOwnedChatPermanently(page.request, chatId, { timeout: 5_000 }).catch(() => undefined);
    }
  });

  test("Studio has no Knowledge section and Chat defaults has no Knowledge row", async ({ page }, testInfo) => {
    await signInWithLocalToken(page);
    const studio = page.getByRole("navigation", { name: "Workspace", exact: true })
      .getByRole("button", { name: "Studio", exact: true });
    await studio.click();
    const library = page.getByTestId("library-v2");
    await expect(library).toBeVisible();
    const sections = library.getByRole("tablist", { name: "Studio sections" });
    await expect(sections.getByRole("tab", { name: "Memory", exact: true })).toBeVisible();
    await expect(sections.getByRole("tab", { name: /Knowledge/u })).toHaveCount(0);

    const defaults = sections.getByRole("tab", { name: "Chat defaults", exact: true });
    await defaults.click();
    await expect(defaults).toHaveAttribute("aria-selected", "true");
    const panel = library.getByRole("tabpanel");
    await expect(panel.getByRole("radiogroup", { name: "MCP tools default" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("settings-default-knowledge")).toHaveCount(0);
    await expect(panel).not.toContainText(/Knowledge|Project/u);
    await expectNoHorizontalOverflow(page);
    await shot(page, testInfo, "studio-chat-defaults-desktop");
  });

  test("Control Center offers the native Anthropic tile and names its retrieval page Memory", async ({ page }, testInfo) => {
    await signInWithLocalToken(page);
    await page.goto("/admin?section=providers");
    await expect(page.getByTestId("admin-topbar-title")).toHaveText("Providers", { timeout: 30_000 });

    const retrieval = page.getByTestId("admin-nav-retrieval");
    await expect(retrieval).toBeVisible();
    await expect(retrieval).toContainText("Memory");
    await expect(retrieval).not.toContainText("Knowledge");
    await expect(page.getByTestId("admin-section-index").getByRole("link", { name: /Knowledge/u })).toHaveCount(0);

    await page.getByTestId("provider-add").click();
    const sheet = page.getByRole("dialog", { name: "Add provider" });
    await expect(sheet).toBeVisible();
    const tiles = sheet.getByTestId("provider-add-tiles");
    await expect(tiles.getByTestId("provider-add-tile-openai")).toBeVisible();
    await expect(tiles.getByTestId("provider-add-tile-anthropic")).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await shot(page, testInfo, "admin-add-provider-desktop");
  });
});

test.describe("phone portrait", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: PHONE_PORTRAIT });

  test("an old Project chat address opens the new chat", async ({ page }, testInfo) => {
    await expectOldProjectAddressOpensNewChat(page, testInfo, "old-project-address-phone");
  });

  test("the drawer offers no Projects and the composer offers no Knowledge", async ({ page }, testInfo) => {
    await signInWithLocalToken(page);
    await expectNoProjectsDestination(page);
    await expectComposerWithoutKnowledge(page, testInfo, "new-chat-add-menu-phone");
    await expectNoHorizontalOverflow(page);
  });
});

import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { runAccountMenuAction } from "./shell/page";
import { e2eAssistantAvatar, e2eAssistantRows } from "./support/assistants";
import { deleteOwnedChatPermanently } from "./support/chatCleanup";
import { authenticateWithLocalToken } from "./support/localAuth";

// Short screens and narrow tablets (task 20260928115822568): on a phone held
// sideways every row menu is a sheet that scrolls to its last item; below
// 1024px and on short touch screens Settings shows its list of sections and a
// section in turns, each across the whole width, instead of a 260px column
// beside the section; and a short screen shows the first gallery row under a
// compact heading. Everything a test creates is removed.

test.use({ locale: "en-US", contextOptions: { reducedMotion: "reduce" } });

type Box = Readonly<{ height: number; width: number; x: number; y: number }>;
type Size = Readonly<{ height: number; width: number }>;

const touchRule = "(hover: none), (pointer: coarse)";
/** `.v2-library-panel` fades its last 2rem out (an overflow cue). */
const PANEL_FADE_PX = 32;

async function boxOf(locator: Locator, name: string): Promise<Box> {
  await expect(locator, `${name} is visible`).toBeVisible();
  const box = await locator.boundingBox();
  expect(box, `${name} has a box`).not.toBeNull();
  return box!;
}

function expectInside(box: Box, frame: Box, name: string): void {
  expect(box.x, `${name} left`).toBeGreaterThanOrEqual(frame.x - 0.5);
  expect(box.y, `${name} top`).toBeGreaterThanOrEqual(frame.y - 0.5);
  expect(box.x + box.width, `${name} right`).toBeLessThanOrEqual(frame.x + frame.width + 0.5);
  expect(box.y + box.height, `${name} bottom`).toBeLessThanOrEqual(frame.y + frame.height + 0.5);
}

function viewportBox(size: Size): Box {
  return { height: size.height, width: size.width, x: 0, y: 0 };
}

async function createOwnedChat(request: APIRequestContext): Promise<Readonly<{ chatId: string; title: string }>> {
  const title = `Short screen ${randomUUID().slice(0, 8)}`;
  const response = await request.post("/api/chats", { data: { memoryMode: "EXCLUDED", title } });
  expect(response.status(), await response.text()).toBe(201);
  const chatId = ((await response.json()) as { chat: { id: string } }).chat.id;
  return { chatId, title };
}

async function fakeModelId(request: APIRequestContext): Promise<string> {
  const response = await request.get("/api/me/catalog");
  expect(response.ok()).toBe(true);
  const { catalog } = (await response.json()) as {
    catalog: { models: { modelId: string; providerFamily: string; upstreamModelId: string }[] };
  };
  const model = catalog.models.find((candidate) =>
    candidate.providerFamily === "fake" && candidate.upstreamModelId === "fake-qsa");
  expect(model, "the seeded Fake QSA model").toBeTruthy();
  return model!.modelId;
}

async function createOwnedAssistant(request: APIRequestContext): Promise<Readonly<{ id: string; name: string }>> {
  const name = `Short screen helper ${randomUUID().slice(0, 8)}`;
  const response = await request.post("/api/me/assistants", {
    data: {
      avatar: e2eAssistantAvatar(),
      category: null,
      description: "Synthetic short-screen fixture",
      name,
      rows: e2eAssistantRows(await fakeModelId(request)),
      starterPrompts: [],
      systemPrompt: "You are terse."
    }
  });
  expect(response.status(), await response.text()).toBe(201);
  const { assistant } = (await response.json()) as { assistant: { id: string } };
  return { id: assistant.id, name };
}

async function deleteOwnedAssistant(request: APIRequestContext, assistantId: string): Promise<void> {
  const detail = await request.get(`/api/me/assistants/${assistantId}`);
  if (detail.status() === 404) return;
  expect(detail.status(), await detail.text()).toBe(200);
  const { assistant } = (await detail.json()) as { assistant: { version?: number } };
  const response = await request.delete(`/api/me/assistants/${assistantId}`, {
    data: { expectedVersion: assistant.version }
  });
  expect([204, 404], "the owned Assistant is cleaned up").toContain(response.status());
}

async function openShell(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await expect(page.getByTestId("app-shell")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("header-model-trigger")).toBeEnabled({ timeout: 30_000 });
}

/**
 * Opens a row menu from its trigger and proves it is a sheet whose every
 * item, the last action and the sheet's own Close row included, scrolls into
 * view inside the sheet and on screen, uncovered. Closes it with Close.
 */
async function expectSheetReachesLastItem(
  page: Page,
  trigger: Locator,
  label: string,
  size: Size,
  lastAction?: string
): Promise<void> {
  await trigger.scrollIntoViewIfNeeded();
  await trigger.tap();
  const sheet = page.getByRole("dialog", { exact: true, name: `${label} sheet` });
  const sheetBox = await boxOf(sheet, `${label} sheet`);
  expectInside(sheetBox, viewportBox(size), `${label} sheet`);
  const menu = sheet.getByRole("menu", { exact: true, name: label });
  const items = menu.getByRole("menuitem");
  const count = await items.count();
  expect(count, `${label} items`).toBeGreaterThanOrEqual(2);
  await expect(items.last(), `${label} ends with Close`).toHaveAccessibleName("Close");
  if (lastAction) await expect(items.nth(count - 2)).toHaveAccessibleName(lastAction);

  for (let index = 0; index < count; index += 1) {
    const item = items.nth(index);
    const name = `${label} item ${index + 1}/${count} ${(await item.textContent())?.trim() ?? ""}`;
    await item.scrollIntoViewIfNeeded();
    const menuBox = await boxOf(menu, `${label} menu`);
    const box = await boxOf(item, name);
    expectInside(box, menuBox, `${name} in the sheet's scroller`);
    expectInside(box, viewportBox(size), `${name} on screen`);
    expect(await item.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
      return Boolean(hit && element.contains(hit));
    }), `${name} is uncovered`).toBe(true);
  }

  await items.last().tap();
  await expect(sheet).toHaveCount(0);
}

async function openSettingsSection(page: Page, name: "Assistants" | "Instructions"): Promise<Locator> {
  await runAccountMenuAction(page, name);
  return page.getByTestId("library-v2");
}

/** The first row menu of a Settings section, if the seeded operator has one there. */
async function firstRowMenuTrigger(scope: Locator): Promise<Locator | null> {
  const triggers = scope.getByRole("button", { name: /^More actions for / });
  return (await triggers.count()) > 0 ? triggers.first() : null;
}

/** The list of sections, also while it is hidden (role queries skip hidden nodes). */
function sectionList(library: Locator): Locator {
  return library.locator('[role="tablist"][aria-label="Settings sections"]');
}

/** Keyboard focus sits on a visible control inside Settings, not on the document body. */
async function expectFocusInsideSettings(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || active === document.body) return false;
    if (!active.closest('[data-testid="library-v2"]')) return false;
    const box = active.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  }), "focus stays on a visible control inside Settings").toBe(true);
}

/**
 * Settings takes the whole width and shows the list of sections and a section
 * in turns: the open section spans the page with no list beside it, Back to
 * Settings shows the list under its title, the last section scrolls into view
 * and opens, and the list leads back to `section`.
 */
async function expectListThenSection(page: Page, size: Size, section: "Assistants"): Promise<void> {
  const library = page.getByTestId("library-v2");
  await expect(library).toHaveAttribute("data-view", "section");
  const libraryBox = await boxOf(library, "Settings");
  expect(Math.abs(libraryBox.x), "Settings starts at the left edge").toBeLessThanOrEqual(1);
  expect(Math.abs(libraryBox.x + libraryBox.width - size.width), "Settings reaches the right edge").toBeLessThanOrEqual(1);
  const panelBox = await boxOf(library.getByRole("tabpanel"), "Settings section");
  expect(Math.abs(panelBox.x - libraryBox.x), "no section column before the section").toBeLessThanOrEqual(1);
  expect(Math.abs(panelBox.width - libraryBox.width), "the section takes the whole width").toBeLessThanOrEqual(1);
  await expect(sectionList(library), "the list yields to the section").toBeHidden();
  // A section keeps Back to chat as a 44px close control at the end of its crumb row.
  const exit = library.getByRole("button", { exact: true, name: "Back to chat" });
  const closeBox = await boxOf(exit, "Back to chat close control");
  expect(Math.abs(closeBox.width - 44), "close control width").toBeLessThanOrEqual(1);
  expect(Math.abs(closeBox.height - 44), "close control height").toBeLessThanOrEqual(1);
  expect(Math.abs(size.width - 8 - (closeBox.x + closeBox.width)), "the close control at the right end").toBeLessThanOrEqual(1);

  await library.getByRole("button", { exact: true, name: "Back to Settings" }).tap();
  await expect(library).toHaveAttribute("data-view", "list");
  const title = library.getByRole("heading", { level: 1, name: "Settings" });
  await expect(title).toBeVisible();
  await expect(library.locator('[role="tabpanel"]'), "the section yields to the list").toBeHidden();
  const list = library.getByRole("tablist", { name: "Settings sections" });
  const listBox = await boxOf(list, "Settings sections");
  const rowBox = await boxOf(library.locator(".v2-library-heading-row"), "Settings header row");
  expect(listBox.y, "the list starts under the header row").toBeGreaterThanOrEqual(rowBox.y + rowBox.height - 0.5);
  // The list: Back to chat is a 44px back arrow left of the title, its icon on
  // the section icons' edge, and nothing sits at the right.
  const arrowBox = await boxOf(exit, "Back to chat arrow");
  expect(Math.abs(arrowBox.width - 44), "arrow width").toBeLessThanOrEqual(1);
  expect(Math.abs(arrowBox.height - 44), "arrow height").toBeLessThanOrEqual(1);
  expectInside(arrowBox, rowBox, "the arrow in the header row");
  expectInside(arrowBox, viewportBox(size), "the arrow on screen");
  expect(arrowBox.x + arrowBox.width, "the arrow left of the title").toBeLessThanOrEqual((await boxOf(title, "Settings title")).x + 0.5);
  await expect(library.locator(".v2-library-heading-row button:visible"), "nothing at the header row's right").toHaveCount(0);
  const classicScrollbar = await list.evaluate((element) => element.offsetWidth - element.clientWidth > 0.5);
  if (!classicScrollbar) {
    const arrowIcon = await boxOf(exit.locator(".v2-library-exit-arrow"), "arrow icon");
    const rowIcon = await boxOf(list.getByRole("tab").first().locator(".v2-icon").first(), "first section icon");
    expect(Math.abs(arrowIcon.x - rowIcon.x), "the arrow's icon on the section icons' edge").toBeLessThanOrEqual(1);
  }

  const last = list.getByRole("tab").last();
  const lastName = (await last.textContent())?.trim() ?? "last section";
  await last.scrollIntoViewIfNeeded();
  const lastBox = await boxOf(last, `${lastName} row`);
  expectInside(lastBox, viewportBox(size), `${lastName} row on screen`);
  expectInside(lastBox, listBox, `${lastName} row inside the list`);
  await last.tap();
  await expect(library).toHaveAttribute("data-view", "section");
  await expect(library.locator('[role="tab"][aria-selected="true"]')).toHaveText(lastName);

  await library.getByRole("button", { exact: true, name: "Back to Settings" }).tap();
  await expect(library).toHaveAttribute("data-view", "list");
  const row = list.getByRole("tab", { exact: true, name: section });
  await row.scrollIntoViewIfNeeded();
  await row.tap();
  await expect(library).toHaveAttribute("data-view", "section");
  await expect(library.locator('[role="tab"][aria-selected="true"]')).toHaveText(section);
}

/**
 * On a short touch screen an open sub-view (the Assistant editor) replaces
 * the section's Back to Settings with "Back to Assistants" in the crumb row;
 * Back returns to the section with focus still inside Settings, and Back to
 * Settings then shows the list with the section's row focused.
 */
async function expectEditorKeepsItsOwnBack(page: Page, size: Size): Promise<void> {
  const assistant = await createOwnedAssistant(page.request);
  try {
    await openShell(page, "/");
    const library = await openSettingsSection(page, "Assistants");
    const card = library.getByTestId(`assistant-card-${assistant.id}`);
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(sectionList(library)).toHaveCount(1);
    await expect(sectionList(library), "the list yields to the section").toBeHidden();
    const backToSettings = library.getByRole("button", { exact: true, name: "Back to Settings" });
    await expect(backToSettings).toBeVisible();

    await card.getByRole("button", { exact: true, name: `More actions for ${assistant.name}` }).tap();
    await page.getByRole("menuitem", { exact: true, name: "Edit" }).tap();
    const editor = library.getByTestId("assistant-editor");
    await expect(editor.getByLabel("Name Required", { exact: true })).toHaveValue(assistant.name, { timeout: 30_000 });
    await expect(backToSettings, "the editor's own Back replaces Back to Settings").toHaveCount(0);
    // Where a section shows alone, the close control yields to the sub-view's own Back too.
    await expect(library.getByRole("button", { exact: true, name: "Back to chat" })).toBeHidden();
    const back = library.getByRole("button", { exact: true, name: "Back to Assistants" });
    const backBox = await boxOf(back, "Back to Assistants");
    expectInside(backBox, await boxOf(library.locator(".v2-library-heading-row"), "Settings crumb row"), "Back to Assistants in the crumb row");
    expectInside(backBox, viewportBox(size), "Back to Assistants on screen");

    await back.tap();
    await expect(editor).toHaveCount(0);
    await expect(card).toBeVisible();
    await expect(backToSettings).toBeVisible();
    await expect(library).toHaveAttribute("data-view", "section");
    await expectFocusInsideSettings(page);

    await backToSettings.tap();
    await expect(library).toHaveAttribute("data-view", "list");
    await expect(library.getByRole("tab", { exact: true, name: "Assistants" })).toBeFocused();
  } finally {
    await deleteOwnedAssistant(page.request, assistant.id);
  }
}

test.describe("short screens · phone landscape 844×390 touch", () => {
  const size = { height: 390, width: 844 } as const;
  test.use({ hasTouch: true, isMobile: true, viewport: size });

  test("row menus open as sheets that scroll to their last item · phone landscape 844×390", async ({ page }) => {
    test.setTimeout(150_000);
    await authenticateWithLocalToken(page.request);
    const { chatId, title } = await createOwnedChat(page.request);
    let assistant: Awaited<ReturnType<typeof createOwnedAssistant>> | null = null;
    try {
      assistant = await createOwnedAssistant(page.request);
      await openShell(page, `/c/${chatId}`);
      expect(await page.evaluate((rule) => matchMedia(rule).matches, touchRule)).toBe(true);

      // The chat row "⋯" in the (compact) chat list.
      const navigation = page.getByRole("complementary", { name: "Chat navigation" });
      if (!(await navigation.isVisible())) {
        await page.locator(".v2-sidebar-floats").getByRole("button", { name: "Open sidebar" }).tap();
        await expect(navigation).toBeVisible();
      }
      await expectSheetReachesLastItem(
        page,
        navigation.getByRole("button", { exact: true, name: `Actions: ${title}` }),
        `Chat actions: ${title}`,
        size
      );

      // Settings › Assistants: the card "⋯" of an owned Assistant (six actions).
      let library = await openSettingsSection(page, "Assistants");
      const card = library.getByTestId(`assistant-card-${assistant.id}`);
      await expectSheetReachesLastItem(
        page,
        card.getByRole("button", { exact: true, name: `More actions for ${assistant.name}` }),
        `Actions for ${assistant.name}`,
        size,
        "Delete"
      );

      // Settings › Instructions: the first row menu the operator has.
      library = await openSettingsSection(page, "Instructions");
      await expect(library.getByRole("button", { name: "New preset" })).toBeEnabled({ timeout: 30_000 });
      const preset = await firstRowMenuTrigger(library.getByTestId("settings-instructions"));
      if (preset) {
        const name = ((await preset.getAttribute("aria-label")) ?? "").replace(/^More actions for /, "");
        await expectSheetReachesLastItem(page, preset, `Actions for ${name}`, size);
      } else {
        test.info().annotations.push({ description: "The seeded operator has no instruction preset.", type: "skipped-menu" });
      }
    } finally {
      if (assistant) await deleteOwnedAssistant(page.request, assistant.id);
      await deleteOwnedChatPermanently(page.request, chatId);
    }
  });

  test("Settings shows its sections and a section in turns and the first gallery row under a compact heading · phone landscape 844×390", async ({ page }) => {
    test.setTimeout(120_000);
    await authenticateWithLocalToken(page.request);
    const assistant = await createOwnedAssistant(page.request);
    try {
      await openShell(page, "/");
      const library = await openSettingsSection(page, "Assistants");
      const gallery = library.getByTestId("assistant-gallery");
      await expect(gallery.getByTestId(`assistant-card-${assistant.id}`)).toBeVisible({ timeout: 30_000 });
      await expectListThenSection(page, size, "Assistants");
      await expect(gallery.getByTestId(`assistant-card-${assistant.id}`)).toBeVisible({ timeout: 30_000 });

      // Compact heading: the title and New assistant stay, the description goes.
      const panel = await boxOf(library.getByRole("tabpanel"), "Settings section");
      await expect(gallery.getByRole("heading", { level: 2, name: "Assistants" })).toBeVisible();
      await expect(gallery.locator(".v2-resource-heading > div > p")).toBeHidden();
      const newAssistant = await boxOf(gallery.getByRole("button", { exact: true, name: "New assistant" }), "New assistant");
      expectInside(newAssistant, viewportBox(size), "New assistant on screen");

      // The first card row shows on the first screen, above the panel's fade.
      const firstCard = gallery.locator(".v2-assistants-card").first();
      const title = await boxOf(firstCard.locator(".v2-assistants-card-open"), "first card title");
      expect(title.y, "first card title below the panel top").toBeGreaterThanOrEqual(panel.y - 0.5);
      expect(title.y + title.height, "first card title on the first screen").toBeLessThanOrEqual(size.height - PANEL_FADE_PX);

      // The one-row toolbar keeps every filter chip reachable.
      const filters = gallery.getByRole("group", { name: "Filter Assistants" });
      const filtersBox = await boxOf(filters, "filter chips");
      const lastChip = filters.getByRole("button").last();
      await lastChip.scrollIntoViewIfNeeded();
      const chip = await boxOf(lastChip, "last filter chip");
      expectInside(chip, viewportBox(size), "last filter chip on screen");
      expect(chip.x + chip.width, "last filter chip inside its strip").toBeLessThanOrEqual(filtersBox.x + filtersBox.width + 0.5);
    } finally {
      await deleteOwnedAssistant(page.request, assistant.id);
    }
  });

  test("the Assistant editor keeps its own Back and returns to the section · phone landscape 844×390", async ({ page }) => {
    test.setTimeout(120_000);
    await authenticateWithLocalToken(page.request);
    await expectEditorKeepsItsOwnBack(page, size);
  });
});

test.describe("short screens · small phone landscape 667×375 touch", () => {
  const size = { height: 375, width: 667 } as const;
  test.use({ hasTouch: true, isMobile: true, viewport: size });

  test("the Assistant editor keeps its own Back and returns to the section · phone landscape 667×375", async ({ page }) => {
    test.setTimeout(120_000);
    await authenticateWithLocalToken(page.request);
    await expectEditorKeepsItsOwnBack(page, size);
  });
});

test.describe("narrow tablet · portrait 768×1024 touch", () => {
  const size = { height: 1024, width: 768 } as const;
  test.use({ hasTouch: true, isMobile: false, viewport: size });

  test("Settings shows its sections and a section in turns across the whole width · tablet portrait 768×1024", async ({ page }) => {
    test.setTimeout(90_000);
    await authenticateWithLocalToken(page.request);
    await openShell(page, "/");
    const library = await openSettingsSection(page, "Assistants");
    await expect(library.getByTestId("assistant-gallery")).toBeVisible();
    await expectListThenSection(page, size, "Assistants");
  });
});

test("desktop keeps the Settings section column and Back to chat · desktop 1440×900", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ height: 900, width: 1440 });
  await authenticateWithLocalToken(page.request);
  await openShell(page, "/");
  expect(await page.evaluate((rule) => matchMedia(rule).matches, touchRule)).toBe(false);
  const library = await openSettingsSection(page, "Assistants");
  // No rail and no chat list: Settings spans the window.
  const libraryBox = await boxOf(library, "Settings");
  expect(Math.abs(libraryBox.x), "Settings starts at the left edge").toBeLessThanOrEqual(1);
  expect(Math.abs(libraryBox.width - 1440), "Settings spans the window").toBeLessThanOrEqual(1);
  await expect(page.getByRole("complementary", { name: "Chat navigation" })).toBeHidden();
  await expect(page.locator(".v2-sidebar-floats")).toHaveCount(0);
  // The section column is the chat list's width (16.25rem), the section follows it.
  const tablist = await boxOf(library.getByRole("tablist", { name: "Settings sections" }), "Settings section column");
  const panel = await boxOf(library.getByRole("tabpanel"), "Settings section");
  expect(Math.abs(tablist.x - libraryBox.x), "the column starts Settings").toBeLessThanOrEqual(1);
  expect(Math.abs(tablist.width - 260), "the column is 260px wide").toBeLessThanOrEqual(1);
  expect(Math.abs(panel.x - (tablist.x + tablist.width)), "the section follows the column").toBeLessThanOrEqual(1);
  expect(Math.abs(panel.x + panel.width - 1440), "the section reaches the right edge").toBeLessThanOrEqual(1);
  // The header row over the section holds only the crumb; the one Back to chat
  // is the column's first row, beside the header row and above the sections,
  // with the section rows' 12px fill edges.
  const row = await boxOf(library.locator(".v2-library-heading-row"), "Settings header row");
  expect(Math.abs(row.x - panel.x), "the header row sits over the section").toBeLessThanOrEqual(1);
  const exit = library.getByRole("button", { exact: true, name: "Back to chat" });
  await expect(exit).toHaveCount(1);
  const exitBox = await boxOf(exit, "Back to chat");
  expect(Math.abs(exitBox.x - 12), "Back to chat fill starts 12px in").toBeLessThanOrEqual(1);
  expect(Math.abs(exitBox.x + exitBox.width - 247), "Back to chat fill ends at 247px").toBeLessThanOrEqual(1);
  expect(exitBox.y + exitBox.height, "Back to chat sits in the header row's band").toBeLessThanOrEqual(row.y + row.height + 0.5);
  expect(exitBox.y + exitBox.height, "Back to chat above the first section").toBeLessThanOrEqual(tablist.y + 0.5);
  await expect(library.locator(".v2-library-heading-row button:visible"), "nothing at the header row's end").toHaveCount(0);
  await expect(library.getByRole("navigation", { name: "Settings location" })).toHaveText("Assistants");
  await exit.click();
  await expect(library).toBeHidden();
  await expect(page.getByRole("complementary", { name: "Chat navigation" })).toBeVisible();
});

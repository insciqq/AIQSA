import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { runAccountMenuAction } from "./shell/page";
import { e2eAssistantAvatar, e2eAssistantRows } from "./support/assistants";
import { deleteOwnedChatPermanently } from "./support/chatCleanup";
import { authenticateWithLocalToken } from "./support/localAuth";

// Short screens and narrow tablets (task 20260928115822568): on a phone held
// sideways every row menu is a sheet that scrolls to its last item; from 768
// to 1023px and on short touch screens Studio stacks its section tabs above
// the content instead of a 260px column; and a short screen shows the first
// gallery row under a compact heading. Everything a test creates is removed.

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

async function openStudioSection(page: Page, name: "Assistants" | "Instructions" | "Knowledge"): Promise<Locator> {
  await runAccountMenuAction(page, name);
  return page.getByTestId("library-v2");
}

/** The first row menu of a Studio section, if the seeded operator has one there. */
async function firstRowMenuTrigger(scope: Locator): Promise<Locator | null> {
  const triggers = scope.getByRole("button", { name: /^More actions for / });
  return (await triggers.count()) > 0 ? triggers.first() : null;
}

/**
 * Studio gives its content the width the phone layout gives it: the panel
 * spans the Library beside the rail, the section tabs are a strip above it,
 * and the last section tab scrolls into view and opens.
 */
async function expectStackedStudio(page: Page, size: Size): Promise<void> {
  const library = page.getByTestId("library-v2");
  const rail = await boxOf(page.getByTestId("workspace-rail"), "rail");
  const libraryBox = await boxOf(library, "Studio");
  const tablist = library.getByRole("tablist", { name: "Studio sections" });
  const panel = library.getByRole("tabpanel");
  const tablistBox = await boxOf(tablist, "Studio section tabs");
  const panelBox = await boxOf(panel, "Studio panel");

  expect(Math.abs(libraryBox.x - (rail.x + rail.width)), "Studio starts at the rail").toBeLessThanOrEqual(1);
  expect(Math.abs(libraryBox.x + libraryBox.width - size.width), "Studio reaches the right edge").toBeLessThanOrEqual(1);
  expect(Math.abs(panelBox.x - libraryBox.x), "no section column before the panel").toBeLessThanOrEqual(1);
  expect(Math.abs(panelBox.width - libraryBox.width), "the panel takes the whole Studio width").toBeLessThanOrEqual(1);
  expect(tablistBox.y + tablistBox.height, "the section tabs sit above the panel").toBeLessThanOrEqual(panelBox.y + 1);
  expect(tablistBox.height, "the section tabs are one strip").toBeLessThanOrEqual(64);

  const tabs = tablist.getByRole("tab");
  const first = tabs.first();
  const last = tabs.last();
  const lastName = (await last.textContent())?.trim() ?? "last section";
  await last.scrollIntoViewIfNeeded();
  const lastBox = await boxOf(last, `${lastName} tab`);
  expectInside(lastBox, viewportBox(size), `${lastName} tab on screen`);
  expect(lastBox.x + lastBox.width, `${lastName} tab inside the strip`).toBeLessThanOrEqual(tablistBox.x + tablistBox.width + 0.5);
  await last.tap();
  await expect(last).toHaveAttribute("aria-selected", "true");
  await first.scrollIntoViewIfNeeded();
  await first.tap();
  await expect(first).toHaveAttribute("aria-selected", "true");
}

/**
 * On a short touch screen an open sub-view (the Assistant editor) hides the
 * section strip and keeps "Back to Assistants" in the crumb row; Back shows
 * the strip again and focuses the selected section tab.
 */
async function expectEditorYieldsSectionStrip(page: Page, size: Size): Promise<void> {
  const assistant = await createOwnedAssistant(page.request);
  try {
    await openShell(page, "/");
    const library = await openStudioSection(page, "Assistants");
    const card = library.getByTestId(`assistant-card-${assistant.id}`);
    await expect(card).toBeVisible({ timeout: 30_000 });
    // The role query skips hidden nodes; the attribute query keeps the strip in reach once hidden.
    const strip = library.locator('[role="tablist"][aria-label="Studio sections"]');
    await expect(strip).toHaveCount(1);
    await expect(strip).toBeVisible();

    await card.getByRole("button", { exact: true, name: `More actions for ${assistant.name}` }).tap();
    await page.getByRole("menuitem", { exact: true, name: "Edit" }).tap();
    const editor = library.getByTestId("assistant-editor");
    await expect(editor.getByLabel("Name Required", { exact: true })).toHaveValue(assistant.name, { timeout: 30_000 });
    await expect(strip, "the section strip yields to the editor").toBeHidden();
    const back = library.getByRole("button", { exact: true, name: "Back to Assistants" });
    const backBox = await boxOf(back, "Back to Assistants");
    expectInside(backBox, await boxOf(library.locator(".v2-library-heading-row"), "Studio crumb row"), "Back to Assistants in the crumb row");
    expectInside(backBox, viewportBox(size), "Back to Assistants on screen");

    await back.tap();
    await expect(editor).toHaveCount(0);
    await expect(strip).toBeVisible();
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
      const navigation = page.getByRole("complementary", { name: /^(Chat|Project) navigation$/ });
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

      // Studio › Assistants: the card "⋯" of an owned Assistant (six actions).
      let library = await openStudioSection(page, "Assistants");
      const card = library.getByTestId(`assistant-card-${assistant.id}`);
      await expectSheetReachesLastItem(
        page,
        card.getByRole("button", { exact: true, name: `More actions for ${assistant.name}` }),
        `Actions for ${assistant.name}`,
        size,
        "Delete"
      );

      // Studio › Instructions and Knowledge: the first row menu the operator has.
      library = await openStudioSection(page, "Instructions");
      await expect(library.getByRole("button", { name: "New preset" })).toBeEnabled({ timeout: 30_000 });
      const preset = await firstRowMenuTrigger(library.getByTestId("settings-instructions"));
      if (preset) {
        const name = ((await preset.getAttribute("aria-label")) ?? "").replace(/^More actions for /, "");
        await expectSheetReachesLastItem(page, preset, `Actions for ${name}`, size);
      } else {
        test.info().annotations.push({ description: "The seeded operator has no instruction preset.", type: "skipped-menu" });
      }

      library = await openStudioSection(page, "Knowledge");
      const knowledge = library.getByTestId("library-knowledge-panel");
      await expect(knowledge).toBeVisible();
      await expect(knowledge.getByText("Loading knowledge…")).toHaveCount(0, { timeout: 30_000 });
      const base = await firstRowMenuTrigger(knowledge);
      if (base) {
        const name = ((await base.getAttribute("aria-label")) ?? "").replace(/^More actions for /, "");
        await expectSheetReachesLastItem(page, base, `Actions for ${name}`, size);
      } else {
        test.info().annotations.push({ description: "The seeded operator owns no Knowledge base.", type: "skipped-menu" });
      }
    } finally {
      if (assistant) await deleteOwnedAssistant(page.request, assistant.id);
      await deleteOwnedChatPermanently(page.request, chatId);
    }
  });

  test("Studio stacks its sections and shows the first gallery row under a compact heading · phone landscape 844×390", async ({ page }) => {
    test.setTimeout(120_000);
    await authenticateWithLocalToken(page.request);
    const assistant = await createOwnedAssistant(page.request);
    try {
      await openShell(page, "/");
      const library = await openStudioSection(page, "Assistants");
      const gallery = library.getByTestId("assistant-gallery");
      await expect(gallery.getByTestId(`assistant-card-${assistant.id}`)).toBeVisible({ timeout: 30_000 });
      await expectStackedStudio(page, size);
      await expect(library.getByRole("tab", { exact: true, name: "Assistants" })).toHaveAttribute("aria-selected", "true");
      await expect(gallery.getByTestId(`assistant-card-${assistant.id}`)).toBeVisible({ timeout: 30_000 });

      // Compact heading: the title and New assistant stay, the description goes.
      const panel = await boxOf(library.getByRole("tabpanel"), "Studio panel");
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

  test("the Assistant editor hides the section strip and Back restores it · phone landscape 844×390", async ({ page }) => {
    test.setTimeout(120_000);
    await authenticateWithLocalToken(page.request);
    await expectEditorYieldsSectionStrip(page, size);
  });
});

test.describe("short screens · small phone landscape 667×375 touch", () => {
  const size = { height: 375, width: 667 } as const;
  test.use({ hasTouch: true, isMobile: true, viewport: size });

  test("the Assistant editor hides the section strip and Back restores it · phone landscape 667×375", async ({ page }) => {
    test.setTimeout(120_000);
    await authenticateWithLocalToken(page.request);
    await expectEditorYieldsSectionStrip(page, size);
  });
});

test.describe("narrow tablet · portrait 768×1024 touch", () => {
  const size = { height: 1024, width: 768 } as const;
  test.use({ hasTouch: true, isMobile: false, viewport: size });

  test("Studio stacks its sections above the full-width content · tablet portrait 768×1024", async ({ page }) => {
    test.setTimeout(90_000);
    await authenticateWithLocalToken(page.request);
    await openShell(page, "/");
    const library = await openStudioSection(page, "Assistants");
    await expect(library.getByTestId("assistant-gallery")).toBeVisible();
    await expectStackedStudio(page, size);
  });
});

test("desktop keeps the Studio section column · desktop 1440×900", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ height: 900, width: 1440 });
  await authenticateWithLocalToken(page.request);
  await openShell(page, "/");
  expect(await page.evaluate((rule) => matchMedia(rule).matches, touchRule)).toBe(false);
  const library = await openStudioSection(page, "Assistants");
  const libraryBox = await boxOf(library, "Studio");
  const tablist = await boxOf(library.getByRole("tablist", { name: "Studio sections" }), "Studio section column");
  const panel = await boxOf(library.getByRole("tabpanel"), "Studio panel");
  expect(Math.abs(tablist.x - libraryBox.x), "the column starts the Studio").toBeLessThanOrEqual(1);
  expect(Math.abs(tablist.width - 260), "the column is 260px wide").toBeLessThanOrEqual(1);
  expect(Math.abs(panel.x - (tablist.x + tablist.width)), "the panel follows the column").toBeLessThanOrEqual(1);
});

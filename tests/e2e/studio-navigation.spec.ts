import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { authenticateWithLocalToken } from "./support/localAuth";
import { installMatrixCatalogFixture } from "./shell/catalogFixture";
import { runAccountMenuAction, showSettingsSection } from "./shell/page";
import { expectNoHorizontalOverflow } from "./support/layoutAssertions";

const sizes = [{ width: 1440, height: 900 }, { width: 768, height: 1024 },
  { width: 1024, height: 768 }, { width: 390, height: 844 }, { width: 844, height: 390 }];
const resources = ["Assistants", "Memory"] as const;
type Resource = typeof resources[number];

async function prepare(page: Page) {
  await authenticateWithLocalToken(page.request);
  const timestamp = "2026-09-21T10:00:00.000Z";
  await installMatrixCatalogFixture(page, { folders: [], chats: [{
    id: "studio-navigation-chat", title: "Navigation destination", folderId: null,
    activeLeafMessageId: null, createdAt: timestamp, updatedAt: timestamp, messageCount: 0,
    defaultModelId: "gpt-5.5", defaultProvider: "openai", messages: []
  }] });
  // Settings › Memory: a saved note, its switches and no earlier memories.
  await page.route("**/api/me/memory/note", route => route.request().method() === "GET"
    ? route.fulfill({ json: { text: "Release notes need evidence.", revision: 1, lastChangedBy: "user", updatedAt: timestamp } })
    : route.fallback());
  await page.route("**/api/me/memory/preferences", route => route.fulfill({
    json: { memoryEnabled: true, pastChatSearchEnabled: true, memorySuggestionsEnabled: true } }));
  await page.route(/\/api\/me\/memory\/legacy(?:\?.*)?$/u, route => route.fulfill({ json: { suggestions: [], nextCursor: null } }));
  await page.route("**/api/chats/compact?*", route => route.fulfill({ json: {
    chats: [{ id: "studio-navigation-chat", title: "Navigation destination", folderId: null, activeRun: false, updatedAt: timestamp,
      assistant: null }],
    folders: [], nextCursor: null
  } }));
  await page.goto("/");
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
}

async function openDraft(page: Page, resource: Resource) {
  await runAccountMenuAction(page, resource);
  const library = page.getByTestId("library-v2");
  if (resource === "Assistants") {
    await library.getByRole("button", { name: "New assistant", exact: true }).first().click();
    // The New assistant sheet starts on Blank; choosing saves nothing.
    const sheet = page.getByRole("dialog", { name: "New assistant", exact: true });
    await expect(sheet.getByRole("radio", { name: "Blank", exact: true })).toBeChecked();
    await sheet.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(sheet).toHaveCount(0);
    const input = library.getByLabel("Name Required", { exact: true });
    await expect(input).toBeFocused();
    await input.fill("Unsaved Settings assistant");
    return input;
  }
  const input = library.getByRole("textbox", { name: "Memory note", exact: true });
  await expect(input).toHaveValue("Release notes need evidence.");
  await input.fill("I prefer carefully verified examples.");
  return input;
}

/** The selected section, also while the list of sections is hidden. */
function selectedSection(library: Locator): Locator {
  return library.locator('[role="tab"][aria-selected="true"]');
}

/**
 * While Settings is open the chat list and the floating controls are absent
 * at every width, and the list shortcuts (Ctrl+K, Ctrl+Shift+S) do nothing.
 * Checked on a section without an editor: an editor may keep shortcuts of
 * its own (the Assistant editor saves on Ctrl+S).
 */
async function expectSettingsOwnsTheShell(page: Page) {
  const navigation = page.getByRole("complementary", { name: "Chat navigation" });
  await expect(navigation).toBeHidden();
  await expect(page.getByRole("button", { name: "Open sidebar" })).toHaveCount(0);
  await expect(page.locator(".v2-sidebar-floats")).toHaveCount(0);
  await page.keyboard.press("Control+k");
  await page.keyboard.press("Control+Shift+S");
  await expect(navigation).toBeHidden();
  await expect(page.getByTestId("discard-changes-confirmation")).toHaveCount(0);
  await expect(page.getByTestId("library-v2")).toBeVisible();
}

async function screenshot(page: Page, info: TestInfo, name: string) {
  await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: true });
}

for (const width of [1440, 390]) {
  test(`Settings protects every existing draft across its exits at ${width}px`, async ({ page }, info) => {
    test.setTimeout(180_000);
    page.setDefaultTimeout(15_000);
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await prepare(page);
    const library = page.getByTestId("library-v2");
    const confirmation = page.getByTestId("discard-changes-confirmation");
    const backToSettings = library.getByRole("button", { name: "Back to Settings", exact: true });
    await runAccountMenuAction(page, "General");
    await expectSettingsOwnsTheShell(page);
    for (const resource of resources) {
      // The narrow Assistant editor is a sub-view: its own Back is the way
      // to another section there, so only the wide layout switches directly.
      const destinations = width === 390 && resource === "Assistants"
        ? ["back", "shortcut"]
        : ["tab", "back", "shortcut"];
      for (const destination of destinations) {
        const input = await openDraft(page, resource);
        const draft = await input.inputValue();
        if (destination === "tab" && width === 390) {
          // The list keeps the section mounted underneath: going to the list
          // and back keeps the draft and the scroll position, with no guard.
          const panel = library.locator('[role="tabpanel"]');
          await panel.evaluate(node => { node.scrollTop = 90; });
          const scroll = await panel.evaluate(node => node.scrollTop);
          await backToSettings.click();
          await expect(library).toHaveAttribute("data-view", "list");
          await expect(confirmation).toHaveCount(0);
          await screenshot(page, info, `${resource}-list-${width}`);
          await library.getByRole("tab", { name: resource, exact: true }).click();
          await expect(library).toHaveAttribute("data-view", "section");
          await expect(input).toHaveValue(draft);
          expect(await panel.evaluate(node => node.scrollTop)).toBe(scroll);
        }
        const navigate = async () => {
          if (destination === "tab") {
            if (await backToSettings.isVisible()) await backToSettings.click();
            await library.getByRole("tab", { name: "Files", exact: true }).click();
          } else if (destination === "back") {
            await library.getByRole("button", { name: resource === "Assistants" ? "Back to Assistants" : "Back to chat", exact: true }).click();
          } else await page.keyboard.press("Control+Shift+O");
        };
        await navigate();
        await expect(confirmation).toBeVisible();
        await expect(confirmation.getByRole("button", { name: "Keep editing", exact: true })).toBeFocused();
        await screenshot(page, info, `${resource}-${destination}-${width}`);
        await confirmation.getByRole("button", { name: "Keep editing", exact: true }).click();
        // Asked from the list of sections, Keep editing leaves the list in front: the draft waits in its section.
        if (await library.getAttribute("data-view") === "list") await showSettingsSection(page, resource);
        await expect(input).toHaveValue(draft);
        await expect(selectedSection(library)).toHaveText(resource);
        await navigate();
        await confirmation.getByRole("button", { name: /Confirm discard/ }).click();
        await expect(input).toHaveCount(0);
        if (destination === "tab") await expect(selectedSection(library)).toHaveText("Files");
        else if (destination !== "back" || resource === "Memory") await expect(library).toHaveCount(0);
        await expectNoHorizontalOverflow(page);
      }
    }
  });
}

test("pending resource mutations block all Settings exits without offering Discard", async ({ page }, info) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(15_000);
  await page.setViewportSize(sizes[0]);
  await prepare(page);
  for (const resource of resources) {
    const input = await openDraft(page, resource);
    const library = page.getByTestId("library-v2");
    const path = resource === "Assistants" ? "assistants" : "memory/note";
    const method = resource === "Assistants" ? "POST" : "PUT";
    let release: (() => void) | undefined;
    let requested = false;
    const pending = new Promise<void>(resolve => { release = resolve; });
    await page.route(`**/api/me/${path}`, async route => {
      if (route.request().method() !== method) { await route.fallback(); return; }
      requested = true;
      await pending;
      await route.fulfill({ status: 503, json: { error: { code: "temporarily_unavailable", message: "Try again later." } } });
    });
    if (resource === "Assistants") {
      await library.getByRole("textbox", { name: "Instructions", exact: true }).fill("Be precise.");
      await library.getByTestId("assistant-editor-save").click();
    } else await library.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(() => requested).toBe(true);
    for (const tab of await library.getByRole("tab").all()) await expect(tab).toBeDisabled();
    // Every exit is locked while the save runs: the Assistant editor's own Back, or Back to chat.
    const exit = library.getByRole("button", { name: resource === "Assistants" ? "Back to Assistants" : "Back to chat", exact: true });
    await expect(exit).toBeDisabled();
    // Back to chat stays beside the Assistant editor on a wide screen, locked too, and Escape does nothing.
    await expect(library.getByRole("button", { name: "Back to chat", exact: true })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(library).toBeVisible();
    await expect(page.locator(".v2-sidebar-floats")).toHaveCount(0);
    await page.keyboard.press("Control+Shift+O");
    await expect(page.getByTestId("discard-changes-confirmation")).toHaveCount(0);
    await screenshot(page, info, `${resource}-busy`);
    release?.();
    await expect(library.getByRole("tab", { name: "Files", exact: true })).toBeEnabled();
    await expect(input).not.toHaveValue("");
    await expect(exit).toBeEnabled();
    await page.keyboard.press("Control+Shift+O");
    await page.getByTestId("discard-changes-confirmation").getByRole("button", { name: /Confirm discard/ }).click();
    await expect(library).toHaveCount(0);
  }
});

test("remembers confirmed sections while explicit links and invalid storage remain predictable", async ({ page }) => {
  await prepare(page);
  await runAccountMenuAction(page, "Files");
  await page.getByRole("button", { name: "Back to chat", exact: true }).click();
  await page.reload();
  await runAccountMenuAction(page, "Settings");
  await expect(page.getByRole("tab", { name: "Files", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.goto("/?library=memory&keep=yes#studio");
  await expect(page.getByRole("tab", { name: "Memory", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page).toHaveURL(/\?keep=yes#studio$/);
  await expect(page).toHaveTitle("Settings · AIQSA");
  await page.evaluate(() => localStorage.setItem("aiqsa.studio.section", "unavailable"));
  await page.goto("/?library=invalid&keep=yes");
  await expect(page).toHaveURL(/\?keep=yes$/);
  await runAccountMenuAction(page, "Settings");
  // Nothing usable is remembered: the gear opens General.
  await expect(page.getByRole("tab", { name: "General", exact: true })).toHaveAttribute("aria-selected", "true");
});

for (const theme of ["dark", "light"] as const) {
  test(`nine-section composition retains order, keyboard access and geometry · ${theme}`, async ({ page }, info) => {
    await page.context().addCookies([{ name: "aiqsa.theme", value: theme, url: "http://127.0.0.1:3000" }]);
    await page.goto("/ui-v2-fixture?fixture=library&state=all-sections");
    const names = ["Assistants", "Instructions", "Skills", "Chat defaults", "Memory", "Files", "Artifacts", "MCP servers", "Secrets"];
    const list = page.getByRole("tablist", { name: "Settings sections" });
    await expect(list.getByRole("tab")).toHaveText(names);
    for (const size of sizes) {
      await page.setViewportSize(size);
      // Where the list and a section take turns, the list is reached with Back to Settings.
      if (!(await list.isVisible())) await page.getByRole("button", { name: "Back to Settings", exact: true }).click();
      const assistants = list.getByRole("tab", { name: "Assistants", exact: true });
      await assistants.focus();
      await assistants.press("End");
      await expect(list.getByRole("tab", { name: "Secrets", exact: true })).toBeFocused();
      await expect(list.getByRole("tab", { name: "Secrets", exact: true })).toHaveAttribute("aria-selected", "true");
      await expect(list.getByRole("tab", { name: "Secrets", exact: true })).toBeInViewport();
      await list.getByRole("tab", { name: "Files", exact: true }).click();
      await expect(page.getByTestId("library-v2")).toHaveAttribute("data-view", "section");
      await expect(page.getByRole("tabpanel", { name: "Files" })).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await screenshot(page, info, `composition-${theme}-${size.width}x${size.height}`);
      await info.attach(`geometry-${size.width}`, { body: JSON.stringify(await page.getByRole("heading", { name: "Files", exact: true }).boundingBox()), contentType: "application/json" });
    }
  });
}

// Operator review 2026-11-16: Back to chat at the top left of Settings, Escape
// one step out, and the chat list and the Settings column 4px further from
// the screen edge (row fills from 12px, text and icons from 20px).

type Box = Readonly<{ height: number; width: number; x: number; y: number }>;

async function boxOf(locator: Locator, name: string): Promise<Box> {
  await expect(locator, `${name} is visible`).toBeVisible();
  const box = await locator.boundingBox();
  expect(box, `${name} has a box`).not.toBeNull();
  return box!;
}

function near(actual: number, expected: number, name: string, tolerance = 1): void {
  expect(Math.abs(actual - expected), `${name}: ${actual.toFixed(2)} ≈ ${expected}`).toBeLessThanOrEqual(tolerance);
}

/** Where an element's first visible text starts and ends. */
async function textBounds(locator: Locator): Promise<Readonly<{ left: number; right: number }>> {
  const bounds = await locator.evaluate((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent?.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const rect = range.getBoundingClientRect();
      if (rect.width > 0) return { left: rect.left, right: rect.right };
    }
    return null;
  });
  expect(bounds, "the element shows text").not.toBeNull();
  return bounds!;
}

/** A classic scrollbar takes width from the rows; an overlay one does not. */
async function scrollbarTakesWidth(locator: Locator): Promise<boolean> {
  return locator.evaluate((element: HTMLElement) => {
    const style = getComputedStyle(element);
    return element.offsetWidth - element.clientWidth - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth) > 0.5;
  });
}

/** A viewport screenshot for the Vision pass; never an element shot taller than the viewport. */
async function viewportShot(page: Page, info: TestInfo, name: string): Promise<void> {
  await page.screenshot({ path: info.outputPath(`${name}.png`) });
}

/**
 * The chat list has one 12px fill edge (New chat, the filter, the rows), its
 * titles and group labels start at 20px, and no title runs under its menu.
 */
async function expectChatListEdges(page: Page, label: string): Promise<void> {
  const navigation = page.getByRole("complementary", { name: "Chat navigation" });
  if (!(await navigation.isVisible())) {
    await page.getByRole("button", { name: "Open sidebar" }).click();
    await expect(navigation).toBeVisible();
  }
  const left = (await boxOf(navigation, `${label}: chat list`)).x;
  near((await boxOf(navigation.locator(".v2-new-chat-wrap"), "New chat")).x - left, 12, `${label}: New chat fill`);
  near((await boxOf(navigation.locator(".v2-navigation-filter input"), "chat filter")).x - left, 12, `${label}: filter`);
  const wrap = navigation.locator(".v2-chat-row-wrap").first();
  near((await boxOf(wrap.locator(".v2-chat-row"), "chat row")).x - left, 12, `${label}: chat row fill`);
  const title = await textBounds(wrap.locator(".v2-chat-title"));
  near(title.left - left, 20, `${label}: chat title`);
  near((await textBounds(navigation.locator(".v2-navigation-group-label").first())).left - left, 20, `${label}: group label`);
  const trigger = await wrap.locator(".v2-chat-menu-trigger").boundingBox();
  expect(trigger, `${label}: the row's menu button`).not.toBeNull();
  expect(title.right, `${label}: the title ends before its menu button`).toBeLessThanOrEqual(trigger!.x + 0.5);
}

/**
 * From 1024px: Back to chat is the first row of the section column, above
 * General, on the column's edges; the crumb row has nothing at its end outside
 * a sub-view; the column has no "Settings" title and the page one h1.
 */
async function expectWideSettingsColumn(page: Page, label: string): Promise<void> {
  const library = page.getByTestId("library-v2");
  const left = (await boxOf(library, `${label}: Settings`)).x;
  const exit = library.getByRole("button", { name: "Back to chat", exact: true });
  await expect(exit).toHaveCount(1);
  const exitBox = await boxOf(exit, `${label}: Back to chat`);
  near(exitBox.x - left, 12, `${label}: Back to chat fill left`);
  near(exitBox.x + exitBox.width - left, 247, `${label}: Back to chat fill right`);
  near((await boxOf(exit.locator(".v2-library-exit-arrow"), "Back to chat arrow")).x - left, 20, `${label}: Back to chat arrow`);
  const list = library.getByRole("tablist", { name: "Settings sections" });
  const general = list.getByRole("tab", { name: "General", exact: true });
  const generalBox = await boxOf(general, `${label}: General`);
  expect(exitBox.y + exitBox.height, `${label}: Back to chat above General`).toBeLessThanOrEqual(generalBox.y + 0.5);
  near(generalBox.x - left, 12, `${label}: section row fill left`);
  if (!(await scrollbarTakesWidth(list))) near(generalBox.x + generalBox.width - left, 247, `${label}: section row fill right`);
  near((await boxOf(general.locator(".v2-icon").first(), "General icon")).x - left, 20, `${label}: section icon`);
  near((await textBounds(list.locator(".v2-library-column-label").first())).left - left, 20, `${label}: group label`);
  const signal = list.locator(".v2-library-tab-signal").first();
  if (await signal.count()) {
    const icon = await boxOf(signal.locator("xpath=..").locator(".v2-icon").first(), "flagged section icon");
    const dot = await boxOf(signal, "attention dot");
    expect(Math.abs(dot.x + dot.width / 2 - (icon.x + icon.width)), `${label}: the dot sits on its icon's corner`).toBeLessThanOrEqual(4);
    expect(Math.abs(dot.y + dot.height / 2 - icon.y), `${label}: the dot sits on its icon's corner`).toBeLessThanOrEqual(4);
  }
  await expect(library.locator(".v2-library-heading-row button:visible"), `${label}: nothing at the crumb row's end`).toHaveCount(0);
  await expect(library.locator(".v2-library-exit-bar, .v2-library-tabs-scroll").getByText("Settings", { exact: true })).toHaveCount(0);
  await expect(library.getByRole("heading", { level: 1, name: "Settings" })).toHaveCount(1);
}

/** Below 1024px, the list: the back arrow left of "Settings", its icon on the section icons' edge, nothing at the right. */
async function expectNarrowList(page: Page, label: string): Promise<void> {
  const library = page.getByTestId("library-v2");
  await expect(library).toHaveAttribute("data-view", "list");
  const title = await boxOf(library.getByRole("heading", { level: 1, name: "Settings" }), `${label}: Settings title`);
  const exit = library.getByRole("button", { name: "Back to chat", exact: true });
  const exitBox = await boxOf(exit, `${label}: back arrow`);
  expect(exitBox.x, `${label}: the arrow stays on screen`).toBeGreaterThanOrEqual(-0.5);
  expect(exitBox.x + exitBox.width, `${label}: the arrow is left of the title`).toBeLessThanOrEqual(title.x + 0.5);
  near(exitBox.y + exitBox.height / 2, title.y + title.height / 2, `${label}: the arrow and the title share a line`, 2);
  await expect(exit.locator(".v2-library-exit-arrow")).toBeVisible();
  await expect(exit.locator(".v2-library-exit-close")).toBeHidden();
  const list = library.getByRole("tablist", { name: "Settings sections" });
  if (!(await scrollbarTakesWidth(list))) {
    const general = list.getByRole("tab", { name: "General", exact: true });
    near((await boxOf(exit.locator(".v2-library-exit-arrow"), "arrow icon")).x,
      (await boxOf(general.locator(".v2-icon").first(), "General icon")).x, `${label}: the arrow on the section icons' edge`);
  }
  await expect(library.locator(".v2-library-heading-row button:visible"), `${label}: nothing at the right`).toHaveCount(0);
}

/** Below 1024px, a section: Back to Settings at the left, the close control named Back to chat at the right end. */
async function expectNarrowSection(page: Page, label: string): Promise<void> {
  const library = page.getByTestId("library-v2");
  await expect(library).toHaveAttribute("data-view", "section");
  const libraryBox = await boxOf(library, `${label}: Settings`);
  const exit = library.getByRole("button", { name: "Back to chat", exact: true });
  const exitBox = await boxOf(exit, `${label}: close control`);
  near(libraryBox.x + libraryBox.width - (exitBox.x + exitBox.width), 8, `${label}: the close control at the right end`);
  await expect(exit.locator(".v2-library-exit-close")).toBeVisible();
  await expect(exit.locator(".v2-library-exit-arrow")).toBeHidden();
  const back = await boxOf(library.getByRole("button", { name: "Back to Settings", exact: true }), `${label}: Back to Settings`);
  expect(back.x + back.width, `${label}: Back to Settings before the close control`).toBeLessThan(exitBox.x);
  const crumb = await boxOf(library.getByRole("navigation", { name: "Settings location" }), `${label}: crumb`);
  expect(crumb.x + crumb.width, `${label}: the crumb keeps clear of the close control`).toBeLessThanOrEqual(exitBox.x + 0.5);
}

for (const theme of ["dark", "light"] as const) {
  test(`Back to chat at the top left and the list edges across widths · ${theme}`, async ({ page }, info) => {
    test.setTimeout(180_000);
    page.setDefaultTimeout(15_000);
    await page.context().addCookies([{ name: "aiqsa.theme", value: theme, url: "http://127.0.0.1:3000" }]);
    await page.setViewportSize({ width: 1440, height: 900 });
    await prepare(page);
    const library = page.getByTestId("library-v2");

    // The chat list at 1440, then in the drawer at 820 and 390.
    await expectChatListEdges(page, "1440 list");
    await viewportShot(page, info, `exit-${theme}-chat-list-1440x900`);
    for (const size of [{ width: 820, height: 1180 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(size);
      await expectChatListEdges(page, `${size.width} drawer`);
      await expectNoHorizontalOverflow(page);
      await viewportShot(page, info, `exit-${theme}-chat-drawer-${size.width}x${size.height}`);
      await page.keyboard.press("Escape");
    }

    // Settings from 1024px: plain, with a sub-view, scrolled in a short window, at 1024.
    await page.setViewportSize({ width: 1440, height: 900 });
    await runAccountMenuAction(page, "Data");
    await expectWideSettingsColumn(page, "1440");
    await expectNoHorizontalOverflow(page);
    await viewportShot(page, info, `exit-${theme}-settings-1440x900`);
    await library.getByRole("button", { name: "Manage", exact: true }).click();
    const backToData = library.getByRole("button", { name: "Back to Data", exact: true });
    await expect(backToData).toBeFocused();
    // Back to chat stays beside the sub-view, after the crumb's buttons in keyboard order.
    const exit = library.getByRole("button", { name: "Back to chat", exact: true });
    await expect(exit).toBeVisible();
    expect((await boxOf(backToData, "Back to Data")).x, "the sub-view's Back at the crumb row's end").toBeGreaterThan(1440 / 2);
    await page.keyboard.press("Tab");
    await expect(exit).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(library.getByRole("tab", { name: "Data", exact: true })).toBeFocused();
    await viewportShot(page, info, `exit-${theme}-settings-subview-1440x900`);
    await backToData.click();

    await page.setViewportSize({ width: 1280, height: 600 });
    const list = library.getByRole("tablist", { name: "Settings sections" });
    const before = await boxOf(exit, "Back to chat before scrolling");
    await list.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    expect(await list.evaluate((element) => element.scrollTop), "the short window scrolls the list").toBeGreaterThan(0);
    const after = await boxOf(exit, "Back to chat after scrolling");
    near(after.y, before.y, "Back to chat stays in place while the list scrolls");
    await expect(exit).toBeInViewport();
    await expectNoHorizontalOverflow(page);
    await viewportShot(page, info, `exit-${theme}-settings-scrolled-1280x600`);
    await list.evaluate((element) => { element.scrollTop = 0; });

    await page.setViewportSize({ width: 1024, height: 768 });
    await expectWideSettingsColumn(page, "1024");
    await expectNoHorizontalOverflow(page);
    await viewportShot(page, info, `exit-${theme}-settings-1024x768`);

    // Below 1024px the list and a section take turns.
    for (const size of [{ width: 820, height: 1180 }, { width: 390, height: 844 }, { width: 844, height: 390 }, { width: 320, height: 640 }]) {
      await page.setViewportSize(size);
      if (await library.getAttribute("data-view") === "section") {
        await library.getByRole("button", { name: "Back to Settings", exact: true }).click();
      }
      await expectNarrowList(page, `${size.width} list`);
      await expectNoHorizontalOverflow(page);
      await viewportShot(page, info, `exit-${theme}-settings-list-${size.width}x${size.height}`);
      await list.getByRole("tab", { name: "Data", exact: true }).click();
      await expectNarrowSection(page, `${size.width} section`);
      await expectNoHorizontalOverflow(page);
      await viewportShot(page, info, `exit-${theme}-settings-section-${size.width}x${size.height}`);
    }
    await library.getByRole("button", { name: "Back to chat", exact: true }).click();
    await expect(library).toBeHidden();
  });
}

/** What holds focus, by tag and name, to compare two ways of leaving Settings. */
async function focusedControl(page: Page): Promise<string> {
  return page.evaluate(() => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || active === document.body) return "body";
    return `${active.tagName}:${active.getAttribute("aria-label") ?? active.textContent?.trim() ?? ""}`;
  });
}

test("Escape leaves Settings one step at a time, yields to what uses it and never leaves from a field · desktop 1440×900", async ({ page }) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(15_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await prepare(page);
  const library = page.getByTestId("library-v2");
  const confirmation = page.getByTestId("discard-changes-confirmation");

  // From a section row, the section and a button: back to the chat, focus where Back to chat puts it.
  await runAccountMenuAction(page, "General");
  await library.getByRole("button", { name: "Back to chat", exact: true }).click();
  await expect(library).toBeHidden();
  const expectedFocus = await focusedControl(page);
  for (const start of ["row", "section", "button"] as const) {
    await runAccountMenuAction(page, "General");
    if (start === "row") await library.getByRole("tab", { name: "General", exact: true }).focus();
    else if (start === "section") await library.getByRole("tabpanel").focus();
    else await library.getByRole("button", { name: "Back to chat", exact: true }).focus();
    await page.keyboard.press("Escape");
    await expect(library, `Escape from the ${start} leaves`).toBeHidden();
    await expect.poll(() => focusedControl(page), `focus after Escape from the ${start}`).toBe(expectedFocus);
  }
  // Outside Settings the key changes nothing.
  await page.keyboard.press("Escape");
  await expect(library).toBeHidden();

  // A field keeps Settings, a confirmation closes first, then Escape leaves.
  await runAccountMenuAction(page, "Memory");
  await library.getByRole("textbox", { name: "Memory note", exact: true }).focus();
  await page.keyboard.press("Escape");
  await expect(library).toBeVisible();
  await library.getByRole("button", { name: "Clear note…", exact: true }).click();
  const clear = page.getByTestId("memory-note-clear-confirmation");
  await expect(clear).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(clear).toHaveCount(0);
  await expect(library).toBeVisible();
  await library.getByRole("tab", { name: "Memory", exact: true }).focus();
  await page.keyboard.press("Escape");
  await expect(library).toBeHidden();

  // A dropdown closes first; the next Escape leaves.
  await runAccountMenuAction(page, "Chat defaults");
  const dropdown = library.getByRole("button", { name: "Default model", exact: true });
  await expect(dropdown).toBeEnabled();
  await dropdown.click();
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(library).toBeVisible();
  await dropdown.focus();
  await page.keyboard.press("Escape");
  await expect(library).toBeHidden();

  // A sub-view: Escape in its fields does nothing; elsewhere it does what Back does, asking first about changes.
  await runAccountMenuAction(page, "Instructions");
  await library.getByRole("button", { name: "New preset", exact: true }).click();
  const name = library.getByRole("textbox", { name: "Name", exact: true });
  await expect(name).toBeFocused();
  await name.fill("Escape draft");
  await page.keyboard.press("Escape");
  await expect(name).toHaveValue("Escape draft");
  const backToInstructions = library.getByRole("button", { name: "Back to Instructions", exact: true });
  await backToInstructions.focus();
  await page.keyboard.press("Escape");
  await expect(confirmation).toBeVisible();
  // The question closes first and the editor stays.
  await page.keyboard.press("Escape");
  await expect(confirmation).toHaveCount(0);
  await expect(name).toHaveValue("Escape draft");
  await expect(library).toBeVisible();
  await backToInstructions.click();
  await confirmation.getByRole("button", { name: /Confirm discard/ }).click();
  await expect(name).toHaveCount(0);
  await library.getByRole("tab", { name: "Instructions", exact: true }).focus();
  await page.keyboard.press("Escape");
  await expect(library).toBeHidden();

  // A changed Assistant editor: Back to chat asks as a section switch does, and Keep editing stays in it.
  const draft = await openDraft(page, "Assistants");
  await library.getByRole("button", { name: "Back to chat", exact: true }).click();
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole("button", { name: "Keep editing", exact: true }).click();
  await expect(draft).toHaveValue("Unsaved Settings assistant");
  await library.getByRole("button", { name: "Back to Assistants", exact: true }).focus();
  await page.keyboard.press("Escape");
  await expect(confirmation).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(confirmation).toHaveCount(0);
  await expect(draft).toHaveValue("Unsaved Settings assistant");
  await library.getByRole("button", { name: "Back to Assistants", exact: true }).click();
  await confirmation.getByRole("button", { name: /Confirm discard/ }).click();
  await expect(draft).toHaveCount(0);
  await expect(library).toBeVisible();
});

import { randomUUID } from "node:crypto";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { providerTemplateIds } from "../../lib/domain/providerTemplates";
import { deleteOwnedChatPermanently } from "./support/chatCleanup";
import { authenticateWithLocalToken } from "./support/localAuth";
import { runAccountMenuAction } from "./shell/page";

// Shell touch targets (task 20260928115816727): on touch every shell control
// is a 44px target, the chat list's footer (account, Announcements, Settings)
// included, the collapsed-list floats never cover the header model button or
// title, and the phone islands keep one 8px rhythm. The fine pointer layout
// keeps its 32px footer icons and 32–34px header controls.

type Box = Readonly<{ height: number; width: number; x: number; y: number }>;

const touchRule = "(hover: none), (pointer: coarse)";

async function boxOf(locator: Locator, name: string): Promise<Box> {
  await expect(locator, `${name} is visible`).toBeVisible();
  const box = await locator.boundingBox();
  expect(box, `${name} has a box`).not.toBeNull();
  return box!;
}

async function expectTarget(locator: Locator, name: string): Promise<Box> {
  const box = await boxOf(locator, name);
  expect(box.width, `${name} width`).toBeGreaterThanOrEqual(43.99);
  expect(box.height, `${name} height`).toBeGreaterThanOrEqual(43.99);
  return box;
}

async function expectTouchHeight(locator: Locator, name: string): Promise<Box> {
  const box = await boxOf(locator, name);
  expect(box.height, `${name} height`).toBeGreaterThanOrEqual(43.99);
  return box;
}

function expectInside(box: Box, frame: Box, name: string): void {
  expect(box.x, `${name} left`).toBeGreaterThanOrEqual(frame.x - 0.5);
  expect(box.y, `${name} top`).toBeGreaterThanOrEqual(frame.y - 0.5);
  expect(box.x + box.width, `${name} right`).toBeLessThanOrEqual(frame.x + frame.width + 0.5);
  expect(box.y + box.height, `${name} bottom`).toBeLessThanOrEqual(frame.y + frame.height + 0.5);
}

async function expectSize(locator: Locator, name: string, size: Readonly<{ height: number; width?: number }>) {
  const box = await boxOf(locator, name);
  expect(Math.abs(box.height - size.height), `${name} height ${box.height}`).toBeLessThanOrEqual(0.5);
  if (size.width !== undefined) {
    expect(Math.abs(box.width - size.width), `${name} width ${box.width}`).toBeLessThanOrEqual(0.5);
  }
  return box;
}

function intersects(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

async function createOwnedChat(page: Page): Promise<Readonly<{ chatId: string; title: string }>> {
  await authenticateWithLocalToken(page.request);
  const title = `Touch geometry ${randomUUID().slice(0, 8)}`;
  const response = await page.request.post("/api/chats", { data: { memoryMode: "EXCLUDED", title } });
  expect(response.status()).toBe(201);
  const chatId = ((await response.json()) as { chat: { id: string } }).chat.id;
  return { chatId, title };
}

async function openChat(page: Page, path: string): Promise<Locator> {
  await page.goto(path);
  await expect(page.getByTestId("app-shell")).toBeVisible({ timeout: 30_000 });
  const model = page.getByTestId("header-model-trigger");
  await expect(model).toBeEnabled({ timeout: 30_000 });
  return model;
}

function sidebarFloats(page: Page) {
  const floats = page.locator(".v2-sidebar-floats");
  return {
    newChat: floats.getByRole("link", { exact: true, name: "New chat" }),
    showList: floats.getByRole("button", { name: "Open sidebar" })
  };
}

/**
 * The chat list's footer on touch: the account entry, Announcements and the
 * Settings gear are 44px targets on one row, inside the drawer and on screen,
 * and the row does not overflow at the drawer's width.
 */
async function expectFooterTargets(page: Page, viewport: Readonly<{ height: number; width: number }>): Promise<void> {
  const navigation = page.getByRole("complementary", { name: "Chat navigation" });
  await sidebarFloats(page).showList.click();
  await expect(navigation).toBeVisible();
  // Below 1024px the list is an overlay drawer from the left edge, as wide as
  // on a phone (17.5rem, or the viewport less 3rem).
  const drawer = await boxOf(navigation, "chat list drawer");
  expect(Math.abs(drawer.x), "drawer starts at the left edge").toBeLessThanOrEqual(0.5);
  expect(Math.abs(drawer.width - Math.min(280, viewport.width - 48)), `drawer width ${drawer.width}`).toBeLessThanOrEqual(0.5);

  const footer = page.getByTestId("navigation-footer");
  const row = footer.locator(".v2-navigation-footer-bar");
  const bar = await boxOf(row, "footer row");
  const account = await expectTarget(footer.getByRole("button", { exact: true, name: "Account menu" }), "Account menu");
  const bell = await expectTarget(footer.getByRole("button", { name: /^Announcements/ }), "Announcements");
  const gear = await expectTarget(footer.getByRole("button", { exact: true, name: "Settings" }), "Settings");
  for (const [name, box] of [["Account menu", account], ["Announcements", bell], ["Settings", gear]] as const) {
    expectInside(box, bar, `${name} inside the footer row`);
    expectInside(box, drawer, `${name} inside the drawer`);
    expect(box.y + box.height, `${name} stays on screen`).toBeLessThanOrEqual(viewport.height + 0.5);
  }
  expect(bell.x, "Announcements after the account entry").toBeGreaterThanOrEqual(account.x + account.width - 0.5);
  expect(gear.x, "Settings after Announcements").toBeGreaterThanOrEqual(bell.x + bell.width - 0.5);
  expect(Math.abs(bell.y - gear.y), "one footer row").toBeLessThanOrEqual(1);
  expect(await row.evaluate((element) => element.scrollWidth <= element.clientWidth), "the footer row does not overflow").toBe(true);

  await navigation.getByRole("button", { exact: true, name: "Close sidebar" }).click();
  await expect(navigation).toBeHidden();
}

/** 768–1023px touch: 44px header controls, floats clear of the model and title. */
async function expectCompactTouchHeader(page: Page, model: Locator, title: string): Promise<void> {
  await expect(page.locator(".v2-workspace-shell")).toHaveAttribute("data-sidebar-composition", "compact");
  const header = page.locator(".v2-live-header");
  const titleButton = page.getByTestId("header-title");
  await expect(titleButton).toContainText(title);
  const modelBox = await expectTarget(model, "header model button");
  const titleBox = await expectTarget(titleButton, "chat title button");
  await expectTarget(header.getByRole("button", { exact: true, name: "Share" }), "Share");
  await expectTarget(page.getByTestId("header-more-trigger"), "Chat actions");
  await expectTouchHeight(page.getByTestId("header-context-indicator"), "context gauge");

  const floats = sidebarFloats(page);
  for (const [name, float] of [["Show list float", floats.showList], ["New chat float", floats.newChat]] as const) {
    const box = await expectTarget(float, name);
    expect(intersects(box, modelBox), `${name} overlaps the model button`).toBe(false);
    expect(intersects(box, titleBox), `${name} overlaps the chat title`).toBe(false);
  }

  // The model button's left end belongs to the model button, not to "+".
  const point = { x: modelBox.x + 4, y: modelBox.y + modelBox.height / 2 };
  expect(await page.evaluate(({ x, y }) =>
    Boolean(document.elementFromPoint(x, y)?.closest("[data-testid='header-model-trigger']")), point
  ), "the left end of the model button is on top").toBe(true);
  await page.touchscreen.tap(point.x, point.y);
  await expect(model).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await expect(model).toHaveAttribute("aria-expanded", "false");
}

/** Phone touch: the islands sit on one row, 8px apart around the centred pill. */
async function expectPhoneIslandGaps(page: Page): Promise<void> {
  const floats = sidebarFloats(page);
  const menu = await expectTarget(floats.showList, "menu island");
  const island = await boxOf(page.locator(".v2-live-header-island"), "model island");
  const plus = await expectTarget(floats.newChat, "New chat island");
  const left = island.x - (menu.x + menu.width);
  const right = plus.x - (island.x + island.width);
  expect(left, "menu → model gap").toBeGreaterThanOrEqual(7.5);
  expect(right, "model → New chat gap").toBeGreaterThanOrEqual(7.5);
  expect(Math.abs(left - right), `model pill gaps ${left} / ${right}`).toBeLessThanOrEqual(1);
  expect(Math.abs(island.y - menu.y), "model island row").toBeLessThanOrEqual(1);
  expect(Math.abs(plus.y - menu.y), "New chat island row").toBeLessThanOrEqual(1);
  // "+" and "⋯" share one island split by a hairline (operator decision 2026-10-29).
  const more = await expectTarget(page.getByTestId("header-more-trigger"), "Chat actions");
  const actionsGap = more.x - (plus.x + plus.width);
  expect(Math.abs(actionsGap - 2), `New chat → Chat actions gap ${actionsGap}`).toBeLessThanOrEqual(1);
  expect(Math.abs(more.y - menu.y), "Chat actions row").toBeLessThanOrEqual(1);
  const shared = await page.locator(".v2-live-more").evaluate((element) => ({
    divider: getComputedStyle(element, "::after").content,
    island: getComputedStyle(element, "::before").width
  }));
  expect(shared.divider, "hairline between New chat and Chat actions").not.toBe("none");
  expect(Math.abs(parseFloat(shared.island) - (more.x + more.width - plus.x)), "one island spans both").toBeLessThanOrEqual(1);
}

/**
 * Phone touch on a blank chat: the Temporary switch takes the New chat
 * island's place (Temporary became a header switch on 2026-10-20).
 */
async function expectPhoneBlankChatIslands(page: Page): Promise<void> {
  const floats = sidebarFloats(page);
  await expect(floats.newChat).toBeHidden();
  const menu = await expectTarget(floats.showList, "menu island");
  const island = await boxOf(page.locator(".v2-live-header-island"), "model island");
  const temporary = await expectTarget(page.getByTestId("header-temporary-toggle"), "Temporary island");
  expect(island.x - (menu.x + menu.width), "menu → model gap").toBeGreaterThanOrEqual(7.5);
  expect(temporary.x - (island.x + island.width), "model → Temporary gap").toBeGreaterThanOrEqual(7.5);
  expect(Math.abs(island.y - menu.y), "model island row").toBeLessThanOrEqual(1);
  expect(Math.abs(temporary.y - menu.y), "Temporary island row").toBeLessThanOrEqual(1);
}

/**
 * Phone touch: the model button and the Assistant segment (when rendered)
 * fill the 44px model island instead of its border-reduced content box.
 */
async function expectPhoneIslandSegments(page: Page): Promise<void> {
  const island = await expectTouchHeight(page.locator(".v2-live-header-island"), "model island");
  const model = await expectTouchHeight(page.getByTestId("header-model-trigger"), "header model button");
  expectInside(model, island, "header model button inside the island");
  const assistant = page.locator(".v2-live-header-island > .v2-live-assistant");
  if (await assistant.count() && await assistant.isVisible()) {
    expectInside(await expectTouchHeight(assistant, "Assistant segment"), island, "Assistant segment inside the island");
  }
}

/**
 * Settings on touch, where the list and a section take turns: the header row
 * is 56px, so the 44px Back controls keep room above and below inside it, and
 * the section starts under the header. Leaves Settings for the chat.
 */
async function expectSettingsHeaderRoom(page: Page): Promise<void> {
  await runAccountMenuAction(page, "Data");
  const settings = page.getByTestId("library-v2");
  await expect(settings).toHaveAttribute("data-view", "section");
  const header = settings.locator(".v2-library-heading-row");
  const backToSettings = settings.getByRole("button", { exact: true, name: "Back to Settings" });
  const backToChat = settings.getByRole("button", { exact: true, name: "Back to chat" });
  const expectRoom = async (control: Locator, name: string) => {
    const headerBox = await boxOf(header, "Settings header");
    expect(headerBox.height, "Settings header height").toBeGreaterThanOrEqual(55.99);
    const box = await expectTarget(control, name);
    expect(box.y - headerBox.y, `${name} room above`).toBeGreaterThanOrEqual(5.49);
    expect(headerBox.y + headerBox.height - (box.y + box.height), `${name} room below`).toBeGreaterThanOrEqual(5.49);
    const panel = await boxOf(settings.locator(".v2-library-panel"), "Settings section");
    expect(panel.y, "the section starts under the header").toBeGreaterThanOrEqual(headerBox.y + headerBox.height - 0.5);
  };
  await expectRoom(backToSettings, "Back to Settings");
  await expectRoom(backToChat, "Back to chat");

  await settings.getByRole("button", { exact: true, name: "Manage" }).click();
  const back = settings.getByRole("button", { exact: true, name: "Back to Data" });
  await expect(back).toBeFocused();
  await expectRoom(back, "Back to Data");
  await back.click();
  await expect(settings.getByRole("button", { exact: true, name: "Manage" })).toBeVisible();

  // The list of sections: Back to chat is a 44px back arrow left of the title, with nothing at the right.
  await backToSettings.click();
  await expect(settings).toHaveAttribute("data-view", "list");
  const listHeader = await boxOf(header, "Settings header");
  const arrow = await expectTarget(backToChat, "Back to chat arrow");
  expect(arrow.y - listHeader.y, "Back to chat arrow room above").toBeGreaterThanOrEqual(5.49);
  expect(listHeader.y + listHeader.height - (arrow.y + arrow.height), "Back to chat arrow room below").toBeGreaterThanOrEqual(5.49);
  const title = await boxOf(settings.getByRole("heading", { level: 1, name: "Settings" }), "Settings title");
  expect(arrow.x, "the arrow on screen").toBeGreaterThanOrEqual(-0.5);
  expect(arrow.x + arrow.width, "the arrow left of the title").toBeLessThanOrEqual(title.x + 0.5);
  await expect(header.locator("button:visible"), "nothing at the header's right").toHaveCount(0);
  await backToChat.click();
  await expect(settings).toBeHidden();
}

/** Settings › Instructions: the Back controls and the instruction variables are 44px targets. */
async function expectInstructionsTargets(page: Page): Promise<void> {
  await runAccountMenuAction(page, "Instructions");
  const library = page.getByTestId("library-v2");
  const newPreset = page.getByRole("button", { name: "New preset" });
  await expect(newPreset).toBeEnabled({ timeout: 30_000 });
  const row = library.locator(".v2-library-heading-row");
  const expectBack = async (name: string) => {
    const box = await expectTarget(library.getByRole("button", { exact: true, name }), name);
    // The touch header row is 56px around 44px controls at every width.
    const rowBox = await boxOf(row, "Settings header row");
    expect(box.y - rowBox.y, `${name} room above`).toBeGreaterThanOrEqual(4);
    expect(rowBox.y + rowBox.height - (box.y + box.height), `${name} room below`).toBeGreaterThanOrEqual(4);
  };
  await expectBack("Back to Settings");
  await expectBack("Back to chat");

  // Opening an empty editor saves nothing.
  await newPreset.click();
  await expectBack("Back to Instructions");
  const editor = page.getByTestId("settings-instructions").locator(".v2-markdown-editor").first();
  await expectTarget(editor.getByRole("button", { name: "Insert date" }), "Insert date");
  await expectTarget(editor.getByRole("button", { name: "Insert time" }), "Insert time");
}

/** Composer menu links (component fixtures): the MCP layer's MCP servers and settings links. */
async function expectComposerLinkTargets(page: Page): Promise<void> {
  await page.goto("/ui-v2-fixture?fixture=composer&state=mcp-personal");
  const picker = page.getByRole("menu", { name: "MCP tools" });
  await expect(picker).toBeVisible();
  const connections = picker.getByRole("menuitem", { name: "Open MCP servers in Settings for Notion" });
  await connections.scrollIntoViewIfNeeded();
  await expectTarget(connections, "MCP servers");
  const manage = picker.getByRole("menuitem", { name: "Manage enabled MCP servers" });
  await manage.scrollIntoViewIfNeeded();
  await expectTarget(manage, "Manage enabled MCP servers");
}

const compactTouchProfiles = [
  { height: 1024, isMobile: false, label: "tablet portrait 768×1024", width: 768 },
  { height: 390, isMobile: true, label: "phone landscape 844×390", width: 844 }
] as const;

for (const profile of compactTouchProfiles) {
  test.describe(`shell touch targets · ${profile.label}`, () => {
    test.use({
      hasTouch: true,
      isMobile: profile.isMobile,
      viewport: { height: profile.height, width: profile.width }
    });

    test(`list footer, header, floats, Settings and composer links are 44px touch targets · ${profile.label}`, async ({ page }) => {
      test.setTimeout(120_000);
      const { chatId, title } = await createOwnedChat(page);
      try {
        const model = await openChat(page, `/c/${chatId}`);
        expect(await page.evaluate((rule) => matchMedia(rule).matches, touchRule)).toBe(true);
        await expectFooterTargets(page, profile);
        await expectCompactTouchHeader(page, model, title);
        await expectSettingsHeaderRoom(page);
        await expectInstructionsTargets(page);
        await expectComposerLinkTargets(page);
      } finally {
        await deleteOwnedChatPermanently(page.request, chatId);
      }
    });
  });
}

test.describe("shell touch targets · phone portrait 390×844", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { height: 844, width: 390 } });

  test("phone islands keep equal gaps and the list footer, Settings and composer links are 44px touch targets · phone portrait 390×844", async ({ page }) => {
    test.setTimeout(150_000);
    const { chatId } = await createOwnedChat(page);
    try {
      await openChat(page, "/");
      expect(await page.evaluate((rule) => matchMedia(rule).matches, touchRule)).toBe(true);
      await expect(page.locator(".v2-workspace-shell")).toHaveAttribute("data-sidebar-composition", "mobile");
      await expectFooterTargets(page, { height: 844, width: 390 });
      await expectPhoneBlankChatIslands(page);
      await expectPhoneIslandSegments(page);

      await openChat(page, `/c/${chatId}`);
      await expect(page.locator(".v2-workspace-shell")).toHaveAttribute("data-chat-active", "true");
      await expectPhoneIslandGaps(page);
      await expectPhoneIslandSegments(page);
      // Settings from a personal chat.
      await expectSettingsHeaderRoom(page);

      await openChat(page, `/c/${chatId}`);
      await expectInstructionsTargets(page);
      await expectComposerLinkTargets(page);
    } finally {
      await deleteOwnedChatPermanently(page.request, chatId);
    }
  });
});

test("fine pointer keeps the 32px footer icons, compact header controls and 48px Settings crumb row · desktop 1440×900", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ height: 900, width: 1440 });
  const { chatId, title } = await createOwnedChat(page);
  try {
    const model = await openChat(page, `/c/${chatId}`);
    expect(await page.evaluate((rule) => matchMedia(rule).matches, touchRule)).toBe(false);
    await expect(page.getByTestId("header-title")).toContainText(title);

    // The list footer: a 44px account row beside the 32px bell and gear.
    const footer = page.getByTestId("navigation-footer");
    await expectSize(footer.getByRole("button", { exact: true, name: "Account menu" }), "Account menu", { height: 44 });
    await expectSize(footer.getByRole("button", { name: /^Announcements/ }), "Announcements", { height: 32, width: 32 });
    await expectSize(footer.getByRole("button", { exact: true, name: "Settings" }), "Settings", { height: 32, width: 32 });
    await expectSize(model, "header model button", { height: 34 });
    await expectSize(page.getByTestId("header-title"), "chat title button", { height: 34 });
    await expectSize(page.locator(".v2-live-header").getByRole("button", { exact: true, name: "Share" }), "Share", { height: 32 });
    await expectSize(page.getByTestId("header-more-trigger"), "Chat actions", { height: 32, width: 32 });

    // Collapsed list: the 32px floats end 8px before the model button.
    await page.getByRole("button", { name: "Close sidebar" }).click();
    await expect(page.locator(".v2-workspace-shell")).toHaveAttribute("data-sidebar-collapsed", "true");
    const floats = sidebarFloats(page);
    await expectSize(floats.showList, "Show list float", { height: 32, width: 32 });
    const plus = await expectSize(floats.newChat, "New chat float", { height: 32, width: 32 });
    const modelBox = await boxOf(model, "header model button");
    expect(Math.abs(modelBox.x - (plus.x + plus.width) - 8), "float → model gap").toBeLessThanOrEqual(1);
    await floats.showList.click();
    await expect(page.locator(".v2-workspace-shell")).not.toHaveAttribute("data-sidebar-collapsed", "true");

    await runAccountMenuAction(page, "Settings");
    await expectSize(page.getByTestId("library-v2").locator(".v2-library-heading-row"), "Settings crumb row", { height: 48 });

    // A desktop collapse that survives a resize to phone width leaves the
    // phone header its own left padding, as on a fresh phone load.
    await openChat(page, `/c/${chatId}`);
    await page.getByRole("button", { name: "Close sidebar" }).click();
    await expect(page.locator(".v2-workspace-shell")).toHaveAttribute("data-sidebar-collapsed", "true");
    await page.setViewportSize({ height: 844, width: 390 });
    await expect(page.locator(".v2-workspace-shell")).toHaveAttribute("data-sidebar-composition", "mobile");
    await expect(page.locator(".v2-workspace-shell")).toHaveAttribute("data-sidebar-collapsed", "true");
    const headerPadding = () => page.locator(".v2-live-header").evaluate((element) => getComputedStyle(element).paddingLeft);
    const resized = await headerPadding();
    await openChat(page, `/c/${chatId}`);
    await expect(page.locator(".v2-workspace-shell")).not.toHaveAttribute("data-sidebar-collapsed", "true");
    expect(resized, "phone header padding after a collapsed desktop resize").toBe(await headerPadding());
  } finally {
    await deleteOwnedChatPermanently(page.request, chatId);
  }
});

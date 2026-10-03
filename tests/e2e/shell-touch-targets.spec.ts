import { randomUUID } from "node:crypto";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { providerTemplateIds } from "../../lib/domain/providerTemplates";
import { deleteOwnedChatPermanently } from "./support/chatCleanup";
import { authenticateWithLocalToken } from "./support/localAuth";
import { runAccountMenuAction } from "./shell/page";

// Shell touch targets (task 20260928115816727): on touch every shell control
// is a 44px target, the collapsed-list floats never cover the header model
// button or title, and the phone islands keep one 8px rhythm. The fine
// pointer layout keeps its 40px rail and 32–34px header controls.

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

/** A Project with one shared chat; the caller deletes the Project. */
async function createOwnedProjectChat(page: Page): Promise<Readonly<{ chatId: string; projectId: string }>> {
  await authenticateWithLocalToken(page.request);
  const suffix = randomUUID().slice(0, 8);
  const project = await page.request.post("/api/projects", {
    data: { name: `Touch geometry Project ${suffix}`, preferredModelId: providerTemplateIds.fakeModel }
  });
  expect(project.status(), await project.text()).toBe(201);
  const projectId = ((await project.json()) as { project: { id: string } }).project.id;
  const chat = await page.request.post(`/api/projects/${projectId}/chats`, { data: { title: `Touch geometry Project chat ${suffix}` } });
  expect(chat.status(), await chat.text()).toBe(201);
  return { chatId: ((await chat.json()) as { chat: { id: string } }).chat.id, projectId };
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
    newChat: floats.getByRole("button", { exact: true, name: "New chat" }),
    showList: floats.getByRole("button", { name: "Open sidebar" })
  };
}

async function expectRailTargets(page: Page, viewportHeight: number): Promise<void> {
  const targets = page.getByTestId("workspace-rail").locator(".v2-rail-button, .v2-navigation-account-trigger");
  const count = await targets.count();
  expect(count, "rail controls").toBeGreaterThanOrEqual(5);
  for (let index = 0; index < count; index += 1) {
    const target = targets.nth(index);
    const name = `rail ${(await target.getAttribute("aria-label")) ?? index}`;
    const box = await expectTarget(target, name);
    expect(box.y, `${name} top`).toBeGreaterThanOrEqual(-0.5);
    expect(box.y + box.height, `${name} stays on screen`).toBeLessThanOrEqual(viewportHeight + 0.5);
  }
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
async function expectPhoneIslandGaps(page: Page, withChatActions: boolean): Promise<void> {
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
  if (!withChatActions) return;
  const more = await expectTarget(page.getByTestId("header-more-trigger"), "Chat actions island");
  const actionsGap = more.x - (plus.x + plus.width);
  expect(Math.abs(actionsGap - 8), `New chat → Chat actions gap ${actionsGap}`).toBeLessThanOrEqual(1);
  expect(Math.abs(more.y - menu.y), "Chat actions island row").toBeLessThanOrEqual(1);
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
 * Phone touch in a Project chat: the projects section has no "+" float, so
 * the header row (the model island, then the Project chip pill) sits centred
 * between the menu island and "⋯" instead of reserving room for "+".
 */
async function expectProjectChatIslandGaps(page: Page): Promise<void> {
  await expect(page.locator(".v2-workspace-shell")).toHaveAttribute("data-shell-section", "projects");
  const header = page.locator(".v2-live-header");
  // The loaded Project chat: "⋯" and the Project chip are both in the row.
  const more = page.getByTestId("header-more-trigger");
  await expect(more).toBeVisible({ timeout: 30_000 });
  await expect(header.getByRole("complementary", { name: "Shared project context" })).toBeVisible({ timeout: 30_000 });
  await expect(sidebarFloats(page).newChat).toHaveCount(0);
  const menu = await expectTarget(sidebarFloats(page).showList, "menu island");
  const island = await boxOf(page.locator(".v2-live-header-island"), "model island");
  const titlePill = header.locator(".v2-live-title");
  const last = await titlePill.isVisible() ? await boxOf(titlePill, "Project chip pill") : island;
  const moreBox = await expectTarget(more, "Chat actions island");
  const left = island.x - (menu.x + menu.width);
  const right = moreBox.x - (last.x + last.width);
  expect(left, "menu → model gap").toBeGreaterThanOrEqual(7.5);
  expect(right, "header row → Chat actions gap").toBeGreaterThanOrEqual(7.5);
  expect(Math.abs(left - right), `Project chat header row gaps ${left} / ${right}`).toBeLessThanOrEqual(1);
}

/**
 * Settings on touch: the header row is 56px, so the 44px Close and Back
 * controls keep room above and below inside it, and the content starts
 * under the header.
 */
async function expectSettingsHeaderRoom(page: Page): Promise<void> {
  await runAccountMenuAction(page, "Settings");
  const settings = page.getByRole("dialog", { exact: true, name: "Settings" });
  await expect(settings).toBeVisible();
  const header = settings.locator(".v2-settings-header");
  const close = settings.getByRole("button", { exact: true, name: "Close settings" });
  const expectRoom = async (control: Locator, name: string) => {
    const headerBox = await boxOf(header, "Settings header");
    expect(headerBox.height, "Settings header height").toBeGreaterThanOrEqual(55.99);
    const box = await expectTarget(control, name);
    expect(box.y - headerBox.y, `${name} room above`).toBeGreaterThanOrEqual(5.49);
    expect(headerBox.y + headerBox.height - (box.y + box.height), `${name} room below`).toBeGreaterThanOrEqual(5.49);
    const scroll = await boxOf(settings.locator(".v2-settings-scroll"), "Settings content");
    expect(scroll.y, "Settings content starts under the header").toBeGreaterThanOrEqual(headerBox.y + headerBox.height - 0.5);
  };
  await expectRoom(close, "Close settings");

  await settings.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { exact: true, name: "Data" }).click();
  await settings.getByRole("button", { exact: true, name: "Manage" }).click();
  const back = settings.getByRole("button", { exact: true, name: "Back to Data" });
  await expect(back).toBeFocused();
  await expectRoom(back, "Back to Data");
  await expectRoom(close, "Close settings");
  await back.click();
  await close.click();
  await expect(settings).toHaveCount(0);
}

/** Studio: the Back controls and the instruction variables are 44px targets. */
async function expectStudioTargets(page: Page, crumbRowRoom: boolean): Promise<void> {
  await runAccountMenuAction(page, "Instructions");
  const library = page.getByTestId("library-v2");
  const newPreset = page.getByRole("button", { name: "New preset" });
  await expect(newPreset).toBeEnabled({ timeout: 30_000 });
  const row = library.locator(".v2-library-heading-row");
  const expectBack = async (name: string) => {
    const box = await expectTarget(library.getByRole("button", { exact: true, name }), name);
    if (!crumbRowRoom) return;
    const rowBox = await boxOf(row, "Studio crumb row");
    expect(box.y - rowBox.y, `${name} room above`).toBeGreaterThanOrEqual(4);
    expect(rowBox.y + rowBox.height - (box.y + box.height), `${name} room below`).toBeGreaterThanOrEqual(4);
  };
  await expectBack("Back to chat");

  // Opening an empty editor saves nothing.
  await newPreset.click();
  await expectBack("Back to Instructions");
  const editor = page.getByTestId("settings-instructions").locator(".v2-markdown-editor").first();
  await expectTarget(editor.getByRole("button", { name: "Insert date" }), "Insert date");
  await expectTarget(editor.getByRole("button", { name: "Insert time" }), "Insert time");
}

/** Composer menu links outside the provenance line (component fixtures). */
async function expectComposerLinkTargets(page: Page): Promise<void> {
  await page.goto("/ui-v2-fixture?fixture=composer&state=knowledge");
  let picker = page.getByRole("menu", { name: "Knowledge" });
  await expect(picker).toBeVisible();
  const manage = picker.getByRole("menuitem", { name: "Manage Knowledge" });
  await manage.scrollIntoViewIfNeeded();
  await expectTarget(manage, "Manage Knowledge");

  await page.goto("/ui-v2-fixture?fixture=composer&state=project-knowledge");
  picker = page.getByRole("menu", { name: "Knowledge" });
  await expect(picker).toBeVisible();
  const override = picker.locator(".v2-composer-knowledge-inherited")
    .getByRole("menuitem", { name: "Override for this chat" });
  await override.scrollIntoViewIfNeeded();
  await expectTarget(override, "Override for this chat");
}

const compactTouchProfiles = [
  { height: 1024, isMobile: false, label: "tablet portrait 768×1024", settings: true, width: 768 },
  { height: 390, isMobile: true, label: "phone landscape 844×390", settings: false, width: 844 }
] as const;

for (const profile of compactTouchProfiles) {
  test.describe(`shell touch targets · ${profile.label}`, () => {
    test.use({
      hasTouch: true,
      isMobile: profile.isMobile,
      viewport: { height: profile.height, width: profile.width }
    });

    test(`rail, header, floats, Studio and composer links are 44px touch targets · ${profile.label}`, async ({ page }) => {
      test.setTimeout(120_000);
      const { chatId, title } = await createOwnedChat(page);
      try {
        const model = await openChat(page, `/c/${chatId}`);
        expect(await page.evaluate((rule) => matchMedia(rule).matches, touchRule)).toBe(true);
        await expectRailTargets(page, profile.height);
        await expectCompactTouchHeader(page, model, title);
        if (profile.settings) await expectSettingsHeaderRoom(page);
        await expectStudioTargets(page, true);
        await expectComposerLinkTargets(page);
      } finally {
        await deleteOwnedChatPermanently(page.request, chatId);
      }
    });
  });
}

test.describe("shell touch targets · phone portrait 390×844", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { height: 844, width: 390 } });

  test("phone islands keep equal gaps and Studio and composer links are 44px touch targets · phone portrait 390×844", async ({ page }) => {
    test.setTimeout(150_000);
    const { chatId } = await createOwnedChat(page);
    let projectId: string | null = null;
    try {
      await openChat(page, "/");
      expect(await page.evaluate((rule) => matchMedia(rule).matches, touchRule)).toBe(true);
      await expect(page.locator(".v2-workspace-shell")).toHaveAttribute("data-sidebar-composition", "mobile");
      await expectPhoneIslandGaps(page, false);
      await expectPhoneIslandSegments(page);

      await openChat(page, `/c/${chatId}`);
      await expect(page.locator(".v2-workspace-shell")).toHaveAttribute("data-chat-active", "true");
      await expectPhoneIslandGaps(page, true);
      await expectPhoneIslandSegments(page);
      // Account Settings from a personal chat.
      await expectSettingsHeaderRoom(page);

      const project = await createOwnedProjectChat(page);
      projectId = project.projectId;
      await openChat(page, `/p/${project.projectId}/c/${project.chatId}`);
      await expect(page.locator(".v2-workspace-shell")).toHaveAttribute("data-chat-active", "true");
      await expectProjectChatIslandGaps(page);

      await openChat(page, `/c/${chatId}`);
      await expectStudioTargets(page, false);
      await expectComposerLinkTargets(page);
    } finally {
      if (projectId) await page.request.delete(`/api/projects/${projectId}`).catch(() => undefined);
      await deleteOwnedChatPermanently(page.request, chatId);
    }
  });
});

test("fine pointer keeps the 40px rail, compact header controls and 48px Studio crumb row · desktop 1440×900", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ height: 900, width: 1440 });
  const { chatId, title } = await createOwnedChat(page);
  try {
    const model = await openChat(page, `/c/${chatId}`);
    expect(await page.evaluate((rule) => matchMedia(rule).matches, touchRule)).toBe(false);
    await expect(page.getByTestId("header-title")).toContainText(title);

    const railTargets = page.getByTestId("workspace-rail").locator(".v2-rail-button, .v2-navigation-account-trigger");
    const count = await railTargets.count();
    expect(count).toBeGreaterThanOrEqual(5);
    for (let index = 0; index < count; index += 1) {
      await expectSize(railTargets.nth(index), `rail control ${index}`, { height: 40, width: 40 });
    }
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

    await page.getByTestId("workspace-rail").getByRole("button", { name: "Studio" }).click();
    await expectSize(page.getByTestId("library-v2").locator(".v2-library-heading-row"), "Studio crumb row", { height: 48 });

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

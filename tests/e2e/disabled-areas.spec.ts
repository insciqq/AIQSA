import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { chooseSearchStrategy } from "./shell/composer";
import { deleteOwnedChatPermanently } from "./support/chatCleanup";
import { expectNoHorizontalOverflow, expectWithinViewport } from "./support/layoutAssertions";
import { authenticateWithLocalToken, signInWithLocalToken } from "./support/localAuth";
import { activeChatId, selectFakeModel, sendAndExpect } from "./support/workspace";

/*
 * Projects, Knowledge and native Anthropic are disabled
 * (`lib/domain/disabledAreas.ts`, operator decision 2026-10-22). No surface
 * offers them, an existing Project chat stays readable by its address with a
 * notice in place of the composer, and an ordinary chat still sends. The API
 * refuses to create Projects, so the Project fixture is written through
 * Prisma and removed in `finally`. Screenshots are viewport shots.
 */

const prisma = new PrismaClient();
test.setTimeout(120_000);
test.use({ trace: "off" });
test.afterAll(async () => { await prisma.$disconnect(); });

const PROJECT_CHAT_NOTICE = "Projects are turned off. You can read this shared chat, but you can't send messages in it.";
const PROJECT_ROUTE_NOTICE = "Projects are turned off. Open a shared chat from its link to read it.";

const DESKTOP = { height: 900, width: 1440 } as const;
const TABLET_PORTRAIT = { height: 1200, width: 900 } as const;
const PHONE_PORTRAIT = { height: 844, width: 390 } as const;
const PHONE_LANDSCAPE = { height: 390, width: 844 } as const;

type ProjectChatFixture = Readonly<{
  answer: string;
  chatId: string;
  projectId: string;
  question: string;
}>;

/** A Project owned by the signed-in test user with one answered Project chat. */
async function seedProjectChat(page: Page): Promise<ProjectChatFixture> {
  const me = await page.request.get("/api/me");
  expect(me.ok()).toBe(true);
  const userId = ((await me.json()) as { user: { id: string } }).user.id;
  const marker = randomUUID().slice(0, 8);
  const displayName = "Disabled areas owner";
  const project = await prisma.project.create({
    data: {
      createdByDisplayName: displayName,
      createdByUserId: userId,
      grants: { create: [{ role: "OWNER", userId }] },
      name: `Disabled areas ${marker}`
    },
    select: { id: true }
  });
  const chat = await prisma.chat.create({
    data: {
      createdByDisplayName: displayName,
      createdByUserId: userId,
      memoryMode: "EXCLUDED",
      projectId: project.id,
      title: `Disabled areas chat ${marker}`,
      userId: null
    },
    select: { id: true }
  });
  const question = `Disabled areas question ${marker}`;
  const answer = `Disabled areas answer ${marker}`;
  const asked = await prisma.message.create({
    data: {
      authorDisplayName: displayName,
      authorProjectRole: "OWNER",
      authorUserId: userId,
      chatId: chat.id,
      content: { blocks: [{ text: question, type: "text" }] },
      role: "user",
      status: "complete"
    },
    select: { id: true }
  });
  const answered = await prisma.message.create({
    data: {
      chatId: chat.id,
      content: { blocks: [{ text: answer, type: "text" }] },
      modelId: "fake-qsa",
      parentMessageId: asked.id,
      provider: "fake",
      role: "assistant",
      status: "complete"
    },
    select: { id: true }
  });
  await prisma.chat.update({ data: { activeLeafMessageId: answered.id }, where: { id: chat.id } });
  return { answer, chatId: chat.id, projectId: project.id, question };
}

/** Removes only the fixture: leaf message first, then the Project with its chat. */
async function removeProjectChat(projectId: string | null): Promise<void> {
  if (!projectId) return;
  const chats = await prisma.chat.findMany({ select: { id: true }, where: { projectId } });
  const chatIds = chats.map(({ id }) => id);
  if (chatIds.length > 0) {
    await prisma.chat.updateMany({ data: { activeLeafMessageId: null }, where: { id: { in: chatIds } } });
    await prisma.message.deleteMany({ where: { chatId: { in: chatIds }, parentMessageId: { not: null } } });
    await prisma.message.deleteMany({ where: { chatId: { in: chatIds } } });
  }
  await prisma.project.deleteMany({ where: { id: projectId } });
}

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
    const drawer = page.getByRole("complementary", { name: /^(Chat|Project) navigation$/u });
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

/** Opens a seeded Project chat by its address and proves it reads without a composer. */
async function expectReadableProjectChat(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  let projectId: string | null = null;
  try {
    await authenticateWithLocalToken(page.request);
    const fixture = await seedProjectChat(page);
    projectId = fixture.projectId;
    await page.goto(`/p/${fixture.projectId}/c/${fixture.chatId}`);
    await expect(page.getByTestId("app-shell")).toBeVisible({ timeout: 30_000 });

    const thread = page.getByTestId("conversation-thread");
    await expect(thread).toContainText(fixture.question, { timeout: 30_000 });
    await expect(thread).toContainText(fixture.answer);
    await expect(page).toHaveURL((url) => url.pathname === `/p/${fixture.projectId}/c/${fixture.chatId}`);

    const notice = page.getByTestId("projects-disabled-notice");
    await expect(notice).toHaveText(PROJECT_CHAT_NOTICE);
    await notice.scrollIntoViewIfNeeded();
    await expectWithinViewport(page, notice);
    await expect(page.getByTestId("composer-v2")).toHaveCount(0);
    await expect(page.getByRole("textbox", { exact: true, name: "Message" })).toHaveCount(0);
    await expect(page.getByTestId("header-model-trigger")).toHaveCount(0);
    await expect(page.getByTestId("header-assistant-selector")).toHaveCount(0);
    await expect(page.getByTestId("project-overview-page")).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    await shot(page, testInfo, name);
    await expectNoProjectsDestination(page);
  } finally {
    await removeProjectChat(projectId);
  }
}

/** A Project's own address offers nothing to start: it falls back to the new chat with the notice. */
async function expectProjectRouteFallback(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  let projectId: string | null = null;
  try {
    await authenticateWithLocalToken(page.request);
    const fixture = await seedProjectChat(page);
    projectId = fixture.projectId;
    await page.goto(`/p/${fixture.projectId}`);
    await expect(page.getByTestId("app-shell")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("shell-notice").filter({ hasText: PROJECT_ROUTE_NOTICE })).toBeVisible({ timeout: 30_000 });
    await expect(page).toHaveURL((url) => url.pathname === "/");
    await expect(page.getByRole("textbox", { exact: true, name: "Message" })).toBeVisible();
    await expect(page.getByTestId("projects-disabled-notice")).toHaveCount(0);
    await expect(page.getByTestId("project-overview-page")).toHaveCount(0);
    await expect(page.getByText(fixture.question)).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    await shot(page, testInfo, name);
  } finally {
    await removeProjectChat(projectId);
  }
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
  await expect(addMenu.getByRole("menuitem", { name: /Knowledge/u })).toHaveCount(0);
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
  await expect(palette.getByRole("option", { name: /Choose Knowledge/u })).toHaveCount(0);
  await page.keyboard.type("knowledge");
  await expect(field).toHaveValue("/knowledge");
  await expect(page.getByRole("option", { name: /Choose Knowledge/u })).toHaveCount(0);
  await field.fill("");
  await page.keyboard.press("Escape");
  await expect(palette).toBeHidden();
}

test.describe("desktop", () => {
  test.use({ viewport: DESKTOP });

  test("a Project chat opened by its address is readable with the notice and no composer", async ({ page }, testInfo) => {
    await expectReadableProjectChat(page, testInfo, "project-chat-desktop");
  });

  test("a Project address without a chat falls back to the new chat with the notice", async ({ page }, testInfo) => {
    await expectProjectRouteFallback(page, testInfo, "project-route-fallback-desktop");
  });

  test("the new chat offers no Projects or Knowledge and still sends an answer", async ({ page }, testInfo) => {
    let chatId: string | null = null;
    try {
      await signInWithLocalToken(page);
      await expectNoProjectsDestination(page);
      await expectComposerWithoutKnowledge(page, testInfo, "new-chat-add-menu-desktop");

      // Regression guard: disabling the areas leaves an ordinary chat working.
      await selectFakeModel(page);
      const searchChip = page.getByRole("button", { name: /^Choose web search/u });
      if (await searchChip.isVisible()) await chooseSearchStrategy(page, "Off");
      const prompt = `Disabled areas regression ${randomUUID().slice(0, 8)}`;
      await sendAndExpect(page, prompt, `Fake answer: ${prompt}`);
      chatId = await activeChatId(page);
      await expect(page).toHaveURL((url) => url.pathname === `/c/${chatId}`);
      await expect(page.getByTestId("projects-disabled-notice")).toHaveCount(0);
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
    await expect(sections.getByRole("tab", { name: "Knowledge", exact: true })).toHaveCount(0);
    await expect(sections.getByRole("tab", { name: /Knowledge/u })).toHaveCount(0);

    const defaults = sections.getByRole("tab", { name: "Chat defaults", exact: true });
    await defaults.click();
    await expect(defaults).toHaveAttribute("aria-selected", "true");
    const panel = library.getByRole("tabpanel");
    await expect(panel.getByRole("radiogroup", { name: "MCP tools default" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("settings-default-knowledge")).toHaveCount(0);
    await expect(panel.getByRole("button", { name: "Knowledge default" })).toHaveCount(0);
    await expect(panel.getByLabel("Knowledge default")).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    await shot(page, testInfo, "studio-chat-defaults-desktop");
  });

  test("Control Center offers no native Anthropic tile and names its retrieval page Memory", async ({ page }, testInfo) => {
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
    await expect(tiles.getByTestId("provider-add-tile-anthropic")).toHaveCount(0);
    await expect(tiles.getByRole("button", { name: /Anthropic/u })).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    await shot(page, testInfo, "admin-add-provider-desktop");
  });
});

test.describe("tablet portrait", () => {
  test.use({ viewport: TABLET_PORTRAIT });

  test("a Project chat opened by its address is readable with the notice and no composer", async ({ page }, testInfo) => {
    await expectReadableProjectChat(page, testInfo, "project-chat-tablet");
  });
});

test.describe("phone portrait", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: PHONE_PORTRAIT });

  test("a Project chat opened by its address is readable with the notice and no composer", async ({ page }, testInfo) => {
    await expectReadableProjectChat(page, testInfo, "project-chat-phone");
  });

  test("a Project address without a chat falls back to the new chat with the notice", async ({ page }, testInfo) => {
    await expectProjectRouteFallback(page, testInfo, "project-route-fallback-phone");
  });

  test("the drawer offers no Projects and the composer offers no Knowledge", async ({ page }, testInfo) => {
    await signInWithLocalToken(page);
    await expectNoProjectsDestination(page);
    await expectComposerWithoutKnowledge(page, testInfo, "new-chat-add-menu-phone");
    await expectNoHorizontalOverflow(page);
  });
});

test.describe("phone landscape", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: PHONE_LANDSCAPE });

  test("a Project chat opened by its address is readable with the notice and no composer", async ({ page }, testInfo) => {
    await expectReadableProjectChat(page, testInfo, "project-chat-phone");
  });
});

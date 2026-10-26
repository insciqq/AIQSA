import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { deleteOwnedChatPermanently } from "./support/chatCleanup";
import { expectNoHorizontalOverflow } from "./support/layoutAssertions";
import { signInWithLocalToken } from "./support/localAuth";

const prisma = new PrismaClient();
test.afterAll(() => prisma.$disconnect());

const viewports = [
  { height: 900, width: 1440 },
  { height: 1024, width: 900 },
  { height: 844, width: 390 }
] as const;

async function createChat(page: Page, title: string): Promise<string> {
  const response = await page.request.post("/api/chats", { data: { memoryMode: "EXCLUDED", title } });
  expect(response.status()).toBe(201);
  return (await response.json()).chat.id as string;
}

async function openNavigation(page: Page) {
  const navigation = page.getByRole("complementary", { name: "Chat navigation" });
  if (!(await navigation.isVisible())) await page.getByRole("button", { name: "Open sidebar" }).click();
  await expect(navigation).toBeVisible();
  return navigation;
}

test("favoriting an old chat lists it under Favorites at the top without moving it by time", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const suffix = randomUUID().slice(0, 8);
  const title = `Favorite old chat ${suffix}`;
  await signInWithLocalToken(page);
  const recentId = await createChat(page, `Favorite recent chat ${suffix}`);
  const oldId = await createChat(page, title);
  // Older than any date page the sidebar loads first, so only the favorites
  // the first page carries can show it.
  const oldTime = new Date(Date.now() - 400 * 86_400_000);
  await prisma.chat.update({ data: { updatedAt: oldTime }, where: { id: oldId } });
  try {
    // Favorite it from the chat header, where an old chat is always reachable.
    await page.goto(`/c/${oldId}`);
    await expect(page.getByTestId("header-title")).toHaveText(title);
    const toggled = page.waitForResponse((response) => response.request().method() === "PATCH" &&
      new URL(response.url()).pathname === `/api/chats/${oldId}`);
    await page.getByRole("button", { exact: true, name: "Chat actions" }).click();
    await page.getByRole("menuitem", { name: "Favorite" }).click();
    expect((await toggled).ok()).toBe(true);
    await expect.poll(async () => (await prisma.chat.findUniqueOrThrow({
      select: { pinned: true, updatedAt: true }, where: { id: oldId }
    }))).toEqual({ pinned: true, updatedAt: oldTime });

    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      await page.goto("/");
      const navigation = await openNavigation(page);
      const favorites = navigation.getByRole("group", { name: "Favorites" });
      await expect(navigation.locator(".v2-navigation-group-label").first()).toHaveText("Favorites");
      await expect(favorites.getByRole("treeitem", { name: title, exact: true })).toBeVisible();
      await expect(navigation.getByRole("treeitem", { name: title, exact: true })).toHaveCount(1);
      await expect(navigation.getByRole("group", { name: "Today" })
        .getByRole("treeitem", { name: title, exact: true })).toHaveCount(0);
      await expectNoHorizontalOverflow(page);
      await page.screenshot({ path: testInfo.outputPath(`sidebar-favorites-${viewport.width}.png`) });
    }

    // Unfavorite from the row menu: the chat returns to its date group.
    await page.setViewportSize(viewports[0]);
    await page.reload();
    const navigation = await openNavigation(page);
    const favorites = navigation.getByRole("group", { name: "Favorites" });
    await favorites.getByRole("button", { exact: true, name: `Actions: ${title}` }).click();
    await page.getByRole("menuitem", { name: "Favorite" }).click();
    await expect(navigation.getByRole("group", { name: "Earlier" })
      .getByRole("treeitem", { name: title, exact: true })).toBeVisible();
    await expect(navigation.getByRole("treeitem", { name: title, exact: true })).toHaveCount(1);
    await expect.poll(async () => (await prisma.chat.findUniqueOrThrow({
      select: { pinned: true, updatedAt: true }, where: { id: oldId }
    }))).toEqual({ pinned: false, updatedAt: oldTime });
    await page.screenshot({ path: testInfo.outputPath("sidebar-favorites-unfavorited-1440.png") });
  } finally {
    for (const chatId of [oldId, recentId]) {
      await deleteOwnedChatPermanently(page.request, chatId).catch(() => undefined);
    }
  }
});

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { deleteOwnedChatPermanently } from "./support/chatCleanup";
import { expectNoHorizontalOverflow } from "./support/layoutAssertions";
import { signInWithLocalToken } from "./support/localAuth";

// Sidebar message search: a word only inside a message finds its chat with a
// readable snippet, and choosing the result opens the chat at that message,
// hundreds of messages back or on a branch that is not the active one.

const prisma = new PrismaClient();
test.afterAll(() => prisma.$disconnect());

const MAIN_MESSAGES = 320;
const OLD_MATCH_INDEX = 12;

type SeededChat = Readonly<{
  branchAnswerId: string;
  branchNeedle: string;
  branchQuestionId: string;
  chatId: string;
  mainLeafId: string;
  oldMatchId: string;
  oldNeedle: string;
  title: string;
}>;

async function seedChat(page: Page): Promise<SeededChat> {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
  const title = `Search jump ${suffix}`;
  const oldNeedle = `zephyrine${suffix}`;
  const branchNeedle = `quillwort${suffix}`;
  const response = await page.request.post("/api/chats", { data: { memoryMode: "EXCLUDED", title } });
  expect(response.status()).toBe(201);
  const chatId = (await response.json() as { chat: { id: string } }).chat.id;
  const base = Date.now() - 3_600_000;
  const ids = Array.from({ length: MAIN_MESSAGES }, () => randomUUID());
  const text = (index: number) => index === OLD_MATCH_INDEX
    ? `Long ago we chose the ${oldNeedle} trail for the first hike.`
    : `${index % 2 === 0 ? "Question" : "Answer"} ${index + 1} about the walking plan.`;
  await prisma.message.createMany({
    data: ids.map((id, index) => ({
      chatId,
      content: { blocks: [{ text: text(index), type: "text" }] },
      createdAt: new Date(base + index * 1_000),
      id,
      parentMessageId: index === 0 ? null : ids[index - 1]!,
      role: index % 2 === 0 ? "user" : "assistant",
      status: "complete" as const,
      ...(index % 2 === 1 ? { modelId: "fake-qsa", provider: "fake" } : {})
    }))
  });
  // Another version of the chat, newer than the active one, branches off an
  // answer near the end.
  const branchQuestionId = randomUUID();
  const branchAnswerId = randomUUID();
  await prisma.message.createMany({
    data: [
      {
        chatId,
        content: { blocks: [{ text: `Could we take the ${branchNeedle} path instead?`, type: "text" }] },
        createdAt: new Date(base + (MAIN_MESSAGES + 10) * 1_000),
        id: branchQuestionId,
        parentMessageId: ids[MAIN_MESSAGES - 21]!,
        role: "user",
        status: "complete"
      },
      {
        chatId,
        content: { blocks: [{ text: "Yes, that path works too.", type: "text" }] },
        createdAt: new Date(base + (MAIN_MESSAGES + 11) * 1_000),
        id: branchAnswerId,
        modelId: "fake-qsa",
        parentMessageId: branchQuestionId,
        provider: "fake",
        role: "assistant",
        status: "complete"
      }
    ]
  });
  const mainLeafId = ids[MAIN_MESSAGES - 1]!;
  await prisma.chat.update({ data: { activeLeafMessageId: mainLeafId }, where: { id: chatId } });
  return {
    branchAnswerId,
    branchNeedle,
    branchQuestionId,
    chatId,
    mainLeafId,
    oldMatchId: ids[OLD_MATCH_INDEX]!,
    oldNeedle,
    title
  };
}

async function navigation(page: Page): Promise<Locator> {
  const sidebar = page.getByRole("complementary", { name: "Chat navigation" });
  if (!(await sidebar.isVisible())) await page.getByRole("button", { name: "Open sidebar" }).click();
  await expect(sidebar).toBeVisible();
  return sidebar;
}

/** Types a query and waits for its first search page to arrive. */
async function search(page: Page, query: string): Promise<Locator> {
  const sidebar = await navigation(page);
  const response = page.waitForResponse((candidate) => {
    const url = new URL(candidate.url());
    return url.pathname === "/api/chats/search" && url.searchParams.get("q") === query;
  });
  await sidebar.getByRole("searchbox", { name: "Filter chats" }).fill(query);
  expect((await response).ok()).toBe(true);
  await expect(sidebar.getByText("Searching chats…")).toHaveCount(0);
  return sidebar;
}

async function expectDrawerClosed(page: Page): Promise<void> {
  const shell = page.locator(".v2-workspace-shell");
  await expect(shell).not.toHaveAttribute("data-mobile-sidebar", "true");
  await expect(shell).not.toHaveAttribute("data-sidebar-compact-expanded", "true");
}

async function activeLeaf(page: Page, chatId: string): Promise<string | null> {
  const response = await page.request.get(`/api/chats/${chatId}`);
  expect(response.ok()).toBe(true);
  return (await response.json() as { chat: { activeLeafMessageId: string | null } }).chat.activeLeafMessageId;
}

function turn(page: Page, messageId: string): Locator {
  return page.locator(`article[data-message-id="${messageId}"]`);
}

test.beforeAll(() => {
  execFileSync(process.execPath, ["--import", "tsx", "scripts/stateful-test-target.ts"], { stdio: "pipe" });
});

test("a word inside an old message finds its chat and opens it at that message", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await signInWithLocalToken(page);
  await page.setViewportSize({ height: 900, width: 1440 });
  const seeded = await seedChat(page);
  try {
    await page.goto("/");
    await expect(page.getByTestId("app-shell")).toBeVisible();

    // JSON keys of the content document are not text.
    for (const key of ["blocks", "type"]) {
      const sidebar = await search(page, key);
      await expect(sidebar.getByRole("treeitem", { name: seeded.title })).toHaveCount(0);
    }

    const sidebar = await search(page, seeded.oldNeedle);
    const inMessages = sidebar.getByRole("group", { name: "In messages" });
    const result = inMessages.getByRole("treeitem", { name: seeded.title });
    await expect(result).toBeVisible({ timeout: 15_000 });
    // The title itself does not match, so the chat is not a title result.
    await expect(sidebar.getByRole("group", { name: "Results" })).toHaveCount(0);
    await expect(result.locator("mark")).toHaveText(seeded.oldNeedle);
    await expect(result).toContainText(`Long ago we chose the ${seeded.oldNeedle} trail`);
    await expect(result).not.toContainText("\"blocks\"");
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: testInfo.outputPath("message-search-results-desktop.png") });

    await result.click();
    await expect(page).toHaveURL(new RegExp(`/c/${seeded.chatId}(?:[?#]|$)`, "u"));
    // About 300 messages back: earlier pages load until it is present.
    await expect(turn(page, seeded.oldMatchId)).toBeInViewport({ timeout: 30_000 });
    await expect(turn(page, seeded.oldMatchId)).toHaveAttribute("data-search-reveal", /.+/u);
    await expect(sidebar.getByRole("searchbox", { name: "Filter chats" })).toHaveValue("");
    expect(await activeLeaf(page, seeded.chatId)).toBe(seeded.mainLeafId);
    await page.screenshot({ path: testInfo.outputPath("message-search-jump-old-desktop.png") });

    // A match on another version of the chat switches to the newest leaf below it.
    const branchResult = (await search(page, seeded.branchNeedle))
      .getByRole("group", { name: "In messages" })
      .getByRole("treeitem", { name: seeded.title });
    await expect(branchResult).toBeVisible({ timeout: 15_000 });
    await branchResult.click();
    await expect.poll(() => activeLeaf(page, seeded.chatId), { timeout: 15_000 }).toBe(seeded.branchAnswerId);
    await expect(turn(page, seeded.branchQuestionId)).toBeInViewport({ timeout: 30_000 });
    await expect(turn(page, seeded.branchAnswerId)).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("message-search-jump-branch-desktop.png") });

    // Opening the result was one history entry; the second jump stayed in it.
    await page.goBack();
    await expect.poll(() => new URL(page.url()).pathname).toBe("/");
  } finally {
    await deleteOwnedChatPermanently(page.request, seeded.chatId);
  }
});

const narrowViewports = [
  { height: 1024, label: "tablet-portrait", width: 768 },
  { height: 844, label: "phone-portrait", width: 390 },
  { height: 390, label: "phone-landscape", width: 844 }
] as const;

for (const viewport of narrowViewports) {
  test(`message search results open from the drawer at the message (${viewport.label})`, async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    await signInWithLocalToken(page);
    await page.setViewportSize({ height: viewport.height, width: viewport.width });
    const seeded = await seedChat(page);
    try {
      await page.goto("/");
      await expect(page.getByTestId("app-shell")).toBeVisible();
      const sidebar = await search(page, seeded.oldNeedle);
      const result = sidebar.getByRole("group", { name: "In messages" }).getByRole("treeitem", { name: seeded.title });
      await expect(result).toBeVisible({ timeout: 15_000 });
      await expect(result.locator("mark")).toHaveText(seeded.oldNeedle);
      await expectNoHorizontalOverflow(page);
      await page.screenshot({ path: testInfo.outputPath(`message-search-results-${viewport.label}.png`) });

      await result.click();
      // The drawer yields to the chat.
      await expectDrawerClosed(page);
      await expect(turn(page, seeded.oldMatchId)).toBeInViewport({ timeout: 30_000 });
      await expectNoHorizontalOverflow(page);
      await page.screenshot({ path: testInfo.outputPath(`message-search-jump-${viewport.label}.png`) });
    } finally {
      await deleteOwnedChatPermanently(page.request, seeded.chatId);
    }
  });
}

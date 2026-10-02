import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { expect, test, type Page, type Route } from "@playwright/test";
import { authenticateWithLocalToken, signInWithLocalToken } from "./support/localAuth";
import { expectNoHorizontalOverflow } from "./support/layoutAssertions";
import { deleteOwnedChatPermanently } from "./support/chatCleanup";

// Sidebar and branch-graph loading must stay bounded when a request fails or
// the browser summary lags a server revision (bugfix wave N22/N23).

const viewports = [
  { height: 900, label: "desktop", width: 1440 },
  { height: 1024, label: "tablet-portrait", width: 768 },
  { height: 768, label: "tablet-landscape", width: 1024 },
  { height: 844, label: "phone-portrait", width: 390 },
  { height: 390, label: "phone-landscape", width: 844 }
] as const;

type CompactMode = "abort" | "fail" | "pass";

async function routeCompactNavigation(page: Page, initial: CompactMode) {
  const state = { mode: initial as CompactMode, requests: 0 };
  await page.route("**/api/chats/compact?*", async (route: Route) => {
    state.requests += 1;
    if (state.mode === "pass") await route.continue();
    else if (state.mode === "abort") await route.abort("internetdisconnected");
    else await route.fulfill({ json: { error: "internal_error" }, status: 500 });
  });
  return state;
}

async function openNavigation(page: Page, width: number) {
  const navigation = page.getByRole("complementary", { name: "Chat navigation" });
  if (width < 1024 && !(await navigation.isVisible())) {
    await page.getByRole("button", { name: "Open sidebar" }).click();
  }
  await expect(navigation).toBeVisible();
  return navigation;
}

/** Samples the list region: the failure must never flash back to the skeleton. */
async function expectSteadyError(page: Page, durationMs: number) {
  const navigation = page.getByRole("complementary", { name: "Chat navigation" });
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    await expect(navigation.getByText("Could not load chats")).toBeVisible();
    await expect(navigation.getByLabel("Loading chats")).toHaveCount(0);
    await page.waitForTimeout(250);
  }
}

for (const viewport of viewports) {
  test(`chat navigation stays bounded after HTTP 500 and recovers on Retry (${viewport.label})`, async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    // Authenticate without opening the shell: a still-hydrating sign-in page
    // would request the chat list through the route below and skew the count.
    await authenticateWithLocalToken(page.request);
    await page.setViewportSize({ height: viewport.height, width: viewport.width });
    const compact = await routeCompactNavigation(page, "fail");
    await page.goto("/");
    await expect(page.getByTestId("app-shell")).toBeVisible();
    const navigation = await openNavigation(page, viewport.width);
    await expect(navigation.getByText("Could not load chats")).toBeVisible();

    // Initial request plus at most the first two backoff steps (2 s, 5 s).
    await expectSteadyError(page, 8_000);
    expect(compact.requests).toBeGreaterThanOrEqual(1);
    expect(compact.requests).toBeLessThanOrEqual(3);
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: testInfo.outputPath(`navigation-500-${viewport.label}.png`) });

    compact.mode = "pass";
    const before = compact.requests;
    await navigation.getByRole("button", { name: "Retry" }).click();
    await expect(navigation.getByText("Could not load chats")).toHaveCount(0);
    await expect(navigation.getByRole("tree", { name: "Personal chats" })).toBeVisible();
    expect(compact.requests - before).toBeLessThanOrEqual(2);
    const settled = compact.requests;
    await page.waitForTimeout(5_000);
    expect(compact.requests).toBe(settled);
    await page.screenshot({ path: testInfo.outputPath(`navigation-recovered-${viewport.label}.png`) });
  });
}

test("chat navigation waits while offline and reloads when the connection returns", async ({ context, page }, testInfo) => {
  test.setTimeout(90_000);
  await signInWithLocalToken(page);
  await page.setViewportSize({ height: 900, width: 1440 });
  const compact = await routeCompactNavigation(page, "abort");
  await page.goto("/");
  const navigation = await openNavigation(page, 1440);
  await expect(navigation.getByText("Could not load chats")).toBeVisible();
  await context.setOffline(true);
  // Offline, only an already scheduled backoff step may still fire once.
  const offlineStart = compact.requests;
  await expectSteadyError(page, 20_000);
  expect(compact.requests - offlineStart).toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath("navigation-offline.png") });

  compact.mode = "pass";
  const before = compact.requests;
  await context.setOffline(false);
  await expect(navigation.getByText("Could not load chats")).toHaveCount(0, { timeout: 15_000 });
  await expect(navigation.getByRole("tree", { name: "Personal chats" })).toBeVisible();
  expect(compact.requests - before).toBeLessThanOrEqual(2);
});

test.describe("branch graph request liveness", () => {
  const prisma = new PrismaClient();
  test.afterAll(() => prisma.$disconnect());

  async function seedChat(page: Page, title: string): Promise<string> {
    const response = await page.request.post("/api/chats", { data: { memoryMode: "EXCLUDED", title } });
    expect(response.status()).toBe(201);
    const chatId = (await response.json() as { chat: { id: string } }).chat.id;
    const question = await prisma.message.create({ data: {
      chatId,
      content: { blocks: [{ text: `${title} question`, type: "text" }] },
      role: "user",
      status: "complete"
    } });
    const answer = await prisma.message.create({ data: {
      chatId,
      content: { blocks: [{ text: `${title} answer`, type: "text" }] },
      modelId: "fake-qsa",
      parentMessageId: question.id,
      provider: "fake",
      role: "assistant",
      status: "complete"
    } });
    await prisma.chat.update({ data: { activeLeafMessageId: answer.id }, where: { id: chatId } });
    return chatId;
  }

  for (const viewport of viewports) {
    test(`a lagging summary and a failed graph never loop /branches (${viewport.label})`, async ({ page }, testInfo) => {
      test.setTimeout(120_000);
      execFileSync(process.execPath, ["--import", "tsx", "scripts/stateful-test-target.ts"], { stdio: "pipe" });
      await signInWithLocalToken(page);
      await page.setViewportSize({ height: viewport.height, width: viewport.width });
      const owned: string[] = [];
      const branchRequests = new Map<string, number>();
      page.on("request", (request) => {
        const match = /^\/api\/chats\/([^/]+)\/branches$/u.exec(new URL(request.url()).pathname);
        if (match) branchRequests.set(match[1]!, (branchRequests.get(match[1]!) ?? 0) + 1);
      });
      const count = (chatId: string) => branchRequests.get(chatId) ?? 0;
      try {
        const first = await seedChat(page, `Liveness first ${viewport.label}`);
        owned.push(first);
        const second = await seedChat(page, `Liveness second ${viewport.label}`);
        owned.push(second);
        // The address names the active chat; `/` always opens a new chat.
        await page.goto(`/c/${first}`);
        await expect(page.getByText(`Liveness first ${viewport.label} answer`)).toBeVisible();
        await expect.poll(() => count(first)).toBeGreaterThanOrEqual(1);
        await page.waitForTimeout(2_000);
        const firstBaseline = count(first);
        expect(firstBaseline).toBeLessThanOrEqual(2);

        // A server write the browser summary never sees (title generation,
        // another device) advances Chat.updatedAt exactly like the title job.
        await prisma.chat.updateMany({ data: { title: `Liveness renamed ${viewport.label}` }, where: { id: first } });

        const select = async (chatId: string) => {
          const navigation = await openNavigation(page, viewport.width);
          await navigation.locator(`[data-navigation-chat-id="${chatId}"]`).getByRole("treeitem").click();
        };
        await select(second);
        await expect(page.getByText(`Liveness second ${viewport.label} answer`)).toBeVisible();
        await select(first);
        await expect(page.getByText(`Liveness first ${viewport.label} answer`)).toBeVisible();
        await page.waitForTimeout(5_000);
        // At most one refresh per distinct revision: returning may adopt the
        // newer server revision once, never chase it in a loop.
        expect(count(first) - firstBaseline).toBeLessThanOrEqual(1);
        expect(count(second)).toBeLessThanOrEqual(2);
        await page.screenshot({ path: testInfo.outputPath(`branches-revision-${viewport.label}.png`) });

        // A negative HTTP outcome is kept until an explicit Retry. A cached
        // graph is deliberately not refetched, so the failure targets a chat
        // whose graph the browser has never loaded.
        const third = await seedChat(page, `Liveness third ${viewport.label}`);
        owned.push(third);
        let failBranches = true;
        await page.route(`**/api/chats/${third}/branches`, async (route) => {
          if (failBranches) await route.fulfill({ json: { error: "internal_error" }, status: 500 });
          else await route.continue();
        });
        await page.reload();
        // The reloaded shell first restores the addressed chat from its chat
        // list; a row chosen before that list arrives only reloads the list.
        await expect(page.getByText(`Liveness first ${viewport.label} answer`)).toBeVisible({ timeout: 15_000 });
        await select(third);
        await expect(page).toHaveURL(new RegExp(`/c/${third}(?:[?#]|$)`, "u"));
        await expect(page.getByText(`Liveness third ${viewport.label} answer`)).toBeVisible({ timeout: 15_000 });
        await page.getByTestId("header-more-trigger").click();
        await page.getByRole("menuitem", { name: "Branches" }).click();
        const branches = page.getByRole("dialog", { name: "Conversation branches" });
        await expect(branches.getByText("Could not load branches")).toBeVisible();
        const failed = count(third);
        await page.waitForTimeout(5_000);
        expect(count(third)).toBe(failed);
        await expectNoHorizontalOverflow(page);
        await page.screenshot({ path: testInfo.outputPath(`branches-error-${viewport.label}.png`) });

        failBranches = false;
        await branches.getByRole("button", { name: "Retry" }).click();
        await expect(branches.getByText("Could not load branches")).toHaveCount(0);
        await expect.poll(() => count(third)).toBe(failed + 1);
        await page.waitForTimeout(3_000);
        expect(count(third)).toBe(failed + 1);
      } finally {
        for (const id of owned) await deleteOwnedChatPermanently(page.request, id);
      }
    });
  }
});

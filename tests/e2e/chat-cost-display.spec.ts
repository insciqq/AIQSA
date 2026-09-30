import { expect, test, type Page } from "@playwright/test";
import type { ChatDetailWire, ChatMessageWire, ChatUsageStats } from "../../lib/contracts/chats";
import { matrixCatalog } from "./shell/catalog";
import { installMatrixCatalogFixture } from "./shell/catalogFixture";
import { expectNoHorizontalOverflow, expectWithinViewport } from "./support/layoutAssertions";
import { signInWithLocalToken } from "./support/localAuth";

const chatId = "chat-cost-fixture";
const questionId = "chat-cost-question";
const answerId = "chat-cost-answer";
const timestamp = "2026-09-30T00:00:00.000Z";
const model = matrixCatalog.models[0]!;
const knownUsage: ChatUsageStats = {
  hasCompletedAnswer: true,
  totalTokens: 43210, estimatedCostMicros: 125000, recordCount: 4,
  knownCostRecordCount: 4, incompleteRecordCount: 0
};
const viewports = [
  { width: 1440, height: 900 }, { width: 900, height: 1440 },
  { width: 820, height: 1180 }, { width: 1180, height: 820 },
  { width: 390, height: 844 }, { width: 844, height: 390 }
];

test.setTimeout(120_000);

function message(id: string, role: "assistant" | "user", content: string, parentMessageId: string | null): ChatMessageWire {
  return { id, role, content, parentMessageId, createdAt: timestamp, status: "complete",
    citationMessageId: null, errorMessage: null, modelId: role === "assistant" ? model.modelId : null,
    modelRunId: null, provider: role === "assistant" ? model.provider : null };
}

function fixture(usageStats: ChatUsageStats | null, empty = false): ChatDetailWire {
  return {
    assistant: null, id: chatId, title: "Chat spending", createdAt: timestamp, updatedAt: timestamp,
    activeLeafMessageId: empty ? null : answerId, defaultModelId: model.modelId,
    defaultProvider: model.provider, folderId: null, pinned: false, messageCount: empty ? 0 : 2,
    usageStats, contextStats: { approximateActiveBranchInputTokens: 400,
      ...(empty ? {} : { sessionMessageId: answerId, session: {
        approximateInputTokens: 3000, contextWindow: model.contextWindow, droppedMessages: 0,
        loadedTools: 0, maxOutputTokens: 1024, modelId: model.upstreamModelId,
        phase: "after_answer" as const, provider: model.providerFamily, safetyMarginTokens: 1000, version: 1 as const
      } }) },
    pageInfo: { activeLeafMessageId: empty ? null : answerId, beforeCursor: null, hasOlder: false, snapshotUpdatedAt: timestamp },
    workspace: { available: false, enabled: false, internetEnabled: false, sessionState: null },
    messages: empty ? [] : [message(questionId, "user", "A short question.", null),
      message(answerId, "assistant", "The first answer.", questionId)]
  };
}

async function prepare(page: Page, initial: ChatDetailWire) {
  const state = { chat: initial, allMessages: [...initial.messages] };
  await installMatrixCatalogFixture(page, { chats: [initial], folders: [] });
  await page.route("**/api/me/mcp", route => route.fulfill({ json: { servers: [] } }));
  await page.route("**/api/chats/compact?*", route => route.fulfill({ json: {
    chats: [{ id: chatId, title: initial.title, folderId: null, assistant: null, activeRun: false, updatedAt: state.chat.updatedAt }],
    folders: [], nextCursor: null
  } }));
  await page.route(`**/api/chats/${chatId}`, async route => {
    if (route.request().method() === "PATCH") {
      const { activeLeafMessageId } = route.request().postDataJSON() as { activeLeafMessageId: string };
      const selected = state.allMessages.find(item => item.id === activeLeafMessageId);
      expect(selected).toBeDefined();
      state.chat = { ...state.chat, activeLeafMessageId,
        messages: [state.allMessages[0]!, selected!],
        pageInfo: { ...state.chat.pageInfo, activeLeafMessageId } };
    }
    await route.fulfill({ json: { chat: state.chat } });
  });
  await page.route(`**/api/chats/${chatId}/branches`, route => route.fulfill({ json: { branchGraph: {
    activeLeafMessageId: state.chat.activeLeafMessageId, snapshotUpdatedAt: state.chat.updatedAt,
    nodes: state.allMessages.map(item => ({ id: item.id, parentMessageId: item.parentMessageId,
      preview: item.content, role: item.role, status: item.status }))
  } } }));
  // Any missed run fixture must fail before it can dispatch a provider request.
  await page.route("**/api/chats/*/messages", route => route.request().method() === "POST"
    ? route.fulfill({ status: 409, json: { error: "unexpected_fixture_run" } }) : route.fallback());
  await page.route("**/api/messages/*/regenerate", route => route.fulfill({ status: 409, json: { error: "unexpected_fixture_run" } }));
  await signInWithLocalToken(page, `/c/${chatId}`);
  await expect(page.getByTestId("header-title")).toHaveText(initial.title);
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
  return state;
}

function contextDialog(page: Page) {
  return page.getByRole("dialog", { name: "Chat context", exact: true });
}

async function openSpent(page: Page) {
  await page.getByTestId("header-context-indicator").click();
  const spent = contextDialog(page).getByRole("group", { name: "Spent", exact: true });
  await expect(spent).toBeVisible();
  return spent;
}

for (const state of [
  { name: "known", usage: knownUsage, amount: "≈ $0.125", tokens: "43,210" },
  { name: "partial", usage: { ...knownUsage, knownCostRecordCount: 2, incompleteRecordCount: 1 }, amount: "≈ $0.125", tokens: "43,210" },
  { name: "unknown", usage: { ...knownUsage, estimatedCostMicros: null, knownCostRecordCount: 0 }, amount: "—", tokens: "43,210" }
]) {
  test(`chat spent ${state.name} survives reload and fits both themes and orientations`, async ({ page }, testInfo) => {
    await prepare(page, fixture(state.usage));
    const spent = await openSpent(page);
    await expect(spent).toContainText(`Tokens spent${state.tokens}`);
    await expect(spent).toContainText(`Approximate cost${state.amount}`);
    if (state.name === "partial") {
      await expect(spent).toContainText("cost known for 2 of 4 requests");
      await expect(spent).toContainText("Token usage is incomplete for 1 of 4 requests.");
    } else await expect(spent).not.toContainText(/known for|incomplete/iu);
    await expect(contextDialog(page)).not.toContainText(/Memory|cached tokens|per answer/iu);
    await expect(contextDialog(page).getByText("Advanced details").locator("..")).not.toHaveAttribute("open");
    await page.reload();
    await expect(page.getByTestId("header-title")).toHaveText("Chat spending");
    await openSpent(page);
    await expect(spent).toContainText(`Tokens spent${state.tokens}`);
    await expect(spent).toContainText(`Approximate cost${state.amount}`);
    for (const theme of ["light", "dark"]) {
      await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
      for (const size of viewports) {
        await page.setViewportSize(size);
        await spent.scrollIntoViewIfNeeded();
        await expectWithinViewport(page, contextDialog(page));
        await expectWithinViewport(page, spent);
        await expectNoHorizontalOverflow(page);
        await page.screenshot({ path: testInfo.outputPath(`spent-${state.name}-${theme}-${size.width}x${size.height}.png`) });
      }
    }
    await page.keyboard.press("Escape");
    await expect(contextDialog(page)).toHaveCount(0);
    await expect(page.getByTestId("header-context-indicator")).toBeFocused();
  });
}

test("pre-answer PDF receipts stay hidden until the first answer, and regeneration and branches keep cumulative spent", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const state = await prepare(page, fixture({ hasCompletedAnswer: false, totalTokens: 750,
    estimatedCostMicros: 25000, recordCount: 1, knownCostRecordCount: 1, incompleteRecordCount: 0 }, true));
  await page.getByTestId("header-context-indicator").click();
  await expect(contextDialog(page).getByRole("group", { name: "Spent" })).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("header-title")).toHaveText("Chat spending");
  await page.getByTestId("header-context-indicator").click();
  await expect(contextDialog(page).getByRole("group", { name: "Spent" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  async function installRun(url: string, nextChat: ChatDetailWire, runId: string, nextAnswerId: string) {
    await page.route(url, async route => {
      state.chat = nextChat;
      const nextAnswer = nextChat.messages.find(item => item.id === nextAnswerId)!;
      state.allMessages = [...state.allMessages.filter(item => item.id !== questionId), nextChat.messages[0]!, nextAnswer];
      // Keep graph creation order independent of which leaf is currently visible.
      state.allMessages.sort((left, right) => left.role === "user" ? -1 : right.role === "user" ? 1 : 0);
      await route.fulfill({ contentType: "text/event-stream", body: [
        ["run_start", { provider: model.provider, modelId: model.modelId, runId, status: "streaming" }],
        ["message_start", { assistantMessageId: nextAnswerId, userMessageId: questionId }],
        ["chat_update", { chat: nextChat, messages: nextChat.messages }],
        ["done", { runId, status: "complete" }]
      ].map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`).join("") });
    });
    await page.route(`**/api/model-runs/${runId}`, route => route.fulfill({ json: { version: 1, run: { id: runId, status: "complete" } } }));
  }

  const first = fixture(knownUsage);
  first.updatedAt = "2026-09-30T00:01:00.000Z";
  first.pageInfo.snapshotUpdatedAt = first.updatedAt;
  first.messages[1]!.modelRunId = "chat-cost-first-run";
  await installRun(`**/api/chats/${chatId}/messages`, first, "chat-cost-first-run", answerId);
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  await composer.fill("A short question.");
  await composer.press("Enter");
  await expect(page.locator(`article[data-message-id="${answerId}"]`)).toContainText("The first answer.");
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeVisible();
  let spent = await openSpent(page);
  await expect(spent).toContainText("Tokens spent43,210");
  await expect(spent).toContainText("Approximate cost≈ $0.125");
  await page.keyboard.press("Escape");

  const nextAnswerId = "chat-cost-regenerated";
  const next: ChatDetailWire = { ...first, updatedAt: "2026-09-30T00:02:00.000Z", activeLeafMessageId: nextAnswerId, messageCount: 3,
    pageInfo: { ...first.pageInfo, activeLeafMessageId: nextAnswerId, snapshotUpdatedAt: "2026-09-30T00:02:00.000Z" },
    contextStats: { ...first.contextStats!, sessionMessageId: nextAnswerId },
    usageStats: { ...knownUsage, totalTokens: 53210, estimatedCostMicros: 150000, recordCount: 5, knownCostRecordCount: 5 },
    messages: [first.messages[0]!, { ...message(nextAnswerId, "assistant", "The regenerated answer.", questionId), modelRunId: "chat-cost-next-run" }] };
  await installRun(`**/api/messages/${answerId}/regenerate`, next, "chat-cost-next-run", nextAnswerId);
  await page.locator(`article[data-message-id="${answerId}"]`).hover();
  await page.getByRole("button", { name: "Regenerate answer", exact: true }).click();
  await expect(page.locator(`article[data-message-id="${nextAnswerId}"]`)).toContainText("The regenerated answer.");
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeVisible();
  spent = await openSpent(page);
  await expect(spent).toContainText("Tokens spent53,210");
  await expect(spent).toContainText("Approximate cost≈ $0.150");
  await page.keyboard.press("Escape");
  const checkout = page.waitForResponse(response => response.request().method() === "PATCH" && response.url().endsWith(`/api/chats/${chatId}`));
  await page.getByRole("button", { name: "Previous version", exact: true }).click();
  expect((await checkout).status()).toBe(200);
  await expect(page.locator(`article[data-message-id="${answerId}"]`)).toContainText("The first answer.");
  spent = await openSpent(page);
  await expect(spent).toContainText("Tokens spent53,210");
  await expect(spent).toContainText("Approximate cost≈ $0.150");
  await page.reload();
  await expect(page.locator(`article[data-message-id="${answerId}"]`)).toContainText("The first answer.");
  spent = await openSpent(page);
  await expect(spent).toContainText("Tokens spent53,210");
  await expect(spent).toContainText("Approximate cost≈ $0.150");
});

test("late title accounting refreshes the open Spent group with no reload or draft loss", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  let allowTerminal = false;
  let usageRequests = 0;
  let detailRequests = 0;
  const settledUsage: ChatUsageStats = { ...knownUsage, recordCount: 5,
    knownCostRecordCount: 5, estimatedCostMicros: 150000, totalTokens: 45210 };
  page.on("request", request => {
    if (request.method() === "GET" && new URL(request.url()).pathname === `/api/chats/${chatId}`) detailRequests += 1;
  });
  await page.route(`**/api/chats/${chatId}/title*`, route => {
    const wantsUsage = new URL(route.request().url()).searchParams.get("usage") === "1";
    if (wantsUsage) usageRequests += 1;
    // Invalid or unapplied generated titles still consumed provider usage.
    // Keep the title unchanged so accounting cannot depend on a rename.
    return route.fulfill({ json: { title: "Chat spending", pending: !allowTerminal,
      updatedAt: timestamp, ...(allowTerminal && wantsUsage ? { usageStats: settledUsage } : {}) } });
  });
  await prepare(page, { ...fixture(knownUsage), titlePending: true });
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  await composer.fill("Keep my unsent draft while the title settles.");
  const spent = await openSpent(page);
  await expect(spent).toContainText("Tokens spent43,210");
  await expect(spent).toContainText("Approximate cost≈ $0.125");
  const initialDetails = detailRequests;
  allowTerminal = true;
  await expect(spent).toContainText("Tokens spent45,210", { timeout: 20_000 });
  await expect(spent).toContainText("Approximate cost≈ $0.150");
  expect(usageRequests).toBeGreaterThan(0);
  expect(detailRequests).toBe(initialDetails);
  await expect(composer).toHaveValue("Keep my unsent draft while the title settles.");
  await expect(page.getByTestId("header-title")).toHaveText("Chat spending");
  await expect(page.locator(`article[data-message-id="${answerId}"]`)).toContainText("The first answer.");
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("spent-late-title-accounting.png") });
});

test("cold entry keeps following delayed title accounting after the visible title is no longer pending", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let settled = false;
  let usageRequests = 0;
  let detailRequests = 0;
  const pendingUsage: ChatUsageStats = { ...knownUsage, titleUsagePending: true,
    recordCount: 5, knownCostRecordCount: 4, incompleteRecordCount: 1 };
  const settledUsage: ChatUsageStats = { ...knownUsage, recordCount: 5, knownCostRecordCount: 5,
    estimatedCostMicros: 150000, totalTokens: 45210 };
  page.on("request", request => {
    if (request.method() === "GET" && new URL(request.url()).pathname === `/api/chats/${chatId}`) detailRequests += 1;
  });
  await page.route(`**/api/chats/${chatId}/title*`, route => {
    const wantsUsage = new URL(route.request().url()).searchParams.get("usage") === "1";
    if (wantsUsage) usageRequests += 1;
    // A manual rename or the presentation deadline already hid title progress.
    // The dispatched title receipt still needs its eventual provider usage.
    return route.fulfill({ json: { title: "Chat spending", pending: false, updatedAt: timestamp,
      ...(wantsUsage ? { usagePending: !settled, ...(settled ? { usageStats: settledUsage } : {}) } : {}) } });
  });
  await prepare(page, { ...fixture(pendingUsage), titlePending: false });
  await expect.poll(() => usageRequests, { timeout: 20_000 }).toBeGreaterThan(0);
  const requestsBeforeReload = usageRequests;
  await page.reload();
  await expect(page.getByTestId("header-title")).toHaveText("Chat spending");
  // A new document must bootstrap from the durable accounting flag; there is
  // no earlier titlePending state or in-memory polling queue to inherit.
  await expect.poll(() => usageRequests, { timeout: 20_000 }).toBeGreaterThan(requestsBeforeReload);
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  await composer.fill("Keep this draft after the cold reload.");
  const spent = await openSpent(page);
  await expect(spent).toContainText("Tokens spent43,210");
  await expect(spent).toContainText("Approximate cost≈ $0.125");
  await expect(spent).toContainText("cost known for 4 of 5 requests");
  const loadedDetails = detailRequests;
  settled = true;
  await expect(spent).toContainText("Tokens spent45,210", { timeout: 20_000 });
  await expect(spent).toContainText("Approximate cost≈ $0.150");
  await expect(spent).not.toContainText(/known for|incomplete/iu);
  expect(detailRequests).toBe(loadedDetails);
  await expect(composer).toHaveValue("Keep this draft after the cold reload.");
  await expect(page.getByTestId("header-title")).toHaveText("Chat spending");
  await expect(page.locator(`article[data-message-id="${answerId}"]`)).toContainText("The first answer.");
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("spent-cold-entry-late-title-accounting.png") });
});

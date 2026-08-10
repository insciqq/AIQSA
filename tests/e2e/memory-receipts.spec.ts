import { expect, test, type Page, type Route } from "@playwright/test";
import { memorySettingsFixture } from "../../components/app-shell/memoryTestFixtures";
import type {
  MemoryActionFeedback,
  MemoryReceipt
} from "../../lib/contracts/memory";
import { installMatrixCatalogFixture } from "./shell/catalogFixture";
import { signInWithLocalToken } from "./support/localAuth";

const timestamp = "2026-08-10T10:00:00.000Z";

function artifactSummary(input: Readonly<{
  action?: MemoryActionFeedback;
  receipt?: MemoryReceipt;
}> = {}) {
  return {
    citationCount: 0,
    citations: [],
    ...(input.action ? { memoryAction: input.action } : {}),
    ...(input.receipt ? { memoryReceipt: input.receipt } : {}),
    reasoningCount: 0,
    reasoningText: [],
    searchCount: 0,
    searchStrategy: null,
    toolCallCount: 0,
    toolCalls: []
  };
}

function receipt(
  includedText: string,
  versionId: string,
  overrides: Partial<MemoryReceipt> = {}
): MemoryReceipt {
  return {
    degradationCode: null,
    itemCount: 1,
    items: [{
      includedText,
      itemType: "FACT_VERSION",
      lifecycleState: "CURRENT",
      ordinal: 0,
      scopeType: "GLOBAL_USER",
      selectionReason: "explicit_lexical_relevance",
      sourceChatId: null,
      sourceMessageIds: [],
      sourceMode: "EXPLICIT",
      versionId
    }],
    outcome: "USED",
    summary: "memory_receipt:used:1",
    ...overrides
  };
}

function message(input: Readonly<{
  action?: MemoryActionFeedback;
  id: string;
  parentMessageId: string | null;
  receipt?: MemoryReceipt;
  role: "assistant" | "user";
  text: string;
}>) {
  return {
    artifactSummary: input.role === "assistant"
      ? artifactSummary({ action: input.action, receipt: input.receipt })
      : null,
    content: { blocks: [{ text: input.text, type: "text" }] },
    createdAt: timestamp,
    errorMessage: null,
    id: input.id,
    modelId: input.role === "assistant" ? "gpt-5.5" : null,
    modelRunId: input.role === "assistant" ? `run-${input.id}` : null,
    parentMessageId: input.parentMessageId,
    provider: input.role === "assistant" ? "openai" : null,
    role: input.role,
    status: "complete"
  };
}

async function openAnswerDetails(page: Page, answerId: string) {
  const answer = page.locator(`[data-message-id="${answerId}"]`);
  await answer.hover();
  await answer.getByRole("button", { name: "More message actions" }).click();
  await page.getByRole("menuitem", { name: "Show run details" }).click();
  await expect(answer.getByTestId("answer-metadata-block")).toBeVisible();
  return answer;
}

test("keeps exact Memory receipts and committed actions answer-bound", async ({ page }) => {
  const firstReceipt = receipt("First answer frozen memory.", "version-first");
  const secondReceipt = receipt("Second answer frozen memory.", "version-second", {
    degradationCode: "memory_vector_unavailable",
    itemCount: 2,
    items: [{
      ...receipt("Deleted-source previous-chat excerpt.", "unused").items[0]!,
      itemType: "RECALL_CHUNK",
      lifecycleState: "SOURCE_DELETED",
      scopeType: "CHAT",
      sourceMessageIds: ["source-message-deleted"],
      sourceMode: "HISTORY",
      versionId: null
    }, {
      ...receipt("Archived previous-chat episode.", "unused").items[0]!,
      includedText: "Archived previous-chat episode.",
      itemType: "EPISODE",
      lifecycleState: "CURRENT",
      ordinal: 1,
      scopeType: "CHAT",
      sourceChatId: "chat-memory-source-archived",
      sourceMessageIds: ["source-message-archived"],
      sourceMode: "HISTORY",
      versionId: null
    }],
    outcome: "DEGRADED",
    summary: "memory_receipt:degraded:2"
  });
  const messages = [
    message({ id: "user-save", parentMessageId: null, role: "user", text: "Remember this" }),
    message({
      action: { operation: "SAVE", status: "COMMITTED" },
      id: "assistant-save",
      parentMessageId: "user-save",
      receipt: firstReceipt,
      role: "assistant",
      text: "Saved answer"
    }),
    message({ id: "user-update", parentMessageId: "assistant-save", role: "user", text: "Update it" }),
    message({
      action: { operation: "UPDATE", status: "COMMITTED" },
      id: "assistant-update",
      parentMessageId: "user-update",
      receipt: secondReceipt,
      role: "assistant",
      text: "Updated answer"
    }),
    message({ id: "user-forget", parentMessageId: "assistant-update", role: "user", text: "Forget it" }),
    message({
      action: { operation: "FORGET", status: "COMMITTED" },
      id: "assistant-forget",
      parentMessageId: "user-forget",
      role: "assistant",
      text: "Forgotten answer"
    })
  ];
  const chat = {
    activeLeafMessageId: "assistant-forget",
    createdAt: timestamp,
    defaultModelId: "gpt-5.5",
    defaultProvider: "openai",
    folderId: null,
    id: "chat-memory-receipts",
    messageCount: messages.length,
    messages,
    pinned: false,
    title: "Memory receipt ownership",
    updatedAt: timestamp,
    usageStats: null
  };
  await page.addInitScript(() =>
    window.localStorage.setItem("aiqsa.activeChatId", "chat-memory-receipts")
  );
  await installMatrixCatalogFixture(page, { chats: [chat], folders: [] });
  await page.route("**/api/me/memory/settings", async (route: Route) => {
    await route.fulfill({ json: memorySettingsFixture({}, "EN") });
  });
  await page.route("**/api/chats/chat-memory-source-archived/source", async (route: Route) => {
    await route.fulfill({
      json: {
        source: {
          chatId: "chat-memory-source-archived",
          location: "ARCHIVED_PREVIEW",
          memoryMode: "NORMAL",
          sourceRevision: 2,
          updatedAt: timestamp
        }
      }
    });
  });
  await page.route("**/api/chats/chat-memory-source-archived/archive", async (route: Route) => {
    await route.fulfill({
      json: {
        chat: {
          activeLeafMessageId: "archived-source-assistant",
          archived: true,
          contextStats: { approximateActiveBranchInputTokens: 12 },
          createdAt: timestamp,
          defaultKnowledgePlan: null,
          defaultModelId: "gpt-5.5",
          defaultProvider: "openai",
          folderId: null,
          id: "chat-memory-source-archived",
          memoryMode: "NORMAL",
          messageCount: 2,
          messages: [
            message({
              id: "archived-source-user",
              parentMessageId: null,
              role: "user",
              text: "What did we decide?"
            }),
            message({
              id: "archived-source-assistant",
              parentMessageId: "archived-source-user",
              role: "assistant",
              text: "Archived previous-chat episode."
            })
          ],
          pageInfo: {
            activeLeafMessageId: "archived-source-assistant",
            beforeCursor: null,
            hasOlder: false,
            snapshotUpdatedAt: timestamp
          },
          pinned: false,
          sourceRevision: 2,
          title: "Archived Memory source",
          updatedAt: timestamp,
          usageStats: null
        }
      }
    });
  });
  await signInWithLocalToken(page);

  await expect(page.getByText("Memory saved.", { exact: true })).toBeVisible();
  await expect(page.getByText("Memory updated.", { exact: true })).toBeVisible();
  await expect(page.getByText("Memory forgotten and fenced from future use.", { exact: true }))
    .toBeVisible();

  const first = await openAnswerDetails(page, "assistant-save");
  const firstDisclosure = first.getByRole("button", { name: "Memory. 1 memory used" });
  await expect(firstDisclosure).toHaveAttribute("aria-expanded", "false");
  await expect(first.getByText("First answer frozen memory.", { exact: true })).toHaveCount(0);
  await firstDisclosure.click();
  await expect(first.getByText("First answer frozen memory.", { exact: true })).toBeVisible();
  await expect(first.getByText("Second answer frozen memory.", { exact: true })).toHaveCount(0);

  const second = await openAnswerDetails(page, "assistant-update");
  const secondDisclosure = second.getByRole("button", {
    name: "Memory. 2 previous chats used · retrieval degraded safely"
  });
  await expect(secondDisclosure).toHaveAttribute("aria-expanded", "false");
  await secondDisclosure.click();
  await expect(second.getByText("Deleted-source previous-chat excerpt.", { exact: true }))
    .toBeVisible();
  await expect(second.getByText("Archived previous-chat episode.", { exact: true }))
    .toBeVisible();
  await expect(second.getByText("Source deleted", { exact: true })).toBeVisible();
  await second.getByRole("button", { name: "Source · 1" }).click();
  const archived = page.getByRole("dialog", { name: "Archived Memory source" });
  await expect(archived.getByText("Archived previous-chat episode.", { exact: true }))
    .toBeVisible();
  await expect(second.getByText("First answer frozen memory.", { exact: true })).toHaveCount(0);
});

test("offers Manage Memories for an ambiguous target without claiming success", async ({ page }) => {
  const chat = {
    activeLeafMessageId: null,
    createdAt: timestamp,
    defaultModelId: "gpt-5.5",
    defaultProvider: "openai",
    folderId: null,
    id: "chat-memory-ambiguous",
    messageCount: 0,
    messages: [],
    pinned: false,
    title: "Ambiguous Memory target",
    updatedAt: timestamp,
    usageStats: null
  };
  await page.addInitScript(() =>
    window.localStorage.setItem("aiqsa.activeChatId", "chat-memory-ambiguous")
  );
  await installMatrixCatalogFixture(page, { chats: [chat], folders: [] });
  await page.route("**/api/me/memory/settings", async (route: Route) => {
    await route.fulfill({ json: memorySettingsFixture({}, "EN") });
  });
  await page.route("**/api/chats/chat-memory-ambiguous/messages", async (route: Route) => {
    await route.fulfill({
      contentType: "application/json",
      json: { error: "memory_intent_confirmation_required" },
      status: 409
    });
  });
  await signInWithLocalToken(page);

  const composer = page.getByRole("textbox", { name: "Message" });
  await composer.fill("Forget the preference I mentioned.");
  await page.getByRole("button", { name: "Send message" }).click();

  const notice = page.getByTestId("shell-notice");
  await expect(notice).toContainText(
    "Choose the exact saved memory before AIQSA changes anything."
  );
  await expect(notice).not.toContainText("Memory forgotten");
  await expect(composer).toHaveValue("Forget the preference I mentioned.");
  await notice.getByRole("button", { name: "Manage Memories" }).click();
  const settings = page.getByTestId("settings-dialog");
  await expect(settings.getByRole("heading", { exact: true, name: "Memory" })).toBeVisible();
  await expect(settings.getByRole("button", { name: "Manage Memories" })).toBeVisible();
});

import { expect, test, type Page, type Route } from "@playwright/test";
import {
  memorySettingsFixture,
  memorySummaryFixture
} from "../../components/app-shell/memoryTestFixtures";
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
  await expect(answer.getByTestId("evidence-row")).toBeVisible();
  return answer;
}

test("keeps exact Memory receipts and committed actions answer-bound", async ({ page }) => {
  const firstReceiptBase = receipt("First answer frozen memory.", "version-first");
  const firstReceipt: MemoryReceipt = {
    ...firstReceiptBase,
    items: [{
      ...firstReceiptBase.items[0]!,
      lifecycleState: "LATER_FORGOTTEN"
    }]
  };
  const secondReceipt = receipt("Second answer frozen memory.", "version-second", {
    degradationCode: "memory_vector_unavailable",
    itemCount: 3,
    items: [{
      ...receipt("Deleted-source previous-chat excerpt.", "unused").items[0]!,
      itemType: "RECALL_CHUNK",
      lifecycleState: "SOURCE_DELETED",
      scopeType: "CHAT",
      sourceMessageIds: ["source-message-deleted"],
      sourceMode: "HISTORY",
      versionId: null
    }, {
      ...receipt("Current previous-chat chunk.", "unused").items[0]!,
      itemType: "RECALL_CHUNK",
      lifecycleState: "CURRENT",
      ordinal: 1,
      scopeType: "CHAT",
      sourceChatId: "chat-memory-source-archived",
      sourceMessageIds: ["source-message-chunk"],
      sourceMode: "HISTORY",
      versionId: null
    }, {
      ...receipt("Archived previous-chat episode.", "unused").items[0]!,
      includedText: "Archived previous-chat episode.",
      itemType: "EPISODE",
      lifecycleState: "CURRENT",
      ordinal: 2,
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
              text: "Current previous-chat chunk. Archived previous-chat episode."
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
  await expect(page.getByText("Forgotten.", { exact: true })).toBeVisible();

  const first = await openAnswerDetails(page, "assistant-save");
  const firstDisclosure = first.getByRole("button", { name: "Memory. 1 memory used" });
  await expect(firstDisclosure).toHaveAttribute("aria-expanded", "false");
  await expect(first.getByText("First answer frozen memory.", { exact: true })).toHaveCount(0);
  await firstDisclosure.click();
  await expect(first.getByText("First answer frozen memory.", { exact: true })).toBeVisible();
  await expect(first.getByText("Later forgotten", { exact: true })).toBeVisible();
  await expect(first.getByText("Second answer frozen memory.", { exact: true })).toHaveCount(0);
  await expect(page.getByTestId("run-details-scrim")).toHaveCount(0);

  const second = await openAnswerDetails(page, "assistant-update");
  const secondDisclosure = second.getByRole("button", {
    name: "Memory. 2 previous chats used · retrieval degraded safely"
  });
  await expect(secondDisclosure).toHaveAttribute("aria-expanded", "false");
  await secondDisclosure.click();
  await expect(second.getByText("Deleted-source previous-chat excerpt.", { exact: true }))
    .toBeVisible();
  await expect(second.getByText("Current previous-chat chunk.", { exact: true })).toBeVisible();
  await expect(second.getByText("Archived previous-chat episode.", { exact: true }))
    .toBeVisible();
  await expect(second.getByText("Source deleted", { exact: true })).toBeVisible();
  await expect(second.getByText(/memory_vector_unavailable/u)).toBeVisible();
  const receiptItems = second.getByTestId("thread-memory-details").getByRole("listitem");
  const chunkItem = receiptItems.filter({ hasText: "Current previous-chat chunk." });
  const episodeItem = receiptItems.filter({ hasText: "Archived previous-chat episode." });
  await expect(chunkItem.getByRole("button", { name: "Source · 1" })).toBeVisible();
  await expect(episodeItem.getByRole("button", { name: "Source · 1" })).toBeVisible();
  await chunkItem.getByRole("button", { name: "Source · 1" }).click();
  const archived = page.getByRole("dialog", { name: "Archived Memory source" });
  await expect(archived.getByText(/Current previous-chat chunk\./u)).toBeVisible();
  await expect(archived.getByText("Archived previous-chat episode.", { exact: true }))
    .toHaveCount(0);
  await archived.getByRole("button", { name: "Close archive" }).click();
  await episodeItem.getByRole("button", { name: "Source · 1" }).click();
  const reopenedArchived = page.getByRole("dialog", { name: "Archived Memory source" });
  await expect(reopenedArchived.getByText(/Archived previous-chat episode\./u)).toBeVisible();
  await expect(second.getByText("First answer frozen memory.", { exact: true })).toHaveCount(0);
  await expect(page.getByTestId("run-details-scrim")).toHaveCount(0);
});

for (const locale of ["EN", "RU"] as const) {
  test(`keeps English controls while editing ${locale} Memory content inline`, async ({ page }) => {
    const action: MemoryActionFeedback = {
      factId: "memory-fact-paraphrase",
      operation: "SAVE",
      statement: locale === "RU"
        ? "Я предпочитаю краткие технические ответы."
        : "I prefer concise technical answers.",
      status: "COMMITTED",
      versionId: "memory-version-1"
    };
    const messages = [
      message({
        id: `user-action-${locale}`,
        parentMessageId: null,
        role: "user",
        text: locale === "RU" ? "Запомни моё предпочтение" : "Remember my preference"
      }),
      message({
        action,
        id: `assistant-action-${locale}`,
        parentMessageId: `user-action-${locale}`,
        role: "assistant",
        text: locale === "RU" ? "Готово." : "Done."
      })
    ];
    const chat = {
      activeLeafMessageId: `assistant-action-${locale}`,
      createdAt: timestamp,
      defaultModelId: "gpt-5.5",
      defaultProvider: "openai",
      folderId: null,
      id: `chat-memory-action-${locale}`,
      messageCount: messages.length,
      messages,
      pinned: false,
      title: `Memory action ${locale}`,
      updatedAt: timestamp,
      usageStats: null
    };
    const copy = {
      changed: "Saved text updated.",
      edit: "Edit",
      edited: locale === "RU"
        ? "Я предпочитаю краткие ответы с техническими деталями."
        : "I prefer concise answers with technical detail.",
      removed: "Saved memory removed.",
      restore: "Restore",
      restored: "Memory restored.",
      save: "Save",
      undo: "Undo"
    };
    await page.addInitScript((chatId) => {
      window.localStorage.setItem("aiqsa.activeChatId", chatId);
    }, chat.id);
    await installMatrixCatalogFixture(page, { chats: [chat], folders: [] });
    await page.route("**/api/me/memory/settings", async (route: Route) => {
      await route.fulfill({ json: memorySettingsFixture({}, locale) });
    });
    let authorizationOrdinal = 0;
    await page.route("**/api/me/memory/mutation-authorizations", async (route: Route) => {
      authorizationOrdinal += 1;
      await route.fulfill({
        json: {
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          mutationAuthorizationId: `authorization-${authorizationOrdinal}`
        },
        status: 201
      });
    });
    await page.route("**/api/me/memories/memory-fact-paraphrase", async (route: Route) => {
      await route.fulfill({
        json: {
          memory: memorySummaryFixture({
            currentVersionId: "memory-version-2",
            displayText: copy.edited,
            id: "memory-fact-paraphrase"
          })
        }
      });
    });
    await page.route("**/api/me/memories/memory-fact-paraphrase/forget", async (route: Route) => {
      await route.fulfill({
        json: {
          memory: memorySummaryFixture({
            currentVersionId: null,
            displayText: null,
            factState: "FORGOTTEN",
            id: "memory-fact-paraphrase",
            versionState: "FORGOTTEN"
          }),
          undo: {
            deletionId: "forget-deletion-1",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            versionId: "memory-version-2"
          }
        }
      });
    });
    await page.route("**/api/me/memories/memory-fact-paraphrase/undo-forget", async (route: Route) => {
      await route.fulfill({
        json: {
          memory: memorySummaryFixture({
            currentVersionId: "memory-version-3",
            displayText: copy.edited,
            id: "memory-fact-paraphrase"
          })
        }
      });
    });
    await signInWithLocalToken(page);

    const answer = page.locator(`[data-message-id="assistant-action-${locale}"]`);
    await expect(answer.getByTestId("memory-action-statement")).toContainText(action.statement!);
    await answer.getByRole("button", { name: copy.edit }).click();
    await answer.getByRole("textbox", { name: copy.edit }).fill(copy.edited);
    await answer.getByRole("button", { name: copy.save }).click();
    await expect(answer.getByText(copy.changed, { exact: true })).toBeVisible();
    await answer.getByRole("button", { name: copy.undo }).click();
    await expect(answer.getByText(copy.removed, { exact: true })).toBeVisible();
    await answer.getByRole("button", { name: copy.restore }).click();
    await expect(answer.getByText(copy.restored, { exact: true })).toBeVisible();
  });
}

test("records and retracts exact automatic receipt feedback without pre-confirmation", async ({ page }) => {
  const automaticBase = receipt(
    "The user prefers concise evidence-backed answers.",
    "version-automatic"
  );
  const automaticReceipt: MemoryReceipt = {
    ...automaticBase,
    items: [{
      ...automaticBase.items[0]!,
      factId: "fact-automatic",
      feedbackState: "AVAILABLE",
      runId: "run-assistant-automatic",
      runItemId: "run-item-automatic",
      selectionReason: "automatic_lexical_relevance",
      sourceMode: "AUTOMATIC"
    }]
  };
  const messages = [
    message({
      id: "user-automatic",
      parentMessageId: null,
      role: "user",
      text: "Give me the concise version."
    }),
    message({
      id: "assistant-automatic",
      parentMessageId: "user-automatic",
      receipt: automaticReceipt,
      role: "assistant",
      text: "Concise answer"
    }),
    message({
      id: "user-mark-incorrect",
      parentMessageId: "assistant-automatic",
      role: "user",
      text: "Mark that memory as incorrect."
    }),
    message({
      action: { operation: "MARK_INCORRECT", status: "COMMITTED" },
      id: "assistant-mark-incorrect",
      parentMessageId: "user-mark-incorrect",
      role: "assistant",
      text: "I recorded that feedback."
    })
  ];
  const chat = {
    activeLeafMessageId: "assistant-mark-incorrect",
    createdAt: timestamp,
    defaultModelId: "gpt-5.5",
    defaultProvider: "openai",
    folderId: null,
    id: "chat-memory-feedback-receipt",
    messageCount: messages.length,
    messages,
    pinned: false,
    title: "Memory feedback receipt",
    updatedAt: timestamp,
    usageStats: null
  };
  const feedbackRequests: Record<string, unknown>[] = [];
  await page.addInitScript(() =>
    window.localStorage.setItem("aiqsa.activeChatId", "chat-memory-feedback-receipt")
  );
  await installMatrixCatalogFixture(page, { chats: [chat], folders: [] });
  await page.route("**/api/me/memory/settings", async (route: Route) => {
    await route.fulfill({ json: memorySettingsFixture({}, "EN") });
  });
  await page.route("**/api/me/memories/fact-automatic/feedback", async (route: Route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    feedbackRequests.push(body);
    await route.fulfill({
      contentType: "application/json",
      json: body.feedbackType === "RETRACT"
        ? {
            createdAt: "2026-08-10T10:01:00.000Z",
            feedbackId: "feedback-retract-automatic",
            feedbackType: "RETRACT",
            retractedFeedbackId: "feedback-automatic",
            targetVersionId: "version-automatic"
          }
        : {
            createdAt: timestamp,
            feedbackId: "feedback-automatic",
            feedbackType: "INCORRECT",
            retractedFeedbackId: null,
            targetVersionId: "version-automatic"
          },
      status: 201
    });
  });
  await signInWithLocalToken(page);

  await expect(page.getByText("Incorrect Memory feedback recorded privately.", {
    exact: true
  })).toBeVisible();
  const answer = await openAnswerDetails(page, "assistant-automatic");
  await answer.getByRole("button", { name: "Memory. 1 memory used" }).click();
  await answer.getByRole("button", { name: "This is incorrect" }).click();
  await expect(answer.getByText("Marked incorrect", { exact: true })).toBeVisible();
  expect(feedbackRequests[0]).toMatchObject({
    expectedVersionId: "version-automatic",
    feedbackType: "INCORRECT",
    modelRunId: "run-assistant-automatic",
    modelRunMemoryItemId: "run-item-automatic"
  });
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await answer.getByRole("button", { name: "Undo" }).click();
  await expect(answer.getByRole("button", { name: "This is incorrect" })).toBeVisible();
  expect(feedbackRequests[1]).toMatchObject({
    expectedVersionId: "version-automatic",
    feedbackType: "RETRACT",
    modelRunId: "run-assistant-automatic",
    modelRunMemoryItemId: "run-item-automatic",
    retractsFeedbackId: "feedback-automatic"
  });
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

  const composer = page.getByRole("textbox", { name: "Сообщение" });
  await composer.fill("Forget the preference I mentioned.");
  await page.getByRole("button", { name: "Отправить сообщение" }).click();

  const notice = page.getByTestId("shell-notice");
  await expect(notice).toContainText(
    "Choose the exact saved memory before AIQSA changes anything."
  );
  await expect(notice).not.toContainText("Memory forgotten");
  await expect(composer).toHaveValue("Forget the preference I mentioned.");
  await notice.getByRole("button", { name: "Manage Memories" }).click();
  const memory = page.getByRole("tabpanel", { name: "Memory" });
  await expect(memory.getByRole("heading", { level: 2, name: "Memory" })).toBeVisible();
  await expect(memory.getByRole("button", { name: "Manage memories" })).toBeVisible();
});

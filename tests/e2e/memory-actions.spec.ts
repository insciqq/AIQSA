import { expect, test, type Route } from "@playwright/test";
import {
  memoryConsumerItemFixture,
  memoryConsumerSettingsFixture
} from "../support/memoryFixtures";
import type {
  MemoryActionFeedback,
  MemoryAnswerSource
} from "../../lib/contracts/memoryClient";
import { MEMORY_CONSUMER_CONFIRMATION_COPY_VERSION } from "../../lib/contracts/memoryConsumer";
import { installMatrixCatalogFixture } from "./shell/catalogFixture";
import { runAccountMenuAction } from "./shell/page";
import { signInWithLocalToken } from "./support/localAuth";

const timestamp = "2026-08-10T10:00:00.000Z";

function artifactSummary(input: Readonly<{
  action?: MemoryActionFeedback;
  memorySources?: readonly MemoryAnswerSource[];
}> = {}) {
  return {
    citations: [],
    ...(input.action ? { memoryAction: input.action } : {}),
    ...(input.memorySources ? { memorySources: [...input.memorySources] } : {}),
    reasoningText: [],
    sources: []
  };
}

function message(input: Readonly<{
  action?: MemoryActionFeedback;
  id: string;
  memorySources?: readonly MemoryAnswerSource[];
  parentMessageId: string | null;
  role: "assistant" | "user";
  text: string;
}>) {
  return {
    artifactSummary: input.role === "assistant"
      ? artifactSummary({ action: input.action, memorySources: input.memorySources })
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

test("keeps committed Memory actions on their originating answers", async ({ page }) => {
  const messages = [
    message({ id: "user-save", parentMessageId: null, role: "user", text: "Remember this" }),
    message({
      action: {
        memoryRef: "opaque-save-ref",
        operation: "SAVE",
        statement: "I prefer concise answers.",
        status: "COMMITTED"
      },
      id: "assistant-save",
      parentMessageId: "user-save",
      role: "assistant",
      text: "Saved answer"
    }),
    message({ id: "user-update", parentMessageId: "assistant-save", role: "user", text: "Update it" }),
    message({
      action: {
        memoryRef: "opaque-update-ref",
        operation: "UPDATE",
        statement: "I prefer very concise answers.",
        status: "COMMITTED"
      },
      id: "assistant-update",
      parentMessageId: "user-update",
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
    id: "chat-memory-actions",
    messageCount: messages.length,
    messages,
    pinned: false,
    title: "Memory action ownership",
    updatedAt: timestamp,
    usageStats: null
  };
  await page.addInitScript(() =>
    window.localStorage.setItem("aiqsa.activeChatId", "chat-memory-actions")
  );
  await installMatrixCatalogFixture(page, { chats: [chat], folders: [] });
  await page.route("**/api/me/memory/settings", async (route: Route) => {
    await route.fulfill({ json: memoryConsumerSettingsFixture() });
  });
  await signInWithLocalToken(page);

  await expect(page.getByText("Memory saved.", { exact: true })).toBeVisible();
  await expect(page.getByText("Memory updated.", { exact: true })).toBeVisible();
  await expect(page.getByText("Forgotten.", { exact: true })).toBeVisible();

  await expect(page.locator('[data-message-id="assistant-save"]')
    .getByText("Memory saved.", { exact: true })).toBeVisible();
  await expect(page.locator('[data-message-id="assistant-update"]')
    .getByText("Memory updated.", { exact: true })).toBeVisible();
  await expect(page.locator('[data-message-id="assistant-forget"]')
    .getByText("Forgotten.", { exact: true })).toBeVisible();
});

test("opens an exact Personal Memory source through the opaque action redirect", async ({ page }) => {
  const sourceMessages = [
    message({
      id: "source-user-message",
      parentMessageId: null,
      role: "user",
      text: "The exact earlier source statement."
    }),
    message({
      id: "source-assistant-message",
      parentMessageId: "source-user-message",
      role: "assistant",
      text: "Earlier answer"
    })
  ];
  const answerMessages = [
    message({
      id: "answer-user-message",
      parentMessageId: null,
      role: "user",
      text: "Use the relevant earlier context."
    }),
    message({
      id: "answer-assistant-message",
      memorySources: [{
        actions: ["CORRECT", "FORGET", "NOT_RELEVANT", "OPEN_SOURCE"],
        date: timestamp,
        memoryRef: "opaque-past-chat-source",
        origin: "Earlier conversation",
        sourceAvailable: true,
        sourceType: "PAST_CHAT",
        text: "The exact earlier source statement."
      }],
      parentMessageId: "answer-user-message",
      role: "assistant",
      text: "Answer using the earlier context."
    })
  ];
  const sourceChat = {
    activeLeafMessageId: "source-assistant-message",
    createdAt: timestamp,
    defaultModelId: "gpt-5.5",
    defaultProvider: "openai",
    folderId: null,
    id: "source-personal-chat",
    messageCount: sourceMessages.length,
    messages: sourceMessages,
    pinned: false,
    title: "Exact source chat",
    updatedAt: timestamp,
    usageStats: null
  };
  const answerChat = {
    ...sourceChat,
    activeLeafMessageId: "answer-assistant-message",
    id: "answer-memory-source-chat",
    messageCount: answerMessages.length,
    messages: answerMessages,
    title: "Answer with Memory source"
  };
  await page.addInitScript(() =>
    window.localStorage.setItem("aiqsa.activeChatId", "answer-memory-source-chat")
  );
  await installMatrixCatalogFixture(page, { chats: [answerChat, sourceChat], folders: [] });
  await page.route("**/api/me/memory/settings", async (route: Route) => {
    await route.fulfill({ json: memoryConsumerSettingsFixture() });
  });
  const navigationRequests: string[] = [];
  await page.route("**/api/me/memory/source-actions**", async (route: Route) => {
    const request = route.request();
    const requestUrl = new URL(request.url());
    if (request.method() === "GET" && requestUrl.pathname.endsWith("/open")) {
      navigationRequests.push(requestUrl.searchParams.get("memoryRef") ?? "");
      await route.fulfill({
        body: "",
        headers: { location: "/?chat=source-personal-chat&message=source-user-message" },
        status: 303
      });
      return;
    }
    const body = request.postDataJSON() as Record<string, unknown>;
    expect(body).toMatchObject({
      action: "OPEN_SOURCE",
      memoryRef: "opaque-past-chat-source"
    });
    await route.fulfill({
      json: {
        href: "/api/me/memory/source-actions/open?memoryRef=opaque-past-chat-source",
        status: "READY"
      }
    });
  });
  await signInWithLocalToken(page);

  // Memory recall lives inside the answer's process fold ("Used 1 memory").
  await page.getByTestId("tool-activity-disclosure").locator("summary").click();
  const sourceCard = page.getByTestId("memory-source-card");
  await sourceCard.getByRole("button", { name: "Open source" }).click();
  const openLink = sourceCard.getByRole("link", { name: "Open source" });
  await expect(openLink).toHaveAttribute("target", "_blank");
  // Keep the production new-tab contract visible above, then reuse this page
  // so the deterministic shell fixtures also cover the post-303 deep link.
  await openLink.evaluate((element) => element.removeAttribute("target"));
  await openLink.click();

  await expect(page).toHaveURL(/chat=source-personal-chat.*message=source-user-message/u);
  await expect(page.getByRole("heading", { name: "Exact source chat" })).toBeVisible();
  await expect(page.locator('[data-message-id="source-user-message"]')).toContainText(
    "The exact earlier source statement."
  );
  expect(navigationRequests).toEqual(["opaque-past-chat-source"]);
});

test("redirects an unavailable Memory source back to a bounded app notice", async ({ page }) => {
  const messages = [
    message({ id: "user-stale-source", parentMessageId: null, role: "user", text: "Open it." }),
    message({
      id: "assistant-stale-source",
      memorySources: [{
        actions: ["CORRECT", "FORGET", "NOT_RELEVANT", "OPEN_SOURCE"],
        date: timestamp,
        memoryRef: "opaque-stale-source",
        origin: "Earlier conversation",
        sourceAvailable: true,
        sourceType: "PAST_CHAT",
        text: "Source that became unavailable."
      }],
      parentMessageId: "user-stale-source",
      role: "assistant",
      text: "Earlier source attached."
    })
  ];
  const chat = {
    activeLeafMessageId: "assistant-stale-source",
    createdAt: timestamp,
    defaultModelId: "gpt-5.5",
    defaultProvider: "openai",
    folderId: null,
    id: "chat-stale-memory-source",
    messageCount: messages.length,
    messages,
    pinned: false,
    title: "Unavailable Memory source",
    updatedAt: timestamp,
    usageStats: null
  };
  await page.addInitScript(() =>
    window.localStorage.setItem("aiqsa.activeChatId", "chat-stale-memory-source")
  );
  await installMatrixCatalogFixture(page, { chats: [chat], folders: [] });
  await page.route("**/api/me/memory/settings", async (route: Route) => {
    await route.fulfill({ json: memoryConsumerSettingsFixture() });
  });
  await page.route("**/api/me/memory/source-actions**", async (route: Route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        body: "",
        headers: { location: "/?memorySource=unavailable" },
        status: 303
      });
      return;
    }
    await route.fulfill({
      json: {
        href: "/api/me/memory/source-actions/open?memoryRef=opaque-stale-source",
        status: "READY"
      }
    });
  });
  await signInWithLocalToken(page);

  // Memory recall lives inside the answer's process fold ("Used 1 memory").
  await page.getByTestId("tool-activity-disclosure").locator("summary").click();
  const sourceCard = page.getByTestId("memory-source-card");
  await sourceCard.getByRole("button", { name: "Open source" }).click();
  const openLink = sourceCard.getByRole("link", { name: "Open source" });
  await openLink.evaluate((element) => element.removeAttribute("target"));
  await openLink.click();

  await expect(page.getByTestId("shell-notice")).toContainText(
    "This Memory source is unavailable."
  );
  await expect(page).toHaveURL(/\/$/u);
  await expect(page.getByText("opaque-stale-source")).toHaveCount(0);
});

for (const locale of ["EN", "RU"] as const) {
  test(`renders a client-safe committed result for ${locale} Memory content`, async ({ page }) => {
    const action: MemoryActionFeedback = {
      memoryRef: `opaque-${locale.toLowerCase()}-ref`,
      operation: "SAVE",
      statement: locale === "RU"
        ? "Я предпочитаю краткие технические ответы."
        : "I prefer concise technical answers.",
      status: "COMMITTED"
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
    await page.addInitScript((chatId) => {
      window.localStorage.setItem("aiqsa.activeChatId", chatId);
    }, chat.id);
    await installMatrixCatalogFixture(page, { chats: [chat], folders: [] });
    await page.route("**/api/me/memory/settings", async (route: Route) => {
      await route.fulfill({ json: memoryConsumerSettingsFixture() });
    });
    await signInWithLocalToken(page);

    const answer = page.locator(`[data-message-id="assistant-action-${locale}"]`);
    await expect(answer.getByTestId("memory-action-statement")).toContainText(action.statement!);
    await expect(answer.getByText("Memory saved.", { exact: true })).toBeVisible();
    // One quiet line: Edit and Forget wait behind the notice's "⋯" menu.
    await answer.getByTestId("memory-action-menu").click();
    await expect(answer.getByRole("menuitem", { name: "Edit" })).toBeVisible();
    await expect(answer.getByRole("menuitem", { name: "Forget" })).toBeVisible();
  });
}

test("shows a rejected Memory action without post-hoc controls", async ({ page }) => {
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
      action: { operation: "UPDATE", status: "REJECTED" },
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
    id: "chat-memory-feedback-action",
    messageCount: messages.length,
    messages,
    pinned: false,
    title: "Memory feedback action",
    updatedAt: timestamp,
    usageStats: null
  };
  await page.addInitScript(() =>
    window.localStorage.setItem("aiqsa.activeChatId", "chat-memory-feedback-action")
  );
  await installMatrixCatalogFixture(page, { chats: [chat], folders: [] });
  await page.route("**/api/me/memory/settings", async (route: Route) => {
    await route.fulfill({ json: memoryConsumerSettingsFixture() });
  });
  await signInWithLocalToken(page);

  await expect(page.getByText("Memory action was not applied.", {
    exact: true
  })).toBeVisible();
  const answer = page.locator('[data-message-id="assistant-automatic"]');
  await expect(answer.getByRole("button", { name: "This is incorrect" })).toHaveCount(0);
});

test("renders an ambiguous result and mutates only the selected opaque candidate", async ({ page }) => {
  const candidates = [
    {
      category: "preferences",
      createdAt: timestamp,
      memoryRef: "opaque-candidate-concise",
      provenance: "SAVED" as const,
      sensitivity: "NORMAL" as const,
      statement: "I prefer concise answers."
    },
    {
      category: "preferences",
      createdAt: timestamp,
      memoryRef: "opaque-candidate-detailed",
      provenance: "SAVED" as const,
      sensitivity: "NORMAL" as const,
      statement: "I prefer detailed answers."
    }
  ];
  const messages = [
    message({
      id: "user-memory-ambiguous",
      parentMessageId: null,
      role: "user",
      text: "Update the preference I mentioned."
    }),
    message({
      action: {
        candidates,
        operation: "UPDATE",
        statement: "I prefer balanced answers.",
        status: "AMBIGUOUS"
      },
      id: "assistant-memory-ambiguous",
      parentMessageId: "user-memory-ambiguous",
      role: "assistant",
      text: "Choose the exact memory to update."
    })
  ];
  const chat = {
    activeLeafMessageId: "assistant-memory-ambiguous",
    createdAt: timestamp,
    defaultModelId: "gpt-5.5",
    defaultProvider: "openai",
    folderId: null,
    id: "chat-memory-ambiguous",
    messageCount: messages.length,
    messages,
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
    await route.fulfill({ json: memoryConsumerSettingsFixture() });
  });
  let selectedAction: Record<string, unknown> | null = null;
  await page.route("**/api/me/memory/source-actions", async (route: Route) => {
    selectedAction = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({ json: { status: "COMMITTED" } });
  });
  await signInWithLocalToken(page);

  const answer = page.locator('[data-message-id="assistant-memory-ambiguous"]');
  await expect(answer.getByText(/Several memories match\./u)).toBeVisible();
  await expect(answer.getByTestId("memory-action-candidate")).toHaveCount(2);
  await expect(answer.getByText("opaque-candidate-detailed")).toHaveCount(0);
  await answer.getByRole("button", { name: "Update this memory" }).nth(1).click();

  await expect.poll(() => selectedAction).toMatchObject({
    action: "CORRECT",
    memoryRef: "opaque-candidate-detailed",
    statement: "I prefer balanced answers."
  });
  expect(selectedAction).not.toHaveProperty("factId");
  expect(selectedAction).not.toHaveProperty("versionId");
  await expect(answer.getByText("Memory updated.", { exact: true })).toBeVisible();
});

test("confirms reset through the safe consumer action without technical IDs", async ({ page }) => {
  const chat = {
    activeLeafMessageId: null,
    createdAt: timestamp,
    defaultModelId: "gpt-5.5",
    defaultProvider: "openai",
    folderId: null,
    id: "chat-memory-reset",
    messageCount: 0,
    messages: [],
    pinned: false,
    title: "Reset Memory",
    updatedAt: timestamp,
    usageStats: null
  };
  let resetBody: Record<string, unknown> | null = null;
  await page.addInitScript(() =>
    window.localStorage.setItem("aiqsa.activeChatId", "chat-memory-reset")
  );
  await installMatrixCatalogFixture(page, { chats: [chat], folders: [] });
  await page.route("**/api/me/memory/settings", async (route: Route) => {
    await route.fulfill({ json: memoryConsumerSettingsFixture() });
  });
  await page.route("**/api/me/memory/reset", async (route: Route) => {
    resetBody = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({ json: { status: "IN_PROGRESS" }, status: 202 });
  });
  await signInWithLocalToken(page);

  await runAccountMenuAction(page, "Memory");
  await page.getByTestId("library-memory-panel")
    .getByRole("button", { name: "Manage memory" })
    .click();
  const memory = page.getByRole("dialog", { name: "Memory" });
  await memory.getByRole("button", { name: "Memory options" }).click();
  await page.getByRole("menuitem", { name: "Reset personal memory" }).click();
  const resetDialog = memory.getByRole("dialog", { name: "Reset personal memory?" });
  await expect(resetDialog).toBeVisible();
  await resetDialog.getByRole("button", { name: "Reset now" }).click();

  await expect.poll(() => resetBody).toMatchObject({
    confirmationCopyVersion: MEMORY_CONSUMER_CONFIRMATION_COPY_VERSION,
    requestId: expect.stringMatching(/^[a-f0-9]{48}$/u)
  });
  expect(Object.keys(resetBody!).sort()).toEqual(["confirmationCopyVersion", "requestId"]);
  await expect(memory.getByText(
    "Memory is off. Reset cleanup is continuing in the background."
  )).toBeVisible();
});

test("searches, edits, and forgets one exact saved memory", async ({ page }) => {
  const chat = {
    activeLeafMessageId: null,
    createdAt: timestamp,
    defaultModelId: "gpt-5.5",
    defaultProvider: "openai",
    folderId: null,
    id: "chat-memory-manager",
    messageCount: 0,
    messages: [],
    pinned: false,
    title: "Saved Memory manager",
    updatedAt: timestamp,
    usageStats: null
  };
  let current = memoryConsumerItemFixture({
    memoryRef: "opaque-memory-manager",
    statement: "I prefer concise architecture reviews."
  });
  let forgotten = false;
  let listRequests = 0;
  let searchBody: Record<string, unknown> | null = null;

  await page.addInitScript(() =>
    window.localStorage.setItem("aiqsa.activeChatId", "chat-memory-manager")
  );
  await installMatrixCatalogFixture(page, { chats: [chat], folders: [] });
  await page.route("**/api/me/memory/settings", async (route: Route) => {
    await route.fulfill({ json: memoryConsumerSettingsFixture() });
  });
  await page.route("**/api/me/memories*", async (route: Route) => {
    listRequests += 1;
    await route.fulfill({ json: { items: forgotten ? [] : [current], nextCursor: null } });
  });
  await page.route("**/api/me/memories/search", async (route: Route) => {
    searchBody = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({ json: { items: forgotten ? [] : [current], nextCursor: null } });
  });
  await page.route("**/api/me/memories/opaque-memory-manager", async (route: Route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    current = memoryConsumerItemFixture({
      ...current,
      memoryRef: "opaque-memory-manager-edited",
      statement: String(body.statement),
      updatedAt: "2026-08-10T10:01:00.000Z"
    });
    await route.fulfill({ json: { item: current } });
  });
  await page.route("**/api/me/memories/opaque-memory-manager-edited/forget", async (route: Route) => {
    forgotten = true;
    await route.fulfill({ json: { status: "FORGOTTEN" } });
  });
  await signInWithLocalToken(page);

  await runAccountMenuAction(page, "Memory");
  await page.getByTestId("library-memory-panel")
    .getByRole("button", { name: "Manage memory" })
    .click();
  const memoryWorkspace = page.getByRole("dialog", { name: "Memory" });
  await memoryWorkspace.getByRole("button", { name: "Manage memory" }).click();
  const manager = page.getByTestId("manage-memories");
  await expect.poll(() => listRequests).toBeGreaterThan(0);
  await expect(manager.getByTestId("memory-list-pane")
    .getByText(current.statement, { exact: true })).toBeVisible();

  await manager.getByRole("search").getByLabel("Search saved memories").fill("architecture");
  await manager.getByRole("search").getByRole("button", { name: "Search", exact: true }).click();
  await expect.poll(() => searchBody).toMatchObject({
    pageSize: 20,
    query: "architecture"
  });
  expect(searchBody).not.toBeNull();

  await manager.getByTestId("memory-list-pane")
    .getByText(current.statement, { exact: true })
    .click();
  await expect(manager.getByRole("heading", { name: "Memory detail" })).toBeVisible();
  await manager.getByRole("button", { name: "Edit", exact: true }).click();
  const statement = manager.getByLabel("Exact statement");
  await statement.fill("I prefer concise architecture reviews with evidence.");
  await manager.getByRole("button", { name: "Save changes" }).click();
  await expect(manager.getByText("Saved memory committed.", { exact: true })).toBeVisible();
  await expect(manager.getByTestId("memory-detail-pane")
    .getByText(current.statement, { exact: true })).toBeVisible();

  await manager.getByRole("button", { name: "Forget", exact: true }).click();
  await expect(manager.getByText("Forgotten.", { exact: true })).toBeVisible();
  await expect(manager.getByText("No saved memories match this search.", { exact: true })).toBeVisible();
});

import { expect, test, type Route } from "@playwright/test";
import {
  memorySettingsFixture,
  memorySummaryFixture
} from "../support/memoryFixtures";
import type {
  MemoryActionFeedback
} from "../../lib/contracts/memory";
import { installMatrixCatalogFixture } from "./shell/catalogFixture";
import { signInWithLocalToken } from "./support/localAuth";

const timestamp = "2026-08-10T10:00:00.000Z";

function artifactSummary(input: Readonly<{
  action?: MemoryActionFeedback;
}> = {}) {
  return {
    citations: [],
    ...(input.action ? { memoryAction: input.action } : {}),
    reasoningText: [],
    sources: []
  };
}

function message(input: Readonly<{
  action?: MemoryActionFeedback;
  id: string;
  parentMessageId: string | null;
  role: "assistant" | "user";
  text: string;
}>) {
  return {
    artifactSummary: input.role === "assistant"
      ? artifactSummary({ action: input.action })
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
      action: { operation: "SAVE", status: "COMMITTED" },
      id: "assistant-save",
      parentMessageId: "user-save",
      role: "assistant",
      text: "Saved answer"
    }),
    message({ id: "user-update", parentMessageId: "assistant-save", role: "user", text: "Update it" }),
    message({
      action: { operation: "UPDATE", status: "COMMITTED" },
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
    await route.fulfill({ json: memorySettingsFixture() });
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
      await route.fulfill({ json: memorySettingsFixture() });
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

test("shows committed automatic Memory feedback without post-hoc controls", async ({ page }) => {
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
    await route.fulfill({ json: memorySettingsFixture() });
  });
  await signInWithLocalToken(page);

  await expect(page.getByText("Incorrect Memory feedback recorded privately.", {
    exact: true
  })).toBeVisible();
  const answer = page.locator('[data-message-id="assistant-automatic"]');
  await expect(answer.getByRole("button", { name: "This is incorrect" })).toHaveCount(0);
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
    await route.fulfill({ json: memorySettingsFixture() });
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
  const memory = page.getByRole("tabpanel", { name: "Memory" });
  await expect(memory.getByRole("heading", { level: 2, name: "Memory" })).toBeVisible();
  await expect(memory.getByRole("button", { name: "Manage memories" })).toBeVisible();
});

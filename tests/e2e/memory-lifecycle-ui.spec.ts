import { expect, test, type Route } from "@playwright/test";
import { memorySettingsFixture } from "../../components/app-shell/memoryTestFixtures";
import { MEMORY_CONFIRMATION_COPY_VERSION } from "../../lib/contracts/memory";
import { installMatrixCatalogFixture } from "./shell/catalogFixture";
import { signInWithLocalToken } from "./support/localAuth";

const timestamp = "2026-08-10T10:00:00.000Z";
const deadline = "2026-08-11T10:00:00.000Z";

function message(
  id: string,
  role: "assistant" | "user",
  text: string,
  parentMessageId: string | null,
  runId: string | null = null
) {
  return {
    artifactSummary: null,
    content: { blocks: [{ text, type: "text" }] },
    createdAt: timestamp,
    errorMessage: null,
    id,
    modelId: role === "assistant" ? "gpt-5.5" : null,
    modelRunId: runId,
    parentMessageId,
    provider: role === "assistant" ? "openai" : null,
    role,
    status: "complete"
  };
}

function chatSummary(id: string, title: string, messageCount = 0) {
  return {
    activeLeafMessageId: messageCount ? "assistant-normal" : null,
    createdAt: timestamp,
    defaultKnowledgePlan: null,
    defaultModelId: "gpt-5.5",
    defaultProvider: "openai",
    folderId: null,
    id,
    messageCount,
    pinned: false,
    title,
    updatedAt: timestamp
  };
}

function sse(type: string, data: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

test("keeps Archive, Exclude, Restore, and immutable Temporary admission distinct", async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1440 });
  const normalMessages = [
    message("user-normal", "user", "Retained question", null),
    message("assistant-normal", "assistant", "Retained answer", "user-normal", "run-normal")
  ];
  const normal = {
    ...chatSummary("chat-normal", "Retained lifecycle", normalMessages.length),
    contextStats: { approximateActiveBranchInputTokens: 12 },
    messages: normalMessages,
    pageInfo: {
      activeLeafMessageId: "assistant-normal",
      beforeCursor: null,
      hasOlder: false,
      snapshotUpdatedAt: timestamp
    },
    usageStats: null
  };
  const temporary = chatSummary("chat-temporary", "Temporary lifecycle");
  let archived = false;
  let memoryMode: "EXCLUDED" | "NORMAL" = "NORMAL";
  let memoryRevision = 8;
  let sourceRevision = 1;
  const modePatches: Record<string, unknown>[] = [];
  const temporaryAdmissions: Record<string, unknown>[] = [];

  await page.addInitScript(() =>
    window.localStorage.setItem("aiqsa.activeChatId", "chat-normal")
  );
  await installMatrixCatalogFixture(page, { chats: [normal], folders: [] });
  await page.route("**/api/me/memory/settings", async (route: Route) => {
    await route.fulfill({
      contentType: "application/json",
      json: memorySettingsFixture({ settings: { memoryRevision } }, "EN")
    });
  });
  await page.route("**/api/me/chats/*/memory-mode", async (route: Route) => {
    const request = route.request();
    const chatId = new URL(request.url()).pathname.split("/").at(-2)!;
    if (request.method() === "GET") {
      await route.fulfill({
        contentType: "application/json",
        json: {
          chat: chatId === temporary.id
            ? {
                archived: false,
                chatId,
                mode: "TEMPORARY",
                sourceRevision: 1,
                temporaryRetentionDeadline: deadline,
                temporaryRetentionPolicyVersion: "temporary-24h-v1",
                updatedAt: timestamp
              }
            : {
                archived,
                chatId,
                mode: memoryMode,
                sourceRevision,
                temporaryRetentionDeadline: null,
                temporaryRetentionPolicyVersion: null,
                updatedAt: timestamp
              }
        }
      });
      return;
    }
    const body = request.postDataJSON() as Record<string, unknown>;
    modePatches.push(body);
    expect(body).toMatchObject({
      expectedChatRevision: sourceRevision,
      expectedMemoryRevision: memoryRevision
    });
    memoryMode = body.mode as typeof memoryMode;
    sourceRevision += 1;
    memoryRevision += 1;
    await route.fulfill({
      contentType: "application/json",
      json: {
        chatId,
        memoryGeneration: 3,
        memoryRevision,
        mode: memoryMode,
        sourceRevision
      }
    });
  });
  await page.route("**/api/chats/chat-normal/archive", async (route: Route) => {
    if (route.request().method() === "POST") {
      expect(route.request().postDataJSON()).toEqual({ expectedChatRevision: sourceRevision });
      archived = true;
      await route.fulfill({
        contentType: "application/json",
        json: {
          chat: {
            archived: true,
            id: normal.id,
            memoryMode,
            sourceRevision,
            updatedAt: timestamp
          }
        }
      });
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      json: {
        chat: {
          ...normal,
          archived: true,
          memoryMode,
          sourceRevision
        }
      }
    });
  });
  await page.route("**/api/chats/chat-normal/restore", async (route: Route) => {
    expect(route.request().postDataJSON()).toEqual({ expectedChatRevision: sourceRevision });
    archived = false;
    await route.fulfill({
      contentType: "application/json",
      json: {
        chat: {
          archived: false,
          id: normal.id,
          memoryMode,
          sourceRevision,
          updatedAt: timestamp
        }
      }
    });
  });
  await page.route("**/api/chats/archived", async (route: Route) => {
    await route.fulfill({
      contentType: "application/json",
      json: {
        chats: archived
          ? [{
              ...chatSummary(normal.id, normal.title, normal.messageCount),
              archived: true,
              memoryMode,
              sourceRevision
            }]
          : [],
        nextCursor: null
      }
    });
  });
  await page.route("**/api/chats", async (route: Route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      json: { chat: temporary },
      status: 201
    });
  });
  await page.route("**/api/chats/chat-temporary/messages", async (route: Route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    temporaryAdmissions.push(body);
    const user = message("user-temporary", "user", "Temporary draft marker", null);
    const assistant = message(
      "assistant-temporary",
      "assistant",
      "Temporary answer",
      user.id,
      "run-temporary"
    );
    await route.fulfill({
      body: [
        sse("run_start", { runId: "run-temporary" }),
        sse("message_start", {
          assistantMessageId: assistant.id,
          userMessageId: user.id
        }),
        sse("chat_update", {
          chat: {
            ...temporary,
            activeLeafMessageId: assistant.id,
            contextStats: { approximateActiveBranchInputTokens: 4 },
            messageCount: 2,
            usageStats: null
          },
          messages: [user, assistant]
        }),
        sse("done", { runId: "run-temporary", status: "complete" })
      ].join(""),
      contentType: "text/event-stream",
      status: 200
    });
  });

  await signInWithLocalToken(page);
  const workspace = page.getByRole("complementary", { name: "Навигация по чатам" });
  await expect(workspace.getByRole("button", { exact: true, name: "Retained lifecycle" })).toBeVisible();

  // One stateful toggle item: it starts checked (NORMAL) and each click flips
  // the retained Memory mode.
  await workspace.getByRole("button", { name: "Действия: Retained lifecycle" }).click();
  await page.getByRole("menu", { name: "Действия чата Retained lifecycle" })
    .getByRole("menuitem", { name: "Использовать память" }).click();
  await expect.poll(() => modePatches.length).toBe(1);
  expect(modePatches.at(-1)).toMatchObject({ mode: "EXCLUDED" });

  await workspace.getByRole("button", { name: "Действия: Retained lifecycle" }).click();
  await page.getByRole("menu", { name: "Действия чата Retained lifecycle" })
    .getByRole("menuitem", { name: "Использовать память" }).click();
  await expect.poll(() => modePatches.length).toBe(2);
  expect(modePatches.at(-1)).toMatchObject({
    mode: "NORMAL",
    resumeDisclosureCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION
  });

  await workspace.getByRole("button", { name: "Действия: Retained lifecycle" }).click();
  await page.getByRole("menu", { name: "Действия чата Retained lifecycle" })
    .getByRole("menuitem", { name: "Архивировать" }).click();
  await expect(workspace.getByRole("button", { exact: true, name: "Retained lifecycle" })).toHaveCount(0);

  await workspace.getByRole("button", { name: "Архив чатов" }).click();
  const archivedDialog = page.getByRole("dialog", { name: "Archived chats" });
  // Anchored: list rows now also carry Restore/Delete actions naming the chat.
  await archivedDialog.getByRole("button", { name: /^Retained lifecycle/ }).click();
  await expect(page.getByRole("dialog", { name: "Retained lifecycle" })).toContainText("Retained answer");
  await page.getByRole("dialog", { name: "Retained lifecycle" })
    .getByRole("button", { name: "Restore" }).click();
  await expect(workspace.getByRole("button", { exact: true, name: "Retained lifecycle" })).toBeVisible();

  const selectNewChatMode = async (itemName: RegExp) => {
    await workspace.getByRole("button", { name: "Режим нового чата" }).click();
    await page.getByRole("menu", { name: "Режим нового чата" })
      .getByRole("menuitem", { name: itemName }).click();
  };
  await workspace.getByRole("button", { name: "Новый чат" }).click();
  const composer = page.getByRole("textbox", { name: "Сообщение" });
  await composer.fill("Normal draft marker");
  await selectNewChatMode(/Временный чат/);
  await expect(page.getByTestId("header-temporary-indicator")).toBeVisible();
  await composer.fill("Temporary draft marker");
  await selectNewChatMode(/Обычный/);
  await expect(page.getByTestId("header-temporary-indicator")).toHaveCount(0);
  await expect(composer).toHaveValue("Normal draft marker");
  await selectNewChatMode(/Временный чат/);
  await expect(composer).toHaveValue("Temporary draft marker");
  await page.getByRole("button", { name: "Отправить сообщение" }).click();

  const temporaryIndicator = page.getByTestId("header-temporary-indicator");
  await expect(temporaryIndicator).toBeVisible();
  await temporaryIndicator.click();
  await expect(page.getByTestId("temporary-retention-deadline")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("temporary-retention-deadline")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Поделиться" })).toBeDisabled();
  expect(temporaryAdmissions).toHaveLength(1);
  expect(temporaryAdmissions[0]).toMatchObject({
    chatMode: "TEMPORARY",
    temporaryRetentionPolicyVersion: "temporary-24h-v1"
  });
  await expect(workspace.getByText("Temporary lifecycle")).toHaveCount(0);
});

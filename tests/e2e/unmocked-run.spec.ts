import { expect, test, type Page } from "@playwright/test";
import { providerTemplateIds } from "../../lib/domain/providerTemplates";
import { chooseSearchStrategy, selectModel } from "./shell/composer";

test.describe.configure({ mode: "serial" });
test.setTimeout(60_000);

type WorkspaceBody = {
  chats: {
    id: string;
    messageCount: number;
    title: string;
    updatedAt: string;
  }[];
};

type ChatDetailBody = {
  chat: {
    id: string;
    messages: {
      modelRunId: string | null;
      role: string;
      status: string;
    }[];
    title: string;
  };
};

type RunBody = {
  run: {
    id: string;
    status: string;
  };
  version: 1;
};

const testTitlePrefix = "E2E unmocked";

async function signIn(page: Page) {
  await page.addInitScript(() => {
    const clearedKey = "aiqsa.e2e.activeChatCleared";
    if (window.sessionStorage.getItem(clearedKey) === "1") return;
    window.localStorage.removeItem("aiqsa.activeChatId");
    window.sessionStorage.setItem(clearedKey, "1");
  });
  await page.goto("/");
  await expect(page).toHaveURL(/\/login/);
  const response = await page.request.post("/api/auth/token", {
    data: {
      token: "aiqsa-test-token"
    }
  });
  expect(response.ok()).toBe(true);
  await page.goto("/");
  await expect(page.getByTestId("app-shell")).toBeVisible();
}

async function cleanupUnmockedChats(page: Page) {
  const response = await page.request.get("/api/chats");
  if (!response.ok()) {
    return;
  }

  const body = (await response.json()) as WorkspaceBody;
  for (const chat of body.chats.filter((candidate) => candidate.title.startsWith(testTitlePrefix))) {
    await page.request.delete(`/api/chats/${chat.id}`);
  }
}

async function prepareFakeBlankChat(page: Page) {
  await page
    .getByRole("complementary", { name: "Chat navigation" })
    .getByRole("button", { name: "New chat", exact: true })
    .click();
  await expect(page.getByTestId("conversation-empty")).toBeVisible();
  await selectModel(page, providerTemplateIds.fakeConnection, "Fake QSA", "Fake QSA");
  await chooseSearchStrategy(page, "Off");
  await expect(page.getByTestId("header-model-trigger")).toContainText("Fake QSA");
}

async function waitForActiveChatId(page: Page): Promise<string> {
  let chatId: string | null = null;
  await expect
    .poll(async () => {
      chatId = await page.evaluate(() => window.localStorage.getItem("aiqsa.activeChatId"));
      return chatId;
    })
    .not.toBeNull();

  return chatId!;
}

async function latestRunForChat(page: Page, chatId: string): Promise<RunBody["run"] | null> {
  const chatResponse = await page.request.get(`/api/chats/${chatId}`);
  if (!chatResponse.ok()) {
    return null;
  }

  const detail = (await chatResponse.json()) as ChatDetailBody;
  let assistant: ChatDetailBody["chat"]["messages"][number] | null = null;
  for (let index = detail.chat.messages.length - 1; index >= 0; index -= 1) {
    const message = detail.chat.messages[index];
    if (message.role === "assistant" && message.modelRunId) {
      assistant = message;
      break;
    }
  }
  if (!assistant?.modelRunId) {
    return null;
  }

  const runResponse = await page.request.get(`/api/model-runs/${assistant.modelRunId}`);
  if (!runResponse.ok()) {
    return null;
  }

  const body = (await runResponse.json()) as RunBody;
  return body.version === 1 ? body.run : null;
}

test.beforeEach(async ({ page }) => {
  await signIn(page);
  await cleanupUnmockedChats(page);
  await page.reload();
  await expect(page.getByTestId("app-shell")).toBeVisible();
});

test.afterEach(async ({ page }) => {
  await cleanupUnmockedChats(page);
});

test("runs a fake-provider chat through real routes, Prisma, SSE, and answer outputs", async ({ page }) => {
  const titlePrefix = `${testTitlePrefix} happy path ${Date.now()}`;
  const prompt = titlePrefix;
  let chatId: string | null = null;

  try {
    await prepareFakeBlankChat(page);
    await page.getByRole("textbox", { name: "Message" }).fill(prompt);
    await page.getByRole("textbox", { name: "Message" }).press("Enter");
    chatId = await waitForActiveChatId(page);

    await expect(page.getByTestId("conversation-thread")).toContainText(`Fake answer: ${prompt}`, {
      timeout: 20_000
    });
    await expect(page.getByRole("button", { name: "Stop answer" })).toHaveCount(0, {
      timeout: 20_000
    });
    const answer = page.locator('article[data-role="assistant"]').last();
    await expect(answer).toContainText(`Fake answer: ${prompt}`);
    await expect(answer.getByRole("button", { name: /^Run details/u })).toHaveCount(0);
    await expect(answer).not.toContainText(/fake-qsa|search-disabled|fake-provider/);

    const run = await latestRunForChat(page, chatId);
    expect(run?.status).toBe("complete");
    expect(Object.keys(run ?? {}).sort()).toEqual(["id", "status"]);

    await page.reload();
    await expect(page.getByTestId("app-shell")).toBeVisible();
    const reloadedAnswer = page.locator('article[data-role="assistant"]').last();
    await expect(reloadedAnswer).toContainText(`Fake answer: ${prompt}`);
    await expect(reloadedAnswer.getByRole("button", { name: /^Run details/u })).toHaveCount(0);
  } finally {
    if (chatId) {
      await page.request.delete(`/api/chats/${chatId}`, { timeout: 5_000 }).catch(() => undefined);
    }
  }
});

test("streams a new answer on the branch created by editing an answered question", async ({ page }) => {
  const titlePrefix = `${testTitlePrefix} edit branch ${Date.now()}`;
  const prompt = `${titlePrefix} original`;
  const editedPrompt = `${titlePrefix} edited`;
  let chatId: string | null = null;

  try {
    await prepareFakeBlankChat(page);
    await page.getByRole("textbox", { name: "Message" }).fill(prompt);
    await page.getByRole("textbox", { name: "Message" }).press("Enter");
    chatId = await waitForActiveChatId(page);
    await expect(page.getByTestId("conversation-thread")).toContainText(`Fake answer: ${prompt}`, {
      timeout: 20_000
    });

    const question = page.locator('article[data-role="user"]').last();
    await question.hover();
    await question.getByRole("button", { name: "Edit question" }).click();
    const inlineEdit = question.getByTestId("inline-message-edit-v2");
    await expect(inlineEdit.getByRole("textbox", { name: "Edit question" })).toHaveValue(prompt);
    await inlineEdit.getByRole("textbox", { name: "Edit question" }).fill(editedPrompt);
    await inlineEdit.getByRole("textbox", { name: "Edit question" }).press("Enter");

    await expect(page.getByTestId("conversation-thread")).toContainText(editedPrompt, { timeout: 20_000 });
    await expect(page.getByTestId("conversation-thread")).toContainText(`Fake answer: ${editedPrompt}`, {
      timeout: 20_000
    });
    await expect(page.getByRole("button", { name: "Stop answer" })).toHaveCount(0, {
      timeout: 20_000
    });
    const run = await latestRunForChat(page, chatId);
    expect(run?.status).toBe("complete");
    expect(Object.keys(run ?? {}).sort()).toEqual(["id", "status"]);

    await page.reload();
    await expect(page.getByTestId("app-shell")).toBeVisible();
    await expect(page.getByTestId("conversation-thread")).toContainText(
      `Fake answer: ${editedPrompt}`,
      { timeout: 10_000 }
    );

    // Branches opens from the single header "⋯" menu.
    await page.getByTestId("header-more-trigger").click();
    await page.getByRole("menuitem", { name: "Branches" }).click();
    const branchTree = page.getByRole("dialog", { name: "Conversation branches" });
    await expect(branchTree).toContainText("Edited question");
    await expect(branchTree).toContainText("Original version");
    await branchTree.getByRole("button", { name: "Switch" }).click();
    await expect(page.getByTestId("conversation-thread")).toContainText(`Fake answer: ${prompt}`, {
      timeout: 10_000
    });
    await expect(page.getByTestId("conversation-thread")).not.toContainText(editedPrompt);
  } finally {
    if (chatId) {
      await page.request.delete(`/api/chats/${chatId}`, { timeout: 5_000 }).catch(() => undefined);
    }
  }
});

test("cancels an in-flight fake-provider stream without leaving the shell stuck", async ({ page }) => {
  const titlePrefix = `${testTitlePrefix} cancel path ${Date.now()}`;
  const prompt = `${titlePrefix} ${"slow token ".repeat(160)}`.trim();
  let chatId: string | null = null;

  try {
    await prepareFakeBlankChat(page);
    await page.getByRole("textbox", { name: "Message" }).fill(prompt);
    await page.getByRole("textbox", { name: "Message" }).press("Enter");
    chatId = await waitForActiveChatId(page);
    const stopButton = page.getByRole("button", { name: "Stop answer" });
    await expect(stopButton).toBeVisible({ timeout: 10_000 });
    await expect(stopButton).toBeEnabled({ timeout: 10_000 });
    const headerXDuring = (await page.getByTestId("header-model-trigger").boundingBox())?.x;

    await stopButton.click();

    await expect(page.getByRole("button", { name: "Stop answer" })).toHaveCount(0, { timeout: 10_000 });
    await expect
      .poll(async () => (chatId ? (await latestRunForChat(page, chatId))?.status ?? null : null), {
        timeout: 15_000
      })
      .toBe("cancelled");
    await expect(page.getByRole("textbox", { name: "Message" })).toBeEnabled();
    await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue("");
    await expect(page.locator(".v2-live-composer-error")).toHaveCount(0);
    expect(
      (await page.getByRole("alert").allTextContents()).filter((text) => text.trim())
    ).toEqual([]);
    await expect(page.locator('article[data-role="assistant"]').last()).toContainText("Stopped");
    await expect(page.getByRole("button", { name: "Regenerate", exact: true })).toBeVisible();
    const headerXAfter = (await page.getByTestId("header-model-trigger").boundingBox())?.x;
    expect(headerXDuring).toBeDefined();
    expect(headerXAfter).toBeDefined();
    expect(Math.abs(headerXAfter! - headerXDuring!)).toBeLessThanOrEqual(1);

  } finally {
    if (chatId) {
      await page.request.delete(`/api/chats/${chatId}`, { timeout: 5_000 }).catch(() => undefined);
    }
  }
});

test("shows a rejected send once at the composer with a Retry action", async ({ page }) => {
  const prompt = `${testTitlePrefix} rejected send ${Date.now()}`;
  let chatId: string | null = null;

  await page.route("**/api/chats/*/messages", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: { error: "provider_unavailable" },
      status: 502
    });
  });

  try {
    await prepareFakeBlankChat(page);
    await page.getByRole("textbox", { name: "Message" }).fill(prompt);
    await page.getByRole("textbox", { name: "Message" }).press("Enter");
    chatId = await waitForActiveChatId(page);

    const composerError = page.locator(".v2-live-composer-error");
    await expect(composerError).toHaveCount(1);
    await expect(composerError).toContainText(/provider is unavailable/iu);
    await expect(composerError.getByRole("button", { name: "Retry" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue(prompt);
    await expect(page.locator(".v2-live-notice")).toHaveCount(0);
    expect(
      (await page.getByRole("alert").allTextContents()).filter((text) => text.trim())
    ).toEqual([expect.stringMatching(/provider is unavailable/iu)]);
  } finally {
    await page.unroute("**/api/chats/*/messages");
    if (chatId) {
      await page.request.delete(`/api/chats/${chatId}`, { timeout: 5_000 }).catch(() => undefined);
    }
  }
});

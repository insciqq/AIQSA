import { expect, test, type Page } from "@playwright/test";

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
    events: {
      eventType: string;
    }[];
    id: string;
    status: string;
    totalTokens: number;
  };
};

const testTitlePrefix = "E2E unmocked";

async function signIn(page: Page) {
  await page.addInitScript(() => {
    window.localStorage.removeItem("aiqsa.activeChatId");
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

async function workspaceChats(page: Page): Promise<WorkspaceBody["chats"]> {
  const response = await page.request.get("/api/chats");
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as WorkspaceBody;

  return body.chats;
}

async function prepareFakeBlankChat(page: Page) {
  await page.getByRole("button", { name: "Start new chat" }).click();
  await expect(page.getByTestId("current-chat-title")).toHaveText("New chat");

  await page.getByRole("button", { name: "Select model" }).click();
  await page
    .getByTestId("model-picker")
    .getByRole("button", { name: "Select model Fake QSA Fake QSA" })
    .click();
  await expect(page.getByRole("button", { name: "Select model" })).toContainText("Fake QSA");
  await expect(page.getByRole("button", { name: "Select model" })).toHaveAttribute("title", "Fake QSA / Fake QSA");

  await page.getByRole("button", { name: "Search strategy" }).click();
  await page.getByTestId("search-select-options").locator('[data-option-value="search-disabled"]').click();
  await expect(page.locator("#search-select-current-value")).toHaveText("Off");
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

  return ((await runResponse.json()) as RunBody).run;
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

test("runs a fake-provider chat through real routes, Prisma, SSE, and Details", async ({ page }) => {
  const titlePrefix = `${testTitlePrefix} happy path ${Date.now()}`;
  const prompt = titlePrefix;
  let chatId: string | null = null;

  try {
    await prepareFakeBlankChat(page);
    await page.getByRole("textbox", { name: "Message" }).fill(prompt);
    await page.getByRole("textbox", { name: "Message" }).press("Enter");
    chatId = await waitForActiveChatId(page);

    await expect(page.getByTestId("thread")).toContainText(`Fake answer: ${prompt}`, { timeout: 20_000 });
    await expect(page.getByTestId("streaming-cursor")).toHaveCount(0, { timeout: 20_000 });
    await expect(page.getByTestId("composer-usage-line")).toBeVisible();
    await expect(page.getByTestId("current-context-length")).toHaveAccessibleName(/Approx\. input:/);
    await expect(page.getByTestId("composer-usage-line")).not.toContainText("cost");

    await page.getByRole("button", { name: "Open details" }).click();
    const details = page.getByTestId("details-pane");
    await details.getByRole("tab", { name: "Events" }).click();
    await expect(details.getByTestId("inspector-event-log")).toContainText("Provider status");
    await expect(details.getByTestId("inspector-event-log")).toContainText("Answer text");
    await expect(details.getByTestId("inspector-event-log")).toContainText("Usage");

    const run = await latestRunForChat(page, chatId);
    expect(run?.status).toBe("complete");
    expect(run?.totalTokens).toBeGreaterThan(0);
    expect(run?.events.map((event) => event.eventType)).toEqual(
      expect.arrayContaining(["artifact", "token", "usage", "done"])
    );
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
    const stopButton = page.getByRole("button", { name: "Stop response" });
    await expect(stopButton).toBeVisible({ timeout: 10_000 });
    await expect
      .poll(async () => (chatId ? (await latestRunForChat(page, chatId))?.status ?? null : null), {
        timeout: 10_000
      })
      .toBe("streaming");
    await expect(stopButton).toBeEnabled({ timeout: 10_000 });

    await stopButton.click();

    await expect(page.getByRole("button", { name: "Stop response" })).toHaveCount(0, { timeout: 10_000 });
    await expect(page.getByTestId("streaming-cursor")).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "Message" })).toBeEnabled();

    await expect
      .poll(async () => (chatId ? (await latestRunForChat(page, chatId))?.status ?? null : null), {
        timeout: 15_000
      })
      .toBe("cancelled");
  } finally {
    if (chatId) {
      await page.request.delete(`/api/chats/${chatId}`, { timeout: 5_000 }).catch(() => undefined);
    }
  }
});

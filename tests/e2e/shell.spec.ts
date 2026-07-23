import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { expect, test, type BrowserContext, type Route } from "@playwright/test";
import { hashPassword } from "../../lib/server/auth/password";
import {
  expectCenterUnobscured,
  expectNoHorizontalOverflow,
  expectTouchSafe,
  expectWithinViewport
} from "./support/layoutAssertions";
import { signInWithLocalToken as signIn } from "./support/localAuth";
import { matrixCatalog } from "./shell/catalog";
import { installMatrixCatalogFixture } from "./shell/catalogFixture";
import {
  chooseReasoningEffort,
  chooseSearchStrategy,
  closeRunSetup,
  closeRunSettings,
  composerRestingButton,
  composerRestingControls,
  composerRunSummary,
  openRunSetup,
  openRunSettings,
  reasoningOptionValues,
  runSettingsButton,
  selectModel
} from "./shell/composer";
import { expectComposerBeforeDetails, runAccountMenuAction, themeContrastMetrics } from "./shell/page";
import {
  closeResponsiveTouchStream,
  emitResponsiveTouchEvent,
  installResponsiveTouchStream,
  responsiveTouchViewports,
  waitForResponsiveTouchRequest
} from "./shell/responsive";
import {
  assistantContentWithText,
  expectThreadTextInViewport,
  scrollMessage,
  sseEvent,
  threadTextIsInViewport
} from "./shell/thread";
import { cleanupE2eWorkspace } from "./shell/workspace";

test.describe.configure({ mode: "serial" });

test("moves explicit mobile sends to the latest turn and keeps long answers anchored at their start", async ({ page }) => {
  await page.setViewportSize({ height: 844, width: 390 });
  const messages: ReturnType<typeof scrollMessage>[] = [];
  let parentMessageId: string | null = null;

  for (let index = 1; index <= 18; index += 1) {
    const userId = `user-scroll-${index}`;
    const assistantId = `assistant-scroll-${index}`;

    messages.push(
      scrollMessage(userId, "user", `Scroll question ${index}`, parentMessageId),
      scrollMessage(
        assistantId,
        "assistant",
        `Scroll answer ${index}${index === 18 ? " bottom marker" : ""}\n\n${"Detail line. ".repeat(8)}`,
        userId
      )
    );
    parentMessageId = assistantId;
  }

  await page.addInitScript(() => window.localStorage.setItem("aiqsa.activeChatId", "chat-scroll"));
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    let sendCount = 0;

    function event(type: string, data: unknown) {
      return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    }

    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");

      if (method === "POST" && url.endsWith("/api/chats/chat-scroll/messages")) {
        sendCount += 1;
        const requestBody = typeof init?.body === "string" ? JSON.parse(init.body) : {};
        window.localStorage.setItem(`aiqsa.testStreamMode.${sendCount}`, String(requestBody?.params?.stream));
        const prompt = requestBody?.content?.blocks?.[0]?.text ?? `Scroll prompt ${sendCount}`;
        const userId = `user-scroll-stream-${sendCount}`;
        const assistantId = `assistant-scroll-stream-${sendCount}`;
        const answerStart = "Anchored answer start marker";
        const answerTail = "Anchored answer tail marker";
        const longAnswerBody = Array.from(
          { length: 80 },
          (_, index) => `Reading anchor detail ${index + 1}. ${"Long streamed explanation. ".repeat(4)}`
        ).join("\n\n");
        const answer =
          sendCount === 1
            ? `${answerStart}\n\n${longAnswerBody}\n\n${answerTail}`
            : "Unpinned streaming answer";
        const encoder = new TextEncoder();
        const tokenChunks =
          sendCount === 1
            ? [
                event("token", {
                  delta: `${answerStart}\n\n`
                }),
                "event: token\ndata: {not json\n\n",
                event("token", {
                  delta: `${longAnswerBody}\n\n`
                }),
                event("token", {
                  delta: answerTail
                })
              ]
            : [
                event("token", {
                  delta: answer
                })
              ];
        const chunks = [
          event("message_start", {
            assistantMessageId: assistantId,
            runId: `run-scroll-stream-${sendCount}`,
            userMessageId: userId
          }),
          event("artifact", {
            artifactType: "search",
            payload: {
              query: "stream progress e2e",
              status: "searching",
              strategy: "openai-native-web-search"
            }
          }),
          ...tokenChunks,
          event("chat_update", {
            chat: {
              activeLeafMessageId: assistantId,
              createdAt: "2026-06-10T00:00:00.000Z",
              defaultModelId: "gpt-5.5",
              defaultPromptPresetId: "prompt-helpful",
              defaultProvider: "openai",
              folderId: null,
              id: "chat-scroll",
              messageCount: 36 + sendCount * 2,
              pinned: false,
              title: "Scroll behavior chat",
              updatedAt: "2026-06-10T00:00:01.000Z",
              usageStats: null
            },
            messages: [
              {
                artifactSummary: null,
                content: {
                  blocks: [{ text: prompt, type: "text" }]
                },
                createdAt: "2026-06-10T00:00:01.000Z",
                errorMessage: null,
                id: userId,
                modelId: "gpt-5.5",
                modelRunId: null,
                parentMessageId: sendCount === 1 ? "assistant-scroll-18" : "assistant-scroll-stream-1",
                provider: "openai",
                role: "user",
                status: "complete"
              },
              {
                artifactSummary: null,
                content: {
                  blocks: [{ text: answer, type: "text" }]
                },
                createdAt: "2026-06-10T00:00:01.000Z",
                errorMessage: null,
                id: assistantId,
                modelId: "gpt-5.5",
                modelRunId: `run-scroll-stream-${sendCount}`,
                parentMessageId: userId,
                provider: "openai",
                role: "assistant",
                status: "complete"
              }
            ]
          }),
          event("done", {
            status: "complete"
          })
        ];
        const delays =
          sendCount === 1
            ? [100, 1_800, 3_200, 3_400, 3_800, 4_200, 4_600, 6_000]
            : [100, 450, 800, 1_100, 1_600];

        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              chunks.forEach((chunk, index) => {
                window.setTimeout(() => {
                  controller.enqueue(encoder.encode(chunk));
                  if (index === chunks.length - 1) {
                    controller.close();
                  }
                }, delays[index] ?? index * 150);
              });
            }
          }),
          {
            headers: {
              "content-type": "text/event-stream"
            },
            status: 200
          }
        );
      }

      return originalFetch(input, init);
    };
  });
  const scrollChat = {
    activeLeafMessageId: "assistant-scroll-18",
    createdAt: "2026-06-10T00:00:00.000Z",
    defaultModelId: "gpt-5.5",
    defaultPromptPresetId: "prompt-helpful",
    defaultProvider: "openai",
    folderId: null,
    id: "chat-scroll",
    messageCount: messages.length,
    messages,
    pinned: false,
    title: "Scroll behavior chat",
    updatedAt: "2026-06-10T00:00:01.000Z",
    usageStats: null
  };
  await installMatrixCatalogFixture(page, {
    chats: [scrollChat],
    folders: []
  });
  await page.route("**/api/chats/chat-scroll", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    await route.fulfill({ contentType: "application/json", json: { chat: scrollChat } });
  });

  await signIn(page);
  await expectThreadTextInViewport(page, "Scroll answer 18 bottom marker");
  const runSetup = await openRunSetup(page);
  const streamButton = runSetup.getByRole("button", { name: "Stream response" });
  await expect(streamButton).toHaveAttribute("aria-pressed", "false");
  await streamButton.click();
  await expect(streamButton).toHaveAttribute("aria-pressed", "true");
  await closeRunSetup(page);

  await page.getByRole("textbox", { name: "Message" }).fill("Pinned stream question");
  await page.getByRole("textbox", { name: "Message" }).press("Enter");
  const liveActivity = page.getByTestId("pipeline-indicator");
  await expect(liveActivity).toHaveAttribute("data-phase", "running");
  await expect(liveActivity).toContainText("Working…");
  const threadActivity = page.getByTestId("thread-run-activity");
  await expect(threadActivity).toHaveText("Working…");
  await expect(threadActivity).not.toContainText(/Question|Search|Answer waiting/i);
  await expectNoHorizontalOverflow(page);
  await expect(threadActivity).toHaveText("Searching…");
  await expect(liveActivity).toContainText("Searching…");
  await expect(assistantContentWithText(page, "Anchored answer start marker")).toBeVisible();
  await expect(threadActivity).toHaveText("Answering…");
  await expect(liveActivity).toContainText("Answering…");
  await liveActivity.click();
  const details = page.getByTestId("details-pane");
  await expect(details).toHaveAttribute("role", "dialog");
  await expect(details.getByRole("tab", { name: "Events" })).toHaveAttribute("aria-selected", "true");
  await expectThreadTextInViewport(page, "Anchored answer start marker");
  await expect
    .poll(() => page.evaluate(() => window.localStorage.getItem("aiqsa.testStreamMode.1")))
    .toBe("true");
  await expect(details.getByTestId("inspector-event-log")).toContainText("Search artifacts");
  await expect(details.getByTestId("inspector-event-log")).toContainText("stream progress e2e");
  await expect(details.getByTestId("inspector-event-log")).toContainText("Warning");
  await expect(details.getByTestId("inspector-event-log")).toContainText("Skipped malformed stream frame");
  await details.getByRole("button", { name: "Close details" }).click();
  await expect(page.getByTestId("thread-run-warnings")).toContainText("Skipped malformed stream frame");
  await expect(assistantContentWithText(page, "Anchored answer tail marker")).toBeVisible();
  const thread = page.getByTestId("thread");
  expect(await threadTextIsInViewport(page, "Anchored answer start marker")).toBe(true);
  expect(await threadTextIsInViewport(page, "Anchored answer tail marker")).toBe(false);

  await expect(page.getByTestId("jump-to-latest")).toBeVisible();
  await page.getByTestId("jump-to-latest").click();
  await expectThreadTextInViewport(page, "Anchored answer tail marker");
  await expect(page.getByRole("button", { name: "Send message" })).toBeVisible();

  await thread.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect(page.getByTestId("jump-to-latest")).toBeVisible();

  await page.getByRole("textbox", { name: "Message" }).fill("Unpinned stream question");
  await page.getByRole("textbox", { name: "Message" }).press("Enter");
  await expectThreadTextInViewport(page, "Unpinned stream question");
  await expect(assistantContentWithText(page, "Unpinned streaming answer")).toBeVisible();
  await expectThreadTextInViewport(page, "Unpinned streaming answer");
  await expect(page.getByTestId("streaming-cursor")).toHaveCount(0);
  await expect(page.getByTestId("thread-complete-answer-spacer")).toBeVisible();
  await expect(page.getByTestId("jump-to-latest")).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
});

test("signs out from the authenticated account menu and clears the session", async ({ page }) => {
  await signIn(page);

  await page.getByRole("button", { name: "Account menu" }).click();
  await expect(page.getByRole("menu", { name: "Account" })).toContainText("operator@aiqsa.local");
  await Promise.all([
    page.waitForURL(/\/login(?:\?|$)/),
    page.getByRole("menuitem", { name: "Sign out" }).click()
  ]);

  await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
  await page.goto("/");
  await expect(page).toHaveURL(/\/login(?:\?|$)/);
});

test("keeps first-load workspace failure owned by one mobile recovery surface until Retry succeeds", async ({ page }) => {
  await page.setViewportSize({ height: 844, width: 390 });
  let catalogReads = 0;
  let workspaceReads = 0;
  await page.route("**/api/me/catalog", async (route) => {
    catalogReads += 1;
    await route.fulfill({ contentType: "application/json", json: { catalog: matrixCatalog } });
  });
  const recoverWorkspace = async (route: Route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }

    workspaceReads += 1;
    if (workspaceReads === 1) {
      await route.fulfill({
        contentType: "application/json",
        json: { error: "workspace_e2e_unavailable" },
        status: 500
      });
      return;
    }

    await route.fulfill({ contentType: "application/json", json: { chats: [], contentMatches: [], folders: [] } });
  };
  await page.route("**/api/chats?*", recoverWorkspace);
  await page.route("**/api/chats", recoverWorkspace);

  await signIn(page);
  const recovery = page.getByTestId("workspace-error-state");
  const retry = page.getByRole("button", { name: "Retry loading workspace" });
  const composer = page.getByRole("textbox", { name: "Message" });
  await expect(recovery).toContainText("Workspace didn't load");
  await expect(recovery).toContainText("workspace_failed_500");
  await expect(retry).toHaveCount(1);
  await expect(page.getByTestId("shell-notice-layer")).toHaveCount(0);
  await expect(composer).toBeDisabled();
  await expect(page.getByTestId("composer-disabled-hint")).toContainText(
    "Workspace unavailable. Retry loading before sending."
  );
  const directNewChat = page.getByTestId("mobile-new-chat-button");
  await expect(directNewChat).toBeDisabled();

  await page.getByRole("button", { name: "Open workspace" }).click();
  const workspace = page.getByTestId("workspace-pane-mobile");
  await expect(workspace.getByRole("button", { name: "Start new chat" })).toBeDisabled();
  await expect(workspace.getByRole("button", { name: "New folder" })).toBeDisabled();
  await expect(workspace.getByLabel("Search chats")).toBeDisabled();
  await expect(workspace.getByTestId("left-workspace-unavailable")).toContainText(
    "Chats unavailable. Use Retry in the conversation pane."
  );
  await expect(workspace.getByText("No chats yet", { exact: true })).toHaveCount(0);
  await workspace.getByRole("button", { name: "Close workspace" }).click();

  await retry.click();
  await expect(recovery).toHaveCount(0);
  await expect(composer).toBeEnabled();
  await expect(directNewChat).toBeEnabled();
  await expect.poll(() => workspaceReads).toBe(2);
  expect(catalogReads).toBe(1);
  await page.getByRole("button", { name: "Open workspace" }).click();
  await expect(workspace.getByRole("button", { name: "Start new chat" })).toBeEnabled();
  await expect(workspace.getByText("No chats yet", { exact: true })).toBeVisible();
});

test("recovers catalog loading while keeping Settings Appearance usable and prompt actions gated", async ({ page }) => {
  let catalogReads = 0;
  let workspaceReads = 0;
  await page.route("**/api/me/catalog", async (route) => {
    catalogReads += 1;
    if (catalogReads === 1) {
      await route.fulfill({
        contentType: "application/json",
        json: { error: "catalog_e2e_unavailable" },
        status: 500
      });
      return;
    }

    await route.fulfill({ contentType: "application/json", json: { catalog: matrixCatalog } });
  });
  const fulfillWorkspace = async (route: Route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    workspaceReads += 1;
    await route.fulfill({ contentType: "application/json", json: { chats: [], contentMatches: [], folders: [] } });
  };
  await page.route("**/api/chats?*", fulfillWorkspace);
  await page.route("**/api/chats", fulfillWorkspace);

  await signIn(page);
  const catalogState = page.getByTestId("catalog-error-state");
  const composer = page.getByRole("textbox", { name: "Message" });
  await expect(catalogState).toContainText("Models didn't load");
  await expect(page.getByRole("button", { name: "Retry loading models" })).toHaveCount(1);
  await expect(composer).toBeDisabled();
  await expect(page.getByTestId("composer-disabled-hint")).toContainText(
    "Models unavailable. Retry loading before sending."
  );
  await expect(page.getByRole("button", { name: "Select model" })).toContainText("Models unavailable");

  await page.getByRole("button", { name: "Open settings" }).click();
  const settings = page.getByTestId("settings-dialog");
  const promptRecovery = settings.getByTestId("settings-prompts-catalog-state");
  await expect(promptRecovery).toContainText("Prompt library didn’t load");
  await expect(settings.getByLabel("Prompt name")).toHaveCount(0);
  await expect(settings.getByRole("button", { name: "New prompt" })).toHaveCount(0);

  await settings.getByRole("button", { name: "Appearance" }).click();
  await expect(settings.getByRole("heading", { name: "Appearance" })).toBeVisible();
  await settings.getByRole("radio", { name: /^Use Graphite theme/ }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "graphite");
  await settings.getByRole("button", { name: "Prompts" }).click();
  await settings.getByRole("button", { name: "Retry loading prompt library" }).click();

  await expect(settings.getByLabel("Prompt name")).toBeVisible();
  await expect(promptRecovery).toHaveCount(0);
  await expect(catalogState).toHaveCount(0);
  await expect.poll(() => catalogReads).toBe(2);
  await expect.poll(() => workspaceReads).toBe(2);
  await settings.getByRole("button", { name: "Close settings" }).click();
  await expect(settings).toHaveCount(0);
  await expect(composer).toBeEnabled();
});

test("keeps a closed-menu sign-out failure discoverable and lets the user retry", async ({ page }) => {
  await page.setViewportSize({ height: 844, width: 390 });
  let signOutAttempts = 0;
  let releaseFailure!: () => void;
  const failureGate = new Promise<void>((resolve) => {
    releaseFailure = resolve;
  });
  await page.route("**/api/auth/logout", async (route) => {
    signOutAttempts += 1;
    if (signOutAttempts === 1) {
      await failureGate;
      await route.fulfill({
        contentType: "application/json",
        json: { error: "logout_failed" },
        status: 503
      });
      return;
    }

    await route.continue();
  });

  await signIn(page);
  const accountTrigger = page.getByRole("button", { name: "Account menu" });
  await accountTrigger.click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page.getByRole("menuitem", { name: "Signing out…" })).toBeDisabled();
  await accountTrigger.click();
  await expect(page.getByRole("menu", { name: "Account" })).toHaveCount(0);
  releaseFailure();

  await expect(page.getByRole("alert").filter({ hasText: "Sign out failed" })).toContainText(
    "Open Account to retry."
  );
  await expect(page.getByTestId("account-error-cue")).toBeVisible();
  await expect(accountTrigger).toHaveAttribute("aria-describedby", "account-sign-out-error-description");
  await accountTrigger.click();
  const accountMenu = page.getByRole("menu", { name: "Account" });
  await expect(accountMenu).toContainText("Could not sign out. Try again. (logout_failed)");
  const retrySignOut = accountMenu.getByRole("menuitem", { name: "Sign out" });
  await expect(retrySignOut).toBeEnabled();
  await expectWithinViewport(page, accountMenu);
  await expectWithinViewport(page, retrySignOut);

  await page.keyboard.press("Escape");
  await page.setViewportSize({ height: 390, width: 844 });
  await accountTrigger.click();
  await expectWithinViewport(page, accountMenu);
  await expectWithinViewport(page, retrySignOut);
  await retrySignOut.click({ trial: true });
  await Promise.all([page.waitForURL(/\/login(?:\?|$)/), retrySignOut.click()]);
  expect(signOutAttempts).toBe(2);
});

test("verifies provider controls, prompt preview, Gemini preview, and hidden unavailable providers", async ({ page }) => {
  let settingsPatchCount = 0;
  await installMatrixCatalogFixture(page, undefined, {
    onSettingsPatch: () => {
      settingsPatchCount += 1;
    }
  });
  await signIn(page);

  await page.getByRole("button", { name: "Select model" }).click();
  await expect(page.getByTestId("model-picker").getByRole("button", { name: "Provider Fake" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  let runSettings = await openRunSettings(page);
  await expect(runSettings.getByRole("button", { name: "Prompt preset" })).toContainText("Helpful Assistant");
  await expect(runSettings.getByRole("button", { name: "Prompt preset" })).not.toContainText("Transparent QSA");
  await closeRunSettings(page);
  await expect(page.getByTestId("details-pane")).toHaveCount(0);
  await page.getByRole("button", { name: "Open details" }).click();
  await page.getByRole("button", { name: "Pin details" }).click();
  await expect(page.getByTestId("details-pane")).toHaveAttribute("data-presentation", "pinned");
  await expect(page.getByTestId("details-pane").getByRole("tab", { name: "Branch" })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  await expect(page.getByRole("tab", { name: "Prompt" })).toHaveCount(0);

  await selectModel(page, "openai", "gpt-5.5");
  runSettings = await openRunSettings(page);
  await expect(runSettings.getByLabel("Background mode")).toBeVisible();
  await expect(runSettings.getByRole("button", { name: "Stream response" })).toHaveAttribute(
    "aria-pressed",
    "false"
  );
  await expect(runSettings.getByLabel("Max output tokens")).toHaveValue("128000");
  await expect(runSettings.getByLabel("Temperature")).toHaveValue("1");
  await expect(runSettings.getByLabel("Temperature")).toBeEnabled();
  await runSettings.getByLabel("Temperature").fill("");
  settingsPatchCount = 0;
  await runSettings.getByLabel("Temperature").pressSequentially("0.75");
  await expect.poll(() => settingsPatchCount, { timeout: 1200 }).toBe(1);
  expect(await reasoningOptionValues(page)).toEqual(["none", "minimal", "low", "medium", "high", "xhigh"]);
  expect(await reasoningOptionValues(page)).not.toContain("max");

  await selectModel(page, "anthropic", "claude-opus-4-8");
  runSettings = await openRunSettings(page);
  await expect(runSettings.getByLabel("Background mode")).toHaveCount(0);
  await expect(runSettings.getByRole("button", { name: "Stream response" })).toHaveCount(0);
  await expect(runSettings.getByLabel("Temperature")).toBeDisabled();
  expect(await reasoningOptionValues(page)).toEqual(["low", "medium", "high", "xhigh", "max"]);

  await selectModel(page, "openrouter", "anthropic/claude-opus-4.8");
  await expect(page.getByRole("button", { name: "Select model" })).toContainText("Claude Opus 4.8");
  await expect(page.getByRole("button", { name: "Select model" })).toHaveAttribute(
    "title",
    "OpenRouter / Claude Opus 4.8"
  );
  await expect(page.getByRole("button", { name: "Select model" })).not.toContainText("via OpenRouter");
  runSettings = await openRunSettings(page);
  await expect(runSettings.getByLabel("Background mode")).toHaveCount(0);
  await expect(runSettings.getByRole("button", { name: "Stream response" })).toHaveAttribute("aria-pressed", "true");
  await expect(runSettings.getByLabel("Temperature")).toBeDisabled();
  expect(await reasoningOptionValues(page)).toEqual(["low", "medium", "high", "xhigh", "max"]);

  await selectModel(page, "openrouter", "google/gemini-3.5-flash");
  runSettings = await openRunSettings(page);
  await expect(runSettings.getByLabel("Background mode")).toHaveCount(0);
  await expect(runSettings.getByLabel("Max output tokens")).toHaveValue("65536");
  await expect(runSettings.getByLabel("Temperature")).toHaveValue("1");
  await expect(runSettings.getByLabel("Temperature")).toBeEnabled();
  expect(await reasoningOptionValues(page)).toEqual(["none", "minimal", "low", "medium", "high"]);
  expect(await reasoningOptionValues(page)).not.toContain("xhigh");
  expect(await reasoningOptionValues(page)).not.toContain("max");
  await expect(composerRestingControls(page).getByRole("button", { name: "Reasoning effort" })).toContainText(
    "Medium"
  );

  await selectModel(page, "openrouter", "~google/gemini-pro-latest");
  await expect(page.getByRole("button", { name: "Select model" })).toContainText("Gemini Pro Latest");

  await page.getByRole("button", { name: "Select model" }).click();
  const modelPicker = page.getByTestId("model-picker");
  await expect(modelPicker.getByRole("heading", { name: "Anthropic" })).toBeVisible();
  await expect(modelPicker.getByRole("heading", { name: "OpenRouter" })).toBeVisible();
  await expect(modelPicker.getByRole("button", { name: /Provider / })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Select model" })).toContainText("Gemini Pro Latest");
});

test("keeps searchable pickers and command palette keyboard-safe in the narrow sheet layout", async ({ page }) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await installMatrixCatalogFixture(page);
  await signIn(page);

  const runSummary = composerRunSummary(page);
  await expect(runSummary).toBeVisible();
  await expect(runSummary).toContainText("Search:");
  await expect(page.getByRole("button", { name: "Select model" })).toBeHidden();
  const runSetup = await openRunSetup(page);
  await expectWithinViewport(page, runSetup);
  await page.keyboard.press("Control+K");
  await expect(page.getByRole("dialog", { name: "Command palette" })).toHaveCount(0);
  await expect(runSetup).toBeVisible();
  const modelTrigger = runSetup.getByRole("button", { name: "Select model" });
  await modelTrigger.click();
  const modelPicker = page.getByTestId("model-picker");
  const modelSearch = modelPicker.getByLabel("Search models");
  await expect(modelSearch).toBeFocused();
  await expectWithinViewport(page, modelPicker);
  await modelSearch.press("End");
  await modelSearch.press("Tab");
  await expect(modelPicker.locator("button:focus")).toContainText("Gemini Pro Latest");
  await expect(modelPicker.getByRole("heading", { name: "Choose a model" })).toBeInViewport();
  await expect(modelSearch).toBeInViewport();
  await modelSearch.focus();
  await modelSearch.fill("no-such-entitled-model");
  await expect(modelPicker.getByRole("status")).toContainText("No models match");
  await page.keyboard.press("Escape");
  await expect(modelTrigger).toBeFocused();
  await expect(runSetup).toBeVisible();

  const searchTrigger = runSetup.getByRole("button", { name: "Search strategy" });
  await searchTrigger.click();
  const searchPicker = page.getByTestId("search-select-options");
  await expectWithinViewport(page, searchPicker);
  await page.keyboard.press("End");
  await expect(searchPicker.locator('[data-option-value="perplexity-tool-search"]')).toBeFocused();
  await page.keyboard.press("Home");
  await expect(searchPicker.locator('[data-option-value="search-disabled"]')).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(searchTrigger).toBeFocused();
  await expect(runSetup).toBeVisible();

  const promptTrigger = runSetup.getByRole("button", { name: "Prompt preset" });
  await promptTrigger.click();
  let promptPicker = page.getByTestId("prompt-picker-options");
  let promptSearch = promptPicker.getByLabel("Search prompt presets");
  await expect(promptSearch).toBeFocused();
  await expectWithinViewport(page, promptPicker);
  await promptSearch.fill("no-such-prompt-wording");
  await expect(promptPicker.getByRole("status")).toContainText("No prompts match");
  await page.keyboard.press("Escape");
  await expect(promptTrigger).toBeFocused();
  await promptTrigger.click();
  promptPicker = page.getByTestId("prompt-picker-options");
  promptSearch = promptPicker.getByLabel("Search prompt presets");
  await expect(promptSearch).toHaveValue("");
  await promptSearch.press("End");
  await promptSearch.press("Tab");
  await expect(promptPicker.locator("button:focus")).toContainText("Helpful Assistant");
  await expect(runSetup.getByRole("heading", { name: "Run setup" })).toBeInViewport();
  await expect(promptSearch).toBeInViewport();
  await page.keyboard.press("Escape");
  await expect(promptTrigger).toBeFocused();
  await expect(runSetup).toBeVisible();
  await closeRunSetup(page);
  await expect(runSummary).toBeFocused();

  const accountTrigger = await runAccountMenuAction(page, "Command palette");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  const commandSearch = palette.getByLabel("Command search");
  await expect(commandSearch).toBeFocused();
  await expectWithinViewport(page, palette);
  await page.mouse.move(0, 0);
  await commandSearch.press("End");
  await expect(palette.getByRole("option", { selected: true })).toContainText("Perplexity tool");
  await commandSearch.press("Home");
  await expect(palette.getByRole("option", { selected: true })).toContainText("New chat");
  await commandSearch.fill("no-such-command-item");
  await expect(palette.getByRole("status")).toContainText("No matching commands");
  await commandSearch.press("Enter");
  await expect(palette).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(accountTrigger).toBeFocused();
  await expectNoHorizontalOverflow(page);
});

test("keeps Settings prompt and Appearance workflows safe in the narrow sheet layout", async ({ page }) => {
  await page.setViewportSize({ height: 844, width: 390 });
  const researchPrompt = {
    developerPrompt: null,
    id: "prompt-research",
    isDefault: false,
    name: "Research Prompt",
    systemPrompt: "Research carefully and explain the evidence."
  };
  const settingsCatalog = {
    ...matrixCatalog,
    promptPresets: [...matrixCatalog.promptPresets, researchPrompt]
  };
  const promptRequests: string[] = [];

  await installMatrixCatalogFixture(page, undefined, { catalog: settingsCatalog });
  await page.route(/\/api\/prompts(?:\/.*)?$/, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    promptRequests.push(`${request.method()} ${path}`);

    await route.fulfill({
      contentType: "application/json",
      json: { error: "unexpected_prompt_mutation" },
      status: 500
    });
  });

  await signIn(page);
  const accountTrigger = await runAccountMenuAction(page, "Settings");
  let settingsDialog = page.getByTestId("settings-dialog");
  const promptName = settingsDialog.getByLabel("Prompt name");
  const closeSettings = settingsDialog.getByRole("button", { name: "Close settings" });
  await expect(promptName).toBeFocused();
  await expectWithinViewport(page, settingsDialog);
  await expectNoHorizontalOverflow(page);

  await promptName.press("Shift+Tab");
  await expect
    .poll(() =>
      page.evaluate(() => Boolean(document.activeElement?.closest('[data-testid="settings-dialog"]')))
    )
    .toBe(true);
  await page.keyboard.press("Tab");
  await expect(promptName).toBeFocused();

  await settingsDialog.getByRole("button", { name: "Edit prompt Research Prompt" }).click();
  await expect(settingsDialog.getByLabel("Prompt name")).toHaveValue("Research Prompt");
  await settingsDialog.getByRole("button", { name: "Set selected prompt as default" }).click();
  await expect(page.getByTestId("shell-notice")).toContainText("Default prompt: Research Prompt");
  await expect(settingsDialog.getByRole("button", { name: "Delete selected prompt" })).toBeDisabled();
  expect(promptRequests).toEqual([]);
  await closeSettings.click();
  await expect(page.getByTestId("shell-notice")).toHaveCount(0);

  let runSetup = await openRunSetup(page);
  await expect(runSetup.getByRole("button", { name: "Prompt preset" })).toContainText("Helpful Assistant");
  await closeRunSetup(page);

  await runAccountMenuAction(page, "Settings");
  settingsDialog = page.getByTestId("settings-dialog");
  await settingsDialog.getByRole("button", { name: "Use prompt Research Prompt for next run" }).click();
  await expect(page.getByTestId("shell-notice")).toContainText("Prompt selected: Research Prompt");
  expect(promptRequests).toEqual([]);
  await settingsDialog.getByRole("button", { name: "Close settings" }).click();
  await expect(page.getByTestId("shell-notice")).toHaveCount(0);
  runSetup = await openRunSetup(page);
  await expect(runSetup.getByRole("button", { name: "Prompt preset" })).toContainText("Research Prompt");
  await closeRunSetup(page);

  await runAccountMenuAction(page, "Settings");
  settingsDialog = page.getByTestId("settings-dialog");
  await settingsDialog.getByRole("button", { name: "Edit prompt Research Prompt" }).click();
  await settingsDialog.getByLabel("Prompt name").fill("Research Prompt with unsaved edits");
  await expect(settingsDialog.getByText("Unsaved changes", { exact: true })).toBeVisible();
  await expectCenterUnobscured(settingsDialog.getByRole("heading", { name: "Settings" }));
  await expectCenterUnobscured(settingsDialog.getByRole("button", { name: "Close settings" }));

  await settingsDialog.getByRole("button", { name: "Appearance" }).click();
  let discardDialog = page.getByRole("dialog", { name: "Discard prompt changes" });
  await expect(discardDialog).toBeVisible();
  await expect(discardDialog.getByRole("button", { name: "Keep editing" })).toBeFocused();
  await discardDialog.getByRole("button", { name: "Keep editing" }).click();
  await expect(settingsDialog.getByRole("button", { name: "Appearance" })).toBeFocused();
  await expect(settingsDialog.getByLabel("Prompt name")).toHaveValue("Research Prompt with unsaved edits");

  await page.keyboard.press("Escape");
  discardDialog = page.getByRole("dialog", { name: "Discard prompt changes" });
  await expect(discardDialog).toBeVisible();
  await discardDialog.getByRole("button", { name: "Keep editing" }).click();
  await page.getByTestId("settings-backdrop").dispatchEvent("mousedown");
  discardDialog = page.getByRole("dialog", { name: "Discard prompt changes" });
  await expect(discardDialog).toBeVisible();
  await discardDialog.getByRole("button", { name: "Keep editing" }).click();
  await expect(settingsDialog).toBeVisible();

  await settingsDialog.getByRole("button", { name: "Appearance" }).click();
  discardDialog = page.getByRole("dialog", { name: "Discard prompt changes" });
  await discardDialog.getByRole("button", { name: "Confirm discard changes" }).click();
  const aiqsaTheme = settingsDialog.getByRole("radio", { name: /^Use AIQSA theme/ });
  const graphiteTheme = settingsDialog.getByRole("radio", { name: /^Use Graphite theme/ });
  const verdantTheme = settingsDialog.getByRole("radio", { name: /^Use Verdant theme/ });
  const neutralTheme = settingsDialog.getByRole("radio", { name: /^Use Classic Light theme/ });
  await expect(verdantTheme).toBeVisible();
  await expect(neutralTheme).toBeVisible();
  await expect(aiqsaTheme).toHaveAttribute("aria-checked", "true");
  await aiqsaTheme.focus();
  await aiqsaTheme.press("ArrowRight");
  await expect(graphiteTheme).toBeFocused();
  await expect(graphiteTheme).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "graphite");
  await expect
    .poll(() => page.evaluate(() => window.localStorage.getItem("aiqsa.theme")))
    .toBe("graphite");

  await page.reload();
  await expect(page.getByTestId("app-shell")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "graphite");
  await runAccountMenuAction(page, "Settings");
  settingsDialog = page.getByTestId("settings-dialog");
  await settingsDialog.getByRole("button", { name: "Appearance" }).click();
  await expect(settingsDialog.getByRole("radio", { name: /^Use Graphite theme/ })).toHaveAttribute(
    "aria-checked",
    "true"
  );
  await settingsDialog.getByRole("radio", { name: /^Use Graphite theme/ }).press("End");
  const reloadedNeutralTheme = settingsDialog.getByRole("radio", { name: /^Use Classic Light theme/ });
  await expect(reloadedNeutralTheme).toBeFocused();
  await expect(reloadedNeutralTheme).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "neutral");
  await expect(page.locator("html")).toHaveAttribute("data-color-scheme", "light");
  await expect
    .poll(() => page.evaluate(() => window.localStorage.getItem("aiqsa.theme")))
    .toBe("neutral");
  const neutralContrast = await themeContrastMetrics(page);
  expect(neutralContrast.text).toBeGreaterThanOrEqual(7);
  expect(neutralContrast.action).toBeGreaterThanOrEqual(4.5);
  expect(neutralContrast.focus).toBeGreaterThanOrEqual(3);

  await page.reload();
  await expect(page.getByTestId("app-shell")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "neutral");
  await expect(page.locator("html")).toHaveAttribute("data-color-scheme", "light");
  await runAccountMenuAction(page, "Settings");
  settingsDialog = page.getByTestId("settings-dialog");
  await settingsDialog.getByRole("button", { name: "Appearance" }).click();
  await settingsDialog.getByRole("radio", { name: /^Use Classic Light theme/ }).press("ArrowLeft");
  const classicDarkTheme = settingsDialog.getByRole("radio", { name: /^Use Classic Dark theme/ });
  await expect(classicDarkTheme).toBeFocused();
  await expect(classicDarkTheme).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "classic-dark");
  await expect(page.locator("html")).toHaveAttribute("data-color-scheme", "dark");
  await expect
    .poll(() => page.evaluate(() => window.localStorage.getItem("aiqsa.theme")))
    .toBe("classic-dark");
  const classicDarkContrast = await themeContrastMetrics(page);
  expect(classicDarkContrast.text).toBeGreaterThanOrEqual(7);
  expect(classicDarkContrast.action).toBeGreaterThanOrEqual(4.5);
  expect(classicDarkContrast.focus).toBeGreaterThanOrEqual(3);

  await page.reload();
  await expect(page.getByTestId("app-shell")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "classic-dark");
  await expect(page.locator("html")).toHaveAttribute("data-color-scheme", "dark");
  await runAccountMenuAction(page, "Settings");
  settingsDialog = page.getByTestId("settings-dialog");
  await settingsDialog.getByRole("button", { name: "Appearance" }).click();
  await settingsDialog.getByRole("radio", { name: /^Use Classic Dark theme/ }).press("Home");
  await expect(settingsDialog.getByRole("radio", { name: /^Use AIQSA theme/ })).toBeFocused();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "aiqsa");
  await expect(page.locator("html")).toHaveAttribute("data-color-scheme", "dark");

  await page.getByTestId("settings-backdrop").dispatchEvent("mousedown");
  await expect(settingsDialog).toHaveCount(0);
  await expect(accountTrigger).toBeFocused();
  await expectNoHorizontalOverflow(page);
});

test("keeps the resting composer and Run settings inventory inside the thread column", async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1440 });
  await installMatrixCatalogFixture(page);
  await signIn(page);

  const threadBeforeDrawer = await page.getByTestId("main-thread-pane").boundingBox();
  expect(threadBeforeDrawer).toBeTruthy();
  await expect(page.getByTestId("details-pane")).toHaveCount(0);
  await expectNoHorizontalOverflow(page);

  const detailsTrigger = page.getByRole("button", { name: "Open details" });
  await detailsTrigger.focus();
  await detailsTrigger.click();
  let details = page.getByTestId("details-pane");
  await expect(details).toHaveAttribute("role", "dialog");
  await expect(details).toHaveAttribute("aria-modal", "true");
  await expect(page.getByTestId("shell-primary-content")).toHaveAttribute("inert", "");
  const threadWithDrawer = await page.getByTestId("main-thread-pane").boundingBox();
  expect(threadWithDrawer?.width).toBe(threadBeforeDrawer?.width);
  await expectNoHorizontalOverflow(page);
  await page.keyboard.press("Escape");
  await expect(details).toHaveCount(0);
  await expect(detailsTrigger).toBeFocused();

  await detailsTrigger.click();
  await page.getByRole("button", { name: "Pin details" }).click();
  details = page.getByTestId("details-pane");
  await expect(details).toHaveAttribute("data-presentation", "pinned");
  await expect(details).not.toHaveAttribute("role", "dialog");
  await expect(page.getByTestId("details-pane-backdrop")).toHaveCount(0);
  await expect(page.getByTestId("shell-primary-content")).not.toHaveAttribute("inert");
  await expectComposerBeforeDetails(page);

  const restingControls = composerRestingControls(page);
  await expect(restingControls.getByRole("button", { name: "Select model" })).toBeVisible();
  await expect(restingControls.locator("#search-select-current-value")).toHaveText("Off");
  await expect(restingControls.getByRole("button", { name: "Run settings" })).toHaveAttribute(
    "aria-expanded",
    "false"
  );
  await expect(restingControls.getByRole("button", { name: "Prompt preset" })).toHaveCount(0);
  await expect(restingControls.getByRole("button", { name: "Reasoning effort" })).toBeVisible();
  await expect(restingControls.getByLabel("Temperature")).toHaveCount(0);

  const runSettings = await openRunSettings(page);
  await expect(runSettings.getByRole("button", { name: "Search strategy" })).toHaveCount(0);
  await expect(runSettings.getByRole("button", { name: "Prompt preset" })).toBeVisible();
  await expect(runSettings.getByRole("button", { name: "Manage prompts" })).toBeVisible();
  await expect(runSettings.getByRole("button", { name: "Reasoning effort" })).toHaveCount(0);
  await expect(runSettings.getByLabel("Temperature")).toBeVisible();
  await expect(runSettings.getByLabel("Max output tokens")).toBeVisible();
  await expect(runSettings.getByRole("button", { name: "Background mode" })).toBeVisible();
  await expect(runSettings.getByRole("button", { name: "Stream response" })).toBeVisible();
  await expect(runSettings.getByRole("button", { name: /^(Hide|Show) citations$/ })).toBeVisible();
  await expect(runSettings.getByRole("button", { name: /^(Hide|Show) reasoning blocks$/ })).toBeVisible();
  await expect(runSettings.getByRole("button", { name: /^(Enable|Mute) answer sound$/ })).toBeVisible();
  const settingsMenuBox = await runSettings.boundingBox();
  const detailedDetailsBox = await page.getByTestId("details-pane").boundingBox();
  expect(settingsMenuBox).toBeTruthy();
  expect(detailedDetailsBox).toBeTruthy();
  expect(settingsMenuBox!.x + settingsMenuBox!.width).toBeLessThanOrEqual(detailedDetailsBox!.x + 1);
  await closeRunSettings(page);
  await expect(restingControls.getByRole("button", { name: "Run settings" })).toHaveAttribute(
    "aria-expanded",
    "false"
  );

  await page.setViewportSize({ height: 720, width: 1280 });
  await expect(details).toHaveAttribute("data-presentation", "overlay");
  await expect(details).toHaveAttribute("role", "dialog");
  await expect(details.getByRole("button", { name: "Pin details" })).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
  await details.getByRole("button", { name: "Close details" }).click();
  await expect(page.getByTestId("details-pane")).toHaveCount(0);
  const composerBox = await page.getByTestId("composer-control-bar").boundingBox();
  expect(composerBox).toBeTruthy();
  expect(composerBox!.x + composerBox!.width).toBeLessThanOrEqual(1280);
  await expectNoHorizontalOverflow(page);

  const contextualSettings = await openRunSettings(page);
  await expect(contextualSettings.getByLabel("Temperature")).toBeVisible();
  await expect(contextualSettings.getByLabel("Max output tokens")).toBeVisible();
  await expect(contextualSettings.getByRole("button", { name: "Open API params in Details" })).toHaveCount(0);
  await closeRunSettings(page);
  await page.getByRole("button", { name: "Open details" }).click();
  details = page.getByTestId("details-pane");
  await expect(details).toHaveAttribute("data-presentation", "overlay");
  await expect(details).toHaveAttribute("role", "dialog");
  await expect(details.getByRole("tab")).toHaveCount(2);
  await expect(details.getByRole("tab", { name: "Branch" })).toBeVisible();
  await expect(details.getByRole("tab", { name: "Events" })).toBeVisible();
  await expect(details.getByRole("tab", { name: "API params" })).toHaveCount(0);
  await expect(details.getByLabel("Temperature")).toHaveCount(0);
  await expect(details.getByLabel("Max output tokens")).toHaveCount(0);
  await details.getByRole("button", { name: "Close details" }).click();
  await expect(page.getByTestId("details-pane")).toHaveCount(0);

  await page.getByRole("button", { name: "Open details" }).click();
  await page.keyboard.press("Control+K");
  await expect(page.getByTestId("details-pane")).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
  await page.keyboard.press("Escape");
});

test("restores per-model search and reasoning drafts across model switches and reloads", async ({ page }) => {
  const defaults = {
    ...matrixCatalog.defaults,
    controlValues: {
      ...matrixCatalog.defaults.controlValues
    }
  };

  await page.route("**/api/me/catalog", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: {
        catalog: {
          ...matrixCatalog,
          defaults
        }
      }
    });
  });
  await page.route("**/api/chats?*", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }

    await route.fulfill({
      contentType: "application/json",
      json: {
        chats: [],
        contentMatches: [],
        folders: []
      }
    });
  });
  await page.route("**/api/chats", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }

    await route.fulfill({
      contentType: "application/json",
      json: {
        chats: [],
        contentMatches: [],
        folders: []
      }
    });
  });
  await page.route("**/api/me/settings", async (route) => {
    if (route.request().method() !== "PATCH") {
      await route.continue();
      return;
    }

    const body = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
    if (typeof body.defaultProvider === "string") {
      defaults.provider = body.defaultProvider;
    }
    if (typeof body.defaultModelId === "string") {
      defaults.modelId = body.defaultModelId;
    }
    if (typeof body.defaultSearchStrategyId === "string") {
      defaults.searchStrategyId = body.defaultSearchStrategyId;
    }
    if (body.defaultControlValues && typeof body.defaultControlValues === "object") {
      defaults.controlValues = {
        ...defaults.controlValues,
        ...(body.defaultControlValues as Record<string, unknown>)
      };
    }

    await route.fulfill({
      contentType: "application/json",
      json: {
        settings: {
          defaultControlValues: defaults.controlValues,
          defaultModelId: defaults.modelId,
          defaultPromptPresetId: defaults.promptPresetId,
          defaultProvider: defaults.provider,
          defaultSearchStrategyId: defaults.searchStrategyId,
          showCitations: defaults.showCitations,
          showReasoningBlocks: defaults.showReasoningBlocks,
          showToolActivity: defaults.showToolActivity
        }
      }
    });
  });

  await signIn(page);

  await chooseSearchStrategy(page, "Perplexity tool");
  await chooseReasoningEffort(page, "high");
  await expect(composerRestingButton(page, "Search strategy")).toContainText("Perplexity");
  await expect(composerRestingButton(page, "Reasoning effort")).toContainText("High");

  await selectModel(page, "openrouter", "google/gemini-3.5-flash");
  await chooseSearchStrategy(page, "No Search");
  await chooseReasoningEffort(page, "minimal");
  await expect(composerRestingButton(page, "Search strategy")).toContainText("Off");
  await expect(composerRestingButton(page, "Reasoning effort")).toContainText("Minimal");

  await selectModel(page, "openai", "gpt-5.5");
  await expect(composerRestingButton(page, "Search strategy")).toContainText("Perplexity");
  await expect(composerRestingButton(page, "Reasoning effort")).toContainText("High");

  await page.reload();
  await expect(page.getByTestId("app-shell")).toBeVisible();
  await expect(page.getByRole("button", { name: "Select model" })).toContainText("GPT-5.5");
  await expect(page.getByRole("button", { name: "Select model" })).toHaveAttribute("title", "OpenAI / GPT-5.5");
  await expect(composerRestingButton(page, "Search strategy")).toContainText("Perplexity");
  await expect(composerRestingButton(page, "Reasoning effort")).toContainText("High");
});

test("saves selected search as a user per-model draft without requiring a global search default", async ({ page }) => {
  const defaults = {
    ...matrixCatalog.defaults,
    controlValues: {
      ...matrixCatalog.defaults.controlValues
    }
  };
  const storedChat = {
    activeLeafMessageId: null,
    createdAt: "2026-06-10T00:00:00.000Z",
    defaultModelId: "anthropic/claude-opus-4.8",
    defaultPromptPresetId: "prompt-helpful",
    defaultProvider: "openrouter",
    folderId: null,
    id: "chat-openrouter-claude",
    messageCount: 0,
    messages: [],
    pinned: false,
    title: "Claude Opus 4.8",
    updatedAt: "2026-06-10T00:00:00.000Z",
    usageStats: null
  };
  const settingsBodies: Record<string, unknown>[] = [];

  await page.addInitScript(() => {
    window.localStorage.setItem("aiqsa.activeChatId", "chat-openrouter-claude");
    window.localStorage.setItem("aiqsa.answerSound", "off");
  });
  await page.route("**/api/me/catalog", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: {
        catalog: {
          ...matrixCatalog,
          defaults
        }
      }
    });
  });
  const fulfillChats = async (route: Route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }

    await route.fulfill({
      contentType: "application/json",
      json: {
        chats: [storedChat],
        contentMatches: [],
        folders: []
      }
    });
  };
  await page.route("**/api/chats?*", fulfillChats);
  await page.route("**/api/chats", fulfillChats);
  await page.route("**/api/chats/chat-openrouter-claude", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    await route.fulfill({ contentType: "application/json", json: { chat: storedChat } });
  });
  await page.route("**/api/me/settings", async (route) => {
    if (route.request().method() !== "PATCH") {
      await route.continue();
      return;
    }

    const body = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
    settingsBodies.push(body);
    if (body.defaultSearchStrategyId === "perplexity-tool-search") {
      await route.fulfill({
        contentType: "application/json",
        json: {
          error: "default_search_unavailable"
        },
        status: 400
      });
      return;
    }

    if (body.defaultControlValues && typeof body.defaultControlValues === "object") {
      defaults.controlValues = {
        ...defaults.controlValues,
        ...(body.defaultControlValues as Record<string, unknown>)
      };
    }

    await route.fulfill({
      contentType: "application/json",
      json: {
        settings: {
          defaultControlValues: defaults.controlValues,
          defaultModelId: defaults.modelId,
          defaultPromptPresetId: defaults.promptPresetId,
          defaultProvider: defaults.provider,
          defaultSearchStrategyId: defaults.searchStrategyId,
          showCitations: defaults.showCitations,
          showReasoningBlocks: defaults.showReasoningBlocks,
          showToolActivity: defaults.showToolActivity
        }
      }
    });
  });

  await signIn(page);
  await expect(page.getByRole("button", { name: "Select model" })).toContainText("Claude Opus 4.8");
  await chooseSearchStrategy(page, "Perplexity tool");
  await expect.poll(() => settingsBodies.length).toBe(1);
  expect(settingsBodies[0]?.defaultSearchStrategyId).toBeUndefined();
  expect(
    (settingsBodies[0]?.defaultControlValues as Record<string, Record<string, unknown>> | undefined)?.[
      "openrouter:anthropic/claude-opus-4.8"
    ]
  ).toMatchObject({
    searchStrategyId: "perplexity-tool-search"
  });

  await page.reload();
  await expect(page.getByTestId("app-shell")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("#search-select-current-value")).toHaveText("Perplexity");
});

test("sends GPT-5.6 Pro/max controls and keeps selected search after an immediate reload", async ({
  page
}) => {
  await page.setViewportSize({ height: 720, width: 1176 });
  const defaults = {
    ...matrixCatalog.defaults,
    controlValues: {
      ...matrixCatalog.defaults.controlValues
    }
  };
  const chats: unknown[] = [];
  let sendBody: Record<string, unknown> | null = null;

  await page.route("**/api/me/catalog", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: {
        catalog: {
          ...matrixCatalog,
          defaults
        }
      }
    });
  });
  const fulfillChats = async (route: Route) => {
    const method = route.request().method();
    if (method === "POST") {
      const chat = {
        activeLeafMessageId: null,
        createdAt: "2026-06-10T00:00:00.000Z",
        defaultModelId: defaults.modelId,
        defaultPromptPresetId: defaults.promptPresetId,
        defaultProvider: defaults.provider,
        folderId: null,
        id: "chat-send-defaults",
        messageCount: 0,
        messages: [],
        pinned: false,
        title: "New Chat",
        updatedAt: "2026-06-10T00:00:00.000Z"
      };
      chats.splice(0, chats.length, chat);
      await route.fulfill({
        contentType: "application/json",
        json: { chat },
        status: 201
      });
      return;
    }

    if (method === "GET") {
      await route.fulfill({
        contentType: "application/json",
        json: {
          chats,
          contentMatches: [],
          folders: []
        }
      });
      return;
    }

    await route.continue();
  };
  await page.route("**/api/chats?*", fulfillChats);
  await page.route("**/api/chats", fulfillChats);
  await page.route("**/api/chats/*/messages", async (route) => {
    sendBody = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
    const strategy = typeof sendBody.searchStrategy === "string" ? sendBody.searchStrategy : "search-disabled";
    const provider = typeof sendBody.provider === "string" ? sendBody.provider : defaults.provider;
    const modelId = typeof sendBody.modelId === "string" ? sendBody.modelId : defaults.modelId;
    const controlDefaults =
      typeof sendBody.controlDefaults === "object" && sendBody.controlDefaults !== null
        ? (sendBody.controlDefaults as Record<string, unknown>)
        : {};
    const key = `${provider}:${modelId}`;

    defaults.provider = provider;
    defaults.modelId = modelId;
    defaults.searchStrategyId = strategy;
    defaults.controlValues = {
      ...defaults.controlValues,
      [key]: {
        ...controlDefaults,
        searchStrategyId: strategy
      }
    };

    await route.fulfill({
      body: [
        sseEvent("run_start", { runId: "run-send-defaults" }),
        sseEvent("message_start", {
          assistantMessageId: "assistant-send-defaults",
          userMessageId: "user-send-defaults"
        }),
        sseEvent("token", { delta: "Saved" }),
        sseEvent("done", {
          runId: "run-send-defaults",
          status: "complete"
        })
      ].join(""),
      contentType: "text/event-stream"
    });
  });
  await page.route("**/api/me/settings", async (route) => {
    if (route.request().method() !== "PATCH") {
      await route.continue();
      return;
    }

    await route.fulfill({
      contentType: "application/json",
      json: {
        error: "settings_update_unavailable"
      },
      status: 503
    });
  });

  await signIn(page);
  await expect(page.getByRole("button", { name: "Select model" })).toBeEnabled();
  await selectModel(page, "openai", "gpt-5.6-sol");
  await chooseReasoningEffort(page, "max");
  const runSettings = await openRunSettings(page);
  await runSettings.getByLabel("Reasoning mode").selectOption("pro");
  await closeRunSettings(page);
  const modelValue = page.locator("#composer-model-current-value");
  const reasoningValue = page.locator("#composer-reasoning-effort-current-value");
  const modelButton = page.getByRole("button", { name: "Select model" });
  const reasoningButton = composerRestingButton(page, "Reasoning effort");
  const searchButton = composerRestingButton(page, "Search strategy");
  const settingsButton = page.getByRole("button", { name: "Run settings" });
  await expect(modelValue).toHaveText("GPT-5.6 Sol");
  await expect(modelButton).toHaveAttribute("title", "OpenAI / GPT-5.6 Sol");
  await expect(modelButton).toHaveAccessibleDescription("OpenAI / GPT-5.6 Sol");
  await expect(reasoningButton).toContainText("Reasoning");
  await expect(reasoningValue).toHaveText("Pro · Max");
  await expect(reasoningButton).toHaveAttribute("title", "Pro mode, Maximum effort");
  await expect(reasoningButton).toHaveAccessibleDescription("Pro mode, Maximum effort");
  for (const value of [modelValue, reasoningValue]) {
    await expect.poll(() => value.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  }
  const controlTops = await Promise.all(
    [modelButton, reasoningButton, searchButton, settingsButton].map((control) =>
      control.evaluate((element) => Math.round(element.getBoundingClientRect().top))
    )
  );
  expect(Math.max(...controlTops) - Math.min(...controlTops)).toBeLessThanOrEqual(1);
  await page.setViewportSize({ height: 390, width: 844 });
  const shortRunSetup = await openRunSetup(page);
  await expectWithinViewport(page, shortRunSetup);
  await expectWithinViewport(page, shortRunSetup.getByRole("button", { name: "Close run setup" }));
  await closeRunSetup(page);
  await page.setViewportSize({ height: 720, width: 1176 });
  await chooseSearchStrategy(page, "Perplexity tool");
  await expect(page.locator("#search-select-current-value")).toHaveText("Perplexity");
  await expect(searchButton).toHaveAccessibleDescription("Perplexity tool");
  await page.getByRole("textbox", { name: "Message" }).fill("Search should survive reload");
  await page.getByRole("textbox", { name: "Message" }).press("Enter");

  await expect.poll(() => sendBody?.searchStrategy).toBe("perplexity-tool-search");
  const sentBody = sendBody as Record<string, unknown> | null;
  if (!sentBody) {
    throw new Error("send body was not captured");
  }
  expect(sentBody).toMatchObject({
    modelId: "gpt-5.6-sol",
    params: {
      reasoning: {
        effort: "max",
        mode: "pro"
      }
    },
    provider: "openai"
  });
  expect(sentBody.controlDefaults).toMatchObject({
    reasoningEffort: "max",
    reasoningMode: "pro",
    searchStrategyId: "perplexity-tool-search"
  });

  await page.reload();
  await expect(page.getByTestId("app-shell")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("#search-select-current-value")).toHaveText("Perplexity");
});

test("loads catalog before activating a stored chat and avoids hydration warnings", async ({ page }) => {
  const consoleErrors: string[] = [];
  let releaseCatalog!: () => void;
  let workspaceReads = 0;
  const catalogCanFinish = new Promise<void>((release) => {
    releaseCatalog = release;
  });
  const storedChat = {
    activeLeafMessageId: "assistant-bootstrap",
    createdAt: "2026-06-10T13:00:00.000Z",
    defaultModelId: "claude-opus-4-8",
    defaultPromptPresetId: "prompt-helpful",
    defaultProvider: "anthropic",
    folderId: null,
    id: "chat-bootstrap",
    messageCount: 2,
    messages: [
      scrollMessage("user-bootstrap", "user", "Bootstrap question", null),
      scrollMessage("assistant-bootstrap", "assistant", "Bootstrap answer", "user-bootstrap")
    ],
    pinned: false,
    title: "Bootstrap chat",
    updatedAt: "2026-06-10T13:00:02.000Z",
    usageStats: null
  };

  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });
  await page.addInitScript(() => {
    window.localStorage.setItem("aiqsa.activeChatId", "chat-bootstrap");
    window.localStorage.setItem("aiqsa.answerSound", "off");
    window.localStorage.setItem("aiqsa.collapsedFolderIds", JSON.stringify(["folder-hydration"]));
  });
  await page.route("**/api/me/catalog", async (route) => {
    await catalogCanFinish;
    await route.fulfill({
      contentType: "application/json",
      json: {
        catalog: matrixCatalog
      }
    });
  });
  const fulfillSearchChats = async (route: Route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }

    workspaceReads += 1;
    await route.fulfill({
      contentType: "application/json",
      json: {
        chats: [storedChat],
        contentMatches: [],
        folders: []
      }
    });
  };
  await page.route("**/api/chats?*", fulfillSearchChats);
  await page.route("**/api/chats", fulfillSearchChats);
  await page.route("**/api/chats/chat-bootstrap", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    await route.fulfill({ contentType: "application/json", json: { chat: storedChat } });
  });
  await page.route("**/api/me/settings", async (route) => {
    if (route.request().method() !== "PATCH") {
      await route.continue();
      return;
    }

    await route.fulfill({
      contentType: "application/json",
      json: {
        settings: {
          defaultControlValues: matrixCatalog.defaults.controlValues,
          defaultModelId: matrixCatalog.defaults.modelId,
          defaultPromptPresetId: matrixCatalog.defaults.promptPresetId,
          defaultProvider: matrixCatalog.defaults.provider,
          defaultSearchStrategyId: matrixCatalog.defaults.searchStrategyId,
          showCitations: matrixCatalog.defaults.showCitations,
          showReasoningBlocks: matrixCatalog.defaults.showReasoningBlocks,
          showToolActivity: matrixCatalog.defaults.showToolActivity
        }
      }
    });
  });

  const signInStarted = signIn(page);
  await expect(page.getByTestId("app-shell")).toBeVisible();
  await page.waitForTimeout(100);
  expect(workspaceReads).toBe(0);

  releaseCatalog();
  await signInStarted;
  await expect(page.getByTestId("thread")).toContainText("Bootstrap answer");
  await expect(page.getByRole("button", { name: "Select model" })).toContainText("Claude Opus 4.8");
  await expect(page.getByRole("button", { name: "Select model" })).toHaveAttribute(
    "title",
    "Anthropic / Claude Opus 4.8"
  );
  expect(consoleErrors.filter((text) => /hydration|did not match/i.test(text))).toEqual([]);
});

test("shows a readable recovery state for malformed workspace payloads", async ({ page }) => {
  await installMatrixCatalogFixture(page, {
    chats: "not an array",
    folders: []
  });
  await signIn(page);

  const recovery = page.getByTestId("workspace-error-state");
  await expect(recovery).toContainText("Workspace response was malformed");
  await expect(recovery.getByRole("button", { name: "Retry loading workspace" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message" })).toBeDisabled();
  await expect(page.getByTestId("shell-notice")).toHaveCount(0);
});

test("finds never-opened chats through server-side content search", async ({ page }) => {
  const hiddenContentChat = {
    activeLeafMessageId: null,
    createdAt: "2026-06-10T13:00:00.000Z",
    defaultModelId: "gpt-5.5",
    defaultPromptPresetId: "prompt-helpful",
    defaultProvider: "openai",
    folderId: null,
    id: "chat-hidden-content",
    messageCount: 4,
    messages: [],
    pinned: false,
    title: "Quiet import",
    updatedAt: "2026-06-10T13:00:02.000Z"
  };
  const publicTitleChat = {
    ...hiddenContentChat,
    id: "chat-public-title",
    title: "Public title",
    updatedAt: "2026-06-10T13:00:01.000Z"
  };
  const searchQueries: string[] = [];

  await page.route("**/api/me/catalog", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: {
        catalog: matrixCatalog
      }
    });
  });
  const fulfillContentSearchChats = async (route: Route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }

    const url = new URL(route.request().url());
    const query = url.searchParams.get("q")?.trim() ?? "";
    if (query) {
      searchQueries.push(query);
    }

    await route.fulfill({
      contentType: "application/json",
      json: {
        chats: [hiddenContentChat, publicTitleChat],
        contentMatches: query === "buried phrase" ? [{ chatId: hiddenContentChat.id, snippet: "buried phrase" }] : [],
        folders: []
      }
    });
  };
  await page.route("**/api/chats?*", fulfillContentSearchChats);
  await page.route("**/api/chats", fulfillContentSearchChats);
  await page.route("**/api/me/settings", async (route) => {
    if (route.request().method() !== "PATCH") {
      await route.continue();
      return;
    }

    await route.fulfill({
      contentType: "application/json",
      json: {
        settings: {
          defaultControlValues: matrixCatalog.defaults.controlValues,
          defaultModelId: matrixCatalog.defaults.modelId,
          defaultPromptPresetId: matrixCatalog.defaults.promptPresetId,
          defaultProvider: matrixCatalog.defaults.provider,
          defaultSearchStrategyId: matrixCatalog.defaults.searchStrategyId,
          showCitations: matrixCatalog.defaults.showCitations,
          showReasoningBlocks: matrixCatalog.defaults.showReasoningBlocks,
          showToolActivity: matrixCatalog.defaults.showToolActivity
        }
      }
    });
  });

  await signIn(page);
  await expect(page.getByTestId("left-chat-pane")).toContainText("Quiet import");
  const chatSearchInput = page.getByLabel("Search chats");
  await chatSearchInput.fill("buried phrase");
  await expect(chatSearchInput).toHaveValue("buried phrase");

  await expect.poll(() => searchQueries, { timeout: 10_000 }).toContain("buried phrase");
  await expect(page.getByTestId("left-chat-pane")).toContainText("Quiet import");
  await expect(page.getByTestId("left-chat-pane")).toContainText("Message match");
  await expect(page.getByTestId("left-chat-pane")).not.toContainText("Public title");
});

test("opens a contained full-height branch details sheet from the thread header on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileChat = {
    activeLeafMessageId: "assistant-mobile",
    createdAt: "2026-06-10T12:00:00.000Z",
    defaultModelId: "gpt-5.5",
    defaultPromptPresetId: "prompt-helpful",
    defaultProvider: "openai",
    folderId: null,
    id: "chat-mobile-details",
    messageCount: 2,
    messages: [
      scrollMessage("user-mobile", "user", "Mobile branch question", null),
      scrollMessage("assistant-mobile", "assistant", "Mobile branch answer", "user-mobile")
    ],
    pinned: false,
    title: "Mobile details chat",
    updatedAt: "2026-06-10T12:00:02.000Z",
    usageStats: null
  };

  await page.addInitScript(() => window.localStorage.setItem("aiqsa.activeChatId", "chat-mobile-details"));
  await installMatrixCatalogFixture(page, {
    chats: [mobileChat],
    folders: []
  });
  await page.route("**/api/chats/chat-mobile-details", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }

    await route.fulfill({
      contentType: "application/json",
      json: {
        chat: mobileChat
      }
    });
  });

  await signIn(page);
  await expect(page.getByTestId("thread")).toContainText("Mobile branch answer");

  const detailsTrigger = page.getByRole("button", { name: "Open details" });
  await detailsTrigger.focus();
  await detailsTrigger.click();
  let mobileDetails = page.getByTestId("details-pane");
  await expect(mobileDetails).toBeVisible();
  await expect(mobileDetails).toHaveAttribute("role", "dialog");
  await expect(mobileDetails.getByRole("tab", { name: "Branch" })).toHaveAttribute("aria-selected", "true");
  const viewport = page.viewportSize();
  const detailsBox = await mobileDetails.boundingBox();
  expect(viewport).toEqual({ width: 390, height: 844 });
  expect(detailsBox).toBeTruthy();
  expect(Math.abs(detailsBox!.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(detailsBox!.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(detailsBox!.width - viewport!.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(detailsBox!.height - viewport!.height)).toBeLessThanOrEqual(1);
  await expectNoHorizontalOverflow(page);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("details-pane")).toHaveCount(0);
  await expect(detailsTrigger).toBeFocused();

  const branchTrigger = page.getByRole("button", { name: "Branch tree" });
  await branchTrigger.click();
  mobileDetails = page.getByTestId("details-pane");
  await expect(mobileDetails).toBeVisible();
  await expect(mobileDetails).toHaveAttribute("role", "dialog");
  await expect(mobileDetails.getByRole("tab", { name: "Branch" })).toHaveAttribute("aria-selected", "true");

  await page.getByTestId("details-pane-backdrop").dispatchEvent("mousedown");
  await expect(page.getByTestId("details-pane")).toHaveCount(0);
  await expect(branchTrigger).toBeFocused();
  await expectNoHorizontalOverflow(page);
});

test("reveals desktop chat row actions on hover and keyboard focus without layout shift", async ({ page }) => {
  const chat = {
    activeLeafMessageId: null,
    createdAt: "2026-06-10T13:30:00.000Z",
    defaultModelId: "gpt-5.5",
    defaultPromptPresetId: "prompt-helpful",
    defaultProvider: "openai",
    folderId: null,
    id: "chat-quiet-actions",
    messageCount: 0,
    messages: [],
    pinned: false,
    title: "Quiet row actions",
    updatedAt: "2026-06-10T13:30:02.000Z"
  };
  await installMatrixCatalogFixture(page, {
    chats: [chat],
    folders: []
  });

  await signIn(page);

  const chatButton = page.getByRole("button", { exact: true, name: "Quiet row actions" });
  const actions = page.getByTestId("chat-row-actions").first();
  await expect.poll(() => actions.evaluate((element) => getComputedStyle(element).opacity)).toBe("0");
  const before = await chatButton.boundingBox();

  await chatButton.hover();
  await expect.poll(() => actions.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
  const afterHover = await chatButton.boundingBox();
  expect(Math.abs((afterHover?.width ?? 0) - (before?.width ?? 0))).toBeLessThan(1);

  await page.mouse.move(0, 0);
  await expect.poll(() => actions.evaluate((element) => getComputedStyle(element).opacity)).toBe("0");

  await chatButton.focus();
  await expect.poll(() => actions.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
});

test("supports message copy plus user and assistant edit branches", async ({ page }) => {
  const chatId = "chat-message-actions";
  let activeLeafMessageId = "assistant-action-1";
  let editCount = 0;
  let messages = [
    scrollMessage("user-action-1", "user", "Original user prompt", null),
    scrollMessage("assistant-action-1", "assistant", "Original assistant answer", "user-action-1")
  ];
  const chat = () => ({
    activeLeafMessageId,
    createdAt: "2026-06-10T13:00:00.000Z",
    defaultModelId: "gpt-5.5",
    defaultPromptPresetId: "prompt-helpful",
    defaultProvider: "openai",
    folderId: null,
    id: chatId,
    messageCount: messages.length,
    messages,
    pinned: false,
    title: "Message action chat",
    updatedAt: "2026-06-10T13:00:02.000Z",
    usageStats: null
  });

  await page.addInitScript(() => {
    window.localStorage.setItem("aiqsa.activeChatId", "chat-message-actions");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          window.localStorage.setItem("aiqsa.testClipboard", text);
        }
      }
    });
  });
  await installMatrixCatalogFixture(page, {
    chats: [chat()],
    folders: []
  });
  await page.route(`**/api/chats/${chatId}`, async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }

    await route.fulfill({
      contentType: "application/json",
      json: {
        chat: chat()
      }
    });
  });
  await page.route("**/api/messages/*", async (route) => {
    if (route.request().method() !== "PATCH") {
      await route.continue();
      return;
    }

    const originalMessageId = new URL(route.request().url()).pathname.split("/").at(-1);
    const original = messages.find((message) => message.id === originalMessageId);
    if (!original) {
      await route.fulfill({
        contentType: "application/json",
        json: {
          error: "message_not_found_or_not_editable"
        },
        status: 404
      });
      return;
    }

    const requestBody = route.request().postDataJSON() as { text?: string };
    editCount += 1;
    const edited = {
      ...original,
      chatId,
      content: {
        blocks: [{ text: requestBody.text ?? "", type: "text" }]
      },
      id: `${original.role}-edited-${editCount}`,
      parentMessageId: original.parentMessageId,
      status: "complete"
    };
    messages = [...messages, edited];
    activeLeafMessageId = edited.id;

    await route.fulfill({
      contentType: "application/json",
      json: {
        message: edited
      }
    });
  });

  await signIn(page);
  await expect(page.getByTestId("thread")).toContainText("Original assistant answer");
  await expect(page.getByTestId("thread-complete-answer-spacer")).toBeVisible();

  await page.getByRole("button", { name: "Copy message" }).last().click();
  await expect(page.getByTestId("shell-notice")).toContainText("Message copied");
  await expect
    .poll(() => page.evaluate(() => window.localStorage.getItem("aiqsa.testClipboard") ?? ""))
    .toBe("Original assistant answer");

  await page.getByRole("button", { name: "Edit message" }).last().click();
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue("Original assistant answer");
  await page.getByRole("textbox", { name: "Message" }).fill("Edited assistant answer");
  await page.getByRole("textbox", { name: "Message" }).press("Enter");
  await expect(page.getByTestId("thread")).toContainText("Edited assistant answer");
  await expect(page.getByTestId("thread")).not.toContainText("Original assistant answer");

  await page.getByRole("button", { name: "Edit message" }).first().click();
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue("Original user prompt");
  await page.getByRole("textbox", { name: "Message" }).fill("Edited user prompt");
  await page.getByRole("textbox", { name: "Message" }).press("Enter");
  await expect(page.getByTestId("thread")).toContainText("Edited user prompt");
  await expect(page.getByTestId("thread")).not.toContainText("Original user prompt");
});

test("opens a second blank New Chat while another active run is still running", async ({ page }) => {
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    let chatCreateCount = 0;
    let sendCount = 0;

    function event(type: string, data: unknown) {
      return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    }

    function apiChat(id: string, title: string, activeLeafMessageId: string | null, messages: unknown[]) {
      return {
        activeLeafMessageId,
        createdAt: "2026-06-10T14:00:00.000Z",
        defaultModelId: "gpt-5.5",
        defaultPromptPresetId: "prompt-helpful",
        defaultProvider: "openai",
        folderId: null,
        id,
        messageCount: messages.length,
        messages,
        pinned: false,
        title,
        updatedAt: "2026-06-10T14:00:02.000Z",
        usageStats: null
      };
    }

    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const url = new URL(rawUrl, window.location.origin);
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");

      if (method === "POST" && url.pathname === "/api/chats") {
        chatCreateCount += 1;
        window.localStorage.setItem("aiqsa.concurrentChatCreateCount", String(chatCreateCount));
        const chatId = `chat-concurrent-${chatCreateCount}`;

        return new Response(
          JSON.stringify({
            chat: apiChat(chatId, `Concurrent Chat ${chatCreateCount}`, null, [])
          }),
          {
            headers: {
              "content-type": "application/json"
            },
            status: 201
          }
        );
      }

      const messageMatch = url.pathname.match(/^\/api\/chats\/([^/]+)\/messages$/);
      if (method === "POST" && messageMatch) {
        sendCount += 1;
        const chatId = messageMatch[1] ?? `chat-concurrent-${sendCount}`;
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
        const prompt =
          body?.content?.blocks?.find((block: { text?: unknown; type?: unknown }) => block?.type === "text")?.text ??
          `Concurrent prompt ${sendCount}`;
        const answer = `Concurrent answer ${sendCount}: ${prompt}`;
        const userMessageId = `user-concurrent-${sendCount}`;
        const assistantMessageId = `assistant-concurrent-${sendCount}`;
        const runId = `run-concurrent-${sendCount}`;
        const messages = [
          {
            artifactSummary: null,
            content: {
              blocks: [{ text: prompt, type: "text" }]
            },
            createdAt: "2026-06-10T14:00:02.000Z",
            errorMessage: null,
            id: userMessageId,
            modelId: "gpt-5.5",
            modelRunId: null,
            parentMessageId: null,
            provider: "openai",
            role: "user",
            status: "complete"
          },
          {
            artifactSummary: null,
            content: {
              blocks: [{ text: answer, type: "text" }]
            },
            createdAt: "2026-06-10T14:00:02.000Z",
            errorMessage: null,
            id: assistantMessageId,
            modelId: "gpt-5.5",
            modelRunId: runId,
            parentMessageId: userMessageId,
            provider: "openai",
            role: "assistant",
            status: "complete"
          }
        ];
        const chunks = [
          event("run_start", { runId }),
          event("message_start", { assistantMessageId, userMessageId }),
          event("token", { delta: answer }),
          event("chat_update", {
            chat: apiChat(chatId, `Concurrent Chat ${sendCount}`, assistantMessageId, messages),
            messages
          }),
          event("done", { runId, status: "complete" })
        ];
        const encoder = new TextEncoder();
        const baseDelay = sendCount === 1 ? 220 : 60;

        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              chunks.forEach((chunk, index) => {
                window.setTimeout(() => {
                  controller.enqueue(encoder.encode(chunk));
                  if (index === chunks.length - 1) {
                    controller.close();
                  }
                }, baseDelay * (index + 1));
              });
            }
          }),
          {
            headers: {
              "content-type": "text/event-stream"
            },
            status: 200
          }
        );
      }

      if (method === "GET" && url.pathname.startsWith("/api/model-runs/run-concurrent-")) {
        const runId = url.pathname.split("/").at(-1) ?? "run-concurrent";

        return new Response(
          JSON.stringify({
            run: {
              errorPayload: null,
              estimatedCostMicros: 0,
              events: [{ eventType: "done", payload: { status: "complete" }, sequence: 0 }],
              id: runId,
              cachedInputTokens: 0,
              cacheWriteInputTokens: 0,
              inputTokens: 4,
              modelId: "gpt-5.5",
              outputTokens: 7,
              provider: "openai",
              reasoningTokens: 0,
              searchRuns: [],
              status: "complete",
              toolCalls: [],
              totalTokens: 11
            }
          }),
          {
            headers: {
              "content-type": "application/json"
            },
            status: 200
          }
        );
      }

      return originalFetch(input, init);
    };
  });
  await installMatrixCatalogFixture(page, {
    chats: [],
    contentMatches: [],
    folders: []
  });

  await signIn(page);
  await page.getByRole("textbox", { name: "Message" }).fill("First concurrent prompt");
  await page.getByRole("textbox", { name: "Message" }).press("Enter");
  await expect(page.getByTestId("streaming-cursor")).toBeVisible();
  await expect(page.getByRole("button", { exact: true, name: "Concurrent Chat 1" })).toHaveAccessibleDescription(
    "Response running"
  );

  await page.getByRole("button", { name: "Start new chat" }).click();
  await expect(page.getByTestId("current-chat-title")).toHaveText("New chat");
  await expect(page.getByRole("button", { exact: true, name: "Concurrent Chat 1" })).toHaveAccessibleDescription(
    "Response running"
  );
  await expect(page.getByRole("textbox", { name: "Message" })).toBeEnabled();
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue("");

  await page.getByRole("textbox", { name: "Message" }).fill("Second concurrent prompt");
  await page.getByRole("textbox", { name: "Message" }).press("Enter");
  await expect
    .poll(() => page.evaluate(() => window.localStorage.getItem("aiqsa.concurrentChatCreateCount") ?? "0"))
    .toBe("2");
  await expect(page.getByTestId("thread")).toContainText("Concurrent answer 2: Second concurrent prompt");
  await expect(page.getByTestId("thread")).not.toContainText("Concurrent answer 1: First concurrent prompt");
  await expect(page.getByTestId("left-chat-pane")).toContainText("Concurrent Chat 1");
  await expect(page.getByTestId("left-chat-pane")).toContainText("Concurrent Chat 2");
});

test("exposes the workspace and new-chat command on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const suffix = Date.now();
  const folderName = `E2E Folder Mobile ${suffix}`;
  const rowTitle = `Folder path e2e question mobile ${suffix}`;
  const renamedTitle = `Mobile Renamed ${suffix}`;

  await signIn(page);
  await cleanupE2eWorkspace(page);
  const chatResponse = await page.request.post("/api/chats", {
    data: {
      title: rowTitle
    }
  });
  expect(chatResponse.status()).toBe(201);
  await page.reload();
  await expect(page.getByTestId("app-shell")).toBeVisible();
  await expect(page.getByTestId("left-chat-pane")).toBeHidden();
  const workspaceButton = page.getByTestId("mobile-workspace-button");
  await expect(workspaceButton).toBeVisible();
  const workspaceButtonBox = await workspaceButton.boundingBox();
  expect(workspaceButtonBox?.x ?? 999).toBeLessThan(24);

  await runAccountMenuAction(page, "Command palette");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.getByLabel("Command search").fill("new chat");
  await palette.getByRole("option", { name: /New chat/ }).click();
  await expect(palette).toHaveCount(0);
  await expect(page.getByTestId("current-chat-title")).toHaveText("New chat");

  await page.getByRole("button", { name: "Open workspace" }).click();
  const workspace = page.getByTestId("workspace-pane-mobile");
  await expect(workspace).toBeVisible();
  await expect(workspace).toHaveAttribute("role", "dialog");
  await expect(page.getByTestId("left-chat-pane-mobile")).toBeVisible();

  await workspace.getByRole("button", { name: "New folder" }).click();
  await workspace.getByLabel("Folder name").fill(folderName);
  await workspace.getByRole("button", { name: "Create folder" }).click();
  await expect(workspace).toContainText(folderName);
  const folderSection = workspace.locator("section").filter({ hasText: folderName });
  await expect.poll(() => workspace.getByTestId("chat-row-actions").first().evaluate((element) => getComputedStyle(element).opacity)).toBe("1");

  await workspace.getByRole("button", { name: `Chat actions ${rowTitle}` }).first().click();
  await workspace.getByLabel(`Move chat ${rowTitle} to folder`).first().selectOption({ label: folderName });
  await expect(page.getByTestId("shell-notice")).toContainText("Moved:");

  await folderSection.getByRole("button", { name: `Chat actions ${rowTitle}` }).first().click();
  await folderSection.getByRole("button", { name: "Rename" }).click();
  await folderSection.getByRole("textbox", { name: `Edit title ${rowTitle}` }).fill(renamedTitle);
  await folderSection.getByRole("button", { name: `Save title ${rowTitle}` }).click();
  await expect(workspace).toContainText(renamedTitle);

  await folderSection.getByRole("button", { name: `Folder actions ${folderName}` }).click();
  await folderSection.getByRole("button", { exact: true, name: "New chat" }).click();
  await expect(page.getByTestId("workspace-pane-mobile")).toHaveCount(0);
  await expect(page.getByTestId("current-chat-title")).toHaveText("New chat");

  await page.getByRole("button", { name: "Open workspace" }).click();
  const reopenedWorkspace = page.getByTestId("workspace-pane-mobile");
  await expect(reopenedWorkspace).toContainText(renamedTitle);
  await reopenedWorkspace.getByRole("button", { exact: true, name: renamedTitle }).click();
  await expect(page.getByTestId("workspace-pane-mobile")).toHaveCount(0);
  await expect(page.getByTestId("current-chat-title")).toHaveText(renamedTitle);

  await cleanupE2eWorkspace(page);
});

test("keeps delayed chat_update scoped to its source chat after switching chats", async ({ page }) => {
  const oldMessage = (id: string, role: "assistant" | "user", content: string, parentMessageId: string | null) => ({
    artifactSummary: null,
    content: {
      blocks: [{ text: content, type: "text" }]
    },
    createdAt: "2026-06-08T10:00:00.000Z",
    errorMessage: null,
    id,
    modelId: "gpt-5.5",
    modelRunId: role === "assistant" ? `run-${id}` : null,
    parentMessageId,
    provider: "openai",
    role,
    status: "complete"
  });
  const workspace = {
    chats: [
      {
        activeLeafMessageId: "assistant-a-old",
        createdAt: "2026-06-08T10:00:00.000Z",
        defaultModelId: "gpt-5.5",
        defaultPromptPresetId: "prompt-helpful",
        defaultProvider: "openai",
        folderId: null,
        id: "chat-a",
        messageCount: 2,
        messages: [
          oldMessage("user-a-old", "user", "Old A question", null),
          oldMessage("assistant-a-old", "assistant", "Old A answer", "user-a-old")
        ],
        title: "Chat A slow",
        updatedAt: "2026-06-08T10:00:02.000Z"
      },
      {
        activeLeafMessageId: "assistant-b-old",
        createdAt: "2026-06-08T10:01:00.000Z",
        defaultModelId: "gpt-5.5",
        defaultPromptPresetId: "prompt-helpful",
        defaultProvider: "openai",
        folderId: null,
        id: "chat-b",
        messageCount: 2,
        messages: [
          oldMessage("user-b-old", "user", "Old B question", null),
          oldMessage("assistant-b-old", "assistant", "Old B answer", "user-b-old")
        ],
        title: "Chat B steady",
        updatedAt: "2026-06-08T10:01:02.000Z"
      }
    ],
    folders: []
  };
  let releaseSend!: () => void;
  let releaseUpload!: () => void;
  let runFetches = 0;
  let markSendStarted!: () => void;
  let markUploadStarted!: () => void;
  const sendStarted = new Promise<void>((resolve) => {
    markSendStarted = resolve;
  });
  const sendCanFinish = new Promise<void>((release) => {
    releaseSend = release;
  });
  const uploadStarted = new Promise<void>((resolve) => {
    markUploadStarted = resolve;
  });
  const uploadCanFinish = new Promise<void>((release) => {
    releaseUpload = release;
  });

  await page.route("**/api/chats/chat-a/messages", async (route) => {
    markSendStarted();
    await sendCanFinish;
    await route.fulfill({
      body: [
        sseEvent("run_start", { runId: "run-a-delayed" }),
        sseEvent("message_start", {
          assistantMessageId: "assistant-a-new",
          userMessageId: "user-a-new"
        }),
        sseEvent("chat_update", {
          chat: {
            activeLeafMessageId: "assistant-a-new",
            createdAt: "2026-06-08T10:00:00.000Z",
            defaultModelId: "gpt-5.5",
            defaultPromptPresetId: "prompt-helpful",
            defaultProvider: "openai",
            folderId: null,
            id: "chat-a",
            messageCount: 4,
            pinned: false,
            title: "Chat A answered",
            updatedAt: "2026-06-08T10:02:00.000Z",
            usageStats: null
          },
          messages: [
            {
              artifactSummary: null,
              content: {
                blocks: [{ text: "Slow question A", type: "text" }]
              },
              createdAt: "2026-06-08T10:02:00.000Z",
              errorMessage: null,
              id: "user-a-new",
              modelId: "gpt-5.5",
              modelRunId: null,
              parentMessageId: "assistant-a-old",
              provider: "openai",
              role: "user",
              status: "complete"
            },
            {
              artifactSummary: null,
              content: {
                blocks: [{ text: "Answer A after switch", type: "text" }]
              },
              createdAt: "2026-06-08T10:02:00.000Z",
              errorMessage: null,
              id: "assistant-a-new",
              modelId: "gpt-5.5",
              modelRunId: "run-a-delayed",
              parentMessageId: "user-a-new",
              provider: "openai",
              role: "assistant",
              status: "complete"
            }
          ]
        }),
        sseEvent("done", { runId: "run-a-delayed", status: "complete" })
      ].join(""),
      contentType: "text/event-stream",
      status: 200
    });
  });

  await page.addInitScript(() => window.localStorage.setItem("aiqsa.activeChatId", "chat-a"));
  await installMatrixCatalogFixture(page, workspace);
  await page.route("**/api/model-runs/run-a-delayed", async (route) => {
    runFetches += 1;
    await route.fulfill({
      contentType: "application/json",
      json: {
        run: {
          errorPayload: null,
          events: [{ eventType: "run_start", payload: { runId: "run-a-delayed" }, sequence: 0 }],
          id: "run-a-delayed",
          inputTokens: 4,
          modelId: "gpt-5.5",
          provider: "openai",
          searchRuns: [],
          status: "complete",
          toolCalls: []
        }
      }
    });
  });
  await page.route("**/api/uploads", async (route) => {
    markUploadStarted();
    await uploadCanFinish;
    await route.fulfill({
      contentType: "application/json",
      json: {
        attachment: {
          byteSize: 12,
          extractedText: "A upload",
          fileName: "source-a.md",
          id: "upload-source-a",
          kind: "document",
          mimeType: "text/markdown",
          status: "ready"
        }
      },
      status: 201
    });
  });

  await signIn(page);
  await expect(page.getByTestId("current-chat-title")).toHaveText("Chat A slow");
  await page.getByRole("textbox", { name: "Message" }).fill("Slow question A");
  await page.getByRole("textbox", { name: "Message" }).press("Enter");
  await sendStarted;
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue("");

  await page.getByRole("button", { exact: true, name: "Chat B steady" }).click();
  await expect(page.getByTestId("current-chat-title")).toHaveText("Chat B steady");
  await expect(page.getByTestId("thread")).toContainText("Old B answer");
  await expect(page.getByRole("button", { name: "Select model" })).toBeEnabled();
  await expect(composerRestingButton(page, "Search strategy")).toBeEnabled();
  await expect(page.getByRole("textbox", { name: "Message" })).toBeEnabled();
  await page.getByRole("textbox", { name: "Message" }).fill("Draft while A finishes");
  await expect(page.getByTestId("composer-disabled-hint")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Send message" })).toBeEnabled();
  await page.getByRole("button", { name: "Open details" }).click();
  let details = page.getByTestId("details-pane");
  await details.getByRole("tab", { name: "Events" }).click();
  await expect(details.getByTestId("details-summary")).toHaveText("Branch and run events");
  await expect(details.getByTestId("inspector-event-log")).toContainText("Events appear here during a run");
  releaseSend();

  await expect(page.getByTestId("left-chat-pane")).toContainText("Chat A answered");
  await expect(page.getByTestId("composer-disabled-hint")).toHaveCount(0);
  await expect(page.getByTestId("current-chat-title")).toHaveText("Chat B steady");
  await expect(page.getByTestId("thread")).toContainText("Old B answer");
  await expect(page.getByTestId("thread")).not.toContainText("Slow question A");
  await expect(page.getByTestId("thread")).not.toContainText("Answer A after switch");
  await expect.poll(() => runFetches).toBe(1);
  await expect(details.getByTestId("details-summary")).toHaveText("Branch and run events");
  await expect(details.getByTestId("inspector-event-log")).toContainText("Events appear here during a run");
  await details.getByRole("button", { name: "Close details" }).click();

  await page.getByRole("button", { exact: true, name: "Chat A answered" }).click();
  await expect(page.getByTestId("current-chat-title")).toHaveText("Chat A answered");
  await expect(page.getByTestId("thread")).toContainText("Slow question A");
  await expect(page.getByTestId("thread")).toContainText("Answer A after switch");
  await expect(page.getByTestId("composer-disabled-hint")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Stop response" })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Message" })).toBeEnabled();
  await page.getByRole("button", { name: "Open details" }).click();
  details = page.getByTestId("details-pane");
  await details.getByRole("tab", { name: "Events" }).click();
  await expect(details.getByTestId("details-summary")).toHaveText("Latest run run-a-de");
  await expect(details.getByTestId("inspector-event-log")).toContainText("Run");
  await details.getByRole("button", { name: "Close details" }).click();
  await page.getByRole("textbox", { name: "Message" }).fill("Follow-up after A completes");
  await expect(page.getByRole("button", { name: "Send message" })).toBeEnabled();

  await page.getByLabel("Attach file").setInputFiles({
    buffer: Buffer.from("A upload"),
    mimeType: "text/markdown",
    name: "source-a.md"
  });
  await uploadStarted;
  await expect(page.getByText("Uploading…", { exact: true })).toBeVisible();

  await page.getByRole("button", { exact: true, name: "Chat B steady" }).click();
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue("Draft while A finishes");
  await expect(page.getByText("Uploading…", { exact: true })).toHaveCount(0);
  await expect(page.getByTestId("attachment-chip")).toHaveCount(0);
  releaseUpload();
  await expect(page.getByRole("textbox", { name: "Message" })).toBeEnabled();
  await expect(page.getByTestId("attachment-chip")).toHaveCount(0);

  await page.getByRole("button", { exact: true, name: "Chat A answered" }).click();
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue("Follow-up after A completes");
  await expect(page.getByTestId("attachment-chip")).toContainText("source-a.md");
});

test("disables send while active chat detail is loading", async ({ page }) => {
  let releaseDetail!: () => void;
  const detailCanFinish = new Promise<void>((release) => {
    releaseDetail = release;
  });
  const lazySummary = {
    activeLeafMessageId: "assistant-lazy-old",
    createdAt: "2026-06-08T11:00:00.000Z",
    defaultModelId: "gpt-5.5",
    defaultPromptPresetId: "prompt-helpful",
    defaultProvider: "openai",
    folderId: null,
    id: "chat-lazy",
    messageCount: 2,
    messages: [],
    pinned: false,
    title: "Lazy detail chat",
    updatedAt: "2026-06-08T11:00:02.000Z",
    usageStats: null
  };

  await page.addInitScript(() => window.localStorage.setItem("aiqsa.activeChatId", "chat-lazy"));
  await installMatrixCatalogFixture(page, {
    chats: [lazySummary],
    folders: []
  });
  await page.route("**/api/chats/chat-lazy", async (route) => {
    await detailCanFinish;
    await route.fulfill({
      contentType: "application/json",
      json: {
        chat: {
          ...lazySummary,
          messages: [
            {
              artifactSummary: null,
              content: {
                blocks: [{ text: "Lazy old question", type: "text" }]
              },
              createdAt: "2026-06-08T11:00:00.000Z",
              errorMessage: null,
              id: "user-lazy-old",
              modelId: "gpt-5.5",
              modelRunId: null,
              parentMessageId: null,
              provider: "openai",
              role: "user",
              status: "complete"
            },
            {
              artifactSummary: null,
              content: {
                blocks: [{ text: "Lazy old answer", type: "text" }]
              },
              createdAt: "2026-06-08T11:00:02.000Z",
              errorMessage: null,
              id: "assistant-lazy-old",
              modelId: "gpt-5.5",
              modelRunId: "run-lazy-old",
              parentMessageId: "user-lazy-old",
              provider: "openai",
              role: "assistant",
              status: "complete"
            }
          ]
        }
      }
    });
  });

  await signIn(page);
  await expect(page.getByTestId("current-chat-title")).toHaveText("Lazy detail chat");
  await expect(page.getByTestId("thread-loading-skeleton")).toBeVisible();
  await expect(page.getByTestId("thread")).not.toContainText("New Chat");
  await expect(page.getByRole("textbox", { name: "Message" })).toBeDisabled();
  releaseDetail();
  await expect(page.getByTestId("thread")).toContainText("Lazy old answer");
  await expect(page.getByRole("textbox", { name: "Message" })).toBeEnabled();
});

test("shows a retryable in-thread error state when chat detail loading fails", async ({ page }) => {
  let detailRequests = 0;
  const failingSummary = {
    activeLeafMessageId: "assistant-failing-old",
    createdAt: "2026-06-08T11:00:00.000Z",
    defaultModelId: "gpt-5.5",
    defaultPromptPresetId: "prompt-helpful",
    defaultProvider: "openai",
    folderId: null,
    id: "chat-failing",
    messageCount: 2,
    messages: [],
    pinned: false,
    title: "Failing detail chat",
    updatedAt: "2026-06-08T11:00:02.000Z",
    usageStats: null
  };

  await page.addInitScript(() => window.localStorage.setItem("aiqsa.activeChatId", "chat-failing"));
  await installMatrixCatalogFixture(page, {
    chats: [failingSummary],
    folders: []
  });
  await page.route("**/api/chats/chat-failing", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }

    detailRequests += 1;
    if (detailRequests === 1) {
      await route.fulfill({
        contentType: "application/json",
        json: { error: "internal_error" },
        status: 500
      });
      return;
    }

    await route.fulfill({
      contentType: "application/json",
      json: {
        chat: {
          ...failingSummary,
          messages: [
            scrollMessage("user-failing-old", "user", "Recovered question", null),
            scrollMessage("assistant-failing-old", "assistant", "Recovered detail answer", "user-failing-old")
          ]
        }
      }
    });
  });

  await signIn(page);
  await expect(page.getByTestId("thread-detail-error")).toBeVisible();
  await expect(page.getByTestId("thread-detail-error")).toContainText("This conversation didn't load");
  await expect(page.getByTestId("thread")).not.toContainText("New Chat");
  await expect(page.getByTestId("thread-loading-skeleton")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Message" })).toBeDisabled();
  await expect(page.getByTestId("composer-disabled-hint")).toContainText(
    "Conversation unavailable. Retry loading before sending."
  );
  await expect(page.getByRole("button", { name: "Select model" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Search strategy" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Run settings" })).toBeDisabled();

  await page.getByRole("button", { name: "Retry loading chat" }).click();
  await expect(page.getByTestId("thread")).toContainText("Recovered detail answer");
  await expect(page.getByTestId("thread-detail-error")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Message" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Select model" })).toBeEnabled();
});

test("recovers a background run after reload and renders search/reasoning thread blocks", async ({ page }) => {
  let workspaceReads = 0;
  const workspace = () => {
    workspaceReads += 1;
    const recovered = workspaceReads > 1;

    return {
      chats: [
        {
          activeLeafMessageId: "assistant-refresh",
          createdAt: "2026-06-07T09:00:00.000Z",
          defaultModelId: "gpt-5.5",
          defaultPromptPresetId: "prompt-helpful",
          defaultProvider: "openai",
          folderId: null,
          id: "chat-refresh",
          messageCount: 2,
          messages: [
            {
              artifactSummary: null,
              content: {
                blocks: [{ text: "Recover this background run", type: "text" }]
              },
              createdAt: "2026-06-07T09:00:01.000Z",
              errorMessage: null,
              id: "user-refresh",
              modelId: "gpt-5.5",
              modelRunId: null,
              parentMessageId: null,
              provider: "openai",
              role: "user",
              status: "complete"
            },
            {
              artifactSummary: recovered
                ? {
                    citationCount: 1,
                    citations: [
                      {
                        index: 1,
                        title: "Recovered source",
                        url: "https://example.com/recovered-source"
                      }
                    ],
                    reasoningCount: 1,
                    reasoningText: ["Recovered reasoning summary"],
                    searchCount: 1,
                    searchStrategy: "openai-native-web-search",
                    toolCallCount: 0,
                    toolCalls: []
                  }
                : null,
              content: {
                blocks: [{ text: recovered ? "Recovered answer" : "", type: "text" }]
              },
              createdAt: "2026-06-07T09:00:02.000Z",
              errorMessage: null,
              id: "assistant-refresh",
              modelId: "gpt-5.5",
              modelRunId: "run-refresh",
              parentMessageId: "user-refresh",
              provider: "openai",
              role: "assistant",
              status: recovered ? "complete" : "streaming"
            }
          ],
          pinned: false,
          title: "Background recovery",
          updatedAt: "2026-06-07T09:00:03.000Z",
          usageStats: null
        }
      ],
      contentMatches: [],
      folders: []
    };
  };

  await page.addInitScript(() => window.localStorage.setItem("aiqsa.activeChatId", "chat-refresh"));
  await installMatrixCatalogFixture(page);
  await page.route("**/api/chats", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }

    await route.fulfill({
      contentType: "application/json",
      json: workspace()
    });
  });
  await page.route("**/api/chats/chat-refresh", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }

    await route.fulfill({
      contentType: "application/json",
      json: {
        chat: workspace().chats[0]
      }
    });
  });
  await page.route("**/api/model-runs/run-refresh", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: {
        run: {
          errorPayload: null,
          events: [
            {
              eventType: "artifact",
              payload: {
                artifactType: "search",
                payload: {
                  strategyId: "openai-native-web-search"
                }
              },
              sequence: 0
            },
            {
              eventType: "artifact",
              payload: {
                artifactType: "reasoning",
                payload: {
                  summary: "Recovered reasoning summary"
                }
              },
              sequence: 1
            }
          ],
          id: "run-refresh",
          inputTokens: 2,
          modelId: "gpt-5.5",
          provider: "openai",
          searchRuns: [],
          status: "complete",
          toolCalls: []
        }
      }
    });
  });

  await signIn(page);
  await expect(page.getByTestId("thread")).toContainText("Recovered answer");
  await expect(page.getByTestId("streaming-cursor")).toHaveCount(0);
  await expect(page.getByTestId("thread-search-summary")).toContainText("1 search call");
  await page.getByTestId("thread-citations-block").getByRole("button", { name: /Citations 1/ }).click();
  await expect(page.getByTestId("thread-citations-block")).toContainText("Recovered source");
  const runSettings = await openRunSettings(page);
  await runSettings.getByRole("button", { name: "Hide citations" }).click();
  await expect(page.getByTestId("thread-citations-block")).toHaveCount(0);
  await runSettings.getByRole("button", { name: "Show citations" }).click();
  await closeRunSettings(page);
  await page.getByTestId("thread-citations-block").getByRole("button", { name: /Citations 1/ }).click();
  await expect(page.getByTestId("thread-citations-block")).toContainText("Recovered source");
  await expect(page.getByTestId("thread-reasoning-block")).toHaveCount(0);
  const reasoningSettings = await openRunSettings(page);
  await reasoningSettings.getByRole("button", { name: "Show reasoning blocks" }).click();
  await closeRunSettings(page);
  await page.getByTestId("thread-reasoning-block").getByRole("button", { name: /Reasoning 1/ }).click();
  await expect(page.getByTestId("thread-reasoning-block")).toContainText("Recovered reasoning summary");
});

test("shows tool activity by default and persists hide/show across reload", async ({ page }) => {
  const chatId = "chat-tool-activity-preference";
  let settingsPatches = 0;
  const chat = {
    activeLeafMessageId: "assistant-tool-activity",
    createdAt: "2026-07-23T12:00:00.000Z",
    defaultModelId: "gpt-5.5",
    defaultPromptPresetId: "prompt-helpful",
    defaultProvider: "openai",
    folderId: null,
    id: chatId,
    messageCount: 2,
    messages: [
      {
        artifactSummary: null,
        content: { blocks: [{ text: "Use my memory", type: "text" }] },
        createdAt: "2026-07-23T12:00:00.000Z",
        errorMessage: null,
        id: "user-tool-activity",
        modelId: "gpt-5.5",
        modelRunId: null,
        parentMessageId: null,
        provider: "openai",
        role: "user",
        status: "complete"
      },
      {
        artifactSummary: {
          citationCount: 0,
          citations: [],
          reasoningCount: 0,
          reasoningText: [],
          searchCount: 0,
          searchStrategy: null,
          toolCallCount: 1,
          toolCalls: [{
            argumentsPreview: { apiKey: "[redacted]", query: "memory" },
            callId: "call-tool-activity",
            capability: "mcp",
            credentialSources: ["personal"],
            durationMs: 64,
            errorMessage: null,
            externalAccountLabel: "Personal memory",
            ordinal: 0,
            resultPreview: { content: [{ text: "found", type: "text" }] },
            round: 1,
            serverName: "Mem0",
            status: "complete",
            toolName: "search"
          }]
        },
        content: { blocks: [{ text: "I found the memory.", type: "text" }] },
        createdAt: "2026-07-23T12:00:01.000Z",
        errorMessage: null,
        id: "assistant-tool-activity",
        modelId: "gpt-5.5",
        modelRunId: "run-tool-activity",
        parentMessageId: "user-tool-activity",
        provider: "openai",
        role: "assistant",
        status: "complete"
      }
    ],
    pinned: false,
    title: "Tool activity preference",
    updatedAt: "2026-07-23T12:00:01.000Z",
    usageStats: null
  };

  await page.addInitScript((activeChatId) => {
    window.localStorage.setItem("aiqsa.activeChatId", activeChatId);
  }, chatId);
  await installMatrixCatalogFixture(
    page,
    { chats: [chat], contentMatches: [], folders: [] },
    { onSettingsPatch: () => { settingsPatches += 1; } }
  );
  await signIn(page);

  const activity = page.getByTestId("thread-tool-activity");
  await expect(activity).toBeVisible();
  await activity.getByRole("button", { name: /Used 1 tool/ }).click();
  await expect(page.getByTestId("thread-tool-activity-details")).toContainText("Mem0 / search");

  let settings = await openRunSettings(page);
  await settings.getByRole("button", { name: "Hide tool activity" }).click();
  await expect.poll(() => settingsPatches).toBe(1);
  await closeRunSettings(page);
  await expect(activity).toHaveCount(0);

  await page.reload();
  await expect(page.getByTestId("app-shell")).toBeVisible();
  await expect(page.getByTestId("thread-tool-activity")).toHaveCount(0);

  settings = await openRunSettings(page);
  await settings.getByRole("button", { name: "Show tool activity" }).click();
  await expect.poll(() => settingsPatches).toBe(2);
  await closeRunSettings(page);
  await expect(page.getByTestId("thread-tool-activity")).toBeVisible();

  await page.reload();
  await expect(page.getByTestId("app-shell")).toBeVisible();
  await expect(page.getByTestId("thread-tool-activity")).toContainText("Mem0");
});

test("supports the default QSA chat and folder workflow", async ({ browser, page }) => {
  test.setTimeout(60_000);
  const suffix = Date.now();
  const folderName = `E2E Folder ${suffix}`;
  const prompt = `Folder path e2e question ${suffix}`;
  const memoryPrompt = `What was my first message in this chat? ${suffix}`;

  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          window.localStorage.setItem("aiqsa.testClipboard", text);
        }
      }
    });
  });
  await page.goto("/");

  await expect(page).toHaveURL(/\/login/);
  const loginResponse = await page.request.post("/api/auth/token", {
    data: {
      token: "aiqsa-test-token"
    }
  });
  expect(loginResponse.ok()).toBe(true);
  await page.goto("/");
  await expect(page.getByTestId("app-shell")).toBeVisible();
  const resetModelLabel = await cleanupE2eWorkspace(page);
  await page.reload();

  await expect(page.getByTestId("app-shell")).toBeVisible();
  await expect(page.getByTestId("left-chat-pane")).toBeVisible();
  await expect(page.getByTestId("main-thread-pane")).toBeVisible();
  await expect(page.getByTestId("details-pane")).toHaveCount(0);
  const resetModelButton = page.getByRole("button", { name: "Select model" });
  await expect(resetModelButton).toContainText(resetModelLabel.split(" / ").at(-1) ?? resetModelLabel);
  await expect(resetModelButton).toHaveAttribute("title", resetModelLabel);
  await expect(page.getByTestId("current-chat-title")).toHaveText("New chat");
  await expect(page.getByTestId("thread")).not.toContainText("Compare native web search");

  await page.getByRole("button", { name: "Share anonymously" }).click();
  await expect(page.getByTestId("shell-notice")).toContainText("Send a message before sharing.");

  const newChatRowsBeforeBlank = await page
    .getByTestId("left-chat-pane")
    .getByRole("button", { exact: true, name: "New Chat" })
    .count();
  await page.getByRole("button", { name: "Start new chat" }).click();
  await expect(page.getByLabel("Chat folder")).toHaveCount(0);
  await expect(page.getByTestId("current-chat-title")).toHaveText("New chat");
  await expect(page.getByTestId("left-chat-pane").getByRole("button", { exact: true, name: "New Chat" })).toHaveCount(
    newChatRowsBeforeBlank
  );

  await page.getByRole("button", { name: "New folder" }).click();
  await page.getByLabel("Folder name").fill(folderName);
  await page.getByRole("button", { name: "Create folder" }).click();
  await expect(page.getByTestId("shell-notice")).toContainText(`Folder created: ${folderName}`);
  await expect(page.getByTestId("left-chat-pane")).toContainText(folderName);

  await page.getByRole("button", { name: `Folder actions ${folderName}` }).click();
  await page.getByTestId("left-chat-pane").getByRole("button", { exact: true, name: "New chat" }).click();
  await expect(page.getByTestId("current-chat-title")).toHaveText("New chat");
  await expect(page.getByLabel("Chat folder")).toHaveCount(0);

  await selectModel(page, "fake", "fake-qsa");
  await expect(page.getByRole("button", { name: "Select model" })).toContainText("Fake QSA");
  await expect(page.getByLabel("Developer prompt")).toHaveCount(0);
  const initialRunSettings = await openRunSettings(page);
  await initialRunSettings.getByLabel("Temperature").fill("0.1");
  await closeRunSettings(page);

  let activeChatDetailFetches = 0;
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (request.method() === "GET" && /^\/api\/chats\/[^/]+$/.test(pathname)) {
      activeChatDetailFetches += 1;
    }
  });

  await expect(page.getByTestId("pipeline-indicator")).toHaveCount(0);

  await page.getByRole("textbox", { name: "Message" }).fill(prompt);
  await page.getByRole("textbox", { name: "Message" }).press("Enter");

  const pipeline = page.getByTestId("pipeline-indicator");
  await expect(pipeline).toHaveAttribute("data-phase", "running");
  await pipeline.click();
  let details = page.getByTestId("details-pane");
  await expect(details.getByRole("tab", { name: "Events" })).toHaveAttribute("aria-selected", "true");

  await expect(assistantContentWithText(page, `Fake answer: ${prompt}`)).toBeVisible({ timeout: 20_000 });
  expect(activeChatDetailFetches).toBe(0);
  await expect(page.getByTestId("thread")).toContainText("Fake / Fake QSA");
  await expect(page.getByTestId("streaming-cursor")).toHaveCount(0);
  await expect(page.getByTestId("pipeline-indicator")).toHaveCount(0);
  await expect(details.getByTestId("inspector-event-log")).toContainText("Done");
  await details.getByRole("button", { name: "Pin details" }).click();
  await expect(details).toHaveAttribute("data-presentation", "pinned");
  await expect(page.getByTestId("left-chat-pane")).toContainText(String(suffix));
  await page.getByLabel("Search chats").fill(String(suffix));
  await expect(page.getByTestId("left-chat-pane")).toContainText(String(suffix));
  await page.getByLabel("Search chats").fill(`missing ${suffix}`);
  await expect(page.getByTestId("left-chat-pane")).toContainText("No title or model matches");
  await page.getByLabel("Search chats").fill("");
  await expect(page.getByTestId("current-chat-title")).toBeVisible();
  const desktopChatToolbar = page.getByRole("toolbar", { name: "Chat actions" });
  await expect(desktopChatToolbar).toBeVisible();
  const desktopCopyThread = page.getByRole("button", { name: "Copy thread" });
  expect(
    await desktopCopyThread.evaluate((element) =>
      Boolean(element.closest('[aria-label="Chat actions"]'))
    )
  ).toBe(true);
  await desktopCopyThread.click();
  await expect(page.getByTestId("shell-notice")).toContainText("Thread copied");
  await expect
    .poll(() => page.evaluate(() => window.localStorage.getItem("aiqsa.testClipboard") ?? ""))
    .toContain(prompt);
  await page.getByTestId("left-chat-pane").getByRole("button", { name: /Chat actions/ }).first().click();
  await expect(page.getByRole("button", { name: "Rename" })).toBeVisible();
  const moveChat = page.getByLabel(/Move chat .* to folder/);
  await expect(moveChat).toBeVisible();
  await expect(moveChat.getByRole("option", { name: "No folder" })).toBeAttached();
  await expect(page.getByTestId("left-chat-pane").getByRole("button", { name: "Export" })).toBeVisible();
  await expect(page.getByTestId("left-chat-pane").getByRole("button", { name: "Share" })).toBeVisible();
  await expect(page.getByTestId("left-chat-pane").getByRole("button", { name: "Delete chat" })).toBeVisible();
  await moveChat.selectOption({ label: "No folder" });
  await expect(page.getByTestId("shell-notice")).toContainText("Moved:");
  await page.getByTestId("left-chat-pane").getByRole("button", { name: /Chat actions/ }).first().click();
  await page.getByLabel(/Move chat .* to folder/).selectOption({ label: folderName });
  await expect(page.getByTestId("shell-notice")).toContainText("Moved:");
  await expect(page.getByTestId("details-pane")).toContainText("Details");
  await expect(page.getByTestId("details-pane")).not.toContainText("Current/latest run");
  await expect(page.getByRole("tab", { name: "Request" })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Response" })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Usage" })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Prompt" })).toHaveCount(0);
  await expect(page.getByTestId("current-context-length")).toHaveAccessibleName(/Approx\. input:/);
  await expect(page.getByTestId("composer-usage-line")).toContainText("/ 7.4k safe input · 8.2k total context");
  await expect(page.getByTestId("composer-usage-line")).not.toContainText("cost");
  await page.getByTestId("token-stats-button").click();
  await expect(page.getByTestId("token-stats-popover")).toContainText("Total messages");
  await expect(page.getByTestId("token-stats-popover")).toContainText("Provider-reported tokens");
  await expect(page.getByTestId("token-stats-popover")).toContainText("Total tokens cached");
  await expect(page.getByTestId("token-stats-popover")).not.toContainText("cost");
  await page.keyboard.press("Escape");
  await details.getByRole("tab", { name: "Events" }).click();
  await expect(details.getByRole("tab", { name: "Events" })).toHaveAttribute("aria-selected", "true");
  await expect(details.getByRole("tab", { name: "API params" })).toHaveCount(0);
  await expect(details.getByLabel("Temperature")).toHaveCount(0);

  await page.getByRole("tab", { name: "Events" }).click();
  await expect(page.getByTestId("inspector-event-log")).toContainText("Run");
  await expect(page.getByTestId("inspector-event-log")).toContainText("Provider status");
  await expect(page.getByTestId("inspector-event-log")).toContainText("Done");
  await page.getByRole("button", { name: "Branch tree" }).click();
  await expect(page.getByRole("tab", { name: "Branch" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("branch-tree")).toBeVisible();
  await page.reload();
  details = page.getByTestId("details-pane");
  await expect(details).toHaveAttribute("data-presentation", "pinned");
  await expect(page.getByTestId("current-context-length")).toHaveAccessibleName(/Approx\. input:/);
  await page.getByTestId("token-stats-button").click();
  await expect(page.getByTestId("token-stats-popover")).toContainText("Provider-reported tokens");
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Branch from here" }).last().click();
  await expect(page.getByTestId("shell-notice")).toContainText("Branched chat:");
  await expect(page.getByTestId("thread")).toContainText(prompt);
  await expect(page.getByTestId("thread")).toContainText(`Fake answer: ${prompt}`);

  await page.getByRole("textbox", { name: "Message" }).fill(memoryPrompt);
  await page.getByRole("textbox", { name: "Message" }).press("Enter");
  await expect(assistantContentWithText(page, `Fake answer: ${memoryPrompt}`)).toBeVisible();
  await expect(page.getByTestId("thread")).toContainText(`Context memory: ${prompt}`);

  await page.getByRole("tab", { name: "Branch" }).click();
  await page.getByRole("button", { name: "Checkout branch assistant 2" }).click();
  const checkoutPrompt = `Branch checkout e2e ${suffix}`;
  await page.getByRole("textbox", { name: "Message" }).fill(checkoutPrompt);
  await page.getByRole("textbox", { name: "Message" }).press("Enter");
  await expect(assistantContentWithText(page, `Fake answer: ${checkoutPrompt}`)).toBeVisible();
  await expect(page.getByTestId("thread")).toContainText(`Context memory: ${prompt}`);
  await expect(page.getByTestId("thread")).not.toContainText(memoryPrompt);
  await page.getByRole("tab", { name: "Branch" }).click();
  activeChatDetailFetches = 0;
  await page.getByRole("button", { name: /Regenerate message/ }).last().click();
  await expect(page.getByTestId("streaming-cursor")).toHaveCount(0);
  await expect(assistantContentWithText(page, `Fake answer: ${checkoutPrompt}`)).toBeVisible();
  await expect(page.getByTestId("thread")).toContainText(`Context memory: ${prompt}`);
  await expect(page.getByTestId("thread")).not.toContainText("Regenerated branch draft");
  expect(activeChatDetailFetches).toBe(0);
  await page.getByRole("button", { name: "Delete message" }).last().click();
  let messageDeleteDialog = page.getByRole("dialog", { name: "Delete message" });
  await expect(messageDeleteDialog).toContainText("every reply below");
  await messageDeleteDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(assistantContentWithText(page, `Fake answer: ${checkoutPrompt}`)).toBeVisible();
  await page.getByRole("button", { name: "Delete message" }).last().click();
  messageDeleteDialog = page.getByRole("dialog", { name: "Delete message" });
  await messageDeleteDialog.getByRole("button", { name: "Confirm delete message" }).click();
  await expect(page.getByTestId("shell-notice")).toContainText("Message deleted");
  await expect(page.getByRole("textbox", { name: "Message" })).toBeFocused();

  const shareCreation = page.waitForResponse((response) => {
    const pathname = new URL(response.url()).pathname;
    return response.request().method() === "POST" && /^\/api\/chats\/[^/]+\/share$/.test(pathname);
  });
  await page.getByRole("button", { name: "Share anonymously" }).click();
  const shareCreationResponse = await shareCreation;
  expect(shareCreationResponse.ok()).toBe(true);
  await expect(page.getByTestId("share-link")).toBeVisible();
  const shareHref = await page.getByTestId("share-link").getByRole("link").getAttribute("href");
  expect(shareHref).toBeTruthy();

  const anonymousContext = await browser.newContext();
  const anonymousPage = await anonymousContext.newPage();
  try {
    const shareResponse = await anonymousPage.goto(shareHref!);
    expect(shareResponse?.status()).toBe(200);
    await expect(anonymousPage.getByTestId("public-share-view")).toContainText("Read-only snapshot");
    await expect(anonymousPage.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(anonymousPage.getByRole("list", { name: "Shared conversation" })).toBeVisible();
    await expect(
      anonymousPage.getByRole("article", { name: "Shared question" }).filter({ hasText: prompt })
    ).toBeVisible();
    await expect(
      anonymousPage
        .getByRole("article", { name: "Shared answer" })
        .filter({ hasText: `Fake answer: ${prompt}` })
    ).toBeVisible();
    await expect(anonymousPage.getByText("Visible answer contract")).toHaveCount(0);
    await expect(anonymousPage.getByText("Fake / Fake QSA")).toHaveCount(0);
    await expect(anonymousPage.getByRole("button", { name: "Share anonymously" })).toHaveCount(0);
    await expect(anonymousPage.getByRole("button", { name: "Edit message" })).toHaveCount(0);
    await expect(anonymousPage.getByRole("button", { name: "Open details" })).toHaveCount(0);

    const shareRevocation = page.waitForResponse((response) => {
      const pathname = new URL(response.url()).pathname;
      return response.request().method() === "POST" && /^\/api\/shares\/[^/]+\/revoke$/.test(pathname);
    });
    await page.getByTestId("share-link").getByRole("button", { name: "Revoke link" }).click();
    const shareRevocationResponse = await shareRevocation;
    expect(shareRevocationResponse.ok()).toBe(true);
    await expect(page.getByTestId("shell-notice")).toContainText("Public share link revoked");
    await expect(page.getByRole("button", { name: "Share anonymously" })).toBeFocused();
    const revokedShareResponse = await anonymousPage.goto(shareHref!);
    expect(revokedShareResponse?.status()).toBe(404);
    await expect(anonymousPage.getByTestId("public-share-unavailable")).toContainText(
      "Shared snapshot unavailable"
    );
    await expect(anonymousPage).not.toHaveURL(/\/login/);

    const unknownShareResponse = await anonymousPage.goto("/s/unknown-token");
    expect(unknownShareResponse?.status()).toBe(404);
    await expect(anonymousPage.getByTestId("public-share-unavailable")).toContainText(
      "Shared snapshot unavailable"
    );
    await expect(anonymousPage.getByTestId("public-share-unavailable")).not.toContainText(
      "operator@aiqsa.local"
    );
    await expect(anonymousPage).not.toHaveURL(/\/login/);
    await expect.poll(async () => (await anonymousContext.request.get("/favicon.svg")).status()).toBe(200);
    await expect.poll(async () => (await anonymousContext.request.get("/favicon-alert.svg")).status()).toBe(200);
  } finally {
    await anonymousContext.close();
  }

  await cleanupE2eWorkspace(page);
});

test("manages prompt presets and left-pane folders", async ({ page }) => {
  test.setTimeout(45_000);
  const suffix = Date.now();
  const folderName = `E2E Folder Manage ${suffix}`;
  const renamedFolderName = `E2E Folder Renamed ${suffix}`;
  const subfolderName = `E2E Subfolder ${suffix}`;
  const promptName = `E2E Prompt ${suffix}`;

  await signIn(page);
  await cleanupE2eWorkspace(page);
  await page.reload();
  await expect(page.getByTestId("app-shell")).toBeVisible();

  await page.getByRole("button", { name: "New folder" }).click();
  await page.getByLabel("Folder name").fill(folderName);
  await page.getByRole("button", { name: "Create folder" }).click();
  await expect(page.getByTestId("left-chat-pane")).toContainText(folderName);

  await page.getByRole("button", { name: `Folder actions ${folderName}` }).click();
  await page.getByRole("button", { name: "Rename" }).click();
  await page.getByRole("textbox", { name: `Rename folder ${folderName}` }).fill(renamedFolderName);
  await page.getByRole("button", { name: `Save folder ${folderName}` }).click();
  await expect(page.getByTestId("left-chat-pane")).toContainText(renamedFolderName);

  await page.getByRole("button", { name: `Collapse folder ${renamedFolderName}` }).click();
  await expect(page.getByRole("button", { name: `Expand folder ${renamedFolderName}` })).toBeVisible();
  await page.getByRole("button", { name: `Expand folder ${renamedFolderName}` }).click();
  await expect(page.getByRole("button", { name: `Collapse folder ${renamedFolderName}` })).toBeVisible();

  await page.getByRole("button", { name: `Folder actions ${renamedFolderName}` }).click();
  await page.getByRole("button", { name: "New subfolder" }).click();
  await page.getByLabel(`Subfolder name for ${renamedFolderName}`).fill(subfolderName);
  await page.getByRole("button", { name: `Create subfolder in ${renamedFolderName}` }).click();
  await expect(page.getByTestId("left-chat-pane")).toContainText(subfolderName);

  await page.getByRole("button", { name: `Folder actions ${renamedFolderName}` }).click();
  await page.getByRole("button", { name: "Project settings" }).click();
  const projectDialog = page.getByRole("dialog", { name: `Project Settings ${renamedFolderName}` });
  await projectDialog.getByLabel("Project memory").fill("Prefer terse E2E project memory.");
  await projectDialog.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("shell-notice")).toContainText(`Project settings saved: ${renamedFolderName}`);

  await page.getByRole("button", { name: `Folder actions ${subfolderName}` }).click();
  await page.getByLabel(`Move folder ${subfolderName} to folder`).selectOption("");
  await expect(page.getByTestId("shell-notice")).toContainText(`Folder moved: ${subfolderName}`);

  await page.getByRole("button", { name: `Folder actions ${renamedFolderName}` }).click();
  await page
    .getByTestId("left-chat-pane")
    .locator("[data-left-pane-menu]")
    .getByRole("button", { name: "Delete folder" })
    .click();
  await page
    .getByRole("dialog", { name: `Delete folder ${renamedFolderName}` })
    .getByRole("button", { name: "Confirm delete folder" })
    .click();
  await expect(page.getByRole("button", { name: `Folder actions ${renamedFolderName}` })).toHaveCount(0);

  await page.getByRole("button", { name: "Open settings" }).click();
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
  await page.getByRole("button", { name: "New prompt" }).click();
  await page.getByLabel("Prompt name").fill(promptName);
  await page.getByLabel("Settings system prompt").fill("You are an E2E prompt preset.");
  await page.getByRole("button", { name: "Create prompt" }).click();
  await expect(page.getByTestId("shell-notice")).toContainText(`Prompt saved: ${promptName}`);
  await page.getByRole("button", { name: "Set selected prompt as default" }).click();
  await expect(page.getByTestId("shell-notice")).toContainText(`Default prompt: ${promptName}`);
  await page.getByRole("button", { name: `Use prompt ${promptName} for next run` }).click();
  await page.getByRole("button", { name: "Close settings" }).click();
  await expect(await runSettingsButton(page, "Prompt preset")).toContainText(promptName);
  await closeRunSettings(page);

  await page.getByRole("button", { name: "Open settings" }).click();
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();

  await page.getByRole("button", { name: "Set prompt Helpful Assistant as default" }).click();
  await expect(page.getByTestId("shell-notice")).toContainText("Default prompt: Helpful Assistant");
  await page.getByRole("button", { name: "Delete selected prompt" }).click();
  await page
    .getByRole("dialog", { name: `Delete prompt ${promptName}` })
    .getByRole("button", { name: "Confirm delete prompt" })
    .click();
  await expect(page.getByTestId("shell-notice")).toContainText("Prompt deleted");

  await cleanupE2eWorkspace(page);
});

for (const viewport of responsiveTouchViewports) {
  test(`keeps the conversation and composer touch-safe in ${viewport.label}`, async ({ baseURL, browser }, testInfo) => {
    testInfo.setTimeout(90_000);
    expect(baseURL).toBeTruthy();
    const context = await browser.newContext({
      baseURL,
      colorScheme: "dark",
      hasTouch: true,
      isMobile: true,
      reducedMotion: "reduce",
      viewport: { height: viewport.height, width: viewport.width }
    });

    try {
      const page = await context.newPage();
      let createChatRequests = 0;
      page.on("request", (request) => {
        if (request.method() === "POST" && new URL(request.url()).pathname === "/api/chats") {
          createChatRequests += 1;
        }
      });
      const chatId = `responsive-touch-${viewport.label}`;
      const compactComposer = viewport.width < 640 || viewport.height <= 512;
      const title = `A deliberately long ${viewport.label} conversation title that preserves every top-bar action`;
      const artifactSummary = {
        citationCount: 1,
        citations: [
          {
            index: 1,
            snippet: `Responsive citation ${"remains readable ".repeat(10)}`,
            title: "Responsive evidence source with a deliberately long title",
            url: `https://example.com/${"responsive-evidence/".repeat(14)}`
          }
        ],
        contextTruncation: { approxDroppedTokens: 2100, droppedMessages: 3 },
        reasoningCount: 1,
        reasoningText: [`Responsive reasoning ${"stays locally contained. ".repeat(14)}`],
        searchCount: 2,
        searchDetails: [
          {
            requestPreview: { query: `responsive ${"request-segment/".repeat(18)}` },
            responsePreview: { result: `responsive ${"response-segment/".repeat(18)}` },
            status: "complete",
            strategyId: "perplexity-tool-search"
          }
        ],
        searchStrategy: "perplexity-tool-search",
        toolCallCount: 0,
        toolCalls: []
      };
      const longMarkdown = [
        "# Responsive report",
        "The conversation remains primary at every target viewport.",
        "",
        "| Viewport | Expected behavior | Deliberately descriptive evidence |",
        "| --- | --- | --- |",
        `| Landscape | Composer stays reachable | ${"RESPONSIVETABLETOKEN".repeat(80)} |`,
        "| Tablet | Reading measure stays calm | Touch targets remain safe |",
        "",
        "\\[",
        String.raw`\hat\sigma_{\text{robust}}=\frac{\mathrm{MAD}}{0.67449}\approx1.4826\cdot\mathrm{MAD}`,
        "\\]",
        "",
        "```ts",
        `const localOverflow = "${"responsive-code-segment-".repeat(48)}";`,
        "```"
      ].join("\n");
      const messages = [
        scrollMessage("responsive-user-1", "user", "Start the responsive audit", null),
        scrollMessage(
          "responsive-assistant-1",
          "assistant",
          `First responsive answer. ${"Readable detail. ".repeat(18)}`,
          "responsive-user-1"
        ),
        scrollMessage(
          "responsive-user-2",
          "user",
          "Inspect artifacts, Markdown, touch actions, and the composer",
          "responsive-assistant-1"
        ),
        {
          ...scrollMessage("responsive-assistant-2", "assistant", longMarkdown, "responsive-user-2"),
          artifactSummary
        },
        scrollMessage(
          "responsive-user-3",
          "user",
          `Keep enough content for scrolling. ${"Supporting line. ".repeat(16)}`,
          "responsive-assistant-2"
        ),
        scrollMessage("responsive-assistant-3", "assistant", "Responsive latest bottom marker", "responsive-user-3")
      ];
      const chat = {
        activeLeafMessageId: "responsive-assistant-3",
        createdAt: "2026-07-11T10:00:00.000Z",
        defaultModelId: "gpt-5.5",
        defaultPromptPresetId: "prompt-helpful",
        defaultProvider: "openai",
        folderId: "responsive-child",
        id: chatId,
        messageCount: messages.length,
        messages,
        pinned: false,
        title,
        updatedAt: "2026-07-11T10:01:00.000Z",
        usageStats: null
      };
      const folders = [
        {
          id: "responsive-root",
          name: "Responsive research",
          parentId: null,
          projectMemory: "Keep the conversation primary.",
          sortOrder: 0
        },
        {
          id: "responsive-child",
          name: "Nested landscape and tablet evidence",
          parentId: "responsive-root",
          projectMemory: "Verify touch and viewport containment.",
          sortOrder: 0
        }
      ];
      const responsiveCatalog = {
        ...matrixCatalog,
        defaults: { ...matrixCatalog.defaults, showReasoningBlocks: true }
      };

      await page.addInitScript((activeChatId) => {
        window.localStorage.setItem("aiqsa.activeChatId", activeChatId);
      }, chatId);
      await installResponsiveTouchStream(page, chatId);
      await installMatrixCatalogFixture(page, { chats: [chat], folders }, { catalog: responsiveCatalog });
      await page.route(`**/api/chats/${chatId}`, async (route) => {
        if (route.request().method() !== "GET") {
          await route.continue();
          return;
        }
        await route.fulfill({ contentType: "application/json", json: { chat } });
      });
      if (viewport.label === "landscape") {
        await page.route(`**/api/chats/${chatId}/share`, async (route) => {
          await route.fulfill({
            contentType: "application/json",
            json: { share: { id: "responsive-landscape-share", publicPath: "/s/responsive-landscape-token" } }
          });
        });
        await page.route("**/api/shares/responsive-landscape-share/revoke", async (route) => {
          await route.fulfill({
            contentType: "application/json",
            json: { share: { id: "responsive-landscape-share", revoked: true } }
          });
        });
      }
      const uploadNames = [
        "responsive-research-notes-with-a-deliberately-long-name.md",
        "responsive-source-table-with-a-deliberately-long-name.csv",
        "responsive-context-export-with-a-deliberately-long-name.json"
      ];
      let uploadIndex = 0;
      await page.route("**/api/uploads", async (route) => {
        if (route.request().method() !== "POST") {
          await route.continue();
          return;
        }
        const fileName = uploadNames[Math.min(uploadIndex, uploadNames.length - 1)];
        uploadIndex += 1;
        await route.fulfill({
          contentType: "application/json",
          json: {
            attachment: {
              byteSize: 128 + uploadIndex,
              extractedText: "Responsive upload evidence",
              fileName,
              id: `responsive-upload-${uploadIndex}`,
              kind: "document",
              metadata: {},
              mimeType: fileName.endsWith(".json") ? "application/json" : "text/plain",
              status: "ready"
            }
          }
        });
      });

      await signIn(page);
      const currentChatTitle = page.getByTestId("current-chat-title");
      await expect(currentChatTitle).toHaveAttribute("title", title);
      await expect
        .poll(() =>
          currentChatTitle.evaluate((element) => {
            const style = getComputedStyle(element);
            return style.position === "absolute"
              && style.width === "1px"
              && style.height === "1px"
              && style.overflow === "hidden";
          })
        )
        .toBe(true);
      await expect(page.getByRole("toolbar", { name: "Chat actions" })).toBeHidden();
      const viewportMeta = page.locator('meta[name="viewport"]');
      await expect(viewportMeta).toHaveAttribute("content", /viewport-fit=cover/);
      await expect(viewportMeta).toHaveAttribute("content", /interactive-widget=resizes-content/);
      expect(await page.evaluate(() => window.matchMedia("(hover: none)").matches)).toBe(true);
      expect(await page.evaluate(() => window.matchMedia("(pointer: coarse)").matches)).toBe(true);
      await expectNoHorizontalOverflow(page);

      for (const name of [
        "Open workspace",
        "Start new chat",
        "Copy thread",
        "Branch tree",
        "Share anonymously",
        "Open details",
        "Account menu"
      ]) {
        const action = page.getByRole("button", { name });
        expect(
          await action.evaluate((element) =>
            Boolean(element.closest('[data-testid="top-rail"]'))
          )
        ).toBe(true);
        await expectTouchSafe(action);
        await expectWithinViewport(page, action);
      }
      if (viewport.label === "landscape") {
        await page.getByRole("button", { name: "Share anonymously" }).click();
        await expect(page.getByTestId("persistent-notice-region")).toContainText(/Share link (copied|created)/);
        await expect(page.getByTestId("share-link")).toBeVisible();
        await expect(page.getByTestId("shell-notice-layer")).toHaveCount(0);
      }
      const accountTrigger = page.getByRole("button", { name: "Account menu" });
      await accountTrigger.click();
      const accountMenu = page.getByRole("menu", { name: "Account" });
      await expectWithinViewport(page, accountMenu);
      const accountEmail = accountMenu.getByText("operator@aiqsa.local");
      await expect(accountEmail).toBeVisible();
      await expectWithinViewport(page, accountEmail);
      for (const name of ["Command palette", "Settings", "Admin console", "Sign out"]) {
        const action = accountMenu.getByRole("menuitem", { name });
        await expectTouchSafe(action);
        await expectWithinViewport(page, action);
        await action.click({ trial: true });
      }
      await page.keyboard.press("Escape");
      await expect(accountTrigger).toBeFocused();
      if (viewport.label === "landscape") {
        await page.getByTestId("share-link").getByRole("button", { name: "Revoke link" }).click();
        await expect(page.getByTestId("shell-notice")).toContainText("Public share link revoked");
        await page.getByTestId("shell-notice").getByRole("button", { name: "Dismiss notice" }).click();
      }

      const composer = page.getByRole("textbox", { name: "Message" });
      const messageLabel = page.locator('label[for="composer"]');
      await expect.poll(() => composer.evaluate((element) => getComputedStyle(element).fontSize)).toBe("16px");
      await expect(composer).toHaveAccessibleName("Message");
      await expect(messageLabel).toHaveText("Message");
      if (compactComposer) {
        await expect(page.getByTestId("composer-form")).not.toHaveAttribute(
          "data-reading-collapsed"
        );
        await expect
          .poll(() =>
            messageLabel.evaluate((element) => {
              const style = getComputedStyle(element);
              return style.position === "absolute"
                && style.width === "1px"
                && style.height === "1px"
                && style.overflow === "hidden";
            })
          )
          .toBe(true);
        const [messageFieldBox, composerInputBox] = await Promise.all([
          page.getByTestId("composer-message-field").boundingBox(),
          composer.boundingBox()
        ]);
        expect(messageFieldBox).toBeTruthy();
        expect(composerInputBox).toBeTruthy();
        expect(composerInputBox!.x - messageFieldBox!.x).toBeLessThanOrEqual(16);
        expect(messageFieldBox!.x + messageFieldBox!.width - composerInputBox!.x - composerInputBox!.width).toBeLessThanOrEqual(16);
        const summary = composerRunSummary(page);
        await expect(summary).toBeVisible();
        await expect(summary).toContainText("Custom");
        await expect(page.getByTestId("run-reasoning-summary")).toContainText("Medium");
        await expect(page.getByTestId("run-search-summary")).toContainText("Search: Off");
        await expectTouchSafe(summary);
        await expectWithinViewport(page, summary);
        const compactProfiles = page.getByTestId("composer-compact-run-profiles");
        await expect(compactProfiles).toBeVisible();
        const compactProfileViewport = compactProfiles.locator("..");
        await expect
          .poll(() =>
            compactProfileViewport.evaluate(
              (element) => element.scrollWidth <= element.clientWidth
            )
          )
          .toBe(true);
        for (const name of ["Use Fast run profile", "Use Balanced run profile", "Use Deep run profile"]) {
          const profile = compactProfiles.getByRole("button", { name });
          await expect(profile).toBeVisible();
          await expectTouchSafe(profile);
        }
        await compactProfiles.getByRole("button", { name: "Use Deep run profile" }).click();
        await expect(compactProfiles.getByRole("button", { name: "Use Deep run profile" })).toHaveAttribute(
          "aria-pressed",
          "true"
        );
        await expect(summary).toContainText("Deep");
        await expect(page.getByTestId("current-context-length")).toBeHidden();
        await page.getByTestId("token-stats-button").click();
        const contextStats = page.getByTestId("token-stats-popover");
        await expect(contextStats).toContainText("Current context");
        await expect(contextStats).toContainText("safe input");
        await expect(contextStats).toContainText("total context");
        await contextStats.getByRole("button", { name: "Close context and usage statistics" }).click();
        for (const name of ["Select model", "Search strategy", "Run settings"]) {
          await expect(page.getByRole("button", { name })).toBeHidden();
        }
        const composerBox = await page.getByTestId("composer-drop-zone").boundingBox();
        expect(composerBox).toBeTruthy();
        expect(composerBox!.height).toBeLessThanOrEqual(240);

        const readingThread = page.getByTestId("thread");
        await readingThread.evaluate((element) => {
          element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 64 }));
          const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
          const start = Math.max(0, Math.min(element.scrollTop, maxScrollTop - 80));
          element.scrollTop = start;
          element.dispatchEvent(new Event("scroll"));
          element.scrollTop = Math.min(maxScrollTop, start + 64);
          element.dispatchEvent(new Event("scroll"));
        });
        await expect(page.getByTestId("composer-form")).toHaveAttribute(
          "data-reading-collapsed",
          "true"
        );
        for (const disclosure of [
          page.getByTestId("composer-controls-disclosure"),
          page.getByTestId("composer-actions-disclosure")
        ]) {
          await expect(disclosure).toHaveAttribute("aria-hidden", "true");
          await expect(disclosure).toHaveAttribute("inert", "");
          await expect
            .poll(() =>
              disclosure.evaluate((element) => ({
                height: Math.round(element.getBoundingClientRect().height),
                opacity: getComputedStyle(element).opacity
              }))
            )
            .toEqual({ height: 0, opacity: "0" });
        }
        await expect(composer).toBeVisible();
        const collapsedComposerBox = await page.getByTestId("composer-drop-zone").boundingBox();
        expect(collapsedComposerBox).toBeTruthy();
        expect(collapsedComposerBox!.height).toBeLessThan(composerBox!.height - 40);

        await composer.click();
        await expect(page.getByTestId("composer-form")).not.toHaveAttribute(
          "data-reading-collapsed"
        );
        await expect(page.getByTestId("run-setup-sheet")).toHaveCount(0);
        await expect(composer).toBeFocused();
        await expect(summary).toBeVisible();
        await expect(compactProfiles).toBeVisible();
        await composer.evaluate((element) => element.blur());

        await readingThread.evaluate((element) => {
          element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -64 }));
          const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
          const start = Math.min(maxScrollTop, Math.max(80, element.scrollTop));
          element.scrollTop = start;
          element.dispatchEvent(new Event("scroll"));
          element.scrollTop = Math.max(0, start - 64);
          element.dispatchEvent(new Event("scroll"));
        });
        await expect(page.getByTestId("composer-form")).toHaveAttribute(
          "data-reading-collapsed",
          "true"
        );
        await composer.click();
        await expect(page.getByTestId("run-setup-sheet")).toHaveCount(0);
        await composer.evaluate((element) => element.blur());
      } else {
        await expect(messageLabel).toBeVisible();
        await expect(page.getByTestId("composer-compact-run-profiles")).toBeHidden();
        await expect(page.getByTestId("current-context-length")).toBeVisible();
        for (const name of ["Select model", "Search strategy", "Run settings"]) {
          const action = page.getByRole("button", { name });
          await expectTouchSafe(action);
          await expectWithinViewport(page, action);
        }
      }
      await expectTouchSafe(page.getByRole("button", { name: "Send message" }));
      await expectWithinViewport(page, page.getByRole("button", { name: "Send message" }));
      await expectTouchSafe(page.getByLabel("Attach file").locator(".."));
      const footer = page.getByTestId("composer-action-footer");
      await expect(footer).toContainText(/\d/);
      const [footerBox, attachBox, sendBox] = await Promise.all([
        footer.boundingBox(),
        page.getByLabel("Attach file").locator("..").boundingBox(),
        page.getByRole("button", { name: "Send message" }).boundingBox()
      ]);
      expect(footerBox).toBeTruthy();
      expect(attachBox).toBeTruthy();
      expect(sendBox).toBeTruthy();
      const footerCenter = footerBox!.y + footerBox!.height / 2;
      expect(Math.abs(attachBox!.y + attachBox!.height / 2 - footerCenter)).toBeLessThanOrEqual(2);
      expect(Math.abs(sendBox!.y + sendBox!.height / 2 - footerCenter)).toBeLessThanOrEqual(2);
      await expectWithinViewport(page, composer);

      const lastAssistant = page.locator('article[data-role="assistant"]').last();
      await lastAssistant.scrollIntoViewIfNeeded();
      const touchActions = lastAssistant.getByRole("toolbar", { name: "Assistant message actions" });
      await expect.poll(() => touchActions.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
      for (const action of await touchActions.getByRole("button").all()) {
        await expectTouchSafe(action);
        await expectWithinViewport(page, action);
      }

      const searchSummary = page.getByTestId("thread-search-summary");
      const citations = page.getByTestId("thread-citations-block");
      const reasoning = page.getByTestId("thread-reasoning-block");
      await searchSummary.getByRole("button").click();
      await citations.getByRole("button").click();
      await reasoning.getByRole("button").click();
      await expect(searchSummary).toContainText("request-segment");
      await expect(citations).toContainText("Responsive evidence source");
      await expect(reasoning).toContainText("Responsive reasoning");
      for (const disclosure of [searchSummary, citations, reasoning]) {
        await expectTouchSafe(disclosure.getByRole("button"));
      }
      const codeScroll = page.getByTestId("markdown-code-scroll");
      const tableScroll = page.getByTestId("markdown-table-scroll");
      const mathScroll = page.getByRole("region", { name: "Scrollable mathematical formula" });
      await expect(mathScroll.locator(".katex")).toBeVisible();
      await expect.poll(() => mathScroll.evaluate((element) => getComputedStyle(element).overflowX)).toBe("auto");
      await mathScroll.focus();
      await expect(mathScroll).toBeFocused();
      await expect.poll(() => codeScroll.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
      await expect(codeScroll).toHaveAttribute("role", "region");
      await expect(codeScroll).toHaveAttribute("aria-label", "Scrollable code block");
      await codeScroll.focus();
      await expect(codeScroll).toBeFocused();
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("ArrowRight");
      await expect.poll(() => codeScroll.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
      await expect
        .poll(() => tableScroll.evaluate((element) => getComputedStyle(element).overflowX))
        .toBe("auto");
      await expect
        .poll(() => tableScroll.evaluate((element) => element.scrollWidth > element.clientWidth))
        .toBe(true);
      await expect(tableScroll).toHaveAttribute("role", "region");
      await expect(tableScroll).toHaveAttribute("aria-label", "Scrollable table");
      await tableScroll.focus();
      await expect(tableScroll).toBeFocused();
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("ArrowRight");
      await expect.poll(() => tableScroll.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
      await expectNoHorizontalOverflow(page);

      const thread = page.getByTestId("thread");
      await thread.evaluate((element) => {
        element.scrollTop = 0;
        element.dispatchEvent(new Event("scroll"));
      });
      const latest = page.getByTestId("jump-to-latest");
      await expect(latest).toBeVisible();
      await expectTouchSafe(latest);
      await expectWithinViewport(page, latest);
      await latest.click();
      await expectThreadTextInViewport(page, "Responsive latest bottom marker");

      const compactRunSetup = compactComposer ? await openRunSetup(page) : null;
      const runControlSurface = compactRunSetup ?? composerRestingControls(page);
      if (compactRunSetup) {
        await expectWithinViewport(page, compactRunSetup);
        await expect(compactRunSetup.getByTestId("composer-run-profiles")).toBeVisible();
        await expect(compactRunSetup.getByText("Advanced settings")).toBeVisible();
        await expect(compactRunSetup.getByLabel("Temperature")).toBeVisible();
      }

      const modelTrigger = runControlSurface.getByRole("button", { name: "Select model" });
      await modelTrigger.click();
      const modelPicker = page.getByTestId("model-picker");
      await expectWithinViewport(page, modelPicker);
      await expect(modelPicker.getByLabel("Search models")).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(modelTrigger).toBeFocused();
      if (compactRunSetup) {
        await expect(compactRunSetup).toBeVisible();
      }

      const searchTrigger = runControlSurface.getByRole("button", { name: "Search strategy" });
      await searchTrigger.click();
      const searchPicker = page.getByTestId("search-select-options");
      await expectWithinViewport(page, searchPicker);
      await page.keyboard.press("Escape");
      await expect(searchTrigger).toBeFocused();

      if (compactRunSetup) {
        await expect(compactRunSetup.getByRole("button", { name: "Prompt preset" })).toBeVisible();
      } else {
        const runSettings = await openRunSettings(page);
        await expectWithinViewport(page, runSettings);
        await expect(runSettings.getByRole("button", { name: "Prompt preset" })).toBeVisible();
        await expectWithinViewport(page, runSettings.getByRole("button", { name: "Close run settings" }));
        await expect(runSettings.getByRole("button", { name: "Reasoning effort" })).toHaveCount(0);
        await closeRunSettings(page);
      }
      const reasoningTrigger = runControlSurface.getByRole("button", { name: "Reasoning effort" });
      await reasoningTrigger.click();
      const reasoningPicker = runControlSurface.getByTestId("composer-reasoning-effort-options");
      await expectWithinViewport(page, reasoningPicker);
      const lastReasoningOption = reasoningPicker.locator("[data-option-value]").last();
      await page.keyboard.press("End");
      await expect(lastReasoningOption).toBeFocused();
      await expect(lastReasoningOption).toBeInViewport();
      const [pickerBox, optionBox] = await Promise.all([reasoningPicker.boundingBox(), lastReasoningOption.boundingBox()]);
      expect(pickerBox).toBeTruthy();
      expect(optionBox).toBeTruthy();
      expect(optionBox!.y).toBeGreaterThanOrEqual(pickerBox!.y);
      expect(optionBox!.y + optionBox!.height).toBeLessThanOrEqual(pickerBox!.y + pickerBox!.height + 1);
      await page.keyboard.press("Escape");
      await expect(reasoningTrigger).toBeFocused();
      if (compactRunSetup) {
        await closeRunSetup(page);
        await expect(composerRunSummary(page)).toBeFocused();
      }

      const workspaceTrigger = page.getByRole("button", { name: "Open workspace" });
      await workspaceTrigger.click();
      const workspace = page.getByTestId("workspace-pane-mobile");
      await expectWithinViewport(page, workspace);
      await page.keyboard.press("Control+K");
      await expect(page.getByRole("dialog", { name: "Command palette" })).toHaveCount(0);
      await expect(workspace).toBeVisible();
      const chatActions = workspace.getByRole("button", { name: `Chat actions ${title}` });
      await expectTouchSafe(chatActions);
      await chatActions.click();
      const chatMenu = workspace.getByRole("dialog", { name: `Actions for ${title}` });
      await expectWithinViewport(page, chatMenu);
      await page.keyboard.press("Escape");
      await workspace.getByRole("button", { name: "Close workspace" }).click();
      await expect(workspaceTrigger).toBeFocused();

      const detailsTrigger = page.getByRole("button", { name: "Open details" });
      await detailsTrigger.click();
      const details = page.getByTestId("details-pane");
      await expectWithinViewport(page, details);
      for (const name of ["Branch", "Events"]) {
        await expectTouchSafe(details.getByRole("tab", { name }));
      }
      await expect(details.getByRole("tab", { name: "API params" })).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(detailsTrigger).toBeFocused();

      await accountTrigger.click();
      await page.getByRole("menu", { name: "Account" }).getByRole("menuitem", { name: "Settings" }).click();
      const settings = page.getByTestId("settings-dialog");
      await expectWithinViewport(page, settings);
      await settings.getByRole("button", { name: "Close settings" }).click();
      await expect(accountTrigger).toBeFocused();

      await page.getByLabel("Attach file").setInputFiles([
        { buffer: Buffer.from("Responsive notes"), mimeType: "text/markdown", name: uploadNames[0] },
        {
          buffer: Buffer.from("state,treatment\nlandscape,contained"),
          mimeType: "text/csv",
          name: uploadNames[1]
        },
        { buffer: Buffer.from('{"responsive":true}'), mimeType: "application/json", name: uploadNames[2] }
      ]);
      const chips = page.getByTestId("attachment-chip");
      await expect(chips).toHaveCount(3);
      const chipList = page.getByTestId("attachment-chip-list");
      expect(await chipList.evaluate((element) => element.clientHeight)).toBeLessThanOrEqual(112);
      for (const remove of await page.getByRole("button", { name: /^Remove responsive-/ }).all()) {
        await expectTouchSafe(remove);
      }
      await page.getByRole("button", { name: "Edit message" }).first().click();
      await expect(page.getByTestId("edit-branch-strip")).toBeVisible();
      await expectTouchSafe(page.getByRole("button", { name: "Cancel edit" }));
      await expectWithinViewport(page, page.getByRole("button", { name: "Send message" }));
      await page.getByRole("button", { name: "Cancel edit" }).click();
      const removeButtons = page.getByRole("button", { name: /^Remove responsive-/ });
      while ((await removeButtons.count()) > 0) {
        await removeButtons.first().click();
      }
      await expect(chips).toHaveCount(0);

      await composer.fill("Keyboard-safe responsive draft");
      await composer.focus();
      await page.setViewportSize({ height: viewport.keyboardHeight, width: viewport.width });
      await expect
        .poll(() =>
          page.evaluate(() => ({
            innerHeight: window.innerHeight,
            visualHeight: Math.round(window.visualViewport?.height ?? window.innerHeight)
          }))
        )
        .toEqual({ innerHeight: viewport.keyboardHeight, visualHeight: viewport.keyboardHeight });
      const shellBox = await page.getByTestId("app-shell").boundingBox();
      expect(shellBox).toBeTruthy();
      expect(Math.abs(shellBox!.height - viewport.keyboardHeight)).toBeLessThanOrEqual(1);
      await expectWithinViewport(page, composer);
      await expectWithinViewport(page, page.getByRole("button", { name: "Send message" }));
      await expectCenterUnobscured(composer);
      await expectCenterUnobscured(page.getByRole("button", { name: "Send message" }));
      await expect
        .poll(() =>
          page.evaluate(() => {
            const threadElement = document.querySelector('[data-testid="thread"]');
            const composerForm = document.querySelector('[data-testid="composer-form"]');
            if (!(threadElement instanceof HTMLElement) || !(composerForm instanceof HTMLElement)) {
              return false;
            }
            return threadElement.getBoundingClientRect().bottom <= composerForm.getBoundingClientRect().top + 1;
          })
        )
        .toBe(true);

      await page.setViewportSize({ height: viewport.height, width: viewport.width });
      await composer.fill("Stream after responsive viewport restoration");
      await composer.press("Enter");
      await waitForResponsiveTouchRequest(page, 1);
      await emitResponsiveTouchEvent(page, "run_start", {
        runId: `responsive-run-${viewport.label}`,
        status: "streaming"
      });
      await emitResponsiveTouchEvent(page, "message_start", {
        assistantMessageId: `responsive-live-assistant-${viewport.label}`,
        userMessageId: `responsive-live-user-${viewport.label}`
      });
      await emitResponsiveTouchEvent(page, "token", { delta: "Responsive live answer" });
      const livePipeline = page.getByTestId("pipeline-indicator");
      await expect(livePipeline).toBeVisible();
      await expectTouchSafe(livePipeline);
      await expectWithinViewport(page, livePipeline);
      await expectNoHorizontalOverflow(page);
      const stop = page.getByRole("button", { name: "Stop response" });
      await expect(stop).toBeEnabled();
      await expectTouchSafe(stop);
      await expectWithinViewport(page, stop);
      if (compactComposer) {
        await page.getByTestId("thread").evaluate((element) => {
          element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 64 }));
          const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
          const start = Math.max(0, Math.min(element.scrollTop, maxScrollTop - 80));
          element.scrollTop = start;
          element.dispatchEvent(new Event("scroll"));
          element.scrollTop = Math.min(maxScrollTop, start + 64);
          element.dispatchEvent(new Event("scroll"));
        });
        await expect(page.getByTestId("composer-form")).toHaveAttribute(
          "data-reading-collapsed",
          "true"
        );
        const readingStop = page.getByTestId("composer-reading-stop");
        await expect(readingStop).toBeVisible();
        await expect(readingStop).toHaveAccessibleName("Stop response");
        await expectTouchSafe(readingStop);
        await readingStop.focus();
        await expect(readingStop).toBeFocused();
        await expect(page.getByTestId("composer-form")).toHaveAttribute(
          "data-reading-collapsed",
          "true"
        );
      }
      await emitResponsiveTouchEvent(page, "done", { status: "cancelled" });
      await closeResponsiveTouchStream(page);
      if (compactComposer) {
        await expect(page.getByTestId("composer-form")).toHaveAttribute(
          "data-reading-collapsed",
          "true"
        );
        await expect(page.getByRole("button", { name: "Send message" })).toBeHidden();
        await composer.click();
      }
      await expect(page.getByRole("button", { name: "Send message" })).toBeVisible();
      await expectNoHorizontalOverflow(page);

      await page.getByTestId("mobile-new-chat-button").click();
      await expect(page.getByTestId("current-chat-title")).toHaveText("New chat");
      await expect(composer).toHaveValue("");
      expect(createChatRequests).toBe(0);
      await expectNoHorizontalOverflow(page);

      const denialPrisma = new PrismaClient();
      const denialId = randomUUID();
      const denialEmail = `responsive-denied-${denialId}@example.com`;
      const denialPassword = `responsive-password-${denialId}`;
      let denialUserId: string | null = null;
      let denialContext: BrowserContext | null = null;
      try {
        const deniedUser = await denialPrisma.user.create({
          data: {
            authIdentities: {
              create: {
                emailVerifiedAt: new Date("2026-07-11T00:00:00.000Z"),
                normalizedEmail: denialEmail,
                passwordHash: await hashPassword(denialPassword),
                provider: "password",
                providerAccountId: denialEmail
              }
            },
            displayName: `Responsive denied ${viewport.label}`,
            email: denialEmail,
            status: "active"
          }
        });
        denialUserId = deniedUser.id;
        denialContext = await browser.newContext({
          baseURL,
          colorScheme: "dark",
          hasTouch: true,
          isMobile: true,
          reducedMotion: "reduce",
          viewport: { height: viewport.height, width: viewport.width }
        });
        const denialPage = await denialContext.newPage();
        await denialPage.goto("/login");
        await denialPage.getByLabel("Email").fill(denialEmail);
        await denialPage.getByLabel("Password", { exact: true }).fill(denialPassword);
        await denialPage.getByRole("button", { name: "Sign in" }).click();
        await expect(denialPage.getByTestId("app-shell")).toBeVisible();
        await expect(denialPage.getByRole("link", { name: "Open admin console" })).toHaveCount(0);
        await denialPage.goto("/admin");
        const denial = denialPage.getByTestId("admin-denied");
        await expectWithinViewport(denialPage, denial);
        const returnToWorkspace = denialPage.getByRole("link", {
          name: /Back to workspace|Return to workspace/i
        });
        await expectTouchSafe(returnToWorkspace);
        await expectWithinViewport(denialPage, returnToWorkspace);
        await returnToWorkspace.click();
        await expect(denialPage.getByTestId("app-shell")).toBeVisible();
        await expectNoHorizontalOverflow(denialPage);
      } finally {
        await denialContext?.close();
        if (denialUserId) {
          await denialPrisma.user.delete({ where: { id: denialUserId } });
        }
        await denialPrisma.$disconnect();
      }
    } finally {
      await context.close();
    }
  });
}

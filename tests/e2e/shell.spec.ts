import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { expect, test, type BrowserContext, type Locator, type Route } from "@playwright/test";
import { DEFAULT_BOOTSTRAP_USER_ID } from "../../lib/server/auth/config";
import { hashPassword } from "../../lib/server/auth/password";
import { SESSION_COOKIE_NAME } from "../../lib/server/auth/session";
import { hashToken } from "../../lib/server/auth/token";
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
  composerRunSummary,
  expectRunSummary,
  openRunSetup,
  reasoningOptionValues,
  selectModel
} from "./shell/composer";
import {
  expectComposerBeforeDetails,
  expectConversationControlsClearOfThread,
  runAccountMenuAction
} from "./shell/page";
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

async function expectTwoLineChatTitle(scope: Locator, title: string): Promise<void> {
  const activation = scope.getByRole("button", { exact: true, name: title });
  const label = activation.getByText(title, { exact: true });
  await expect(activation).toHaveAttribute("title", title);
  await expect(label).toBeVisible();

  const geometry = await label.evaluate((element) => {
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const actions = element
      .closest('[data-testid="chat-row"]')
      ?.querySelector<HTMLElement>('[data-testid="chat-row-actions"]');
    const actionsRect = actions?.getBoundingClientRect() ?? null;

    return {
      actionsLeft: actionsRect?.left ?? null,
      clientHeight: element.clientHeight,
      height: rect.height,
      lineClamp: style.webkitLineClamp,
      lineHeight: Number.parseFloat(style.lineHeight),
      overflowWrap: style.overflowWrap,
      right: rect.right,
      scrollHeight: element.scrollHeight,
      width: rect.width
    };
  });

  expect(geometry.lineClamp).toBe("2");
  expect(geometry.overflowWrap).toBe("anywhere");
  expect(geometry.height).toBeGreaterThan(geometry.lineHeight + 1);
  expect(geometry.height).toBeLessThanOrEqual(geometry.lineHeight * 2 + 1);
  expect(geometry.scrollHeight, JSON.stringify(geometry)).toBeLessThanOrEqual(
    geometry.clientHeight + 1
  );
  expect(geometry.actionsLeft).not.toBeNull();
  expect(geometry.right).toBeLessThanOrEqual(geometry.actionsLeft!);
}

test("anchors explicit mobile sends on the user turn and keeps long answers stable", async ({ page }) => {
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
        `Scroll answer ${index}${index === 18 ? " bottom marker" : ""}\n\n${"Detail line. ".repeat(8)}${index === 18 ? "\n\nPrevious answer tail marker" : ""}`,
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
  await expectThreadTextInViewport(page, "Pinned stream question");
  await expectThreadTextInViewport(page, "Previous answer tail marker");
  const liveActivity = page.getByTestId("pipeline-indicator");
  await expect(liveActivity).toHaveAttribute("data-phase", "running");
  await expect(liveActivity).toContainText("Working…");
  const threadActivity = page.getByTestId("thread-run-activity");
  const runAnnouncement = page.getByTestId("run-lifecycle-announcer");
  await expect(threadActivity).toHaveText("Working…");
  await expect(runAnnouncement).toHaveText("Working");
  await expect(liveActivity.locator("[aria-live]")).toHaveCount(0);
  await expect(threadActivity).not.toHaveAttribute("role");
  await expect(threadActivity).not.toContainText(/Question|Search|Answer waiting/i);
  await expectNoHorizontalOverflow(page);
  await expect(threadActivity).toHaveText("Searching…");
  await expect(liveActivity).toContainText("Searching…");
  await expect(runAnnouncement).toHaveText("Searching");
  await expect(assistantContentWithText(page, "Anchored answer start marker")).toBeVisible();
  await expect(threadActivity).toHaveText("Answering…");
  await expect(liveActivity).toContainText("Answering…");
  await expect(runAnnouncement).toHaveText("Answering");
  await liveActivity.click();
  const details = page.getByTestId("details-pane");
  await expect(details).toHaveAttribute("role", "dialog");
  await expect(details.getByRole("tab", { name: "Events" })).toHaveAttribute("aria-selected", "true");
  await expectThreadTextInViewport(page, "Anchored answer start marker");
  await expect
    .poll(() => page.evaluate(() => window.localStorage.getItem("aiqsa.testStreamMode.1")))
    .toBe("true");
  const eventLog = details.getByTestId("inspector-event-log");
  const searchEvent = eventLog.getByRole("listitem").filter({ hasText: "Search evidence" });
  await expect(searchEvent).toContainText("Search evidence");
  await expect(searchEvent.getByText("Search", { exact: true })).toBeVisible();
  await expect(eventLog).toContainText("stream progress e2e");
  await expect(eventLog).toContainText("Warning");
  await expect(eventLog).toContainText("Skipped malformed stream frame");
  await details.getByRole("button", { name: "Close details" }).click();
  await expect(page.getByTestId("thread-run-warnings")).toContainText("Skipped malformed stream frame");
  await expect(assistantContentWithText(page, "Anchored answer tail marker")).toBeVisible();
  await expect(runAnnouncement).toHaveText("Run complete. Message composer ready.");
  const thread = page.getByTestId("thread");
  expect(await threadTextIsInViewport(page, "Pinned stream question")).toBe(true);
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

test("bounds long-chat opening, preserves prepend position, lazy-loads branches, and refetches an evicted chat", async ({ page }) => {
  await page.setViewportSize({ height: 820, width: 1440 });
  const initialUpdatedAt = "2026-08-09T08:00:00.000Z";
  const branchUpdatedAt = "2026-08-09T08:01:00.000Z";
  const longText = (label: string, index: number) =>
    `${label} marker ${index} ${"bounded-browser-evidence ".repeat(68)}`;
  const historyMessages = Array.from({ length: 120 }, (_, index) =>
    scrollMessage(
      `long-history-${index}`,
      index % 2 === 0 ? "user" : "assistant",
      longText("Long history", index),
      index === 0 ? null : `long-history-${index - 1}`
    )
  );
  const alternateMessage = scrollMessage(
    "long-alternate",
    "assistant",
    "Lazy branch alternate answer",
    "long-history-0"
  );
  const longSummary = {
    activeLeafMessageId: "long-history-119",
    createdAt: initialUpdatedAt,
    defaultModelId: "gpt-5.5",
    defaultProvider: "openai",
    folderId: null,
    id: "chat-long-bounded",
    messageCount: 121,
    pinned: false,
    title: "Bounded long chat",
    updatedAt: initialUpdatedAt
  };
  const compactSummaries = ["B", "C", "D"].map((label, index) => ({
    ...longSummary,
    activeLeafMessageId: `cache-${label.toLowerCase()}-119`,
    id: `chat-cache-${label.toLowerCase()}`,
    messageCount: 120,
    title: `Cache chat ${label}`,
    updatedAt: `2026-08-09T08:0${index + 2}:00.000Z`
  }));
  const compactMessages = new Map(compactSummaries.map((summary) => {
    const suffix = summary.id.at(-1)!;
    const messages = Array.from({ length: 120 }, (_, index) =>
      scrollMessage(
        `cache-${suffix}-${index}`,
        index % 2 === 0 ? "user" : "assistant",
        longText(`Cache ${suffix}`, index),
        index === 0 ? null : `cache-${suffix}-${index - 1}`
      )
    );
    return [summary.id, messages] as const;
  }));
  const detail = (
    summary: typeof longSummary,
    messages: ReturnType<typeof scrollMessage>[],
    pageInfo: { beforeCursor: string | null; hasOlder: boolean }
  ) => ({
    ...summary,
    contextStats: { approximateActiveBranchInputTokens: 12_345 },
    messages,
    pageInfo: {
      activeLeafMessageId: summary.activeLeafMessageId,
      snapshotUpdatedAt: summary.updatedAt,
      ...pageInfo
    },
    usageStats: {
      activeBranchMessageCount: summary.id === longSummary.id ? 120 : summary.messageCount,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      totalTokens: 0
    }
  });

  let selectedLongLeafId = longSummary.activeLeafMessageId;
  let currentLongUpdatedAt = initialUpdatedAt;
  let longDetailReads = 0;
  let olderPageReads = 0;
  let branchGraphReads = 0;
  let checkoutBody: Record<string, unknown> | null = null;
  let initialDetailResponseBytes: number | null = null;
  const compactDetailResponseBytes = new Map<string, number>();
  const fullActiveBranchCharacters = historyMessages.reduce(
    (total, message) => total + (message.content.blocks[0]?.text?.length ?? 0),
    0
  );

  await page.addInitScript(() => {
    type MeasurementWindow = Window & {
      __aiqsaLongChatDetailStartedAt?: number;
      __aiqsaLongTasks?: Array<{ duration: number; startTime: number }>;
    };
    const measurementWindow = window as MeasurementWindow;
    window.localStorage.setItem("aiqsa.activeChatId", "chat-long-bounded");
    measurementWindow.__aiqsaLongTasks = [];
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          measurementWindow.__aiqsaLongTasks?.push({
            duration: entry.duration,
            startTime: entry.startTime
          });
        }
      }).observe({ buffered: true, type: "longtask" });
    } catch {
      // Older browser projects may not expose the Long Tasks API; Chromium evidence does.
    }
    const browserFetch = window.fetch.bind(window);
    window.fetch = async (...args: Parameters<typeof window.fetch>) => {
      const [input, init] = args;
      const request = input instanceof Request ? input : null;
      const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
      const url = request?.url ?? String(input);
      if (method === "GET" && new URL(url, window.location.href).pathname === "/api/chats/chat-long-bounded") {
        measurementWindow.__aiqsaLongChatDetailStartedAt = performance.now();
      }
      return browserFetch(...args);
    };
  });
  await installMatrixCatalogFixture(page, {
    chats: [longSummary, ...compactSummaries],
    folders: []
  });
  await page.route("**/api/chats/chat-long-bounded/messages?*", async (route) => {
    olderPageReads += 1;
    expect(new URL(route.request().url()).searchParams.get("before")).toBe("cursor-70");
    await route.fulfill({
      contentType: "application/json",
      json: {
        messages: historyMessages.slice(20, 70),
        pageInfo: {
          activeLeafMessageId: "long-history-119",
          beforeCursor: "cursor-20",
          hasOlder: true,
          snapshotUpdatedAt: initialUpdatedAt
        }
      }
    });
  });
  await page.route("**/api/chats/chat-long-bounded/branches", async (route) => {
    branchGraphReads += 1;
    await route.fulfill({
      contentType: "application/json",
      json: {
        branchGraph: {
          activeLeafMessageId: selectedLongLeafId,
          nodes: [...historyMessages, alternateMessage].map((message) => ({
            id: message.id,
            parentMessageId: message.parentMessageId,
            preview: (message.content.blocks[0]?.text ?? "").slice(0, 160),
            role: message.role,
            status: message.status
          })),
          snapshotUpdatedAt: currentLongUpdatedAt
        }
      }
    });
  });
  await page.route("**/api/chats/chat-long-bounded", async (route) => {
    if (route.request().method() === "PATCH") {
      checkoutBody = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
      selectedLongLeafId = String(checkoutBody.activeLeafMessageId ?? "");
      currentLongUpdatedAt = branchUpdatedAt;
      await route.fulfill({
        contentType: "application/json",
        json: {
          chat: {
            ...longSummary,
            activeLeafMessageId: selectedLongLeafId,
            updatedAt: currentLongUpdatedAt
          }
        }
      });
      return;
    }
    longDetailReads += 1;
    const summary = {
      ...longSummary,
      activeLeafMessageId: selectedLongLeafId,
      updatedAt: currentLongUpdatedAt
    };
    const chat = selectedLongLeafId === alternateMessage.id
      ? detail(summary, [historyMessages[0]!, alternateMessage], {
          beforeCursor: null,
          hasOlder: false
        })
      : detail(summary, historyMessages.slice(70), {
          beforeCursor: "cursor-70",
          hasOlder: true
        });
    const body = { chat };
    if (initialDetailResponseBytes === null && selectedLongLeafId === longSummary.activeLeafMessageId) {
      initialDetailResponseBytes = Buffer.byteLength(JSON.stringify(body), "utf8");
    }
    await route.fulfill({ contentType: "application/json", json: body });
  });
  for (const summary of compactSummaries) {
    await page.route(`**/api/chats/${summary.id}`, async (route) => {
      const body = {
        chat: detail(
          summary,
          [...(compactMessages.get(summary.id) ?? [])].slice(70),
          { beforeCursor: `cursor-${summary.id.at(-1)}-70`, hasOlder: true }
        )
      };
      compactDetailResponseBytes.set(
        summary.id,
        Buffer.byteLength(JSON.stringify(body), "utf8")
      );
      await route.fulfill({
        contentType: "application/json",
        json: body
      });
    });
  }

  const settlePaint = () => page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  const captureBrowserMeasurement = (explicitStartTime?: number) => page.evaluate((startTime) => {
    type MeasurementWindow = Window & {
      __aiqsaLongChatDetailStartedAt?: number;
      __aiqsaLongTasks?: Array<{ duration: number; startTime: number }>;
    };
    type PerformanceWithMemory = Performance & {
      memory?: { usedJSHeapSize: number };
    };
    const measurementWindow = window as MeasurementWindow;
    const measuredAt = performance.now();
    const startedAt = startTime ?? measurementWindow.__aiqsaLongChatDetailStartedAt ?? measuredAt;
    const longTasks = (measurementWindow.__aiqsaLongTasks ?? []).filter(
      (entry) => entry.startTime >= startedAt && entry.startTime <= measuredAt
    );
    return {
      domNodes: document.querySelectorAll("*").length,
      heapBytes: (performance as PerformanceWithMemory).memory?.usedJSHeapSize ?? null,
      longTaskCount: longTasks.length,
      longTaskDurationMs: Math.round(
        longTasks.reduce((total, entry) => total + entry.duration, 0) * 10
      ) / 10,
      timeToVisibleMs: Math.round((measuredAt - startedAt) * 10) / 10
    };
  }, explicitStartTime);

  await signIn(page);
  const thread = page.getByTestId("thread");
  const renderedMessages = thread.locator("article[data-message-id]");
  await expect(renderedMessages).toHaveCount(50);
  await expect(thread).toContainText("Long history marker 70");
  await expect(thread).not.toContainText("Long history marker 69 ");
  await expect(page.getByRole("button", { name: "Load earlier messages" })).toBeVisible();
  expect(longDetailReads).toBe(1);
  expect(branchGraphReads).toBe(0);
  await settlePaint();
  const initialMeasurement = await captureBrowserMeasurement();
  expect(fullActiveBranchCharacters).toBeGreaterThanOrEqual(192_000);
  expect(initialDetailResponseBytes).not.toBeNull();
  expect(initialDetailResponseBytes!).toBeLessThan(200_000);

  await thread.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
  });
  const priorFirstMessage = thread.locator('[data-message-id="long-history-70"]');
  const anchorOffset = async () => priorFirstMessage.evaluate((element) => {
    const container = document.querySelector<HTMLElement>('[data-testid="thread"]')!;
    return element.getBoundingClientRect().top - container.getBoundingClientRect().top;
  });
  const offsetBefore = await anchorOffset();
  await page.getByRole("button", { name: "Load earlier messages" }).click();
  await expect(renderedMessages).toHaveCount(100);
  await expect(thread).toContainText("Long history marker 20 ");
  await expect(page.getByRole("button", { name: "Load earlier messages" })).toBeVisible();
  const offsetAfter = await anchorOffset();
  expect(Math.abs(offsetAfter - offsetBefore)).toBeLessThanOrEqual(3);
  expect(olderPageReads).toBe(1);

  const chatList = page.getByTestId("left-chat-pane");
  const switchMeasurements = [];
  for (const summary of compactSummaries) {
    const switchStartedAt = await page.evaluate(() => performance.now());
    await chatList.getByRole("button", { exact: true, name: summary.title }).click();
    await expect(thread).toContainText(`Cache ${summary.id.at(-1)} marker 119`);
    await settlePaint();
    switchMeasurements.push({
      chatId: summary.id,
      ...(await captureBrowserMeasurement(switchStartedAt))
    });
  }
  const reopenStartedAt = await page.evaluate(() => performance.now());
  await chatList.getByRole("button", { exact: true, name: longSummary.title }).click();
  await expect(renderedMessages).toHaveCount(50);
  await expect(thread).toContainText("Long history marker 70");
  await expect(thread).not.toContainText("Long history marker 20 ");
  await settlePaint();
  const reopenMeasurement = await captureBrowserMeasurement(reopenStartedAt);
  expect(longDetailReads).toBe(2);

  await page.getByRole("button", { name: "Open details" }).click();
  await expect(page.getByTestId("branch-tree")).toBeVisible();
  expect(branchGraphReads).toBe(1);
  await page.getByRole("button", { name: /^Open alternate version, assistant \d+$/ }).click();
  await expect.poll(() => checkoutBody?.activeLeafMessageId).toBe(alternateMessage.id);
  await expect(thread).toContainText("Lazy branch alternate answer");
  await expect(thread).not.toContainText("Long history marker 119");
  expect(longDetailReads).toBe(3);
  console.info("long-chat-browser-measurement", JSON.stringify({
    compactDetailResponseBytes: Object.fromEntries(compactDetailResponseBytes),
    fullActiveBranchCharacters,
    initial: initialMeasurement,
    initialDetailResponseBytes,
    reopen: reopenMeasurement,
    switches: switchMeasurements
  }));
});

test("signs out from the authenticated account menu and clears the session", async ({ page }) => {
  await signIn(page);

  const accountTrigger = page.getByTestId("workspace-icon-rail").getByRole("button", { name: "Account" });
  await expect(page.getByTestId("left-chat-pane").getByTestId("workspace-account-footer")).toHaveCount(0);
  await expect(page.getByTestId("top-rail").locator('button[aria-label^="Account menu for "]')).toHaveCount(0);
  await accountTrigger.click();
  await expect(page.getByRole("menu", { name: "Account" })).toContainText("operator@aiqsa.local");
  await Promise.all([
    page.waitForURL(/\/login(?:\?|$)/),
    page.getByRole("menuitem", { name: "Sign out" }).click()
  ]);

  await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
  await page.goto("/");
  await expect(page).toHaveURL(/\/login(?:\?|$)/);
});

test("returns through login with the active draft after the session is revoked", async ({ page }) => {
  const destination = "/?reauth=417#draft";
  const draft = "Preserve this question across re-authentication";
  await signIn(page);
  await page.goto(destination);
  await expect(page.getByTestId("app-shell")).toBeVisible();

  const composer = page.getByRole("textbox", { name: "Message" });
  await composer.fill(draft);
  const sessionCookie = (await page.context().cookies()).find((cookie) => cookie.name === SESSION_COOKIE_NAME);
  expect(sessionCookie).toBeDefined();
  if (!sessionCookie) throw new Error("The signed-in browser session cookie is missing");

  const revocationPrisma = new PrismaClient();
  const sentinelTokenHash = hashToken(`reauth-sentinel-${randomUUID()}`);
  try {
    await revocationPrisma.authSession.create({
      data: {
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
        tokenHash: sentinelTokenHash,
        userId: DEFAULT_BOOTSTRAP_USER_ID
      }
    });
    await expect(
      revocationPrisma.authSession.updateMany({
        data: {
          revokedAt: new Date(),
          revokedReason: "test_session_revocation"
        },
        where: {
          revokedAt: null,
          tokenHash: hashToken(sessionCookie.value),
          userId: DEFAULT_BOOTSTRAP_USER_ID
        }
      })
    ).resolves.toEqual({ count: 1 });
    await expect(
      revocationPrisma.authSession.findUniqueOrThrow({
        select: { revokedAt: true },
        where: { tokenHash: sentinelTokenHash }
      })
    ).resolves.toEqual({ revokedAt: null });
  } finally {
    await revocationPrisma.authSession.deleteMany({ where: { tokenHash: sentinelTokenHash } });
    await revocationPrisma.$disconnect();
  }

  await Promise.all([
    page.waitForURL(/\/login\?/),
    composer.press("Enter")
  ]);
  const loginUrl = new URL(page.url());
  expect(loginUrl.searchParams.get("next")).toBe(destination);
  expect(loginUrl.searchParams.get("reason")).toBe("session_expired");
  await expect(page.getByRole("alert").filter({ hasText: "Your session ended" })).toContainText(
    "Your session ended or was revoked. Sign in again to continue."
  );

  await page.getByLabel("Email").fill("operator@aiqsa.local");
  await page.getByRole("textbox", { name: "Password" }).fill("AIQSA-local-2026!");
  await Promise.all([
    page.waitForURL((url) => `${url.pathname}${url.search}${url.hash}` === destination),
    page.getByRole("button", { name: "Sign in" }).click()
  ]);

  await expect(page.getByTestId("app-shell")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue(draft);
});

test("closes Account and restores compact navigation focus across the desktop breakpoint", async ({ page }) => {
  await page.setViewportSize({ height: 720, width: 1360 });
  await signIn(page);

  const accountTrigger = page.getByTestId("workspace-icon-rail").getByRole("button", { name: "Account" });
  await expect(accountTrigger).toHaveAccessibleName("Account");
  await accountTrigger.click();
  const paletteItem = page.getByRole("menuitem", { name: "Command palette" });
  await expect(paletteItem).toBeFocused();

  await page.setViewportSize({ height: 720, width: 800 });
  await expect(page.getByRole("menu", { name: "Account" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open workspace" })).toBeFocused();

  await page.setViewportSize({ height: 720, width: 1360 });
  await expect(page.getByRole("menu", { name: "Account" })).toHaveCount(0);
  await expect(accountTrigger).toBeFocused();
});

test("keeps one labeled top-rail Account surface while the Workspace pane hides and restores", async ({ page }) => {
  await page.setViewportSize({ height: 720, width: 1360 });
  await signIn(page);

  const rail = page.getByTestId("workspace-icon-rail");
  const railTrigger = rail.getByRole("button", { name: "Account" });
  const menu = page.getByRole("menu", { name: "Account" });
  const menuRoot = page.locator('[data-account-menu-root="true"]');

  await expect(page.getByTestId("left-chat-pane").getByTestId("workspace-account-footer")).toHaveCount(0);
  await railTrigger.click();
  await expect(menu).toBeVisible();
  await expect(menu).toHaveCount(1);
  await expect(menuRoot).toHaveAttribute("data-account-menu-anchor", "rail");
  await expect(railTrigger).toHaveAttribute("aria-controls", "account-menu");
  const [menuBox, railTriggerBox] = await Promise.all([
    menu.boundingBox(),
    railTrigger.boundingBox()
  ]);
  expect(menuBox).toBeTruthy();
  expect(railTriggerBox).toBeTruthy();
  expect(menuBox!.x).toBeGreaterThanOrEqual(railTriggerBox!.x + railTriggerBox!.width - 1);
  expect(menuBox!.y).toBeLessThanOrEqual(railTriggerBox!.y + railTriggerBox!.height + 1);
  await expectWithinViewport(page, menu);

  await page.keyboard.press("Escape");
  await expect(railTrigger).toBeFocused();
  await page.getByRole("button", { name: "Hide workspace" }).click();
  await expect(page.getByTestId("shell-workspace-grid")).toHaveAttribute(
    "data-workspace-pane-hidden",
    "true"
  );
  await expect(menu).toHaveCount(0);
  await expect(railTrigger).not.toHaveAttribute("aria-controls");
  await expect(rail.getByRole("button", { name: "Chats" })).toBeFocused();
  await rail.click({ position: { x: 70, y: 690 } });
  await expect(page.getByRole("button", { name: "Hide workspace" })).toBeFocused();
});

test("restores Settings and Assistants across direct rail, Account, and responsive origins", async ({ page }) => {
  await page.setViewportSize({ height: 760, width: 1360 });
  await signIn(page);

  const rail = page.getByTestId("workspace-icon-rail");
  const railSettings = rail.getByRole("button", { name: "Settings" });
  const railAssistants = rail.getByRole("button", { name: "Assistants" });

  await railSettings.click();
  await page.getByRole("button", { name: "Close settings" }).click();
  await expect(railSettings).toBeFocused();

  await railAssistants.click();
  await page.getByRole("button", { name: "Back to chat" }).click();
  await expect(railAssistants).toBeFocused();

  await railSettings.click();
  await page.setViewportSize({ height: 760, width: 800 });
  await page.getByRole("button", { name: "Close settings" }).click();
  const compactWorkspace = page.getByRole("button", { name: "Open workspace" });
  await expect(compactWorkspace).toBeFocused();
  await page.setViewportSize({ height: 760, width: 1360 });
  await expect(railSettings).toBeFocused();

  await railAssistants.click();
  await page.setViewportSize({ height: 760, width: 800 });
  await page.getByRole("button", { name: "Back to chat" }).click();
  await expect(compactWorkspace).toBeFocused();
  await page.setViewportSize({ height: 760, width: 1360 });
  await expect(railAssistants).toBeFocused();

  const accountSettingsOrigin = await runAccountMenuAction(page, "Settings");
  await page.getByRole("button", { name: "Close settings" }).click();
  await expect(accountSettingsOrigin).toBeFocused();
  const accountAssistantsOrigin = await runAccountMenuAction(page, "Assistants");
  await page.getByRole("button", { name: "Back to chat" }).click();
  await expect(accountAssistantsOrigin).toBeFocused();
});

test("keeps 1280 compact and persists the desktop Workspace pane preference with the rail present", async ({ page }) => {
  await page.setViewportSize({ height: 720, width: 1280 });
  await signIn(page);

  const workspaceTrigger = page.getByRole("button", { name: "Open workspace" });
  const persistentWorkspace = page.getByTestId("left-chat-pane");
  const iconRail = page.getByTestId("workspace-icon-rail");
  await expect(workspaceTrigger).toBeVisible();
  await expect(persistentWorkspace).toBeHidden();
  await expect(iconRail).toBeHidden();

  await page.setViewportSize({ height: 720, width: 1281 });
  const hideWorkspace = page.getByRole("button", { name: "Hide workspace" });
  const chats = iconRail.getByRole("button", { name: "Chats" });
  await expect(iconRail).toBeVisible();
  await expect(hideWorkspace).toBeVisible();
  await expect(workspaceTrigger).toBeHidden();
  await hideWorkspace.click();

  await expect(page.getByTestId("shell-workspace-grid")).toHaveAttribute(
    "data-workspace-pane-hidden",
    "true"
  );
  await expect(persistentWorkspace).toBeHidden();
  await expect(iconRail).toBeVisible();
  await expect(workspaceTrigger).toBeHidden();
  await expect(chats).toBeFocused();
  expect(await page.evaluate(() => window.localStorage.getItem("aiqsa.workspaceRail"))).toBe("hidden");

  await page.reload();
  await expect(page.getByTestId("app-shell")).toBeVisible();
  await expect(page.getByTestId("shell-workspace-grid")).toHaveAttribute(
    "data-workspace-pane-hidden",
    "true"
  );
  await expect(iconRail).toBeVisible();
  await expect(persistentWorkspace).toBeHidden();

  await chats.click();
  await expect(page.getByTestId("shell-workspace-grid")).not.toHaveAttribute(
    "data-workspace-pane-hidden"
  );
  await expect(hideWorkspace).toBeFocused();
  expect(await page.evaluate(() => window.localStorage.getItem("aiqsa.workspaceRail"))).toBe("visible");

  const [railBox, paneBox, conversationBox] = await Promise.all([
    iconRail.boundingBox(),
    page.getByTestId("workspace-pane-desktop").boundingBox(),
    page.getByTestId("conversation-column").boundingBox()
  ]);
  expect(railBox).toBeTruthy();
  expect(paneBox).toBeTruthy();
  expect(conversationBox).toBeTruthy();
  expect(railBox!.x).toBeGreaterThanOrEqual(0);
  expect(railBox!.width).toBeGreaterThanOrEqual(80);
  expect(paneBox!.x).toBeGreaterThanOrEqual(railBox!.x + railBox!.width - 1);
  expect(conversationBox!.x).toBeGreaterThanOrEqual(paneBox!.x + paneBox!.width - 1);
  await expectNoHorizontalOverflow(page);

  await page.evaluate(() => {
    document.documentElement.style.fontSize = "20px";
  });
  await expect.poll(async () => (await iconRail.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(60);
  for (const name of ["New chat", "Chats", "Assistants", "Knowledge", "Settings", "Account"]) {
    await expectTouchSafe(iconRail.getByRole("button", { name, exact: true }));
    await expect(iconRail.getByText(name, { exact: true })).toBeVisible();
  }
  const settingsEntry = iconRail.getByRole("button", { name: "Settings" });
  const settingsTooltipId = await settingsEntry.getAttribute("aria-describedby");
  expect(settingsTooltipId).toBeTruthy();
  const settingsTooltip = page.locator(`#${settingsTooltipId}`);
  await settingsEntry.hover();
  await expect(settingsTooltip).toBeVisible();
  await settingsEntry.focus();
  await page.keyboard.press("Escape");
  await expect(settingsTooltip).toBeHidden();
  await iconRail.getByRole("button", { name: "Chats" }).focus();
  await settingsEntry.focus();
  await expect(settingsTooltip).toBeVisible();
  await iconRail.getByRole("button", { name: "Chats" }).focus();
  await expect(settingsTooltip).toBeHidden();
  await expectNoHorizontalOverflow(page);
});

test("adapts the composer to 1280 short-height and enlarged-text content width", async ({ page }) => {
  await page.setViewportSize({ height: 600, width: 1280 });
  await installMatrixCatalogFixture(page);
  await signIn(page);
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "20px";
  });

  const composer = page.getByTestId("composer-drop-zone");
  const directReasoning = page.locator('[data-composer-direct-reasoning="true"]');
  const expectStableDirectControlGeometry = async () => {
    const directControls = page.getByTestId("composer-control-bar");
    const secondary = page.getByTestId("composer-secondary-controls");
    const [surfaceBox, secondaryBox, modelBox, searchBox, moreBox] = await Promise.all([
      composer.boundingBox(),
      secondary.boundingBox(),
      directControls.getByRole("button", { name: "Select model" }).boundingBox(),
      directControls.getByRole("button", { name: "Search strategy" }).boundingBox(),
      directControls.getByTestId("composer-run-summary").boundingBox()
    ]);
    const reasoningBox = await directReasoning.isVisible()
      ? await directControls.getByRole("button", { name: /^Reasoning / }).boundingBox()
      : null;
    if (!surfaceBox || !secondaryBox || !modelBox || !searchBox || !moreBox) {
      throw new Error("Expected the composer and every direct control to have layout boxes");
    }

    for (const box of [modelBox, reasoningBox, searchBox, moreBox].filter(
      (value): value is NonNullable<typeof value> => value !== null
    )) {
      expect(box.x).toBeGreaterThanOrEqual(surfaceBox.x - 1);
      expect(box.x + box.width).toBeLessThanOrEqual(surfaceBox.x + surfaceBox.width + 1);
    }

    const secondaryControls = [reasoningBox, searchBox, moreBox].filter(
      (value): value is NonNullable<typeof value> => value !== null
    );
    const rowCenter = secondaryControls[0]!.y + secondaryControls[0]!.height / 2;
    for (const box of secondaryControls) {
      expect(Math.abs(box.y + box.height / 2 - rowCenter)).toBeLessThanOrEqual(1.5);
    }
    expect(secondaryBox.height).toBeLessThanOrEqual(
      Math.max(...secondaryControls.map((box) => box.height)) + 2
    );
    expect(moreBox.x).toBeGreaterThan(searchBox.x);
  };
  await expect(page.getByRole("button", { name: "Open workspace" })).toBeVisible();
  await expect(page.getByTestId("left-chat-pane")).toBeHidden();
  await expect(directReasoning).toBeHidden();
  await expectStableDirectControlGeometry();
  await expectNoHorizontalOverflow(page);
  const shortComposerBox = await composer.boundingBox();
  expect(shortComposerBox).toBeTruthy();
  expect(shortComposerBox!.height).toBeLessThanOrEqual(260);

  await page.setViewportSize({ height: 800, width: 1280 });
  await expect(directReasoning).toBeVisible();
  await expectStableDirectControlGeometry();
  await expectNoHorizontalOverflow(page);

  await page.evaluate(() => {
    document.documentElement.style.fontSize = "16px";
  });
  for (const width of [1203, 1024, 768]) {
    await page.setViewportSize({ height: 800, width });
    await expectStableDirectControlGeometry();
    await expectNoHorizontalOverflow(page);
  }

  await page.setViewportSize({ height: 800, width: 640 });
  await expect(directReasoning).toBeHidden();
  await expectStableDirectControlGeometry();
  await expectNoHorizontalOverflow(page);

  await page.setViewportSize({ height: 800, width: 1440 });
  await expect(page.getByRole("button", { name: "Hide workspace" })).toBeVisible();
  await expect(directReasoning).toBeVisible();
  await expectStableDirectControlGeometry();
  await expectNoHorizontalOverflow(page);
});

test("offers first-load workspace recovery in both the conversation and mobile workspace surfaces", async ({ page }) => {
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
  await expect(workspace.getByTestId("left-workspace-unavailable")).toContainText("Chats unavailable.");
  const workspaceRetry = workspace.getByRole("button", { name: "Retry workspace" });
  await expect(workspaceRetry).toBeVisible();
  await expect(workspace.getByText("No chats yet", { exact: true })).toHaveCount(0);

  await workspaceRetry.click();
  await expect.poll(() => workspaceReads).toBe(2);
  expect(catalogReads).toBe(1);
  await expect(workspace.getByRole("button", { name: "Start new chat" })).toBeEnabled();
  await expect(workspace.getByText("No chats yet", { exact: true })).toBeVisible();
  await workspace.getByRole("button", { name: "Close workspace" }).click();
  await expect(recovery).toHaveCount(0);
  await expect(retry).toHaveCount(0);
  await expect(composer).toBeEnabled();
  await expect(directNewChat).toBeEnabled();
});

test("recovers catalog loading through the Library while Settings Appearance remains usable", async ({ page }) => {
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
  await expectRunSummary(page, { model: "Models unavailable" });

  await runAccountMenuAction(page, "Assistants");
  const library = page.getByTestId("assistant-library");
  await expect(library).toBeVisible();
  const libraryError = library.getByRole("alert");
  await expect(libraryError).toHaveText("Assistants didn’t load");
  await expect(library.getByTestId("assistant-library-grid")).toHaveCount(0);
  await expect(library.getByRole("group", { name: "Filters" })).toHaveCount(0);
  await library.getByRole("button", { name: "Retry" }).click();

  await expect(libraryError).toHaveCount(0);
  await expect(library.getByRole("group", { name: "Filters" })).toBeVisible();
  await expect(catalogState).toHaveCount(0);
  await expect.poll(() => catalogReads).toBe(2);
  await expect.poll(() => workspaceReads).toBe(2);
  await library.getByRole("button", { name: "Back to chat" }).click();
  await expect(library).toHaveCount(0);
  await expect(composer).toBeEnabled();

  await runAccountMenuAction(page, "Settings");
  const settings = page.getByTestId("settings-dialog");
  await expect(settings.getByRole("heading", { name: "Appearance" })).toBeVisible();
  await settings.getByRole("radio", { name: /^Use Graphite theme/ }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "graphite");
  await settings.getByRole("button", { name: "Close settings" }).click();
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
  await page.getByRole("button", { name: "Open workspace" }).click();
  const accountWorkspace = page.getByTestId("workspace-pane-mobile");
  const accountTrigger = accountWorkspace.getByRole("button", { name: /Account menu/ });
  await accountTrigger.click();
  await accountWorkspace.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(accountWorkspace.getByRole("menuitem", { name: "Signing out…" })).toBeDisabled();
  await accountTrigger.click();
  await expect(accountWorkspace.getByRole("menu", { name: "Account" })).toHaveCount(0);
  await accountWorkspace.getByRole("button", { name: "Close workspace" }).click();
  await expect(accountWorkspace).toHaveCount(0);
  releaseFailure();

  await expect(page.getByRole("alert").filter({ hasText: "Sign out failed" })).toContainText(
    "Open Account to retry."
  );
  const workspaceTrigger = page.getByRole("button", { name: "Open workspace" });
  await expect(page.getByTestId("workspace-account-attention")).toBeVisible();
  await expect(workspaceTrigger).toHaveAttribute(
    "aria-describedby",
    "workspace-account-attention-description"
  );
  await workspaceTrigger.click();
  await expect(page.getByTestId("account-error-cue")).toBeVisible();
  await expect(accountTrigger).toHaveAttribute("aria-describedby", "mobile-account-sign-out-error-description");
  await accountTrigger.click();
  const accountMenu = accountWorkspace.getByRole("menu", { name: "Account" });
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

test("verifies provider controls, Gemini preview, and hidden unavailable providers", async ({ page }) => {
  let settingsPatchCount = 0;
  const providerControlsChat = {
    activeLeafMessageId: "assistant-provider-controls",
    createdAt: "2026-06-10T12:00:00.000Z",
    defaultModelId: "gpt-5.5",
    defaultProvider: "openai",
    folderId: null,
    id: "chat-provider-controls",
    messageCount: 2,
    messages: [
      scrollMessage("user-provider-controls", "user", "Provider controls question", null),
      scrollMessage(
        "assistant-provider-controls",
        "assistant",
        "Provider controls answer",
        "user-provider-controls"
      )
    ],
    pinned: false,
    title: "Provider controls chat",
    updatedAt: "2026-06-10T12:00:02.000Z",
    usageStats: null
  };
  await page.addInitScript(() =>
    window.localStorage.setItem("aiqsa.activeChatId", "chat-provider-controls")
  );
  await installMatrixCatalogFixture(page, { chats: [providerControlsChat], folders: [] }, {
    onSettingsPatch: () => {
      settingsPatchCount += 1;
    }
  });
  await signIn(page);

  let runSetup = await openRunSetup(page);
  await runSetup.getByRole("button", { name: "Select model" }).click();
  await expect(page.getByTestId("model-picker").getByRole("button", { name: "Provider Fake" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await closeRunSetup(page);
  await expect(page.getByTestId("details-pane")).toHaveCount(0);
  await page.getByRole("button", { name: "Open details" }).click();
  await page.getByRole("button", { name: "Pin details" }).click();
  await expect(page.getByTestId("details-pane")).toHaveAttribute("data-presentation", "pinned");
  await expect(page.getByTestId("details-pane").getByRole("tab", { name: "Branch" })).toHaveAttribute(
    "aria-selected",
    "true"
  );

  await selectModel(page, "openai", "gpt-5.5");
  runSetup = await openRunSetup(page);
  await expect(runSetup.getByLabel("Background mode")).toBeVisible();
  await expect(runSetup.getByRole("button", { name: "Stream response" })).toHaveAttribute(
    "aria-pressed",
    "false"
  );
  await expect(runSetup.getByLabel("Max output tokens")).toHaveValue("128000");
  await expect(runSetup.getByLabel("Temperature")).toHaveValue("1");
  await expect(runSetup.getByLabel("Temperature")).toBeEnabled();
  await runSetup.getByLabel("Temperature").fill("");
  settingsPatchCount = 0;
  await runSetup.getByLabel("Temperature").pressSequentially("0.75");
  await expect.poll(() => settingsPatchCount, { timeout: 1200 }).toBe(1);
  expect(await reasoningOptionValues(page)).toEqual(["none", "minimal", "low", "medium", "high", "xhigh"]);
  expect(await reasoningOptionValues(page)).not.toContain("max");

  await selectModel(page, "anthropic", "claude-opus-4-8");
  runSetup = await openRunSetup(page);
  await expect(runSetup.getByLabel("Background mode")).toHaveCount(0);
  await expect(runSetup.getByRole("button", { name: "Stream response" })).toHaveCount(0);
  await expect(runSetup.getByLabel("Temperature")).toBeDisabled();
  expect(await reasoningOptionValues(page)).toEqual(["low", "medium", "high", "xhigh", "max"]);

  await selectModel(page, "openrouter", "anthropic/claude-opus-4.8");
  await expectRunSummary(page, { model: "Claude Opus 4.8" });
  runSetup = await openRunSetup(page);
  await expect(runSetup.getByRole("button", { name: "Select model" })).toHaveAttribute(
    "title",
    "OpenRouter / Claude Opus 4.8"
  );
  await expect(runSetup.getByRole("button", { name: "Select model" })).not.toContainText("via OpenRouter");
  const answerSetup = runSetup.getByTestId("run-answer-setup-controls");
  const modelIdentityParts = answerSetup.getByRole("button", { name: "Select model" }).locator(".truncate");
  const reasoningValue = answerSetup.locator("#composer-reasoning-effort-current-value");
  await expect(modelIdentityParts).toHaveCount(2);
  await expect
    .poll(() => modelIdentityParts.evaluateAll((parts) => parts.every((part) => part.scrollWidth <= part.clientWidth)))
    .toBe(true);
  await expect
    .poll(() => reasoningValue.evaluate((value) => value.scrollWidth <= value.clientWidth))
    .toBe(true);
  await expect(runSetup.getByLabel("Background mode")).toHaveCount(0);
  await expect(runSetup.getByRole("button", { name: "Stream response" })).toHaveAttribute("aria-pressed", "true");
  await expect(runSetup.getByLabel("Temperature")).toBeDisabled();
  expect(await reasoningOptionValues(page)).toEqual(["low", "medium", "high", "xhigh", "max"]);

  await selectModel(page, "openrouter", "google/gemini-3.5-flash");
  runSetup = await openRunSetup(page);
  await expect(runSetup.getByLabel("Background mode")).toHaveCount(0);
  await expect(runSetup.getByLabel("Max output tokens")).toHaveValue("65536");
  await expect(runSetup.getByLabel("Temperature")).toHaveValue("1");
  await expect(runSetup.getByLabel("Temperature")).toBeEnabled();
  expect(await reasoningOptionValues(page)).toEqual(["none", "minimal", "low", "medium", "high"]);
  expect(await reasoningOptionValues(page)).not.toContain("xhigh");
  expect(await reasoningOptionValues(page)).not.toContain("max");
  await expectRunSummary(page, { reasoning: "Standard · Medium" });

  await selectModel(page, "openrouter", "~google/gemini-pro-latest");
  await expectRunSummary(page, { model: "Gemini Pro Latest" });

  runSetup = await openRunSetup(page);
  await runSetup.getByRole("button", { name: "Select model" }).click();
  const modelPicker = page.getByTestId("model-picker");
  const anthropicProviderHeader = modelPicker.locator("header").filter({
    has: page.getByRole("heading", { name: "Anthropic" })
  });
  const openRouterProviderHeader = modelPicker.locator("header").filter({
    has: page.getByRole("heading", { name: "OpenRouter" })
  });
  await expect(anthropicProviderHeader).toBeVisible();
  await expect(openRouterProviderHeader).toBeVisible();
  await expect(anthropicProviderHeader.getByText("Provider", { exact: true })).toBeVisible();
  await expect(openRouterProviderHeader.getByText("Provider", { exact: true })).toBeVisible();
  await expect(modelPicker.getByRole("button", { name: /Provider / })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await closeRunSetup(page);
  await expectRunSummary(page, { model: "Gemini Pro Latest" });
});

test("disambiguates identical provider connections in the desktop and compact model picker", async ({ page }) => {
  const sourceModel = matrixCatalog.models.find((model) => model.modelId === "gpt-5.6-sol");
  const uniqueModel = matrixCatalog.models.find((model) => model.modelId === "claude-opus-4-8");
  if (!sourceModel || !uniqueModel) {
    throw new Error("The model-picker identity fixture requires its source models");
  }

  const firstConnectionId = "provider-connection-alpha-7f31";
  const secondConnectionId = "provider-connection-beta-9c42";
  const collisionCatalog: typeof matrixCatalog = {
    ...matrixCatalog,
    defaults: {
      ...matrixCatalog.defaults,
      modelId: sourceModel.modelId,
      personalModelDefault: { modelId: sourceModel.modelId, provider: firstConnectionId },
      provider: firstConnectionId
    },
    models: [
      { ...sourceModel, provider: firstConnectionId, providerFamily: "openai" },
      { ...sourceModel, provider: secondConnectionId, providerFamily: "openai" },
      uniqueModel
    ],
    providers: [
      {
        family: "openai",
        id: firstConnectionId,
        models: [sourceModel.modelId],
        name: "OpenAI"
      },
      {
        family: "openai",
        id: secondConnectionId,
        models: [sourceModel.modelId],
        name: "OpenAI"
      },
      {
        family: "anthropic",
        id: "anthropic",
        models: [uniqueModel.modelId],
        name: "Anthropic"
      }
    ]
  };

  await page.setViewportSize({ height: 820, width: 1440 });
  await installMatrixCatalogFixture(page, undefined, { catalog: collisionCatalog });
  await signIn(page);

  const runSetup = await openRunSetup(page);
  const modelTrigger = runSetup.getByRole("button", { name: "Select model" });
  await modelTrigger.click();
  let modelPicker = page.getByTestId("model-picker");
  const firstRowSelector = `[data-model-picker-row="${firstConnectionId}:${sourceModel.modelId}"]`;
  const secondRowSelector = `[data-model-picker-row="${secondConnectionId}:${sourceModel.modelId}"]`;
  const providerLabelFor = async (rowSelector: string) => {
    const section = modelPicker.locator("section").filter({ has: page.locator(rowSelector) });
    await expect(section).toHaveCount(1);
    return (await section.getByRole("heading", { level: 3 }).innerText()).trim();
  };
  const firstLabel = await providerLabelFor(firstRowSelector);
  const secondLabel = await providerLabelFor(secondRowSelector);
  expect(firstLabel).toMatch(/^OpenAI · ref [A-Z0-9]{6,}$/);
  expect(secondLabel).toMatch(/^OpenAI · ref [A-Z0-9]{6,}$/);
  expect(firstLabel).not.toBe(secondLabel);
  await expect(modelPicker.getByRole("heading", { exact: true, name: "Anthropic" })).toBeVisible();
  await expect(modelPicker.getByText(/Anthropic · ref/)).toHaveCount(0);

  const firstActionName = `Select model ${firstLabel} ${sourceModel.displayName}`;
  const secondActionName = `Select model ${secondLabel} ${sourceModel.displayName}`;
  const firstAction = modelPicker.locator(firstRowSelector).getByRole("button", { name: firstActionName });
  const secondAction = modelPicker.locator(secondRowSelector).getByRole("button", { name: secondActionName });
  await expect(firstAction).toBeVisible();
  await expect(secondAction).toBeVisible();
  await secondAction.click();
  await expect(modelTrigger).toHaveAttribute("title", `${secondLabel} / ${sourceModel.displayName}`);
  await expect(modelTrigger.locator(".truncate").first()).toHaveText(secondLabel);

  await page.setViewportSize({ height: 844, width: 390 });
  await modelTrigger.click();
  modelPicker = page.getByTestId("model-picker");
  await expectWithinViewport(page, modelPicker);
  await expectTouchSafe(modelPicker.locator(firstRowSelector).getByRole("button", { name: firstActionName }));
  await expectTouchSafe(modelPicker.locator(secondRowSelector).getByRole("button", { name: secondActionName }));
  await expect(modelPicker.getByRole("heading", { exact: true, name: firstLabel })).toBeVisible();
  await expect(modelPicker.getByRole("heading", { exact: true, name: secondLabel })).toBeVisible();
  await expect(modelPicker).not.toContainText(firstConnectionId);
  await expect(modelPicker).not.toContainText(secondConnectionId);
  const compactFirstAction = modelPicker.locator(firstRowSelector).getByRole("button", {
    name: firstActionName
  });
  await compactFirstAction.focus();
  await expect(compactFirstAction).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(modelTrigger).toHaveAttribute("title", `${firstLabel} / ${sourceModel.displayName}`);
  await expect(modelTrigger.locator(".truncate").first()).toHaveText(firstLabel);
  await expectNoHorizontalOverflow(page);
});

test("keeps searchable pickers and command palette keyboard-safe in the narrow sheet layout", async ({ page }) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await installMatrixCatalogFixture(page);
  await signIn(page);

  const runSummary = composerRunSummary(page);
  await expect(runSummary).toBeVisible();
  await expectRunSummary(page, {
    model: "GPT-5.5",
    reasoning: "Standard · Medium",
    search: "Off"
  });
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
  await expect(page.getByTestId("model-picker-backdrop")).toBeVisible();
  await expect(modelPicker.getByRole("button", { name: "Back to Run setup" })).toBeVisible();
  await expect(modelPicker.getByRole("button", { name: "Close model picker" })).toHaveCount(0);
  const providerHeaders = modelPicker.locator("header");
  await expect(providerHeaders.first().getByText("Provider", { exact: true })).toBeVisible();
  await expect(providerHeaders.first()).toHaveClass(/bg-control-surface/);
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

test("keeps a tall wide-screen Run setup inside the viewport with one local scroll owner", async ({ page }) => {
  await page.setViewportSize({ height: 800, width: 1_600 });
  await installMatrixCatalogFixture(page);
  await signIn(page);
  await page.evaluate(() => document.documentElement.removeAttribute("data-motion"));

  const runSetup = await openRunSetup(page);
  const content = runSetup.getByTestId("run-setup-content");
  await expectWithinViewport(page, runSetup);
  await expect.poll(() => content.evaluate((element) => ({
    clientHeight: element.clientHeight,
    maxHeight: getComputedStyle(element.parentElement!).maxHeight,
    scrollHeight: element.scrollHeight
  }))).toMatchObject({
    maxHeight: expect.not.stringMatching(/^none$/u)
  });
  const sizes = await content.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight
  }));
  expect(sizes.scrollHeight).toBeGreaterThan(sizes.clientHeight);

  await content.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect(runSetup.getByRole("heading", { name: "Display preferences" })).toBeInViewport();
  await expectWithinViewport(page, runSetup);
  await closeRunSetup(page);
});

test("keeps the standalone Library and Settings Appearance safe in the narrow sheet layout", async ({ page }) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await installMatrixCatalogFixture(page);
  await page.route("**/api/me/assistants", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }

    await route.fulfill({
      contentType: "application/json",
      json: { assistants: [], publishableGroups: [], viewer: { canPublishInstallation: false } }
    });
  });

  await signIn(page);
  const accountTrigger = await runAccountMenuAction(page, "Settings");
  let settingsDialog = page.getByTestId("settings-dialog");
  await expect(settingsDialog).toHaveAttribute("aria-label", "Settings");
  await expect(settingsDialog.getByRole("heading", { name: "Appearance" })).toBeVisible();
  await expect(settingsDialog.getByRole("button", { name: "MCP & tools" })).toBeVisible();
  await expectWithinViewport(page, settingsDialog);
  await expectNoHorizontalOverflow(page);
  await settingsDialog.getByRole("button", { name: "Close settings" }).click();

  await runAccountMenuAction(page, "Assistants");
  const library = page.getByTestId("assistant-library");
  await expect(library).toHaveAttribute("aria-label", "Assistants");
  await expect(library.getByRole("heading", { name: "Assistants" })).toBeVisible();
  await expect(library.getByRole("tab", { name: "Discover" })).toHaveAttribute("aria-selected", "true");
  await expect(library.getByRole("button", { name: "Back to chat" })).toBeInViewport();
  await expect(library.getByRole("button", { name: "New assistant" })).toBeInViewport();
  await expect(library.getByLabel("Search assistants")).toBeVisible();
  await expectWithinViewport(page, library);
  await expectNoHorizontalOverflow(page);

  await library.getByRole("tab", { name: "Yours" }).click();
  await expect(library.getByRole("tab", { name: "Yours" })).toHaveAttribute("aria-selected", "true");
  await expect(library.getByText("No assistants yet", { exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);

  await library.getByRole("button", { name: "New assistant" }).click();
  const narrowEditor = library.getByTestId("assistant-editor");
  await expect(narrowEditor).toBeVisible();
  await expect(library.getByRole("tab", { name: "Discover" })).toHaveCount(0);
  await expect(narrowEditor.getByRole("button", { name: "Back to assistants" })).toBeInViewport();
  await expect(narrowEditor.getByLabel("Name", { exact: true })).toBeVisible();
  await expect(narrowEditor.getByTestId("assistant-editor-save")).toBeInViewport();
  await expectWithinViewport(page, library);
  await expectNoHorizontalOverflow(page);
  await narrowEditor.getByRole("button", { name: "Back to assistants" }).click();
  await expect(library.getByTestId("assistant-editor")).toHaveCount(0);
  await expect(library.getByRole("tab", { name: "Yours" })).toHaveAttribute("aria-selected", "true");

  await library.getByRole("button", { name: "Back to chat" }).click();
  await expect(library).toHaveCount(0);

  await runAccountMenuAction(page, "Settings");
  settingsDialog = page.getByTestId("settings-dialog");
  const aiqsaTheme = settingsDialog.getByRole("radio", { name: /^Use AIQSA theme/ });
  const graphiteTheme = settingsDialog.getByRole("radio", { name: /^Use Graphite theme/ });
  const verdantTheme = settingsDialog.getByRole("radio", { name: /^Use Verdant theme/ });
  const neutralTheme = settingsDialog.getByRole("radio", { name: /^Use Classic Light theme/ });
  const paperTheme = settingsDialog.getByRole("radio", { name: /^Use Paper theme/ });
  await expect(verdantTheme).toBeVisible();
  await expect(neutralTheme).toBeVisible();
  await expect(paperTheme).toBeVisible();
  await expect(neutralTheme).toHaveAttribute("aria-checked", "true");
  await neutralTheme.focus();
  await neutralTheme.press("Home");
  await expect(aiqsaTheme).toBeFocused();
  await expect(aiqsaTheme).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "aiqsa");
  await expect(page.locator("html")).toHaveAttribute("data-color-scheme", "dark");
  await expect
    .poll(() => page.evaluate(() => window.localStorage.getItem("aiqsa.theme")))
    .toBe("aiqsa");
  await aiqsaTheme.press("ArrowRight");
  await expect(graphiteTheme).toBeFocused();
  await expect(graphiteTheme).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "graphite");
  await expect(page.locator("html")).toHaveAttribute("data-color-scheme", "dark");
  await expect
    .poll(() => page.evaluate(() => window.localStorage.getItem("aiqsa.theme")))
    .toBe("graphite");

  await page.reload();
  await expect(page.getByTestId("app-shell")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "graphite");
  await expect(page.locator("html")).toHaveAttribute("data-color-scheme", "dark");
  await runAccountMenuAction(page, "Settings");
  settingsDialog = page.getByTestId("settings-dialog");
  await settingsDialog.getByRole("button", { name: "Appearance" }).click();
  await expect(settingsDialog.getByRole("radio", { name: /^Use Graphite theme/ })).toHaveAttribute(
    "aria-checked",
    "true"
  );
  await settingsDialog.getByRole("radio", { name: /^Use Verdant theme/ }).click();
  await expect(settingsDialog.getByRole("radio", { name: /^Use Verdant theme/ })).toHaveAttribute(
    "aria-checked",
    "true"
  );
  await expect(page.locator("html")).toHaveAttribute("data-theme", "verdant");
  await expect(page.locator("html")).toHaveAttribute("data-color-scheme", "dark");
  await expect
    .poll(() => page.evaluate(() => window.localStorage.getItem("aiqsa.theme")))
    .toBe("verdant");
  await page.reload();
  await expect(page.getByTestId("app-shell")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "verdant");
  await expect(page.locator("html")).toHaveAttribute("data-color-scheme", "dark");
  await runAccountMenuAction(page, "Settings");
  settingsDialog = page.getByTestId("settings-dialog");
  await settingsDialog.getByRole("button", { name: "Appearance" }).click();
  await expect(settingsDialog.getByRole("radio", { name: /^Use Verdant theme/ })).toHaveAttribute(
    "aria-checked",
    "true"
  );
  await settingsDialog.getByRole("radio", { name: /^Use Paper theme/ }).click();
  const reloadedPaperTheme = settingsDialog.getByRole("radio", { name: /^Use Paper theme/ });
  await expect(reloadedPaperTheme).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "paper");
  await expect(page.locator("html")).toHaveAttribute("data-color-scheme", "light");
  await expect
    .poll(() => page.evaluate(() => window.localStorage.getItem("aiqsa.theme")))
    .toBe("paper");
  await page.reload();
  await expect(page.getByTestId("app-shell")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "paper");
  await expect(page.locator("html")).toHaveAttribute("data-color-scheme", "light");
  await page.evaluate(() => window.localStorage.setItem("aiqsa.theme", "malformed-theme"));
  await page.reload();
  await expect(page.getByTestId("app-shell")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "paper");
  await expect(page.locator("html")).toHaveAttribute("data-color-scheme", "light");
  await expect
    .poll(() => page.evaluate(() => window.localStorage.getItem("aiqsa.theme")))
    .toBe("paper");
  await runAccountMenuAction(page, "Settings");
  settingsDialog = page.getByTestId("settings-dialog");
  await settingsDialog.getByRole("button", { name: "Appearance" }).click();
  await settingsDialog.getByRole("radio", { name: /^Use Paper theme/ }).press("ArrowLeft");
  const reloadedNeutralTheme = settingsDialog.getByRole("radio", { name: /^Use Classic Light theme/ });
  await expect(reloadedNeutralTheme).toBeFocused();
  await expect(reloadedNeutralTheme).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "neutral");
  await expect(page.locator("html")).toHaveAttribute("data-color-scheme", "light");
  await expect
    .poll(() => page.evaluate(() => window.localStorage.getItem("aiqsa.theme")))
    .toBe("neutral");
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
  await expect
    .poll(() => page.evaluate(() => window.localStorage.getItem("aiqsa.theme")))
    .toBe("aiqsa");
  await page.reload();
  await expect(page.getByTestId("app-shell")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "aiqsa");
  await expect(page.locator("html")).toHaveAttribute("data-color-scheme", "dark");
  await runAccountMenuAction(page, "Settings");
  settingsDialog = page.getByTestId("settings-dialog");

  await page.getByTestId("settings-backdrop").dispatchEvent("mousedown");
  await expect(settingsDialog).toHaveCount(0);
  await expect(accountTrigger).toBeFocused();
  await expectNoHorizontalOverflow(page);
});

test("uses the Library editor side column only when both width and height can support it", async ({ page }) => {
  await page.setViewportSize({ height: 512, width: 1024 });
  await installMatrixCatalogFixture(page);
  await page.route("**/api/me/assistants", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }

    await route.fulfill({
      contentType: "application/json",
      json: { assistants: [], publishableGroups: [], viewer: { canPublishInstallation: false } }
    });
  });
  await signIn(page);
  await runAccountMenuAction(page, "Assistants");

  const library = page.getByTestId("assistant-library");
  await library.getByRole("button", { name: "New assistant" }).click();
  const editor = library.getByTestId("assistant-editor");
  const identitySection = editor.locator('section[aria-labelledby="assistant-identity-heading"]');
  const runSetupGroup = editor.getByRole("button", { name: "Run setup" });
  await expect(identitySection).toBeVisible();
  await expect(runSetupGroup).toBeVisible();

  const editorColumnLayout = async () => {
    const [identityBox, runSetupBox] = await Promise.all([
      identitySection.boundingBox(),
      runSetupGroup.boundingBox()
    ]);
    if (!identityBox || !runSetupBox) {
      return "unknown";
    }
    return runSetupBox.x >= identityBox.x + identityBox.width - 1 ? "beside" : "stacked";
  };

  await expect.poll(editorColumnLayout).toBe("stacked");
  await expect(editor.getByTestId("assistant-editor-save")).toBeInViewport();
  await expectNoHorizontalOverflow(page);

  await page.setViewportSize({ height: 500, width: 1280 });
  await expect.poll(editorColumnLayout).toBe("stacked");
  await expect(editor.getByTestId("assistant-editor-save")).toBeInViewport();
  await expectNoHorizontalOverflow(page);

  await page.setViewportSize({ height: 513, width: 1024 });
  await expect.poll(editorColumnLayout).toBe("beside");
  await expect(editor.getByTestId("assistant-editor-save")).toBeInViewport();
  const libraryBox = await library.boundingBox();
  expect(libraryBox).toEqual({ height: 513, width: 1024, x: 0, y: 0 });
  await expectNoHorizontalOverflow(page);
});

test("keeps direct run choices and one complete More setup inside the thread workflow", async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1440 });
  const composerChat = {
    activeLeafMessageId: "assistant-direct-controls",
    createdAt: "2026-06-10T12:00:00.000Z",
    defaultModelId: "gpt-5.5",
    defaultProvider: "openai",
    folderId: null,
    id: "chat-direct-controls",
    messageCount: 2,
    messages: [
      scrollMessage("user-direct-controls", "user", "Direct controls question", null),
      scrollMessage(
        "assistant-direct-controls",
        "assistant",
        "Direct controls answer",
        "user-direct-controls"
      )
    ],
    pinned: false,
    title: "Direct controls chat",
    updatedAt: "2026-06-10T12:00:02.000Z",
    usageStats: null
  };

  await page.addInitScript(() =>
    window.localStorage.setItem("aiqsa.activeChatId", "chat-direct-controls")
  );
  await installMatrixCatalogFixture(page, { chats: [composerChat], folders: [] });
  await signIn(page);
  await expect(page.getByTestId("thread")).toContainText("Direct controls answer");

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
  const iconRail = page.getByTestId("workspace-icon-rail");
  const workspacePane = page.getByTestId("workspace-pane-desktop");
  const conversation = page.getByTestId("conversation-column");
  const expandedBoxes = await Promise.all([
    iconRail.boundingBox(),
    workspacePane.boundingBox(),
    conversation.boundingBox(),
    details.boundingBox()
  ]);
  expandedBoxes.forEach((box) => expect(box).toBeTruthy());
  expect(expandedBoxes[1]!.x).toBeGreaterThanOrEqual(expandedBoxes[0]!.x + expandedBoxes[0]!.width - 1);
  expect(expandedBoxes[2]!.x).toBeGreaterThanOrEqual(expandedBoxes[1]!.x + expandedBoxes[1]!.width - 1);
  expect(expandedBoxes[3]!.x).toBeGreaterThanOrEqual(expandedBoxes[2]!.x + expandedBoxes[2]!.width - 1);

  await page.getByRole("button", { name: "Hide workspace" }).click();
  await expect(page.getByTestId("shell-workspace-grid")).toHaveAttribute(
    "data-workspace-pane-hidden",
    "true"
  );
  await expect(workspacePane).toBeHidden();
  await expect(details).toHaveAttribute("data-presentation", "pinned");
  const railOnlyBoxes = await Promise.all([
    iconRail.boundingBox(),
    conversation.boundingBox(),
    details.boundingBox()
  ]);
  railOnlyBoxes.forEach((box) => expect(box).toBeTruthy());
  expect(railOnlyBoxes[1]!.x).toBeGreaterThanOrEqual(railOnlyBoxes[0]!.x + railOnlyBoxes[0]!.width - 1);
  expect(railOnlyBoxes[2]!.x).toBeGreaterThanOrEqual(railOnlyBoxes[1]!.x + railOnlyBoxes[1]!.width - 1);
  await iconRail.getByRole("button", { name: "Chats" }).click();
  await expect(page.getByRole("button", { name: "Hide workspace" })).toBeFocused();

  const runSummary = composerRunSummary(page);
  const directControls = page.getByTestId("composer-control-bar");
  await expectRunSummary(page, { model: "GPT-5.5", search: "Off" });
  await expect(directControls.getByRole("button", { name: "Select model" })).toBeVisible();
  await expect(directControls.getByRole("button", { name: "Search strategy" })).toBeVisible();
  await expect(runSummary).toContainText("More");
  await expect(runSummary).toHaveAttribute("aria-expanded", "false");
  const runSummaryBox = await runSummary.boundingBox();
  const detailedDetailsBox = await page.getByTestId("details-pane").boundingBox();
  expect(runSummaryBox).toBeTruthy();
  expect(detailedDetailsBox).toBeTruthy();
  expect(runSummaryBox!.x + runSummaryBox!.width).toBeLessThanOrEqual(detailedDetailsBox!.x + 1);

  let runSetup = await openRunSetup(page);
  await expectWithinViewport(page, runSetup);
  await expect(runSetup.getByRole("button", { name: "Select model" })).toBeVisible();
  await expect(runSetup.getByRole("button", { name: "Search strategy" })).toBeVisible();
  await expect(runSetup.getByRole("heading", { name: "Assistant" })).toBeVisible();
  await expect(runSetup.getByTestId("run-setup-use-assistant")).toHaveText("Use an assistant…");
  await expect(runSetup.getByRole("button", { name: "Reasoning effort" })).toBeVisible();
  await expect(runSetup.getByLabel("Temperature")).toBeVisible();
  await expect(runSetup.getByLabel("Max output tokens")).toBeVisible();
  await expect(runSetup.getByRole("button", { name: "Background mode" })).toBeVisible();
  await expect(runSetup.getByRole("button", { name: "Stream response" })).toBeVisible();
  await expect(runSetup.getByRole("button", { name: /^(Hide|Show) citations$/ })).toBeVisible();
  await expect(runSetup.getByRole("button", { name: /^(Hide|Show) reasoning blocks$/ })).toBeVisible();
  await expect(runSetup.getByRole("button", { name: /^(Enable|Mute) answer sound$/ })).toBeVisible();
  await closeRunSetup(page);
  await expect(runSummary).toHaveAttribute("aria-expanded", "false");

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

  runSetup = await openRunSetup(page);
  await expect(runSetup.getByLabel("Temperature")).toBeVisible();
  await expect(runSetup.getByLabel("Max output tokens")).toBeVisible();
  await expect(runSetup.getByRole("button", { name: "Open API params in Details" })).toHaveCount(0);
  await closeRunSetup(page);
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

test("keeps a global Search preference and per-model reasoning across model switches and reloads", async ({ page }) => {
  const defaults = {
    ...matrixCatalog.defaults,
    controlValues: {
      ...matrixCatalog.defaults.controlValues
    },
    organizationSearchPlan: {
      mode: "all_selected" as const,
      optionIds: ["perplexity-tool-search"]
    },
    searchPlan: {
      mode: "all_selected" as const,
      optionIds: ["perplexity-tool-search"]
    },
    searchPreferenceSource: "organization" as "organization" | "personal",
    searchStrategyId: "perplexity-tool-search"
  };
  const settingsBodies: Record<string, unknown>[] = [];

  await page.route("**/api/me/catalog", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: {
        catalog: {
          ...matrixCatalog,
          defaults,
          models: matrixCatalog.models.map((model) => model.modelId === "google/gemini-3.5-flash"
            ? { ...model, searchStrategyIds: ["search-disabled"] }
            : model)
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
    settingsBodies.push(body);
    if (typeof body.defaultProvider === "string") {
      defaults.provider = body.defaultProvider;
    }
    if (typeof body.defaultModelId === "string") {
      defaults.modelId = body.defaultModelId;
    }
    if (body.defaultSearchPlan === null) {
      defaults.searchPlan = defaults.organizationSearchPlan;
      defaults.searchPreferenceSource = "organization";
      defaults.searchStrategyId = defaults.searchPlan.optionIds[0] ?? "search-disabled";
    } else if (body.defaultSearchPlan && typeof body.defaultSearchPlan === "object") {
      defaults.searchPlan = body.defaultSearchPlan as typeof defaults.searchPlan;
      defaults.searchPreferenceSource = "personal";
      defaults.searchStrategyId = defaults.searchPlan.optionIds[0] ?? "search-disabled";
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
          defaultProvider: defaults.provider,
          defaultSearchPlan: defaults.searchPlan,
          defaultSearchStrategyId: defaults.searchStrategyId,
          organizationSearchPlan: defaults.organizationSearchPlan,
          searchPreferenceSource: defaults.searchPreferenceSource,
          showCitations: defaults.showCitations,
          showReasoningBlocks: defaults.showReasoningBlocks,
          showToolActivity: defaults.showToolActivity
        }
      }
    });
  });

  await signIn(page);

  await expectRunSummary(page, { search: "Perplexity tool" });
  await chooseSearchStrategy(page, "^Off");
  await expect.poll(() => settingsBodies.some((body) =>
    JSON.stringify(body.defaultSearchPlan) === JSON.stringify({ mode: "all_selected", optionIds: [] })
  )).toBe(true);
  await expectRunSummary(page, { search: "Off" });
  let runSetup = await openRunSetup(page);
  await runSetup.getByRole("button", { name: "Search strategy" }).click();
  await runSetup.getByRole("button", { name: "Use organization default" }).click();
  await closeRunSetup(page);
  await expect.poll(() => settingsBodies.some((body) => body.defaultSearchPlan === null)).toBe(true);
  await chooseReasoningEffort(page, "high");
  await expectRunSummary(page, { reasoning: "Standard · High", search: "Perplexity tool" });

  await selectModel(page, "openrouter", "google/gemini-3.5-flash");
  await chooseReasoningEffort(page, "minimal");
  await expectRunSummary(page, { reasoning: "Standard · Minimal", search: "Perplexity tool" });
  runSetup = await openRunSetup(page);
  await expect(runSetup.getByRole("button", { name: "Search strategy" })).toHaveAttribute(
    "title",
    "0 active · 1 unavailable"
  );
  await closeRunSetup(page);

  await selectModel(page, "openai", "gpt-5.5");
  await expectRunSummary(page, { reasoning: "Standard · High", search: "Perplexity tool" });

  await page.reload();
  await expect(page.getByTestId("app-shell")).toBeVisible();
  await expectRunSummary(page, {
    model: "GPT-5.5",
    reasoning: "Standard · High",
    search: "Perplexity tool"
  });
  runSetup = await openRunSetup(page);
  await expect(runSetup.getByRole("button", { name: "Select model" })).toHaveAttribute(
    "title",
    "OpenAI / GPT-5.5"
  );
  await closeRunSetup(page);
});

test("saves selected Search as a global personal preference", async ({ page }) => {
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
    if (body.defaultSearchPlan && typeof body.defaultSearchPlan === "object") {
      defaults.searchPlan = body.defaultSearchPlan as typeof defaults.searchPlan;
      defaults.searchPreferenceSource = "personal";
      defaults.searchStrategyId = defaults.searchPlan.optionIds[0] ?? "search-disabled";
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
          defaultProvider: defaults.provider,
          defaultSearchPlan: defaults.searchPlan,
          defaultSearchStrategyId: defaults.searchStrategyId,
          organizationSearchPlan: defaults.organizationSearchPlan,
          searchPreferenceSource: defaults.searchPreferenceSource,
          showCitations: defaults.showCitations,
          showReasoningBlocks: defaults.showReasoningBlocks,
          showToolActivity: defaults.showToolActivity
        }
      }
    });
  });

  await signIn(page);
  await expectRunSummary(page, { model: "Claude Opus 4.8" });
  await chooseSearchStrategy(page, "Perplexity tool");
  await expect.poll(() => settingsBodies.length).toBe(1);
  expect(settingsBodies[0]?.defaultSearchStrategyId).toBeUndefined();
  expect(settingsBodies[0]?.defaultSearchPlan).toEqual({
    mode: "model_choice",
    optionIds: ["perplexity-tool-search"]
  });
  expect(settingsBodies[0]?.defaultControlValues).toBeUndefined();

  await page.reload();
  await expect(page.getByTestId("app-shell")).toBeVisible({ timeout: 15_000 });
  await expectRunSummary(page, { search: "Perplexity tool" });
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
    const provider = typeof sendBody.provider === "string" ? sendBody.provider : defaults.provider;
    const modelId = typeof sendBody.modelId === "string" ? sendBody.modelId : defaults.modelId;
    const controlDefaults =
      typeof sendBody.controlDefaults === "object" && sendBody.controlDefaults !== null
        ? (sendBody.controlDefaults as Record<string, unknown>)
        : {};
    const key = `${provider}:${modelId}`;

    defaults.provider = provider;
    defaults.modelId = modelId;
    if (sendBody.searchPreferencePlan && typeof sendBody.searchPreferencePlan === "object") {
      defaults.searchPlan = sendBody.searchPreferencePlan as typeof defaults.searchPlan;
      defaults.searchPreferenceSource = sendBody.searchPreferenceSource === "organization"
        ? "organization"
        : "personal";
      defaults.searchStrategyId = defaults.searchPlan.optionIds[0] ?? "search-disabled";
    }
    defaults.controlValues = {
      ...defaults.controlValues,
      [key]: { ...controlDefaults }
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
  await expect(composerRunSummary(page)).toBeEnabled();
  await selectModel(page, "openai", "gpt-5.6-sol");
  await chooseReasoningEffort(page, "max");
  let runSetup = await openRunSetup(page);
  await runSetup.getByLabel("Reasoning mode").selectOption("pro");
  await expect(runSetup.getByRole("button", { name: "Select model" })).toHaveAttribute(
    "title",
    "OpenAI / GPT-5.6 Sol"
  );
  await expect(runSetup.getByRole("button", { name: "Reasoning effort" })).toHaveAttribute(
    "title",
    "Pro mode, Maximum effort"
  );
  await closeRunSetup(page);
  await expectRunSummary(page, {
    model: "GPT-5.6 Sol",
    reasoning: "Pro · Maximum",
    search: "Off"
  });
  const directReasoning = page.getByTestId("composer-control-bar").getByRole("button", {
    name: "Reasoning Pro · Maximum"
  });
  await expect(directReasoning).toBeVisible();
  await directReasoning.click();
  await expect(page.getByRole("dialog", { name: "Reasoning settings" })).toBeVisible();
  await page.getByRole("button", { name: "Close Reasoning settings" }).click();
  const modelValue = page.getByTestId("run-model-summary");
  const reasoningValue = page.getByTestId("run-reasoning-summary");
  for (const value of [modelValue, reasoningValue]) {
    await expect.poll(() => value.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  }
  await page.setViewportSize({ height: 390, width: 1176 });
  await expect(directReasoning).toBeHidden();
  const shortRunSetup = await openRunSetup(page);
  await expectWithinViewport(page, shortRunSetup);
  await expectWithinViewport(page, shortRunSetup.getByRole("button", { name: "Close run setup" }));
  await closeRunSetup(page);
  await page.setViewportSize({ height: 720, width: 1176 });
  await chooseSearchStrategy(page, "Perplexity tool");
  await expectRunSummary(page, { search: "Perplexity tool" });
  runSetup = await openRunSetup(page);
  await expect(runSetup.getByRole("button", { name: "Search strategy" })).toHaveAccessibleDescription(
    "Perplexity tool"
  );
  await closeRunSetup(page);
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
    reasoningMode: "pro"
  });
  expect(sentBody.controlDefaults).not.toHaveProperty("searchStrategyId");
  expect(sentBody).toMatchObject({
    searchPreferencePlan: {
      mode: "model_choice",
      optionIds: ["perplexity-tool-search"]
    },
    searchPreferenceSource: "personal"
  });

  await page.reload();
  await expect(page.getByTestId("app-shell")).toBeVisible({ timeout: 15_000 });
  await expectRunSummary(page, { search: "Perplexity tool" });
});

test.describe("stored-chat bootstrap in a divergent client zone", () => {
  // A client zone/locale far from the UTC en-US server surfaces any SSR string
  // that leaks the live clock, zone, or locale into hydrated markup (for
  // example the composer's baseline token estimate).
  test.use({ locale: "ru-RU", timezoneId: "Asia/Novosibirsk" });

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
          defaultProvider: matrixCatalog.defaults.provider,
          defaultSearchPlan: matrixCatalog.defaults.searchPlan,
          defaultSearchStrategyId: matrixCatalog.defaults.searchStrategyId,
          organizationSearchPlan: matrixCatalog.defaults.organizationSearchPlan,
          searchPreferenceSource: matrixCatalog.defaults.searchPreferenceSource,
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
  await expectRunSummary(page, { model: "Claude Opus 4.8" });
  const runSetup = await openRunSetup(page);
  await expect(runSetup.getByRole("button", { name: "Select model" })).toHaveAttribute(
    "title",
    "Anthropic / Claude Opus 4.8"
  );
  await closeRunSetup(page);
  expect(consoleErrors.filter((text) => /hydration|did not match/i.test(text))).toEqual([]);
  });
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

test("keeps chats without a persisted default model accessible", async ({ page }) => {
  const chatWithoutDefaultModel = {
    activeLeafMessageId: null,
    createdAt: "2026-06-10T13:00:00.000Z",
    defaultModelId: null,
    defaultProvider: null,
    folderId: null,
    id: "chat-without-default-model",
    messageCount: 0,
    messages: [],
    pinned: false,
    title: "Chat without a default model",
    updatedAt: "2026-06-10T13:00:02.000Z",
    usageStats: null
  };

  await page.addInitScript(() => {
    window.localStorage.setItem("aiqsa.activeChatId", "chat-without-default-model");
  });
  await installMatrixCatalogFixture(page, {
    chats: [chatWithoutDefaultModel],
    folders: []
  });
  await signIn(page);

  await expect(page.getByTestId("workspace-error-state")).toHaveCount(0);
  await expect(page.getByTestId("current-chat-title")).toHaveText(chatWithoutDefaultModel.title);
  await expect(page.getByRole("textbox", { name: "Message" })).toBeEnabled();

  const workspace = page.getByTestId("left-chat-pane");
  await expect(workspace).toContainText(chatWithoutDefaultModel.title);
  await workspace
    .getByRole("button", { name: `Chat actions ${chatWithoutDefaultModel.title}` })
    .click();
  await expect(workspace.getByRole("button", { name: "Delete chat" })).toBeVisible();
});

test("finds never-opened chats through server-side content search", async ({ page }) => {
  const hiddenContentChat = {
    activeLeafMessageId: null,
    createdAt: "2026-06-10T13:00:00.000Z",
    defaultModelId: "gpt-5.5",
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
          defaultProvider: matrixCatalog.defaults.provider,
          defaultSearchPlan: matrixCatalog.defaults.searchPlan,
          defaultSearchStrategyId: matrixCatalog.defaults.searchStrategyId,
          organizationSearchPlan: matrixCatalog.defaults.organizationSearchPlan,
          searchPreferenceSource: matrixCatalog.defaults.searchPreferenceSource,
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

  const conversationActions = page.getByRole("button", { name: "Conversation actions" });
  await conversationActions.click();
  const branchTrigger = page.getByRole("menuitem", { name: "Branch tree" });
  await branchTrigger.click();
  mobileDetails = page.getByTestId("details-pane");
  await expect(mobileDetails).toBeVisible();
  await expect(mobileDetails).toHaveAttribute("role", "dialog");
  await expect(mobileDetails.getByRole("tab", { name: "Branch" })).toHaveAttribute("aria-selected", "true");

  await page.getByTestId("details-pane-backdrop").dispatchEvent("mousedown");
  await expect(page.getByTestId("details-pane")).toHaveCount(0);
  await expect(conversationActions).toBeFocused();
  await expectNoHorizontalOverflow(page);
});

test("reveals desktop chat row actions on hover and keyboard focus without layout shift", async ({ page }) => {
  const longFolderName = `Research-${"unbroken-label-".repeat(12)}`;
  const chat = {
    activeLeafMessageId: null,
    createdAt: "2026-06-10T13:30:00.000Z",
    defaultModelId: "gpt-5.5",
    defaultProvider: "openai",
    folderId: "folder-long-workspace-label",
    id: "chat-quiet-actions",
    messageCount: 0,
    messages: [],
    pinned: false,
    title: "Quiet row actions",
    updatedAt: "2026-06-10T13:30:02.000Z"
  };
  await installMatrixCatalogFixture(page, {
    chats: [chat],
    folders: [
      {
        id: "folder-long-workspace-label",
        name: longFolderName,
        parentId: null,
        projectMemory: "",
        sortOrder: 0
      }
    ]
  });

  await signIn(page);

  const workspaceRail = page.getByTestId("workspace-pane-desktop");
  const leftChatPane = page.getByTestId("left-chat-pane");
  const newFolderButton = page.getByRole("button", { name: "New folder" });
  const [workspaceRailBox, leftChatPaneBox, newFolderButtonBox] = await Promise.all([
    workspaceRail.boundingBox(),
    leftChatPane.boundingBox(),
    newFolderButton.boundingBox()
  ]);
  expect(workspaceRailBox).toBeTruthy();
  expect(leftChatPaneBox).toBeTruthy();
  expect(newFolderButtonBox).toBeTruthy();
  expect(leftChatPaneBox!.x + leftChatPaneBox!.width).toBeLessThanOrEqual(
    workspaceRailBox!.x + workspaceRailBox!.width + 1
  );
  expect(newFolderButtonBox!.x + newFolderButtonBox!.width).toBeLessThanOrEqual(
    workspaceRailBox!.x + workspaceRailBox!.width + 1
  );
  await expectCenterUnobscured(newFolderButton);
  await newFolderButton.click();
  await expect(page.getByTestId("new-folder-form")).toBeVisible();
  await newFolderButton.click();

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
  await page.evaluate(() => document.documentElement.removeAttribute("data-motion"));
  await expect(page.getByTestId("thread")).toContainText("Original assistant answer");
  await expect(page.getByTestId("thread-complete-answer-spacer")).toBeVisible();

  const assistantArticle = page.locator('article[data-role="assistant"]').last();
  const assistantSurface = assistantArticle.locator('[data-message-interaction-surface="true"]');
  const assistantActions = assistantArticle.getByRole("toolbar", { name: "Assistant message actions" });
  const restingAssistantBackground = await assistantSurface.evaluate(
    (element) => getComputedStyle(element).backgroundColor
  );
  await expect(assistantActions).toBeHidden();
  const [assistantArticleBox, assistantSurfaceBox] = await Promise.all([
    assistantArticle.boundingBox(),
    assistantSurface.boundingBox()
  ]);
  expect(assistantArticleBox).not.toBeNull();
  expect(assistantSurfaceBox).not.toBeNull();
  const articleBox = assistantArticleBox as NonNullable<typeof assistantArticleBox>;
  const surfaceBox = assistantSurfaceBox as NonNullable<typeof assistantSurfaceBox>;
  const gutterX = surfaceBox.x - articleBox.x > 8
    ? articleBox.x + 2
    : articleBox.x + articleBox.width - 2;
  expect(gutterX < surfaceBox.x || gutterX > surfaceBox.x + surfaceBox.width).toBe(true);
  await page.mouse.move(gutterX, surfaceBox.y + surfaceBox.height / 2);
  await page.waitForTimeout(200);
  await expect(assistantActions).toBeHidden();
  expect(
    await assistantSurface.evaluate((element) => getComputedStyle(element).backgroundColor)
  ).toBe(restingAssistantBackground);

  await assistantSurface.hover();
  expect(
    await assistantSurface.evaluate((element) => getComputedStyle(element).transitionDuration)
  ).toBe("0.15s, 0.15s");
  expect(
    await assistantSurface.evaluate((element) => getComputedStyle(element).transitionTimingFunction)
  ).toBe("cubic-bezier(0.4, 0, 0.2, 1), cubic-bezier(0.4, 0, 0.2, 1)");
  expect(
    await assistantActions.evaluate((element) => getComputedStyle(element).display)
  ).toBe("flex");
  await expect(assistantActions).toBeVisible();
  await expect.poll(() =>
    assistantSurface.evaluate((element) => getComputedStyle(element).backgroundColor)
  ).not.toBe(restingAssistantBackground);
  await expect(assistantActions.getByRole("button")).toHaveCount(4);
  const assistantActionLabels = await assistantActions.locator("button").evaluateAll((buttons) =>
    buttons.map((button) => button.getAttribute("aria-label"))
  );
  await assistantSurface.click({ position: { x: 4, y: 4 } });
  await page.mouse.move(0, 0);
  await expect.poll(() =>
    assistantSurface.evaluate((element) => getComputedStyle(element).backgroundColor)
  ).toBe(restingAssistantBackground);
  await expect(assistantActions).toBeHidden();
  await assistantSurface.hover();
  await expect(assistantActions).toBeVisible();
  await assistantActions.getByRole("button", { name: "Copy message" }).click();
  await expect(page.getByTestId("shell-notice")).toContainText("Message copied");
  await expect
    .poll(() => page.evaluate(() => window.localStorage.getItem("aiqsa.testClipboard") ?? ""))
    .toBe("Original assistant answer");

  await assistantActions.getByRole("button", { name: "Edit message" }).click();
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue("Original assistant answer");
  await page.getByRole("textbox", { name: "Message" }).fill("Edited assistant answer");
  await page.getByRole("textbox", { name: "Message" }).press("Enter");
  await expect(page.getByTestId("thread")).toContainText("Edited assistant answer");
  await expect(page.getByTestId("thread")).not.toContainText("Original assistant answer");

  const userArticle = page.locator('article[data-role="user"]').first();
  const userSurface = userArticle.locator('[data-message-interaction-surface="true"]');
  const userActions = userArticle.getByRole("toolbar", { name: "User message actions" });
  await expect(userActions).toBeHidden();
  await userSurface.hover();
  await expect(userActions).toBeVisible();
  await expect.poll(() =>
    userSurface.evaluate((element) => getComputedStyle(element).backgroundColor)
  ).not.toBe("rgba(0, 0, 0, 0)");
  const userActionLabels = await userActions.locator("button").evaluateAll((buttons) =>
    buttons.map((button) => button.getAttribute("aria-label"))
  );
  expect(userActionLabels).toEqual(assistantActionLabels);
  await expect.poll(async () => {
    const [surfaceBox, actionsBox] = await Promise.all([
      userSurface.boundingBox(),
      userActions.boundingBox()
    ]);
    if (!surfaceBox || !actionsBox) return Number.POSITIVE_INFINITY;
    return Math.abs(surfaceBox.x + surfaceBox.width - 8 - (actionsBox.x + actionsBox.width));
  }).toBeLessThanOrEqual(1);
  await expect.poll(async () => {
    const [surfaceBox, actionsBox] = await Promise.all([
      userSurface.boundingBox(),
      userActions.boundingBox()
    ]);
    if (!surfaceBox || !actionsBox) return Number.POSITIVE_INFINITY;
    return Math.abs(surfaceBox.y + surfaceBox.height - (actionsBox.y + actionsBox.height / 2));
  }).toBeLessThanOrEqual(1);
  await userActions.getByRole("button", { name: "Edit message" }).click();
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
        const chunkDelays = sendCount === 1
          ? [100, 200, 300, 5_000, 5_200]
          : chunks.map((_, index) => 60 * (index + 1));

        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              chunks.forEach((chunk, index) => {
                window.setTimeout(() => {
                  controller.enqueue(encoder.encode(chunk));
                  if (index === chunks.length - 1) {
                    controller.close();
                  }
                }, chunkDelays[index]);
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

test("keeps route-aware titles and complete two-line chat names across shell viewports", async ({ page }) => {
  const englishTitle = "Comparative multi-model workspace Alpha review";
  const cyrillicTitle = "Сравнение архитектур поиска Бета итог обзор";
  const fixtureChat = (id: string, title: string, updatedAt: string) => ({
    activeLeafMessageId: null,
    createdAt: "2026-08-01T10:00:00.000Z",
    defaultModelId: "gpt-5.5",
    defaultProvider: "openai",
    folderId: null,
    id,
    messageCount: 0,
    messages: [],
    title,
    updatedAt,
    usageStats: null
  });

  await page.addInitScript((activeChatId) => {
    window.localStorage.setItem("aiqsa.activeChatId", activeChatId);
  }, "chat-title-alpha");
  await installMatrixCatalogFixture(page, {
    chats: [
      fixtureChat("chat-title-alpha", englishTitle, "2026-08-01T12:00:00.000Z"),
      fixtureChat("chat-title-beta", cyrillicTitle, "2026-08-01T11:00:00.000Z")
    ],
    contentMatches: [],
    folders: []
  });

  await page.setViewportSize({ height: 900, width: 1440 });
  await page.goto("/login");
  await expect(page).toHaveTitle("Sign in · AIQSA");
  await signIn(page);
  await expect(page).toHaveTitle(`${englishTitle} · AIQSA`);

  const desktopWorkspace = page.getByTestId("left-chat-pane");
  await expectTwoLineChatTitle(desktopWorkspace, englishTitle);
  await expectTwoLineChatTitle(desktopWorkspace, cyrillicTitle);

  await desktopWorkspace.getByRole("button", { exact: true, name: cyrillicTitle }).click();
  await expect(page).toHaveTitle(`${cyrillicTitle} · AIQSA`);

  await runAccountMenuAction(page, "Settings");
  await expect(page).toHaveTitle("Settings · AIQSA");
  await page.getByRole("button", { name: "Close settings" }).click();
  await expect(page).toHaveTitle(`${cyrillicTitle} · AIQSA`);

  await runAccountMenuAction(page, "Assistants");
  await expect(page).toHaveTitle("Assistants · AIQSA");
  await page.getByRole("button", { name: "Back to chat" }).click();
  await expect(page).toHaveTitle(`${cyrillicTitle} · AIQSA`);

  await desktopWorkspace.getByRole("button", { name: "Start new chat" }).click();
  await expect(page).toHaveTitle("New chat · AIQSA");
  await desktopWorkspace.getByRole("button", { exact: true, name: englishTitle }).click();
  await expect(page).toHaveTitle(`${englishTitle} · AIQSA`);

  for (const viewport of [
    { height: 844, width: 390 },
    { height: 390, width: 844 }
  ]) {
    await page.setViewportSize(viewport);
    await page.getByRole("button", { name: "Open workspace" }).click();
    const mobileWorkspace = page.getByTestId("workspace-pane-mobile");
    await expect(mobileWorkspace).toBeVisible();
    await expectTwoLineChatTitle(mobileWorkspace, englishTitle);
    await expectTwoLineChatTitle(mobileWorkspace, cyrillicTitle);
    await mobileWorkspace.getByRole("button", { name: "Close workspace" }).click();
    await expect(page).toHaveTitle(`${englishTitle} · AIQSA`);
  }

  await page.setViewportSize({ height: 900, width: 1440 });
  await page.goto("/admin");
  await expect(page).toHaveTitle("Providers · Control Center · AIQSA");
  await page.getByRole("tab", { name: "Search" }).click();
  await expect(page).toHaveTitle("Search · Control Center · AIQSA");
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
  await workspace.getByRole("button", { name: `Move chat ${rowTitle} to folder` }).first().click();
  await page
    .getByRole("dialog", { name: "Choose move to folder" })
    .getByText(folderName, { exact: true })
    .click();
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
  const delayedUserMessage = {
    ...oldMessage("user-a-new", "user", "Slow question A", "assistant-a-old"),
    createdAt: "2026-06-08T10:02:00.000Z"
  };
  const delayedAssistantMessage = {
    ...oldMessage("assistant-a-new", "assistant", "Answer A after switch", "user-a-new"),
    createdAt: "2026-06-08T10:02:00.000Z",
    modelRunId: "run-a-delayed"
  };
  let chatAAnswered = false;
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
    chatAAnswered = true;
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
            contextStats: { approximateActiveBranchInputTokens: 37 },
            createdAt: "2026-06-08T10:00:00.000Z",
            defaultModelId: "gpt-5.5",
            defaultProvider: "openai",
            folderId: null,
            id: "chat-a",
            messageCount: 4,
            pinned: false,
            title: "Chat A answered",
            updatedAt: "2026-06-08T10:02:00.000Z",
            usageStats: null
          },
          messages: [delayedUserMessage, delayedAssistantMessage]
        }),
        sseEvent("done", { runId: "run-a-delayed", status: "complete" })
      ].join(""),
      contentType: "text/event-stream",
      status: 200
    });
  });

  await page.addInitScript(() => window.localStorage.setItem("aiqsa.activeChatId", "chat-a"));
  await installMatrixCatalogFixture(page, workspace);
  await page.route("**/api/chats/chat-a", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    const initial = workspace.chats[0]!;
    const messages = chatAAnswered
      ? [...initial.messages, delayedUserMessage, delayedAssistantMessage]
      : initial.messages;
    const updatedAt = chatAAnswered
      ? "2026-06-08T10:02:00.000Z"
      : initial.updatedAt;
    await route.fulfill({
      contentType: "application/json",
      json: {
        chat: {
          ...initial,
          activeLeafMessageId: chatAAnswered ? delayedAssistantMessage.id : initial.activeLeafMessageId,
          contextStats: { approximateActiveBranchInputTokens: chatAAnswered ? 37 : 21 },
          messageCount: messages.length,
          messages,
          pageInfo: {
            activeLeafMessageId: chatAAnswered
              ? delayedAssistantMessage.id
              : initial.activeLeafMessageId,
            beforeCursor: null,
            hasOlder: false,
            snapshotUpdatedAt: updatedAt
          },
          pinned: false,
          title: chatAAnswered ? "Chat A answered" : initial.title,
          updatedAt,
          usageStats: null
        }
      }
    });
  });
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
  await expect(composerRunSummary(page)).toBeEnabled();
  await expect(page.getByRole("textbox", { name: "Message" })).toBeEnabled();
  await page.getByRole("textbox", { name: "Message" }).fill("Draft while A finishes");
  await expect(page.getByTestId("composer-disabled-hint")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Send message" })).toBeEnabled();
  await page.getByRole("button", { name: "Open details" }).click();
  let details = page.getByTestId("details-pane");
  await details.getByRole("tab", { name: "Events" }).click();
  await expect(details.getByTestId("details-summary")).toHaveText(
    "Review conversation branches or recorded run events."
  );
  await expect(details.getByTestId("inspector-event-log")).toContainText(
    "Run events will appear here after a response starts."
  );
  releaseSend();

  await expect(page.getByTestId("left-chat-pane")).toContainText("Chat A answered");
  await expect(page.getByTestId("composer-disabled-hint")).toHaveCount(0);
  await expect(page.getByTestId("current-chat-title")).toHaveText("Chat B steady");
  await expect(page.getByTestId("thread")).toContainText("Old B answer");
  await expect(page.getByTestId("thread")).not.toContainText("Slow question A");
  await expect(page.getByTestId("thread")).not.toContainText("Answer A after switch");
  await expect.poll(() => runFetches).toBe(1);
  await expect(details.getByTestId("details-summary")).toHaveText(
    "Review conversation branches or recorded run events."
  );
  await expect(details.getByTestId("inspector-event-log")).toContainText(
    "Run events will appear here after a response starts."
  );
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
  await expect(details.getByTestId("details-summary")).toHaveText("1 recorded event for this run.");
  await expect(details.getByTestId("inspector-event-log")).toContainText("Run started");
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

test("recovers a rejected send by preserving the draft and retrying from the same context", async ({ page }) => {
  const chatId = "chat-send-recovery";
  const draft = "Retry this question without losing context";
  const parentUser = scrollMessage("user-send-parent", "user", "Existing question", null);
  const parentAssistant = scrollMessage(
    "assistant-send-parent",
    "assistant",
    "Existing answer stays in context",
    parentUser.id
  );
  const chat = {
    activeLeafMessageId: parentAssistant.id,
    createdAt: "2026-06-08T12:00:00.000Z",
    defaultModelId: "gpt-5.5",
    defaultProvider: "openai",
    folderId: null,
    id: chatId,
    messageCount: 2,
    messages: [parentUser, parentAssistant],
    pinned: false,
    title: "Send recovery",
    updatedAt: "2026-06-08T12:00:02.000Z",
    usageStats: null
  };
  const sendBodies: Array<Record<string, unknown>> = [];

  await page.addInitScript((activeChatId) => {
    window.localStorage.setItem("aiqsa.activeChatId", activeChatId);
  }, chatId);
  await installMatrixCatalogFixture(page, {
    chats: [chat],
    folders: []
  });
  await page.route(`**/api/chats/${chatId}/messages`, async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
    sendBodies.push(body);

    if (sendBodies.length === 1) {
      await route.fulfill({
        contentType: "application/json",
        json: { error: "provider_unavailable" },
        status: 503
      });
      return;
    }

    const retryUser = scrollMessage("user-send-retry", "user", draft, parentAssistant.id);
    const retryAssistant = {
      ...scrollMessage(
        "assistant-send-retry",
        "assistant",
        "Recovered answer after retry",
        retryUser.id
      ),
      modelRunId: "run-send-retry"
    };
    await route.fulfill({
      body: [
        sseEvent("run_start", { runId: "run-send-retry" }),
        sseEvent("message_start", {
          assistantMessageId: retryAssistant.id,
          userMessageId: retryUser.id
        }),
        sseEvent("chat_update", {
          chat: {
            ...chat,
            activeLeafMessageId: retryAssistant.id,
            contextStats: { approximateActiveBranchInputTokens: 42 },
            messageCount: 4,
            messages: [parentUser, parentAssistant, retryUser, retryAssistant],
            updatedAt: "2026-06-08T12:01:00.000Z"
          },
          messages: [retryUser, retryAssistant]
        }),
        sseEvent("done", { runId: "run-send-retry", status: "complete" })
      ].join(""),
      contentType: "text/event-stream",
      status: 200
    });
  });
  await page.route("**/api/model-runs/run-send-retry", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: {
        run: {
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          errorPayload: null,
          estimatedCostMicros: 0,
          events: [{ eventType: "done", payload: { status: "complete" }, sequence: 0 }],
          id: "run-send-retry",
          inputTokens: 8,
          modelId: "gpt-5.5",
          outputTokens: 5,
          provider: "openai",
          reasoningTokens: 0,
          searchRuns: [],
          status: "complete",
          toolCalls: [],
          totalTokens: 13
        }
      }
    });
  });

  await signIn(page);
  const composer = page.getByRole("textbox", { name: "Message" });
  const send = page.getByRole("button", { name: "Send message" });
  const thread = page.getByTestId("thread");
  await expect(thread).toContainText("Existing answer stays in context");

  await composer.fill(draft);
  await send.click();

  await expect(page.getByTestId("composer-operation-error")).toHaveText(
    "Send failed. Your draft was preserved."
  );
  await expect(composer).toHaveValue(draft);
  await expect(send).toBeEnabled();
  await expect(thread).toContainText("Existing answer stays in context");
  await expect(thread).not.toContainText(draft);
  await expect.poll(() => sendBodies.length).toBe(1);
  expect(sendBodies[0]).toMatchObject({
    content: { blocks: [{ text: draft, type: "text" }] },
    expectedActiveLeafId: parentAssistant.id
  });

  await send.click();

  await expect(thread).toContainText(draft);
  await expect(thread).toContainText("Recovered answer after retry");
  await expect(thread).toContainText("Existing answer stays in context");
  await expect(composer).toHaveValue("");
  await expect(page.getByTestId("composer-operation-error")).toHaveCount(0);
  await expect.poll(() => sendBodies.length).toBe(2);
  expect(sendBodies[1]).toMatchObject({
    content: { blocks: [{ text: draft, type: "text" }] },
    expectedActiveLeafId: parentAssistant.id
  });
});

test("keeps successful attachments and the draft after a mixed upload failure", async ({ page }) => {
  const chatId = "chat-upload-recovery";
  const draft = "Use the uploaded notes for this answer";
  const parentUser = scrollMessage("user-upload-parent", "user", "Existing upload question", null);
  const parentAssistant = scrollMessage(
    "assistant-upload-parent",
    "assistant",
    "Existing upload answer",
    parentUser.id
  );
  const chat = {
    activeLeafMessageId: parentAssistant.id,
    createdAt: "2026-06-08T13:00:00.000Z",
    defaultModelId: "gpt-5.5",
    defaultProvider: "openai",
    folderId: null,
    id: chatId,
    messageCount: 2,
    messages: [parentUser, parentAssistant],
    pinned: false,
    title: "Upload recovery",
    updatedAt: "2026-06-08T13:00:02.000Z",
    usageStats: null
  };
  let uploadAttempts = 0;
  let sendBody: Record<string, unknown> | null = null;
  let markFailedUploadStarted!: () => void;
  let releaseFailedUpload!: () => void;
  const failedUploadStarted = new Promise<void>((resolve) => {
    markFailedUploadStarted = resolve;
  });
  const failedUploadCanFinish = new Promise<void>((resolve) => {
    releaseFailedUpload = resolve;
  });

  await page.addInitScript((activeChatId) => {
    window.localStorage.setItem("aiqsa.activeChatId", activeChatId);
  }, chatId);
  await installMatrixCatalogFixture(page, {
    chats: [chat],
    folders: []
  });
  await page.route("**/api/uploads", async (route) => {
    uploadAttempts += 1;
    if (uploadAttempts === 1) {
      await route.fulfill({
        contentType: "application/json",
        json: {
          attachment: {
            byteSize: 14,
            extractedText: "Accepted notes",
            fileName: "accepted-notes.md",
            id: "attachment-upload-good",
            kind: "document",
            mimeType: "text/markdown",
            status: "ready"
          }
        },
        status: 201
      });
      return;
    }

    markFailedUploadStarted();
    await failedUploadCanFinish;
    await route.fulfill({
      contentType: "application/json",
      json: { error: "storage_temporarily_unavailable" },
      status: 500
    });
  });
  await page.route(`**/api/chats/${chatId}/messages`, async (route) => {
    sendBody = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
    const sentUser = {
      ...scrollMessage("user-upload-sent", "user", draft, parentAssistant.id),
      content: {
        blocks: [
          { text: draft, type: "text" },
          {
            attachmentId: "attachment-upload-good",
            fileName: "accepted-notes.md",
            type: "file"
          }
        ]
      }
    };
    const sentAssistant = {
      ...scrollMessage(
        "assistant-upload-sent",
        "assistant",
        "Answer used the successful upload",
        sentUser.id
      ),
      modelRunId: "run-upload-recovery"
    };
    await route.fulfill({
      body: [
        sseEvent("run_start", { runId: "run-upload-recovery" }),
        sseEvent("message_start", {
          assistantMessageId: sentAssistant.id,
          userMessageId: sentUser.id
        }),
        sseEvent("chat_update", {
          chat: {
            ...chat,
            activeLeafMessageId: sentAssistant.id,
            contextStats: { approximateActiveBranchInputTokens: 44 },
            messageCount: 4,
            messages: [parentUser, parentAssistant, sentUser, sentAssistant],
            updatedAt: "2026-06-08T13:01:00.000Z"
          },
          messages: [sentUser, sentAssistant]
        }),
        sseEvent("done", { runId: "run-upload-recovery", status: "complete" })
      ].join(""),
      contentType: "text/event-stream",
      status: 200
    });
  });
  await page.route("**/api/model-runs/run-upload-recovery", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: {
        run: {
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          errorPayload: null,
          estimatedCostMicros: 0,
          events: [{ eventType: "done", payload: { status: "complete" }, sequence: 0 }],
          id: "run-upload-recovery",
          inputTokens: 9,
          modelId: "gpt-5.5",
          outputTokens: 6,
          provider: "openai",
          reasoningTokens: 0,
          searchRuns: [],
          status: "complete",
          toolCalls: [],
          totalTokens: 15
        }
      }
    });
  });

  await signIn(page);
  const composer = page.getByRole("textbox", { name: "Message" });
  const send = page.getByRole("button", { name: "Send message" });
  await composer.fill(draft);
  await page.getByLabel("Attach file").setInputFiles([
    {
      buffer: Buffer.from("Accepted notes"),
      mimeType: "text/markdown",
      name: "accepted-notes.md"
    },
    {
      buffer: Buffer.from("Rejected notes"),
      mimeType: "text/markdown",
      name: "rejected-notes.md"
    }
  ]);

  await failedUploadStarted;
  await expect(page.getByText("Uploading…", { exact: true })).toBeVisible();
  await expect(composer).toHaveValue(draft);
  await expect(page.getByTestId("attachment-chip")).toHaveText("accepted-notes.md");
  await expect(send).toBeDisabled();

  releaseFailedUpload();

  const uploadError = page.getByTestId("composer-operation-error");
  await expect(uploadError).toContainText("rejected-notes.md");
  await expect(uploadError).toContainText("upload failed with HTTP 500 (upload_failed_500)");
  await expect(page.getByText("Uploading…", { exact: true })).toHaveCount(0);
  await expect(composer).toHaveValue(draft);
  await expect(page.getByTestId("attachment-chip")).toHaveCount(1);
  await expect(page.getByTestId("attachment-chip")).toHaveText("accepted-notes.md");
  await expect(send).toBeEnabled();

  await send.click();

  await expect(page.getByTestId("thread")).toContainText("Answer used the successful upload");
  await expect(composer).toHaveValue("");
  await expect(page.getByTestId("attachment-chip")).toHaveCount(0);
  await expect(page.getByTestId("composer-operation-error")).toHaveCount(0);
  await expect.poll(() => sendBody).not.toBeNull();
  expect(sendBody).toMatchObject({
    content: {
      blocks: [
        { text: draft, type: "text" },
        {
          attachmentId: "attachment-upload-good",
          fileName: "accepted-notes.md",
          type: "file"
        }
      ]
    },
    expectedActiveLeafId: parentAssistant.id
  });
  expect(JSON.stringify(sendBody)).not.toContain("rejected-notes.md");
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
  await expect(composerRunSummary(page)).toBeDisabled();
  await expect(page.getByRole("dialog", { name: "Run setup" })).toHaveCount(0);

  await page.getByRole("button", { name: "Retry loading chat" }).click();
  await expect(page.getByTestId("thread")).toContainText("Recovered detail answer");
  await expect(page.getByTestId("thread-detail-error")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Message" })).toBeEnabled();
  await expect(composerRunSummary(page)).toBeEnabled();
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
                    searchActivity: [{
                      displayName: "OpenAI Search",
                      providerOperations: [{
                        kind: "search",
                        ordinal: 0,
                        pattern: null,
                        queries: ["background recovery evidence"],
                        status: "complete",
                        url: null
                      }],
                      providerOperationsTruncated: false,
                      query: "background recovery evidence",
                      sourceCount: 1,
                      sources: [{
                        rank: 1,
                        title: "Recovered source",
                        url: "https://example.com/recovered-source"
                      }],
                      status: "complete"
                    }],
                    searchCount: 1,
                    searchDisplayName: "OpenAI Search",
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
  const answerMetadata = page.getByTestId("answer-metadata-block");
  const recoveredAnswer = page.locator('article[data-role="assistant"]').last();
  const recoveredSearchSummary = recoveredAnswer.getByTestId("thread-search-summary");
  await expect(recoveredSearchSummary).toBeVisible();
  const recoveredSearch = recoveredSearchSummary.getByRole("button", {
    name: /Search OpenAI Search.*Completed.*1 source.*1 citation/i
  });
  await expect(recoveredSearch).toHaveAttribute("aria-expanded", "false");
  await recoveredSearch.click();
  await expect(recoveredSearch).toHaveAttribute("aria-expanded", "true");
  await expect(recoveredSearchSummary.getByTestId("thread-search-details")).toContainText(
    "background recovery evidence"
  );
  await expect(recoveredSearchSummary.getByRole("link", { name: "Recovered source" }).first()).toBeVisible();
  await recoveredSearch.click();
  await expect(answerMetadata).toHaveCount(0);
  await recoveredAnswer.hover();
  await expect(answerMetadata).toHaveCount(0);
  const recoveredActions = recoveredAnswer.getByRole("toolbar", { name: "Assistant message actions" });
  await expect(recoveredActions).toBeVisible();
  await recoveredActions.getByRole("button", { name: "More message actions" }).click();
  await page.getByRole("menuitem", { name: "Show run details" }).click();
  await expect(answerMetadata).toBeVisible();
  const recoveredSearchReceipt = answerMetadata.getByRole("button", { name: "1 search call" });
  await expect(recoveredSearchReceipt).toHaveAttribute("aria-expanded", "false");
  await recoveredSearchReceipt.click();
  await expect(recoveredSearchReceipt).toHaveAttribute("aria-expanded", "true");
  await expect(recoveredSearch).toHaveAttribute("aria-expanded", "true");
  const recoveredCitations = answerMetadata.getByRole("button", { name: "1 citation" });
  await expect(recoveredCitations).toHaveAttribute("aria-expanded", "false");
  await recoveredCitations.click();
  await expect(recoveredCitations).toHaveAttribute("aria-expanded", "true");
  await expect(answerMetadata.getByTestId("thread-citations-block")).toContainText("Recovered source");
  let runSetup = await openRunSetup(page);
  await runSetup.getByRole("button", { name: "Hide citations" }).click();
  await expect(page.getByTestId("thread-citations-block")).toHaveCount(0);
  await runSetup.getByRole("button", { name: "Show citations" }).click();
  await closeRunSetup(page);
  const restoredCitations = answerMetadata.getByRole("button", { name: "1 citation" });
  await expect(restoredCitations).toHaveAttribute("aria-expanded", "true");
  await expect(answerMetadata.getByTestId("thread-citations-block")).toContainText("Recovered source");
  await restoredCitations.click();
  await expect(restoredCitations).toHaveAttribute("aria-expanded", "false");
  await restoredCitations.click();
  await expect(restoredCitations).toHaveAttribute("aria-expanded", "true");
  await expect(answerMetadata.getByTestId("thread-citations-block")).toContainText("Recovered source");
  await expect(page.getByTestId("thread-reasoning-block")).toHaveCount(0);
  runSetup = await openRunSetup(page);
  await runSetup.getByRole("button", { name: "Show reasoning blocks" }).click();
  await closeRunSetup(page);
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

  let runSetup = await openRunSetup(page);
  await runSetup.getByRole("button", { name: "Hide tool activity" }).click();
  await expect.poll(() => settingsPatches).toBe(1);
  await closeRunSetup(page);
  await expect(activity).toHaveCount(0);

  await page.reload();
  await expect(page.getByTestId("app-shell")).toBeVisible();
  await expect(page.getByTestId("thread-tool-activity")).toHaveCount(0);

  runSetup = await openRunSetup(page);
  await runSetup.getByRole("button", { name: "Show tool activity" }).click();
  await expect.poll(() => settingsPatches).toBe(2);
  await closeRunSetup(page);
  await expect(page.getByTestId("thread-tool-activity")).toBeVisible();

  await page.reload();
  await expect(page.getByTestId("app-shell")).toBeVisible();
  await expect(page.getByTestId("thread-tool-activity")).toContainText("Mem0");
});

test("keeps client Search direct, expandable, and independent of generic tool activity", async ({ page }) => {
  const chatId = "chat-search-tool-trace";
  const chat = {
    activeLeafMessageId: "assistant-search-trace",
    createdAt: "2026-07-31T12:00:00.000Z",
    defaultModelId: "gpt-5.5",
    defaultProvider: "openai",
    folderId: null,
    id: chatId,
    messageCount: 2,
    messages: [
      {
        artifactSummary: null,
        content: { blocks: [{ text: "latest news in Moscow", type: "text" }] },
        createdAt: "2026-07-31T12:00:00.000Z",
        errorMessage: null,
        id: "user-search-trace",
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
          searchActivity: [
            {
              displayName: "Web Search · Sol",
              providerOperations: [
                {
                  kind: "search",
                  ordinal: 0,
                  pattern: null,
                  queries: ["Moscow latest news", "Moscow news today"],
                  status: "complete",
                  url: null
                },
                {
                  kind: "open_page",
                  ordinal: 1,
                  pattern: null,
                  queries: [],
                  status: "complete",
                  url: "https://example.com/moscow"
                }
              ],
              providerOperationsTruncated: false,
              query: "latest news in Moscow",
              sourceCount: 4,
              sources: [{
                date: "2026-07-31",
                rank: 1,
                snippet: "Normalized Moscow news evidence",
                title: "Moscow news",
                url: "https://example.com/moscow"
              }],
              status: "complete"
            },
            {
              displayName: "Web Search · Sol",
              failureReason: "This Search source reached its request limit for this answer.",
              providerOperations: null,
              providerOperationsTruncated: false,
              query: "latest news in Moscow retry",
              sourceCount: null,
              sources: [],
              status: "error"
            }
          ],
          searchCount: 2,
          searchDisplayName: "Web Search · Sol",
          searchStrategy: "client-search-plan",
          toolCallCount: 0,
          toolCalls: []
        },
        content: { blocks: [{ text: "Here is the latest news.", type: "text" }] },
        createdAt: "2026-07-31T12:02:26.000Z",
        errorMessage: null,
        id: "assistant-search-trace",
        modelId: "gpt-5.5",
        modelRunId: "run-search-trace",
        parentMessageId: "user-search-trace",
        provider: "openai",
        role: "assistant",
        status: "complete"
      }
    ],
    pinned: false,
    title: "Search tool trace",
    updatedAt: "2026-07-31T12:02:26.000Z",
    usageStats: null
  };

  await page.addInitScript((activeChatId) => {
    window.localStorage.setItem("aiqsa.activeChatId", activeChatId);
  }, chatId);
  await installMatrixCatalogFixture(page, { chats: [chat], contentMatches: [], folders: [] });
  await signIn(page);

  const searchSummary = page.getByTestId("thread-search-summary");
  await expect(searchSummary).toBeVisible();
  const search = searchSummary.getByRole("button", {
    name: /Search Web Search · Sol.*1 of 2 completed.*4\+ sources/i
  });
  await expect(search).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("thread-tool-activity")).toHaveCount(0);
  await expect(page.getByText("search_selected_engines", { exact: true })).toHaveCount(0);

  await search.click();
  await expect(search).toHaveAttribute("aria-expanded", "true");
  const detail = searchSummary.getByTestId("thread-search-details");
  const attempts = detail.getByTestId("thread-search-attempt");
  await expect(attempts).toHaveCount(2);
  const completedAttempt = attempts.nth(0).getByRole("button", {
    name: /Attempt 1 Web Search · Sol Completed.*4 sources/i
  });
  const rejectedAttempt = attempts.nth(1).getByRole("button", {
    name: /Attempt 2 Web Search · Sol Failed/i
  });
  await expect(completedAttempt).toHaveAttribute("aria-expanded", "false");
  await expect(rejectedAttempt).toHaveAttribute("aria-expanded", "false");
  await completedAttempt.click();
  await expect(detail).toContainText("latest news in Moscow");
  await expect(detail).toContainText("Provider operations · 2");
  await expect(detail).toContainText("Moscow latest news");
  await expect(detail).toContainText("Moscow news today");
  await expect(detail.getByRole("link", { name: "Moscow news" })).toHaveAttribute(
    "href",
    "https://example.com/moscow"
  );
  await expect(detail).toContainText("Normalized Moscow news evidence");
  await rejectedAttempt.click();
  await expect(detail).toContainText("latest news in Moscow retry");
  await expect(detail).toContainText(
    "This Search source reached its request limit for this answer."
  );
  await expectNoHorizontalOverflow(page);

  const runSetup = await openRunSetup(page);
  await runSetup.getByRole("button", { name: "Hide tool activity" }).click();
  await closeRunSetup(page);
  await expect(searchSummary).toBeVisible();
  await expect(search).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("thread-tool-activity")).toHaveCount(0);

  await page.setViewportSize({ height: 844, width: 390 });
  await detail.scrollIntoViewIfNeeded();
  await expect(detail).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test("supports the default chat and folder workflow", async ({ browser, page }) => {
  test.setTimeout(60_000);
  const suffix = Date.now();
  const folderName = `E2E Folder ${suffix}`;
  const expectedAutoTitle = `Folder path e2e question ${suffix} demonstrates`;
  const prompt = `${expectedAutoTitle} clean automatic title boundaries`;
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
  await expectRunSummary(page, { model: resetModelLabel.split(" / ").at(-1) ?? resetModelLabel });
  let runSetup = await openRunSetup(page);
  await expect(runSetup.getByRole("button", { name: "Select model" })).toHaveAttribute(
    "title",
    resetModelLabel
  );
  await closeRunSetup(page);
  await expect(page.getByTestId("current-chat-title")).toHaveText("New chat");
  await expect(page.getByTestId("thread")).not.toContainText("Compare native web search");

  await expect(page.getByRole("button", { name: "Share anonymously" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open details" })).toHaveCount(0);
  await expect(page.getByTestId("top-rail")).toHaveCSS("height", "0px");

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

  const workspaceRail = page.getByTestId("workspace-pane-desktop");
  const newFolderButton = page.getByRole("button", { name: "New folder" });
  const [workspaceRailBox, newFolderButtonBox] = await Promise.all([
    workspaceRail.boundingBox(),
    newFolderButton.boundingBox()
  ]);
  expect(workspaceRailBox).toBeTruthy();
  expect(newFolderButtonBox).toBeTruthy();
  expect(newFolderButtonBox!.x).toBeGreaterThanOrEqual(workspaceRailBox!.x - 1);
  expect(newFolderButtonBox!.x + newFolderButtonBox!.width).toBeLessThanOrEqual(
    workspaceRailBox!.x + workspaceRailBox!.width + 1
  );
  await newFolderButton.click();
  await page.getByLabel("Folder name").fill(folderName);
  await page.getByRole("button", { name: "Create folder" }).click();
  await expect(page.getByTestId("shell-notice")).toContainText(`Folder created: ${folderName}`);
  await expect(page.getByTestId("left-chat-pane")).toContainText(folderName);

  await page.getByRole("button", { name: `Folder actions ${folderName}` }).click();
  await page.getByTestId("left-chat-pane").getByRole("button", { exact: true, name: "New chat" }).click();
  await expect(page.getByTestId("current-chat-title")).toHaveText("New chat");
  await expect(page.getByLabel("Chat folder")).toHaveCount(0);

  await selectModel(page, "fake", "Fake QSA", resetModelLabel.split(" / ").at(0) ?? "Fake QSA");
  await expectRunSummary(page, { model: "Fake QSA" });
  runSetup = await openRunSetup(page);
  await runSetup.getByLabel("Temperature").fill("0.1");
  await closeRunSetup(page);

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
  await expect(details.getByTestId("details-mode-label")).toHaveCount(0);

  await expect(assistantContentWithText(page, `Fake answer: ${prompt}`)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("current-chat-title")).toHaveText(expectedAutoTitle);
  expect(activeChatDetailFetches).toBe(0);
  await expect(page.getByTestId("streaming-cursor")).toHaveCount(0);
  await expect(page.getByTestId("pipeline-indicator")).toHaveCount(0);
  await expect(details.getByTestId("inspector-event-log")).toContainText("Run complete");
  await details.getByRole("button", { name: "Pin details" }).click();
  await expect(details).toHaveAttribute("data-presentation", "pinned");
  await expect(details.getByTestId("details-mode-label")).toHaveText("Pinned beside chat");
  const completedAnswer = page.locator('article[data-role="assistant"]').last();
  await completedAnswer.hover();
  await completedAnswer.getByRole("button", { name: "More message actions" }).click();
  await page.getByRole("menuitem", { name: "Show run details" }).click();
  await expect(completedAnswer).toContainText(resetModelLabel);
  await expect(
    page.getByTestId("left-chat-pane").getByRole("button", { exact: true, name: expectedAutoTitle })
  ).toBeVisible();
  await expect(page.getByTestId("left-chat-pane")).toContainText(String(suffix));
  await page.getByLabel("Search chats").fill(String(suffix));
  await expect(page.getByTestId("left-chat-pane")).toContainText(String(suffix));
  await page.getByLabel("Search chats").fill(`missing ${suffix}`);
  await expect(page.getByTestId("left-chat-pane")).toContainText("No chats match this search");
  await page.getByLabel("Search chats").press("Escape");
  await expect(page.getByLabel("Search chats")).toHaveValue("");
  await expect(page.getByTestId("current-chat-title")).toHaveClass(/\bsr-only\b/);
  const desktopConversationHeader = page.getByTestId("top-rail");
  await expect(desktopConversationHeader).toBeVisible();
  await expectConversationControlsClearOfThread(page);
  const conversationActions = desktopConversationHeader.getByRole("button", {
    name: "Conversation actions"
  });
  await conversationActions.click();
  await page
    .getByRole("menu", { name: "Conversation actions" })
    .getByRole("menuitem", { name: "Copy thread" })
    .click();
  await expect(page.getByTestId("shell-notice")).toContainText("Thread copied");
  await expect
    .poll(() => page.evaluate(() => window.localStorage.getItem("aiqsa.testClipboard") ?? ""))
    .toContain(prompt);
  await page.getByTestId("left-chat-pane").getByRole("button", { name: /Chat actions/ }).first().click();
  await expect(page.getByRole("button", { name: "Rename" })).toBeVisible();
  const moveChat = page.getByRole("button", { name: /Move chat .* to folder/ });
  await expect(moveChat).toBeVisible();
  await expect(page.getByTestId("left-chat-pane").getByRole("button", { name: "Export" })).toBeVisible();
  await expect(page.getByTestId("left-chat-pane").getByRole("button", { name: "Share" })).toBeVisible();
  await expect(page.getByTestId("left-chat-pane").getByRole("button", { name: "Delete chat" })).toBeVisible();
  await moveChat.click();
  let movePicker = page.getByRole("dialog", { name: "Choose move to folder" });
  await expect(movePicker.getByText("No folder", { exact: true })).toBeVisible();
  await movePicker.getByText("No folder", { exact: true }).click();
  await expect(page.getByTestId("shell-notice")).toContainText("Moved:");
  await page.getByTestId("left-chat-pane").getByRole("button", { name: /Chat actions/ }).first().click();
  await page.getByRole("button", { name: /Move chat .* to folder/ }).click();
  movePicker = page.getByRole("dialog", { name: "Choose move to folder" });
  await movePicker.getByText(folderName, { exact: true }).click();
  await expect(page.getByTestId("shell-notice")).toContainText("Moved:");
  await expect(page.getByTestId("details-pane")).toContainText("Details");
  await expect(page.getByTestId("details-pane")).not.toContainText("Current/latest run");
  await expect(page.getByRole("tab", { name: "Request" })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Response" })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Usage" })).toHaveCount(0);
  await expect(page.getByTestId("token-stats-button")).toBeVisible();
  await expect(page.getByTestId("composer-usage-line")).not.toContainText("cost");
  await page.getByTestId("token-stats-button").click();
  await expect(page.getByTestId("token-stats-popover")).toContainText("Approximate input");
  await expect(page.getByTestId("token-stats-popover")).toContainText("Safe input budget");
  await expect(page.getByTestId("token-stats-popover")).toContainText("7.4k");
  await expect(page.getByTestId("token-stats-popover")).toContainText("Total context");
  await expect(page.getByTestId("token-stats-popover")).toContainText("8.2k");
  await expect(page.getByTestId("token-stats-popover")).toContainText("Total messages");
  await expect(page.getByTestId("token-stats-popover")).toContainText("Provider-reported tokens");
  const composerMessageLabel = page.locator('label[for="composer"]');
  await expect(composerMessageLabel).toHaveClass(/\bsr-only\b/);
  await expect
    .poll(() => composerMessageLabel.evaluate((element) => {
      const style = window.getComputedStyle(element);
      return `${style.position}:${style.width}:${style.height}:${style.overflow}`;
    }))
    .toBe("absolute:1px:1px:hidden");
  await expect(page.getByTestId("token-stats-popover")).toContainText("Total tokens cached");
  await expect(page.getByTestId("token-stats-popover")).not.toContainText("cost");
  await page.keyboard.press("Escape");
  await details.getByRole("tab", { name: "Events" }).click();
  await expect(details.getByRole("tab", { name: "Events" })).toHaveAttribute("aria-selected", "true");
  await expect(details.getByRole("tab", { name: "API params" })).toHaveCount(0);
  await expect(details.getByLabel("Temperature")).toHaveCount(0);

  await page.getByRole("tab", { name: "Events" }).click();
  await expect(page.getByTestId("inspector-event-log")).toContainText("Run started");
  await expect(page.getByTestId("inspector-event-log")).toContainText("Provider updates");
  await expect(page.getByTestId("inspector-event-log")).toContainText("Run complete");
  await conversationActions.click();
  await page
    .getByRole("menu", { name: "Conversation actions" })
    .getByRole("menuitem", { name: "Branch tree" })
    .click();
  await expect(page.getByRole("tab", { name: "Branch" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("branch-tree")).toBeVisible();
  await page.reload();
  details = page.getByTestId("details-pane");
  await expect(details).toHaveAttribute("data-presentation", "pinned");
  await page.getByTestId("token-stats-button").click();
  await expect(page.getByTestId("token-stats-popover")).toContainText("Provider-reported tokens");
  await page.keyboard.press("Escape");

  let latestAssistant = page.locator('article[data-role="assistant"]').last();
  await latestAssistant.hover();
  let latestMessageActions = latestAssistant.getByTestId("message-actions");
  await latestMessageActions.getByRole("button", { name: "More message actions" }).click();
  await page
    .getByRole("menu", { name: "More message actions" })
    .getByRole("menuitem", { name: "Branch from here" })
    .click();
  await expect(page.getByTestId("shell-notice")).toContainText("Branched chat:");
  await expect(page.getByTestId("thread")).toContainText(prompt);
  await expect(page.getByTestId("thread")).toContainText(`Fake answer: ${prompt}`);

  // Create a real sibling inside the new chat before extending one path; the
  // cross-chat Branch action itself intentionally copies only one version.
  latestAssistant = page.locator('article[data-role="assistant"]').last();
  await latestAssistant.hover();
  await latestAssistant.getByRole("button", { name: "Regenerate message" }).click();
  await expect(
    page.getByRole("button", { name: /^Open alternate version, assistant \d+$/ }).first()
  ).toBeVisible({ timeout: 10_000 });

  await page.getByRole("textbox", { name: "Message" }).fill(memoryPrompt);
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(assistantContentWithText(page, `Fake answer: ${memoryPrompt}`)).toBeVisible();
  await expect(page.getByTestId("thread")).toContainText(`Context memory: ${prompt}`);

  await page.getByRole("tab", { name: "Branch" }).click();
  await page.getByRole("button", { name: /^Open alternate version, assistant \d+$/ }).first().click();
  const checkoutPrompt = `Branch checkout e2e ${suffix}`;
  await page.getByRole("textbox", { name: "Message" }).fill(checkoutPrompt);
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(assistantContentWithText(page, `Fake answer: ${checkoutPrompt}`)).toBeVisible();
  await expect(page.getByTestId("thread")).toContainText(`Context memory: ${prompt}`);
  await expect(page.getByTestId("thread")).not.toContainText(memoryPrompt);
  await page.getByRole("tab", { name: "Branch" }).click();
  activeChatDetailFetches = 0;
  latestAssistant = page.locator('article[data-role="assistant"]').last();
  await latestAssistant.hover();
  await latestAssistant.getByRole("button", { name: /Regenerate message/ }).click();
  await expect(page.getByTestId("streaming-cursor")).toHaveCount(0);
  await expect(assistantContentWithText(page, `Fake answer: ${checkoutPrompt}`)).toBeVisible();
  await expect(page.getByTestId("thread")).toContainText(`Context memory: ${prompt}`);
  await expect(page.getByTestId("thread")).not.toContainText("Regenerated branch draft");
  expect(activeChatDetailFetches).toBe(0);
  latestAssistant = page.locator('article[data-role="assistant"]').last();
  await latestAssistant.hover();
  latestMessageActions = latestAssistant.getByTestId("message-actions");
  await latestMessageActions.getByRole("button", { name: "More message actions" }).click();
  await page
    .getByRole("menu", { name: "More message actions" })
    .getByRole("menuitem", { name: "Delete message" })
    .click();
  let messageDeleteDialog = page.getByRole("dialog", { name: "Delete message" });
  await expect(messageDeleteDialog).toContainText("every reply below");
  await messageDeleteDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(assistantContentWithText(page, `Fake answer: ${checkoutPrompt}`)).toBeVisible();
  latestAssistant = page.locator('article[data-role="assistant"]').last();
  await latestAssistant.hover();
  latestMessageActions = latestAssistant.getByTestId("message-actions");
  await latestMessageActions.getByRole("button", { name: "More message actions" }).click();
  await page
    .getByRole("menu", { name: "More message actions" })
    .getByRole("menuitem", { name: "Delete message" })
    .click();
  messageDeleteDialog = page.getByRole("dialog", { name: "Delete message" });
  await messageDeleteDialog.getByRole("button", { name: "Confirm delete message" }).click();
  await expect(page.getByTestId("shell-notice")).toContainText("Message deleted");
  await expect(page.getByRole("textbox", { name: "Message" })).toBeFocused();

  let failShareListOnce = true;
  const shareListRetryRoute = async (route: Route) => {
    if (route.request().method() === "GET" && failShareListOnce) {
      failShareListOnce = false;
      await route.fulfill({
        contentType: "application/json",
        json: { error: "share_list_temporarily_unavailable" },
        status: 503
      });
      return;
    }
    await route.continue();
  };
  await page.route("**/api/chats/*/share", shareListRetryRoute);
  await page.getByRole("button", { name: "Share anonymously" }).click();
  const shareDialog = page.getByRole("dialog", { name: "Share anonymously" });
  const shareAnnouncement = shareDialog.getByTestId("share-dialog-announcement");
  await expect(shareDialog).toBeVisible();
  await expect(shareDialog).toContainText("sanitized snapshot");
  await expect(shareAnnouncement).toContainText("Could not load shared links.");
  await shareDialog.getByRole("button", { name: "Retry loading links" }).click();
  await expect(shareDialog.getByTestId("share-links-empty")).toBeVisible();
  await expect(shareAnnouncement).toHaveText("No live shared links found.");
  await page.unroute("**/api/chats/*/share", shareListRetryRoute);
  const shareCreation = page.waitForResponse((response) => {
    const pathname = new URL(response.url()).pathname;
    return response.request().method() === "POST" && /^\/api\/chats\/[^/]+\/share$/.test(pathname);
  });
  await shareDialog.getByRole("button", { name: "Create public link" }).click();
  const shareCreationResponse = await shareCreation;
  expect(shareCreationResponse.ok()).toBe(true);
  await expect(shareDialog.getByTestId("share-link")).toBeVisible();
  await expect(shareAnnouncement).toHaveText("Public link created and copied.");
  await expect(shareDialog.getByTestId("share-link").locator('[aria-live], [role="alert"], [role="status"]'))
    .toHaveCount(0);
  const shareHref = await shareDialog.getByTestId("share-link").getByRole("link").getAttribute("href");
  expect(shareHref).toBeTruthy();
  expect(await page.evaluate(() => window.localStorage.getItem("aiqsa.testClipboard")))
    .toBe(shareHref);
  await shareDialog.getByRole("button", { name: "Close share dialog" }).click();
  await expect(shareDialog).toHaveCount(0);

  const anonymousContext = await browser.newContext({
    viewport: { height: 844, width: 390 }
  });
  const anonymousPage = await anonymousContext.newPage();
  try {
    const shareResponse = await anonymousPage.goto(shareHref!);
    expect(shareResponse?.status()).toBe(200);
    await expect(anonymousPage.getByTestId("public-share-view")).toContainText("Read-only snapshot");
    const sharedTitle = anonymousPage.getByRole("heading", { level: 1 });
    await expect(sharedTitle).toHaveText(`Branch: ${expectedAutoTitle}`);
    await expect(sharedTitle).not.toContainText("...");
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
    await expect(anonymousPage.getByText(resetModelLabel)).toHaveCount(0);
    await expect(anonymousPage.getByRole("button", { name: "Share anonymously" })).toHaveCount(0);
    await expect(anonymousPage.getByRole("button", { name: "Edit message" })).toHaveCount(0);
    await expect(anonymousPage.getByRole("button", { name: "Open details" })).toHaveCount(0);
    await expectNoHorizontalOverflow(anonymousPage);

    await page.getByRole("button", { name: "Share anonymously" }).click();
    const reopenedShareDialog = page.getByRole("dialog", { name: "Share anonymously" });
    await expect(reopenedShareDialog.getByTestId("share-links")).toBeVisible();
    const shareRevocation = page.waitForResponse((response) => {
      const pathname = new URL(response.url()).pathname;
      return response.request().method() === "POST" && /^\/api\/shares\/[^/]+\/revoke$/.test(pathname);
    });
    await reopenedShareDialog.getByRole("button", { name: /Revoke link created/ }).click();
    const shareRevocationResponse = await shareRevocation;
    expect(shareRevocationResponse.ok()).toBe(true);
    await expect(reopenedShareDialog.getByTestId("share-links-empty")).toBeVisible();
    await expect(reopenedShareDialog.getByTestId("share-dialog-announcement"))
      .toHaveText("Public link revoked.");
    await reopenedShareDialog.getByRole("button", { name: "Close share dialog" }).click();
    await expect(page.getByRole("button", { name: "Share anonymously" })).toBeFocused();
    const revokedShareResponse = await anonymousPage.goto(shareHref!);
    expect(revokedShareResponse?.status()).toBe(404);
    await expect(anonymousPage.getByTestId("public-share-unavailable")).toContainText(
      "Shared snapshot unavailable"
    );
    await expect(anonymousPage).not.toHaveURL(/\/login/);
    await expectNoHorizontalOverflow(anonymousPage);

    const unknownShareResponse = await anonymousPage.goto("/s/unknown-token");
    expect(unknownShareResponse?.status()).toBe(404);
    await expect(anonymousPage.getByTestId("public-share-unavailable")).toContainText(
      "Shared snapshot unavailable"
    );
    await expect(anonymousPage.getByTestId("public-share-unavailable")).not.toContainText(
      "operator@aiqsa.local"
    );
    await expect(anonymousPage).not.toHaveURL(/\/login/);
    await expectNoHorizontalOverflow(anonymousPage);
    await expect.poll(async () => (await anonymousContext.request.get("/favicon.svg")).status()).toBe(200);
    await expect.poll(async () => (await anonymousContext.request.get("/favicon-alert.svg")).status()).toBe(200);
  } finally {
    await anonymousContext.close();
  }

  await cleanupE2eWorkspace(page);
});

test("manages left-pane folders", async ({ page }) => {
  test.setTimeout(45_000);
  const suffix = Date.now();
  const folderName = `E2E Folder Manage ${suffix}`;
  const renamedFolderName = `E2E Folder Renamed ${suffix}`;
  const subfolderName = `E2E Subfolder ${suffix}`;

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
  await projectDialog.getByLabel("Project instructions").fill("Prefer terse E2E project memory.");
  await projectDialog.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("shell-notice")).toContainText(`Project settings saved: ${renamedFolderName}`);

  await page.getByRole("button", { name: `Folder actions ${subfolderName}` }).click();
  await page.getByRole("button", { name: `Move folder ${subfolderName} to folder` }).click();
  await page
    .getByRole("dialog", { name: "Choose move to folder" })
    .getByText("Top level", { exact: true })
    .click();
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

  await cleanupE2eWorkspace(page);
});

test("keeps the desktop icon rail contained for coarse-pointer input", async ({ baseURL, browser }) => {
  expect(baseURL).toBeTruthy();
  const context = await browser.newContext({
    baseURL,
    colorScheme: "dark",
    hasTouch: true,
    isMobile: true,
    reducedMotion: "reduce",
    viewport: { height: 800, width: 1281 }
  });

  try {
    const page = await context.newPage();
    await signIn(page);
    expect(await page.evaluate(() => window.matchMedia("(pointer: coarse)").matches)).toBe(true);
    const rail = page.getByTestId("workspace-icon-rail");
    await expect(rail).toBeVisible();
    await expect(page.getByTestId("left-chat-pane")).toBeVisible();
    for (const name of ["New chat", "Chats", "Assistants", "Knowledge", "Settings", "Account"]) {
      const control = rail.getByRole("button", { name, exact: true });
      await expectTouchSafe(control);
      await expectWithinViewport(page, control);
    }

    await page.getByRole("button", { name: "Hide workspace" }).click();
    await expect(rail.getByRole("button", { name: "Chats" })).toBeFocused();
    await rail.getByRole("button", { name: "Account" }).click();
    const accountMenu = page.getByRole("menu", { name: "Account" });
    await expectWithinViewport(page, accountMenu);
    await page.keyboard.press("Escape");
    await expectNoHorizontalOverflow(page);
  } finally {
    await context.close();
  }
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
        searchActivity: [{
          displayName: "Perplexity Search",
          providerOperations: [{
            kind: "search",
            ordinal: 0,
            pattern: null,
            queries: ["responsive viewport evidence"],
            status: "complete",
            url: null
          }],
          providerOperationsTruncated: false,
          query: `responsive ${"request-segment/".repeat(18)}`,
          sourceCount: 1,
          sources: [{
            rank: 1,
            snippet: `Responsive source ${"remains contained. ".repeat(12)}`,
            title: "Responsive normalized Search source",
            url: "https://example.com/responsive-search-source"
          }],
          status: "complete"
        }],
        searchCount: 1,
        searchDisplayName: "Perplexity Search",
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
        contextStats: { approximateActiveBranchInputTokens: 12_800 },
        createdAt: "2026-07-11T10:00:00.000Z",
        defaultModelId: "gpt-5.5",
        defaultProvider: "openai",
        folderId: "responsive-child",
        id: chatId,
        messageCount: messages.length,
        messages,
        pageInfo: {
          activeLeafMessageId: "responsive-assistant-3",
          beforeCursor: null,
          hasOlder: false,
          snapshotUpdatedAt: "2026-07-11T10:01:00.000Z"
        },
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
        let landscapeShareLive = false;
        await page.route(`**/api/chats/${chatId}/share`, async (route) => {
          if (route.request().method() === "GET") {
            await route.fulfill({
              contentType: "application/json",
              json: {
                shares: landscapeShareLive
                  ? [{ createdAt: "2026-07-27T12:00:00.000Z", id: "responsive-landscape-share" }]
                  : []
              }
            });
            return;
          }
          landscapeShareLive = true;
          await route.fulfill({
            contentType: "application/json",
            json: { share: { id: "responsive-landscape-share", publicPath: "/s/responsive-landscape-token" } }
          });
        });
        await page.route("**/api/shares/responsive-landscape-share/revoke", async (route) => {
          landscapeShareLive = false;
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
      await expect(currentChatTitle).toHaveClass(/\bsr-only\b/);
      await expect
        .poll(() =>
          currentChatTitle.evaluate((element) => {
            const style = window.getComputedStyle(element);
            return `${style.position}:${style.width}:${style.height}:${style.overflow}`;
          })
        )
        .toBe("absolute:1px:1px:hidden");
      await expectConversationControlsClearOfThread(page);
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
        "Share anonymously",
        "Open details"
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
      const conversationActionsTrigger = page.getByRole("button", { name: "Conversation actions" });
      await expectTouchSafe(conversationActionsTrigger);
      await conversationActionsTrigger.click();
      const conversationActionsMenu = page.getByRole("menu", { name: "Conversation actions" });
      for (const name of ["Copy thread", "Branch tree"]) {
        const action = conversationActionsMenu.getByRole("menuitem", { name });
        await expectTouchSafe(action);
        await expectWithinViewport(page, action);
      }
      await page.keyboard.press("Escape");
      if (viewport.label === "landscape") {
        await page.getByRole("button", { name: "Share anonymously" }).click();
        const landscapeShareDialog = page.getByRole("dialog", { name: "Share anonymously" });
        await expect(landscapeShareDialog).toBeVisible();
        await landscapeShareDialog.getByRole("button", { name: "Create public link" }).click();
        await expect(landscapeShareDialog.getByTestId("share-link")).toBeVisible();
        await expectWithinViewport(page, landscapeShareDialog.getByRole("button", { name: "Create public link" }));
        await landscapeShareDialog.getByRole("button", { name: "Close share dialog" }).click();
        await expect(landscapeShareDialog).toHaveCount(0);
      }
      await expect(
        page.getByTestId("top-rail").locator('button[aria-label^="Account menu for "]')
      ).toHaveCount(0);
      const workspaceBrowseTrigger = page.getByRole("button", { name: "Open workspace" });
      await workspaceBrowseTrigger.click();
      const accountWorkspace = page.getByTestId("workspace-pane-mobile");
      const accountTrigger = accountWorkspace.getByRole("button", { name: /Account menu/ });
      expect(
        await accountTrigger.evaluate((element) =>
          Boolean(element.closest('[data-testid="workspace-account-footer"]'))
        )
      ).toBe(true);
      await expectTouchSafe(accountTrigger);
      await expectWithinViewport(page, accountTrigger);
      await expect(accountWorkspace).toHaveCSS("z-index", "50");
      await accountTrigger.click();
      await expect(accountWorkspace).toHaveCSS("z-index", "80");
      const accountMenu = accountWorkspace.getByRole("menu", { name: "Account" });
      await expect(accountMenu).toHaveCSS("scrollbar-width", "thin");
      await expectWithinViewport(page, accountMenu);
      await expect(accountMenu.getByText("Account", { exact: true })).toBeVisible();
      if (viewport.label === "landscape") {
        await expect(accountWorkspace.getByTestId("account-menu-scroll-cue")).toBeVisible();
        const [accountMenuBox, workspaceHeaderBox] = await Promise.all([
          accountMenu.boundingBox(),
          accountWorkspace.getByRole("heading", { name: "Workspace" }).locator("..").boundingBox()
        ]);
        expect(accountMenuBox).toBeTruthy();
        expect(workspaceHeaderBox).toBeTruthy();
        expect(accountMenuBox!.y).toBeGreaterThanOrEqual(
          workspaceHeaderBox!.y + workspaceHeaderBox!.height - 1
        );
      }
      const accountEmail = accountMenu.getByText("operator@aiqsa.local");
      await expect(accountEmail).toBeVisible();
      await expectWithinViewport(page, accountEmail);
      for (const name of ["Command palette", "Settings", "Control Center", "Sign out"]) {
        const action = accountMenu.getByRole("menuitem", { name });
        await expectTouchSafe(action);
        await expectWithinViewport(page, action);
        await action.click({ trial: true });
      }
      const [accountMenuBox, accountTriggerBox] = await Promise.all([
        accountMenu.boundingBox(),
        accountTrigger.boundingBox()
      ]);
      expect(accountMenuBox).toBeTruthy();
      expect(accountTriggerBox).toBeTruthy();
      expect(accountMenuBox!.y + accountMenuBox!.height).toBeLessThanOrEqual(accountTriggerBox!.y + 1);
      if (viewport.label === "landscape") {
        await page.keyboard.press("Escape");
        await accountTrigger.press("ArrowUp");
        const signOut = accountWorkspace.getByRole("menuitem", { name: "Sign out" });
        await expect(signOut).toBeFocused();
        await expectCenterUnobscured(signOut);
        await expectWithinViewport(page, signOut);
        await expect(accountWorkspace.getByTestId("account-menu-scroll-cue")).toHaveCount(0);
      }
      await page.keyboard.press("Escape");
      await expect(accountTrigger).toBeFocused();
      await accountWorkspace.getByRole("button", { name: "Close workspace" }).click();
      await expect(workspaceBrowseTrigger).toBeFocused();
      if (viewport.label === "landscape") {
        await page.getByRole("button", { name: "Share anonymously" }).click();
        const landscapeRevokeDialog = page.getByRole("dialog", { name: "Share anonymously" });
        await expect(landscapeRevokeDialog.getByTestId("share-links")).toBeVisible();
        await landscapeRevokeDialog.getByRole("button", { name: /Revoke link created/ }).click();
        await expect(landscapeRevokeDialog.getByTestId("share-links-empty")).toBeVisible();
        await landscapeRevokeDialog.getByRole("button", { name: "Close share dialog" }).click();
        await expect(landscapeRevokeDialog).toHaveCount(0);
      }

      const composer = page.getByRole("textbox", { name: "Message" });
      const messageLabel = page.locator('label[for="composer"]');
      await expect.poll(() => composer.evaluate((element) => getComputedStyle(element).fontSize)).toBe("16px");
      await expect(composer).toHaveAccessibleName("Message");
      await expect(messageLabel).toHaveText("Message");
      await expect(messageLabel).toBeVisible();
      const summary = composerRunSummary(page);
      await expect(summary).toBeVisible();
      await expectRunSummary(page, {
        model: "GPT-5.5",
        reasoning: "Standard · Medium",
        search: "Off"
      });
      const directModel = page.getByRole("button", { name: "Select model" }).first();
      await expect(directModel).not.toContainText("Model");
      await expectTouchSafe(summary);
      await expectWithinViewport(page, summary);

      let runSetup = await openRunSetup(page);
      await expectWithinViewport(page, runSetup);
      const useAssistant = runSetup.getByTestId("run-setup-use-assistant");
      await useAssistant.scrollIntoViewIfNeeded();
      await expect(useAssistant).toHaveText("Use an assistant…");
      await expectTouchSafe(useAssistant);
      await expectWithinViewport(page, useAssistant);
      await closeRunSetup(page);

      const thread = page.getByTestId("thread");
      await expect(page.getByTestId("composer-form")).not.toHaveAttribute(
        "data-reading-collapsed"
      );
      await thread.evaluate((element) => {
        element.scrollTop = 0;
        element.dispatchEvent(new Event("scroll"));
        element.dispatchEvent(new Event("touchmove", { bubbles: true }));
        element.scrollTop = 72;
        element.dispatchEvent(new Event("scroll"));
        element.scrollTop = 144;
        element.dispatchEvent(new Event("scroll"));
      });
      if (viewport.width < 640 || viewport.height <= 512) {
        await expect(page.getByTestId("composer-form")).toHaveAttribute(
          "data-reading-collapsed",
          "true"
        );
        await expect(page.getByTestId("composer-actions-disclosure")).toHaveAttribute(
          "aria-hidden",
          "true"
        );
        await expect(composer).toBeVisible();
        await composer.click();
        await expect(page.getByTestId("composer-form")).not.toHaveAttribute(
          "data-reading-collapsed"
        );
      } else {
        await expect(page.getByTestId("composer-form")).not.toHaveAttribute(
          "data-reading-collapsed"
        );
      }

      const contextGauge = page.getByTestId("token-stats-button");
      await expect(contextGauge).toHaveAccessibleName(/% of the .* safe input budget.*Open context details/);
      await contextGauge.click();
      const contextStats = page.getByTestId("token-stats-popover");
      await expect(contextStats).toContainText("Approximate input");
      await expect(contextStats).toContainText("Safe input budget");
      await expect(contextStats).toContainText("Total context");
      await expect(contextStats).toContainText("Safe budget used");
      await expectWithinViewport(page, contextStats);
      await expectNoHorizontalOverflow(page);
      await contextStats.getByRole("button", { name: "Close context and usage statistics" }).click();
      const composerBox = await page.getByTestId("composer-drop-zone").boundingBox();
      expect(composerBox).toBeTruthy();
      expect(composerBox!.height).toBeLessThanOrEqual(280);
      expect(composerBox!.x).toBeGreaterThanOrEqual(-1);
      expect(composerBox!.x + composerBox!.width).toBeLessThanOrEqual(viewport.width + 1);
      const composerFormBox = await page.getByTestId("composer-form").boundingBox();
      expect(composerFormBox).toBeTruthy();
      expect(composerFormBox!.x).toBeGreaterThanOrEqual(-1);
      expect(composerFormBox!.x + composerFormBox!.width).toBeLessThanOrEqual(viewport.width + 1);
      await expectTouchSafe(page.getByRole("button", { name: "Send message" }));
      await expectWithinViewport(page, page.getByRole("button", { name: "Send message" }));
      await expectTouchSafe(page.getByLabel("Attach file").locator(".."));
      const primaryActions = page.getByTestId("composer-primary-actions");
      const [primaryActionsBox, attachBox, sendBox] = await Promise.all([
        primaryActions.boundingBox(),
        page.getByLabel("Attach file").locator("..").boundingBox(),
        page.getByRole("button", { name: "Send message" }).boundingBox()
      ]);
      expect(primaryActionsBox).toBeTruthy();
      expect(attachBox).toBeTruthy();
      expect(sendBox).toBeTruthy();
      const actionCenter = primaryActionsBox!.y + primaryActionsBox!.height / 2;
      expect(Math.abs(attachBox!.y + attachBox!.height / 2 - actionCenter)).toBeLessThanOrEqual(2);
      expect(Math.abs(sendBox!.y + sendBox!.height / 2 - actionCenter)).toBeLessThanOrEqual(2);
      await expectWithinViewport(page, composer);

      const lastAssistant = page.locator('article[data-role="assistant"]').last();
      await lastAssistant.scrollIntoViewIfNeeded();
      const touchSurface = lastAssistant.locator('[data-message-interaction-surface="true"]');
      const touchActions = lastAssistant.getByRole("toolbar", { name: "Assistant message actions" });
      const restingTouchBackground = await touchSurface.evaluate(
        (element) => getComputedStyle(element).backgroundColor
      );
      await expect(touchActions).toBeHidden();
      await expect(lastAssistant.getByTestId("answer-metadata-block")).toHaveCount(0);
      await expect(lastAssistant.getByTestId("assistant-message-content")).toContainText(
        "Responsive latest bottom marker"
      );
      await lastAssistant.focus();
      await page.keyboard.press("Enter");
      await expect(lastAssistant).toHaveAttribute("data-mobile-controls-open", "true");
      await expect(touchActions).toBeVisible();
      for (const name of ["Regenerate message", "Edit message", "Copy message", "More message actions"]) {
        await page.keyboard.press("Tab");
        await expect(touchActions.getByRole("button", { name })).toBeFocused();
      }
      await lastAssistant.focus();
      await page.keyboard.press("Escape");
      await expect(lastAssistant).not.toHaveAttribute("data-mobile-controls-open", "true");
      await expect(touchActions).toBeHidden();
      await expect(lastAssistant).toBeFocused();

      await lastAssistant.getByTestId("assistant-message-content").click();
      await expect(lastAssistant).toHaveAttribute("data-mobile-controls-open", "true");
      await expect(touchActions).toBeVisible();
      await expect.poll(() =>
        touchSurface.evaluate((element) => getComputedStyle(element).backgroundColor)
      ).toBe(restingTouchBackground);
      for (const name of ["Regenerate message", "Edit message", "Copy message", "More message actions"]) {
        const action = touchActions.getByRole("button", { name });
        await expect(action).toBeVisible();
        await expectTouchSafe(action);
        await expectWithinViewport(page, action);
      }
      const messageMore = touchActions.getByRole("button", { name: "More message actions" });
      await messageMore.click();
      const messageMenu = page.getByRole("menu", { name: "More message actions" });
      await expectWithinViewport(page, messageMenu);
      for (const name of ["Show run details", "Delete message", "Branch from here"]) {
        const action = messageMenu.getByRole("menuitem", { name });
        await expectTouchSafe(action);
        await expectWithinViewport(page, action);
      }
      await page.keyboard.press("Escape");
      await expect(messageMore).toBeFocused();

      const artifactAssistant = page.locator('[data-message-id="responsive-assistant-2"]');
      const answerMetadata = artifactAssistant.getByTestId("answer-metadata-block");
      const searchSummary = artifactAssistant.getByTestId("thread-search-summary");
      const directSearchTrigger = searchSummary.getByRole("button", {
        name: /Search Perplexity Search.*Completed.*1 source.*1 citation/i
      });
      await expect(searchSummary).toBeVisible();
      await expect(directSearchTrigger).toHaveAttribute("aria-expanded", "false");
      await directSearchTrigger.click();
      await expect(directSearchTrigger).toHaveAttribute("aria-expanded", "true");
      await expect(searchSummary.getByTestId("thread-search-details")).toContainText("request-segment");
      await directSearchTrigger.click();
      await expect(answerMetadata).toHaveCount(0);
      await artifactAssistant.getByTestId("assistant-message-content").click({ position: { x: 8, y: 8 } });
      await expect(artifactAssistant).toHaveAttribute("data-mobile-controls-open", "true");
      const artifactActions = artifactAssistant.getByRole("toolbar", { name: "Assistant message actions" });
      await artifactActions.getByRole("button", { name: "More message actions" }).click();
      await page.getByRole("menuitem", { name: "Show run details" }).click();
      await expect(answerMetadata).toBeVisible();
      const searchReceiptTrigger = answerMetadata.getByRole("button", { name: "1 search call" });
      const citationReceiptTrigger = answerMetadata.getByRole("button", { name: "1 citation" });
      const reasoningReceiptTrigger = answerMetadata.getByRole("button", { name: "1 reasoning trace" });
      await searchReceiptTrigger.click();
      await citationReceiptTrigger.click();
      await reasoningReceiptTrigger.click();
      const citations = answerMetadata.getByTestId("thread-citations-block");
      const reasoning = page.getByTestId("thread-reasoning-block");
      await expect(searchSummary).toContainText("request-segment");
      await expect(citations).toContainText("Responsive evidence source");
      await expect(reasoning).toContainText("Responsive reasoning");
      for (const disclosure of [searchReceiptTrigger, citationReceiptTrigger, reasoningReceiptTrigger]) {
        await expectTouchSafe(disclosure);
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

      runSetup = await openRunSetup(page);
      await expectWithinViewport(page, runSetup);
      await expect(runSetup.getByRole("heading", { name: "Assistant" })).toBeVisible();
      await expect(runSetup.getByRole("heading", { name: "Generation" })).toBeVisible();
      await expect(runSetup.getByRole("heading", { name: "Next run" })).toBeVisible();
      await expect(runSetup.getByRole("heading", { name: "Display preferences" })).toBeVisible();
      await expect(runSetup.getByLabel("Temperature")).toBeVisible();

      const modelTrigger = runSetup.getByRole("button", { name: "Select model" });
      await modelTrigger.click();
      const modelPicker = page.getByTestId("model-picker");
      await expectWithinViewport(page, modelPicker);
      await expect(modelPicker.getByLabel("Search models")).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(modelTrigger).toBeFocused();
      await expect(runSetup).toBeVisible();

      const searchTrigger = runSetup.getByRole("button", { name: "Search strategy" });
      await searchTrigger.click();
      const searchPicker = page.getByTestId("search-select-options");
      await expectWithinViewport(page, searchPicker);
      await page.keyboard.press("Escape");
      await expect(searchTrigger).toBeFocused();

      const reasoningTrigger = runSetup.getByRole("button", { name: "Reasoning effort" });
      await reasoningTrigger.click();
      const reasoningPicker = runSetup.getByTestId("composer-reasoning-effort-options");
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
      await closeRunSetup(page);
      await expect(composerRunSummary(page)).toBeFocused();

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

      const accountRestoreTarget = await runAccountMenuAction(page, "Settings");
      const settings = page.getByTestId("settings-dialog");
      await expectWithinViewport(page, settings);
      await settings.getByRole("button", { name: "Close settings" }).click();
      await expect(accountRestoreTarget).toBeFocused();

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
      const firstUserMessage = page.locator('article[data-role="user"]').first();
      const firstUserActions = firstUserMessage.getByRole("toolbar", { name: "User message actions" });
      await expect(firstUserActions).toBeHidden();
      await firstUserMessage.focus();
      await page.keyboard.press("Space");
      await expect(firstUserMessage).toHaveAttribute("data-mobile-controls-open", "true");
      await expect(firstUserActions).toBeVisible();
      await firstUserMessage.focus();
      await page.keyboard.press("Escape");
      await expect(firstUserActions).toBeHidden();
      await expect(firstUserMessage).toBeFocused();
      await firstUserMessage.click();
      for (const name of ["Regenerate message", "Edit message", "Copy message", "More message actions"]) {
        const action = firstUserActions.getByRole("button", { name });
        await expect(action).toBeVisible();
        await expectTouchSafe(action);
      }
      await firstUserActions.getByRole("button", { name: "Edit message" }).click();
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
      await emitResponsiveTouchEvent(page, "done", { status: "cancelled" });
      await closeResponsiveTouchStream(page);
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

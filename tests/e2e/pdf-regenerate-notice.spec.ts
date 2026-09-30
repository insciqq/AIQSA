import { expect, test, type Page } from "@playwright/test";
import type { ChatDetailWire, ChatMessageWire } from "../../lib/contracts/chats";
import { decodeChatDetailResponse } from "../../lib/contracts/chats";
import type { ChatPdfPreparationWire } from "../../lib/contracts/chatPdfPreparation";
import { installMatrixCatalogFixture } from "./shell/catalogFixture";
import { createGatedRunStreamFixture } from "./support/gatedRunStream";
import { expectNoHorizontalOverflow, expectWithinViewport } from "./support/layoutAssertions";
import { signInWithLocalToken } from "./support/localAuth";

const timestamp = "2026-09-30T00:00:00.000Z";
const failedRunId = "pdf-failed-run";
const pendingRunId = "pdf-pending-retry-run";
const answerModel = "gpt-5.5";
const provider = "openai";

function message(input: Readonly<{
  content: string;
  id: string;
  modelRunId?: string | null;
  parentMessageId: string | null;
  role: "assistant" | "user";
  status: "cancelled" | "complete" | "error" | "streaming";
  pdfPreparation?: readonly ChatPdfPreparationWire[];
  errorMessage?: string | null;
}>): ChatMessageWire {
  return {
    citationMessageId: null,
    content: { blocks: [{ text: input.content, type: "text" }] },
    createdAt: timestamp,
    errorMessage: input.errorMessage ?? null,
    id: input.id,
    modelId: input.role === "assistant" ? answerModel : null,
    modelRunId: input.modelRunId ?? null,
    parentMessageId: input.parentMessageId,
    provider: input.role === "assistant" ? provider : null,
    role: input.role,
    status: input.status,
    ...(input.pdfPreparation ? { pdfPreparation: input.pdfPreparation } : {})
  };
}

function chat(input: Readonly<{
  id: string;
  title: string;
  activeLeafMessageId: string | null;
  messages: readonly ChatMessageWire[];
}>): ChatDetailWire {
  return {
    activeLeafMessageId: input.activeLeafMessageId,
    assistant: null,
    contextStats: { approximateActiveBranchInputTokens: 0 },
    createdAt: timestamp,
    defaultModelId: answerModel,
    defaultProvider: provider,
    folderId: null,
    id: input.id,
    messageCount: input.messages.length,
    messages: [...input.messages],
    pageInfo: {
      activeLeafMessageId: input.activeLeafMessageId,
      beforeCursor: null,
      hasOlder: false,
      snapshotUpdatedAt: timestamp
    },
    pinned: false,
    title: input.title,
    updatedAt: timestamp,
    usageStats: null
  };
}

test.use({ hasTouch: true });

async function chooseChat(page: Page, title: string) {
  const navigation = page.getByRole("complementary", { name: "Chat navigation" });
  if (!(await navigation.isVisible())) await page.getByRole("button", { name: "Open sidebar" }).click();
  await navigation.getByRole("treeitem", { name: title, exact: true }).click();
}

for (const viewport of [
  { width: 1440, height: 900, theme: "dark" },
  { width: 1180, height: 820, theme: "dark" },
  { width: 820, height: 1180, theme: "light" },
  { width: 390, height: 844, theme: "dark" },
  { width: 844, height: 390, theme: "light" }
] as const) {
  test(`PDF retry notice stays in its chat at ${viewport.width}x${viewport.height}`, async ({ page, context }, testInfo) => {
    test.setTimeout(90_000);
    await page.setViewportSize(viewport);
    await context.addCookies([{ name: "aiqsa.theme", value: viewport.theme, url: "http://127.0.0.1:3000" }]);

    const failedPdf: ChatPdfPreparationWire = {
      completedPages: 0,
      limitedReadingQuality: false,
      longDocument: false,
      pageCount: 1,
      phase: "failed",
      retryable: false,
      route: "selected_model_vision"
    };
    const preparingPdf: ChatPdfPreparationWire = { ...failedPdf, phase: "preparing" };
    const failedQuestion = message({ content: "Read this PDF.", id: "pdf-question", parentMessageId: null, role: "user", status: "complete" });
    const failedAnswer = message({ content: "", errorMessage: "Document preparation could not finish.", id: "pdf-failed-answer",
      modelRunId: failedRunId, parentMessageId: failedQuestion.id, pdfPreparation: [failedPdf], role: "assistant", status: "error" });
    const chatA = chat({ activeLeafMessageId: failedAnswer.id, id: "pdf-chat-a", messages: [failedQuestion, failedAnswer], title: "PDF retry" });
    const earlierQuestion = message({ content: "Earlier message.", id: "earlier-question", parentMessageId: null, role: "user", status: "complete" });
    const chatB = chat({ activeLeafMessageId: earlierQuestion.id, id: "pdf-chat-b", messages: [earlierQuestion], title: "Second chat" });

    // The second chat uses a real browser SSE consumer; the PDF path itself is
    // represented by the persisted wire projection above, so this test needs no
    // upload, parser sidecar or storage service.
    const secondChatStream = createGatedRunStreamFixture({
      abortMessage: "Synthetic second-chat stream stopped",
      key: "pdf-notice-second-chat",
      notReadyError: "pdf_notice_second_chat_stream_not_ready"
    });
    await secondChatStream.install(page, chatB.id);
    await installMatrixCatalogFixture(page, { chats: [chatA, chatB], folders: [] });
    await page.route("**/api/chats/compact?*", (route) => route.fulfill({ json: {
      chats: [chatA, chatB].map((detail) => ({ activeRun: detail.messages.some((item) => item.status === "streaming"),
        assistant: null, folderId: null, id: detail.id, title: detail.title, updatedAt: detail.updatedAt })),
      folders: [], nextCursor: null
    } }));
    for (const detail of [chatA, chatB]) {
      await page.route(`**/api/chats/${detail.id}`, (route) => {
        if (route.request().method() !== "GET") return route.fallback();
        expect(decodeChatDetailResponse({ chat: detail })).not.toBeNull();
        return route.fulfill({ json: { chat: detail } });
      });
    }
    await page.route("**/api/model-runs/second-run", (route) => route.fulfill({
      json: { version: 1, run: { id: "second-run", status: "complete" } }
    }));
    await page.route("**/api/me/mcp", (route) => route.fulfill({ json: { servers: [] } }));

    let retryPosts = 0;
    await page.route("**/api/messages/pdf-failed-answer/regenerate", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      expect(route.request().postDataJSON()).toMatchObject({ retryPdfPreparation: true });
      retryPosts += 1;
      // Simulate a conflict with an already admitted retry sibling. The shell
      // must reconcile without replaying or leaving its optimistic row behind.
      const pendingAnswer = message({ content: "", id: "pdf-retry-answer", modelRunId: pendingRunId,
        parentMessageId: failedQuestion.id, pdfPreparation: [preparingPdf],
        role: "assistant", status: "streaming" });
      chatA.messages = [failedQuestion, pendingAnswer];
      chatA.activeLeafMessageId = pendingAnswer.id;
      chatA.messageCount = 3;
      chatA.updatedAt = "2026-09-30T00:00:01.000Z";
      chatA.pageInfo = { ...chatA.pageInfo, activeLeafMessageId: pendingAnswer.id, snapshotUpdatedAt: chatA.updatedAt };
      await route.fulfill({ status: 409, json: { error: "active_run_in_progress" } });
    });
    await page.route(`**/api/model-runs/${pendingRunId}`, async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      await route.fulfill({ json: { version: 1, run: { id: pendingRunId, status: "streaming", pdfPreparation: [preparingPdf] } } });
    });

    await signInWithLocalToken(page, `/c/${chatA.id}`);
    await expect(page.getByRole("heading", { name: "Document preparation stopped" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Regenerate", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Regenerate", exact: true }).click();
    await expect.poll(() => retryPosts).toBe(1);
    await expect(page.getByTestId("shell-notice")).toContainText("Another response is still running. Stop it or wait for it to finish before sending.");
    await expect(page.getByRole("button", { name: /Stop(?: answer)?/u }).first()).toBeVisible({ timeout: 15_000 });
    await expectNoHorizontalOverflow(page);
    await expectWithinViewport(page, page.getByTestId("shell-notice"));
    await page.screenshot({ path: testInfo.outputPath("pdf-conflict.png") });

    // The canonical pending retry is now the visible active leaf and owns Stop.
    // Navigate away while its source notice still exists: B must remain usable.
    await chooseChat(page, chatB.title);
    await expect(page.getByTestId("shell-notice")).toHaveCount(0);
    const composer = page.getByRole("textbox", { name: "Message" });
    await expect(composer).toBeEnabled();
    await expectWithinViewport(page, composer);
    await expectNoHorizontalOverflow(page);

    const secondQuestion = message({ content: "A message from the second chat.", id: "second-question", parentMessageId: earlierQuestion.id, role: "user", status: "complete" });
    const secondAnswer = message({ content: "Second chat remains usable.", id: "second-answer", modelRunId: "second-run",
      parentMessageId: secondQuestion.id, role: "assistant", status: "complete" });
    await composer.fill("A message from the second chat.");
    await expect(page.getByRole("button", { name: "Send message" })).toBeEnabled();
    await composer.press("Enter");
    await secondChatStream.waitForRequestCount(page, 1);
    await secondChatStream.emit(page, "run_start", { modelId: answerModel, provider, runId: "second-run", status: "streaming" });
    await secondChatStream.emit(page, "message_start", { assistantMessageId: secondAnswer.id, userMessageId: secondQuestion.id });
    chatB.messages = [earlierQuestion, secondQuestion, secondAnswer];
    chatB.activeLeafMessageId = secondAnswer.id;
    chatB.messageCount = chatB.messages.length;
    chatB.updatedAt = "2026-09-30T00:00:02.000Z";
    chatB.pageInfo = { ...chatB.pageInfo, activeLeafMessageId: secondAnswer.id, snapshotUpdatedAt: chatB.updatedAt };
    await secondChatStream.emit(page, "chat_update", { chat: chatB, messages: chatB.messages });
    await secondChatStream.emit(page, "done", { runId: "second-run", status: "complete" });
    await secondChatStream.close(page);
    await expect(page.getByText("Second chat remains usable.", { exact: true })).toBeVisible();
    await expect(page.getByTestId("shell-notice")).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    await expectWithinViewport(page, composer);
    await page.screenshot({ path: testInfo.outputPath("second-chat.png") });

    await chooseChat(page, chatA.title);
    await expect(page.getByTestId("shell-notice")).toHaveCount(0);
    await expect(page.getByText("Document preparation stopped", { exact: true })).toHaveCount(0);
    await expect(page.getByTestId("run-status-line")).toContainText("Preparing document");
    await expect(page.getByRole("button", { name: "Stop answer", exact: true }).first()).toBeEnabled();
    expect(retryPosts).toBe(1);
  });
}

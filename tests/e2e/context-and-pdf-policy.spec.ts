import { expect, test } from "@playwright/test";
import type { AdminSystemModelPolicyCatalog } from "../../lib/contracts/adminSystemModelPolicy";
import type { ChatDetailWire, ChatMessageWire } from "../../lib/contracts/chats";
import type { RunOutcomeResponse } from "../../lib/contracts/runs";
import { matrixCatalog } from "./shell/catalog";
import { installMatrixCatalogFixture } from "./shell/catalogFixture";
import { expectNoHorizontalOverflow, expectWithinViewport } from "./support/layoutAssertions";
import { signInWithLocalToken } from "./support/localAuth";
import { createGatedRunStreamFixture } from "./support/gatedRunStream";

for (const viewport of [
  { width: 1440, height: 900, theme: "dark" },
  { width: 390, height: 844, theme: "light" }
] as const) {
  test(`context capacity, omitted history and rejected drafts remain actionable at ${viewport.width}px`, async ({ page, context }, testInfo) => {
    test.setTimeout(90_000);
    await page.setViewportSize(viewport);
    await context.addCookies([{ name: "aiqsa.theme", value: viewport.theme, url: "http://127.0.0.1:3000" }]);
    const catalog = structuredClone(matrixCatalog);
    const model = catalog.models[0]!;
    model.contextWindow = 10000;
    model.parameterControls.maxOutputTokens = { defaultValue: 1024, maxValue: 1024 };
    model.defaultParams = { ...model.defaultParams, maxTokens: 1024, maxOutputTokens: 1024 };
    const timestamp = "2026-09-12T00:00:00.000Z";
    const chat: ChatDetailWire = {
      id: "context-fixture", title: "Context estimate", createdAt: timestamp, updatedAt: timestamp,
      activeLeafMessageId: "context-answer", defaultModelId: model.modelId, defaultProvider: model.provider,
      folderId: null, pinned: false, messageCount: 1, usageStats: null,
      pageInfo: { activeLeafMessageId: "context-answer", beforeCursor: null, hasOlder: false, snapshotUpdatedAt: timestamp },
      contextStats: { approximateActiveBranchInputTokens: 1000, sessionMessageId: "context-answer", session: {
        approximateInputTokens: 6000, contextWindow: 10000, droppedMessages: 4, loadedTools: 3,
        maxOutputTokens: 1024, modelId: model.upstreamModelId, phase: "after_answer", provider: model.providerFamily,
        safetyMarginTokens: 1000, version: 1
      } },
      messages: [{ id: "context-answer", role: "assistant", status: "complete", parentMessageId: null,
        content: "The earlier answer remains here.", createdAt: timestamp, errorMessage: null,
        citationMessageId: null, modelId: model.modelId, modelRunId: "context-run", provider: model.provider }]
    };
    await page.addInitScript((id) => localStorage.setItem("aiqsa.activeChatId", id), chat.id);
    await installMatrixCatalogFixture(page, { chats: [chat], folders: [] }, { catalog });
    await page.route("**/api/me/mcp", (route) => route.fulfill({ json: { servers: [] } }));
    let continuations = 0;
    await page.route(`**/api/chats/${chat.id}/continue`, (route) => {
      continuations += 1;
      return route.fulfill({ status: 409, json: { error: "chat_summary_unavailable" } });
    });
    await signInWithLocalToken(page);
    const trigger = page.getByTestId("header-context-indicator");
    const dialog = page.getByRole("dialog", { name: "Chat context" });
    const composer = page.getByRole("textbox", { name: "Message" });
    async function captureMatrix(state: string) {
      if (viewport.width !== 1440) return;
      for (const theme of ["light", "dark"]) {
        await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
        for (const size of [
          { width: 1440, height: 900 }, { width: 900, height: 1440 },
          { width: 820, height: 1180 }, { width: 1180, height: 820 },
          { width: 390, height: 844 }, { width: 844, height: 390 }
        ]) {
          await page.setViewportSize(size);
          if (state === "details") {
            await dialog.getByText("Draft and attachments estimate", { exact: true }).scrollIntoViewIfNeeded();
            await expect(dialog.getByText("Request and answer estimate", { exact: true })).toBeInViewport();
            await expect(dialog.getByText("Draft and attachments estimate", { exact: true })).toBeInViewport();
          }
          await expectWithinViewport(page, dialog);
          await expectNoHorizontalOverflow(page);
          await page.screenshot({ path: testInfo.outputPath(`context-${state}-${theme}-${size.width}x${size.height}.png`) });
        }
      }
      await page.setViewportSize(viewport);
    }
    await expect(trigger).toHaveText("10%");
    await expect(trigger).toHaveAttribute("data-context-estimate", "preliminary");
    await expect(trigger.locator(".v2-chat-context-track")).toHaveAttribute("stroke-dasharray", "3 3");
    await trigger.click();
    await expect(dialog).toContainText("Preliminary estimate");
    await expect(dialog).not.toContainText("4 earlier messages");
    await page.screenshot({ path: testInfo.outputPath("context-cold-load.png") });
    await captureMatrix("preliminary");
    await page.keyboard.press("Escape");

    // A real composer submission captures its controls. Only that binding can
    // make the subsequent server status a matching snapshot in this document.
    const runId = "context-accepted-run";
    const stream = createGatedRunStreamFixture({ abortMessage: "Synthetic context stream stopped",
      key: "context-gauge", notReadyError: "synthetic_context_stream_not_ready" });
    await stream.installCurrent(page, chat.id);
    await page.route(`**/api/chats/${chat.id}/active-leaf`, (route) => route.fulfill({ json: { ok: true } }));
    let finished = false;
    await page.route(`**/api/model-runs/${runId}`, (route) => {
      const response: RunOutcomeResponse = { version: 1, run: { id: runId, status: finished ? "complete" : "streaming" } };
      return route.fulfill({ json: response });
    });
    await composer.fill("Continue this conversation.");
    await composer.press("Enter");
    await stream.waitForRequestCount(page, 1);
    await stream.emit(page, "run_start", { modelId: model.modelId, provider: model.provider, runId, status: "streaming" });
    await stream.emit(page, "message_start", { assistantMessageId: "context-next-answer", userMessageId: "context-next-question" });
    await stream.emit(page, "artifact", { artifactType: "context_status", payload: {
      ...chat.contextStats.session!, approximateInputTokens: 5900, phase: "request"
    } });
    await expect(trigger).toHaveText("59%");
    await expect(trigger).toHaveAttribute("data-context-estimate", "snapshot");
    await page.screenshot({ path: testInfo.outputPath("context-live-request.png") });
    const question: ChatMessageWire = {
      citationMessageId: null, content: "Continue this conversation.", createdAt: timestamp,
      errorMessage: null, id: "context-next-question", modelId: null, modelRunId: null,
      parentMessageId: chat.activeLeafMessageId, provider: null, role: "user", status: "complete"
    };
    const answer: ChatMessageWire = { ...question, content: "The next answer is ready.",
      id: "context-next-answer", modelId: model.modelId, modelRunId: runId,
      parentMessageId: question.id, provider: model.provider, role: "assistant" };
    chat.messages = [...chat.messages, question, answer];
    chat.messageCount = chat.messages.length;
    chat.activeLeafMessageId = answer.id;
    chat.pageInfo.activeLeafMessageId = answer.id;
    chat.contextStats.sessionMessageId = answer.id;
    chat.updatedAt = "2026-09-12T00:00:01.000Z";
    chat.pageInfo.snapshotUpdatedAt = chat.updatedAt;
    await installMatrixCatalogFixture(page, { chats: [chat], folders: [] }, { catalog });
    await stream.emit(page, "artifact", { artifactType: "context_status", payload: chat.contextStats.session });
    await stream.emit(page, "chat_update", { chat, messages: chat.messages });
    finished = true;
    await stream.emit(page, "done", { runId, status: "complete" });
    await stream.close(page);
    await expect(trigger).toHaveText("60%");
    await expect(trigger).toHaveAttribute("data-context-estimate", "snapshot");
    await expect(trigger.locator(".v2-chat-context-track")).not.toHaveAttribute("stroke-dasharray");
    await trigger.click();
    await expect(dialog).toContainText("4 earlier messages are still in this chat");
    await expect(dialog).toContainText("project files are copied into the new chat. Attachments are not carried over.");
    expect(continuations).toBe(0);
    await dialog.getByRole("button", { name: "Stay here" }).click();
    await trigger.click();
    await dialog.getByText("Advanced details").click();
    await expect(dialog).toContainText("Safe input budget");
    await expect(dialog).toContainText("Answer reserve");
    await expect(dialog).toContainText("Safety margin");
    await expectWithinViewport(page, dialog);
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: testInfo.outputPath("context-capacity.png") });
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
    await composer.fill("a".repeat(4000));
    await expect(trigger).toHaveText("70%");
    await expect(trigger).toHaveAttribute("data-context-estimate", "snapshot");
    await expect(trigger).toHaveAttribute("data-context-tone", "warning");
    await trigger.click();
    await expect(dialog).toContainText("plus your draft and attachments");
    await expect(dialog).toContainText("Draft and attachments estimate");
    await page.screenshot({ path: testInfo.outputPath("context-with-draft.png") });
    await captureMatrix("draft");
    await dialog.getByText("Advanced details", { exact: true }).click();
    await expect(dialog.getByText("Request and answer estimate", { exact: true })).toBeVisible();
    await expect(dialog.getByText("Draft and attachments estimate", { exact: true })).toBeVisible();
    await captureMatrix("details");
    await page.keyboard.press("Escape");
    await composer.fill("界".repeat(4000));
    await expect(trigger).toHaveText("100%");
    await expect(trigger).toHaveAttribute("data-context-tone", "critical");
    await composer.fill("");
    await expect(trigger).toHaveText("60%");
    await page.reload();
    await expect(trigger).toHaveText("10%");
    await expect(trigger).toHaveAttribute("data-context-estimate", "preliminary");
    await expect(dialog).toBeHidden();
    await page.route(`**/api/chats/${chat.id}/messages`, (route) => route.fulfill({
      status: 400, json: { error: "context_too_large", message: "This request cannot fit in the model context window." }
    }));
    await composer.fill("a request rejected after private context is measured");
    await composer.press("Enter");
    await expect(composer).toHaveValue("a request rejected after private context is measured");
    await expect(trigger).toHaveAccessibleName("This request exceeds the model context capacity");
    await expect(trigger).toHaveAttribute("data-context-tone", "critical");
    await expect(trigger).toHaveAttribute("data-context-estimate", "preliminary");
    await expect(trigger.locator(".v2-chat-context-track")).toHaveAttribute("stroke-dasharray", "3 3");
    await expect(trigger.locator("svg")).toHaveCSS("animation-name", "none");
    await expect(trigger.locator(".v2-chat-context-track")).toHaveCSS("animation-name", "none");
    await trigger.click();
    await expect(dialog.getByRole("alert")).toContainText("Shorten the message, remove attachments");
    await expect(dialog).toContainText("Preliminary estimate");
    await page.screenshot({ path: testInfo.outputPath("context-preliminary-rejected.png") });
    await dialog.getByRole("button", { name: "Summarize and open new chat" }).click();
    await expect.poll(() => continuations).toBe(1);
    await expect(dialog.getByRole("alert").last()).toContainText("Summaries are unavailable");
    await expect(page.getByText("The earlier answer remains here.", { exact: true })).toBeVisible();
  });
}

test("PDF modes keep independent reader assignments through refresh and compact layout", async ({ page }, testInfo) => {
  const base = { connectionId: "fixture", connectionDisplayName: "Fixture provider", defaultReasoningEffort: null,
    reasoningEfforts: [], forcedToolCall: "unsupported" as const, structuredOutput: "unsupported" as const };
  const native = { ...base, id: "native-reader", displayName: "Native document reader", pdfInput: "verified" as const, visionInput: "not_verified" as const };
  const images = { ...base, id: "image-reader", displayName: "Page image reader", pdfInput: "unsupported" as const, visionInput: "verified" as const };
  const roles: AdminSystemModelPolicyCatalog = {
    candidates: [], titleCandidates: [], documentCandidates: [native, images], verificationCandidates: [], rerankerCandidates: [],
    ineligible: { chat_titles: [], direct_pdf: [], memory: [], vision: [] },
    policy: { systemModel: null, reasoningEffort: null, chatTitleModel: null, chatTitleReasoningEffort: null,
      chatPdfNativeModel: { ...native, available: true }, chatPdfNativeReasoningEffort: null,
      chatPdfModel: { ...images, available: true }, chatPdfReasoningEffort: null,
      chatPdfProcessingMode: "prefer_chat_model", chatPdfFallbackMethod: "page_images", rerankerModel: null,
      updatedAt: "2026-09-12T00:00:00.000Z", updatedBy: null, version: 1 }
  };
  const patches: Record<string, unknown>[] = [];
  await page.route("**/api/admin/providers/system-model-policy", async (route) => {
    if (route.request().method() === "PATCH") {
      const patch = route.request().postDataJSON(); patches.push(patch);
      if (patch.chatPdfProcessingMode) roles.policy.chatPdfProcessingMode = patch.chatPdfProcessingMode;
      if (patch.chatPdfFallbackMethod) roles.policy.chatPdfFallbackMethod = patch.chatPdfFallbackMethod;
      roles.policy.version += 1;
    }
    await route.fulfill({ json: { systemModelPolicy: roles } });
  });
  await signInWithLocalToken(page);
  await page.goto("/admin?section=roles");
  const mode = page.getByRole("combobox", { name: "Processing mode", exact: true });
  const fallback = page.getByRole("combobox", { name: "Fallback method", exact: true });
  await expect(mode).toHaveValue("prefer_chat_model");
  await fallback.selectOption("pdf_reader");
  await expect(fallback).toBeEnabled();
  await mode.selectOption("use_pdf_reader");
  await expect(fallback).toHaveCount(0);
  await expect(page.getByRole("button", { name: "PDF reader deployment", exact: true })).toContainText(native.displayName);
  await expect(page.getByRole("button", { name: "Page-image reader deployment", exact: true })).toHaveCount(0);
  await page.reload();
  await expect(mode).toHaveValue("use_pdf_reader");
  await mode.selectOption("read_page_images");
  await expect(mode).toBeEnabled();
  await expect(page.getByRole("button", { name: "PDF reader deployment", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Page-image reader deployment", exact: true })).toContainText(images.displayName);
  await mode.selectOption("prefer_chat_model");
  await expect(fallback).toHaveValue("pdf_reader");
  for (const profile of [{ width: 1440, height: 900, theme: "dark" }, { width: 390, height: 844, theme: "light" }, { width: 844, height: 390, theme: "dark" }]) {
    await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, profile.theme);
    await page.setViewportSize(profile);
    await mode.scrollIntoViewIfNeeded();
    await expectWithinViewport(page, mode);
    await expectNoHorizontalOverflow(page);
  }
  expect(patches).toHaveLength(4);
  for (const patch of patches) {
    expect(patch).not.toHaveProperty("chatPdfNativeProviderModelId");
    expect(patch).not.toHaveProperty("chatPdfProviderModelId");
  }
  await page.screenshot({ path: testInfo.outputPath("pdf-policy.png") });
});

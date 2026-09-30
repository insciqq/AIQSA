import { expect, test, type Page } from "@playwright/test";
import type { AdminSystemModelPolicyCatalog } from "../../lib/contracts/adminSystemModelPolicy";
import type { ChatDetailWire, ChatMessageWire } from "../../lib/contracts/chats";
import type { RunOutcomeResponse } from "../../lib/contracts/runs";
import { calculateContextBudgetLimits } from "../../lib/domain/contextBudget";
import { chooseReasoningEffort, selectModel } from "./shell/composer";
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
    test.setTimeout(180_000);
    await page.setViewportSize(viewport);
    await context.addCookies([{ name: "aiqsa.theme", value: viewport.theme, url: "http://127.0.0.1:3000" }]);
    const catalog = structuredClone(matrixCatalog);
    const model = catalog.models[0]!;
    model.contextWindow = 10000;
    model.parameterControls.maxOutputTokens = { defaultValue: 1024, maxValue: 1024 };
    model.defaultParams = { ...model.defaultParams, maxTokens: 1024, maxOutputTokens: 1024 };
    const widerModel = catalog.models[1]!;
    widerModel.contextWindow = 20000;
    widerModel.parameterControls.maxOutputTokens = { defaultValue: 1024, maxValue: 1024 };
    widerModel.defaultParams = { ...widerModel.defaultParams, maxTokens: 1024, maxOutputTokens: 1024 };
    const unknownModel = catalog.models[2]!;
    unknownModel.contextWindow = null;
    const timestamp = "2026-09-12T00:00:00.000Z";
    const chat: ChatDetailWire = {
      assistant: null,
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
    const otherChats = [1, 2, 3].map((index) => ({
      ...chat, id: `context-other-${index}`, title: `Context other ${index}`, activeLeafMessageId: null,
      messageCount: 0, messages: [], contextStats: { approximateActiveBranchInputTokens: 0 },
      pageInfo: { ...chat.pageInfo, activeLeafMessageId: null }
    }));
    await installMatrixCatalogFixture(page, { chats: [chat, ...otherChats], folders: [] }, { catalog });
    await page.route("**/api/chats/compact?*", route => route.fulfill({ json: {
      chats: [chat, ...otherChats].map(item => ({ id: item.id, title: item.title,
        folderId: null, assistant: null, activeRun: false, updatedAt: item.updatedAt })),
      folders: [], nextCursor: null
    } }));
    await page.route("**/api/me/mcp", (route) => route.fulfill({ json: { servers: [] } }));
    let continuations = 0;
    await page.route(`**/api/chats/${chat.id}/continue`, (route) => {
      continuations += 1;
      return route.fulfill({ status: 409, json: { error: "chat_summary_unavailable" } });
    });
    await signInWithLocalToken(page, `/c/${chat.id}`);
    const trigger = page.getByTestId("header-context-indicator");
    const dialog = page.getByRole("dialog", { name: "Chat context" });
    const composer = page.getByRole("textbox", { name: "Message" });
    const lastReply = dialog.getByText("Based on the last reply.", { exact: true });
    const settingsChanged = dialog.getByText("Based on the last reply. Settings changed since.", { exact: true });
    // A phone has no gauge: "⋯" opens the context panel as a bottom sheet.
    const phone = viewport.width < 768;
    const more = page.getByTestId("header-more-trigger");
    async function openContext() {
      if (!phone) return trigger.click();
      await more.click();
      await page.getByRole("menuitem", { name: /^Context/u }).click();
    }
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
    await expect(trigger).toHaveText("60%");
    await expect(trigger).toHaveAttribute("data-context-estimate", "snapshot");
    await expect(trigger.locator(".v2-chat-context-track")).not.toHaveAttribute("stroke-dasharray");
    // A persisted warning never opens a continuation automatically.
    await expect(dialog).toBeHidden();
    await openContext();
    // A cold load changed nothing: the chat's own defaults are not "settings changed".
    await expect(lastReply).toBeVisible();
    await expect(dialog).not.toContainText("Settings changed since.");
    await expect(dialog).toContainText("4 earlier messages");
    await page.screenshot({ path: testInfo.outputPath("context-cold-load.png") });
    await captureMatrix("measured");
    await page.keyboard.press("Escape");
    await chooseReasoningEffort(page, "high");
    await expect(trigger).toHaveText("60%");
    await openContext();
    await expect(settingsChanged).toBeVisible();
    await expect(lastReply).toHaveCount(0);
    await captureMatrix("settings-changed");
    await page.keyboard.press("Escape");
    await selectModel(page, widerModel.provider, widerModel.displayName);
    await expect(trigger).toHaveText("30%");
    await expect(trigger).toHaveAttribute("data-context-estimate", "snapshot");
    await openContext();
    await expect(settingsChanged).toBeVisible();
    await dialog.getByText("Advanced details", { exact: true }).click();
    await expect(dialog.locator("dl > div").filter({ has: page.getByText("Context tokens", { exact: true }) })).toContainText("~6k");
    await expect(dialog.locator("dl > div").filter({ has: page.getByText("Safe input budget", { exact: true }) })).toContainText("17k");
    await page.keyboard.press("Escape");
    await selectModel(page, unknownModel.provider, unknownModel.displayName);
    await expect(trigger).toHaveText("?");
    await expect(trigger).toHaveAttribute("data-context-estimate", "snapshot");
    await openContext();
    await captureMatrix("unknown");
    await page.keyboard.press("Escape");
    await selectModel(page, model.provider, model.displayName);
    const chooseChat = async (title: string) => {
      const navigation = page.getByRole("complementary", { name: "Chat navigation" });
      if (!(await navigation.isVisible())) await page.getByRole("button", { name: "Open sidebar" }).click();
      await navigation.getByRole("treeitem", { name: title, exact: true }).click();
    };
    for (const other of otherChats) {
      await chooseChat(other.title);
      await expect(trigger).toHaveAttribute("data-context-estimate", "preliminary");
    }
    await openContext();
    await expect(dialog).toContainText("Preliminary estimate");
    await captureMatrix("preliminary");
    await page.keyboard.press("Escape");
    await chooseChat(chat.title);
    await expect(trigger).toHaveText("60%");
    await expect(trigger).toHaveAttribute("data-context-estimate", "snapshot");
    // Returning after cache eviction is a fresh load, not a settings change.
    await openContext();
    await expect(lastReply).toBeVisible();
    await expect(dialog).not.toContainText("Settings changed since.");
    await page.keyboard.press("Escape");

    // A new run still takes live measurement priority over the saved snapshot.
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
    await openContext();
    await expect(dialog).toContainText("4 earlier messages are still in this chat");
    await expect(dialog.getByText("A new chat starts with a summary of this one and takes your draft, files and settings (and Workspace files, if on). This chat stays as it is.")).toBeVisible();
    expect(continuations).toBe(0);
    await dialog.getByRole("button", { name: "Stay here" }).click();
    await openContext();
    await dialog.getByText("Advanced details").click();
    await expect(dialog).toContainText("Safe input budget");
    await expect(dialog).toContainText("Answer reserve");
    await expect(dialog).toContainText("Safety margin");
    await expectWithinViewport(page, dialog);
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: testInfo.outputPath("context-capacity.png") });
    await page.keyboard.press("Escape");
    await expect(phone ? more : trigger).toBeFocused();
    await composer.fill("a".repeat(4000));
    await expect(trigger).toHaveText("70%");
    await expect(trigger).toHaveAttribute("data-context-estimate", "snapshot");
    await expect(trigger).toHaveAttribute("data-context-tone", "warning");
    await openContext();
    await expect(dialog).toContainText("Based on the last reply and your draft.");
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
    await openContext();
    await expect(dialog.getByRole("alert")).toContainText("No room left for this request.");
    await captureMatrix("critical");
    await page.keyboard.press("Escape");
    await composer.fill("");
    await expect(trigger).toHaveText("60%");
    await page.reload();
    await expect(trigger).toHaveText("60%");
    await expect(trigger).toHaveAttribute("data-context-estimate", "snapshot");
    await expect(dialog).toBeHidden();
    await openContext();
    await expect(lastReply).toBeVisible();
    await expect(dialog).not.toContainText("Settings changed since.");
    await page.keyboard.press("Escape");
    await page.route(`**/api/chats/${chat.id}/messages`, (route) => route.fulfill({
      status: 400, json: { error: "context_too_large", message: "This request cannot fit in the model context window." }
    }));
    await composer.fill("a request rejected after private context is measured");
    await composer.press("Enter");
    if (phone) {
      // On a phone each rejected request opens the modal sheet by itself.
      await expect(dialog).toBeVisible();
      await page.keyboard.press("Escape");
    }
    await expect(composer).toHaveValue("a request rejected after private context is measured");
    if (phone) await expect(trigger).toHaveAttribute("aria-label", "This request exceeds the model context capacity");
    else await expect(trigger).toHaveAccessibleName("This request exceeds the model context capacity");
    await expect(trigger).toHaveAttribute("data-context-tone", "critical");
    await expect(trigger).toHaveAttribute("data-context-estimate", "preliminary");
    await expect(trigger.locator(".v2-chat-context-track")).toHaveAttribute("stroke-dasharray", "3 3");
    await expect(trigger.locator("svg")).toHaveCSS("animation-name", "none");
    await expect(trigger.locator(".v2-chat-context-track")).toHaveCSS("animation-name", "none");
    await openContext();
    await expect(dialog.getByRole("alert")).toContainText("Shorten it, remove attachments");
    await expect(dialog).toContainText("Preliminary estimate");
    await page.screenshot({ path: testInfo.outputPath("context-preliminary-rejected.png") });
    await dialog.getByRole("button", { name: "Summarize and open new chat" }).click();
    await expect.poll(() => continuations).toBe(1);
    await expect(dialog.getByRole("alert").last()).toContainText("Summaries are unavailable");
    await expect(page.getByText("The earlier answer remains here.", { exact: true })).toBeVisible();
  });
}

function stoppedOrAnsweredChat(status: "cancelled" | "complete"): ChatDetailWire {
  const model = matrixCatalog.models[0]!;
  const timestamp = "2026-09-30T00:00:00.000Z";
  const id = status === "cancelled" ? "context-stopped" : "context-ordinary";
  // The server measures with the same limits the client derives for the model's default answer reserve.
  const limits = calculateContextBudgetLimits({ contextWindow: model.contextWindow!,
    maxOutputTokens: model.parameterControls.maxOutputTokens.defaultValue, provider: model.providerFamily });
  return {
    assistant: null, id, title: status === "cancelled" ? "Stopped answer" : "Ordinary context",
    createdAt: timestamp, updatedAt: timestamp, activeLeafMessageId: `${id}-answer`,
    defaultModelId: model.modelId, defaultProvider: model.provider, folderId: null, pinned: false, messageCount: 2,
    usageStats: { hasCompletedAnswer: true, totalTokens: 1840, estimatedCostMicros: 2500, recordCount: 1,
      knownCostRecordCount: 1, incompleteRecordCount: 0 },
    pageInfo: { activeLeafMessageId: `${id}-answer`, beforeCursor: null, hasOlder: false, snapshotUpdatedAt: timestamp },
    contextStats: { approximateActiveBranchInputTokens: 300, sessionMessageId: `${id}-answer`, session: {
      approximateInputTokens: 1800, contextWindow: limits.contextWindow, droppedMessages: 0, loadedTools: 0,
      maxOutputTokens: limits.maxOutputTokens, modelId: model.upstreamModelId,
      // A stopped run keeps only the measurement taken when its request was dispatched.
      phase: status === "cancelled" ? "request" : "after_answer", provider: model.providerFamily,
      safetyMarginTokens: limits.safetyMarginTokens, version: 1
    } },
    messages: [
      { id: `${id}-question`, role: "user", status: "complete", parentMessageId: null, content: "A short question.",
        createdAt: timestamp, errorMessage: null, citationMessageId: null, modelId: null, modelRunId: null, provider: null },
      { id: `${id}-answer`, role: "assistant", status, parentMessageId: `${id}-question`,
        content: status === "cancelled" ? "A partial answer" : "A complete answer.", createdAt: timestamp,
        errorMessage: null, citationMessageId: null, modelId: model.modelId, modelRunId: `${id}-run`, provider: model.provider }
    ]
  };
}

async function openFixtureChat(page: Page, chat: ChatDetailWire) {
  await installMatrixCatalogFixture(page, { chats: [chat], folders: [] });
  await page.route("**/api/chats/compact?*", route => route.fulfill({ json: {
    chats: [{ id: chat.id, title: chat.title, folderId: null, assistant: null, activeRun: false, updatedAt: chat.updatedAt }],
    folders: [], nextCursor: null
  } }));
  await page.route("**/api/me/mcp", (route) => route.fulfill({ json: { servers: [] } }));
  await signInWithLocalToken(page, `/c/${chat.id}`);
  await expect(page.getByTestId("header-title")).toHaveText(chat.title);
}

test("a stopped answer's request measurement reads as the last request after reload and keeps its spending", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openFixtureChat(page, stoppedOrAnsweredChat("cancelled"));
  const trigger = page.getByTestId("header-context-indicator");
  const dialog = page.getByRole("dialog", { name: "Chat context" });
  for (const load of ["first load", "reload"]) {
    if (load === "reload") await page.reload();
    await expect(trigger).toHaveAttribute("data-context-estimate", "snapshot");
    // Nothing runs: neither the ring's title nor the popover claims a current request.
    await expect(trigger).toHaveAttribute("title", /\. Based on the last request\.$/u);
    await trigger.click();
    await expect(dialog.getByText("Based on the last request.", { exact: true })).toBeVisible();
    await expect(dialog).not.toContainText("current request");
    await expect(dialog.getByRole("group", { name: "Spent" })).toContainText("1,840");
    await page.screenshot({ path: testInfo.outputPath(`context-stopped-${load.replace(" ", "-")}.png`) });
    await page.keyboard.press("Escape");
  }
});

test.describe("touch context popover", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  test("shows the carry-over explanation as text in the ordinary state without hover", async ({ page }, testInfo) => {
    await openFixtureChat(page, stoppedOrAnsweredChat("complete"));
    expect(await page.evaluate(() => matchMedia("(hover: none)").matches)).toBe(true);
    const trigger = page.getByTestId("header-context-indicator");
    const dialog = page.getByRole("dialog", { name: "Chat context" });
    // A phone has no gauge: "⋯" opens the panel as a bottom sheet.
    await expect(trigger).toBeHidden();
    await page.getByTestId("header-more-trigger").tap();
    await page.getByRole("menuitem", { name: /^Context · \d+%$/u }).tap();
    await expect(dialog).toHaveAttribute("data-layout", "sheet");
    const action = dialog.getByRole("button", { name: "Summarize and open new chat", exact: true });
    await expect(action).toHaveAttribute("data-tone", "ghost");
    await expect(dialog.getByRole("button", { name: "Stay here" })).toHaveCount(0);
    const note = dialog.getByText("A new chat starts with a summary of this one and takes your draft, files and settings (and Workspace files, if on). This chat stays as it is.", { exact: true });
    await expect(note).toBeVisible();
    const [actionBox, noteBox] = await Promise.all([action.boundingBox(), note.boundingBox()]);
    expect(noteBox!.y).toBeGreaterThanOrEqual(actionBox!.y + actionBox!.height - 1);
    expect(noteBox!.y - (actionBox!.y + actionBox!.height)).toBeLessThan(24);
    await expectWithinViewport(page, dialog);
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: testInfo.outputPath("context-ordinary-touch-phone.png") });
    await dialog.getByRole("button", { name: "Close chat context" }).tap();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId("header-more-trigger")).toBeFocused();
    // A touch tablet keeps the gauge in its header.
    await page.setViewportSize({ width: 820, height: 1180 });
    await expect(trigger).toBeVisible();
  });
});

test("PDF modes keep independent reader assignments through refresh and compact layout", async ({ page }, testInfo) => {
  const base = { connectionId: "fixture", connectionDisplayName: "Fixture provider", defaultReasoningEffort: null,
    reasoningEfforts: [], forcedToolCall: "unsupported" as const, structuredOutput: "unsupported" as const };
  const native = { ...base, id: "native-reader", displayName: "Native document reader", pdfInput: "verified" as const, visionInput: "not_verified" as const };
  const images = { ...base, id: "image-reader", displayName: "Page image reader", pdfInput: "unsupported" as const, visionInput: "verified" as const };
  const roles: AdminSystemModelPolicyCatalog = {
    memoryPolicy: { model: null, reasoningEffort: null, version: 1, assignmentSource: "unassigned" },
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

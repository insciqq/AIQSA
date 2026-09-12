import { expect, test } from "@playwright/test";
import type { AdminSystemModelPolicyCatalog } from "../../lib/contracts/adminSystemModelPolicy";
import type { ChatDetailWire } from "../../lib/contracts/chats";
import { matrixCatalog } from "./shell/catalog";
import { installMatrixCatalogFixture } from "./shell/catalogFixture";
import { expectNoHorizontalOverflow, expectWithinViewport } from "./support/layoutAssertions";
import { signInWithLocalToken } from "./support/localAuth";

for (const viewport of [
  { width: 1440, height: 900, theme: "dark" },
  { width: 390, height: 844, theme: "light" }
] as const) {
  test(`context capacity, omitted history and rejected drafts remain actionable at ${viewport.width}px`, async ({ page, context }, testInfo) => {
    test.setTimeout(60_000);
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
    await expect(trigger).toHaveText("60%");
    await expect(dialog).toContainText("4 earlier messages are still in this chat");
    await expect(dialog).toContainText("Files and Workspace won’t be carried over");
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
    const composer = page.getByRole("textbox", { name: "Message" });
    await composer.fill("a".repeat(4000));
    await expect(trigger).toHaveText("20%");
    await composer.fill("界".repeat(4000));
    await expect(trigger).toHaveText("50%");
    await composer.fill("");
    await expect(trigger).toHaveText("60%");
    await page.reload();
    await expect(trigger).toHaveText("60%");
    await expect(dialog).toBeHidden();
    await page.route(`**/api/chats/${chat.id}/active-leaf`, (route) => route.fulfill({ json: { ok: true } }));
    await page.route(`**/api/chats/${chat.id}/messages`, (route) => route.fulfill({
      status: 400, json: { error: "context_too_large", message: "This request cannot fit in the model context window." }
    }));
    await composer.fill("a request rejected after private context is measured");
    await composer.press("Enter");
    await expect(composer).toHaveValue("a request rejected after private context is measured");
    await expect(trigger).toHaveAccessibleName("This request exceeds the model context capacity");
    await expect(trigger).toHaveAttribute("data-context-tone", "critical");
    await trigger.click();
    await expect(dialog.getByRole("alert")).toContainText("Shorten the message, remove attachments");
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

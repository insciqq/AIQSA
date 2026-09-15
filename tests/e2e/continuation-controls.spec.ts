import { expect, test } from "@playwright/test";
import type { ChatDetailWire } from "../../lib/contracts/chats";
import { matrixCatalog } from "./shell/catalog";
import { installMatrixCatalogFixture } from "./shell/catalogFixture";
import { chooseSearchStrategy, closeRunSetup, openRunSetup, selectModel } from "./shell/composer";
import { expectNoHorizontalOverflow, expectWithinViewport } from "./support/layoutAssertions";
import { signInWithLocalToken } from "./support/localAuth";

for (const width of [1440, 390]) {
  test(`continuation preserves controls, current input and focus at ${width}px`, async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height: 900 });
    const catalog = structuredClone(matrixCatalog);
    const chosen = { ...structuredClone(catalog.models[0]!), modelId: "continuation-model", displayName: "Continuation model" };
    catalog.models.push(chosen);
    const timestamp = "2026-09-15T00:00:00.000Z";
    function chat(id: string, text: string): ChatDetailWire {
      return { id, title: id === "source" ? "Source conversation" : "Continued conversation", createdAt: timestamp, updatedAt: timestamp,
        activeLeafMessageId: `${id}-answer`, defaultModelId: id === "source" ? catalog.models[0]!.modelId : chosen.modelId,
        defaultProvider: chosen.provider, folderId: null, pinned: false, messageCount: 1, usageStats: null,
        hasContinuationSource: id !== "source", workspace: { available: true, enabled: true, internetEnabled: false, sessionState: null },
        contextStats: { approximateActiveBranchInputTokens: 100 },
        pageInfo: { activeLeafMessageId: `${id}-answer`, beforeCursor: null, hasOlder: false, snapshotUpdatedAt: timestamp },
        messages: [{ id: `${id}-answer`, role: "assistant", status: "complete", parentMessageId: null, content: text,
          createdAt: timestamp, errorMessage: null, citationMessageId: null, modelId: null, modelRunId: null, provider: null }] };
    }
    const source = chat("source", "The source conversation stays here.");
    const target = chat("continued", "Conversation summary ready.");
    await page.addInitScript(() => localStorage.setItem("aiqsa.activeChatId", "source"));
    await installMatrixCatalogFixture(page, { chats: [source, target], folders: [] }, { catalog });
    await page.route("**/api/me/mcp", (route) => route.fulfill({ json: { servers: [] } }));
    await page.route("**/api/me/chats/*/memory-mode", (route) => route.fulfill({ json: {
      allowedActions: ["EXCLUDE"], archived: false, mode: "NORMAL", temporaryRetentionDeadline: null
    } }));
    let releaseUpload!: () => void;
    const uploadGate = new Promise<void>((resolve) => { releaseUpload = resolve; });
    let uploaded = 0;
    await page.route("**/api/uploads", async (route) => {
      const number = ++uploaded;
      await uploadGate;
      await route.fulfill({ json: { attachment: { id: `attachment-${number}`, fileName: `draft-${number}.pdf`, kind: "pdf", status: "ready", pageCount: 1 } } });
    });
    let releaseSummary!: () => void;
    const summaryGate = new Promise<void>((resolve) => { releaseSummary = resolve; });
    let selected: unknown;
    await page.route("**/api/chats/source/continue", async (route) => {
      selected = route.request().postDataJSON().modelSelection;
      await summaryGate;
      await route.fulfill({ json: { status: "complete", chatId: target.id, projectId: null } });
    });
    await signInWithLocalToken(page);
    const composer = page.getByRole("textbox", { name: "Message" });
    await selectModel(page, chosen.provider, chosen.displayName);
    await chooseSearchStrategy(page, "Perplexity");
    let parameters = await openRunSetup(page);
    await parameters.getByLabel("Temperature", { exact: true }).fill("0.4");
    await parameters.getByLabel("Max output tokens").fill("1700");
    await parameters.getByLabel("Reasoning effort").selectOption("high");
    await parameters.getByLabel("Search orchestration").selectOption("model_choice");
    for (const label of [/^Streaming/, /^Background/]) {
      const toggle = parameters.getByRole("switch", { name: label });
      if (await toggle.getAttribute("aria-checked") !== "true") await toggle.click();
      await expect(toggle).toHaveAttribute("aria-checked", "true");
    }
    await closeRunSetup(page);
    await page.getByRole("button", { name: "Change MCP mode" }).click();
    await page.getByRole("menuitemradio", { name: /^Load all/ }).click();
    await composer.fill("Initial unsent draft");
    await page.getByLabel("Attach files").setInputFiles([1, 2].map((number) => ({
      name: `draft-${number}.pdf`, mimeType: "application/pdf", buffer: Buffer.from("Synthetic upload fixture")
    })));
    const indicator = page.getByTestId("header-context-indicator");
    await indicator.click();
    const dialog = page.getByRole("dialog", { name: "Chat context" });
    const action = dialog.getByRole("button", { name: "Summarize and open new chat" });
    await expect(action).toBeDisabled();
    await expect(dialog).toContainText("Wait for uploads to finish.");
    releaseUpload();
    await expect(action).toBeEnabled();
    await expect(page.getByRole("button", { name: "Remove draft-2.pdf" })).toBeVisible();
    await action.click();
    await expect.poll(() => selected).toEqual({ provider: chosen.provider, modelId: chosen.modelId });
    await composer.fill("Changed while the summary was running");
    releaseSummary();
    await expect(page.getByRole("article", { name: "Answer", exact: true })).toContainText("Conversation summary ready.");
    await expect(composer).toHaveValue("Changed while the summary was running");
    await expect(composer).toBeFocused();
    await expect(page.getByRole("article", { name: "Answer", exact: true })).toBeInViewport();
    expect(await composer.evaluate((element: HTMLTextAreaElement) => element.selectionStart === element.value.length && element.selectionEnd === element.value.length)).toBe(true);
    await expect(page.getByTestId("header-model-trigger")).toContainText(chosen.displayName);
    await expect(page.getByRole("button", { name: /^Choose web search/ })).toContainText("Perplexity");
    await expect(page.getByRole("button", { name: /Workspace details/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "Change MCP mode" })).toHaveAttribute("data-mcp-mode", "load_all");
    for (const number of [1, 2]) await expect(page.getByRole("button", { name: `Remove draft-${number}.pdf` })).toBeVisible();
    if (width === 1440) {
      for (const theme of ["light", "dark"]) {
        await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
        for (const viewport of [{ width: 1440, height: 900 }, { width: 900, height: 1440 }, { width: 820, height: 1180 },
          { width: 1180, height: 820 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
          await page.setViewportSize(viewport);
          await expectWithinViewport(page, composer);
          await expectNoHorizontalOverflow(page);
          await page.screenshot({ path: testInfo.outputPath(`continued-${theme}-${viewport.width}x${viewport.height}.png`) });
        }
      }
    }
    parameters = await openRunSetup(page);
    await expect(parameters.getByLabel("Temperature", { exact: true })).toHaveValue("0.4");
    await expect(parameters.getByLabel("Max output tokens")).toHaveValue("1700");
    await expect(parameters.getByLabel("Reasoning effort")).toHaveValue("high");
    await expect(parameters.getByLabel("Search orchestration")).toHaveValue("model_choice");
    await expect(parameters.getByRole("switch", { name: /^Streaming/ })).toHaveAttribute("aria-checked", "true");
    await expect(parameters.getByRole("switch", { name: /^Background/ })).toHaveAttribute("aria-checked", "true");
    await closeRunSetup(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole("treeitem", { name: source.title, exact: true }).click();
    await expect(composer).toHaveValue("");
    await expect(page.getByRole("button", { name: /^Remove draft-/ })).toHaveCount(0);
    await page.getByRole("treeitem", { name: target.title, exact: true }).click();
    await expect(composer).toHaveValue("Changed while the summary was running");
    await expect(page.getByTestId("header-model-trigger")).toContainText(chosen.displayName);
    for (const number of [1, 2]) await expect(page.getByRole("button", { name: `Remove draft-${number}.pdf` })).toBeVisible();
  });
}

import { expect, test } from "@playwright/test";
import type { ChatDetailWire, ChatMessageWire } from "../../lib/contracts/chats";
import { mcpAutoDiscoveryFailure, type RunOutcomeResponse } from "../../lib/contracts/runs";
import { installMatrixCatalogFixture } from "./shell/catalogFixture";
import { createGatedRunStreamFixture } from "./support/gatedRunStream";
import { expectNoHorizontalOverflow, expectWithinViewport } from "./support/layoutAssertions";
import { signInWithLocalToken } from "./support/localAuth";

test.use({ hasTouch: true });

const chatId = "synthetic-mcp-routing-chat";
const runId = "synthetic-mcp-routing-run";
const timestamp = "2026-09-10T10:00:00.000Z";
const question = "Find tools for reading the requested items.";
const failure = mcpAutoDiscoveryFailure("mcp_router_gemini_invalid_request");

for (const viewport of [
  { width: 1440, height: 900, theme: "dark" },
  { width: 390, height: 600, theme: "light" }
] as const) {
  test(`System Model rejection keeps one actionable error and requires explicit Load all at ${viewport.width}px`, async ({ page, context }, testInfo) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.emulateMedia({ colorScheme: viewport.theme });
    await context.addCookies([{ name: "aiqsa.theme", value: viewport.theme, url: "http://127.0.0.1:3000" }]);
    await page.addInitScript((id) => window.localStorage.setItem("aiqsa.activeChatId", id), chatId);
    const stream = createGatedRunStreamFixture({
      abortMessage: "Synthetic MCP stream stopped", key: "mcp-routing-recovery", notReadyError: "synthetic_stream_not_ready"
    });
    await stream.install(page, chatId);
    const chat: ChatDetailWire = {
      activeLeafMessageId: null, contextStats: { approximateActiveBranchInputTokens: 0 }, createdAt: timestamp,
      defaultModelId: "gpt-5.5", defaultProvider: "openai", folderId: null, id: chatId, messageCount: 0,
      messages: [], pinned: false, title: "MCP routing recovery", updatedAt: timestamp,
      pageInfo: { activeLeafMessageId: null, beforeCursor: null, hasOlder: false, snapshotUpdatedAt: timestamp }, usageStats: null
    };
    await installMatrixCatalogFixture(page, { chats: [chat], folders: [] });
    await page.route("**/api/me/mcp", (route) => route.fulfill({ json: { servers: [] } }));
    let finished = false;
    await page.route(`**/api/model-runs/${runId}`, (route) => {
      const response: RunOutcomeResponse = { version: 1, run: { id: runId, status: finished ? "error" : "streaming" } };
      return route.fulfill({ json: response });
    });
    const regenerations: unknown[] = [];
    await page.route("**/api/messages/*/regenerate", (route) => {
      regenerations.push(route.request().postDataJSON());
      // Inspect the user's selected policy without contacting a provider/MCP.
      return route.fulfill({ status: 409, json: { error: "synthetic_regeneration_recorded" } });
    });
    await signInWithLocalToken(page);
    await page.getByRole("textbox", { name: "Message" }).fill(question);
    await page.getByRole("textbox", { name: "Message" }).press("Enter");
    await stream.waitForRequestCount(page, 1);
    await stream.emit(page, "run_start", { modelId: "gpt-5.5", provider: "openai", runId, status: "streaming" });
    await stream.emit(page, "message_start", { assistantMessageId: "synthetic-answer", userMessageId: "synthetic-question" });
    await stream.emit(page, "artifact", { artifactType: "tool_call", payload: {
      name: "find_tools", origin: "discovery", round: 1, serverName: "Auto tools", status: "requested"
    } });
    await expect(page.getByTestId("run-status-line")).toHaveText("Finding relevant tools…");
    await stream.emit(page, "error", failure);

    const user: ChatMessageWire = {
      citationMessageId: null, content: { blocks: [{ type: "text", text: question }] }, createdAt: timestamp,
      errorMessage: null, id: "synthetic-question", modelId: null, modelRunId: null, parentMessageId: null,
      provider: null, role: "user", status: "complete"
    };
    const assistant: ChatMessageWire = {
      ...user, content: { blocks: [] }, errorMessage: failure.message, id: "synthetic-answer", modelId: "gpt-5.5",
      modelRunId: runId, parentMessageId: user.id, provider: "openai", role: "assistant", status: "error",
      toolActivity: { calls: [{ durationMs: 15, origin: "discovery", round: 1, serverName: "Auto tools", status: "error", toolName: "find_tools" }] }
    };
    chat.activeLeafMessageId = assistant.id;
    chat.updatedAt = "2026-09-10T10:00:01.000Z";
    chat.pageInfo.activeLeafMessageId = assistant.id;
    chat.pageInfo.snapshotUpdatedAt = chat.updatedAt;
    chat.messageCount = 2;
    chat.messages = [user, assistant];
    await installMatrixCatalogFixture(page, { chats: [chat], folders: [] });
    await stream.emit(page, "chat_update", { chat, messages: chat.messages });
    finished = true;
    await stream.close(page);

    const assertRecovery = async () => {
      const answer = page.locator('article[data-role="assistant"]');
      const card = answer.getByRole("region", { name: "Automatic tool discovery is unavailable" });
      await expect(card).toHaveCount(1);
      await expect(card.getByText(failure.message, { exact: true })).toBeVisible();
      await expect(card.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
      await expect(card.getByRole("button", { name: "Regenerate", exact: true })).toHaveCount(0);
      const loadAll = card.getByRole("button", { name: "Use Load all" });
      await expect(loadAll).toBeEnabled();
      await loadAll.scrollIntoViewIfNeeded();
      await expectWithinViewport(page, loadAll);
      await expectNoHorizontalOverflow(page);
      expect(regenerations).toEqual([]);
      return loadAll;
    };
    await assertRecovery();
    await page.reload();
    await expect(page.getByTestId("app-shell")).toBeVisible();
    const loadAll = await assertRecovery();
    await stream.waitForRequestCount(page, 0);
    await page.screenshot({ path: testInfo.outputPath("mcp-routing-rejection.png") });
    if (viewport.width < 500) {
      await loadAll.tap();
    } else {
      await loadAll.focus();
      await expect(loadAll).toBeFocused();
      await page.keyboard.press("Enter");
    }
    await expect.poll(() => regenerations.length).toBe(1);
    expect(regenerations[0]).toMatchObject({ mcp: { mode: "load_all" } });
  });
}

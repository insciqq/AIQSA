import { expect, test } from "@playwright/test";
import type { ChatDetailWire, ChatMessageWire, ChatUpdateDataWire, ThreadToolActivity } from "../../lib/contracts/chats";
import { TOOL_SYNTHESIS_FAILURE, type RunOutcomeResponse } from "../../lib/contracts/runs";
import type { ModelRunSseEvent } from "../../lib/domain/modelRunEvents";
import { installMatrixCatalogFixture } from "./shell/catalogFixture";
import { createGatedRunStreamFixture } from "./support/gatedRunStream";
import { expectNoHorizontalOverflow, expectWithinViewport } from "./support/layoutAssertions";
import { signInWithLocalToken } from "./support/localAuth";

const chatId = "synthetic-tool-budget-chat";
const runId = "synthetic-tool-budget-run";
const timestamp = "2026-09-09T10:00:00.000Z";
const question = "Search the repository tools.";
const partial = "Available findings from the completed tool steps.";

for (const viewport of [
  { width: 1440, height: 900, theme: "dark" },
  { width: 390, height: 844, theme: "light" }
] as const) {
  test(`MCP search and bounded final synthesis stay truthful through reload at ${viewport.width}px`, async ({ page, context }, testInfo) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.emulateMedia({ colorScheme: viewport.theme });
    await context.addCookies([{ name: "aiqsa.theme", value: viewport.theme, url: "http://127.0.0.1:3000" }]);
    await page.addInitScript((id) => window.localStorage.setItem("aiqsa.activeChatId", id), chatId);
    const stream = createGatedRunStreamFixture({
      abortMessage: "Synthetic tool-budget stream stopped",
      key: "tool-budget-synthesis", notReadyError: "synthetic_stream_not_ready"
    });
    await stream.install(page, chatId);
    const emit = (event: ModelRunSseEvent) => stream.emit(page, event.type, event.data);
    const chat: ChatDetailWire = {
      activeLeafMessageId: null, contextStats: { approximateActiveBranchInputTokens: 0 },
      createdAt: timestamp, defaultModelId: "gpt-5.5", defaultProvider: "openai", folderId: null,
      id: chatId, messageCount: 0, messages: [], pinned: false, title: "Bounded tool answer", updatedAt: timestamp,
      pageInfo: { activeLeafMessageId: null, beforeCursor: null, hasOlder: false, snapshotUpdatedAt: timestamp },
      usageStats: null
    };
    await installMatrixCatalogFixture(page, { chats: [chat], folders: [] });
    await page.route("**/api/me/mcp", (route) => route.fulfill({ json: { servers: [] } }));
    let finished = false;
    let terminalReads = 0;
    await page.route(`**/api/model-runs/${runId}`, (route) => {
      if (finished) terminalReads += 1;
      const response: RunOutcomeResponse = { version: 1, run: { id: runId, status: finished ? "error" : "streaming" } };
      return route.fulfill({ json: response });
    });
    const unexpectedWrites: string[] = [];
    for (const path of ["**/api/messages/*/regenerate", "**/api/chats/*/messages"]) {
      await page.route(path, (route) => {
        if (route.request().method() !== "POST") return route.fallback();
        unexpectedWrites.push(new URL(route.request().url()).pathname);
        return route.fulfill({ status: 409, json: { error: "unexpected_synthetic_run_request" } });
      });
    }

    await signInWithLocalToken(page);
    const composer = page.getByRole("textbox", { name: "Message" });
    await composer.fill(question);
    await composer.press("Enter");
    await stream.waitForRequestCount(page, 1);
    await emit({ type: "run_start", data: { modelId: "gpt-5.5", provider: "openai", runId, status: "streaming" } });
    await emit({ type: "message_start", data: { assistantMessageId: "synthetic-answer", userMessageId: "synthetic-question" } });
    // This MCP server deliberately shares a built-in display name. Accepted
    // origin must preserve its identity in both live and persisted activity.
    await emit({ type: "artifact", data: { artifactType: "tool_call", payload: {
      name: "search", origin: "mcp", round: 8, serverName: "Web search", status: "requested"
    } } });
    const live = page.getByTestId("run-status-line");
    await expect(live).toHaveText("Using Web search: search…");
    await expectWithinViewport(page, live);
    await expect(live).not.toContainText("Searching the web");
    await emit({ type: "artifact", data: { artifactType: "tool_budget", payload: { kind: "rounds", limit: 8 } } });
    await expect(live).toHaveText("Tool round limit (8) reached. Finishing the answer…");
    await expectWithinViewport(page, live);
    await expectNoHorizontalOverflow(page);
    await emit({ type: "token", data: { delta: partial } });
    await expect(page.locator('article[data-role="assistant"]')).toContainText(partial);
    await emit({ type: "error", data: TOOL_SYNTHESIS_FAILURE });

    const toolActivity: ThreadToolActivity = {
      calls: Array.from({ length: 8 }, (_, index): ThreadToolActivity["calls"][number] => ({
        durationMs: 10, origin: "mcp", round: index + 1,
        serverName: index === 7 ? "Web search" : "Repository Tools",
        status: index === 7 ? "error" : "complete", toolName: "search"
      })),
      warning: { kind: "rounds", limit: 8 }
    };
    const user: ChatMessageWire = {
      citationMessageId: null, content: { blocks: [{ type: "text", text: question }] }, createdAt: timestamp,
      errorMessage: null, id: "synthetic-question", modelId: null, modelRunId: null,
      parentMessageId: null, provider: null, role: "user", status: "complete"
    };
    const assistant: ChatMessageWire = {
      ...user, content: { blocks: [{ type: "text", text: partial }] }, errorMessage: TOOL_SYNTHESIS_FAILURE.message,
      id: "synthetic-answer", modelId: "gpt-5.5", modelRunId: runId, parentMessageId: user.id,
      provider: "openai", role: "assistant", status: "error", toolActivity
    };
    chat.activeLeafMessageId = assistant.id;
    chat.updatedAt = "2026-09-09T10:00:01.000Z";
    chat.pageInfo.activeLeafMessageId = assistant.id;
    chat.pageInfo.snapshotUpdatedAt = chat.updatedAt;
    chat.messageCount = 2;
    chat.messages = [user, assistant];
    // Publish the same server projection to live reconciliation and
    // subsequent reloads; no business tool or provider is contacted.
    await installMatrixCatalogFixture(page, { chats: [chat], folders: [] });
    const update: ChatUpdateDataWire = { chat, messages: chat.messages };
    await emit({ type: "chat_update", data: update });
    finished = true;
    await stream.close(page);
    await expect.poll(() => terminalReads).toBeGreaterThan(0);

    const assertFailedAnswer = async () => {
      const answer = page.locator('article[data-role="assistant"]');
      await expect(answer).toHaveCount(1);
      await expect(answer.getByRole("heading", { name: "Final answer not completed" })).toBeVisible();
      await expect(answer.getByText(partial, { exact: true })).toBeVisible();
      await expect(answer.getByText(TOOL_SYNTHESIS_FAILURE.message, { exact: true })).toBeVisible();
      await expect(answer.getByText("Tool round limit (8) stopped further tool use.", { exact: true })).toBeVisible();
      await expect(answer).not.toContainText(/Change the request parameters|Searching the web|Searched the web|mcp_synthetic/);
      const process = answer.getByTestId("tool-activity-disclosure");
      await process.locator(":scope > summary").click();
      await expect(process.getByRole("listitem")).toHaveCount(8);
      await expect(process.getByText("Used Repository Tools: search", { exact: true })).toHaveCount(7);
      await expect(process.getByText("Web search: search failed", { exact: true })).toBeVisible();
      await process.locator(":scope > summary").click();
      const regenerate = answer.getByRole("region", { name: "Final answer not completed" }).getByRole("button", { name: "Regenerate", exact: true });
      await expect(regenerate).toBeEnabled();
      await regenerate.scrollIntoViewIfNeeded();
      await expectWithinViewport(page, regenerate);
      await expectNoHorizontalOverflow(page);
      expect(unexpectedWrites).toEqual([]);
    };
    await assertFailedAnswer();
    await stream.waitForRequestCount(page, 1);
    await page.reload();
    await expect(page.getByTestId("app-shell")).toBeVisible();
    await assertFailedAnswer();
    // The new document loaded the failed result without opening another run.
    await stream.waitForRequestCount(page, 0);
    await page.screenshot({ path: testInfo.outputPath("tool-budget-synthesis.png") });
  });
}

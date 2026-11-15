import { expect, test } from "@playwright/test";
import { installMatrixCatalogFixture } from "./shell/catalogFixture";
import { createGatedRunStreamFixture } from "./support/gatedRunStream";
import { expectNoHorizontalOverflow } from "./support/layoutAssertions";
import { signInWithLocalToken } from "./support/localAuth";

const chatId = "search-counts-chat";
const runId = "search-counts-run";
const answerId = "search-counts-answer";
const timestamp = "2026-09-29T10:00:00.000Z";
const chat = { id: chatId, title: "Compare selected search engines", activeLeafMessageId: null,
  createdAt: timestamp, updatedAt: timestamp, defaultProvider: "openai", defaultModelId: "gpt-5.5",
  folderId: null, pinned: false, messageCount: 0, messages: [] };
const first = [
  { engine: 1, name: "Perplexity", requested: 1, settled: 0, complete: 0, error: 0, skipped: 0 },
  { engine: 2, name: "OpenAI (CodexLB)", requested: 1, settled: 0, complete: 0, error: 0, skipped: 0 }
];
const finished = [
  { ...first[0]!, requested: 3, settled: 3, complete: 2, error: 1 },
  { ...first[1]!, requested: 2, settled: 2, complete: 1, skipped: 1 }
];

for (const viewport of [
  { width: 1440, height: 900, theme: "dark" },
  { width: 768, height: 1024, theme: "light" },
  { width: 1024, height: 768, theme: "dark" },
  { width: 390, height: 844, theme: "light" },
  { width: 844, height: 390, theme: "dark" }
] as const) {
  test(`search counts preserve outcomes across replay and reload at ${viewport.width}px`, async ({ page, context }, testInfo) => {
    await page.setViewportSize(viewport);
    await context.addCookies([{ name: "aiqsa.theme", value: viewport.theme, url: testInfo.project.use.baseURL! }]);
    await installMatrixCatalogFixture(page, { folders: [], chats: [chat] });
    await page.route("**/api/me/mcp", route => route.fulfill({ json: { servers: [] } }));
    await page.route(`**/api/model-runs/${runId}`, route => route.fulfill({
      json: { version: 1, run: { id: runId, status: "streaming" } }
    }));
    const stream = createGatedRunStreamFixture({
      key: "search-counts", abortMessage: "Synthetic stream stopped", notReadyError: "search_stream_not_ready"
    });
    await stream.install(page, chatId);
    await page.route("**/api/chats/*/messages", route => route.request().method() === "POST"
      ? route.fulfill({ status: 409, json: { error: "unexpected_fixture_run" } }) : route.fallback());
    await signInWithLocalToken(page, `/c/${chatId}`);
    const composer = page.getByRole("textbox", { name: "Message" });
    await composer.fill("Compare the available references.");
    await composer.press("Enter");
    await stream.waitForRequestCount(page, 1);
    await stream.emit(page, "run_start", { provider: "openai", modelId: "gpt-5.5", runId, status: "streaming" });
    await stream.emit(page, "message_start", { assistantMessageId: answerId, userMessageId: "search-counts-question" });
    await stream.emit(page, "artifact", { artifactType: "tool_call", payload: {
      name: "search", origin: "web_search", serverName: "Web search", round: 1, status: "requested"
    } });
    // The live line names the real work; counts never ride on it (FRONTEND.md, operator decisions 2026-10-20, 2026-10-30).
    await expect(page.getByTestId("run-status-line")).toHaveText("Searching the web…");
    const emitCounts = (engines: typeof first) => stream.emit(page, "artifact", { artifactType: "search_activity", payload: { engines } });
    await emitCounts(first);
    const disclosure = page.getByTestId("tool-activity-disclosure");
    const summary = disclosure.locator(":scope > summary");
    const engineRow = disclosure.getByTestId("answer-search-engines");
    await expect(summary).toHaveText("Searching the web…");
    await summary.focus();
    await page.keyboard.press("Enter");
    await expect(disclosure).toHaveAttribute("open");
    // The fold holds the per-engine counts while the run works.
    await expect(engineRow).toContainText("Perplexity 1 in progress · OpenAI (CodexLB) 1 in progress");
    await expect(disclosure).not.toContainText(/round \d/u);
    await page.locator(".v2-conversation-scroll").evaluate(node => node.scrollTo({ top: 0 }));
    await page.screenshot({ path: testInfo.outputPath("search-counts-running.png") });
    await emitCounts(finished);
    // Settled counts change only the fold; the line keeps naming the work.
    await expect(summary).toHaveText("Searching the web…");
    await expect(engineRow).toContainText("Perplexity ×2 · 1 unsuccessful · OpenAI (CodexLB) ×1 · 1 skipped");
    // Replayed and out-of-order snapshots never move the counts back.
    await emitCounts(finished);
    await emitCounts(first);
    await stream.emit(page, "token", { delta: "The references support this answer." });
    await expect(summary).not.toContainText("Searching the web");
    await expect(summary).not.toContainText("Perplexity");
    await expect(engineRow).toContainText("Perplexity ×2 · 1 unsuccessful · OpenAI (CodexLB) ×1 · 1 skipped");
    await expect(engineRow).not.toContainText("in progress");
    await expect(disclosure).not.toContainText("counts successful calls");
    await expect(disclosure).not.toContainText("search_selected_engines");
    await expectNoHorizontalOverflow(page);

    await installMatrixCatalogFixture(page, { folders: [], chats: [{
      ...chat, activeLeafMessageId: answerId, messageCount: 1, messages: [{
        id: answerId, role: "assistant", status: "complete", parentMessageId: null,
        createdAt: timestamp, content: "The references support this answer.", errorMessage: null,
        citationMessageId: null, modelId: "gpt-5.5", modelRunId: runId, provider: "openai",
        toolActivity: { calls: [{ durationMs: 12_000, origin: "web_search", serverName: "Web search", toolName: "search", round: 1, status: "complete" }], searchEngines: finished },
        artifactSummary: { citations: [], sources: [{ title: "Reference", url: "https://example.com/reference", rank: 1 }], reasoningText: [] }
      }]
    }] });
    await stream.emit(page, "done", { runId, status: "complete" });
    await stream.close(page);
    await page.reload();
    await expect(disclosure).toHaveAttribute("open");
    // The settled line says how long the work took; the counts stay in the fold.
    await expect(summary).toHaveText(/^Worked for [^·]+$/u);
    await expect(engineRow).toContainText("Perplexity ×2 · 1 unsuccessful · OpenAI (CodexLB) ×1 · 1 skipped");
    await expect(engineRow).not.toContainText("in progress");
    await page.getByTestId("answer-sources-toggle").click();
    // Nothing is cited, so the sheet opens on the searched sites.
    await page.getByRole("dialog", { name: "Sources" }).getByRole("button", { name: "example.com · 1" }).click();
    await expect(page.getByRole("link", { name: /Reference/ })).toHaveAttribute("href", "https://example.com/reference");
    await expectNoHorizontalOverflow(page);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Sources" })).toHaveCount(0);
    await page.locator(".v2-conversation-scroll").evaluate(node => node.scrollTo({ top: 0 }));
    await page.screenshot({ path: testInfo.outputPath("search-counts-reloaded.png") });
    await summary.click();
    await page.reload();
    await expect(disclosure).not.toHaveAttribute("open");
  });
}

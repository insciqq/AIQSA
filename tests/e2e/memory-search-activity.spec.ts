import { expect, test } from "@playwright/test";
import { installMatrixCatalogFixture } from "./shell/catalogFixture";
import { createGatedRunStreamFixture } from "./support/gatedRunStream";
import { expectNoHorizontalOverflow } from "./support/layoutAssertions";
import { signInWithLocalToken } from "./support/localAuth";

const timestamp = "2026-09-29T10:00:00.000Z";
const chatId = "memory-search-activity-chat";
const chat = { id: chatId, title: "Recall an earlier preference", activeLeafMessageId: null,
  createdAt: timestamp, updatedAt: timestamp, defaultProvider: "openai", defaultModelId: "gpt-5.5",
  folderId: null, pinned: false, messageCount: 0, messages: [] };
// A limited search reads like any other search and a failed one leaves no
// step at all: users never see Memory failures or limits.
const outcomes = [
  { outcome: "results", status: "complete", label: "Searched memory" },
  { outcome: "no_results", status: "complete", label: "No matching memories found" },
  { outcome: "limited", status: "complete", label: "Searched memory" },
  { outcome: "failure", status: "error", label: null },
  { outcome: "cancelled", status: "cancelled", label: "Memory search stopped" }
] as const;
const hiddenMemoryCopy = /Memory search unavailable|limited results|Failed/u;

for (const viewport of [
  { width: 1440, height: 900, theme: "dark" },
  { width: 768, height: 1024, theme: "light" },
  { width: 1024, height: 768, theme: "dark" },
  { width: 390, height: 844, theme: "light" },
  { width: 844, height: 390, theme: "dark" }
] as const) {
  test(`Memory search status survives replay and reload at ${viewport.width}px`, async ({ page, context }, testInfo) => {
    test.setTimeout(90_000);
    await page.setViewportSize(viewport);
    await context.addCookies([{ name: "aiqsa.theme", value: viewport.theme, url: testInfo.project.use.baseURL! }]);
    await page.route("**/api/me/mcp", route => route.fulfill({ json: { servers: [] } }));
    await page.route("**/api/model-runs/*", route => route.request().method() === "GET"
      ? route.fulfill({ json: { version: 1, run: { id: "memory-activity-run", status: "streaming" } } })
      : route.fallback());
    const stream = createGatedRunStreamFixture({ key: "memory-search-activity",
      abortMessage: "Synthetic stream stopped", notReadyError: "memory_stream_not_ready" });
    await stream.install(page, chatId);
    await page.route("**/api/chats/*/messages", route => route.request().method() === "POST"
      ? route.fulfill({ status: 409, json: { error: "unexpected_fixture_run" } }) : route.fallback());

    for (const [index, variant] of outcomes.entries()) {
      await installMatrixCatalogFixture(page, { folders: [], chats: [chat] });
      if (index === 0) await signInWithLocalToken(page, `/c/${chatId}`);
      else await page.reload();
      const runId = `memory-activity-run-${index}`;
      const answerId = `memory-activity-answer-${index}`;
      const composer = page.getByRole("textbox", { name: "Message" });
      await composer.fill("What preference did we discuss earlier?");
      await composer.press("Enter");
      await stream.waitForRequestCount(page, 1);
      await stream.emit(page, "run_start", { provider: "openai", modelId: "gpt-5.5", runId, status: "streaming" });
      await stream.emit(page, "message_start", { assistantMessageId: answerId, userMessageId: `memory-activity-question-${index}` });
      await stream.emit(page, "artifact", { artifactType: "tool_call", payload: {
        name: "memory_search", origin: "memory", serverName: "Memory", round: 1, status: "requested"
      } });
      const emit = (payload: Record<string, unknown>) => stream.emit(page, "artifact", {
        artifactType: "memory_search_activity", payload: { call: 1, round: 1, ...payload }
      });
      await emit({ status: "running" });
      await emit({ status: "running" });
      const disclosure = page.getByTestId("tool-activity-disclosure");
      const summary = disclosure.locator(":scope > summary");
      await expect(summary).toContainText("Searching memory…");
      await summary.focus();
      await page.keyboard.press("Enter");
      await expect(disclosure).toHaveAttribute("open");
      await expect(disclosure.locator(".v2-answer-process-steps > li")).toHaveCount(1);
      await expectNoHorizontalOverflow(page);
      if (index === 0) {
        await page.locator(".v2-conversation-scroll").evaluate(node => node.scrollTo({ top: 0 }));
        await page.screenshot({ path: testInfo.outputPath("memory-search-running.png") });
      }
      const settled = { status: variant.status, outcome: variant.outcome, durationMs: 18000 };
      await emit(settled);
      await emit(settled);
      await emit({ status: "running" });
      if (variant.label === null) {
        await expect(page.locator(".v2-answer-process-steps")).toHaveCount(0);
        await expect(page.getByText("Searching memory…")).toHaveCount(0);
      } else {
        await expect(disclosure).toContainText(variant.label);
        await expect(disclosure.locator(".v2-answer-process-steps > li")).toHaveCount(1);
        await expect(summary).not.toContainText("Searching memory…");
        await expect(disclosure).not.toContainText("memory_search");
      }
      await expect(page.locator("body")).not.toContainText(hiddenMemoryCopy);
      const runStatus = variant.outcome === "cancelled" ? "cancelled" : "complete";
      await stream.emit(page, "token", { delta: "A concise response." });
      await installMatrixCatalogFixture(page, { folders: [], chats: [{ ...chat,
        activeLeafMessageId: answerId, messageCount: 1, messages: [{
          id: answerId, role: "assistant", status: runStatus, parentMessageId: null, createdAt: timestamp,
          content: "A concise response.", errorMessage: null, citationMessageId: null,
          modelId: "gpt-5.5", modelRunId: runId, provider: "openai",
          toolActivity: { calls: [{ origin: "memory", serverName: "Memory", toolName: "memory_search",
            memorySearchCall: 1, memorySearchOutcome: variant.outcome, round: 1,
            status: variant.status, durationMs: 18000 }] },
          artifactSummary: { citations: [], sources: [], reasoningText: [] }
        }]
      }] });
      await stream.emit(page, "done", { runId, status: runStatus });
      await stream.close(page);
      await page.reload();
      if (variant.label === null) {
        // Reopening the chat shows the answer without any Memory step or notice.
        await expect(page.getByText("A concise response.")).toBeVisible();
        await expect(disclosure).toHaveCount(0);
        await expect(page.locator("body")).not.toContainText(hiddenMemoryCopy);
        await expect(page.locator("[role='alert']:not(#__next-route-announcer__)")).toHaveCount(0);
        await expectNoHorizontalOverflow(page);
        continue;
      }
      await expect(disclosure).toHaveAttribute("open");
      await expect(disclosure).toContainText(variant.label);
      await expect(disclosure.locator(".v2-answer-process-steps > li")).toHaveCount(1);
      await expectNoHorizontalOverflow(page);
      if (variant.outcome === "limited" || variant.outcome === "cancelled") {
        await page.locator(".v2-conversation-scroll").evaluate(node => node.scrollTo({ top: 0 }));
        await page.screenshot({ path: testInfo.outputPath(`memory-search-${variant.outcome}-reloaded.png`) });
      }
      await summary.click();
      await page.reload();
      await expect(disclosure).not.toHaveAttribute("open");
    }
  });
}

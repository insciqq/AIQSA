import { expect, test } from "@playwright/test";
import { installMatrixCatalogFixture } from "./shell/catalogFixture";
import { createGatedRunStreamFixture } from "./support/gatedRunStream";
import { expectNoHorizontalOverflow } from "./support/layoutAssertions";
import { signInWithLocalToken } from "./support/localAuth";

const timestamp = "2026-09-29T10:00:00.000Z";
const chatId = "unused-workspace-chat";
const runId = "unused-workspace-run";
const answerId = "unused-workspace-answer";
const closed = { id: "execution-proof", kind: "execution_status", phase: "closed", sequence: 1 };
const chat = {
  id: chatId, title: "An ordinary answer", activeLeafMessageId: null,
  createdAt: timestamp, updatedAt: timestamp, defaultProvider: "openai", defaultModelId: "gpt-5.5",
  folderId: null, pinned: false, messageCount: 0, messages: []
};

for (const viewport of [
  { width: 1440, height: 900, theme: "dark" },
  { width: 768, height: 1024, theme: "light" },
  { width: 1024, height: 768, theme: "dark" },
  { width: 390, height: 844, theme: "light" },
  { width: 844, height: 390, theme: "dark" }
] as const) {
  test(`empty Workspace settlement preserves ordinary Memory disclosure at ${viewport.width}px`, async ({ page, context }, testInfo) => {
    await page.setViewportSize(viewport);
    await context.addCookies([{ name: "aiqsa.theme", value: viewport.theme, url: testInfo.project.use.baseURL! }]);
    await installMatrixCatalogFixture(page, { folders: [], chats: [chat] });
    await page.route("**/api/me/mcp", route => route.fulfill({ json: { servers: [] } }));
    await page.route(`**/api/model-runs/${runId}`, route => route.fulfill({
      json: { version: 1, run: { id: runId, status: "streaming" } }
    }));
    const stream = createGatedRunStreamFixture({
      key: "unused-workspace", abortMessage: "Synthetic stream stopped", notReadyError: "unused_stream_not_ready"
    });
    await stream.install(page, chatId);
    await page.route("**/api/chats/*/messages", route => route.request().method() === "POST"
      ? route.fulfill({ status: 409, json: { error: "unexpected_fixture_run" } }) : route.fallback());
    await signInWithLocalToken(page, `/c/${chatId}`);
    const composer = page.getByRole("textbox", { name: "Message" });
    await composer.fill("Please give a concise answer.");
    await composer.press("Enter");
    await stream.waitForRequestCount(page, 1);
    await stream.emit(page, "run_start", { provider: "openai", modelId: "gpt-5.5", runId, status: "streaming" });
    await stream.emit(page, "message_start", { assistantMessageId: answerId, userMessageId: "unused-workspace-question" });
    await stream.emit(page, "artifact", { artifactType: "workspace_activity", payload: closed });
    await stream.emit(page, "token", { delta: "Here is the concise answer." });
    await expect(page.locator('article[data-role="assistant"]')).toContainText("Here is the concise answer.");
    await expect(page.getByTestId("workspace-activity-section")).toHaveCount(0);
    await expect(page.getByText(/Worked in Workspace|Workspace execution ended/)).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("unused-workspace-live.png") });

    await installMatrixCatalogFixture(page, { folders: [], chats: [{
      ...chat, activeLeafMessageId: answerId, messageCount: 1, messages: [{
        id: answerId, role: "assistant", status: "complete", parentMessageId: null,
        createdAt: timestamp, content: "Here is the concise answer.", errorMessage: null,
        citationMessageId: null, modelId: "gpt-5.5", modelRunId: runId, provider: "openai",
        workspaceActivity: { entries: [closed], outputStatus: { state: "complete", revision: timestamp } },
        artifactSummary: { citations: [], sources: [], reasoningText: [], memorySources: [{
          actions: ["CORRECT", "FORGET", "NOT_RELEVANT"], date: timestamp,
          memoryRef: "opaque-fixture-fact", sourceAvailable: true, sourceType: "SAVED_MEMORY",
          text: "Prefer concise answers."
        }, {
          actions: ["CORRECT", "FORGET", "NOT_RELEVANT", "OPEN_SOURCE"], date: timestamp,
          memoryRef: "opaque-fixture-history", sourceAvailable: true, sourceType: "PAST_CHAT",
          chatGroup: "chat-1", origin: "Earlier discussion", text: "User: Keep the explanation brief."
        }] }
      }]
    }] });
    await stream.emit(page, "done", { runId, status: "complete" });
    await stream.close(page);
    await page.reload();
    const process = page.getByTestId("tool-activity-disclosure");
    const summary = process.locator(":scope > summary");
    await expect(summary).toContainText("Past chats · 1 · Memory · 1");
    await expect(page.getByTestId("workspace-activity-section")).toHaveCount(0);
    await expect(page.getByText(/Worked in Workspace|Workspace execution ended/)).toHaveCount(0);
    await summary.focus();
    await page.keyboard.press("Enter");
    await expect(process).toHaveAttribute("open");
    await expect(page.getByTestId("memories-disclosure")).toBeVisible();
    await expect(page.getByTestId("past-chats-disclosure")).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await page.locator(".v2-conversation-scroll").evaluate(node => node.scrollTo({ top: 0 }));
    await page.screenshot({ path: testInfo.outputPath("unused-workspace-reloaded.png") });
    await page.reload();
    await expect(process).toHaveAttribute("open");
  });
}

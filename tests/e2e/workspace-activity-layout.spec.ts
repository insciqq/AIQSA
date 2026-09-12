import { expect, test, type Locator } from "@playwright/test";
import type { ThreadWorkspaceActivityEntry } from "../../lib/contracts/workspace";
import { installMatrixCatalogFixture } from "./shell/catalogFixture";
import { createGatedRunStreamFixture } from "./support/gatedRunStream";
import { expectNoHorizontalOverflow } from "./support/layoutAssertions";
import { signInWithLocalToken } from "./support/localAuth";

const chatId = "workspace-layout-chat";
const runId = "workspace-layout-run";
const timestamp = "2026-09-12T10:00:00.000Z";

async function expectStackedTimeline(disclosure: Locator): Promise<number> {
  const summary = disclosure.locator(":scope > summary");
  const timeline = disclosure.getByTestId("workspace-activity");
  await expect(timeline).toBeVisible();
  const [foldBox, summaryBox, timelineBox] = await Promise.all([
    disclosure.boundingBox(), summary.boundingBox(), timeline.boundingBox()
  ]);
  expect(timelineBox!.y).toBeGreaterThanOrEqual(summaryBox!.y + summaryBox!.height);
  expect(timelineBox!.width).toBeGreaterThan(foldBox!.width * 0.8);
  expect(timelineBox!.x + timelineBox!.width).toBeLessThanOrEqual(foldBox!.x + foldBox!.width + 1);
  return timelineBox!.width;
}

for (const viewport of [
  { width: 1440, height: 900, theme: "dark" },
  { width: 390, height: 844, theme: "light" },
  { width: 844, height: 390, theme: "dark" }
] as const) {
  test(`Workspace activity keeps its width as live commands change at ${viewport.width}px`, async ({ page, context }, testInfo) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await context.addCookies([{ name: "aiqsa.theme", value: viewport.theme, url: testInfo.project.use.baseURL! }]);
    await page.addInitScript((id) => window.localStorage.setItem("aiqsa.activeChatId", id), chatId);
    await installMatrixCatalogFixture(page, { folders: [], chats: [{
      id: chatId, title: "Workspace activity layout", activeLeafMessageId: null,
      createdAt: timestamp, updatedAt: timestamp, defaultProvider: "openai", defaultModelId: "gpt-5.5",
      folderId: null, pinned: false, messageCount: 0, messages: []
    }] });
    await page.route("**/api/me/mcp", (route) => route.fulfill({ json: { servers: [] } }));
    await page.route(`**/api/model-runs/${runId}`, (route) => route.fulfill({
      json: { version: 1, run: { id: runId, status: "streaming" } }
    }));
    const stream = createGatedRunStreamFixture({
      key: "workspace-layout", abortMessage: "Synthetic layout stream stopped", notReadyError: "layout_stream_not_ready"
    });
    await stream.install(page, chatId);
    // Any send that escapes the synthetic stream must never reach a provider.
    await page.route("**/api/chats/*/messages", (route) => route.request().method() === "POST"
      ? route.fulfill({ status: 409, json: { error: "unexpected_layout_run" } }) : route.fallback());
    await signInWithLocalToken(page);
    const composer = page.getByRole("textbox", { name: "Message" });
    await composer.fill("Inspect the synthetic project files.");
    await composer.press("Enter");
    await stream.waitForRequestCount(page, 1);
    await stream.emit(page, "run_start", { provider: "openai", modelId: "gpt-5.5", runId, status: "streaming" });
    await stream.emit(page, "message_start", { assistantMessageId: "workspace-layout-answer", userMessageId: "workspace-layout-question" });
    await expect(page.getByTestId("run-status-line")).toBeVisible();

    let sequence = 0;
    const emitActivity = (entry: ThreadWorkspaceActivityEntry) => stream.emit(page, "artifact", {
      artifactType: "workspace_activity", payload: { ...entry, sequence: ++sequence }
    });
    await emitActivity({ id: "start", kind: "workspace_start", phase: "succeeded", durationMs: 546 });
    const disclosure = page.getByTestId("tool-activity-disclosure");
    const summary = disclosure.locator(":scope > summary");
    await expect(summary).toHaveText("Working in Workspace…");
    const initialWidth = await expectStackedTimeline(disclosure);

    for (const [index, preview] of ["pwd", "python -c \"from pathlib import Path; print(Path('project/report-with-a-long-file-name.txt').read_text())\""].entries()) {
      const entry: ThreadWorkspaceActivityEntry = { id: `command-${index}`, kind: "command", phase: "running", command: { preview } };
      await emitActivity(entry);
      await expect(summary).toContainText("Running ");
      expect(Math.abs(await expectStackedTimeline(disclosure) - initialWidth)).toBeLessThanOrEqual(1);
      await expectNoHorizontalOverflow(page);
      await emitActivity({ ...entry, phase: "succeeded", durationMs: 97, command: { preview, exitCode: 0, stdoutPreview: "Synthetic output" } });
      await expect(summary).toHaveText("Working in Workspace…");
      expect(Math.abs(await expectStackedTimeline(disclosure) - initialWidth)).toBeLessThanOrEqual(1);
    }

    const command = disclosure.locator(".v2-workspace-command").last();
    await command.locator(":scope > summary").focus();
    await page.keyboard.press("Enter");
    await expect(command.getByText("Synthetic output", { exact: true })).toBeVisible();
    expect(Math.abs(await expectStackedTimeline(disclosure) - initialWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: testInfo.outputPath("workspace-live.png") });
    await stream.emit(page, "token", { delta: "The synthetic project check is complete." });
    await expect(page.locator('article[data-role="assistant"]')).toContainText("The synthetic project check is complete.");
    await expect(disclosure).not.toHaveAttribute("data-live");
    if (await disclosure.getAttribute("open") === null) await summary.click();
    expect(Math.abs(await expectStackedTimeline(disclosure) - initialWidth)).toBeLessThanOrEqual(1);
    await expectNoHorizontalOverflow(page);
  });
}

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
  { width: 820, height: 1180, theme: "light" },
  { width: 390, height: 844, theme: "light" },
  { width: 844, height: 390, theme: "dark" }
] as const) {
  test.describe(`${viewport.width}px`, () => {
  test.use({ isMobile: viewport.width !== 1440, hasTouch: viewport.width !== 1440 });
  test(`Workspace activity keeps its width and scrolls long history at ${viewport.width}px`, async ({ page, context }, testInfo) => {
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
    await expect(disclosure).not.toHaveAttribute("open");
    await summary.click();
    const initialWidth = await expectStackedTimeline(disclosure);

    for (const [index, preview] of ["pwd", "python -c \"from pathlib import Path; print(Path('project/report-with-a-long-file-name.txt').read_text())\""].entries()) {
      const entry: ThreadWorkspaceActivityEntry = { id: `command-${index}`, kind: "command", phase: "running", command: { preview } };
      await emitActivity(entry);
      await expect(summary).toContainText(index === 0 ? "Exploring pwd" : "Running ");
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

    for (let index = 0; index < 60; index++) {
      await emitActivity({ id: `read-${index}`, kind: "file_read", phase: "succeeded",
        file: { displayPath: `project/report-${index}.txt` } });
    }
    const opener = disclosure.getByRole("button", { name: /earlier steps · Show all/ });
    await opener.click();
    const dialog = page.getByRole("dialog", { name: "Workspace activity", exact: true });
    const steps = dialog.getByRole("list", { name: "Activity steps" });
    const close = dialog.getByRole("button", { name: "Close", exact: true });
    await expect(steps.getByRole("listitem")).toHaveCount(63);
    await expect(close).toBeFocused();
    expect(await steps.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
    const [dialogBox, listBox] = await Promise.all([dialog.boundingBox(), steps.boundingBox()]);
    expect(dialogBox!.y).toBeGreaterThanOrEqual(0);
    expect(dialogBox!.y + dialogBox!.height).toBeLessThanOrEqual(viewport.height);
    expect(listBox!.y + listBox!.height).toBeLessThanOrEqual(dialogBox!.y + dialogBox!.height);
    await dialog.screenshot({ path: testInfo.outputPath("workspace-history-top.png") });
    await steps.hover();
    await page.mouse.wheel(0, 16000);
    await expect.poll(() => steps.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(1);
    await expect(steps.getByText("Read project/report-59.txt", { exact: true })).toBeInViewport();
    await expect(close).toBeInViewport();
    await page.keyboard.press("Tab");
    await expect(steps).toBeFocused();
    await page.keyboard.press("Home");
    await expect.poll(() => steps.evaluate((element) => element.scrollTop)).toBe(0);
    await page.keyboard.press("End");
    await expect.poll(() => steps.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(1);
    await dialog.screenshot({ path: testInfo.outputPath("workspace-history-bottom.png") });
    await page.keyboard.press("Shift+Tab");
    await expect(close).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(dialog.locator(".v2-workspace-command > summary").last()).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(close).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
    await expectNoHorizontalOverflow(page);

    await installMatrixCatalogFixture(page, { folders: [], chats: [{
      id: chatId, title: "Workspace activity layout", activeLeafMessageId: "workspace-layout-answer",
      createdAt: timestamp, updatedAt: timestamp, defaultProvider: "openai", defaultModelId: "gpt-5.5",
      folderId: null, pinned: false, messageCount: 1,
      messages: [{ id: "workspace-layout-answer", role: "assistant", status: "complete", parentMessageId: null,
        createdAt: timestamp, content: "The synthetic project check is complete.", errorMessage: null,
        citationMessageId: null, modelId: "gpt-5.5", modelRunId: runId, provider: "openai",
        workspaceActivity: { entries: [{ id: "failed-check", kind: "command", phase: "failed",
          command: { preview: "npm test", exitCode: 1 } }] }
      }]
    }] });
    await page.reload();
    await expect(disclosure).toHaveAttribute("open");
    await expect(summary).toContainText("Needs attention");
    await summary.click();
    await page.reload();
    await expect(disclosure).not.toHaveAttribute("open");
    await expect(summary).toContainText("Needs attention");
    await page.locator(".v2-conversation-scroll").evaluate(node => node.scrollTo({ top: 0 }));
    await page.screenshot({ path: testInfo.outputPath("workspace-reload-collapsed.png") });
  });
  });
}

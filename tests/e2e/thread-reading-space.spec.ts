import { expect, test, type Locator, type Page } from "@playwright/test";
import type { ThreadWorkspaceActivityEntry } from "../../lib/contracts/workspace";
import { installMatrixCatalogFixture } from "./shell/catalogFixture";
import { scrollMessage } from "./shell/thread";
import { createGatedRunStreamFixture } from "./support/gatedRunStream";
import { expectNoHorizontalOverflow } from "./support/layoutAssertions";
import { signInWithLocalToken } from "./support/localAuth";

const chatId = "reading-space-chat";
const otherChatId = "reading-space-other";
const timestamp = "2026-10-21T10:00:00.000Z";
const waitingPhrase = /^(Thinking|Pondering|Mulling it over|Working on it|Considering|Reflecting|Deliberating|Musing)…$/u;
const earlierAnswer = Array.from({ length: 24 }, (_, index) =>
  `Earlier answer paragraph ${index + 1} keeps the thread taller than the screen.`).join("\n\n");
const history = [
  scrollMessage("prior-question", "user", "Earlier question", null),
  scrollMessage("prior-answer", "assistant", earlierAnswer, "prior-question")
];

function chat(id: string, title: string, messages: ReadonlyArray<ReturnType<typeof scrollMessage>>) {
  return {
    activeLeafMessageId: messages.at(-1)?.id ?? null, createdAt: timestamp, defaultModelId: "gpt-5.5",
    defaultProvider: "openai", folderId: null, id, messageCount: messages.length, messages, pinned: false, title,
    updatedAt: timestamp
  };
}

const otherChat = chat(otherChatId, "Another reading chat", [
  scrollMessage("other-question", "user", "Another question", null),
  scrollMessage("other-answer", "assistant", "Another answer.", "other-question")
]);

/** The sidebar lists chats from its own compact endpoint. */
async function installChatList(page: Page, chats: ReadonlyArray<ReturnType<typeof chat>>) {
  await page.route("**/api/chats/compact?*", (route) => route.fulfill({ json: {
    chats: chats.map((detail) => ({ activeRun: false, assistant: null, folderId: null, id: detail.id, title: detail.title,
      updatedAt: detail.updatedAt })),
    folders: [], nextCursor: null
  } }));
}

async function openChat(page: Page, title: string) {
  const navigation = page.getByRole("complementary", { name: "Chat navigation" });
  if (!(await navigation.isVisible())) await page.getByRole("button", { name: "Open sidebar" }).click();
  await navigation.getByRole("treeitem", { name: title, exact: true }).click();
}

/** Top and bottom of an element against the thread's visible band above the docked composer. */
async function placement(page: Page, target: Locator) {
  return target.evaluate((element) => {
    const thread = document.querySelector<HTMLElement>('[data-testid="conversation-scroll"]')!;
    const dock = document.querySelector<HTMLElement>("[data-thread-composer-dock]");
    const threadBox = thread.getBoundingClientRect();
    const visibleBottom = Math.min(threadBox.bottom, dock?.getBoundingClientRect().top ?? threadBox.bottom);
    const box = element.getBoundingClientRect();
    return { bottom: box.bottom - threadBox.top, top: box.top - threadBox.top, visibleBottom: visibleBottom - threadBox.top };
  });
}

async function scrollThreadToEnd(page: Page) {
  await page.getByTestId("conversation-scroll").evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event("scroll"));
  });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

for (const viewport of [
  { height: 900, label: "desktop", width: 1440 },
  { height: 844, label: "phone", width: 390 }
] as const) {
  test.describe(`${viewport.label}`, () => {
    test.use({ hasTouch: viewport.label === "phone", isMobile: viewport.label === "phone" });

    test(`a short settled answer ends the thread at its question, and another chat opens at its own end (${viewport.label})`,
      async ({ page }, testInfo) => {
        await page.setViewportSize({ height: viewport.height, width: viewport.width });
        const runId = `reading-space-run-${viewport.label}`;
        await installMatrixCatalogFixture(page, { chats: [chat(chatId, "Reading space", history), otherChat], folders: [] });
        await installChatList(page, [chat(chatId, "Reading space", history), otherChat]);
        await page.route(`**/api/model-runs/${runId}`, (route) => route.fulfill({
          json: { run: { id: runId, status: "streaming" }, version: 1 }
        }));
        const stream = createGatedRunStreamFixture({
          abortMessage: "Reading space stream stopped", key: "reading-space", notReadyError: "reading_space_stream_not_ready"
        });
        await stream.install(page, chatId);
        await signInWithLocalToken(page, `/c/${chatId}`);

        const composer = page.getByRole("textbox", { name: "Message" });
        await composer.fill("A short question");
        await composer.press("Enter");
        await stream.waitForRequestCount(page, 1);
        await stream.emit(page, "run_start", { modelId: "gpt-5.5", provider: "openai", runId, status: "streaming" });
        await stream.emit(page, "message_start", { assistantMessageId: "short-answer", userMessageId: "short-question" });
        await stream.emit(page, "token", { delta: "A short answer." });
        const question = page.locator('[data-message-id="short-question"]');
        const answer = page.locator('[data-message-id="short-answer"]');
        await expect(answer).toContainText("A short answer.");

        const settled = chat(chatId, "Reading space", [
          ...history,
          scrollMessage("short-question", "user", "A short question", "prior-answer"),
          { ...scrollMessage("short-answer", "assistant", "A short answer, settled.", "short-question"), modelRunId: runId }
        ]);
        await installMatrixCatalogFixture(page, { chats: [settled, otherChat], folders: [] });
        await stream.emit(page, "chat_update", { chat: settled, messages: settled.messages });
        await stream.emit(page, "done", { runId, status: "complete" });
        await stream.close(page);
        await expect(page.getByRole("button", { name: "Stop answer", exact: true })).toHaveCount(0);
        await expect(answer).toContainText("A short answer, settled.");

        // The end of the thread is the anchored view: the question with the
        // answer under it, not the answer pushed off the top above a blank screen.
        await scrollThreadToEnd(page);
        const questionAtEnd = await placement(page, question);
        const answerAtEnd = await placement(page, answer);
        expect(questionAtEnd.top).toBeGreaterThanOrEqual(0);
        expect(answerAtEnd.bottom).toBeLessThanOrEqual(answerAtEnd.visibleBottom);
        await expectNoHorizontalOverflow(page);
        await page.screenshot({ path: testInfo.outputPath(`thread-end-${viewport.label}.png`) });

        // Another chat and back: no room left over from the live answer.
        await openChat(page, "Another reading chat");
        await expect(page.locator('[data-message-id="other-answer"]')).toBeVisible();
        await openChat(page, "Reading space");
        await expect(answer).toBeVisible();
        await expect.poll(() => page.locator("[data-thread-reading-spacer]").evaluate((element) =>
          element.getBoundingClientRect().height)).toBe(0);
        const returned = await placement(page, answer);
        expect(returned.bottom).toBeLessThanOrEqual(returned.visibleBottom);
        expect(returned.visibleBottom - returned.bottom).toBeLessThan(200);
        await page.screenshot({ path: testInfo.outputPath(`thread-returned-${viewport.label}.png`) });
      });

    test(`Workspace steps toggled while the answer runs stay under the pointer (${viewport.label})`, async ({ page }, testInfo) => {
      await page.setViewportSize({ height: viewport.height, width: viewport.width });
      const runId = `reading-space-workspace-run-${viewport.label}`;
      await installMatrixCatalogFixture(page, { chats: [chat(chatId, "Reading space", history)], folders: [] });
      await page.route("**/api/me/mcp", (route) => route.fulfill({ json: { servers: [] } }));
      await page.route(`**/api/model-runs/${runId}`, (route) => route.fulfill({
        json: { run: { id: runId, status: "streaming" }, version: 1 }
      }));
      const stream = createGatedRunStreamFixture({
        abortMessage: "Reading space Workspace stream stopped", key: "reading-space-workspace",
        notReadyError: "reading_space_workspace_stream_not_ready"
      });
      await stream.install(page, chatId);
      await signInWithLocalToken(page, `/c/${chatId}`);

      const composer = page.getByRole("textbox", { name: "Message" });
      await composer.fill("Run the synthetic Workspace check.");
      await composer.press("Enter");
      await stream.waitForRequestCount(page, 1);
      await stream.emit(page, "run_start", { modelId: "gpt-5.5", provider: "openai", runId, status: "streaming" });
      await stream.emit(page, "message_start", { assistantMessageId: "workspace-answer", userMessageId: "workspace-question" });

      let sequence = 0;
      const emitActivity = (entry: ThreadWorkspaceActivityEntry) => stream.emit(page, "artifact", {
        artifactType: "workspace_activity", payload: { ...entry, sequence: ++sequence }
      });
      const emitToolRound = async (index: number) => {
        await stream.emit(page, "artifact", { artifactType: "tool_call", payload: {
          name: "workspace_exec", origin: "workspace", round: index + 1, serverName: "Workspace", status: "requested"
        } });
        const entry: ThreadWorkspaceActivityEntry = { command: { preview: `python step_${index}.py` }, id: `step-${index}`,
          kind: "command", phase: "running" };
        await emitActivity(entry);
        await emitActivity({ ...entry, command: { exitCode: 1, preview: `python step_${index}.py`,
          stderrPreview: "Synthetic traceback line\n".repeat(30), truncated: true }, durationMs: 120, phase: "failed" });
        // The model reads the results: the line waits with the answer's own phrase.
        await stream.emit(page, "artifact", { artifactType: "summary", payload: { stage: "model", status: "waiting" } });
      };
      await emitActivity({ durationMs: 480, id: "start", kind: "workspace_start", phase: "succeeded" });
      for (let index = 0; index < 12; index += 1) await emitToolRound(index);

      const disclosure = page.getByTestId("tool-activity-disclosure");
      const summary = disclosure.locator(":scope > summary");
      await expect(summary).toHaveText(waitingPhrase);
      await expect(page.getByText("Reading results", { exact: false })).toHaveCount(0);
      if (await disclosure.getAttribute("open") === null) await summary.click();

      const question = page.locator('[data-message-id="workspace-question"]');
      const stepRow = (index: number) => disclosure.locator(".v2-workspace-command").filter({ hasText: `python step_${index}.py` });
      const stepSummary = (index: number) => stepRow(index).locator(":scope > summary");
      const expectStill = async (target: Locator, top: number) => {
        await expect.poll(async () => Math.round((await placement(page, target)).top)).toBe(Math.round(top));
      };

      await expect(stepRow(11)).toBeVisible();
      // Opening the latest step's output keeps it under the pointer.
      const latestTop = (await placement(page, stepSummary(11))).top;
      await stepSummary(11).click();
      await expect(stepRow(11)).toHaveAttribute("open");
      await expect(stepRow(11).getByText("Output truncated", { exact: true })).toBeVisible();
      await expectStill(stepSummary(11), latestTop);

      // The answer now runs past the screen: follow it to the end, as a reader would.
      const jumpToLatest = page.getByRole("button", { name: "Jump to latest message" });
      await expect(jumpToLatest).toBeVisible();
      await jumpToLatest.click();
      await expect(jumpToLatest).toHaveCount(0);

      // While following, opening another step no longer chases the tail.
      await expect(stepSummary(10)).toBeInViewport();
      const followedTop = (await placement(page, stepSummary(10))).top;
      await stepSummary(10).click();
      await expect(stepRow(10)).toHaveAttribute("open");
      await expectStill(stepSummary(10), followedTop);
      await emitToolRound(12);
      await expect(stepRow(12)).toHaveCount(1);
      await expect(stepSummary(10)).toBeInViewport();
      await expect(jumpToLatest).toBeVisible();
      const settledTop = (await placement(page, stepSummary(10))).top;
      await stepSummary(10).click();
      await expect(stepRow(10)).not.toHaveAttribute("open");
      await expectStill(stepSummary(10), settledTop);

      // Closing the long output returns to the question and its answer, not to a blank screen.
      await stepSummary(11).click();
      await expect(stepRow(11)).not.toHaveAttribute("open");
      await expect.poll(async () => (await placement(page, question)).top).toBeGreaterThanOrEqual(0);
      await expect(stepSummary(11)).toBeInViewport();
      await page.screenshot({ path: testInfo.outputPath(`workspace-toggled-${viewport.label}.png`) });
      await expect(summary).toHaveText(waitingPhrase);
      await expectNoHorizontalOverflow(page);

      await stream.emit(page, "done", { runId, status: "cancelled" });
      await stream.close(page);
    });
  });
}

import { expect, test } from "@playwright/test";
import { createGatedRunStreamFixture } from "./support/gatedRunStream";
import { expectNoHorizontalOverflow } from "./support/layoutAssertions";
import { signInWithLocalToken as signIn } from "./support/localAuth";
import { closeRunSetup, openRunSetup } from "./shell/composer";
import { installMatrixCatalogFixture } from "./shell/catalogFixture";
import {
  expectThreadTextInViewport,
  scrollMessage,
  threadTextIsInViewport
} from "./shell/thread";

const oversizedQuestionStream = createGatedRunStreamFixture({
  abortMessage: "Oversized question stream aborted",
  key: "oversized-question-tail",
  notReadyError: "oversized_question_stream_not_ready"
});

const viewports = [
  { height: 720, label: "desktop", width: 1280 },
  { height: 2160, label: "4k", width: 3840 },
  { height: 844, label: "mobile", width: 390 }
] as const;

const chatId = "chat-oversized-question-tail";
const questionTailMarker = "Oversized question tail marker";
const answerStartMarker = "Oversized answer start marker";
const largeGrowthTailMarker = "Oversized answer large-growth tail marker";
const resumedFollowTailMarker = "Oversized answer resumed-follow tail marker";
const oversizedQuestion = [
  "Oversized question start marker",
  ...Array.from(
    { length: 140 },
    (_, index) =>
      `Submitted research note ${index + 1}. Preserve this authored context while revealing its trailing edge.`
  ),
  questionTailMarker
].join("\n\n");

test.describe("oversized submitted-question reading anchor", () => {
  for (const viewport of viewports) {
    test(`${viewport.width}x${viewport.height} reveals the question tail without chasing answer growth`, async ({ page }) => {
      await page.setViewportSize(viewport);
      const historicalAnswer = [
        "Historical answer start",
        ...Array.from(
          { length: 120 },
          (_, index) => `Historical reading line ${index + 1}. This keeps the initial reader away from the tail.`
        ),
        "Historical answer tail"
      ].join("\n\n");
      const chat = {
        activeLeafMessageId: "assistant-previous",
        createdAt: "2026-08-05T00:00:00.000Z",
        defaultModelId: "gpt-5.5",
        defaultProvider: "openai",
        folderId: null,
        id: chatId,
        messageCount: 2,
        messages: [
          scrollMessage("user-previous", "user", "Previous question", null),
          scrollMessage("assistant-previous", "assistant", historicalAnswer, "user-previous")
        ],
        pinned: false,
        title: "Oversized question anchor",
        updatedAt: "2026-08-05T00:00:01.000Z",
        usageStats: null
      };

      await page.addInitScript(
        ({ activeChatId }) => window.localStorage.setItem("aiqsa.activeChatId", activeChatId),
        { activeChatId: chatId }
      );
      await oversizedQuestionStream.install(page, chatId);
      await installMatrixCatalogFixture(page, { chats: [chat], folders: [] });
      await signIn(page);

      if (viewport.label === "mobile") {
        await expect
          .poll(() =>
            page.evaluate(() => ({
              innerHeight: window.innerHeight,
              visualHeight: Math.round(window.visualViewport?.height ?? window.innerHeight)
            }))
          )
          .toEqual({ innerHeight: viewport.height, visualHeight: viewport.height });
      }

      const runSetup = await openRunSetup(page);
      const streamButton = runSetup.getByRole("switch", { name: /Streaming/ });
      await expect(streamButton).toHaveAttribute("aria-checked", "false");
      await streamButton.click();
      await closeRunSetup(page);

      const thread = page.getByTestId("conversation-scroll");
      await expectThreadTextInViewport(page, "Historical answer tail");
      await thread.evaluate((element) => {
        element.scrollTop = 0;
        element.dispatchEvent(new Event("scroll"));
      });
      const jumpToLatest = page.getByRole("button", { name: "Jump to latest message" });
      await expect(jumpToLatest).toBeVisible();

      const composer = page.getByRole("textbox", { name: "Сообщение" });
      await composer.fill(oversizedQuestion);
      await composer.press("Enter");
      await oversizedQuestionStream.waitForRequestCount(page, 1);
      await oversizedQuestionStream.emit(page, "run_start", {
        runId: `run-oversized-${viewport.label}`,
        status: "streaming"
      });
      await oversizedQuestionStream.emit(page, "message_start", {
        assistantMessageId: `assistant-oversized-${viewport.label}`,
        userMessageId: `user-oversized-${viewport.label}`
      });
      await oversizedQuestionStream.emit(page, "token", { delta: answerStartMarker });

      const submittedQuestion = thread.locator(
        `[data-message-id="user-oversized-${viewport.label}"]`
      );
      await expect(submittedQuestion).toBeVisible();
      await expect
        .poll(async () => {
          const [questionBox, threadBox] = await Promise.all([
            submittedQuestion.boundingBox(),
            thread.boundingBox()
          ]);
          return Boolean(questionBox && threadBox && questionBox.height > threadBox.height);
        })
        .toBe(true);
      await expectThreadTextInViewport(page, questionTailMarker);
      await expectThreadTextInViewport(page, answerStartMarker);
      await expect(jumpToLatest).toHaveCount(0);
      await expectNoHorizontalOverflow(page);

      const anchoredScrollTop = await thread.evaluate((element) => element.scrollTop);
      await oversizedQuestionStream.emit(page, "token", {
        delta: "\n\nSmall answer preview growth."
      });
      await expect(page.getByRole("article", { name: "Answer" }).last())
        .toContainText("Small answer preview growth.");
      await expect
        .poll(() => thread.evaluate((element) => element.scrollTop))
        .toBe(anchoredScrollTop);
      await expect(jumpToLatest).toHaveCount(0);

      const largeGrowth = [
        "",
        ...Array.from(
          { length: 80 },
          (_, index) => `Large streamed answer line ${index + 1}. The reading anchor must remain stable.`
        ),
        largeGrowthTailMarker
      ].join("\n\n");
      await oversizedQuestionStream.emit(page, "token", { delta: largeGrowth });
      await expect(page.getByText(largeGrowthTailMarker, { exact: true })).toBeVisible();
      await expect
        .poll(() => thread.evaluate((element) => element.scrollTop))
        .toBe(anchoredScrollTop);
      expect(await threadTextIsInViewport(page, largeGrowthTailMarker)).toBe(false);
      await expect(jumpToLatest).toBeVisible();
      await expectNoHorizontalOverflow(page);

      await jumpToLatest.click();
      await expectThreadTextInViewport(page, largeGrowthTailMarker);
      const jumpedScrollTop = await thread.evaluate((element) => element.scrollTop);
      expect(jumpedScrollTop).toBeGreaterThan(anchoredScrollTop);

      await oversizedQuestionStream.emit(page, "token", {
        delta: `\n\n${"Resumed tail-follow growth. ".repeat(20)}\n\n${resumedFollowTailMarker}`
      });
      await expectThreadTextInViewport(page, resumedFollowTailMarker);
      await expect
        .poll(() => thread.evaluate((element) => element.scrollTop))
        .toBeGreaterThan(jumpedScrollTop);
      await expect(jumpToLatest).toHaveCount(0);
      await expectNoHorizontalOverflow(page);

      await oversizedQuestionStream.emit(page, "done", { status: "complete" });
      await oversizedQuestionStream.close(page);
    });
  }
});

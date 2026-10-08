import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { DEFAULT_BOOTSTRAP_USER_ID } from "../../lib/server/auth/config";
import { runAccountMenuAction } from "./shell/page";
import { chooseAnswerReview, composerChips, grantPush, modelPicker, unresolvablePushEndpoint } from "./support/answerReviewAuto";
import {
  openAnswerReviewStand,
  REVIEWER_NAME,
  reviewStatus,
  shownAnswer,
  type AnswerReviewStand
} from "./support/answerReviewStand";
import { captureState, type CaptureSize } from "./support/capture";
import { turnComposerToolsOff } from "./support/composerToolsOff";
import { expectNoHorizontalOverflow, expectWithinViewport } from "./support/layoutAssertions";
import { signInWithLocalToken } from "./support/localAuth";
import { activeChatId, disableMemoryRecall, startNewChat } from "./support/workspace";

/**
 * Automatic answer review on the fake-provider stand (see the stand's notes
 * in support/answerReviewStand.ts): the chat's choice in the model picker,
 * the session the server drives after the user's send, with the tab closed
 * too, its single end notification, Stop, the early clean finish, the budget
 * stop and the header chip at every size. Fake QSA's window is 8k: every
 * chat runs with Workspace, MCP, Skills and Search off.
 *
 * In-page notifications are counted by the favicon alert each one sets, as
 * answer-sound.spec.ts does; pushes by the failed deliveries to an
 * unresolvable endpoint, as browser-push-shown-runs.spec.ts does. Two
 * reviewers in one round, a restart and the time limit are proven in
 * lib/server/answerReviews (stepStart.test.ts and autoDriver.prisma.test.ts).
 */

test.describe.configure({ mode: "serial" });

const prisma = new PrismaClient();
const userId = DEFAULT_BOOTSTRAP_USER_ID;
const REVISED = "Revised answer: the figure is verified and its source is named.";
let stand: AnswerReviewStand | null = null;

test.beforeAll(async ({ browser }, testInfo) => {
  test.setTimeout(300_000);
  stand = await openAnswerReviewStand({ baseURL: testInfo.project.use.baseURL, browser, prisma, userId, warmPaths: [
    "/api/answer-reviews/route-warmup/stop", `/api/model-runs/${randomUUID()}/cancel`
  ] });
});

test.afterAll(async () => {
  await stand?.close();
  await prisma.$disconnect();
});

type AlertWindow = Window & { __answerAlerts: number };

/** Counts the page's answer notifications: each sets the alert favicon once while the page is visible. */
async function countAnswerAlerts(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as AlertWindow).__answerAlerts = 0;
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.target instanceof HTMLLinkElement && record.target.rel.includes("icon") &&
          record.target.getAttribute("href") === "/favicon-alert.svg") (window as unknown as AlertWindow).__answerAlerts += 1;
      }
    });
    observer.observe(document, { attributeFilter: ["href"], attributes: true, subtree: true });
  });
}

const answerAlerts = (page: Page) => page.evaluate(() => (window as unknown as AlertWindow).__answerAlerts);

/** Turns the chat's automatic review on with the fixture reviewer (or off) from the model picker's row. */
function chooseReview(page: Page, input: Readonly<{ enabled: boolean; rounds?: 1 | 2 | 3 }>): Promise<void> {
  return chooseAnswerReview(page, { ...input, reviewer: REVIEWER_NAME });
}

/**
 * A new chat of the signed-in user with Fake QSA, every tool off and
 * automatic review on; returns the composer's chips from before review was on.
 */
async function reviewedChat(page: Page, rounds: 1 | 2 | 3 = 3): Promise<string[]> {
  await disableMemoryRecall(page);
  await startNewChat(page);
  await turnComposerToolsOff(page);
  await expect(page.getByTestId("header-model-trigger")).toContainText("Fake QSA");
  const chips = await composerChips(page);
  await chooseReview(page, { enabled: true, rounds });
  await expect(page.getByTestId("header-model-trigger")).toHaveAttribute("title", new RegExp(
    `Review: ${REVIEWER_NAME}, up to ${rounds} rounds?`, "u"));
  // The review lives in the model picker and the header chip, never in the composer's chips.
  expect(await composerChips(page)).toEqual(chips);
  return chips;
}

/** Sends the question; resolves with its chat once the answer under review is written. */
async function ask(page: Page, question: string): Promise<string> {
  const composer = page.getByRole("textbox", { name: "Message" });
  await composer.fill(question);
  await expect(page.getByRole("button", { name: "Send message" })).toBeEnabled();
  await composer.press("Enter");
  await expect(shownAnswer(page)).toContainText("Fake answer:", { timeout: 45_000 });
  const chatId = await activeChatId(page);
  stand!.chatIds.add(chatId);
  return chatId;
}

const session = (chatId: string) => prisma.answerReviewSession.findFirstOrThrow({ where: { chatId } });
const stepTurns = (chatId: string, kind: "answer_review_request" | "answer_revision_request") =>
  prisma.message.count({ where: { chatId, systemTurnKind: kind } });
const composerStatus = (page: Page) => page.getByTestId("answer-review-composer-status");
const checking = new RegExp(`Review · round 1 of 3 · ${REVIEWER_NAME} is checking…`, "u");

test("a review the user left runs on the server, and its end is the one notification", async ({ browser }, testInfo) => {
  test.setTimeout(360_000);
  const baseURL = testInfo.project.use.baseURL;
  const endpoint = unresolvablePushEndpoint("answer-review");
  const settings = await prisma.userSettings.findUniqueOrThrow({ select: { browserNotificationsEnabled: true }, where: { userId } });
  await prisma.userSettings.update({ data: { browserNotificationsEnabled: true }, where: { userId } });
  const subscription = () => prisma.browserPushSubscription.findUnique({ where: { endpoint } });
  const left = await browser.newContext({ baseURL, viewport: { height: 900, width: 1440 } });
  const release = stand!.endpoint.hold();
  try {
    const page = await left.newPage();
    await grantPush(page, endpoint);
    await countAnswerAlerts(page);
    // Settings › Chat defaults: review is off for new chats unless chosen.
    await signInWithLocalToken(page);
    await runAccountMenuAction(page, "Chat defaults");
    await expect(page.getByTestId("settings-default-answer-review-summary")).toHaveText("Off");
    await page.goto("/");
    await expect.poll(async () => (await subscription())?.userId ?? null, { timeout: 30_000 }).toBe(userId);

    await reviewedChat(page);
    const reviewsBefore = stand!.endpoint.reviews.length;
    const chatId = await ask(page, "Check the quarterly total of 12, 15 and 14 [AIQSA_REVIEW_E2E:converge]");
    // The server starts the review on its own: its status line and the composer wait for it.
    await expect(reviewStatus(page)).toHaveText(checking, { timeout: 60_000 });
    await expect(composerStatus(page)).toHaveText("Review in progress — Stop to send now");
    await expect(page.getByTestId("composer-v2").getByRole("button", { name: "Stop answer" })).toBeEnabled();
    await expect.poll(() => stand!.endpoint.reviews.length).toBe(reviewsBefore + 1);
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ fullPage: false, path: testInfo.outputPath("answer-review-auto-running.png") });
    expect(await answerAlerts(page)).toBe(0);
    expect(await session(chatId)).toMatchObject({ maxRounds: 3, mode: "auto", round: 1, state: "running" });

    // The tab closes mid-review; the review goes on without it.
    await left.close();
    release();
    // The end is handled once, after the session settled.
    await expect.poll(async () => (await session(chatId)).endNotifiedAt, { timeout: 180_000 }).not.toBeNull();
    expect(await session(chatId)).toMatchObject({ round: 2, state: "finished", stopReason: "clean" });
    expect(await stepTurns(chatId, "answer_review_request")).toBe(2);
    expect(await stepTurns(chatId, "answer_revision_request")).toBe(1);
    // One push for the whole session: neither the answer nor any step pushed.
    await expect.poll(async () => (await subscription())?.failureCount, { timeout: 90_000 }).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 8_000));
    expect((await subscription())?.failureCount).toBe(1);

    // Reopened, the chat shows the reviewed answer with its history and how the review ended, and stays quiet.
    const reopened = await browser.newContext({ baseURL, viewport: { height: 900, width: 1440 } });
    try {
      const again = await reopened.newPage();
      await countAnswerAlerts(again);
      await signInWithLocalToken(again, `/c/${chatId}`);
      await expect(shownAnswer(again)).toContainText(REVISED, { timeout: 30_000 });
      await expect(reviewStatus(again)).toHaveText(/No substantive issues/u);
      await expect(composerStatus(again)).toHaveCount(0);
      const history = again.getByTestId("answer-review-history");
      await history.getByRole("button", { name: "Review history · 2 rounds" }).click();
      await expect(history).toContainText("Version 1");
      await expect(history).toContainText(`Review by ${REVIEWER_NAME} · round 1`);
      await expect(history).toContainText("Revision by Fake QSA · round 1");
      await expect(history).toContainText(`Review by ${REVIEWER_NAME} · round 2`);
      await expect(history).toContainText("Version 2 is the answer shown above.");
      // The chat keeps its choice for the next question.
      await expect(again.getByTestId("header-model-review")).toHaveAttribute("data-state", "on");
      await expectNoHorizontalOverflow(again);
      await again.screenshot({ fullPage: false, path: testInfo.outputPath("answer-review-auto-reopened.png") });
      await again.waitForTimeout(3_000);
      expect(await answerAlerts(again)).toBe(0);
    } finally {
      await reopened.close();
    }
  } finally {
    release();
    await left.close().catch(() => undefined);
    await prisma.browserPushSubscription.deleteMany({ where: { endpoint } });
    await prisma.userSettings.update({ data: settings, where: { userId } });
  }
});

test("a clean first review ends after one review and notifies once; the header chip fits at every size", async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  await countAnswerAlerts(page);
  await signInWithLocalToken(page);
  const chips = await reviewedChat(page);
  const chatId = await ask(page, "Summarize the plan in one line [AIQSA_REVIEW_E2E:clean]");
  await expect(reviewStatus(page)).toHaveText(/No substantive issues/u, { timeout: 90_000 });
  await expect(shownAnswer(page)).toContainText("Fake answer: Summarize the plan");
  await expect(composerStatus(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Send message" })).toBeVisible();
  await expect.poll(async () => (await session(chatId)).endNotifiedAt, { timeout: 30_000 }).not.toBeNull();
  expect(await session(chatId)).toMatchObject({ round: 1, state: "finished", stopReason: "clean" });
  expect(await stepTurns(chatId, "answer_review_request")).toBe(1);
  expect(await stepTurns(chatId, "answer_revision_request")).toBe(0);
  // The answer and its review rang once together: at the session's end.
  await expect.poll(() => answerAlerts(page), { timeout: 15_000 }).toBe(1);
  await page.waitForTimeout(3_000);
  expect(await answerAlerts(page)).toBe(1);

  // The header chip carries the review as a glyph (the count beside it from tablets up) and fits;
  // the composer's chips stay as they were.
  const trigger = page.getByTestId("header-model-trigger");
  await captureState(page, testInfo, "answer-review-auto-header", { atEachSize: async ({ size }) => {
    await expectWithinViewport(page, trigger);
    const glyph = trigger.getByTestId("header-model-review");
    await expect(glyph).toBeVisible();
    const count = glyph.locator(".v2-live-model-review-count");
    if (size.width < 768) await expect(count).toBeHidden();
    else await expect(count).toHaveText("1");
    await expectNoHorizontalOverflow(page);
    expect(await composerChips(page)).toEqual(chips);
  } });

  // The model picker's row says what the chat's review is, at every size.
  const sizes: readonly CaptureSize[] = [{ height: 900, width: 1440 }, { height: 1024, width: 768 }, { height: 844, width: 390 },
    { height: 390, width: 844 }];
  for (const size of sizes) {
    await page.setViewportSize(size);
    await trigger.click();
    const row = modelPicker(page).getByTestId("composer-v2-model-answer-review");
    await row.scrollIntoViewIfNeeded();
    await expectWithinViewport(page, row);
    await expect(row).toContainText("Answer review");
    await expect(row).toContainText("On · 1 reviewer · up to 3 rounds");
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ fullPage: false, path: testInfo.outputPath(`answer-review-auto-picker-${size.width}x${size.height}.png`) });
    await page.keyboard.press("Escape");
    await expect(modelPicker(page)).toHaveCount(0);
  }
  await page.setViewportSize({ height: 900, width: 1440 });

  // `/review` turns the chat's review off and on again; the choice is the chat's.
  const field = page.getByTestId("composer-v2").getByLabel("Message", { exact: true });
  const palette = page.getByRole("listbox", { name: "Commands" });
  for (const enabled of [false, true]) {
    const saved = page.waitForResponse((response) => response.request().method() === "PATCH" &&
      new URL(response.url()).pathname === `/api/chats/${chatId}`);
    await field.focus();
    await page.keyboard.type("/review");
    await palette.getByRole("option", { name: /Review answers/u }).click();
    expect((await saved).ok()).toBe(true);
    if (enabled) await expect(page.getByTestId("header-model-review")).toHaveAttribute("data-state", "on");
    else await expect(page.getByTestId("header-model-review")).toHaveCount(0);
    await expect(field).toHaveValue("");
  }
  expect((await prisma.chat.findUniqueOrThrow({ where: { id: chatId } })).answerReviewConfig).toMatchObject({ enabled: true,
    maxRounds: 3 });
});

test("Stop during a review step ends the session as the user's stop and frees the composer", async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  await countAnswerAlerts(page);
  await signInWithLocalToken(page);
  // The chat starts on desktop, where the navigation offers New chat.
  await reviewedChat(page);
  await page.setViewportSize({ height: 1180, width: 820 });
  const release = stand!.endpoint.hold();
  try {
    const chatId = await ask(page, "Check the invoice total [AIQSA_REVIEW_E2E:findings]");
    await expect(reviewStatus(page)).toHaveText(checking, { timeout: 60_000 });
    await expect(composerStatus(page)).toHaveText("Review in progress — Stop to send now");
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ fullPage: false, path: testInfo.outputPath("answer-review-auto-stop-tablet.png") });
    const stop = page.getByTestId("composer-v2").getByRole("button", { name: "Stop answer" });
    await expect(stop).toBeEnabled({ timeout: 30_000 });
    const stopped = page.waitForResponse((candidate) => candidate.request().method() === "POST" &&
      /^\/api\/answer-reviews\/[^/]+\/stop$/u.test(new URL(candidate.url()).pathname), { timeout: 60_000 });
    await stop.click();
    expect((await stopped).status()).toBe(200);
    await expect(reviewStatus(page)).toHaveText(/^Stopped$/u, { timeout: 30_000 });
    await expect(composerStatus(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Send message" })).toBeVisible();
    await expect(shownAnswer(page)).toContainText("Fake answer: Check the invoice total");
    await expect.poll(async () => (await session(chatId)).endNotifiedAt, { timeout: 30_000 }).not.toBeNull();
    expect(await session(chatId)).toMatchObject({ state: "stopped", stopReason: "user_stopped" });
    const step = await prisma.modelRun.findFirstOrThrow({ where: { chatId, userMessage: { systemTurnKind: "answer_review_request" } } });
    await expect.poll(async () => (await prisma.modelRun.findUniqueOrThrow({ where: { id: step.id } })).status, { timeout: 30_000 })
      .toBe("cancelled");
    // The user's own Stop rings nothing.
    await page.waitForTimeout(3_000);
    expect(await answerAlerts(page)).toBe(0);
    expect(await stepTurns(chatId, "answer_review_request")).toBe(1);
  } finally {
    release();
  }
});

test("a usage limit reached during the review stops it and keeps the latest version", async ({ page }) => {
  test.setTimeout(240_000);
  await countAnswerAlerts(page);
  await signInWithLocalToken(page);
  // The chat starts on desktop, where the navigation offers New chat.
  await reviewedChat(page);
  await page.setViewportSize({ height: 390, width: 844 });
  const previous = await prisma.usageLimit.findUnique({ where: { userId } });
  const reviewsBefore = stand!.endpoint.reviews.length;
  // The first round runs; the second round's review waits until the limit is in place.
  const release = stand!.endpoint.hold(1);
  let spendId: string | null = null;
  try {
    const chatId = await ask(page, "Estimate the cost [AIQSA_REVIEW_E2E:findings]");
    await expect.poll(() => stand!.endpoint.reviews.length, { timeout: 120_000 }).toBe(reviewsBefore + 2);
    await expect(shownAnswer(page)).toContainText(REVISED, { timeout: 30_000 });
    spendId = (await prisma.usageEvent.create({ data: { chatId, estimatedCostMicros: 10_000, inputTokens: 1, modelId: "fake-qsa",
      outputTokens: 1, provider: "fake", purpose: "chat_answer", totalTokens: 2, usageCompleteness: "COMPLETE", userId } })).id;
    await prisma.usageLimit.upsert({ create: { monthlyBudgetMicros: BigInt(1), userId },
      update: { exempt: false, monthlyBudgetMicros: BigInt(1) }, where: { userId } });
    release();
    await expect(reviewStatus(page)).toHaveText(/Stopped: usage limit reached/u, { timeout: 90_000 });
    await expect(shownAnswer(page)).toContainText(REVISED);
    await expect(page.getByRole("button", { name: "Review history · 2 rounds" })).toBeVisible();
    await expect(composerStatus(page)).toHaveCount(0);
    await expect.poll(async () => (await session(chatId)).endNotifiedAt, { timeout: 30_000 }).not.toBeNull();
    expect(await session(chatId)).toMatchObject({ round: 2, state: "stopped", stopReason: "budget" });
    expect(await stepTurns(chatId, "answer_review_request")).toBe(2);
    expect(await stepTurns(chatId, "answer_revision_request")).toBe(1);
    await expectNoHorizontalOverflow(page);
    // A review that ended on its own notifies once.
    await expect.poll(() => answerAlerts(page), { timeout: 15_000 }).toBe(1);
  } finally {
    release();
    if (previous) {
      await prisma.usageLimit.update({ data: { exempt: previous.exempt, messagesPerDay: previous.messagesPerDay,
        messagesPerHour: previous.messagesPerHour, monthlyBudgetMicros: previous.monthlyBudgetMicros }, where: { userId } });
    } else {
      await prisma.usageLimit.deleteMany({ where: { userId } });
    }
    if (spendId) await prisma.usageEvent.delete({ where: { id: spendId } });
  }
});

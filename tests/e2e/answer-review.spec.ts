import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { DEFAULT_BOOTSTRAP_USER_ID } from "../../lib/server/auth/config";
import {
  openAnswerReviewStand,
  REVIEW_FINDING as finding,
  REVIEWER_NAME as reviewerName,
  reviewStatus as status,
  shownAnswer,
  type AnswerReviewStand
} from "./support/answerReviewStand";
import { turnComposerToolsOff } from "./support/composerToolsOff";
import { expectNoHorizontalOverflow } from "./support/layoutAssertions";
import { signInWithLocalToken } from "./support/localAuth";
import { activeChatId, disableMemoryRecall, sendAndExpect, startNewChat } from "./support/workspace";

/**
 * Manual answer review on the fake-provider stand (see the stand's notes in
 * support/answerReviewStand.ts). Fake QSA's window is 8k: every chat runs
 * with Workspace, MCP, Skills and Search off.
 *
 * Not covered here: a reviewer's MCP write gated by approval (the approval
 * card path is unit-tested in lib/domain/answerReviewProgress.test.ts and
 * the gate in the MCP approval suites) and a real process restart (the step
 * claim is proven in lib/server/answerReviews/repository.prisma.test.ts).
 */

test.describe.configure({ mode: "serial" });

const prisma = new PrismaClient();
const userId = DEFAULT_BOOTSTRAP_USER_ID;
let stand: AnswerReviewStand | null = null;

test.beforeAll(async ({ browser }, testInfo) => {
  test.setTimeout(300_000);
  stand = await openAnswerReviewStand({ baseURL: testInfo.project.use.baseURL, browser, prisma, userId, warmPaths: [
    `/api/chats/${randomUUID()}/answer-reviews`, "/api/answer-reviews/route-warmup/steps", `/api/model-runs/${randomUUID()}/cancel`
  ] });
});

test.afterAll(async () => {
  await stand?.close();
  await prisma.$disconnect();
});

/** A new chat with Fake QSA and every tool off, answered once. */
async function answeredChat(page: Page, question: string): Promise<string> {
  await signInWithLocalToken(page);
  await disableMemoryRecall(page);
  await startNewChat(page);
  await turnComposerToolsOff(page);
  await expect(page.getByTestId("header-model-trigger")).toContainText("Fake QSA");
  await sendAndExpect(page, question, "Fake answer:");
  const chatId = await activeChatId(page);
  stand!.chatIds.add(chatId);
  return chatId;
}

async function startReview(page: Page): Promise<void> {
  await shownAnswer(page).getByRole("button", { name: "More answer actions" }).click();
  await page.getByRole("menu", { name: "Answer menu" }).getByRole("menuitem", { name: "Review…" }).click();
  const dialog = page.getByRole("dialog", { name: "Review with another model" });
  await expect(dialog).toBeVisible();
  // Only the fixture reviewer: the stand may offer other tool-calling models.
  for (const box of await dialog.getByRole("checkbox", { checked: true }).all()) {
    if (!((await box.getAttribute("aria-label")) ?? (await box.locator("xpath=..").innerText())).includes(reviewerName)) await box.uncheck();
  }
  await dialog.getByRole("checkbox", { name: reviewerName }).check();
  await dialog.getByRole("button", { name: "Start review" }).click();
  // The dialog closes once the round is accepted; the step's progress shows in the status line.
  await expect(dialog).toHaveCount(0, { timeout: 30_000 });
}

/** The signed-in user's default model and the installation's: review steps never change either. */
async function defaultModels() {
  const [settings, policy] = await Promise.all([
    prisma.userSettings.findUniqueOrThrow({ select: { defaultProviderModelId: true }, where: { userId } }),
    prisma.modelPolicy.findUniqueOrThrow({ select: { defaultProviderModelId: true }, where: { id: "installation" } })
  ]);
  return { installation: policy.defaultProviderModelId, user: settings.defaultProviderModelId };
}

test("a review's finding is decided and revised into Version 2, and the next turn reads only the latest version", async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ height: 900, width: 1440 });
  const question = "Check the quarterly total of 12, 15 and 14 [AIQSA_REVIEW_E2E:findings]";
  const chatId = await answeredChat(page, question);
  const defaultsBefore = await defaultModels();
  await startReview(page);
  await expect(status(page)).toHaveText(/Review · round 1 · 1 finding to evaluate/u, { timeout: 60_000 });
  // The server-written turns are never user bubbles.
  await expect(page.locator('article[data-role="user"]')).toHaveCount(1);
  await expect(page.getByText("Answer review request", { exact: false })).toHaveCount(0);
  const history = page.getByTestId("answer-review-history");
  await history.getByRole("button", { name: "Review history · 1 round" }).click();
  await expect(history.getByTestId("answer-review-card")).toContainText(`Review by ${reviewerName}: 1 finding`);
  await expect(history.getByTestId("answer-review-card")).toContainText(finding.problem);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ fullPage: false, path: testInfo.outputPath("answer-review-findings.png") });

  await status(page).getByRole("button", { name: "Revise" }).click();
  await expect(shownAnswer(page)).toContainText("Revised answer: the figure is verified and its source is named.", { timeout: 60_000 });
  await expect(status(page)).toHaveCount(0);
  // The steps ran the reviewer's and the author's models without making either a default.
  expect(await defaultModels()).toEqual(defaultsBefore);
  await page.reload();
  // Version 2 is the answer; the history is collapsed and holds Version 1, the review and the decisions.
  await expect(shownAnswer(page)).toContainText("Revised answer: the figure is verified and its source is named.", { timeout: 30_000 });
  const toggle = page.getByRole("button", { name: "Review history · 1 round" });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await page.screenshot({ fullPage: false, path: testInfo.outputPath("answer-review-version-2-collapsed.png") });
  await toggle.click();
  await expect(history).toContainText("Version 1");
  await expect(history).toContainText(`Review by ${reviewerName} · round 1`);
  await expect(history.getByTestId("answer-review-card")).toContainText("Accepted");
  await expect(history.getByTestId("answer-review-decisions")).toHaveText(/Decisions: 1 accepted, 0 rejected/u);
  await expect(history).toContainText("Version 2 is the answer shown above.");
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ fullPage: false, path: testInfo.outputPath("answer-review-version-2-expanded.png") });
  expect(await prisma.message.count({ where: { chatId, systemTurnKind: { in: ["answer_review_request", "answer_revision_request"] } } }))
    .toBe(2);
  // A manual session stays open for a further round until the chat moves on.
  expect(await prisma.answerReviewSession.findFirstOrThrow({ where: { chatId } })).toMatchObject({ round: 1, state: "running" });

  // The next turn's context holds the question and Version 2, never the review's turns.
  await sendAndExpect(page, "Thanks, what comes next?", "Fake answer: Thanks, what comes next?");
  await expect(shownAnswer(page)).toContainText(`Context memory: ${question}`);
  await expect(shownAnswer(page)).not.toContainText(/Answer (review|revision) request/u);
  await expect(page.getByTestId("answer-review-status")).toHaveCount(0);
  expect(await prisma.answerReviewSession.findFirstOrThrow({ where: { chatId } })).toMatchObject({ state: "stopped",
    stopReason: "superseded" });

  // A branch from that later answer copies the question, Version 2 and the answer: never the review.
  await shownAnswer(page).getByRole("button", { name: "More answer actions" }).click();
  await page.getByRole("menu", { name: "Answer menu" }).getByRole("menuitem", { name: "Branch from here" }).click();
  await expect.poll(() => page.evaluate(() => window.location.pathname), { timeout: 30_000 }).not.toContain(chatId);
  stand!.chatIds.add(await activeChatId(page));
  const branch = page.getByTestId("conversation-thread");
  await expect(branch.locator('article[data-role="assistant"]')).toHaveCount(2, { timeout: 30_000 });
  await expect(branch.locator('article[data-role="user"]')).toHaveCount(2);
  await expect(branch.locator('article[data-role="assistant"]').first()).toContainText("Revised answer: the figure is verified");
  await expect(branch.locator('article[data-role="assistant"]').last()).toContainText("Fake answer: Thanks, what comes next?");
  await expect(branch.locator("[data-system-turn]")).toHaveCount(0);
  await expect(page.getByTestId("answer-review-history")).toHaveCount(0);
  await expect(branch).not.toContainText(/Answer (review|revision) request|Review submitted/u);
});

test("a clean review shows No substantive issues and offers no Revise", async ({ page }) => {
  test.setTimeout(180_000);
  // The chat starts on desktop, where the navigation offers New chat.
  await answeredChat(page, "Summarize the plan in one line [AIQSA_REVIEW_E2E:clean]");
  await page.setViewportSize({ height: 844, width: 390 });
  await startReview(page);
  await expect(status(page)).toHaveText(/No substantive issues/u, { timeout: 60_000 });
  await expect(page.getByRole("button", { name: "Revise" })).toHaveCount(0);
  await expect(shownAnswer(page)).toContainText("Fake answer: Summarize the plan");
  await expectNoHorizontalOverflow(page);
});

test("a budget refusal on a step stops the session and keeps the answer", async ({ page }) => {
  test.setTimeout(180_000);
  const chatId = await answeredChat(page, "Estimate the cost [AIQSA_REVIEW_E2E:findings]");
  await page.setViewportSize({ height: 1180, width: 820 });
  const previous = await prisma.usageLimit.findUnique({ where: { userId } });
  const spend = await prisma.usageEvent.create({ data: { chatId, estimatedCostMicros: 10_000, inputTokens: 1, modelId: "fake-qsa",
    outputTokens: 1, provider: "fake", purpose: "chat_answer", totalTokens: 2, usageCompleteness: "COMPLETE", userId } });
  try {
    await prisma.usageLimit.upsert({ create: { monthlyBudgetMicros: BigInt(1), userId }, update: { exempt: false, monthlyBudgetMicros: BigInt(1) },
      where: { userId } });
    await startReview(page);
    await expect(status(page)).toHaveText(/Stopped: usage limit reached/u, { timeout: 60_000 });
    await expect(shownAnswer(page)).toContainText("Fake answer: Estimate the cost");
    expect(await prisma.answerReviewSession.findFirstOrThrow({ where: { chatId } })).toMatchObject({ state: "stopped",
      stopReason: "budget" });
    expect(await prisma.message.count({ where: { chatId, systemTurnKind: "answer_review_request" } })).toBe(0);
  } finally {
    if (previous) {
      await prisma.usageLimit.update({ data: { exempt: previous.exempt, messagesPerDay: previous.messagesPerDay,
        messagesPerHour: previous.messagesPerHour, monthlyBudgetMicros: previous.monthlyBudgetMicros }, where: { userId } });
    } else {
      await prisma.usageLimit.deleteMany({ where: { userId } });
    }
    await prisma.usageEvent.delete({ where: { id: spend.id } });
  }
});

test("a reload during a step shows the same live state and the step runs once; Stop ends the session", async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  const chatId = await answeredChat(page, "Check the invoice total [AIQSA_REVIEW_E2E:findings]");
  await page.setViewportSize({ height: 390, width: 844 });
  let release = stand!.endpoint.hold();
  const reviewsBefore = stand!.endpoint.reviews.length;
  try {
    await startReview(page);
    const checking = new RegExp(`Review · round 1 · ${reviewerName} is checking…`, "u");
    await expect(status(page)).toHaveText(checking, { timeout: 30_000 });
    await expect.poll(() => stand!.endpoint.reviews.length).toBe(reviewsBefore + 1);
    await page.reload();
    await expect(status(page)).toHaveText(checking, { timeout: 30_000 });
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ fullPage: false, path: testInfo.outputPath("answer-review-live-after-reload.png") });
    release();
    await expect(status(page)).toHaveText(/1 finding to evaluate/u, { timeout: 60_000 });
    expect(stand!.endpoint.reviews.length).toBe(reviewsBefore + 1);
    expect(await prisma.message.count({ where: { chatId, systemTurnKind: "answer_review_request" } })).toBe(1);

    // A stopped step ends the session; the answer stays.
    await sendAndExpect(page, "One more check [AIQSA_REVIEW_E2E:findings]", "Fake answer: One more check");
    release = stand!.endpoint.hold();
    await startReview(page);
    await expect(status(page)).toHaveText(checking, { timeout: 30_000 });
    // Stop waits, like the answer's own Stop, until the server has acknowledged the step's run.
    const stop = status(page).getByRole("button", { name: "Stop" });
    await expect(stop).toBeEnabled({ timeout: 30_000 });
    const cancelled = page.waitForResponse((candidate) => candidate.request().method() === "POST" &&
      /^\/api\/model-runs\/[^/]+\/cancel$/u.test(new URL(candidate.url()).pathname), { timeout: 60_000 });
    await stop.click();
    expect((await cancelled).status()).toBe(200);
    await expect(status(page)).toHaveText(/^Stopped$/u, { timeout: 30_000 });
    await expect(shownAnswer(page)).toContainText("Fake answer: One more check");
  } finally {
    release();
  }
});

import { execFileSync } from "node:child_process";
import { PrismaClient, type Prisma } from "@prisma/client";
import { expect, test } from "@playwright/test";
import { DEFAULT_BOOTSTRAP_USER_ID } from "../../lib/server/auth/config";
import { snapshotComposerDefaults, turnComposerToolsOff } from "./support/composerToolsOff";
import { signInWithLocalToken } from "./support/localAuth";
import { activeChatId, disableMemoryRecall, sendAndExpect, startNewChat } from "./support/workspace";

/**
 * An answer review recorded before Answer Review was removed (operator
 * decision 2026-10-25), on the fake-provider stand: a chat answered through
 * the app gets the steps the previous release wrote (a review turn and its
 * answer, a revision turn and the revised answer, the session row). The chat
 * reads as its question and the revised answer, offers no review, and
 * Regenerate answers the question again beside that answer. The projection's
 * other paths (pages, branch graph, message search, deletion, sends after a
 * step) are proven in lib/server/chats/legacyAnswerReviews.prisma.test.ts.
 */

test.describe.configure({ mode: "serial" });

const prisma = new PrismaClient();
const userId = DEFAULT_BOOTSTRAP_USER_ID;
const QUESTION = `Check the quarterly total of 12, 15 and 14 (${Date.now()})`;
const REVIEW_TURN = "[Answer review request — written by AIQSA] Review the previous answer.";
const REVIEW = "Review submitted: one finding.";
const REVISION_TURN = "[Answer revision request — written by AIQSA] Revise the answer.";
const REVISED = "Revised answer: the figure is verified and its source is named.";
const chatIds = new Set<string>();
let restoreDefaults: (() => Promise<void>) | null = null;

test.beforeAll(() => {
  execFileSync(process.execPath, ["--import", "tsx", "scripts/stateful-test-target.ts"], { stdio: "pipe" });
});

test.afterAll(async () => {
  const ids = [...chatIds];
  if (ids.length > 0) {
    // The sessions and their steps go with their chats.
    await prisma.$transaction(async (tx) => {
      await tx.modelRun.deleteMany({ where: { chatId: { in: ids } } });
      await tx.memoryJob.deleteMany({ where: { chatId: { in: ids }, userId } });
      await tx.memoryRetrievalAttempt.deleteMany({ where: { chatId: { in: ids }, userId } });
      await tx.memoryRecallChunk.deleteMany({ where: { chatId: { in: ids }, userId } });
      await tx.chatMemoryCheckpointMessage.deleteMany({ where: { chatId: { in: ids } } });
      await tx.chatMemoryCheckpoint.deleteMany({ where: { chatId: { in: ids } } });
      await tx.workspaceSession.deleteMany({ where: { chatId: { in: ids } } });
      await tx.chat.deleteMany({ where: { id: { in: ids }, userId } });
    });
  }
  await restoreDefaults?.();
  await prisma.$disconnect();
});

/** The steps the previous release wrote after the chat's answer, ending on the revised answer as the chat's leaf. */
async function seedLegacyReview(chatId: string) {
  const answer = await prisma.message.findFirstOrThrow({ orderBy: { createdAt: "desc" }, where: { chatId, role: "assistant" } });
  const question = answer.parentMessageId!;
  const session = await prisma.answerReviewSession.create({ data: {
    authorModel: { modelId: answer.modelId, name: "Fake QSA", provider: answer.provider }, chatId, mode: "manual",
    reviewers: [{ modelId: "fixture/reviewer", name: "Fixture Reviewer", provider: "fixture" }],
    sourceAssistantMessageId: answer.id, state: "stopped", stopReason: "user_stopped", userId
  } });
  const say = async (role: "assistant" | "user", text: string, parentMessageId: string,
    extra: Partial<Prisma.MessageUncheckedCreateInput>) => (await prisma.message.create({ data: {
    answerReviewSessionId: session.id, chatId, content: { blocks: [{ text, type: "text" }] }, parentMessageId, role,
    status: "complete", ...extra
  }, select: { id: true } })).id;
  const author = { modelId: answer.modelId, provider: answer.provider };
  const reviewTurn = await say("user", REVIEW_TURN, answer.id,
    { answerReviewRound: 1, answerReviewStep: 0, systemTurnKind: "answer_review_request" });
  const review = await say("assistant", REVIEW, reviewTurn, { modelId: "fixture/reviewer", provider: "fixture" });
  const revisionTurn = await say("user", REVISION_TURN, review,
    { answerReviewRound: 1, answerReviewStep: 1, systemTurnKind: "answer_revision_request" });
  const version = await say("assistant", REVISED, revisionTurn, author);
  await prisma.chat.update({ data: { activeLeafMessageId: version }, where: { id: chatId } });
  return { answer: answer.id, question, review, version };
}

test("a reviewed answer of the previous release reads as its latest version, and Regenerate answers its question again", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ height: 900, width: 1440 });
  restoreDefaults = await snapshotComposerDefaults(prisma, userId);
  await signInWithLocalToken(page);
  await disableMemoryRecall(page);
  await startNewChat(page);
  await turnComposerToolsOff(page);
  await expect(page.getByTestId("header-model-trigger")).toContainText("Fake QSA");
  await sendAndExpect(page, QUESTION, "Fake answer:");
  const chatId = await activeChatId(page);
  chatIds.add(chatId);
  const seeded = await seedLegacyReview(chatId);

  await page.reload();
  const thread = page.getByTestId("conversation-thread");
  const answers = thread.locator('article[data-role="assistant"]');
  await expect(answers).toHaveCount(1, { timeout: 30_000 });
  await expect(answers.first()).toHaveAttribute("data-message-id", seeded.version);
  await expect(answers.first()).toContainText(REVISED);
  const questions = thread.locator('article[data-role="user"]');
  await expect(questions).toHaveCount(1);
  await expect(questions.first()).toHaveAttribute("data-message-id", seeded.question);
  // Neither the server-written turns, the review nor the first version shows.
  for (const hidden of ["Answer review request", "Answer revision request", REVIEW, "Fake answer:"]) {
    await expect(thread).not.toContainText(hidden);
  }

  await answers.first().hover();
  await answers.first().getByRole("button", { name: "More answer actions" }).click();
  const menu = page.getByRole("menu", { name: "Answer menu" });
  await expect(menu.getByRole("menuitem", { name: "Report a problem…" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: /Review/u })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);

  await answers.first().hover();
  await answers.first().getByRole("button", { name: "Regenerate answer", exact: true }).click();
  await expect(answers.first()).toContainText("Fake answer:", { timeout: 45_000 });
  await expect(page.getByRole("button", { name: "Stop answer" })).toHaveCount(0, { timeout: 45_000 });
  const regenerated = await prisma.message.findMany({ select: { id: true, parentMessageId: true }, where: { chatId, id: {
    notIn: [seeded.answer, seeded.review, seeded.version] }, role: "assistant" } });
  // A sibling of the revised answer: an answer of the question, never of a step.
  expect(regenerated).toEqual([{ id: expect.any(String), parentMessageId: seeded.question }]);
  await expect(answers.first()).toHaveAttribute("data-message-id", regenerated[0]!.id);
  await expect(page.getByTestId("branch-pager").getByLabel("Version 2 of 2")).toHaveText("2/2");
  await page.getByRole("button", { name: "Previous version", exact: true }).click();
  await expect(answers.first()).toHaveAttribute("data-message-id", seeded.version);
  await expect(answers.first()).toContainText(REVISED);
});

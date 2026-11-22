import { randomUUID } from "node:crypto";
import { type Prisma, PrismaClient } from "@prisma/client";
import { expect, test } from "@playwright/test";
import { expectNoHorizontalOverflow } from "./support/layoutAssertions";
import { createPeopleFixture } from "./support/people";

/**
 * A chat answered before v0.5.0 keeps what the old Memory stored with its run:
 * `memory_search` steps (one found something, one failed), a step of the
 * retired model-driven Memory tools, and the old Memory fields of the frozen
 * request. It opens and reads after the upgrade: the answer, its fold with a
 * plain legacy label, and nothing of the removed Memory source lists, remember
 * receipts or `/memory` cards, with no error and no empty frame where they were.
 */
const prisma = new PrismaClient();
const people = createPeopleFixture(prisma);
test.describe.configure({ mode: "serial" });
test.afterAll(async () => {
  await people.cleanup();
  await prisma.$disconnect();
});

const QUESTION = "Which rollout window did we agree on?";
const ANSWER = "The rollout window is Tuesday morning, as agreed in the planning chat.";

/** The frozen request as the old Memory wrote it, beside the ordinary fields. */
function legacyNormalizedRequest(): Prisma.InputJsonValue {
  return {
    modelId: "gpt-5.5",
    provider: "openai",
    params: {},
    prompt: {
      developer: null,
      system: null,
      memoryActionAnswerResult: { operation: "SAVE", status: "COMMITTED", version: 1 }
    },
    memoryStandingVersion: 1,
    memorySearch: {
      version: "memory-search-v1", maxCalls: 3, resultTokens: 6000, comparisonResultTokens: 12000,
      timeoutSeconds: 30, memoryGeneration: 4, referenceChatHistory: true, destinations: []
    },
    personalContext: {
      approxTokens: 12, itemCount: 1, memoryGeneration: 4, memoryRevision: 2, mode: "standing-v1", text: "Synthetic saved detail."
    }
  };
}

function memorySearchResult(outcome: "failure" | "results"): Prisma.InputJsonValue {
  return { content: [{ type: "json", value: { version: "memory-search-v1", outcome, items: [] } }] };
}

async function seedLegacyChat(userId: string): Promise<string> {
  const chat = await prisma.chat.create({ data: { title: "Rollout planning (before the upgrade)", userId } });
  const at = Date.now() - 3 * 86_400_000;
  const question = await prisma.message.create({ data: {
    chatId: chat.id, content: { blocks: [{ text: QUESTION, type: "text" }] }, createdAt: new Date(at), role: "user", status: "complete"
  } });
  const answer = await prisma.message.create({ data: {
    chatId: chat.id, content: { blocks: [{ text: ANSWER, type: "text" }] }, createdAt: new Date(at + 20_000),
    parentMessageId: question.id, role: "assistant", status: "complete"
  } });
  const runId = randomUUID();
  await prisma.modelRun.create({ data: {
    assistantMessageId: answer.id, chatId: chat.id, createdAt: new Date(at + 1_000), id: runId, modelId: "gpt-5.5",
    normalizedRequest: legacyNormalizedRequest(), provider: "openai", status: "complete", userId, userMessageId: question.id
  } });
  const started = new Date(at + 2_000);
  const completed = new Date(at + 3_200);
  await prisma.modelRunToolCall.createMany({ data: [
    { arguments: { query: "rollout window" }, completedAt: completed, modelRunId: runId, ordinal: 0, providerCallId: "legacy-call-1",
      result: memorySearchResult("results"), roundIndex: 1, startedAt: started, state: "complete", toolName: "memory_search" },
    { arguments: { query: "rollout window decision" }, completedAt: completed, modelRunId: runId, ordinal: 1, providerCallId: "legacy-call-2",
      result: memorySearchResult("failure"), roundIndex: 1, startedAt: started, state: "error", toolName: "memory_search" },
    { arguments: { statement: "Rollouts happen on Tuesday mornings." }, completedAt: completed, modelRunId: runId, ordinal: 0,
      providerCallId: "legacy-call-3", result: { content: [{ type: "text", text: "Saved." }] }, roundIndex: 2, startedAt: started,
      state: "complete", toolName: "save_memory" }
  ] });
  await prisma.chat.update({ data: { activeLeafMessageId: answer.id }, where: { id: chat.id } });
  return chat.id;
}

test("a chat answered before the upgrade opens and reads without the removed Memory parts", async ({ browser }) => {
  test.setTimeout(120_000);
  const user = await people.user("Legacy memory reader", { memory: true });
  const chatId = await seedLegacyChat(user.id);
  const { page } = await people.signIn(browser, user);

  for (const viewport of [{ height: 900, width: 1440 }, { height: 844, width: 390 }] as const) {
    await page.setViewportSize(viewport);
    await page.goto(`/c/${chatId}`);
    const answer = page.locator('article[data-role="assistant"]').filter({ hasText: ANSWER });
    await expect(answer).toBeVisible();
    await expect(page.getByText(QUESTION)).toBeVisible();

    const fold = answer.getByTestId("tool-activity-disclosure");
    await expect(fold).toBeVisible();
    if (!await fold.evaluate((node) => (node as HTMLDetailsElement).open)) await fold.locator(":scope > summary").click();
    // The search that found something keeps its plain label; the failed one leaves no step.
    await expect(fold).toContainText("Searched memory");
    await expect(fold).not.toContainText(/memory_search|failed|unavailable/iu);

    // Nothing of the removed Memory parts, and no error where they were.
    await expect(answer).not.toContainText(/Memory · \d|Memory saved|Not saved to Memory|Manage Memories/u);
    await expect(answer.getByRole("button", { name: /Memory actions|Correct|Not relevant|Forget/u })).toHaveCount(0);
    await expect(page.locator("[role='alert']:not(#__next-route-announcer__)")).toHaveCount(0);
    await expect(page.getByTestId("shell-notice")).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
  }

  // A reload reads the same chat again.
  await page.reload();
  await expect(page.locator('article[data-role="assistant"]').filter({ hasText: ANSWER })).toBeVisible();
  await expect(page.locator("[role='alert']:not(#__next-route-announcer__)")).toHaveCount(0);
});

// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { textMessageContent } from "../../domain/content";
import { prisma } from "../prisma";
import { createPrismaFetchUrlOperations } from "./prismaRepositoryFetchUrl";

const users: string[] = [];
const operations = createPrismaFetchUrlOperations(prisma);

/** An owner, a personal chat with a stored user turn (optionally a scheduled prompt) and its run. */
async function turn(input: Readonly<{ scheduledPrompt?: boolean }> = {}) {
  const userId = `fetch-url-test-${randomUUID()}`;
  users.push(userId);
  await prisma.user.create({ data: { displayName: "Synthetic page reader", id: userId, status: "active" } });
  const chatId = randomUUID();
  const questionId = randomUUID();
  const answerId = randomUUID();
  const runId = randomUUID();
  await prisma.chat.create({ data: { id: chatId, title: "Synthetic chat", userId } });
  await prisma.message.create({ data: { chatId, content: textMessageContent("Read https://news.example/today"), id: questionId,
    role: "user", ...(input.scheduledPrompt ? { scheduledTaskPrompt: true } : {}), status: "complete" } });
  await prisma.message.create({ data: { chatId, content: textMessageContent(""), id: answerId, parentMessageId: questionId,
    role: "assistant", status: "streaming" } });
  await prisma.modelRun.create({ data: { assistantMessageId: answerId, chatId, id: runId, modelId: "fake-qsa", normalizedRequest: {},
    provider: "fake", status: "streaming", userId, userMessageId: questionId } });
  return { answerId, chatId, questionId, runId, userId };
}

afterEach(async () => {
  const ids = users.splice(0);
  await prisma.chat.deleteMany({ where: { userId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
});
afterAll(() => prisma.$disconnect());

describe("page reader persistence reads", () => {
  it("returns only the run's own Search sources and hosted search and citation output, for its owner", async () => {
    const own = await turn();
    const other = await turn();
    await prisma.searchRun.create({ data: { artifacts: { sources: [{ rank: 1, title: "A", url: "https://found.example/a" }] },
      invocationId: "call-1:search", modelRunId: own.runId, provider: "openrouter", status: "complete", strategyId: "perplexity" } });
    await prisma.searchRun.create({ data: { artifacts: { sources: [{ rank: 1, title: "B", url: "https://elsewhere.example/b" }] },
      invocationId: "call-1:search", modelRunId: other.runId, provider: "openrouter", status: "complete", strategyId: "perplexity" } });
    await prisma.modelRunEvent.createMany({ data: [
      { eventType: "artifact", modelRunId: own.runId, sequence: 0,
        payload: { artifactType: "search", payload: { action: { sources: [{ rank: 1, title: "C", url: "https://hosted.example/c" }] } } } },
      { eventType: "artifact", modelRunId: own.runId, sequence: 1,
        payload: { artifactType: "citation", payload: { index: 1, title: "D", url: "https://cited.example/d" } } },
      { eventType: "artifact", modelRunId: own.runId, sequence: 2,
        payload: { artifactType: "reasoning", payload: { entry: 0, text: "https://not-a-source.example/" } } }
    ] });
    expect(await operations.loadRunSearchSourceUrls({ runId: own.runId, userId: own.userId })).toEqual([
      "https://found.example/a", "https://hosted.example/c", "https://cited.example/d"
    ]);
    // Another user's view of the run reads nothing.
    expect(await operations.loadRunSearchSourceUrls({ runId: own.runId, userId: other.userId })).toEqual([]);
  });

  it("lists only the run's page-reader calls", async () => {
    const own = await turn();
    await prisma.modelRunToolCall.createMany({ data: [
      { arguments: { url: "https://news.example/today" }, modelRunId: own.runId, ordinal: 0, providerCallId: "read-1",
        result: { callId: "read-1", content: [{ type: "json", value: {} }], name: "fetch_url", status: "complete" },
        roundIndex: 1, state: "complete", toolName: "fetch_url" },
      { arguments: {}, modelRunId: own.runId, ordinal: 1, providerCallId: "other-1", roundIndex: 1, state: "running",
        toolName: "get_session_status" }
    ] });
    const calls = await operations.loadRunFetchUrlCalls({ runId: own.runId, userId: own.userId });
    expect(calls).toEqual([expect.objectContaining({ state: "complete" })]);
    expect(await operations.loadRunFetchUrlCalls({ runId: own.runId, userId: "someone-else" })).toEqual([]);
  });

  it("names the chat's scheduled prompts among the branch messages, failing closed beyond its bound", async () => {
    const prompt = await turn({ scheduledPrompt: true });
    const plain = await turn();
    expect(await operations.loadScheduledPromptMessageIds({ chatId: prompt.chatId, userId: prompt.userId,
      messageIds: [prompt.questionId, prompt.answerId, plain.questionId] })).toEqual(new Set([prompt.questionId]));
    const many = Array.from({ length: 1_005 }, (_, index) => `missing-${index}`);
    const marked = await operations.loadScheduledPromptMessageIds({ chatId: plain.chatId, userId: plain.userId,
      messageIds: [plain.questionId, ...many] });
    expect(marked.has(plain.questionId)).toBe(false);
    expect(marked.has("missing-1004")).toBe(true);
  });
});

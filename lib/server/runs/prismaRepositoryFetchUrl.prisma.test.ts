// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { textMessageContent } from "../../domain/content";
import { prisma } from "../prisma";
import { FETCH_URL_LIMITS } from "../tools/fetchUrlPlan";
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

/** A stored page read of `url`, with the shape the page reader's cache takes back. */
const storedRead = (providerCallId: string, url: string) => ({ callId: providerCallId, content: [{ type: "json",
  value: { contentType: "html", fetchedAt: "2026-11-01T09:00:00.000Z", finalUrl: url, text: "Page text", title: null, truncated: false, url } }],
name: "fetch_url", rawPreview: { fetchUrl: { dispatched: true, outcome: "read", url, version: 1 } }, status: "complete" });

describe("page reader persistence reads", () => {
  it("takes back only the run's reads, for its owner", async () => {
    const own = await turn();
    await prisma.modelRunToolCall.createMany({ data: [
      { arguments: { url: "https://news.example/today" }, modelRunId: own.runId, ordinal: 0, providerCallId: "read-1",
        result: storedRead("read-1", "https://news.example/today"), roundIndex: 1, state: "complete", toolName: "fetch_url" },
      { arguments: { url: "https://planted.example/" }, modelRunId: own.runId, ordinal: 1, providerCallId: "refused",
        result: { callId: "refused", content: [], name: "fetch_url", rawPreview: { fetchUrl: { dispatched: false,
          outcome: "fetch_url_not_in_conversation", version: 1 } }, status: "error" }, roundIndex: 1, state: "error", toolName: "fetch_url" },
      { arguments: {}, modelRunId: own.runId, ordinal: 2, providerCallId: "other-1", roundIndex: 1, state: "running",
        toolName: "get_session_status" }
    ] });
    const calls = await operations.loadRunFetchUrlCalls({ runId: own.runId, userId: own.userId });
    expect(calls).toEqual([{ result: expect.objectContaining({ callId: "read-1" }) }]);
    expect(await operations.loadRunFetchUrlCalls({ runId: own.runId, userId: "someone-else" })).toEqual([]);
  });

  it("takes back the newest reads when the run read more than the cache holds, its sub-agents' too", async () => {
    const own = await turn();
    const total = FETCH_URL_LIMITS.cachedPages + 2;
    await prisma.modelRunToolCall.createMany({ data: Array.from({ length: total }, (_, ordinal) => ({
      arguments: { url: `https://site${ordinal}.example/` }, modelRunId: own.runId, ordinal, providerCallId: `read-${ordinal}`,
      result: storedRead(`read-${ordinal}`, `https://site${ordinal}.example/`), roundIndex: 1, state: "complete" as const, toolName: "fetch_url",
      // The same run holds a foreground sub-agent's reads under its own keys.
      ...(ordinal === total - 1 ? { subagentThreadId: "thread-1", subagentTurnId: "turn-1" } : {}) })) });
    const calls = await operations.loadRunFetchUrlCalls({ runId: own.runId, userId: own.userId });
    expect(calls).toHaveLength(FETCH_URL_LIMITS.cachedPages);
    expect(calls.at(-1)).toEqual({ result: expect.objectContaining({ callId: `read-${total - 1}` }) });
    expect(calls[0]).toEqual({ result: expect.objectContaining({ callId: "read-2" }) });
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

// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { textMessageContent } from "../../../domain/content";
import { providerTemplateIds } from "../../../domain/providerTemplates";
import { prisma } from "../../prisma";
import { createPrismaDiscordRunFacts } from "./runFacts";

/**
 * A Discord run's totals and AIQSA's own Discord posts, read from a
 * disposable database. Every id is synthetic and unique to the run of the
 * test; each test removes the user (and with it the chat, run and rows) it made.
 */

const facts = createPrismaDiscordRunFacts(prisma);
const users: string[] = [];
const loose: bigint[] = [];
let next = 1_200_000_000_000_000_000n + BigInt(Math.floor(Math.random() * 1_000_000_000)) * 1_000n;
const snowflake = () => next++;

afterEach(async () => {
  await prisma.discordReply.deleteMany({ where: { questionMessageId: { in: loose.splice(0) } } });
  await prisma.user.deleteMany({ where: { id: { in: users.splice(0) } } });
});
afterAll(() => prisma.$disconnect());

async function run(input: Readonly<{ status: "complete" | "error"; errorPayload?: Readonly<{ code: string; message: string }> }>) {
  const userId = `discord-facts-${randomUUID()}`;
  users.push(userId);
  await prisma.user.create({ data: { displayName: "Discord", id: userId, kind: "service", status: "active" } });
  const chat = await prisma.chat.create({ data: { defaultProviderModelId: providerTemplateIds.fakeModel, memoryMode: "EXCLUDED", title: "Thread", userId } });
  const question = await prisma.message.create({ data: { chatId: chat.id, content: textMessageContent("Question"), role: "user", status: "complete" } });
  const answer = await prisma.message.create({ data: { chatId: chat.id, content: textMessageContent("Answer"), parentMessageId: question.id,
    role: "assistant", status: input.status } });
  const created = await prisma.modelRun.create({ data: {
    assistantMessageId: answer.id, chatId: chat.id, engine: "native", modelId: "fake-qsa", provider: "fake", status: input.status, userId,
    userMessageId: question.id,
    ...(input.errorPayload ? { errorPayload: { code: input.errorPayload.code, message: input.errorPayload.message } } : {}),
    normalizedRequest: {
      mcp: { tools: [{ namespacedName: "mcp_tracker_search", originalName: "search", serverId: "server-tracker", serverName: "Tracker" }] },
      mcpDiscovery: { catalog: { servers: [{ serverId: "server-wiki", tools: [{ namespacedName: "mcp_wiki_read" }] }], version: 1 }, epochs: [], version: 2 }
    }
  } });
  return { chatId: chat.id, runId: created.id, userId };
}

function call(runId: string, ordinal: number, toolName: string, state: "complete" | "error") {
  return { arguments: {}, modelRunId: runId, ordinal, providerCallId: `call-${ordinal}`, roundIndex: 1, state, toolName };
}

describe("Discord run facts (stateful)", () => {
  it("totals a run's MCP calls and errors per server id, its compactions and sub-agent turns, and reads its failure code", async () => {
    const { chatId, runId, userId } = await run({ errorPayload: { code: "provider_rate_limited", message: "limited" }, status: "error" });
    await prisma.modelRunToolCall.createMany({ data: [
      call(runId, 0, "mcp_tracker_search", "complete"), call(runId, 1, "mcp_tracker_search", "error"), call(runId, 2, "mcp_wiki_read", "complete"),
      call(runId, 3, "web_search", "complete")
    ] });
    await prisma.runTranscriptItem.create({ data: { body: {}, chatId, kind: "compaction", modelRunId: runId, sequence: 0, userId } });
    await expect(facts.summary(runId)).resolves.toEqual({
      compactions: 1, errorCode: "provider_rate_limited", mcpByServer: { "server-tracker": { calls: 2, errors: 1 }, "server-wiki": { calls: 1, errors: 0 } },
      subagents: 0
    });
    await expect(facts.summary(randomUUID())).resolves.toBeNull();
  });

  it("names AIQSA's own posts with their question's conversation, and the questions of a run", async () => {
    const { runId } = await run({ status: "complete" });
    const question = snowflake();
    const status = snowflake();
    const refusal = snowflake();
    const refused = snowflake();
    loose.push(question, refused);
    await prisma.discordReply.createMany({ data: [
      { authorName: "Synthetic author", channelId: 1_200_000_000_000_000_010n, discordUserId: 1_200_000_000_000_000_020n, questionMessageId: question,
        runId, statusMessageId: status, answerMessageId: status, state: "delivered" },
      { authorName: "Synthetic author", channelId: 1_200_000_000_000_000_010n, discordUserId: 1_200_000_000_000_000_020n, kind: "refused",
        questionMessageId: refused, statusMessageId: refusal, state: "failed" }
    ] });
    const own = await facts.aiqsaMessages([status.toString(), refusal.toString(), snowflake().toString()]);
    expect([...own.entries()].sort()).toEqual([[refusal.toString(), null], [status.toString(), null]].sort());
    await expect(facts.questionsOfRun(runId)).resolves.toEqual([question.toString()]);
  });

  it("names a chat's first run", async () => {
    const { chatId, runId } = await run({ status: "complete" });
    await expect(facts.firstRunOfChat(chatId)).resolves.toBe(runId);
    await expect(facts.firstRunOfChat(randomUUID())).resolves.toBeNull();
  });
});

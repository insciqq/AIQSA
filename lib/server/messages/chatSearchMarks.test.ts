import type { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { textMessageContent } from "../../domain/content";
import { recordingTransaction, type RecordedCall } from "../chatSearch/index/markRecorder.testFixtures";
import { createPrismaMessageBranchRepository } from "./prismaRepository";

const OWNER = "owner-1";
const CHAT = { activeLeafMessageId: "answer-1", defaultProviderModelId: null, folderId: null, id: "chat-1",
  importSource: null, importSourceModel: null, memoryMode: "NORMAL", title: "Trip plans", userId: OWNER };
const MESSAGES = [
  { content: textMessageContent("Where to?"), createdAt: new Date("2026-11-01T10:00:00Z"), id: "question-1",
    parentMessageId: null, role: "user", status: "complete" },
  { content: textMessageContent("Lisbon."), createdAt: new Date("2026-11-01T10:01:00Z"), id: "answer-1",
    parentMessageId: "question-1", role: "assistant", status: "complete" }
];

const isChatLock = (call: RecordedCall) => call.name === "$queryRaw" && Boolean(call.text?.includes("FOR UPDATE OF chat"));
const isLeafWrite = (leaf: string | null) => (call: RecordedCall) => call.name === "chat.update" &&
  (call.args as { data?: { activeLeafMessageId?: string | null } }).data?.activeLeafMessageId === leaf;
const isDirtyMark = (call: RecordedCall) => call.name === "$executeRaw" &&
  Boolean(call.text?.startsWith("INSERT INTO \"ChatSearchState\""));

function repository(handlers: Parameters<typeof recordingTransaction>[0]) {
  const recorder = recordingTransaction({ $queryRaw: (call) => isChatLock(call as RecordedCall) ? [CHAT] : [], ...handlers });
  return { recorder, repository: createPrismaMessageBranchRepository(recorder.client as unknown as PrismaClient) };
}

describe("message writers mark past-chat search in their own transaction", () => {
  it("an edit moves the leaf to the edited message and marks the chat after locking it", async () => {
    const { recorder, repository: messages } = repository({
      "message.create": () => ({ id: "edited-1" }),
      "message.findFirst": () => ({ ...MESSAGES[0], chatId: CHAT.id, modelId: null, provider: null })
    });

    await messages.createEditedMessageBranch({ content: { blocks: [{ text: "Where in May?", type: "text" }] },
      originalMessageId: "question-1", userId: OWNER });

    const lock = recorder.indexOf(isChatLock);
    const leaf = recorder.indexOf(isLeafWrite("edited-1"));
    const mark = recorder.indexOf(isDirtyMark);
    expect(lock).toBeGreaterThan(recorder.indexOf((call) => call.name === "$transaction"));
    expect(leaf).toBeGreaterThan(lock);
    expect(mark).toBeGreaterThan(leaf);
    expect(recorder.marks()).toEqual([{ kind: "dirty", values: expect.arrayContaining([CHAT.id, OWNER]) }]);
  });

  it("a deletion of the active tail moves the leaf up and marks the chat before the messages go", async () => {
    const { recorder, repository: messages } = repository({
      "chat.findUniqueOrThrow": () => ({ updatedAt: new Date() }),
      "message.findFirst": () => ({ chatId: CHAT.id, id: "answer-1", parentMessageId: "question-1" }),
      "message.findMany": () => MESSAGES.map(({ id, parentMessageId, status }) => ({ id, parentMessageId, status }))
    });

    await expect(messages.deleteMessageSubtree({ messageId: "answer-1", userId: OWNER })).resolves.toMatchObject({
      activeLeafMessageId: "question-1", deletedMessageIds: ["answer-1"]
    });

    const leaf = recorder.indexOf(isLeafWrite("question-1"));
    const mark = recorder.indexOf(isDirtyMark);
    expect(leaf).toBeGreaterThan(recorder.indexOf(isChatLock));
    expect(mark).toBeGreaterThan(leaf);
    expect(mark).toBeLessThan(recorder.indexOf((call) => call.name === "message.delete"));
    expect(recorder.marks()).toEqual([{ kind: "dirty", values: expect.arrayContaining([CHAT.id, OWNER]) }]);
  });

  it("a deletion off the active branch keeps the leaf and still marks the chat", async () => {
    const sibling = { id: "answer-0", parentMessageId: "question-1", status: "complete" };
    const { recorder, repository: messages } = repository({
      "chat.findUniqueOrThrow": () => ({ updatedAt: new Date() }),
      "message.findFirst": () => ({ chatId: CHAT.id, id: sibling.id, parentMessageId: sibling.parentMessageId }),
      "message.findMany": () => [...MESSAGES.map(({ id, parentMessageId, status }) => ({ id, parentMessageId, status })), sibling]
    });

    await messages.deleteMessageSubtree({ messageId: sibling.id, userId: OWNER });

    expect(recorder.calls.some((call) => call.name === "chat.update")).toBe(false);
    expect(recorder.indexOf(isDirtyMark)).toBeGreaterThan(recorder.indexOf(isChatLock));
    expect(recorder.marks()).toEqual([{ kind: "dirty", values: expect.arrayContaining([CHAT.id, OWNER]) }]);
  });

  it("a branch copy marks the new chat, never the source", async () => {
    let copied = 0;
    const { recorder, repository: messages } = repository({
      "chat.create": () => ({ id: "copy-1" }),
      "chat.findUniqueOrThrow": () => ({ activeLeafMessageId: "copied", createdAt: new Date(), defaultProviderModel: null,
        folderId: null, id: "copy-1", importSource: null, importSourceModel: null, pinned: false, title: "Branch: Trip plans",
        updatedAt: new Date() }),
      "message.create": () => ({ id: `copied-${copied++}` }),
      "message.findFirst": () => ({ chatId: CHAT.id, id: "answer-1", role: "assistant", status: "complete" }),
      "message.findMany": () => MESSAGES.map((message) => ({ ...message,
        assistantModelRuns: [], branchFollowups: null, branchSourceModelRunId: null, errorMessage: null, inputTokens: null,
        modelId: null, outputTokens: null, provider: null, reasoningTokens: null, scheduledTaskPrompt: false,
        systemTurnKind: null }))
    });

    await messages.createChatBranchFromMessage({ sourceMessageId: "answer-1", userId: OWNER });

    const leaf = recorder.indexOf((call) => call.name === "chat.update" &&
      (call.args as { where: { id: string } }).where.id === "copy-1");
    expect(leaf).toBeGreaterThan(recorder.indexOf((call) => call.name === "chat.create"));
    expect(recorder.indexOf(isDirtyMark)).toBeGreaterThan(leaf);
    const marks = recorder.marks();
    expect(marks).toEqual([{ kind: "dirty", values: expect.arrayContaining(["copy-1", OWNER]) }]);
    expect(marks[0]!.values).not.toContain(CHAT.id);
    // Each copied message stays out of past-chat search where its source did, before the copy is marked.
    const carried = recorder.indexOf((call) => call.text?.startsWith("INSERT INTO \"ChatSearchExcludedMessage\"") ?? false);
    expect(carried).toBeGreaterThan(recorder.indexOf((call) => call.name === "message.create"));
    expect(carried).toBeLessThan(recorder.indexOf(isDirtyMark));
    expect(recorder.calls[carried]!.values).toEqual(["copy-1", OWNER, ["question-1", "answer-1"], ["copied-0", "copied-1"],
      CHAT.id, OWNER]);
  });

  it("a branch copy of a continued chat keeps its summary prompt the server's, so answering it there is no request of the user's", async () => {
    let copied = 0;
    const { recorder, repository: messages } = repository({
      "chat.create": () => ({ id: "copy-1" }),
      "chat.findUniqueOrThrow": () => ({ activeLeafMessageId: "copied", createdAt: new Date(), defaultProviderModel: null,
        folderId: null, id: "copy-1", importSource: null, importSourceModel: null, pinned: false, title: "Branch: Trip plans",
        updatedAt: new Date() }),
      "message.create": () => ({ id: `copied-${copied++}` }),
      "message.findFirst": () => ({ chatId: CHAT.id, id: "answer-1", role: "assistant", status: "complete" }),
      "message.findMany": () => MESSAGES.map((message) => ({ ...message,
        assistantModelRuns: [], branchFollowups: null, branchSourceModelRunId: null, errorMessage: null, inputTokens: null,
        modelId: null, outputTokens: null, provider: null, reasoningTokens: null, scheduledTaskPrompt: false,
        systemTurnKind: message.role === "user" ? "conversation_summary" : null }))
    });

    await messages.createChatBranchFromMessage({ sourceMessageId: "answer-1", userId: OWNER });

    const created = recorder.calls.filter((call) => call.name === "message.create")
      .map((call) => (call.args as { data: { role: string; systemTurnKind?: string } }).data);
    expect(created.map((message) => [message.role, message.systemTurnKind ?? null])).toEqual([
      ["user", "conversation_summary"], ["assistant", null]]);
  });
});

import type { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { chatTitleWork } from "@/tests/support/chatTitles";
import { MEMORY_CONFIRMATION_COPY_VERSION } from "../../contracts/memoryClient";
import { recordingTransaction, type RecordedCall } from "../chatSearch/index/markRecorder.testFixtures";
import type { WorkspaceAvailabilityService } from "../workspace/availability";
import { createPrismaPermanentChatDeletionRepository } from "./permanentDeletion/repository";
import { createPrismaChatRepository } from "./prismaRepository";
import { createChatTitleRepository } from "./titleGenerationRepository";

const OWNER = "owner-1";
const CHAT_ID = "chat-1";
const LOCKED = { activeLeafMessageId: "answer-1", archived: false, folderId: null, id: CHAT_ID, memoryMode: "NORMAL",
  title: "Trip plans", updatedAt: new Date("2026-11-01T10:00:00Z"), userId: OWNER };

const workspaceAvailability = {
  project: () => ({ state: "unavailable" }),
  snapshot: async () => ({})
} as unknown as WorkspaceAvailabilityService;

const summaryRow = (overrides: Record<string, unknown> = {}) => ({
  _count: { messages: 2 }, activeLeafMessageId: "answer-1", assistantId: null, computerCwd: null, computerDeviceId: null,
  continuationSource: null, createdAt: new Date("2026-11-01T09:00:00Z"), defaultProviderModel: null,
  folderId: null, id: CHAT_ID, importSource: null, importSourceModel: null, pinned: false,
  receivedWorkspaceSeeds: [], title: "Trip plans", titleGeneration: null, titleRevision: 1,
  updatedAt: new Date("2026-11-01T10:00:00Z"), workspaceEnabled: true, workspaceSession: null, ...overrides
});

const isChatLock = (call: RecordedCall) => call.name === "$queryRaw" && Boolean(call.text?.includes("FOR UPDATE"));

function chats(handlers: Parameters<typeof recordingTransaction>[0] = {}) {
  const recorder = recordingTransaction({
    $queryRaw: (call) => isChatLock(call as RecordedCall) ? [{ ...LOCKED, importSource: null }] : [],
    "chat.findUnique": () => ({ permanentDeletionAt: null, userId: OWNER }),
    "chat.findUniqueOrThrow": () => summaryRow(),
    "chat.update": () => summaryRow(),
    "message.findFirst": () => ({ id: "answer-0" }),
    ...handlers
  });
  return {
    recorder,
    repository: createPrismaChatRepository(recorder.client as unknown as PrismaClient, { workspaceAvailability })
  };
}

describe("chat writers mark past-chat search in their own transaction", () => {
  it("excluding a chat clears its passages at once, after the chat is locked and written", async () => {
    const { recorder, repository } = chats();

    await expect(repository.setMemoryMode({ chatId: CHAT_ID, mode: "EXCLUDED", userId: OWNER })).resolves.toEqual({
      kind: "ok"
    });

    const write = recorder.indexOf((call) => call.name === "chat.update");
    expect(recorder.calls[write]!.args).toMatchObject({ data: { memoryMode: "EXCLUDED" }, where: { id: CHAT_ID } });
    expect(write).toBeGreaterThan(recorder.indexOf(isChatLock));
    expect(recorder.marks()).toEqual([
      { kind: "clear", values: [CHAT_ID] }
    ]);
    expect(recorder.indexOf((call) => call.text?.startsWith("DELETE FROM \"ChatSearchState\"") ?? false))
      .toBeGreaterThan(write);
  });

  it("resuming a chat marks it to be indexed again", async () => {
    const { recorder, repository } = chats({
      $queryRaw: (call) => isChatLock(call as RecordedCall) ? [{ ...LOCKED, importSource: null, memoryMode: "EXCLUDED" }] : []
    });

    await expect(repository.setMemoryMode({ chatId: CHAT_ID, mode: "NORMAL", userId: OWNER,
      resumeDisclosureCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION })).resolves.toMatchObject({ kind: "ok" });

    expect(recorder.marks()).toEqual([{ kind: "dirty", values: expect.arrayContaining([CHAT_ID, OWNER]) }]);
  });

  it("an imported chat cannot resume, so nothing is marked", async () => {
    const { recorder, repository } = chats({
      $queryRaw: (call) => isChatLock(call as RecordedCall)
        ? [{ ...LOCKED, importSource: "CHATGPT", memoryMode: "EXCLUDED" }] : []
    });

    await expect(repository.setMemoryMode({ chatId: CHAT_ID, mode: "NORMAL", userId: OWNER,
      resumeDisclosureCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION })).resolves.toEqual({ kind: "imported" });
    expect(recorder.marks()).toEqual([]);
    expect(recorder.calls.some((call) => call.name === "chat.update")).toBe(false);
  });

  it("a branch switch writes the leaf and marks the chat", async () => {
    const { recorder, repository } = chats();

    await repository.updateChat({ activeLeafMessageId: "answer-0", chatId: CHAT_ID, userId: OWNER });

    const write = recorder.indexOf((call) => call.name === "chat.update" &&
      (call.args as { data: { activeLeafMessageId?: string } }).data.activeLeafMessageId === "answer-0");
    expect(write).toBeGreaterThan(recorder.indexOf(isChatLock));
    expect(recorder.indexOf((call) => call.name === "$executeRaw")).toBeGreaterThan(write);
    expect(recorder.marks()).toEqual([{ kind: "dirty", values: expect.arrayContaining([CHAT_ID, OWNER]) }]);
  });

  it("a rename marks the chat, since every passage carries the title", async () => {
    const { recorder, repository } = chats();

    await repository.updateChat({ chatId: CHAT_ID, title: "Lisbon in May", userId: OWNER });

    const rename = recorder.indexOf((call) => call.name === "chat.update" &&
      (call.args as { data: { title?: string } }).data.title === "Lisbon in May");
    expect(rename).toBeGreaterThan(recorder.indexOf(isChatLock));
    expect(recorder.indexOf((call) => call.name === "$executeRaw")).toBeGreaterThan(rename);
    expect(recorder.marks()).toEqual([{ kind: "dirty", values: expect.arrayContaining([CHAT_ID, OWNER]) }]);
  });

  it("a folder move, a favorite and an unchanged title mark nothing", async () => {
    const { recorder, repository } = chats({ $queryRaw: (call) => (call as RecordedCall).text?.includes("\"Folder\"")
      ? [{ id: "folder-1" }]
      : isChatLock(call as RecordedCall) ? [{ ...LOCKED, importSource: null }] : [] });

    await repository.updateChat({ chatId: CHAT_ID, folderId: "folder-1", userId: OWNER });
    await repository.updateChat({ chatId: CHAT_ID, pinned: true, userId: OWNER });
    await repository.updateChat({ chatId: CHAT_ID, title: " Trip plans ", userId: OWNER });

    expect(recorder.marks()).toEqual([]);
  });

  it("archiving and restoring write the flag and mark nothing", async () => {
    const { recorder, repository } = chats({
      $queryRaw: (call) => isChatLock(call as RecordedCall) ? [{ ...LOCKED, archived: true }] : []
    });

    await expect(repository.setArchived({ archived: false, chatId: CHAT_ID, userId: OWNER }))
      .resolves.toMatchObject({ chat: { archived: false }, kind: "ok" });
    // The chat's own state is the fence: restoring a chat that is not archived is stale.
    await expect(chats().repository.setArchived({ archived: false, chatId: CHAT_ID, userId: OWNER }))
      .resolves.toEqual({ kind: "stale" });

    expect(recorder.calls.find((call) => call.name === "chat.update")?.args).toMatchObject({
      data: { archived: false, ownerKeptAt: expect.any(Date) }, where: { id: CHAT_ID }
    });
    expect(recorder.marks()).toEqual([]);
  });

  it("the permanent-deletion fence clears the chat's passages in the fencing transaction", async () => {
    const recorder = recordingTransaction({
      $queryRaw: () => [{ activeLeafMessageId: "answer-1", memoryMode: "NORMAL", permanentDeletionAt: null }]
    });
    const repository = createPrismaPermanentChatDeletionRepository(recorder.client as unknown as PrismaClient);

    await expect(repository.admit({ chatId: CHAT_ID, expectedActiveLeafMessageId: "answer-1",
      now: new Date(), userId: OWNER })).resolves.toMatchObject({ kind: "ok" });

    const fence = recorder.indexOf((call) => call.name === "chat.updateMany");
    expect(recorder.marks()).toEqual([{ kind: "clear", values: [CHAT_ID] }]);
    expect(recorder.indexOf((call) => call.name === "$executeRaw")).toBeGreaterThan(fence);
  });

  it("a generated title marks the chat only when it was written", async () => {
    const work = chatTitleWork({ chatId: CHAT_ID, userId: OWNER });
    for (const written of [1, 0]) {
      const recorder = recordingTransaction({
        "chat.updateMany": () => ({ count: written }),
        "chatTitleGeneration.updateMany": () => ({ count: 1 }),
        "providerCredentialVersion.findFirst": () => ({ id: work.providerSnapshot.credentialVersionId })
      });

      await createChatTitleRepository(recorder.client as unknown as PrismaClient).finish(work, "Lisbon in May");

      expect(recorder.marks()).toEqual(written
        ? [{ kind: "dirty", values: expect.arrayContaining([CHAT_ID, OWNER]) }]
        : []);
      if (written) {
        expect(recorder.indexOf((call) => call.name === "$executeRaw"))
          .toBeGreaterThan(recorder.indexOf((call) => call.name === "chat.updateMany"));
      }
    }
  });
});

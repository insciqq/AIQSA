import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadAuthorizedChatPrintDocument, loadChatPrintGeneratedImages } from "./printChat";

const access = vi.hoisted(() => ({ resolveChatAccess: vi.fn() }));
vi.mock("../projects/access", () => ({ resolveChatAccess: access.resolveChatAccess }));

const at = (minute: number) => new Date(Date.UTC(2026, 8, 1, 12, minute));
const noRuns = { assistantModelRuns: [], branchFollowups: null };

const chatRow = {
  activeLeafMessageId: "db-a2",
  archived: false,
  createdAt: at(0),
  id: "db-chat",
  memoryMode: "NORMAL",
  pinned: false,
  title: "Отчёт о релизе",
  updatedAt: at(9)
};

const branchRows = [
  { ...noRuns, content: { blocks: [{ text: "Первый вопрос", type: "text" }] }, createdAt: at(1), id: "db-q", modelId: null,
    parentMessageId: null, provider: null, role: "user", status: "complete" },
  { ...noRuns, content: { blocks: [{ text: "Ответ с картинкой", type: "text" }] }, createdAt: at(2), id: "db-a2", modelId: "m",
    parentMessageId: "db-q", provider: "p", role: "assistant", status: "complete" }
];

const generatedImage = (id: string) => ({
  attachmentId: id, byteSize: 100, fileName: "image.png", height: 768, mimeType: "image/png", sourceAttachmentIds: [], width: 1024
});

/** Answers' latest runs with their image outputs; one mismatched and one non-image metadata. */
const runRows = [{
  assistantModelRuns: [{ workspaceProducedAttachments: [
    { id: "gen-1", metadata: { image: generatedImage("gen-1") } },
    { id: "gen-2", metadata: { image: generatedImage("someone-else") } },
    { id: "gen-3", metadata: {} }
  ] }],
  id: "db-a2"
}];

function fakePrisma(chat: Record<string, unknown> | null) {
  const messageQueries: Array<Record<string, unknown>> = [];
  const tx = {
    attachment: { findMany: vi.fn(async () => []) },
    chat: { findFirst: vi.fn(async () => chat) },
    message: {
      findMany: vi.fn(async (args: Record<string, unknown>) => {
        messageQueries.push(args);
        return messageQueries.length === 1 ? branchRows : runRows;
      })
    }
  };
  const transaction = vi.fn(async (run: (client: typeof tx) => unknown) => run(tx));
  return { db: { $transaction: transaction }, messageQueries, transaction, tx };
}

beforeEach(() => {
  access.resolveChatAccess.mockReset();
});

describe("authorized chat print document", () => {
  it("prints the visible branch with the answer's generated images for the owner and Project members", async () => {
    for (const grant of [{ kind: "personal", project: null, userId: "u1" }, { kind: "project", project: {}, userId: null }]) {
      const { db, messageQueries } = fakePrisma(chatRow);
      access.resolveChatAccess.mockResolvedValueOnce(grant);
      const document = await loadAuthorizedChatPrintDocument(db as never, { chatId: "db-chat", userId: "u1" }, new Date("2026-10-05T00:00:00Z"));
      expect(document).toMatchObject({ fileBaseName: "отчёт-о-релизе-2026-10-05", title: "Отчёт о релизе" });
      expect(document?.turns.map((turn) => turn.text)).toEqual(["Первый вопрос", "Ответ с картинкой"]);
      expect(document?.turns[1]?.images).toEqual([{ attachmentId: "gen-1", height: 768, label: "Generated image", width: 1024 }]);
      expect(messageQueries[1]).toMatchObject({ where: { chatId: "db-chat", id: { in: ["db-a2"] } } });
    }
    expect(access.resolveChatAccess).toHaveBeenCalledWith(expect.anything(), { chatId: "db-chat", userId: "u1" });
  });

  it("returns the same nothing for a stranger and a missing chat, reading no messages", async () => {
    const stranger = fakePrisma(chatRow);
    access.resolveChatAccess.mockResolvedValueOnce(null);
    expect(await loadAuthorizedChatPrintDocument(stranger.db as never, { chatId: "db-chat", userId: "stranger" })).toBeNull();
    expect(stranger.tx.chat.findFirst).not.toHaveBeenCalled();
    expect(stranger.messageQueries).toEqual([]);

    const missing = fakePrisma(null);
    access.resolveChatAccess.mockResolvedValueOnce(null);
    expect(await loadAuthorizedChatPrintDocument(missing.db as never, { chatId: "no-such-chat", userId: "u1" })).toBeNull();
    expect(missing.messageQueries).toEqual([]);
  });

  it("prints archived chats only for their personal owner and never archived temporary ones", async () => {
    const archived = fakePrisma({ ...chatRow, archived: true });
    access.resolveChatAccess.mockResolvedValueOnce({ kind: "personal", project: null, userId: "u1" });
    expect(await loadAuthorizedChatPrintDocument(archived.db as never, { chatId: "db-chat", userId: "u1" })).not.toBeNull();
    const projectArchived = fakePrisma({ ...chatRow, archived: true });
    access.resolveChatAccess.mockResolvedValueOnce({ kind: "project", project: {}, userId: null });
    expect(await loadAuthorizedChatPrintDocument(projectArchived.db as never, { chatId: "db-chat", userId: "viewer" })).toBeNull();
    const temporaryArchived = fakePrisma({ ...chatRow, archived: true, memoryMode: "TEMPORARY" });
    access.resolveChatAccess.mockResolvedValueOnce({ kind: "personal", project: null, userId: "u1" });
    expect(await loadAuthorizedChatPrintDocument(temporaryArchived.db as never, { chatId: "db-chat", userId: "u1" })).toBeNull();
    const temporary = fakePrisma({ ...chatRow, memoryMode: "TEMPORARY" });
    access.resolveChatAccess.mockResolvedValueOnce({ kind: "personal", project: null, userId: "u1" });
    expect(await loadAuthorizedChatPrintDocument(temporary.db as never, { chatId: "db-chat", userId: "u1" })).not.toBeNull();
  });

  it("rejects an id that cannot name a chat before opening a transaction", async () => {
    const { db, transaction } = fakePrisma(chatRow);
    for (const chatId of ["", "a b", "x".repeat(257)]) {
      expect(await loadAuthorizedChatPrintDocument(db as never, { chatId, userId: "u1" })).toBeNull();
    }
    expect(transaction).not.toHaveBeenCalled();
    expect(access.resolveChatAccess).not.toHaveBeenCalled();
  });
});

describe("generated images of printed answers", () => {
  it("skips the query without answers and reads only image outputs of the latest run", async () => {
    const findMany = vi.fn(async () => runRows);
    expect(await loadChatPrintGeneratedImages({ message: { findMany } } as never, "db-chat", [])).toEqual(new Map());
    expect(findMany).not.toHaveBeenCalled();
    const images = await loadChatPrintGeneratedImages({ message: { findMany } } as never, "db-chat", ["db-a2"]);
    expect(images.get("db-a2")).toEqual([{ attachmentId: "gen-1", height: 768, width: 1024 }]);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      select: expect.objectContaining({
        assistantModelRuns: expect.objectContaining({
          orderBy: { createdAt: "desc" },
          select: { workspaceProducedAttachments: expect.objectContaining({ where: { origin: "IMAGE_OUTPUT" } }) },
          take: 1
        })
      })
    }));
  });
});

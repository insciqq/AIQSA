import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { createTestAuth } from "@/tests/support/auth";
import { messageFromApi } from "@/components/app-shell/shellApi";
import { visibleMessagePath } from "@/components/app-shell/threadPath";
import { decodeChatExportDocument } from "../../contracts/chatExport";
import { chatExportMarkdown } from "../../domain/chatExport";
import { projectMessageFollowups } from "../runs/runFollowups";
import {
  createExportChatHandler,
  loadAuthorizedChatExportSource,
  loadChatExportSource,
  type ChatExportChatRow,
  type ExportChatHandlerDeps
} from "./exportChat";

type Load = ExportChatHandlerDeps["load"];

const access = vi.hoisted(() => ({ resolveChatAccess: vi.fn() }));
vi.mock("../projects/access", () => ({ resolveChatAccess: access.resolveChatAccess }));

const auth = createTestAuth();
const at = (minute: number) => new Date(Date.UTC(2026, 8, 1, 12, minute));
const text = (value: string) => ({ blocks: [{ text: value, type: "text" }] });

const chatRow: ChatExportChatRow = {
  activeLeafMessageId: "db-a2",
  archived: false,
  createdAt: at(0),
  id: "db-chat",
  pinned: false,
  title: "Release checklist · 032",
  updatedAt: at(9)
};

const noRuns = { assistantModelRuns: [], branchFollowups: null };

/** Persisted rows: a regenerated answer with a delivered follow-up and a stopped first answer. */
const messageRows = [
  { ...noRuns, content: { blocks: [{ text: "Составь план релиза  ", type: "text" }, { attachmentId: "db-file", fileName: "plan.pdf", type: "file" }] },
    createdAt: at(1), id: "db-q", modelId: null, parentMessageId: null, provider: null, role: "user", status: "complete" },
  { ...noRuns, content: { blocks: [] }, createdAt: at(2), id: "db-a1", modelId: "m", parentMessageId: "db-q", provider: "p",
    role: "assistant", status: "cancelled" },
  {
    assistantModelRuns: [{
      answerCompletedAt: at(5), followupClosedAt: at(5), followupMode: "chat", status: "complete",
      followups: [{ authorName: "Owner", createdAt: at(4), deliveredAt: at(4), id: "db-followup", ordinal: 1,
        precedingText: "Черновик", text: "Добавь откат" }]
    }],
    branchFollowups: null,
    content: { blocks: [{ text: "1. Проверить миграции\n2. Прогнать smoke", type: "text" }] },
    createdAt: at(3), id: "db-a2", modelId: "m", parentMessageId: "db-q", provider: "p", role: "assistant", status: "complete"
  }
];

function fakeReadClient(rows: readonly Record<string, unknown>[] = messageRows) {
  const attachmentQueries: unknown[] = [];
  const messageQueries: unknown[] = [];
  return {
    attachmentQueries,
    messageQueries,
    attachment: {
      findMany: async (args: { where: unknown }) => {
        attachmentQueries.push(args.where);
        return [{ byteSize: 4096, fileName: "plan.pdf", id: "db-file", mimeType: "application/pdf" }];
      }
    },
    message: {
      findMany: async (args: { where: unknown }) => {
        messageQueries.push(args.where);
        return rows;
      }
    }
  };
}

beforeEach(() => {
  access.resolveChatAccess.mockReset();
});

describe("chat export source", () => {
  it("reads one chat's messages and only its referenced attachments in a fixed number of queries", async () => {
    const db = fakeReadClient();
    const source = await loadChatExportSource(db as never, chatRow);
    expect(db.messageQueries).toEqual([{ chatId: "db-chat" }]);
    expect(db.attachmentQueries).toEqual([{ chatId: "db-chat", id: { in: ["db-file"] } }]);
    expect(source.attachments.get("db-file")).toEqual({ byteSize: 4096, mimeType: "application/pdf", name: "plan.pdf" });
    expect(source.messages.find((row) => row.key === "db-a2")?.followups?.entries.map((entry) => entry.text)).toEqual(["Добавь откат"]);
  });

  it("skips the attachment query for a chat without attachments", async () => {
    const db = fakeReadClient([{ ...messageRows[1]!, parentMessageId: null }]);
    await loadChatExportSource(db as never, { ...chatRow, activeLeafMessageId: "db-a1" });
    expect(db.attachmentQueries).toEqual([]);
  });
});

describe("authorized chat export source", () => {
  function fakePrisma(chat: Record<string, unknown> | null) {
    const tx = { ...fakeReadClient(), chat: { findFirst: vi.fn(async () => chat) } };
    return { db: { $transaction: async (run: (client: typeof tx) => unknown) => run(tx) }, tx };
  }

  it("uses the chat read rule for active personal and Project chats", async () => {
    const { db } = fakePrisma({ ...chatRow, memoryMode: "NORMAL" });
    access.resolveChatAccess.mockResolvedValueOnce({ kind: "personal", project: null, userId: "u1" });
    expect(await loadAuthorizedChatExportSource(db as never, { chatId: "db-chat", userId: "u1" })).not.toBeNull();
    expect(access.resolveChatAccess).toHaveBeenCalledWith(expect.anything(), { chatId: "db-chat", userId: "u1" });
    access.resolveChatAccess.mockResolvedValueOnce({ kind: "project", project: {}, userId: null });
    expect(await loadAuthorizedChatExportSource(db as never, { chatId: "db-chat", userId: "viewer" })).not.toBeNull();
  });

  it("returns nothing without chat access and reads no messages", async () => {
    const { db, tx } = fakePrisma({ ...chatRow, memoryMode: "NORMAL" });
    access.resolveChatAccess.mockResolvedValueOnce(null);
    expect(await loadAuthorizedChatExportSource(db as never, { chatId: "db-chat", userId: "stranger" })).toBeNull();
    expect(tx.chat.findFirst).not.toHaveBeenCalled();
    expect(tx.messageQueries).toEqual([]);
  });

  it("opens archived chats only for their personal owner and never temporary ones", async () => {
    const archived = fakePrisma({ ...chatRow, archived: true, memoryMode: "NORMAL" });
    access.resolveChatAccess.mockResolvedValueOnce({ kind: "personal", project: null, userId: "u1" });
    expect(await loadAuthorizedChatExportSource(archived.db as never, { chatId: "db-chat", userId: "u1" })).toMatchObject({
      chat: { archived: true }
    });
    access.resolveChatAccess.mockResolvedValueOnce({ kind: "project", project: {}, userId: null });
    expect(await loadAuthorizedChatExportSource(archived.db as never, { chatId: "db-chat", userId: "viewer" })).toBeNull();
    const temporary = fakePrisma({ ...chatRow, archived: true, memoryMode: "TEMPORARY" });
    access.resolveChatAccess.mockResolvedValueOnce({ kind: "personal", project: null, userId: "u1" });
    expect(await loadAuthorizedChatExportSource(temporary.db as never, { chatId: "db-chat", userId: "u1" })).toBeNull();
  });
});

describe("single-chat export route", () => {
  const exportedAt = new Date("2026-09-01T13:00:00.000Z");

  function handler(load: Mock<Load> = vi.fn<Load>(async () => loadChatExportSource(fakeReadClient() as never, chatRow))) {
    return { GET: createExportChatHandler({ load, now: () => exportedAt, resolveAuth: auth.resolveAuth }), load };
  }

  const request = (query = "") => new Request(`http://localhost/api/chats/db-chat/export${query}`, { headers: { cookie: auth.cookie } });

  it("requires a session and a known format before reading the chat", async () => {
    const { GET, load } = handler();
    expect((await GET(new Request("http://localhost/api/chats/db-chat/export"), { params: { chatId: "db-chat" } })).status).toBe(401);
    for (const query of ["?format=pdf", "?format=json&format=markdown", "?format=json&debug=1"]) {
      const response = await GET(request(query), { params: { chatId: "db-chat" } });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "chat_export_format_invalid" });
    }
    expect(load).not.toHaveBeenCalled();
  });

  it("answers a missing, foreign or malformed chat with the same private not-found", async () => {
    const { GET, load } = handler(vi.fn<Load>(async () => null));
    const missing = await GET(request("?format=json"), { params: { chatId: "someone-elses-chat" } });
    const malformed = await GET(request("?format=json"), { params: { chatId: "bad id" } });
    for (const response of [missing, malformed]) {
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toContain("no-store");
      expect(await response.json()).toEqual({ error: "chat_not_found" });
    }
    expect(load).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledWith({ chatId: "someone-elses-chat", userId: auth.session.userId });
  });

  it("downloads the whole tree as a valid aiqsa.chat document", async () => {
    const { GET } = handler();
    const response = await GET(request("?format=json"), { params: { chatId: "db-chat" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(response.headers.get("content-disposition")).toBe(
      "attachment; filename=\"release-checklist-032-2026-09-01.json\"; filename*=UTF-8''release-checklist-032-2026-09-01.json"
    );
    const body = await response.text();
    const decoded = decodeChatExportDocument(JSON.parse(body));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value.exportedAt).toBe("2026-09-01T13:00:00.000Z");
    expect(decoded.value.chat.messages.map((message) => [message.id, message.parentId, message.role])).toEqual([
      ["m1", null, "user"], ["m2", "m1", "assistant"], ["m3", "m1", "assistant"], ["m4", "m3", "user"], ["m5", "m4", "assistant"]
    ]);
    expect(decoded.value.chat.activeLeafId).toBe("m5");
    expect(decoded.value.chat.messages[0]?.attachments).toEqual([{ byteSize: 4096, mimeType: "application/pdf", name: "plan.pdf" }]);
    expect(body).not.toMatch(/db-|Owner|delivered|Tokens|attachmentId/u);
  });

  it("keeps the Markdown byte-identical to the former browser export of the active branch", async () => {
    // The former browser export: API projection -> thread messages -> visible path -> Markdown.
    const thread = messageRows.map((row) => {
      const followups = projectMessageFollowups(row as never);
      return messageFromApi({ ...row, ...(followups ? { followups } : {}) } as never);
    });
    for (const leaf of ["db-a2", "db-a1"]) {
      const former = chatExportMarkdown(chatRow.title, visibleMessagePath(thread, leaf));
      const { GET } = handler(vi.fn<Load>(async () => loadChatExportSource(fakeReadClient() as never, { ...chatRow, activeLeafMessageId: leaf })));
      const response = await GET(request(), { params: { chatId: "db-chat" } });
      expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
      expect(response.headers.get("content-disposition")).toContain("release-checklist-032-2026-09-01.md");
      expect(await response.text()).toBe(former);
    }
  });

  it("gives a non-ASCII title an ASCII fallback name beside the UTF-8 one", async () => {
    const { GET } = handler(vi.fn<Load>(async () => loadChatExportSource(fakeReadClient() as never, { ...chatRow, title: "План релиза" })));
    const response = await GET(request("?format=markdown"), { params: { chatId: "db-chat" } });
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="chat-2026-09-01.md"; filename*=UTF-8''${encodeURIComponent("план-релиза-2026-09-01.md")}`
    );
  });
});

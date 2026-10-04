import { describe, expect, it } from "vitest";
import { getAuthConfig } from "../auth/config";
import { createTestAuth } from "@/tests/support/auth";
import { decodeChatArchiveManifest } from "../../contracts/chatExport";
import { createExportAllChatsHandler, personalChatExportEntries } from "./exportAll";
import { createExportChatHandler, loadChatExportSource } from "./exportChat";
import type { TarEntry } from "./tarArchive";

const config = getAuthConfig({
  AIQSA_BOOTSTRAP_AUTH_TOKEN: "token",
  AIQSA_AUTH_SESSION_SECRET: "secret"
});
const auth = createTestAuth({ user: { id: config.bootstrapUserId } });

type ChatRow = {
  activeLeafMessageId: string | null;
  archived: boolean;
  createdAt: Date;
  id: string;
  pinned: boolean;
  title: string;
  updatedAt: Date;
};

const createdAt = new Date("2026-08-01T09:00:00.000Z");

function fakeDb(chats: ChatRow[], messages: Record<string, Array<Record<string, unknown>>>) {
  const filters: unknown[] = [];
  return {
    filters,
    chat: {
      findMany: async (args: { where: unknown }) => {
        filters.push(args.where);
        return chats;
      }
    },
    attachment: {
      findMany: async () => []
    },
    message: {
      findMany: async (args: { where: { chatId: string } }) => messages[args.where.chatId] ?? []
    }
  };
}

async function entries(iterable: AsyncIterable<TarEntry>): Promise<TarEntry[]> {
  const output: TarEntry[] = [];
  for await (const entry of iterable) output.push(entry);
  return output;
}

describe("export all personal chats", () => {
  it("emits a manifest, then the Markdown branch and the whole-tree aiqsa.chat document per chat", async () => {
    const updatedAt = new Date("2026-09-01T12:00:00.000Z");
    const message = (id: string, parentMessageId: string | null, body: string, minute: number, assistant = false) => ({
      assistantModelRuns: [], branchFollowups: null, content: { blocks: [{ text: body, type: "text" }] },
      createdAt: new Date(Date.UTC(2026, 7, 1, 9, minute)), id, modelId: assistant ? "m" : null, parentMessageId,
      provider: assistant ? "p" : null, role: assistant ? "assistant" : "user", status: "complete"
    });
    const db = fakeDb(
      [
        { activeLeafMessageId: "a2", archived: false, createdAt, id: "c1", pinned: true, title: "Release", updatedAt },
        { activeLeafMessageId: null, archived: true, createdAt, id: "c2", pinned: false, title: "Release", updatedAt }
      ],
      {
        c1: [
          message("u1", null, "Q1", 1),
          message("a1", "u1", "old branch", 2, true),
          message("a2", "u1", "A2", 3, true)
        ]
      }
    );
    const output = await entries(personalChatExportEntries(
      db as never,
      "user-1",
      new Date("2026-09-01T13:00:00.000Z")
    ));
    expect(output.map((entry) => entry.path)).toEqual([
      "manifest.json",
      "release-2026-09-01.md",
      "release-2026-09-01.json",
      "archived/release-2026-09-01.md",
      "archived/release-2026-09-01.json"
    ]);
    const manifest = decodeChatArchiveManifest(JSON.parse(String(output[0]?.content)));
    expect(manifest).toEqual({ ok: true, value: {
      chats: [
        { archived: false, markdownPath: "release-2026-09-01.md", path: "release-2026-09-01.json", title: "Release", updatedAt: "2026-09-01T12:00:00.000Z" },
        { archived: true, markdownPath: "archived/release-2026-09-01.md", path: "archived/release-2026-09-01.json", title: "Release", updatedAt: "2026-09-01T12:00:00.000Z" }
      ],
      exportedAt: "2026-09-01T13:00:00.000Z",
      format: "aiqsa.chat-archive",
      version: 1
    } });
    expect(output[1]?.content).toBe("# Release\n\n## User\n\nQ1\n\n## Assistant\n\nA2\n");
    expect(JSON.parse(String(output[2]?.content))).toEqual({
      chat: {
        activeLeafId: "m3",
        archived: false,
        createdAt: "2026-08-01T09:00:00.000Z",
        messages: [
          { createdAt: "2026-08-01T09:01:00.000Z", id: "m1", parentId: null, role: "user", status: "complete", text: "Q1" },
          { createdAt: "2026-08-01T09:02:00.000Z", id: "m2", model: { modelId: "m", provider: "p" }, parentId: "m1", role: "assistant", status: "complete", text: "old branch" },
          { createdAt: "2026-08-01T09:03:00.000Z", id: "m3", model: { modelId: "m", provider: "p" }, parentId: "m1", role: "assistant", status: "complete", text: "A2" }
        ],
        pinned: true,
        title: "Release",
        updatedAt: "2026-09-01T12:00:00.000Z"
      },
      exportedAt: "2026-09-01T13:00:00.000Z",
      format: "aiqsa.chat",
      version: 1
    });
    expect(JSON.parse(String(output[4]?.content)).chat).toMatchObject({ activeLeafId: null, archived: true, messages: [] });
    expect(db.filters[0]).toEqual({
      memoryMode: { not: "TEMPORARY" },
      permanentDeletionAt: null,
      projectId: null,
      userId: "user-1"
    });

    // The single-chat export of the same chat yields the identical documents.
    const exportedAt = new Date("2026-09-01T13:00:00.000Z");
    const single = createExportChatHandler({
      load: async () => loadChatExportSource(db as never, (await db.chat.findMany({ where: {} }))[0]!),
      now: () => exportedAt,
      resolveAuth: auth.resolveAuth
    });
    const singleRequest = (format: string) => single(
      new Request(`http://localhost/api/chats/c1/export?format=${format}`, { headers: { cookie: auth.cookie } }),
      { params: { chatId: "c1" } }
    );
    expect(JSON.parse(await (await singleRequest("json")).text()).chat).toEqual(JSON.parse(String(output[2]?.content)).chat);
    expect(await (await singleRequest("markdown")).text()).toBe(output[1]?.content);
  });

  it("suffixes colliding base names instead of overwriting entries", async () => {
    const updatedAt = new Date("2026-09-01T12:00:00.000Z");
    const db = fakeDb([
      { activeLeafMessageId: null, archived: false, createdAt, id: "c1", pinned: false, title: "Notes", updatedAt },
      { activeLeafMessageId: null, archived: false, createdAt, id: "c2", pinned: false, title: "notes", updatedAt }
    ], {});
    const output = await entries(personalChatExportEntries(db as never, "user-1"));
    expect(output.map((entry) => entry.path)).toEqual([
      "manifest.json",
      "notes-2026-09-01.md",
      "notes-2026-09-01.json",
      "notes-2026-09-01-2.md",
      "notes-2026-09-01-2.json"
    ]);
  });

  it("streams a private gzip attachment for the authenticated user only", async () => {
    let requestedUser: string | null = null;
    const GET = createExportAllChatsHandler({
      entries: (userId) => {
        requestedUser = userId;
        return (async function* empty() {})();
      },
      now: () => new Date("2026-09-01T13:00:00.000Z"),
      resolveAuth: auth.resolveAuth
    });
    const anonymous = await GET(new Request("http://localhost/api/me/chats/export"));
    expect(anonymous.status).toBe(401);

    const response = await GET(new Request("http://localhost/api/me/chats/export", {
      headers: { cookie: auth.cookie }
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/gzip");
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="aiqsa-chats-2026-09-01.tar.gz"'
    );
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(requestedUser).toBe(config.bootstrapUserId);
    const body = new Uint8Array(await response.arrayBuffer());
    expect(body[0]).toBe(0x1f);
    expect(body[1]).toBe(0x8b);
  });
});

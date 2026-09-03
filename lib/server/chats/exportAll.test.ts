import { describe, expect, it } from "vitest";
import { getAuthConfig } from "../auth/config";
import { createTestAuth } from "@/tests/support/auth";
import { createExportAllChatsHandler, personalChatExportEntries } from "./exportAll";
import type { TarEntry } from "./tarArchive";

const config = getAuthConfig({
  AIQSA_BOOTSTRAP_AUTH_TOKEN: "token",
  AIQSA_AUTH_SESSION_SECRET: "secret"
});
const auth = createTestAuth({ user: { id: config.bootstrapUserId } });

type ChatRow = {
  activeLeafMessageId: string | null;
  archived: boolean;
  id: string;
  title: string;
  updatedAt: Date;
};

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
  it("emits Markdown and JSON per chat along the active branch, archived under a prefix", async () => {
    const updatedAt = new Date("2026-09-01T12:00:00.000Z");
    const db = fakeDb(
      [
        { activeLeafMessageId: "a2", archived: false, id: "c1", title: "Release", updatedAt },
        { activeLeafMessageId: null, archived: true, id: "c2", title: "Release", updatedAt }
      ],
      {
        c1: [
          { content: { blocks: [{ text: "Q1", type: "text" }] }, id: "u1", modelId: null, parentMessageId: null, provider: null, role: "user", status: "complete" },
          { content: { blocks: [{ text: "old branch", type: "text" }] }, id: "a1", modelId: "m", parentMessageId: "u1", provider: "p", role: "assistant", status: "complete" },
          { content: { blocks: [{ text: "A2", type: "text" }] }, id: "a2", modelId: "m", parentMessageId: "u1", provider: "p", role: "assistant", status: "complete" }
        ]
      }
    );
    const output = await entries(personalChatExportEntries(
      db as never,
      "user-1",
      new Date("2026-09-01T13:00:00.000Z")
    ));
    expect(output.map((entry) => entry.path)).toEqual([
      "release-2026-09-01.md",
      "release-2026-09-01.json",
      "archived/release-2026-09-01.md",
      "archived/release-2026-09-01.json"
    ]);
    expect(output[0]?.content).toBe("# Release\n\n## User\n\nQ1\n\n## Assistant\n\nA2\n");
    expect(JSON.parse(String(output[1]?.content))).toEqual({
      archived: false,
      exportedAt: "2026-09-01T13:00:00.000Z",
      messages: [
        { content: "Q1", modelId: null, provider: null, role: "user", status: "complete" },
        { content: "A2", modelId: "m", provider: "p", role: "assistant", status: "complete" }
      ],
      title: "Release"
    });
    expect(db.filters[0]).toEqual({
      memoryMode: { not: "TEMPORARY" },
      permanentDeletionAt: null,
      projectId: null,
      userId: "user-1"
    });
  });

  it("suffixes colliding base names instead of overwriting entries", async () => {
    const updatedAt = new Date("2026-09-01T12:00:00.000Z");
    const db = fakeDb([
      { activeLeafMessageId: null, archived: false, id: "c1", title: "Notes", updatedAt },
      { activeLeafMessageId: null, archived: false, id: "c2", title: "notes", updatedAt }
    ], {});
    const output = await entries(personalChatExportEntries(db as never, "user-1"));
    expect(output.map((entry) => entry.path)).toEqual([
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

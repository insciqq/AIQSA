import type { PrismaClient } from "@prisma/client";
import {
  CHAT_ARCHIVE_FORMAT,
  CHAT_ARCHIVE_MANIFEST_PATH,
  CHAT_ARCHIVE_VERSION,
  type ChatArchiveManifest
} from "../../contracts/chatExport";
import { chatExportFileBaseName } from "../../domain/chatExport";
import { chatExportActiveBranchMarkdown, chatExportDocument } from "../../domain/chatExportDocument";
import type { RequestAuthResolver } from "../auth/requestAuth";
import { chatExportChatSelect, loadChatExportSource } from "./exportChat";
import { tarGzipStream, type TarEntry } from "./tarArchive";

type ExportPrismaClient = Pick<PrismaClient, "answerReviewSession" | "attachment" | "chat" | "message">;

function uniqueBaseName(used: Set<string>, base: string): string {
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

/**
 * Every personal chat (active and archived; never Project or Temporary chats)
 * as the same `aiqsa.chat` JSON and Markdown documents the single-chat export
 * produces, one pair per chat, after a root `manifest.json` that lists them.
 * Archived chats live under `archived/`.
 */
export async function* personalChatExportEntries(
  db: ExportPrismaClient,
  userId: string,
  exportedAt: Date = new Date()
): AsyncGenerator<TarEntry> {
  const chats = await db.chat.findMany({
    orderBy: { updatedAt: "desc" },
    select: chatExportChatSelect,
    where: {
      memoryMode: { not: "TEMPORARY" },
      permanentDeletionAt: null,
      projectId: null,
      userId
    }
  });
  const used = new Set<string>();
  const planned = chats.map((chat) => ({
    base: uniqueBaseName(
      used,
      `${chat.archived ? "archived/" : ""}${chatExportFileBaseName(chat.title, chat.updatedAt)}`
    ),
    chat
  }));
  const manifest: ChatArchiveManifest = {
    format: CHAT_ARCHIVE_FORMAT,
    version: CHAT_ARCHIVE_VERSION,
    exportedAt: exportedAt.toISOString(),
    chats: planned.map(({ base, chat }) => ({
      path: `${base}.json`,
      markdownPath: `${base}.md`,
      title: chat.title,
      archived: chat.archived,
      updatedAt: chat.updatedAt.toISOString()
    }))
  };
  yield {
    content: `${JSON.stringify(manifest, null, 2)}\n`,
    mtime: exportedAt,
    path: CHAT_ARCHIVE_MANIFEST_PATH
  };
  for (const { base, chat } of planned) {
    const source = await loadChatExportSource(db, chat);
    yield {
      content: chatExportActiveBranchMarkdown(source),
      mtime: chat.updatedAt,
      path: `${base}.md`
    };
    yield {
      content: `${JSON.stringify(chatExportDocument(source, exportedAt), null, 2)}\n`,
      mtime: chat.updatedAt,
      path: `${base}.json`
    };
  }
}

export type ExportAllChatsHandlerDeps = Readonly<{
  entries(userId: string, exportedAt: Date): AsyncIterable<TarEntry>;
  now?: () => Date;
  resolveAuth: RequestAuthResolver;
}>;

export function createExportAllChatsHandler(deps: ExportAllChatsHandlerDeps) {
  return async function GET(request: Request): Promise<Response> {
    const auth = await deps.resolveAuth(request);
    if (!auth) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    const exportedAt = deps.now?.() ?? new Date();
    const fileName = `aiqsa-chats-${exportedAt.toISOString().slice(0, 10)}.tar.gz`;
    return new Response(tarGzipStream(deps.entries(auth.userId, exportedAt)), {
      headers: {
        "cache-control": "private, no-store, max-age=0",
        "content-disposition": `attachment; filename="${fileName}"`,
        "content-type": "application/gzip",
        vary: "Cookie"
      },
      status: 200
    });
  };
}

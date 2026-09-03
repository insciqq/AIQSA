import type { PrismaClient } from "@prisma/client";
import {
  chatExportFileBaseName,
  chatExportMarkdown,
  chatExportText
} from "../../domain/chatExport";
import type { RequestAuthResolver } from "../auth/requestAuth";
import { tarGzipStream, type TarEntry } from "./tarArchive";

type ExportPrismaClient = Pick<PrismaClient, "chat" | "message">;

type ExportMessageRow = {
  content: unknown;
  id: string;
  modelId: string | null;
  parentMessageId: string | null;
  provider: string | null;
  role: string;
  status: string;
};

function activeBranch(rows: readonly ExportMessageRow[], leafId: string | null): ExportMessageRow[] {
  if (!leafId) return [];
  const byId = new Map(rows.map((row) => [row.id, row]));
  const path: ExportMessageRow[] = [];
  const seen = new Set<string>();
  let cursor: string | null = leafId;
  while (cursor) {
    if (seen.has(cursor)) return [];
    const row = byId.get(cursor);
    if (!row) return [];
    seen.add(cursor);
    path.push(row);
    cursor = row.parentMessageId;
  }
  return path.reverse();
}

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
 * as the same Markdown and JSON documents the per-chat export produces, one
 * pair per chat. Archived chats live under `archived/`.
 */
export async function* personalChatExportEntries(
  db: ExportPrismaClient,
  userId: string,
  exportedAt: Date = new Date()
): AsyncGenerator<TarEntry> {
  const chats = await db.chat.findMany({
    orderBy: { updatedAt: "desc" },
    select: {
      activeLeafMessageId: true,
      archived: true,
      id: true,
      title: true,
      updatedAt: true
    },
    where: {
      memoryMode: { not: "TEMPORARY" },
      permanentDeletionAt: null,
      projectId: null,
      userId
    }
  });
  const used = new Set<string>();
  for (const chat of chats) {
    const rows = await db.message.findMany({
      select: {
        content: true,
        id: true,
        modelId: true,
        parentMessageId: true,
        provider: true,
        role: true,
        status: true
      },
      where: { chatId: chat.id }
    });
    const branch = activeBranch(rows, chat.activeLeafMessageId);
    const base = uniqueBaseName(
      used,
      `${chat.archived ? "archived/" : ""}${chatExportFileBaseName(chat.title, chat.updatedAt)}`
    );
    yield {
      content: chatExportMarkdown(chat.title, branch),
      mtime: chat.updatedAt,
      path: `${base}.md`
    };
    yield {
      content: JSON.stringify({
        archived: chat.archived,
        exportedAt: exportedAt.toISOString(),
        messages: branch.map((message) => ({
          content: chatExportText(message.content),
          modelId: message.modelId,
          provider: message.provider,
          role: message.role,
          status: message.status
        })),
        title: chat.title
      }, null, 2),
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

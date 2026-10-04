import { Prisma, type PrismaClient } from "@prisma/client";
import { chatExportFileBaseName } from "../../domain/chatExport";
import {
  chatExportActiveBranchMarkdown,
  chatExportAttachmentIds,
  chatExportDocument,
  type ChatExportAttachmentMetadata,
  type ChatExportSource
} from "../../domain/chatExportDocument";
import type { RequestAuthResolver } from "../auth/requestAuth";
import { resolveChatAccess } from "../projects/access";
import { messageFollowupSelect } from "../runs/prismaRepositoryFollowups";
import { projectMessageFollowups } from "../runs/runFollowups";

export const chatExportChatSelect = {
  activeLeafMessageId: true,
  archived: true,
  createdAt: true,
  id: true,
  pinned: true,
  title: true,
  updatedAt: true
} satisfies Prisma.ChatSelect;

export type ChatExportChatRow = Prisma.ChatGetPayload<{ select: typeof chatExportChatSelect }>;

const chatExportMessageSelect = {
  ...messageFollowupSelect,
  content: true,
  createdAt: true,
  id: true,
  modelId: true,
  parentMessageId: true,
  provider: true,
  role: true,
  status: true
} satisfies Prisma.MessageSelect;

type ChatExportReadClient = Pick<Prisma.TransactionClient, "attachment" | "message">;

/**
 * Every message of one chat with its follow-ups and attachment metadata, in
 * a fixed number of queries regardless of the chat's size.
 */
export async function loadChatExportSource(db: ChatExportReadClient, chat: ChatExportChatRow): Promise<ChatExportSource> {
  const rows = await db.message.findMany({ select: chatExportMessageSelect, where: { chatId: chat.id } });
  const attachmentIds = [...new Set(rows.flatMap((row) => chatExportAttachmentIds(row.content)))];
  const attachmentRows = attachmentIds.length
    ? await db.attachment.findMany({
        select: { byteSize: true, fileName: true, id: true, mimeType: true },
        where: { chatId: chat.id, id: { in: attachmentIds } }
      })
    : [];
  return {
    attachments: new Map<string, ChatExportAttachmentMetadata>(attachmentRows.map((row) => [
      row.id,
      { byteSize: row.byteSize, mimeType: row.mimeType, name: row.fileName }
    ])),
    chat: {
      activeLeafKey: chat.activeLeafMessageId,
      archived: chat.archived,
      createdAt: chat.createdAt,
      pinned: chat.pinned,
      title: chat.title,
      updatedAt: chat.updatedAt
    },
    messages: rows.map((row) => ({
      content: row.content,
      createdAt: row.createdAt,
      followups: projectMessageFollowups(row),
      key: row.id,
      modelId: row.modelId,
      parentKey: row.parentMessageId,
      provider: row.provider,
      role: row.role,
      status: row.status
    }))
  };
}

/**
 * The export source of a chat the user may open: an active chat under the
 * personal or Project read rule, an archived chat only for its personal
 * owner (never a temporary chat). Anything else is indistinguishable from a
 * missing chat.
 */
export async function loadAuthorizedChatExportSource(
  db: PrismaClient,
  input: Readonly<{ chatId: string; userId: string }>
): Promise<ChatExportSource | null> {
  return db.$transaction(async (tx) => {
    const access = await resolveChatAccess(tx, input);
    if (!access) return null;
    const chat = await tx.chat.findFirst({
      select: { ...chatExportChatSelect, memoryMode: true },
      where: { id: input.chatId, permanentDeletionAt: null }
    });
    if (!chat || chat.archived && (access.kind !== "personal" || chat.memoryMode === "TEMPORARY")) return null;
    return loadChatExportSource(tx, chat);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

type ChatExportFormat = "json" | "markdown";

export type ExportChatHandlerDeps = Readonly<{
  load(input: Readonly<{ chatId: string; userId: string }>): Promise<ChatExportSource | null>;
  now?: () => Date;
  resolveAuth: RequestAuthResolver;
}>;

const PRIVATE_HEADERS = {
  "cache-control": "private, no-store, max-age=0",
  vary: "Cookie"
} as const;

function errorJson(error: string, status: number): Response {
  return Response.json({ error }, { headers: PRIVATE_HEADERS, status });
}

function requestedFormat(request: Request): ChatExportFormat | null {
  const search = new URL(request.url).searchParams;
  const values = search.getAll("format");
  if ([...search.keys()].some((key) => key !== "format") || values.length > 1) return null;
  const format = values[0] ?? "markdown";
  return format === "json" || format === "markdown" ? format : null;
}

function routeChatId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000- \u007f]/u.test(value)
    ? value
    : null;
}

/** RFC 6266 attachment header; the ASCII fallback keeps the extension and date. */
function attachmentDisposition(fileName: string, date: Date, extension: string): string {
  const ascii = /^[A-Za-z0-9._-]+$/u.test(fileName) ? fileName : `chat-${date.toISOString().slice(0, 10)}.${extension}`;
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

/**
 * `GET /api/chats/[chatId]/export?format=json|markdown`: the whole tree as an
 * `aiqsa.chat` document, or the readable Markdown of the active branch.
 */
export function createExportChatHandler(deps: ExportChatHandlerDeps) {
  return async function GET(
    request: Request,
    context: { params: Promise<{ chatId: string }> | { chatId: string } }
  ): Promise<Response> {
    const auth = await deps.resolveAuth(request);
    if (!auth) return errorJson("unauthorized", 401);
    const format = requestedFormat(request);
    if (!format) return errorJson("chat_export_format_invalid", 400);
    const chatId = routeChatId((await context.params).chatId);
    const source = chatId ? await deps.load({ chatId, userId: auth.userId }) : null;
    if (!source) return errorJson("chat_not_found", 404);
    const exportedAt = deps.now?.() ?? new Date();
    const extension = format === "json" ? "json" : "md";
    const fileName = `${chatExportFileBaseName(source.chat.title, exportedAt)}.${extension}`;
    const body = format === "json"
      ? `${JSON.stringify(chatExportDocument(source, exportedAt), null, 2)}\n`
      : chatExportActiveBranchMarkdown(source);
    return new Response(body, {
      headers: {
        ...PRIVATE_HEADERS,
        "content-disposition": attachmentDisposition(fileName, exportedAt, extension),
        "content-type": format === "json" ? "application/json; charset=utf-8" : "text/markdown; charset=utf-8",
        "x-content-type-options": "nosniff"
      },
      status: 200
    });
  };
}

import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { importedChatTitle } from "../../contracts/chats";
import type { ChatExportDocumentChat } from "../../contracts/chatExport";
import {
  CHAT_IMPORT_REQUEST_MAX_BYTES,
  decodeChatImportItem,
  decodeChatImportRequestItems,
  type ChatImportItem,
  type ChatImportResponse,
  type ChatImportResult
} from "../../contracts/chatImport";
import { textMessageContent } from "../../domain/content";
import type { RequestAuthResolver } from "../auth/requestAuth";
import {
  readBoundedRequestBody,
  requestBodyErrorResponse,
  RequestBodyTooLargeError
} from "../http/requestBody";
import { applyMemorySourceMutations, lockMemorySourceChat } from "../memory/sourceState";
import { defaultMemorySourceMutationHooks } from "../memory/sourceHooks";
import { logEvent } from "../observability";
import { databaseFailureCode, retainDatabaseFailure } from "../observability/databaseFailure";

export type ImportedChatOutcome =
  | Readonly<{ status: "imported"; messages: number }>
  | Readonly<{ status: "already_imported" }>;

const KEY_DOMAIN = "aiqsa.chat-import.v1";
/** Rows per INSERT, far below PostgreSQL's bind-parameter ceiling. */
const MESSAGE_INSERT_CHUNK = 1_000;
/** One chat of up to 20,000 messages and 8 MiB of text is written in one transaction. */
const IMPORT_TRANSACTION = { maxWait: 10_000, timeout: 60_000 } as const;

/**
 * The identity of an AIQSA document's conversation: its creation time and
 * message tree (parent position, role, date, text) in document order. Export
 * time, title, pin/archive state, branch choice, statuses and model labels
 * are left out, so a later export of the same unchanged conversation keys
 * the same way.
 */
function aiqsaContentIdentity(chat: ChatExportDocumentChat): string {
  const positions = new Map(chat.messages.map((message, index) => [message.id, index]));
  return JSON.stringify({
    createdAt: new Date(chat.createdAt).toISOString(),
    messages: chat.messages.map((message) => [
      message.parentId === null ? -1 : positions.get(message.parentId) ?? -1,
      message.role,
      new Date(message.createdAt).toISOString(),
      message.text
    ])
  });
}

/**
 * `Chat.importSourceKey`: a SHA-256 of the source conversation id, or of the
 * canonical content of an AIQSA document, which has no stable chat id.
 */
export function chatImportSourceKey(item: ChatImportItem): string {
  const identity = item.source === "AIQSA" ? aiqsaContentIdentity(item.document.chat) : item.sourceKey ?? "";
  return createHash("sha256").update(`${KEY_DOMAIN}\n${item.source}\n${identity}`).digest("hex");
}

/** The exported active leaf, or the last message in document order when the export names none. */
function activeLeafLocalId(chat: ChatExportDocumentChat): string {
  return chat.activeLeafId ?? chat.messages[chat.messages.length - 1]!.id;
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

type ImportClient = Pick<PrismaClient, "$transaction" | "chat">;

/**
 * Creates one imported personal chat in its own transaction: Excluded from
 * Memory, the source title, dates, archive and pin state, no default model;
 * messages with new ids, mapped parents and plain text content, complete,
 * without provider, model, token counts or runs; then the active leaf. A
 * second import of the same conversation, including one racing this one
 * through the unique key, reports "already imported".
 */
export async function importChatForUser(
  db: ImportClient,
  userId: string,
  item: ChatImportItem
): Promise<ImportedChatOutcome> {
  const key = chatImportSourceKey(item);
  const existing = () => db.chat.findFirst({
    select: { id: true },
    where: { importSource: item.source, importSourceKey: key, permanentDeletionAt: null, userId }
  });
  if (await existing()) return { status: "already_imported" };
  const { chat } = item.document;
  const createdAt = new Date(chat.createdAt);
  const updatedAt = new Date(chat.updatedAt);
  try {
    return await db.$transaction(async (tx) => {
      const chatId = randomUUID();
      await tx.chat.create({
        data: {
          archived: chat.archived,
          createdAt,
          id: chatId,
          importSource: item.source,
          importSourceKey: key,
          ...(item.sourceModel ? { importSourceModel: item.sourceModel } : {}),
          memoryMode: "EXCLUDED",
          pinned: chat.pinned,
          // Never empty: every chat list and search decoder refuses an empty title.
          title: importedChatTitle(chat.title),
          updatedAt,
          userId
        },
        select: { id: true }
      });
      const ids = new Map(chat.messages.map((message) => [message.id, randomUUID()]));
      // Parents precede children, so every chunk references rows already
      // inserted or inserted by the same statement.
      for (let start = 0; start < chat.messages.length; start += MESSAGE_INSERT_CHUNK) {
        await tx.message.createMany({
          data: chat.messages.slice(start, start + MESSAGE_INSERT_CHUNK).map((message) => ({
            chatId,
            content: textMessageContent(message.text) as Prisma.InputJsonValue,
            createdAt: new Date(message.createdAt),
            id: ids.get(message.id)!,
            parentMessageId: message.parentId === null ? null : ids.get(message.parentId)!,
            role: message.role,
            status: "complete" as const,
            updatedAt: new Date(message.createdAt)
          }))
        });
      }
      const locked = await lockMemorySourceChat(tx, { chatId, lock: "UPDATE", userId });
      if (!locked) throw new Error("chat_import_chat_missing");
      // Every personal leaf change goes through the source-state owner; an
      // Excluded chat admits nothing to Memory there.
      await applyMemorySourceMutations(tx, {
        chat: locked,
        hooks: defaultMemorySourceMutationHooks,
        mutations: ["NORMAL_APPEND"],
        patch: { activeLeafMessageId: ids.get(activeLeafLocalId(chat))! }
      });
      // The leaf write stamped the import time; the source's last activity wins.
      await tx.chat.update({ data: { updatedAt }, select: { id: true }, where: { id: chatId } });
      return { messages: chat.messages.length, status: "imported" as const };
    }, IMPORT_TRANSACTION);
  } catch (error) {
    if (isUniqueViolation(error) && await existing()) return { status: "already_imported" };
    return retainDatabaseFailure(error);
  }
}

export type ImportChatsHandlerDeps = Readonly<{
  importChat(userId: string, item: ChatImportItem): Promise<ImportedChatOutcome>;
  now?: () => Date;
  resolveAuth: RequestAuthResolver;
}>;

const PRIVATE_HEADERS = {
  "cache-control": "private, no-store, max-age=0",
  vary: "Cookie"
} as const;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { headers: PRIVATE_HEADERS, status });
}

function isJsonContentType(value: string | null): boolean {
  return value?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

/**
 * `POST /api/me/chats/import`: a batch of `aiqsa.chat` documents under a
 * route-specific body limit. Each chat is validated and imported on its own;
 * an invalid or failing chat gets a reason code and never fails the batch.
 */
export function createImportChatsHandler(deps: ImportChatsHandlerDeps) {
  return async function POST(request: Request): Promise<Response> {
    const auth = await deps.resolveAuth(request);
    if (!auth) return json({ error: "unauthorized" }, 401);
    if (new URL(request.url).search || !isJsonContentType(request.headers.get("content-type"))) {
      return json({ error: "chat_import_invalid" }, 400);
    }
    let body: unknown;
    try {
      const bytes = await readBoundedRequestBody(request, { maxBytes: CHAT_IMPORT_REQUEST_MAX_BYTES });
      body = JSON.parse(new TextDecoder().decode(bytes));
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        const response = requestBodyErrorResponse(error)!;
        response.headers.set("cache-control", PRIVATE_HEADERS["cache-control"]);
        response.headers.set("vary", PRIVATE_HEADERS.vary);
        return response;
      }
      if (request.signal.aborted) throw error;
      return json({ error: "chat_import_invalid" }, 400);
    }
    const items = decodeChatImportRequestItems(body);
    if (!items) return json({ error: "chat_import_invalid" }, 400);
    const now = deps.now?.() ?? new Date();
    const results: ChatImportResult[] = [];
    for (const raw of items) {
      const decoded = decodeChatImportItem(raw, now);
      if (!decoded.ok) {
        results.push({ code: decoded.code, status: "failed" });
        continue;
      }
      try {
        results.push(await deps.importChat(auth.userId, decoded.value));
      } catch (error) {
        logEvent("service_operation", {
          code: "chat_import_failed",
          outcome: "failed",
          prisma_code: databaseFailureCode(error),
          stage: "write",
          subsystem: "database"
        });
        results.push({ code: "chat_import_failed", status: "failed" });
      }
    }
    return json({ results } satisfies ChatImportResponse);
  };
}

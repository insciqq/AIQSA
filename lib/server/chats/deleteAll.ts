import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import {
  DELETE_ALL_PERSONAL_CHATS_CONFIRMATION,
  type DeleteAllPersonalChatsResponse
} from "../../contracts/account";
import { MEMORY_CONFIRMATION_COPY_VERSION } from "../../contracts/memoryClient";
import type { RequestAuthResolver } from "../auth/requestAuth";
import {
  readJsonBodyOrNull,
  requestBodyErrorResponse
} from "../http/requestBody";
import { ActiveRunConflictError } from "../runs/runRepositoryContract";
import type { ChatLifecycleRepository } from "./lifecycleHandlers";
import {
  PermanentChatDeletionError,
  type PermanentChatDeletionCapability,
  type PermanentChatDeletionService
} from "./permanentDeletion/service";

export type PersonalChatLifecycleRow = Readonly<{
  archived: boolean;
  id: string;
  memoryMode: "EXCLUDED" | "NORMAL" | "TEMPORARY";
  sourceRevision: number;
}>;

export type DeleteAllPersonalChatsDeps = Readonly<{
  archive: ChatLifecycleRepository["setArchived"];
  capability: PermanentChatDeletionCapability;
  deletion: Pick<PermanentChatDeletionService, "confirm">;
  listPersonalChats(userId: string): Promise<readonly PersonalChatLifecycleRow[]>;
  resolveAuth: RequestAuthResolver;
}>;

const PRIVATE_CACHE_CONTROL = "private, no-store, max-age=0";

function json(body: unknown, status = 200): Response {
  const response = Response.json(body, { status });
  response.headers.set("cache-control", PRIVATE_CACHE_CONTROL);
  response.headers.set("vary", "Cookie");
  return response;
}

export function createPrismaPersonalChatLister(
  prisma: Pick<PrismaClient, "chat">
): DeleteAllPersonalChatsDeps["listPersonalChats"] {
  return async (userId) => {
    const chats = await prisma.chat.findMany({
      orderBy: { updatedAt: "asc" },
      select: {
        archived: true,
        id: true,
        memoryMode: true,
        memorySourceRevision: true
      },
      where: { permanentDeletionAt: null, projectId: null, userId }
    });
    return chats.map((chat) => ({
      archived: chat.archived,
      id: chat.id,
      memoryMode: chat.memoryMode,
      sourceRevision: chat.memorySourceRevision
    }));
  };
}

/**
 * Every personal chat goes through the existing lifecycle: permanent deletion
 * admission (which archives and schedules the purge) when that capability is
 * open, otherwise archive only. Temporary chats expire on their own and chats
 * with an active run are left untouched and counted as skipped. Project chats
 * are never selected.
 */
export async function deleteAllPersonalChats(
  deps: Pick<DeleteAllPersonalChatsDeps, "archive" | "capability" | "deletion" | "listPersonalChats">,
  userId: string
): Promise<DeleteAllPersonalChatsResponse> {
  const chats = await deps.listPersonalChats(userId);
  let archived = 0;
  let scheduled = 0;
  let skipped = 0;
  for (const chat of chats) {
    if (chat.memoryMode === "TEMPORARY") {
      skipped += 1;
      continue;
    }
    if (deps.capability.enabled) {
      try {
        await deps.deletion.confirm(userId, chat.id, {
          alsoForgetOriginMemories: false,
          confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
          requestId: randomUUID()
        });
        scheduled += 1;
        if (!chat.archived) archived += 1;
      } catch (error) {
        if (error instanceof PermanentChatDeletionError) {
          skipped += 1;
          continue;
        }
        throw error;
      }
      continue;
    }
    if (chat.archived) {
      continue;
    }
    try {
      const result = await deps.archive({
        archived: true,
        chatId: chat.id,
        expectedChatRevision: chat.sourceRevision,
        userId
      });
      if (result.kind === "ok") archived += 1;
      else skipped += 1;
    } catch (error) {
      if (error instanceof ActiveRunConflictError) {
        skipped += 1;
        continue;
      }
      throw error;
    }
  }
  return {
    archived,
    permanentDeletionAvailable: deps.capability.enabled,
    scheduled,
    skipped
  };
}

export function createDeleteAllPersonalChatsHandler(deps: DeleteAllPersonalChatsDeps) {
  return async function POST(request: Request): Promise<Response> {
    const auth = await deps.resolveAuth(request);
    if (!auth) {
      return json({ error: "unauthorized" }, 401);
    }
    const body = await readJsonBodyOrNull(request, "json");
    const bodyError = requestBodyErrorResponse(body);
    if (bodyError) return bodyError;
    if (
      !body || typeof body !== "object" || Array.isArray(body) ||
      (body as { confirmation?: unknown }).confirmation !== DELETE_ALL_PERSONAL_CHATS_CONFIRMATION
    ) {
      return json({ error: "delete_all_confirmation_required" }, 400);
    }
    return json(await deleteAllPersonalChats(deps, auth.userId));
  };
}

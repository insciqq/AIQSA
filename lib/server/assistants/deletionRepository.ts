import { Prisma, type PrismaClient } from "@prisma/client";
import type { AssistantDeletionConsequences } from "../../contracts/assistantDeletion";
import { CHAT_ASSISTANT_DELETED_MARKER } from "../../contracts/chats";
import { defaultMemorySourceMutationHooks } from "../memory/sourceHooks";
import {
  applyMemoryScopedTargetOwnerLifecycle,
  type MemorySourceMutationHooks
} from "../memory/sourceState";
import { prisma } from "../prisma";
import { isPrismaSerializationConflict } from "../runs/prismaRepositoryShared";

export type AssistantDeleteResult =
  | { kind: "deleted" }
  | { kind: "not_found" }
  | { kind: "version_conflict" };

export type PrismaAssistantDeletionRepositoryOptions = Readonly<{
  memorySourceHooks?: MemorySourceMutationHooks;
}>;

export function createPrismaAssistantDeletionRepository(
  client: PrismaClient = prisma,
  options: PrismaAssistantDeletionRepositoryOptions = {}
) {
  const memorySourceHooks = options.memorySourceHooks ?? defaultMemorySourceMutationHooks;

  return {
    /** Owner-only preview of {@link delete}. Invisible and missing definitions
     * both return null. */
    async loadConsequences(
      userId: string,
      assistantId: string
    ): Promise<AssistantDeletionConsequences | null> {
      return client.$transaction(async (tx) => {
        const definition = await tx.assistantDefinition.findFirst({
          select: {
            listingRequests: { select: { id: true }, where: { state: "pending" } },
            publications: { select: { group: { select: { name: true } }, scope: true } },
            version: true
          },
          where: { id: assistantId, ownerUserId: userId }
        });
        if (!definition) return null;

        // Chats already awaiting permanent deletion are gone for their users.
        const chatCount = await tx.chat.count({
          where: { assistantId, permanentDeletionAt: null }
        });
        return {
          audiences: {
            groupNames: definition.publications
              .flatMap((publication) =>
                publication.scope === "group" && publication.group ? [publication.group.name] : [])
              .sort((left, right) => left.localeCompare(right)),
            installation: definition.publications.some((publication) => publication.scope === "installation")
          },
          chatCount,
          pendingListingRequest: definition.listingRequests.length > 0,
          version: definition.version
        };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    },

    /**
     * Permanently deletes an owned definition in one transaction. Accepted runs,
     * chats, user defaults and Memory history keep their rows and snapshots;
     * the foreign keys only detach them from the definition.
     */
    async delete(
      userId: string,
      assistantId: string,
      expectedVersion: number
    ): Promise<AssistantDeleteResult> {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const result = await client.$transaction(async (tx) => {
            // Match Memory admission's owner -> definition -> chat order.
            // The deletion hook later locks this owner's Memory settings.
            await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
            // The exclusive row lock also blocks every new reference: inserting
            // a run, chat binding or pin takes a key-share lock on this row, so
            // the sets read below can only shrink.
            const locked = await tx.$queryRaw<Array<{ version: number }>>`
              SELECT "version"
              FROM "AssistantDefinition"
              WHERE "id" = ${assistantId} AND "ownerUserId" = ${userId}
              FOR UPDATE
            `;
            const definition = locked[0];
            if (!definition) return { kind: "not_found" as const };
            if (definition.version !== expectedVersion) {
              return { kind: "version_conflict" as const };
            }

            await tx.assistantListingRequest.deleteMany({ where: { assistantId } });
            await tx.assistantPublication.deleteMany({ where: { assistantId } });
            // Projects were removed (operator decision 2026-10-23); a binding a
            // retired Project still holds restricts the definition until the
            // Project's own deletion removes it, so it goes first.
            await tx.projectAssistantBinding.deleteMany({ where: { assistantId } });

            await applyMemoryScopedTargetOwnerLifecycle(tx, memorySourceHooks, {
              kind: "ASSISTANT_DELETE",
              sourceSnapshots: [],
              targetId: assistantId,
              userId
            });

            // One set-based write before the foreign key detaches the chats:
            // the marker replaces their overrides, so each chat can say what
            // happened until the user continues without it. Raw SQL keeps
            // Chat.updatedAt, which orders recent chats. Chats
            // awaiting permanent deletion are included: the detaching update
            // passes the same guard, which allows it while the fence is intact.
            await tx.$executeRaw`
              UPDATE "Chat"
              SET "assistantOverrides" = ${JSON.stringify(CHAT_ASSISTANT_DELETED_MARKER)}::jsonb
              WHERE "assistantId" = ${assistantId}
            `;

            await tx.assistantPin.deleteMany({ where: { assistantId } });
            await tx.assistantSkill.deleteMany({ where: { assistantId } });
            const deleted = await tx.assistantDefinition.deleteMany({
              where: { id: assistantId, ownerUserId: userId }
            });
            if (deleted.count !== 1) throw new Error("assistant_delete_invariant");
            return { kind: "deleted" as const };
          }, { maxWait: 10_000, timeout: 30_000 });
          return result;
        } catch (error) {
          if (!isPrismaSerializationConflict(error)) throw error;
        }
      }
      return { kind: "version_conflict" };
    }
  };
}

export type PrismaAssistantDeletionRepository = ReturnType<typeof createPrismaAssistantDeletionRepository>;

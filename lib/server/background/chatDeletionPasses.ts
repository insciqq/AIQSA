import { Prisma, type PrismaClient } from "@prisma/client";
import { logEvent, reportSubsystemFailure } from "../observability";
import {
  purgePermanentlyDeletedChat,
  type ChatPurgeContext,
  type ChatPurgeDependencies
} from "../chats/permanentDeletion/cleanup";
import { deleteExpiredTemporaryChat } from "../chats/temporaryDeletion";
import type { ChatAggregateScope } from "../chats/aggregateDeletion";
import { PERMANENT_CHAT_DELETION_DUTY, TEMPORARY_CHAT_DELETION_DUTY } from "./duties";
import { backgroundErrorCode } from "./errors";
import type { BackgroundPass, BackgroundPassContext } from "./passes";
import {
  backgroundWorkItemClaimableSql,
  claimBackgroundWorkItem,
  completeBackgroundWorkItem,
  failBackgroundWorkItem,
  pruneCompletedBackgroundWorkItems,
  releaseBackgroundWorkItem,
  type BackgroundWorkClaim,
  type BackgroundWorkClient
} from "./workItems";

export { PERMANENT_CHAT_DELETION_DUTY, TEMPORARY_CHAT_DELETION_DUTY };
export const CHAT_DELETION_BATCH = 16;

export type ChatDeletionDuty = typeof PERMANENT_CHAT_DELETION_DUTY | typeof TEMPORARY_CHAT_DELETION_DUTY;

export type ChatDeletionHandler = (
  dependencies: ChatPurgeDependencies,
  scope: ChatAggregateScope,
  context: ChatPurgeContext
) => Promise<"deleted" | "gone" | "not_due">;

/** The durable side of a chat deletion pass: due chats from their own rows, claims on `BackgroundWorkItem`. */
export type ChatDeletionWorkStore = Readonly<{
  claim(input: Readonly<{ duty: ChatDeletionDuty; itemId: string; now: Date; userId: string }>): Promise<BackgroundWorkClaim | null>;
  complete(tx: BackgroundWorkClient, claim: BackgroundWorkClaim, now: Date): Promise<boolean>;
  dueChats(duty: ChatDeletionDuty, now: Date, limit: number): Promise<readonly ChatAggregateScope[]>;
  fail(claim: BackgroundWorkClaim, input: Readonly<{ code: string; now: Date }>): Promise<void>;
  prune(duty: ChatDeletionDuty, now: Date): Promise<void>;
  release(claim: BackgroundWorkClaim, now: Date): Promise<void>;
  /**
   * A work row whose chat vanished without it (another path deleted the chat): a permanent deletion's completes,
   * so its owner still reads the outcome; a Temporary one's goes.
   */
  settleVanished(duty: ChatDeletionDuty, now: Date): Promise<void>;
}>;

function dueSql(duty: ChatDeletionDuty, now: Date): Prisma.Sql {
  return duty === TEMPORARY_CHAT_DELETION_DUTY
    ? Prisma.sql`chat."memoryMode" = 'TEMPORARY'::"MemoryChatMode" AND chat."temporaryRetentionDeadline" <= ${now}`
    : Prisma.sql`chat."permanentDeletionAt" IS NOT NULL`;
}

export function createPrismaChatDeletionWorkStore(client: PrismaClient): ChatDeletionWorkStore {
  return Object.freeze({
    claim: (input) => claimBackgroundWorkItem(client, input),
    complete: (tx, claim, now) => completeBackgroundWorkItem(tx, claim, now),
    async dueChats(duty, now, limit) {
      return client.$queryRaw<Array<{ chatId: string; userId: string }>>(Prisma.sql`
        SELECT chat."id" AS "chatId", chat."userId"
        FROM "Chat" AS chat
        WHERE chat."userId" IS NOT NULL
          AND ${dueSql(duty, now)}
          AND ${backgroundWorkItemClaimableSql(duty, Prisma.sql`chat."id"`, now)}
        ORDER BY chat."updatedAt" ASC, chat."id" ASC
        LIMIT ${limit}
      `);
    },
    fail: (claim, input) => failBackgroundWorkItem(client, claim, input),
    async prune(duty, now) {
      await pruneCompletedBackgroundWorkItems(client, { duty, now });
    },
    release: (claim, now) => releaseBackgroundWorkItem(client, claim, now),
    async settleVanished(duty, now) {
      const vanished = Prisma.sql`
        work."duty" = ${duty}
        AND work."completedAt" IS NULL
        AND (work."leaseToken" IS NULL OR work."leaseExpiresAt" <= ${now})
        AND NOT EXISTS (SELECT 1 FROM "Chat" AS chat WHERE chat."id" = work."itemId")
      `;
      await client.$executeRaw(duty === PERMANENT_CHAT_DELETION_DUTY
        ? Prisma.sql`
            UPDATE "BackgroundWorkItem" AS work
            SET "leaseToken" = NULL, "leaseExpiresAt" = NULL, "nextAttemptAt" = NULL, "lastErrorCode" = NULL,
              "completedAt" = ${now}, "updatedAt" = ${now}
            WHERE ${vanished}`
        : Prisma.sql`DELETE FROM "BackgroundWorkItem" AS work WHERE ${vanished}`);
    }
  });
}

type PassOptions = Readonly<{
  batch?: number;
  /** Test seam; the default is the duty's own handler. */
  handler?: ChatDeletionHandler;
  intervalMs?: number;
  /** Test seam; the default is the Prisma store over the dependencies' client. */
  store?: ChatDeletionWorkStore;
}>;

async function processItem(
  input: Readonly<{
    claim: BackgroundWorkClaim;
    context: BackgroundPassContext;
    dependencies: ChatPurgeDependencies;
    fallbackCode: string;
    handler: ChatDeletionHandler;
    store: ChatDeletionWorkStore;
  }>
): Promise<"completed" | "failed" | "released"> {
  const { claim, context, store } = input;
  const now = context.now();
  try {
    const outcome = await input.handler(input.dependencies, { chatId: claim.itemId, userId: claim.userId }, {
      complete: (tx) => store.complete(tx, claim, now),
      now,
      signal: context.signal
    });
    if (outcome === "not_due") {
      await store.release(claim, context.now());
      return "released";
    }
    return "completed";
  } catch (error) {
    if (context.signal.aborted) {
      // Shutdown: give the item back at once instead of holding it until the lease expires.
      await store.release(claim, context.now()).catch(() => undefined);
      return "released";
    }
    const code = backgroundErrorCode(error, input.fallbackCode);
    reportSubsystemFailure({ action: "retry", code, error, stage: "cleanup", subsystem: "background" });
    await store.fail(claim, { code, now: context.now() });
    return "failed";
  }
}

function createChatDeletionPass(
  dependencies: ChatPurgeDependencies,
  duty: ChatDeletionDuty,
  defaults: Readonly<{ fallbackCode: string; handler: ChatDeletionHandler; intervalMs: number }>,
  options: PassOptions
): BackgroundPass {
  const batch = options.batch ?? CHAT_DELETION_BATCH;
  const store = options.store ?? createPrismaChatDeletionWorkStore(dependencies.client);
  const handler = options.handler ?? defaults.handler;
  return Object.freeze({
    intervalMs: options.intervalMs ?? defaults.intervalMs,
    name: duty,
    async run(context: BackgroundPassContext) {
      await store.settleVanished(duty, context.now());
      const items = await store.dueChats(duty, context.now(), batch);
      let completed = 0;
      let failed = 0;
      for (const item of items) {
        if (context.signal.aborted) break;
        const claim = await store.claim({ duty, itemId: item.chatId, now: context.now(), userId: item.userId });
        if (!claim) continue;
        const outcome = await processItem({
          claim, context, dependencies, fallbackCode: defaults.fallbackCode, handler, store
        });
        if (outcome === "completed") completed += 1;
        if (outcome === "failed") failed += 1;
      }
      await store.prune(duty, context.now());
      if (completed + failed > 0) {
        logEvent("runtime_lifecycle", {
          completed_count: completed, failed_count: failed,
          outcome: failed > 0 ? "degraded" : "completed", stage: "cleanup", subsystem: "background"
        });
      }
      return { more: items.length === batch && !context.signal.aborted };
    }
  });
}

/** Temporary chats past their retention deadline (24 hours after their last answer). */
export function createTemporaryChatDeletionPass(
  dependencies: ChatPurgeDependencies,
  options: PassOptions = {}
): BackgroundPass {
  return createChatDeletionPass(dependencies, TEMPORARY_CHAT_DELETION_DUTY, {
    fallbackCode: "temporary_chat_deletion_failed", handler: deleteExpiredTemporaryChat, intervalMs: 30_000
  }, options);
}

/** Chats fenced for permanent deletion (by their owner, "delete all" or an automation's history retention). */
export function createPermanentChatDeletionPass(
  dependencies: ChatPurgeDependencies,
  options: PassOptions = {}
): BackgroundPass {
  return createChatDeletionPass(dependencies, PERMANENT_CHAT_DELETION_DUTY, {
    fallbackCode: "permanent_chat_deletion_failed", handler: purgePermanentlyDeletedChat, intervalMs: 2_000
  }, options);
}

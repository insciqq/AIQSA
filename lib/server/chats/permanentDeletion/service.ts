import type { Prisma } from "@prisma/client";
import type {
  MemoryConsumerPermanentChatDeleteInput,
  MemoryConsumerPermanentChatDeleteResponse
} from "../../../contracts/memoryClient";

export type PermanentChatDeletionCapability = Readonly<{ enabled: boolean }>;

/**
 * Permanent deletion needs only the fence and the background worker that purges fenced chats, so it is always
 * available (it no longer waits for the Memory coordinator's composition).
 */
export const permanentChatDeletionCapability: PermanentChatDeletionCapability = Object.freeze({ enabled: true });

export type PermanentChatDeletionSnapshot = Readonly<{
  activeLeafMessageId: string | null;
  activeRunCount: number;
  memoryMode: "EXCLUDED" | "NORMAL" | "TEMPORARY";
}>;

/**
 * A caller's own condition for one admission, checked inside its transaction
 * after the chat row is locked and before anything changes; false refuses the
 * admission as stale. Owner actions on the chat (pin, rename, folder, share,
 * restore) take the same row lock, so the condition and the fence are one
 * decision. Scheduled task history retention passes its eligibility here.
 */
export type PermanentChatDeletionCondition = (tx: Prisma.TransactionClient) => Promise<boolean>;

/** Where a deletion the owner asked for stands: fenced and waiting for the worker, or finished. */
export type PermanentChatDeletionProgress = "complete" | "in_progress";

export type PermanentChatDeletionRepository = Readonly<{
  admit(input: Readonly<{
    chatId: string;
    condition?: PermanentChatDeletionCondition;
    expectedActiveLeafMessageId: string | null;
    now: Date;
    userId: string;
  }>): Promise<
    | Readonly<{ kind: "active_run" | "not_found" | "stale" | "temporary" }>
    | Readonly<{ deletionId: string; kind: "ok" }>
  >;
  readSnapshot(input: Readonly<{
    chatId: string;
    userId: string;
  }>): Promise<PermanentChatDeletionSnapshot | null>;
  progress(input: Readonly<{
    chatId: string;
    userId: string;
  }>): Promise<PermanentChatDeletionProgress | null>;
}>;

export type PermanentChatDeletionErrorCode =
  | "active_run_in_progress"
  | "chat_not_found"
  | "chat_permanent_delete_failed"
  | "chat_permanent_delete_stale"
  | "chat_permanent_delete_temporary_forbidden"
  | "chat_permanent_delete_unavailable";

export class PermanentChatDeletionError extends Error {
  constructor(readonly code: PermanentChatDeletionErrorCode) {
    super(code);
    this.name = "PermanentChatDeletionError";
  }
}

function fail(code: PermanentChatDeletionErrorCode): never {
  throw new PermanentChatDeletionError(code);
}

function assertCapability(capability: PermanentChatDeletionCapability): void {
  if (!capability.enabled) fail("chat_permanent_delete_unavailable");
}

/**
 * Permanent chat deletion: admission fences the chat (archived, out of every list, search and new write, shares
 * revoked) and acknowledges; the background worker then purges it with its Workspace and files
 * (`lib/server/background/chatDeletionPasses.ts`). The fence is the durable obligation.
 */
export function createPermanentChatDeletionService(input: Readonly<{
  capability: PermanentChatDeletionCapability;
  now?: () => Date;
  repository: PermanentChatDeletionRepository;
  /**
   * Stops every background sub-agent of the chat once its fence holds (no new
   * one can start), before cleanup deletes its rows; cleanup retries until no
   * run of the chat is active.
   */
  stopSubagents?: (scope: Readonly<{ chatId: string; userId: string }>) => Promise<unknown>;
}>) {
  const now = input.now ?? (() => new Date());
  return Object.freeze({
    async confirm(
      userId: string,
      chatId: string,
      // The request id and copy version are validated by the route; "also forget origin memories" has nothing
      // left to forget once Memory facts are replaced by the note, and is accepted for compatibility.
      _request: MemoryConsumerPermanentChatDeleteInput,
      options: Readonly<{ condition?: PermanentChatDeletionCondition }> = {}
    ): Promise<MemoryConsumerPermanentChatDeleteResponse> {
      assertCapability(input.capability);
      const snapshot = await input.repository.readSnapshot({ chatId, userId });
      if (!snapshot) fail("chat_not_found");
      if (snapshot.memoryMode === "TEMPORARY") fail("chat_permanent_delete_temporary_forbidden");
      if (snapshot.activeRunCount > 0) fail("active_run_in_progress");
      let result: Awaited<ReturnType<PermanentChatDeletionRepository["admit"]>>;
      try {
        result = await input.repository.admit({
          chatId,
          ...(options.condition ? { condition: options.condition } : {}),
          expectedActiveLeafMessageId: snapshot.activeLeafMessageId,
          now: now(),
          userId
        });
      } catch {
        return fail("chat_permanent_delete_failed");
      }
      switch (result.kind) {
        case "not_found": return fail("chat_not_found");
        case "stale": return fail("chat_permanent_delete_stale");
        case "temporary": return fail("chat_permanent_delete_temporary_forbidden");
        case "active_run": return fail("active_run_in_progress");
        case "ok": break;
      }
      await input.stopSubagents?.({ chatId, userId }).catch(() => undefined);
      return { status: "IN_PROGRESS" };
    },

    async consumerStatus(
      userId: string,
      chatId: string
    ): Promise<MemoryConsumerPermanentChatDeleteResponse> {
      const progress = await input.repository.progress({ chatId, userId });
      if (!progress) fail("chat_not_found");
      return { status: progress === "complete" ? "COMPLETE" : "IN_PROGRESS" };
    }
  });
}

export type PermanentChatDeletionService = ReturnType<
  typeof createPermanentChatDeletionService
>;

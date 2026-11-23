import type { ChatSearchChatSnapshot, ChatSearchPassageDraft } from "./passages";

/**
 * The indexer's storage port. The Prisma implementation is `./prismaStore.ts`; the pass (`./pass.ts`) depends only on
 * this, so its behaviour is tested with an in-memory store.
 *
 * Concurrency rests on `ChatSearchState.dirtyAt` as the chat's version: every mark moves it forward (a new turn to
 * the current time, a background mark keeps an earlier time but still moves it), a claim remembers it, and every
 * write of the claimed pass is conditional on it being unchanged. So a mark that lands while a pass works on the chat
 * is never lost: that pass writes nothing more and the chat is claimed again.
 */

/** A claimed dirty chat: the version the pass works on and the failures before it. */
export type ChatSearchClaim = Readonly<{
  chatId: string;
  userId: string;
  dirtyAt: Date;
  attemptCount: number;
}>;

export type ChatSearchReconcileTarget =
  | Readonly<{ kind: "passages"; passages: readonly ChatSearchPassageDraft[]; leafMessageId: string | null }>
  /** The chat may not be indexed: its passages and its state go. */
  | Readonly<{ kind: "clear" }>;

export type ChatSearchReconcileOutcome =
  | Readonly<{ kind: "applied"; inserted: number; updated: number; deleted: number; unchanged: number }>
  | Readonly<{ kind: "cleared" }>
  /** A newer mark arrived since the claim: nothing was written, and the chat is claimed again. */
  | Readonly<{ kind: "stale" }>
  /** The chat was deleted or fenced for permanent deletion: it has no state or passages left. */
  | Readonly<{ kind: "gone" }>;

/**
 * `allowed`; `owner_off` when the owner does not allow vectors now; `chat_left` when the chat was deleted, fenced for
 * deletion or otherwise left search (Excluded, Temporary) since it was claimed.
 */
export type ChatSearchEmbeddingPermission = "allowed" | "owner_off" | "chat_left";

export type ChatSearchPassageToEmbed =Readonly<{ id: string; text: string; contentHash: string }>;

export type ChatSearchEmbeddingWrite = Readonly<{ id: string; contentHash: string; vector: readonly number[] }>;

export type ChatSearchSettlement =
  /** Done until the next mark; `note` says why words only, when they are (`embedding_unset`, an unavailable role). */
  | Readonly<{ kind: "clean"; note: string | null }>
  /** More vectors to write: dirty and due again at once. */
  | Readonly<{ kind: "more" }>
  /** Embedding failed: dirty, retried at `retryAt`, with the content-free code. Words stay searchable. */
  | Readonly<{ kind: "failed"; code: string; retryAt: Date }>;

export type ChatSearchIndexStore = Readonly<{
  /** Claims due dirty chats, newest mark first, without waiting on chats another worker holds, under a lease. */
  claimDue(input: Readonly<{ now: Date; leaseUntil: Date; limit: number; ownerIds?: readonly string[] }>):
    Promise<readonly ChatSearchClaim[]>;
  /**
   * The chat as one consistent snapshot, its path without the messages search never holds
   * (`ChatSearchExcludedMessage`); null when it no longer exists.
   */
  loadSnapshot(chatId: string): Promise<ChatSearchChatSnapshot | null>;
  loadSavedSecretValues(userId: string): Promise<readonly string[]>;
  /**
   * Whether the chat's passages may go to the embedding model now, as committed, in one query: the chat may still be
   * indexed (`chatSearchEligible`: it exists, is the owner's ordinary chat and is not fenced for deletion), then the
   * owner allows vectors (`./ownerEmbedding.ts`).
   */
  embeddingPermission(claim: Pick<ChatSearchClaim, "chatId" | "userId">): Promise<ChatSearchEmbeddingPermission>;
  /** Writes the target if the claim's version still holds (`planChatSearchPassages`). */
  reconcile(claim: ChatSearchClaim, target: ChatSearchReconcileTarget): Promise<ChatSearchReconcileOutcome>;
  /** The chat's passages without a vector of this model, newest turn first. */
  passagesToEmbed(input: Readonly<{ chatId: string; providerModelId: string; limit: number }>):
    Promise<readonly ChatSearchPassageToEmbed[]>;
  /** Writes vectors to passages whose text still has the embedded hash; returns how many it wrote. */
  writeEmbeddings(input: Readonly<{
    chatId: string;
    providerModelId: string;
    dimension: number;
    vectors: readonly ChatSearchEmbeddingWrite[];
  }>): Promise<number>;
  /** Settles the claim if its version still holds; false when a newer mark took over. */
  settle(claim: ChatSearchClaim, settlement: ChatSearchSettlement): Promise<boolean>;
}>;

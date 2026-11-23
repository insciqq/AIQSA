import type { PrismaClient } from "@prisma/client";
import { logEvent } from "../../observability";
import { ChatSearchEmbeddingError, type ChatSearchEmbedder, type ChatSearchEmbeddingModel } from "../embedder";
import { chatSearchEligible } from "../eligibility";
import { CHAT_SEARCH_OWNER_OFF_NOTE } from "./ownerEmbedding";
import { buildChatSearchPassages } from "./passages";
import { createPrismaChatSearchIndexStore } from "./prismaStore";
import type { ChatSearchClaim, ChatSearchIndexStore, ChatSearchPassageToEmbed, ChatSearchSettlement } from "./store";

/**
 * The background index pass: claims due dirty chats, rewrites each one's passages from its current active branch
 * (words are searchable as soon as that commits), then embeds the passages that lack a vector of the current role, in
 * batches, newest turns first. A provider failure backs the chat off with a content-free code and never touches its
 * words. Nothing here waits on the user's answer: chats are marked dirty after it settles (`./dirty.ts`). Vectors are
 * written only for an owner who allows them right before each call (`./ownerEmbedding.ts`); any other owner's chat
 * settles with its words alone, and a chat that left search meanwhile sends nothing more and is cleared.
 *
 * Freshness: the worker runs a pass every `CHAT_SEARCH_INDEX_PASS_INTERVAL_MS` while idle and the next one at once
 * while a pass reports `more`. A new turn's mark carries the current time and claims go newest mark first, so it is
 * claimed by the next pass even during a backfill or a re-embedding: its words are searchable within about one
 * interval of the answer settling and its vectors one embedding call later.
 */

/** How long an idle worker waits between passes. */
export const CHAT_SEARCH_INDEX_PASS_INTERVAL_MS = 2_000;

export type ChatSearchIndexLimitValues = Readonly<{
  chatsPerPass: number;
  passagesPerChat: number;
  batchTexts: number;
  batchChars: number;
  leaseMs: number;
  retryFirstDelayMs: number;
  retryMaxDelayMs: number;
}>;

export const CHAT_SEARCH_INDEX_LIMITS: ChatSearchIndexLimitValues = Object.freeze({
  chatsPerPass: 8,
  /** Vectors one chat gets per pass; a larger chat stays due and continues in the next pass. */
  passagesPerChat: 128,
  /** One embedding request: texts and characters (well under the adapter's request bounds). */
  batchTexts: 32,
  batchChars: 120_000,
  /** A claim's lease: a worker that dies leaves the chat to be claimed again after it. */
  leaseMs: 5 * 60_000,
  /** Backoff after a failure: doubling from the first delay up to the cap, never sooner than the provider asked. */
  retryFirstDelayMs: 30_000,
  retryMaxDelayMs: 60 * 60_000
});

export type ChatSearchIndexLimits = Partial<ChatSearchIndexLimitValues> & Readonly<{
  /** Restricts the claim to these owners (targeted repair, tests). */
  ownerIds?: readonly string[];
}>;

/** A content-free account of one pass. */
export type ChatSearchIndexPassSummary = Readonly<{
  claimed: number;
  /** Chats whose passages now match their active branch. */
  indexed: number;
  /** Chats that may not be indexed and lost their passages. */
  cleared: number;
  /** Chats a newer mark took over; they are claimed again. */
  stale: number;
  /** Chats deleted or fenced for permanent deletion meanwhile. */
  gone: number;
  failed: number;
  /** Vectors written. */
  embedded: number;
  model: ChatSearchEmbeddingModel["kind"] | "not_checked";
  /** More work is due now: run the next pass without waiting. */
  more: boolean;
}>;

export type ChatSearchIndexPassInput = Readonly<{
  embedder: ChatSearchEmbedder;
  now?: () => Date;
  limits?: ChatSearchIndexLimits;
  signal?: AbortSignal;
}>;

const CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;
const INDEX_FAILED = "chat_search_index_failed";

export function chatSearchRetryDelayMs(
  attempt: number,
  retryAfterMs: number | null,
  limits: Pick<ChatSearchIndexLimitValues, "retryFirstDelayMs" | "retryMaxDelayMs"> = CHAT_SEARCH_INDEX_LIMITS
): number {
  const exponent = Math.max(0, Math.min(attempt - 1, 20));
  const backoff = Math.min(limits.retryFirstDelayMs * 2 ** exponent, limits.retryMaxDelayMs);
  const asked = retryAfterMs !== null && Number.isFinite(retryAfterMs) && retryAfterMs > 0
    ? Math.min(retryAfterMs, limits.retryMaxDelayMs) : 0;
  return Math.max(backoff, asked);
}

function batches(
  rows: readonly ChatSearchPassageToEmbed[],
  limits: Pick<ChatSearchIndexLimitValues, "batchChars" | "batchTexts">
): ChatSearchPassageToEmbed[][] {
  const output: ChatSearchPassageToEmbed[][] = [];
  let current: ChatSearchPassageToEmbed[] = [];
  let characters = 0;
  for (const row of rows) {
    if (current.length > 0 && (current.length >= limits.batchTexts || characters + row.text.length > limits.batchChars)) {
      output.push(current);
      current = [];
      characters = 0;
    }
    current.push(row);
    characters += row.text.length;
  }
  if (current.length > 0) output.push(current);
  return output;
}

function logFailure(stage: "reconcile" | "embed" | "settle", code: string, error?: unknown): void {
  logEvent("service_operation", {
    action: "retry", code, ...(error === undefined ? {} : { error }), outcome: "failed", stage, subsystem: "memory_search"
  });
}

/** One pass over the Prisma store (`createPrismaChatSearchIndexStore`). */
export function runChatSearchIndexPass(
  input: ChatSearchIndexPassInput & Readonly<{ db: PrismaClient }>
): Promise<ChatSearchIndexPassSummary> {
  return runChatSearchIndexPassOn(createPrismaChatSearchIndexStore(input.db), input);
}

export async function runChatSearchIndexPassOn(
  store: ChatSearchIndexStore,
  input: ChatSearchIndexPassInput
): Promise<ChatSearchIndexPassSummary> {
  const limits = { ...CHAT_SEARCH_INDEX_LIMITS, ...input.limits };
  const now = input.now ?? (() => new Date());
  const startedAt = now();
  const claims = await store.claimDue({
    leaseUntil: new Date(startedAt.getTime() + limits.leaseMs),
    limit: limits.chatsPerPass,
    now: startedAt,
    ...(limits.ownerIds ? { ownerIds: limits.ownerIds } : {})
  });
  const counts = { cleared: 0, embedded: 0, failed: 0, gone: 0, indexed: 0, stale: 0 };
  if (claims.length === 0) return { ...counts, claimed: 0, model: "not_checked", more: false };

  let more = claims.length >= limits.chatsPerPass;
  const settle = async (claim: ChatSearchClaim, settlement: ChatSearchSettlement): Promise<void> => {
    if (settlement.kind === "more") more = true;
    try {
      if (!await store.settle(claim, settlement)) {
        counts.stale += 1;
        more = true;
      }
    } catch (error) {
      // The lease runs out and the chat is claimed again.
      logFailure("settle", INDEX_FAILED, error);
    }
  };
  const failed = (claim: ChatSearchClaim, code: string, retryAfterMs: number | null = null): ChatSearchSettlement => ({
    code: CODE_PATTERN.test(code) ? code : INDEX_FAILED,
    kind: "failed",
    retryAt: new Date(now().getTime() + chatSearchRetryDelayMs(claim.attemptCount + 1, retryAfterMs, limits))
  });

  let model: ChatSearchEmbeddingModel;
  try {
    model = await input.embedder.currentModel();
  } catch (error) {
    logFailure("embed", "embedding_unavailable", error);
    model = { code: "embedding_unavailable", kind: "unavailable", providerModelId: "" };
  }

  // Words first: every claimed chat's passages are rewritten before any embedding call.
  const indexed: ChatSearchClaim[] = [];
  const savedValues = new Map<string, Promise<readonly string[]>>();
  const ownerSavedValues = (userId: string) => {
    if (!savedValues.has(userId)) savedValues.set(userId, store.loadSavedSecretValues(userId));
    return savedValues.get(userId)!;
  };
  for (const [position, claim] of claims.entries()) {
    if (input.signal?.aborted) {
      for (const rest of claims.slice(position)) await settle(rest, { kind: "more" });
      return { ...counts, claimed: claims.length, model: model.kind, more: true };
    }
    try {
      const snapshot = await store.loadSnapshot(claim.chatId);
      if (!snapshot) {
        counts.gone += 1;
        continue;
      }
      const outcome = chatSearchEligible(snapshot.eligibility, claim.userId)
        ? await store.reconcile(claim, {
          kind: "passages",
          leafMessageId: snapshot.activeLeafMessageId,
          passages: buildChatSearchPassages(snapshot, await ownerSavedValues(claim.userId))
        })
        : await store.reconcile(claim, { kind: "clear" });
      if (outcome.kind === "applied") {
        counts.indexed += 1;
        indexed.push(claim);
      } else if (outcome.kind === "cleared") {
        counts.cleared += 1;
      } else if (outcome.kind === "stale") {
        counts.stale += 1;
        more = true;
      } else {
        counts.gone += 1;
      }
    } catch (error) {
      counts.failed += 1;
      logFailure("reconcile", INDEX_FAILED, error);
      await settle(claim, failed(claim, INDEX_FAILED));
    }
  }

  // Then vectors. After one provider failure the rest of this pass backs off too instead of calling it again.
  let providerFailure: ChatSearchEmbeddingError | null = null;
  for (const claim of indexed) {
    if (model.kind === "unset") {
      await settle(claim, { kind: "clean", note: "embedding_unset" });
      continue;
    }
    if (model.kind === "unavailable") {
      await settle(claim, { kind: "clean", note: CODE_PATTERN.test(model.code) ? model.code : "embedding_unavailable" });
      continue;
    }
    if (providerFailure) {
      counts.failed += 1;
      await settle(claim, failed(claim, providerFailure.code, providerFailure.retryAfterMs));
      continue;
    }
    if (input.signal?.aborted) {
      await settle(claim, { kind: "more" });
      continue;
    }
    try {
      const rows = await store.passagesToEmbed({
        chatId: claim.chatId, limit: limits.passagesPerChat + 1, providerModelId: model.providerModelId
      });
      let stop: "owner_off" | "chat_left" | null = null;
      for (const batch of batches(rows.slice(0, limits.passagesPerChat), limits)) {
        // Asked right before every request, since one chat's requests can take a while. The chat left search (deleted,
        // fenced for deletion, excluded): the prefetched texts are no longer the index's to send, and the chat is
        // cleared as one that left before its words were rewritten. An inactive account, or Memory or past-chat search
        // off: nothing more goes to the provider; the vectors already written stay, and no retry follows, since the
        // backfill marks the chat again once vectors are allowed (`./backfill.ts`).
        const permission = await store.embeddingPermission(claim);
        if (permission !== "allowed") {
          stop = permission;
          break;
        }
        const result = await input.embedder.embed({
          latencyClass: "background",
          mode: "document",
          providerModelId: model.providerModelId,
          ...(input.signal ? { signal: input.signal } : {}),
          texts: batch.map((row) => row.text),
          userId: claim.userId
        });
        // One vector of the stated dimension per text, or the batch writes nothing (the vector check would refuse it).
        if (result.vectors.length !== batch.length || result.vectors.some((vector) => vector.length !== result.dimension)) {
          throw new ChatSearchEmbeddingError("embedding_response_dimension_mismatch");
        }
        counts.embedded += await store.writeEmbeddings({
          chatId: claim.chatId,
          dimension: result.dimension,
          providerModelId: model.providerModelId,
          vectors: batch.map((row, index) => ({ contentHash: row.contentHash, id: row.id, vector: result.vectors[index]! }))
        });
      }
      if (stop === "chat_left") {
        const outcome = await store.reconcile(claim, { kind: "clear" });
        if (outcome.kind === "cleared") counts.cleared += 1;
        else if (outcome.kind === "gone") counts.gone += 1;
        else if (outcome.kind === "stale") {
          counts.stale += 1;
          more = true;
        }
        continue;
      }
      await settle(claim, stop === "owner_off" ? { kind: "clean", note: CHAT_SEARCH_OWNER_OFF_NOTE }
        : rows.length > limits.passagesPerChat ? { kind: "more" } : { kind: "clean", note: null });
    } catch (error) {
      if (error instanceof ChatSearchEmbeddingError &&
        (error.code === "embedding_model_changed" || error.code === "embedding_request_cancelled")) {
        // The role changed under the pass, or the worker stops: the next pass reads the role again.
        await settle(claim, { kind: "more" });
        continue;
      }
      counts.failed += 1;
      if (error instanceof ChatSearchEmbeddingError) {
        providerFailure = error;
        logFailure("embed", CODE_PATTERN.test(error.code) ? error.code : INDEX_FAILED);
        await settle(claim, failed(claim, error.code, error.retryAfterMs));
      } else {
        logFailure("embed", INDEX_FAILED, error);
        await settle(claim, failed(claim, INDEX_FAILED));
      }
    }
  }
  return { ...counts, claimed: claims.length, model: model.kind, more };
}

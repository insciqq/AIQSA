import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { logEvent } from "../observability";
import { prisma } from "../prisma";
import { MemoryCoordinatorError } from "./coordinator/errors";
import type { MemoryDeletionHandler } from "./coordinator/types";
import { invalidateMemoryHistoryHoldingSavedSecret } from "./history/sourceLifecycle";
import { forgetMemoryFactsHoldingSavedSecret } from "./lifecycle/repository";
import { memoryValueContainsSavedSecret } from "./persistence/savedSecretMatching";
import { memorySavedSecretValues } from "./persistence/savedSecrets";
import { lockMemorySettings } from "./persistence/transaction";
import { MEMORY_SAVED_SECRET_SCRUB_TARGET_TYPE } from "./savedSecretScrubRequest";
import { loadMemorySuppressionKeyring } from "./suppressionKeyring";

/**
 * Removes the owner's saved secret values from what Memory already holds
 * (operator report 2026-10-23). Saving a value records this obligation
 * (`./savedSecretScrubRequest.ts`); it compares Memory with every value saved
 * when it runs, so values saved before it existed are covered too, by the
 * rule of `./persistence/savedSecretMatching.ts`:
 *
 * - a fact any version or evidence of which holds a value is forgotten like
 *   the user's Forget and purged at once;
 * - a chat whose visible history holds a value has its history invalidated,
 *   purged and rebuilt with saved values redacted; one whose only copies are
 *   already invalidated is purged.
 *
 * Staged extraction output is left alone: its candidates are refused at apply
 * (`./learning/extraction/repository.ts`), and the stage is cleared then or
 * when its recovery window ends. The scan reads the owner's Memory text in
 * pages outside the commit, which proves each hit again under the owner's
 * lock. A pass changes at most a bounded number of facts and chats and leaves
 * a fresh obligation for the rest.
 */
/** Facts, and chats, one commit changes: each is a Forget fence or a history
 * reset, and the commit must stay well inside the deletion commit timeout. */
export const MEMORY_SAVED_SECRET_SCRUB_PASS_LIMIT = 25;
const SCAN_PAGE = 500;
const FORGETTABLE_FACT_STATES = ["ACTIVE", "CONFLICTED", "ORPHANED"] as const;

type MemoryReader = Prisma.TransactionClient;

type FactHolder = Readonly<{ expectedVersionId: string | null; factId: string }>;

export type MemorySavedSecretHolders = Readonly<{
  facts: readonly FactHolder[];
  /** Chats whose only copies are invalidated items awaiting their purge. */
  hiddenChatIds: readonly string[];
  /** Chats with an active or suppressed history item holding a value. */
  visibleChatIds: readonly string[];
}>;

type ScanPage = Readonly<{ after: Readonly<{ id?: Readonly<{ gt: string }> }>; take: number }>;

/** Reads every row of a keyset scan by id, page by page. */
async function scan<T extends Readonly<{ id: string }>>(
  read: (page: ScanPage) => Promise<T[]>,
  visit: (row: T) => void
): Promise<void> {
  let after: string | null = null;
  for (;;) {
    const rows = await read({ after: after === null ? {} : { id: { gt: after } }, take: SCAN_PAGE });
    for (const row of rows) visit(row);
    if (rows.length < SCAN_PAGE) return;
    after = rows.at(-1)!.id;
  }
}

async function factHolders(
  db: MemoryReader,
  userId: string,
  values: readonly string[],
  onlyFactIds: readonly string[] | undefined
): Promise<readonly FactHolder[]> {
  const holds = (value: unknown) => memoryValueContainsSavedSecret(value, values);
  const factFilter = onlyFactIds ? { factId: { in: [...onlyFactIds] } } : {};
  const versionFacts = new Map<string, string>();
  const matched = new Set<string>();
  await scan((page) => db.memoryFactVersion.findMany({
    orderBy: { id: "asc" },
    select: { displayText: true, factId: true, id: true, rawTemporalExpression: true, structuredValue: true },
    take: page.take,
    where: { contentPurgedAt: null, userId, ...factFilter, ...page.after }
  }), (version) => {
    versionFacts.set(version.id, version.factId);
    if (holds([version.displayText, version.rawTemporalExpression, version.structuredValue])) {
      matched.add(version.factId);
    }
  });
  await scan((page) => db.memoryEvidence.findMany({
    orderBy: { id: "asc" },
    select: { factVersionId: true, id: true, safeExcerpt: true },
    take: page.take,
    where: {
      userId,
      ...(onlyFactIds ? { factVersionId: { in: [...versionFacts.keys()] } } : {}),
      ...page.after
    }
  }), (evidence) => {
    const factId = versionFacts.get(evidence.factVersionId);
    if (factId && holds(evidence.safeExcerpt)) matched.add(factId);
  });
  if (matched.size === 0) return [];
  const facts = await db.memoryFact.findMany({
    orderBy: { id: "asc" },
    select: { currentVersionId: true, id: true, state: true },
    take: MEMORY_SAVED_SECRET_SCRUB_PASS_LIMIT,
    where: { id: { in: [...matched] }, state: { in: [...FORGETTABLE_FACT_STATES] }, userId }
  });
  const conflicted = facts.filter(({ state }) => state === "CONFLICTED").map(({ id }) => id);
  const conflicting = conflicted.length === 0 ? [] : await db.memoryFactVersion.findMany({
    orderBy: { id: "asc" },
    select: { factId: true, id: true },
    where: { factId: { in: conflicted }, state: "CONFLICTING", userId }
  });
  return facts.map((fact) => ({
    expectedVersionId: fact.currentVersionId ??
      conflicting.find(({ factId }) => factId === fact.id)?.id ?? null,
    factId: fact.id
  }));
}

async function chatHolders(
  db: MemoryReader,
  userId: string,
  values: readonly string[],
  onlyChatIds: readonly string[] | undefined
): Promise<Readonly<{ hidden: readonly string[]; visible: readonly string[] }>> {
  const visible = new Set<string>();
  const hidden = new Set<string>();
  const holds = (value: unknown) => memoryValueContainsSavedSecret(value, values);
  const visit = (row: Readonly<{ chatId: string; state: string }>, text: unknown) => {
    if (!holds(text)) return;
    if (row.state === "INVALIDATED") hidden.add(row.chatId);
    else visible.add(row.chatId);
  };
  const where = (page: ScanPage) => ({
    userId, ...(onlyChatIds ? { chatId: { in: [...onlyChatIds] } } : {}), ...page.after
  });
  await scan((page) => db.memoryRecallChunk.findMany({
    orderBy: { id: "asc" },
    select: { chatId: true, id: true, safeProjectedText: true, state: true },
    take: page.take,
    where: where(page)
  }), (chunk) => visit(chunk, chunk.safeProjectedText));
  await scan((page) => db.memoryRecallRound.findMany({
    orderBy: { id: "asc" },
    select: { chatId: true, contextualNarrativeText: true, id: true, rawSafeText: true, state: true },
    take: page.take,
    where: where(page)
  }), (round) => visit(round, [round.rawSafeText, round.contextualNarrativeText]));
  await scan((page) => db.memoryToolEvent.findMany({
    orderBy: { id: "asc" },
    select: { chatId: true, id: true, safeProjectedText: true, state: true, structuredIdentifiers: true },
    take: page.take,
    where: where(page)
  }), (event) => visit(event, [event.safeProjectedText, event.structuredIdentifiers]));
  const visibleIds = [...visible].sort();
  return {
    hidden: [...hidden].filter((chatId) => !visible.has(chatId)).sort()
      .slice(0, Math.max(0, MEMORY_SAVED_SECRET_SCRUB_PASS_LIMIT - visibleIds.length)),
    visible: visibleIds.slice(0, MEMORY_SAVED_SECRET_SCRUB_PASS_LIMIT)
  };
}

/** Facts and chats holding one of `values`, optionally only among known ids. */
export async function findMemorySavedSecretHolders(
  db: MemoryReader,
  userId: string,
  values: readonly string[],
  only?: Readonly<{ chatIds: readonly string[]; factIds: readonly string[] }>
): Promise<MemorySavedSecretHolders & Readonly<{ more: boolean }>> {
  if (values.length === 0) return { facts: [], hiddenChatIds: [], more: false, visibleChatIds: [] };
  const facts = only?.factIds.length === 0 ? [] : await factHolders(db, userId, values, only?.factIds);
  const chats = only?.chatIds.length === 0
    ? { hidden: [], visible: [] }
    : await chatHolders(db, userId, values, only?.chatIds);
  return {
    facts,
    hiddenChatIds: chats.hidden,
    more: facts.length >= MEMORY_SAVED_SECRET_SCRUB_PASS_LIMIT ||
      chats.visible.length >= MEMORY_SAVED_SECRET_SCRUB_PASS_LIMIT,
    visibleChatIds: chats.visible
  };
}

function nothingHeld(holders: MemorySavedSecretHolders): boolean {
  return holders.facts.length === 0 && holders.visibleChatIds.length === 0 &&
    holders.hiddenChatIds.length === 0;
}

export function createMemorySavedSecretScrubDeletionHandler(
  client: PrismaClient = prisma,
  dependencies: Readonly<{
    key?: () => Buffer;
    keyring?: typeof loadMemorySuppressionKeyring;
  }> = {}
): MemoryDeletionHandler {
  const loadKeyring = dependencies.keyring ?? loadMemorySuppressionKeyring;
  const savedValues = (db: MemoryReader, userId: string) =>
    memorySavedSecretValues(db, userId, dependencies.key);
  return Object.freeze({
    async execute(claim, context) {
      if (claim.operation !== "SOURCE_PURGE" ||
        claim.targetType !== MEMORY_SAVED_SECRET_SCRUB_TARGET_TYPE) {
        throw new MemoryCoordinatorError("memory_deletion_target_invalid", false);
      }
      const found = await findMemorySavedSecretHolders(
        client, claim.userId, await savedValues(client, claim.userId)
      );
      if (nothingHeld(found)) return {};
      const configured = found.facts.length > 0 ? loadKeyring() : null;
      if (configured && configured.status !== "ready") {
        throw new MemoryCoordinatorError(configured.code, true);
      }
      return {
        apply: async (tx) => {
          const settings = await lockMemorySettings(tx, claim.userId, false);
          const now = context.now();
          // Values and hits are proven again under the owner's lock.
          const held = await findMemorySavedSecretHolders(tx, claim.userId, await savedValues(tx, claim.userId), {
            chatIds: [...found.visibleChatIds, ...found.hiddenChatIds],
            factIds: found.facts.map(({ factId }) => factId)
          });
          if (nothingHeld(held)) return;
          const facts = configured?.status === "ready" && held.facts.length > 0
            ? await forgetMemoryFactsHoldingSavedSecret(tx, settings, configured.keyring, {
                facts: held.facts,
                now
              })
            : 0;
          const chats = await invalidateMemoryHistoryHoldingSavedSecret(tx, settings, {
            hidden: held.hiddenChatIds,
            visible: held.visibleChatIds
          }, now);
          // Hidden chats never ask for more: they stay found until their purge runs.
          if (found.more) {
            await tx.memoryDeletionOutbox.create({
              data: {
                memoryGeneration: settings.memoryGeneration,
                operation: "SOURCE_PURGE",
                targetId: randomUUID(),
                targetType: MEMORY_SAVED_SECRET_SCRUB_TARGET_TYPE,
                userId: claim.userId
              }
            });
          }
          logEvent("service_operation", {
            action: "complete", code: "memory_saved_secret_scrub", count: facts + chats,
            outcome: "completed", stage: "cleanup", subsystem: "memory"
          });
        }
      };
    },
    operation: "SOURCE_PURGE"
  });
}

export const memorySavedSecretScrubDeletionHandler = createMemorySavedSecretScrubDeletionHandler();

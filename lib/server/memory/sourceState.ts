import { Prisma, type MemoryChatMode, type MemoryJobKind } from "@prisma/client";
import {
  memoryCounterEffectFor,
  type MemoryCounterAdvance,
  type MemoryCounterMutation
} from "../../domain/memory/counters";
import { enqueueMemoryJob } from "./persistence/jobs";
import { memorySha256 } from "./persistence/lexical";
import {
  lockMemorySettings,
  type MemoryTransaction
} from "./persistence/transaction";

export const MEMORY_SOURCE_PROJECTION_VERSION = "memory-source-v1";
export const MEMORY_SOURCE_RECONCILIATION_PIPELINE_VERSION =
  "memory-source-reconciliation-v1";

const MAX_COUNTER = 2_147_483_647;

export const MEMORY_SOURCE_MUTATIONS = [
  "NORMAL_APPEND",
  "TERMINAL_SETTLEMENT",
  "BRANCH_PATH_CHANGE",
  "SOURCE_HARD_DELETE",
  "SOURCE_EXCLUDE",
  "SOURCE_RESUME",
  "CHAT_ARCHIVE_OR_RESTORE",
  "FOLDER_MOVE",
  "ASSISTANT_ACCESS_CHANGE",
  "SCOPE_TARGET_DELETE"
] as const satisfies readonly MemoryCounterMutation[];

export type MemorySourceMutation = (typeof MEMORY_SOURCE_MUTATIONS)[number];
const memorySourceMutationSet = new Set<MemoryCounterMutation>(MEMORY_SOURCE_MUTATIONS);

export type LockedMemorySourceChat = Readonly<{
  activeLeafMessageId: string | null;
  archived: boolean;
  folderId: string | null;
  id: string;
  memoryBranchGeneration: number;
  memoryMode: MemoryChatMode;
  memorySourceRevision: number;
  temporaryRetentionDeadline: Date | null;
  temporaryRetentionPolicyVersion: string | null;
  userId: string;
}>;

export type MemorySourceMessageIdentity = Readonly<{
  createdAt: Date;
  id: string;
  updatedAt: Date;
}>;

export type MemorySourceSnapshot = LockedMemorySourceChat & Readonly<{
  messages: readonly MemorySourceMessageIdentity[];
  sourceHash: string;
}>;

function temporaryMemorySourceSnapshot(
  chat: LockedMemorySourceChat
): MemorySourceSnapshot {
  return {
    ...chat,
    messages: [],
    sourceHash: memorySha256({ chatId: chat.id, mode: "TEMPORARY" })
  };
}

export type MemoryTerminalSettlement = Readonly<{
  assistantMessageId: string | null;
  runId: string;
  status: "cancelled" | "complete" | "error";
}>;

export type MemoryScopedTargetLifecycleEvent = Readonly<{
  mutations: readonly MemorySourceMutation[];
  nextFolderId: string | null;
  previousFolderId: string | null;
  snapshot: MemorySourceSnapshot;
}>;

export type MemoryScopedTargetOwnerLifecycleEvent = Readonly<{
  kind: "ASSISTANT_ACCESS_CHANGE" | "CHAT_DELETE" | "FOLDER_DELETE";
  sourceSnapshots: readonly MemorySourceSnapshot[];
  targetId: string;
  userId: string;
}>;

export type MemoryTemporaryFinalizationEvent = Readonly<{
  settlement: MemoryTerminalSettlement;
  snapshot: MemorySourceSnapshot;
}>;

export type MemoryRetainedSourceMutationEvent = Readonly<{
  mutations: readonly MemorySourceMutation[];
  previous: LockedMemorySourceChat;
  settlement?: MemoryTerminalSettlement;
  snapshot: MemorySourceSnapshot;
}>;

/** Feature leaves attach here instead of adding independent writes to chat/run repositories. */
export type MemorySourceMutationHooks = Readonly<{
  onRetainedSourceMutated?: (
    tx: MemoryTransaction,
    event: MemoryRetainedSourceMutationEvent
  ) => Promise<void>;
  onScopedTargetLifecycle?: (
    tx: MemoryTransaction,
    event: MemoryScopedTargetLifecycleEvent
  ) => Promise<void>;
  onScopedTargetOwnerLifecycle?: (
    tx: MemoryTransaction,
    event: MemoryScopedTargetOwnerLifecycleEvent
  ) => Promise<void>;
  onTemporaryRunFinalized?: (
    tx: MemoryTransaction,
    event: MemoryTemporaryFinalizationEvent
  ) => Promise<void>;
}>;

export const NOOP_MEMORY_SOURCE_MUTATION_HOOKS: MemorySourceMutationHooks = Object.freeze({});

type SourcePathRow = Readonly<{
  content: Prisma.JsonValue;
  createdAt: Date;
  cycle: boolean;
  depth: number;
  errorMessage: string | null;
  groundedAt: Date | null;
  groundingProvider: string | null;
  groundingStrategy: string | null;
  id: string;
  modelId: string | null;
  parentMessageId: string | null;
  provider: string | null;
  role: string;
  status: string;
  updatedAt: Date;
}>;

type MemorySourcePatch = Readonly<{
  activeLeafMessageId?: string | null;
  archived?: boolean;
  folderId?: string | null;
  memoryMode?: MemoryChatMode;
  temporaryRetentionDeadline?: Date | null;
  temporaryRetentionPolicyVersion?: string | null;
}>;

const transientSourceMessageStatuses = new Set(["queued", "streaming"]);

export class MemorySourceStateConflictError extends Error {
  constructor(readonly code = "memory_source_state_conflict") {
    super(code);
    this.name = "MemorySourceStateConflictError";
  }
}

function nextValue<T>(current: T, next: T | undefined): T {
  return next === undefined ? current : next;
}

function counterAdvance(
  value: MemoryCounterAdvance,
  sourceRequiresBranchGeneration: boolean
): boolean {
  if (value === "WHEN_CHAT_SOURCE") return true;
  if (value === "AS_SOURCE_REQUIRES") return sourceRequiresBranchGeneration;
  return value;
}

function checkedCounter(current: number, increment: number): number {
  const next = current + increment;
  if (!Number.isSafeInteger(next) || next < 0 || next > MAX_COUNTER) {
    throw new MemorySourceStateConflictError("memory_counter_contract_invalid");
  }
  return next;
}

function sourceJobKinds(
  mutations: readonly MemorySourceMutation[],
  branchGenerationAdvanced: boolean
): readonly MemoryJobKind[] {
  const kinds = new Set<MemoryJobKind>();
  if (branchGenerationAdvanced) kinds.add("RECONCILE_BRANCH");
  if (mutations.some((mutation) =>
    mutation === "FOLDER_MOVE" ||
    mutation === "SOURCE_EXCLUDE" ||
    mutation === "SOURCE_RESUME" ||
    mutation === "SCOPE_TARGET_DELETE" ||
    mutation === "ASSISTANT_ACCESS_CHANGE")) {
    kinds.add("RECONCILE_SOURCE");
  }
  return [...kinds];
}

export async function lockMemorySourceChat(
  tx: MemoryTransaction,
  input: Readonly<{ chatId: string; lock: "SHARE" | "UPDATE"; userId: string }>
): Promise<LockedMemorySourceChat | null> {
  return readMemorySourceChat(tx, input);
}

async function readMemorySourceChat(
  tx: MemoryTransaction,
  input: Readonly<{
    chatId: string;
    lock: "NONE" | "SHARE" | "UPDATE";
    userId: string;
  }>
): Promise<LockedMemorySourceChat | null> {
  const lock = input.lock === "UPDATE"
    ? Prisma.sql`FOR UPDATE`
    : input.lock === "SHARE"
      ? Prisma.sql`FOR SHARE`
      : Prisma.empty;
  const rows = await tx.$queryRaw<LockedMemorySourceChat[]>(Prisma.sql`
    SELECT
      "id", "userId", "activeLeafMessageId", "folderId", "archived",
      "memoryMode", "memoryBranchGeneration", "memorySourceRevision",
      "temporaryRetentionPolicyVersion", "temporaryRetentionDeadline"
    FROM "Chat"
    WHERE "id" = ${input.chatId} AND "userId" = ${input.userId}
    ${lock}
  `);
  return rows[0] ?? null;
}

async function loadActiveSourcePath(
  tx: MemoryTransaction,
  chatId: string,
  activeLeafMessageId: string | null
): Promise<readonly SourcePathRow[]> {
  if (activeLeafMessageId === null) return [];
  const rows = await tx.$queryRaw<SourcePathRow[]>(Prisma.sql`
    WITH RECURSIVE active_path AS (
      SELECT
        message."id", message."parentMessageId", message."role",
        message."content", message."status"::text AS "status",
        message."provider", message."modelId", message."errorMessage",
        message."groundedAt", message."groundingProvider",
        message."groundingStrategy", message."createdAt", message."updatedAt",
        0 AS "depth", ARRAY[message."id"]::text[] AS visited, FALSE AS cycle
      FROM "Message" AS message
      WHERE message."chatId" = ${chatId}
        AND message."id" = ${activeLeafMessageId}

      UNION ALL

      SELECT
        parent."id", parent."parentMessageId", parent."role",
        parent."content", parent."status"::text AS "status",
        parent."provider", parent."modelId", parent."errorMessage",
        parent."groundedAt", parent."groundingProvider",
        parent."groundingStrategy", parent."createdAt", parent."updatedAt",
        child."depth" + 1,
        child.visited || parent."id",
        parent."id" = ANY(child.visited)
      FROM active_path AS child
      INNER JOIN "Message" AS parent
        ON parent."chatId" = ${chatId}
       AND parent."id" = child."parentMessageId"
      WHERE NOT child.cycle
    )
    SELECT
      "id", "parentMessageId", "role", "content", "status", "provider",
      "modelId", "errorMessage", "groundedAt", "groundingProvider",
      "groundingStrategy", "createdAt", "updatedAt", "depth", cycle
    FROM active_path
    ORDER BY "depth" DESC
  `);
  if (
    rows.length === 0 ||
    rows.some((row) => row.cycle) ||
    rows[0]?.parentMessageId !== null ||
    rows.at(-1)?.id !== activeLeafMessageId ||
    rows.some((row, index) => index > 0 && row.parentMessageId !== rows[index - 1]?.id)
  ) {
    throw new MemorySourceStateConflictError("memory_source_path_invalid");
  }
  return rows;
}

function sourceMessageProjection(message: SourcePathRow): Readonly<Record<string, unknown>> {
  const identity = {
    createdAt: message.createdAt.toISOString(),
    id: message.id,
    modelId: message.modelId,
    parentMessageId: message.parentMessageId,
    provider: message.provider,
    role: message.role
  };
  if (transientSourceMessageStatuses.has(message.status)) {
    return { ...identity, lifecycle: "ACTIVE" };
  }
  return {
    ...identity,
    content: message.content,
    errorMessage: message.errorMessage,
    groundedAt: message.groundedAt?.toISOString() ?? null,
    groundingProvider: message.groundingProvider,
    groundingStrategy: message.groundingStrategy,
    status: message.status,
    updatedAt: message.updatedAt.toISOString()
  };
}

export async function loadMemorySourceSnapshot(
  tx: MemoryTransaction,
  input: Readonly<{
    chatId: string;
    lock?: "NONE" | "SHARE" | "UPDATE";
    userId: string;
  }>
): Promise<MemorySourceSnapshot | null> {
  const chat = await readMemorySourceChat(tx, {
    chatId: input.chatId,
    lock: input.lock ?? "SHARE",
    userId: input.userId
  });
  if (!chat) return null;
  if (chat.memoryMode === "TEMPORARY") {
    return temporaryMemorySourceSnapshot(chat);
  }
  const path = await loadActiveSourcePath(tx, chat.id, chat.activeLeafMessageId);
  const sourceHash = memorySha256({
    activeLeafMessageId: chat.activeLeafMessageId,
    chatId: chat.id,
    folderId: chat.folderId,
    memoryMode: chat.memoryMode,
    messages: path.map(sourceMessageProjection),
    projectionVersion: MEMORY_SOURCE_PROJECTION_VERSION,
    temporaryRetentionDeadline: chat.temporaryRetentionDeadline?.toISOString() ?? null,
    temporaryRetentionPolicyVersion: chat.temporaryRetentionPolicyVersion,
    userId: chat.userId
  });
  return {
    ...chat,
    messages: path.map(({ createdAt, id, updatedAt }) => ({ createdAt, id, updatedAt })),
    sourceHash
  };
}

export async function applyMemorySourceMutations(
  tx: MemoryTransaction,
  input: Readonly<{
    chat: LockedMemorySourceChat;
    hooks?: MemorySourceMutationHooks;
    mutations: readonly MemorySourceMutation[];
    patch?: MemorySourcePatch;
    sourceRequiresBranchGeneration?: boolean;
    terminalSettlement?: MemoryTerminalSettlement;
  }>
): Promise<MemorySourceSnapshot> {
  if (
    input.mutations.length === 0 ||
    new Set(input.mutations).size !== input.mutations.length ||
    input.mutations.some((mutation) => !memorySourceMutationSet.has(mutation))
  ) {
    throw new MemorySourceStateConflictError("memory_source_mutation_unclassified");
  }
  const patch = input.patch ?? {};
  const nextMemoryMode = nextValue(input.chat.memoryMode, patch.memoryMode);
  const sourceRequiresBranchGeneration = input.sourceRequiresBranchGeneration ?? false;
  let branchIncrement = 0;
  let sourceIncrement = 0;
  let memoryGenerationIncrement = 0;
  let memoryRevisionIncrement = 0;
  for (const mutation of input.mutations) {
    if (nextMemoryMode === "TEMPORARY") continue;
    const effect = memoryCounterEffectFor(mutation);
    branchIncrement += Number(counterAdvance(
      effect.branchGeneration,
      sourceRequiresBranchGeneration
    ));
    sourceIncrement += Number(counterAdvance(
      effect.sourceRevision,
      sourceRequiresBranchGeneration
    ));
    memoryGenerationIncrement += Number(effect.memoryGeneration);
    memoryRevisionIncrement += Number(effect.memoryRevision);
  }

  const nextBranchGeneration = checkedCounter(
    input.chat.memoryBranchGeneration,
    branchIncrement
  );
  const nextSourceRevision = checkedCounter(
    input.chat.memorySourceRevision,
    sourceIncrement
  );
  const jobKinds = nextMemoryMode === "TEMPORARY"
    ? []
    : sourceJobKinds(input.mutations, branchIncrement > 0);
  const needsSettings = memoryGenerationIncrement > 0 ||
    memoryRevisionIncrement > 0 || jobKinds.length > 0;
  const settings = needsSettings
    ? await lockMemorySettings(tx, input.chat.userId, false)
    : null;
  if (settings) {
    const nextMemoryGeneration = checkedCounter(
      settings.memoryGeneration,
      memoryGenerationIncrement
    );
    const nextMemoryRevision = checkedCounter(
      settings.memoryRevision,
      memoryRevisionIncrement
    );
    const advanced = await tx.userMemorySettings.updateMany({
      data: {
        memoryGeneration: nextMemoryGeneration,
        memoryRevision: nextMemoryRevision
      },
      where: {
        memoryGeneration: settings.memoryGeneration,
        memoryRevision: settings.memoryRevision,
        userId: settings.userId
      }
    });
    if (advanced.count !== 1) {
      throw new MemorySourceStateConflictError("memory_counter_contract_invalid");
    }
    settings.memoryGeneration = nextMemoryGeneration;
    settings.memoryRevision = nextMemoryRevision;
  }

  const updated = await tx.chat.updateMany({
    data: {
      activeLeafMessageId: nextValue(input.chat.activeLeafMessageId, patch.activeLeafMessageId),
      archived: nextValue(input.chat.archived, patch.archived),
      folderId: nextValue(input.chat.folderId, patch.folderId),
      memoryBranchGeneration: nextBranchGeneration,
      memoryMode: nextValue(input.chat.memoryMode, patch.memoryMode),
      memorySourceRevision: nextSourceRevision,
      temporaryRetentionDeadline: nextValue(
        input.chat.temporaryRetentionDeadline,
        patch.temporaryRetentionDeadline
      ),
      temporaryRetentionPolicyVersion: nextValue(
        input.chat.temporaryRetentionPolicyVersion,
        patch.temporaryRetentionPolicyVersion
      )
    },
    where: {
      activeLeafMessageId: input.chat.activeLeafMessageId,
      folderId: input.chat.folderId,
      id: input.chat.id,
      memoryBranchGeneration: input.chat.memoryBranchGeneration,
      memoryMode: input.chat.memoryMode,
      memorySourceRevision: input.chat.memorySourceRevision,
      userId: input.chat.userId
    }
  });
  if (updated.count !== 1) {
    throw new MemorySourceStateConflictError();
  }

  const snapshot = nextMemoryMode === "TEMPORARY"
    ? temporaryMemorySourceSnapshot({
        ...input.chat,
        activeLeafMessageId: nextValue(
          input.chat.activeLeafMessageId,
          patch.activeLeafMessageId
        ),
        archived: nextValue(input.chat.archived, patch.archived),
        folderId: nextValue(input.chat.folderId, patch.folderId),
        memoryBranchGeneration: nextBranchGeneration,
        memoryMode: nextMemoryMode,
        memorySourceRevision: nextSourceRevision,
        temporaryRetentionDeadline: nextValue(
          input.chat.temporaryRetentionDeadline,
          patch.temporaryRetentionDeadline
        ),
        temporaryRetentionPolicyVersion: nextValue(
          input.chat.temporaryRetentionPolicyVersion,
          patch.temporaryRetentionPolicyVersion
        )
      })
    : await loadMemorySourceSnapshot(tx, {
        chatId: input.chat.id,
        lock: "UPDATE",
        userId: input.chat.userId
      });
  if (
    !snapshot ||
    snapshot.memoryBranchGeneration !== nextBranchGeneration ||
    snapshot.memorySourceRevision !== nextSourceRevision
  ) {
    throw new MemorySourceStateConflictError();
  }

  if (settings && snapshot.activeLeafMessageId) {
    for (const kind of jobKinds) {
      const identityHash = memorySha256({
        branchGeneration: snapshot.memoryBranchGeneration,
        chatId: snapshot.id,
        kind,
        pipelineVersion: MEMORY_SOURCE_RECONCILIATION_PIPELINE_VERSION,
        sourceHash: snapshot.sourceHash,
        sourceRevision: snapshot.memorySourceRevision
      });
      await enqueueMemoryJob(tx, settings, {
        idempotencyFingerprint: `${kind.toLocaleLowerCase("en-US")}:${identityHash}`,
        kind,
        pipelineVersion: MEMORY_SOURCE_RECONCILIATION_PIPELINE_VERSION,
        source: {
          activeLeafMessageId: snapshot.activeLeafMessageId,
          branchGeneration: snapshot.memoryBranchGeneration,
          chatId: snapshot.id,
          sourceHash: snapshot.sourceHash,
          sourceRevision: snapshot.memorySourceRevision
        }
      });
    }
  }

  const hooks = input.hooks ?? NOOP_MEMORY_SOURCE_MUTATION_HOOKS;
  if (snapshot.memoryMode !== "TEMPORARY") {
    await hooks.onRetainedSourceMutated?.(tx, {
      mutations: input.mutations,
      previous: input.chat,
      ...(input.terminalSettlement
        ? { settlement: input.terminalSettlement }
        : {}),
      snapshot
    });
  }
  if (snapshot.memoryMode !== "TEMPORARY" && input.mutations.some((mutation) =>
    mutation === "FOLDER_MOVE" ||
    mutation === "SCOPE_TARGET_DELETE" ||
    mutation === "ASSISTANT_ACCESS_CHANGE")) {
    await hooks.onScopedTargetLifecycle?.(tx, {
      mutations: input.mutations,
      nextFolderId: snapshot.folderId,
      previousFolderId: input.chat.folderId,
      snapshot
    });
  }
  if (
    input.mutations.includes("TERMINAL_SETTLEMENT") &&
    snapshot.memoryMode === "TEMPORARY" &&
    input.terminalSettlement
  ) {
    await hooks.onTemporaryRunFinalized?.(tx, {
      settlement: input.terminalSettlement,
      snapshot
    });
  }
  return snapshot;
}

export async function applyMemoryScopedTargetOwnerLifecycle(
  tx: MemoryTransaction,
  hooks: MemorySourceMutationHooks | undefined,
  event: MemoryScopedTargetOwnerLifecycleEvent
): Promise<void> {
  await (hooks ?? NOOP_MEMORY_SOURCE_MUTATION_HOOKS)
    .onScopedTargetOwnerLifecycle?.(tx, event);
}

export async function memorySourceJobSnapshotMatches(
  tx: MemoryTransaction,
  job: Readonly<{
    activeLeafMessageId: string | null;
    branchGeneration: number | null;
    chatId: string | null;
    memoryGenerationSnapshot: number;
    sourceHash: string | null;
    sourceRevision: number | null;
    userId: string;
  }>
): Promise<boolean> {
  if (job.chatId === null) {
    return job.activeLeafMessageId === null &&
      job.branchGeneration === null &&
      job.sourceRevision === null &&
      job.sourceHash === null;
  }
  if (
    job.activeLeafMessageId === null ||
    job.branchGeneration === null ||
    job.sourceRevision === null ||
    job.sourceHash === null
  ) return false;
  const snapshot = await loadMemorySourceSnapshot(tx, {
    chatId: job.chatId,
    lock: "SHARE",
    userId: job.userId
  });
  const settings = await tx.$queryRaw<Array<{ memoryGeneration: number }>>(Prisma.sql`
    SELECT "memoryGeneration"
    FROM "UserMemorySettings"
    WHERE "userId" = ${job.userId}
    FOR SHARE
  `);
  if (settings[0]?.memoryGeneration !== job.memoryGenerationSnapshot) return false;
  return Boolean(
    snapshot &&
    snapshot.activeLeafMessageId === job.activeLeafMessageId &&
    snapshot.memoryBranchGeneration === job.branchGeneration &&
    snapshot.memorySourceRevision === job.sourceRevision &&
    snapshot.sourceHash === job.sourceHash
  );
}

export async function deleteMemorySourceJobsForMessages(
  tx: MemoryTransaction,
  input: Readonly<{ chatId: string; messageIds: readonly string[]; userId: string }>
): Promise<number> {
  if (input.messageIds.length === 0) return 0;
  const deleted = await tx.memoryJob.deleteMany({
    where: {
      activeLeafMessageId: { in: [...input.messageIds] },
      chatId: input.chatId,
      userId: input.userId
    }
  });
  return deleted.count;
}

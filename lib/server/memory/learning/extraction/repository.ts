import {
  Prisma,
  type MemoryExecutionState,
  type PrismaClient
} from "@prisma/client";
import { prisma } from "../../../prisma";
import { MemoryCoordinatorError } from "../../coordinator/errors";
import type {
  MemoryJobClaim,
  MemoryJobDescriptor,
  MemoryJobGateDecision
} from "../../coordinator/types";
import {
  buildMemorySafeSourceSnapshot,
  type MemoryHistorySourceMessageInput
} from "../../history/sourceProjection";
import { memoryExplicitStatementContainsSecret } from "../../explicit/safety";
import { memorySha256 } from "../../persistence/lexical";
import {
  memoryDestructiveSourceCutoff,
  memorySourceIsInsidePause
} from "../../persistence/pauseIntervals";
import { findMatchingMemorySuppressions } from "../../persistence/suppressions";
import type {
  LockedMemorySettings,
  MemoryTransaction
} from "../../persistence/transaction";
import {
  loadMemorySuppressionKeyring,
  type MemorySuppressionKeyring
} from "../../suppressionKeyring";
import { loadMemorySourceSnapshot } from "../../sourceState";
import {
  MEMORY_FACT_MAX_INPUT_CHARACTERS,
  MEMORY_FACT_MAX_INPUT_MESSAGES,
  MEMORY_FACT_SOURCE_PROJECTION_VERSION,
  memoryFactExtractionClaimIsValid,
  memoryFactExtractionInputHash,
  memoryFactExtractionOutputHash,
  type MemoryExtractedCandidate,
  type MemoryFactExtractionInput,
  type MemoryFactExtractionPlan,
  type MemoryFactSourceIdentity
} from "./contract";
import { commitMemoryVNextExtractionPlan } from "../../vnext/repository";
import { loadMemoryFactContextRefs } from "../dependencies/context";

type PrepareResult =
  | Readonly<{ decision: Exclude<MemoryJobGateDecision, { status: "READY" }> }>
  | Readonly<{ input: MemoryFactExtractionInput }>;

export type MemoryFactExecutionBinding = Readonly<{
  acceptedOutputHash: string | null;
  id: string;
  inputHash: string;
  ordinal: number;
  secretFreeExecutionSnapshot: unknown;
  state: MemoryExecutionState;
}>;

const staleDecision = Object.freeze({
  errorCode: "memory_fact_source_stale",
  status: "STALE" as const
});
const disabledDecision = Object.freeze({
  errorCode: "memory_automatic_learning_disabled",
  status: "CANCELLED" as const
});

function modelValueContainsSecret(
  value: unknown,
  seen: WeakSet<object> = new WeakSet()
): boolean {
  if (typeof value === "string") {
    return memoryExplicitStatementContainsSecret(value);
  }
  if (typeof value !== "object" || value === null || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some((entry) => modelValueContainsSecret(entry, seen));
  }
  return Object.entries(value).some(([key, entry]) =>
    memoryExplicitStatementContainsSecret(key) || modelValueContainsSecret(entry, seen));
}

/** Final local defense before model-authored candidate text crosses storage. */
export function memoryAutomaticCandidateContainsSecret(
  candidate: MemoryExtractedCandidate
): boolean {
  const values = [
    candidate.displayText,
    candidate.statement,
    candidate.quote,
    candidate.rawTemporalExpression,
    candidate.responsePreference,
    ...candidate.entities.flatMap((entity) => [
      entity.canonicalLabel,
      entity.mention,
      ...entity.aliases
    ]),
    ...candidate.evidence.map((evidence) => evidence.quote)
  ];
  return values.some((value) => modelValueContainsSecret(value)) ||
    modelValueContainsSecret(candidate.proposedValue) ||
    modelValueContainsSecret(candidate.temporalResolutionEvidence);
}

type MemoryFactSourceMessage = Readonly<{
  chatId: string;
  content: Prisma.JsonValue;
  createdAt: Date;
  id: string;
  parentMessageId: string | null;
  role: string;
  status: string;
  updatedAt: Date;
}>;

type MemoryFactBoundSource = Readonly<{
  activePathMessageIds: readonly string[];
  chat: Readonly<{
    folderId: string | null;
    id: string;
    userId: string;
  }>;
  message: MemoryFactSourceMessage;
}>;

const sourceMessageSelect = Object.freeze({
  chatId: true,
  content: true,
  createdAt: true,
  id: true,
  parentMessageId: true,
  role: true,
  status: true,
  updatedAt: true
});

async function loadBoundSource(
  tx: MemoryTransaction,
  job: MemoryJobDescriptor
): Promise<MemoryFactBoundSource | null> {
  if (job.chatId === null || job.sourceMessageId === null) return null;
  const snapshot = await loadMemorySourceSnapshot(tx, {
    chatId: job.chatId,
    // The settings lock is the semantic-write linearization point. Avoid the
    // inverse chat->settings lock order used by source mutations while still
    // revalidating the complete active path in this transaction snapshot.
    lock: "NONE",
    personalOnly: true,
    userId: job.userId
  });
  if (
    !snapshot || snapshot.memoryMode !== "NORMAL" ||
    !snapshot.messages.some(({ id }) => id === job.sourceMessageId)
  ) return null;
  const message = await tx.message.findFirst({
    select: sourceMessageSelect,
    where: {
      chatId: job.chatId,
      id: job.sourceMessageId,
      role: "user",
      status: "complete"
    }
  });
  if (!message) return null;
  return {
    activePathMessageIds: snapshot.messages.map(({ id }) => id),
    chat: {
      folderId: snapshot.folderId,
      id: snapshot.id,
      userId: snapshot.userId
    },
    message
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalTimeZone(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 64) return "UTC";
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: value })
      .resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
}

function runTimeZone(value: Prisma.JsonValue | null): string {
  if (!isRecord(value) || !isRecord(value.prompt) || !isRecord(value.prompt.baseline)) {
    return "UTC";
  }
  return canonicalTimeZone(value.prompt.baseline.timeZone);
}

async function probeWith(
  tx: MemoryTransaction,
  job: MemoryJobDescriptor,
  now: Date
): Promise<MemoryJobGateDecision> {
  if (!memoryFactExtractionClaimIsValid(job)) {
    return { errorCode: "memory_fact_job_invalid", status: "CANCELLED" };
  }
  const source = await loadBoundSource(tx, job);
  if (!source) return staleDecision;
  const settings = await tx.userMemorySettings.findUnique({
    select: {
      learnAutomatically: true,
      memoryGeneration: true,
      useMemoryFacts: true
    },
    where: { userId: job.userId }
  });
  if (!settings || settings.memoryGeneration !== job.memoryGenerationSnapshot) {
    return staleDecision;
  }
  if (!settings.useMemoryFacts || !settings.learnAutomatically) return disabledDecision;
  const admission = await loadAdmission(tx, source, job.branchGeneration, now);
  if (admission.excluded) return staleDecision;
  return { status: "READY" };
}

async function loadAdmission(
  tx: MemoryTransaction,
  source: MemoryFactBoundSource,
  sourceBranchGeneration: number,
  now: Date
): Promise<Readonly<{
  excluded: boolean;
  sourceCreatedAtCutoff: Date | null;
  suppressionIdentitySnapshot: string;
}>> {
  const [barriers, pauseIntervals, suppressions, checkpoint] = await Promise.all([
    tx.memorySourceBarrier.findMany({
      orderBy: [{ sourceCreatedAtCutoff: "asc" }, { id: "asc" }],
      select: {
        id: true,
        kind: true,
        memoryGeneration: true,
        sourceCreatedAtCutoff: true
      },
      where: {
        explicitOverrideAllowed: false,
        kind: { in: ["ALL_REUSABLE", "AUTOMATIC_FACTS"] },
        userId: source.chat.userId
      }
    }),
    tx.memoryPauseInterval.findMany({
      orderBy: [{ pausedAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        memoryGeneration: true,
        pausedAt: true,
        resumedAt: true,
        scope: true
      },
      where: {
        scope: { in: ["MASTER", "AUTOMATIC_LEARNING"] },
        userId: source.chat.userId
      }
    }),
    tx.memorySuppression.findMany({
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: {
        expiresAt: true,
        fingerprintKeyVersion: true,
        id: true,
        scope: true,
        sourceBranchGeneration: true,
        sourceChatId: true,
        sourceMessageId: true
      },
      where: {
        AND: [
          { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
          {
            OR: [
              { scope: "ALL" },
              {
                scope: "SOURCE_MESSAGE",
                sourceBranchGeneration,
                sourceChatId: source.chat.id,
                sourceMessageId: source.message.id
              }
            ]
          }
        ],
        userId: source.chat.userId
      }
    }),
    tx.chatMemoryCheckpoint.findUnique({
      select: { resumeCreatedAtCutoff: true },
      where: {
        userId_chatId: {
          chatId: source.chat.id,
          userId: source.chat.userId
        }
      }
    })
  ]);
  const globalCutoff = memoryDestructiveSourceCutoff(
    barriers.map((barrier) => ({
      explicitOverrideAllowed: false,
      sourceCreatedAtCutoff: barrier.sourceCreatedAtCutoff
    }))
  );
  const resumeCutoff = checkpoint?.resumeCreatedAtCutoff ?? null;
  const sourceCreatedAtCutoff = globalCutoff && resumeCutoff
    ? (globalCutoff > resumeCutoff ? globalCutoff : resumeCutoff)
    : globalCutoff ?? resumeCutoff;
  return {
    excluded: suppressions.length > 0 ||
      memorySourceIsInsidePause(source.message.createdAt, pauseIntervals) ||
      (sourceCreatedAtCutoff !== null &&
        source.message.createdAt <= sourceCreatedAtCutoff),
    sourceCreatedAtCutoff,
    suppressionIdentitySnapshot: memorySha256({
      barriers,
      checkpointResumeCutoff: resumeCutoff,
      pauseIntervals,
      suppressions
    })
  };
}

function boundedContextMessages<T extends Readonly<{
  evidenceEligible: boolean;
  text: string;
}>>(
  messages: readonly T[]
): readonly T[] {
  const targetIndex = messages.findIndex((message) => message.evidenceEligible);
  const target = messages[targetIndex];
  if (!target || target.text.length > MEMORY_FACT_MAX_INPUT_CHARACTERS ||
    messages.some((message, index) =>
      index !== targetIndex && message.evidenceEligible)) return [];
  const selected = new Set([targetIndex]);
  let characters = target.text.length;
  for (let distance = 1; selected.size < MEMORY_FACT_MAX_INPUT_MESSAGES; distance += 1) {
    const indexes = [targetIndex + distance, targetIndex - distance]
      .filter((index) => index >= 0 && index < messages.length);
    if (indexes.length === 0) break;
    for (const index of indexes) {
      if (selected.size >= MEMORY_FACT_MAX_INPUT_MESSAGES) break;
      const message = messages[index]!;
      if (characters + message.text.length > MEMORY_FACT_MAX_INPUT_CHARACTERS) continue;
      selected.add(index);
      characters += message.text.length;
    }
  }
  return messages.filter((_message, index) => selected.has(index));
}

async function loadBoundContext(
  tx: MemoryTransaction,
  job: MemoryJobDescriptor & MemoryFactSourceIdentity,
  source: MemoryFactBoundSource
): Promise<Readonly<{
  activeLeafMessageId: string;
  contextRefs: MemoryFactExtractionInput["contextRefs"];
  messages: readonly MemoryHistorySourceMessageInput[];
  timeZone: string;
}>> {
  const activeRun = await tx.modelRun.findFirst({
    // The first completed run bound to the admitted leaf owns the temporal
    // snapshot. A later recovery/replay row must not rewrite extraction input.
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      assistantId: true,
      assistantMessageId: true,
      id: true,
      normalizedRequest: true,
      status: true,
      userMessageId: true
    },
    where: {
      assistantMessageId: job.activeLeafMessageId,
      chatId: source.chat.id,
      status: "complete",
      userId: source.chat.userId,
      userMessageId: source.message.id
    }
  });
  const messages: readonly MemoryHistorySourceMessageInput[] = [{
    ...source.message,
    parentMessageId: null,
    provenance: {
      assistantId: null,
      complete: true,
      influencedByMessageIds: [],
      modelRunId: null,
      origin: "DIRECT_USER",
      taintSources: []
    }
  }];
  const contextRefs = await loadMemoryFactContextRefs(tx, {
    activePathMessageIds: source.activePathMessageIds,
    sourceMessageId: source.message.id,
    userId: source.chat.userId
  });
  return {
    activeLeafMessageId: source.message.id,
    contextRefs,
    messages,
    timeZone: runTimeZone(activeRun?.normalizedRequest ?? null)
  };
}

/** Returns the sole direct-user message belonging to a settled assistant
 * leaf.  Keeping this pure makes the no-history-widening rule auditable and
 * prevents callers from accidentally selecting an older path message. */
export function currentDirectUserMessageId(
  messages: readonly Readonly<{
    id: string;
    parentMessageId: string | null;
    role: string;
    status: string;
  }>[],
  activeLeafMessageId: string | null
): string | null {
  if (activeLeafMessageId === null) return null;
  const activeLeaf = messages.find((message) => message.id === activeLeafMessageId);
  if (activeLeaf?.role !== "assistant" || activeLeaf.status !== "complete" ||
    activeLeaf.parentMessageId === null) return null;
  const parent = messages.find((message) => message.id === activeLeaf.parentMessageId);
  return parent?.role === "user" && parent.status === "complete"
    ? parent.id
    : null;
}

async function prepareWith(
  tx: MemoryTransaction,
  job: MemoryJobDescriptor,
  now: Date
): Promise<PrepareResult> {
  const decision = await probeWith(tx, job, now);
  if (decision.status !== "READY") return { decision };
  if (!memoryFactExtractionClaimIsValid(job)) {
    return {
      decision: { errorCode: "memory_fact_job_invalid", status: "CANCELLED" }
    };
  }
  const source = await loadBoundSource(tx, job);
  if (!source) return { decision: staleDecision };
  const context = await loadBoundContext(tx, job, source);
  const safeSnapshot = buildMemorySafeSourceSnapshot({
    activeLeafMessageId: context.activeLeafMessageId,
    branchGeneration: job.branchGeneration,
    chatId: source.chat.id,
    folderId: source.chat.folderId,
    messages: context.messages,
    mode: "NORMAL",
    sourceContentHash: memorySha256(context.messages.map((message) => ({
      content: message.content,
      createdAt: new Date(message.createdAt).toISOString(),
      id: message.id,
      updatedAt: new Date(message.updatedAt).toISOString()
    }))),
    sourceRevision: job.sourceRevision,
    timeZone: context.timeZone,
    userId: source.chat.userId
  });
  const admission = await loadAdmission(tx, source, job.branchGeneration, now);
  const projectedById = new Map(
    safeSnapshot.factEvidenceProjection.messages.map((message) =>
      [message.id, message] as const)
  );
  for (const group of safeSnapshot.recallChunkProjection.turnGroups) {
    for (const message of group.messages) projectedById.set(message.id, message);
  }
  const admitted = context.messages.flatMap((contextMessage) => {
    const message = projectedById.get(contextMessage.id);
    if (!message) return [];
    const evidenceEligible = message.id === source.message.id &&
      message.role === "user" &&
      !admission.excluded &&
      (admission.sourceCreatedAtCutoff === null ||
        new Date(message.createdAt) > admission.sourceCreatedAtCutoff);
    return [{
      contentHash: message.safeTextHash,
      createdAt: message.createdAt,
      evidenceEligible,
      id: message.id,
      languageCode: message.languageCode,
      role: message.role,
      text: message.safeText,
      updatedAt: message.updatedAt
    }];
  });
  const selected = boundedContextMessages(admitted);
  if (!selected.some((message) => message.evidenceEligible)) {
    return { decision: staleDecision };
  }
  const sourceProjectionHash = memorySha256({
    baseProjectionHash: safeSnapshot.snapshotHash,
    contextRefs: context.contextRefs,
    messages: selected,
    projectionVersion: MEMORY_FACT_SOURCE_PROJECTION_VERSION,
    suppressionIdentitySnapshot: admission.suppressionIdentitySnapshot
  });
  const sourceIdentity: MemoryFactSourceIdentity = {
    activeLeafMessageId: job.activeLeafMessageId,
    branchGeneration: job.branchGeneration,
    chatId: source.chat.id,
    memoryGenerationSnapshot: job.memoryGenerationSnapshot,
    sourceHash: job.sourceHash,
    sourceMessageId: source.message.id,
    sourceRevision: job.sourceRevision,
    userId: source.chat.userId
  };
  const withoutInputHash: Omit<MemoryFactExtractionInput, "inputHash"> = {
    contextRefs: context.contextRefs,
    folderId: source.chat.folderId,
    messages: selected,
    source: sourceIdentity,
    sourceProjectionHash,
    sourceProjectionVersion: MEMORY_FACT_SOURCE_PROJECTION_VERSION,
    suppressionIdentitySnapshot: admission.suppressionIdentitySnapshot,
    timeZone: context.timeZone
  };
  return {
    input: {
      ...withoutInputHash,
      inputHash: memoryFactExtractionInputHash(withoutInputHash)
    }
  };
}

async function candidateIsSuppressed(
  tx: MemoryTransaction,
  keyring: MemorySuppressionKeyring,
  input: MemoryFactExtractionInput,
  candidate: MemoryExtractedCandidate
): Promise<boolean> {
  for (const evidence of candidate.evidence) {
    const matches = await findMatchingMemorySuppressions(
      tx,
      keyring,
      input.source.userId,
      {
        canonicalKey: candidate.canonicalKey,
        category: candidate.category,
        normalizedValue: candidate.displayText,
        source: {
          branchGeneration: input.source.branchGeneration,
          chatId: input.source.chatId,
          messageId: evidence.messageId
        }
      }
    );
    if (matches.length > 0) return true;
  }
  return false;
}

async function applyPlan(
  tx: MemoryTransaction,
  settings: LockedMemorySettings,
  claim: MemoryJobClaim,
  plan: MemoryFactExtractionPlan,
  bindingId: string,
  keyring: MemorySuppressionKeyring,
  now: Date
): Promise<"APPLIED" | "EMPTY" | "STALE"> {
  if (
    !memoryFactExtractionClaimIsValid(claim) ||
    plan.input.source.userId !== claim.userId ||
    memoryFactExtractionOutputHash(plan.input, plan.candidates) !== plan.outputHash
  ) throw new MemoryCoordinatorError("memory_fact_plan_invalid", false);
  const liveLease = await tx.$queryRaw<Array<{ id: string; stage: string | null }>>(Prisma.sql`
    SELECT "id", "stage"
    FROM "MemoryJob"
    WHERE "id" = ${claim.id}
      AND "userId" = ${claim.userId}
      AND "state" = 'CLAIMED'::"MemoryJobState"
      AND "leaseToken" = ${claim.claimToken}
      AND "leaseExpiresAt" > ${now}
    FOR UPDATE
  `);
  if (!liveLease[0]) return "STALE";
  if (liveLease[0].stage === "fact_observations_applied") return "APPLIED";
  if (liveLease[0].stage === "fact_observations_empty_applied") return "EMPTY";
  if (!settings.useMemoryFacts || !settings.learnAutomatically ||
    settings.memoryGeneration !== claim.memoryGenerationSnapshot) return "STALE";
  const current = await prepareWith(tx, claim, now);
  if ("decision" in current || current.input.inputHash !== plan.input.inputHash) {
    return "STALE";
  }
  // Suppression is an independent candidate outcome.  A suppressed sibling
  // must not discard otherwise valid candidates from the same strict packet.
  const admittedCandidates: MemoryExtractedCandidate[] = [];
  for (const candidate of plan.candidates) {
    if (
      candidate.scope.type === "GLOBAL_USER" && candidate.scope.targetId === null &&
      !memoryAutomaticCandidateContainsSecret(candidate) &&
      !await candidateIsSuppressed(tx, keyring, plan.input, candidate)
    ) {
      admittedCandidates.push(candidate);
    }
  }

  const committed = await commitMemoryVNextExtractionPlan(
    tx,
    settings,
    claim,
    { ...plan, candidates: admittedCandidates },
    bindingId,
    now
  );
  const applied = committed.attachedEvidence > 0 || committed.createdVersions > 0;
  await tx.memoryJob.updateMany({
    data: {
      stage: applied
        ? "fact_observations_applied"
        : "fact_observations_empty_applied"
    },
    where: {
      id: claim.id,
      leaseToken: claim.claimToken,
      state: "CLAIMED",
      userId: claim.userId
    }
  });
  return applied ? "APPLIED" : "EMPTY";
}

export function createPrismaMemoryFactExtractionRepository(
  client: PrismaClient = prisma,
  options: Readonly<{
    keyring?: () => MemorySuppressionKeyring;
  }> = {}
) {
  const keyring = options.keyring ?? (() => {
    const configured = loadMemorySuppressionKeyring();
    if (configured.status !== "ready") {
      throw new Error("memory_suppression_keyring_unavailable");
    }
    return configured.keyring;
  });
  return Object.freeze({
    apply(
      tx: MemoryTransaction,
      settings: LockedMemorySettings,
      claim: MemoryJobClaim,
      plan: MemoryFactExtractionPlan,
      bindingId: string,
      now: Date
    ) {
      return applyPlan(tx, settings, claim, plan, bindingId, keyring(), now);
    },
    async applied(
      job: MemoryJobDescriptor,
      _bindingId: string
    ): Promise<"APPLIED" | "EMPTY" | null> {
      const marker = await client.memoryJob.findFirst({
        select: { stage: true },
        where: { id: job.id, userId: job.userId }
      });
      return marker?.stage === "fact_observations_applied"
        ? "APPLIED"
        : marker?.stage === "fact_observations_empty_applied"
          ? "EMPTY"
          : null;
    },
    bindings(userId: string, memoryJobId: string): Promise<MemoryFactExecutionBinding[]> {
      return client.memoryExecutionBinding.findMany({
        orderBy: [{ ordinal: "asc" }, { id: "asc" }],
        select: {
          acceptedOutputHash: true,
          id: true,
          inputHash: true,
          ordinal: true,
          secretFreeExecutionSnapshot: true,
          state: true
        },
        where: {
          logicalRole: "MEMORY_FACT_EXTRACT",
          memoryJobId,
          ownerType: "JOB",
          userId
        }
      });
    },
    prepare(job: MemoryJobDescriptor): Promise<PrepareResult> {
      return client.$transaction((tx) => prepareWith(tx, job, new Date()), {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead
      });
    },
    preflight(job: MemoryJobDescriptor): Promise<MemoryJobGateDecision> {
      return client.$transaction((tx) => probeWith(tx, job, new Date()), {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead
      });
    }
  });
}

export type MemoryFactExtractionRepository = ReturnType<
  typeof createPrismaMemoryFactExtractionRepository
>;

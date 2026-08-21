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
  type MemoryHistorySourceMessageInput,
  type MemoryHistorySourceOrigin,
  type MemoryHistoryTaintSource
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
  loadMemorySourceSnapshot,
  type MemorySourceSnapshot
} from "../../sourceState";
import {
  loadMemorySuppressionKeyring,
  type MemorySuppressionKeyring
} from "../../suppressionKeyring";
import {
  MEMORY_FACT_EXTRACTION_PIPELINE_VERSION,
  MEMORY_FACT_MAX_INPUT_CHARACTERS,
  MEMORY_FACT_MAX_INPUT_MESSAGES,
  MEMORY_FACT_SOURCE_PROJECTION_VERSION,
  MEMORY_FACT_TEMPORAL_RESOLVER_VERSION,
  memoryFactExtractionClaimIsValid,
  memoryFactExtractionInputHash,
  memoryFactExtractionOutputHash,
  type MemoryExtractedCandidate,
  type MemoryFactExtractionInput,
  type MemoryFactExtractionPlan,
  type MemoryFactSourceIdentity
} from "./contract";

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
    ...candidate.evidence.map((evidence) => evidence.quote)
  ];
  return values.some((value) => modelValueContainsSecret(value)) ||
    modelValueContainsSecret(candidate.proposedValue) ||
    modelValueContainsSecret(candidate.temporalResolutionEvidence);
}

function sourceMatchesJob(
  source: MemorySourceSnapshot | null,
  job: MemoryJobDescriptor
): source is MemorySourceSnapshot & Readonly<{ activeLeafMessageId: string }> {
  return Boolean(
    source && source.memoryMode === "NORMAL" && source.activeLeafMessageId &&
    source.activeLeafMessageId === job.activeLeafMessageId &&
    source.id === job.chatId &&
    source.memoryBranchGeneration === job.branchGeneration &&
    source.memorySourceRevision === job.sourceRevision &&
    source.sourceHash === job.sourceHash && source.userId === job.userId
  );
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

function provenanceForRole(role: string): Readonly<{
  origin: MemoryHistorySourceOrigin;
  taintSources: readonly MemoryHistoryTaintSource[];
}> {
  if (role === "user") return { origin: "DIRECT_USER", taintSources: [] };
  if (role === "assistant") {
    return { origin: "VISIBLE_ASSISTANT", taintSources: ["PROVIDER_PAYLOAD"] };
  }
  if (role === "system") return { origin: "SYSTEM", taintSources: ["SYSTEM"] };
  if (role === "developer") {
    return { origin: "DEVELOPER", taintSources: ["DEVELOPER"] };
  }
  if (role === "tool") return { origin: "TOOL", taintSources: ["TOOL"] };
  return { origin: "PROVIDER_PAYLOAD", taintSources: ["PROVIDER_PAYLOAD"] };
}

async function probeWith(
  tx: MemoryTransaction,
  job: MemoryJobDescriptor
): Promise<MemoryJobGateDecision> {
  if (!memoryFactExtractionClaimIsValid(job)) {
    return { errorCode: "memory_fact_job_invalid", status: "CANCELLED" };
  }
  const source = await loadMemorySourceSnapshot(tx, {
    chatId: job.chatId,
    lock: "SHARE",
    personalOnly: true,
    userId: job.userId
  });
  if (!sourceMatchesJob(source, job)) return staleDecision;
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
  return { status: "READY" };
}

async function loadAdmission(
  tx: MemoryTransaction,
  source: MemorySourceSnapshot,
  now: Date
): Promise<Readonly<{
  excludedMessageIds: ReadonlySet<string>;
  sourceCreatedAtCutoff: Date | null;
  suppressionIdentitySnapshot: string;
}>> {
  const pathMessageIds = source.messages.map((message) => message.id);
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
        userId: source.userId
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
        userId: source.userId
      }
    }),
    pathMessageIds.length === 0
      ? Promise.resolve([])
      : tx.memorySuppression.findMany({
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
                    sourceBranchGeneration: source.memoryBranchGeneration,
                    sourceChatId: source.id,
                    sourceMessageId: { in: pathMessageIds }
                  }
                ]
              }
            ],
            userId: source.userId
          }
        }),
    tx.chatMemoryCheckpoint.findUnique({
      select: { resumeCreatedAtCutoff: true },
      where: { userId_chatId: { chatId: source.id, userId: source.userId } }
    })
  ]);
  const excludesAll = suppressions.some((suppression) => suppression.scope === "ALL");
  const excludedMessageIds = new Set(excludesAll
    ? pathMessageIds
    : suppressions.flatMap((suppression) =>
        suppression.scope === "SOURCE_MESSAGE" && suppression.sourceMessageId
          ? [suppression.sourceMessageId]
          : []));
  for (const message of source.messages) {
    if (memorySourceIsInsidePause(message.createdAt, pauseIntervals)) {
      excludedMessageIds.add(message.id);
    }
  }
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
    excludedMessageIds,
    sourceCreatedAtCutoff,
    suppressionIdentitySnapshot: memorySha256({
      barriers,
      checkpointResumeCutoff: resumeCutoff,
      pauseIntervals,
      suppressions
    })
  };
}

function boundedRecentMessages<T extends Readonly<{ text: string }>>(
  messages: readonly T[]
): readonly T[] {
  const selected: T[] = [];
  let characters = 0;
  for (const message of [...messages].reverse()) {
    if (selected.length >= MEMORY_FACT_MAX_INPUT_MESSAGES) break;
    if (characters + message.text.length > MEMORY_FACT_MAX_INPUT_CHARACTERS) continue;
    selected.push(message);
    characters += message.text.length;
  }
  return selected.reverse();
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
  const decision = await probeWith(tx, job);
  if (decision.status !== "READY") return { decision };
  if (!memoryFactExtractionClaimIsValid(job)) {
    return {
      decision: { errorCode: "memory_fact_job_invalid", status: "CANCELLED" }
    };
  }
  const source = await loadMemorySourceSnapshot(tx, {
    chatId: job.chatId,
    lock: "SHARE",
    personalOnly: true,
    userId: job.userId
  });
  if (!sourceMatchesJob(source, job)) return { decision: staleDecision };
  const pathIds = source.messages.map((message) => message.id);
  const rows = await tx.message.findMany({
    select: {
      chatId: true,
      content: true,
      createdAt: true,
      id: true,
      parentMessageId: true,
      role: true,
      status: true,
      updatedAt: true
    },
    where: { chatId: source.id, id: { in: pathIds } }
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  if (pathIds.some((id) => !byId.has(id))) return { decision: staleDecision };
  const messages: MemoryHistorySourceMessageInput[] = pathIds.map((id) => {
    const row = byId.get(id);
    if (!row) throw new MemoryCoordinatorError("memory_fact_source_stale", false);
    const provenance = provenanceForRole(row.role);
    return {
      chatId: row.chatId,
      content: row.content,
      createdAt: row.createdAt,
      id: row.id,
      parentMessageId: row.parentMessageId,
      provenance: {
        assistantId: null,
        complete: true,
        influencedByMessageIds: [],
        modelRunId: null,
        origin: provenance.origin,
        taintSources: provenance.taintSources
      },
      role: row.role,
      status: row.status,
      updatedAt: row.updatedAt
    };
  });
  const activeRun = await tx.modelRun.findFirst({
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { normalizedRequest: true },
    where: {
      assistantMessageId: source.activeLeafMessageId,
      chatId: source.id,
      userId: source.userId
    }
  });
  const timeZone = runTimeZone(activeRun?.normalizedRequest ?? null);
  const safeSnapshot = buildMemorySafeSourceSnapshot({
    activeLeafMessageId: source.activeLeafMessageId,
    branchGeneration: source.memoryBranchGeneration,
    chatId: source.id,
    folderId: source.folderId,
    messages,
    mode: "NORMAL",
    sourceContentHash: source.sourceHash,
    sourceRevision: source.memorySourceRevision,
    timeZone,
    userId: source.userId
  });
  const admission = await loadAdmission(tx, source, now);
  // A settled assistant leaf identifies exactly one turn.  Automatic Memory
  // may inspect only its direct user parent; older user turns and every
  // assistant/tool/provider projection are intentionally out of scope.
  const currentUserMessageId = currentDirectUserMessageId(
    rows,
    source.activeLeafMessageId
  );
  const admitted = safeSnapshot.factEvidenceProjection.messages.flatMap((message) => {
    if (
      currentUserMessageId === null ||
      message.id !== currentUserMessageId ||
      message.role !== "user" ||
      admission.excludedMessageIds.has(message.id) ||
      (admission.sourceCreatedAtCutoff !== null &&
        new Date(message.createdAt) <= admission.sourceCreatedAtCutoff)
    ) return [];
    return [{
      contentHash: message.safeTextHash,
      createdAt: message.createdAt,
      id: message.id,
      languageCode: message.languageCode,
      text: message.safeText,
      updatedAt: message.updatedAt
    }];
  });
  const selected = boundedRecentMessages(admitted);
  const sourceProjectionHash = memorySha256({
    baseProjectionHash: safeSnapshot.factEvidenceProjection.projectionHash,
    messages: selected,
    projectionVersion: MEMORY_FACT_SOURCE_PROJECTION_VERSION,
    suppressionIdentitySnapshot: admission.suppressionIdentitySnapshot
  });
  const sourceIdentity: MemoryFactSourceIdentity = {
    activeLeafMessageId: source.activeLeafMessageId,
    branchGeneration: source.memoryBranchGeneration,
    chatId: source.id,
    sourceHash: source.sourceHash,
    sourceRevision: source.memorySourceRevision,
    userId: source.userId
  };
  const withoutInputHash: Omit<MemoryFactExtractionInput, "inputHash"> = {
    folderId: source.folderId,
    messages: selected,
    source: sourceIdentity,
    sourceProjectionHash,
    sourceProjectionVersion: MEMORY_FACT_SOURCE_PROJECTION_VERSION,
    suppressionIdentitySnapshot: admission.suppressionIdentitySnapshot,
    timeZone
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
): Promise<"APPLIED" | "STALE"> {
  if (
    !memoryFactExtractionClaimIsValid(claim) ||
    plan.input.source.userId !== claim.userId ||
    memoryFactExtractionOutputHash(plan.input, plan.candidates) !== plan.outputHash
  ) throw new MemoryCoordinatorError("memory_fact_plan_invalid", false);
  const liveLease = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id"
    FROM "MemoryJob"
    WHERE "id" = ${claim.id}
      AND "userId" = ${claim.userId}
      AND "state" = 'CLAIMED'::"MemoryJobState"
      AND "leaseToken" = ${claim.claimToken}
      AND "leaseExpiresAt" > ${now}
    FOR UPDATE
  `);
  if (!liveLease[0]) return "STALE";
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

  for (const candidate of admittedCandidates) {
    const [existing] = await tx.$queryRaw<Array<{
      contentPurgedAt: Date | null;
      id: string;
      reasonCode: string | null;
      state: string;
      userId: string;
    }>>(Prisma.sql`
      SELECT "contentPurgedAt", "id", "reasonCode", "state"::text AS "state", "userId"
      FROM "MemoryCandidate"
      WHERE "id" = ${candidate.id}
      FOR UPDATE
    `);
    if (existing) {
      if (existing.userId !== claim.userId) {
        throw new MemoryCoordinatorError("memory_fact_candidate_collision", false);
      }
      if (
        existing.state !== "STALE" ||
        existing.reasonCode !== "source_invalidated" ||
        existing.contentPurgedAt !== null
      ) continue;
      await tx.memoryCandidate.delete({ where: { id: existing.id } });
    }
    await tx.memoryCandidate.create({
      data: {
        branchGeneration: claim.branchGeneration,
        chatId: claim.chatId,
        confidence: candidate.confidence,
        createdByExecutionId: bindingId,
        id: candidate.id,
        importance: candidate.importance,
        jobId: claim.id,
        languageCode: candidate.languageCode,
        negated: candidate.negated,
        pipelineVersion: MEMORY_FACT_EXTRACTION_PIPELINE_VERSION,
        proposedCanonicalKey: candidate.canonicalKey,
        proposedCategory: candidate.category,
        proposedCoreEligible: candidate.coreEligible,
        proposedCoreSalience: candidate.coreSalience,
        proposedDirectness: candidate.directness,
        proposedDisplayText: candidate.displayText,
        proposedModality: candidate.modality,
        proposedScope: {
          target_id: candidate.scope.targetId,
          type: candidate.scope.type
        },
        proposedSensitivity: candidate.sensitivity,
        proposedValidFrom: candidate.validFrom
          ? new Date(candidate.validFrom)
          : null,
        proposedValidTo: candidate.validTo ? new Date(candidate.validTo) : null,
        proposedValue: candidate.proposedValue === null
          ? Prisma.JsonNull
          : candidate.proposedValue as Prisma.InputJsonValue,
        rawTemporalExpression: candidate.rawTemporalExpression,
        reasonCode: candidate.reasonCode,
        resolvedAt: null,
        sourceHash: claim.sourceHash,
        sourceProjectionHash: plan.input.sourceProjectionHash,
        sourceProjectionVersion: plan.input.sourceProjectionVersion,
        sourceRevision: claim.sourceRevision,
        sourceTimezone: plan.input.timeZone,
        state: candidate.state,
        temporalResolutionEvidence: candidate.temporalResolutionEvidence === null
          ? Prisma.DbNull
          : candidate.temporalResolutionEvidence as Prisma.InputJsonValue,
        temporalResolverVersion: candidate.temporalResolutionEvidence === null
          ? null
          : MEMORY_FACT_TEMPORAL_RESOLVER_VERSION,
        userId: claim.userId
      }
    });
    await tx.memoryCandidateMessage.createMany({
      data: candidate.evidence.map((evidence, ordinal) => ({
        candidateId: candidate.id,
        chatId: claim.chatId,
        endOffset: evidence.endOffset,
        messageId: evidence.messageId,
        ordinal,
        sourceTextHash: evidence.sourceTextHash,
        startOffset: evidence.startOffset,
        userId: claim.userId
      }))
    });
  }
  await tx.memoryJob.updateMany({
    data: { stage: "fact_candidates_applied" },
    where: {
      id: claim.id,
      leaseToken: claim.claimToken,
      state: "CLAIMED",
      userId: claim.userId
    }
  });
  return "APPLIED";
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
    async applied(job: MemoryJobDescriptor, bindingId: string): Promise<boolean> {
      const [candidateCount, marker] = await Promise.all([
        client.memoryCandidate.count({
          where: { createdByExecutionId: bindingId, userId: job.userId }
        }),
        client.memoryJob.findFirst({
          select: { stage: true },
          where: { id: job.id, userId: job.userId }
        })
      ]);
      return candidateCount > 0 || marker?.stage === "fact_candidates_applied";
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
      return client.$transaction((tx) => probeWith(tx, job), {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead
      });
    }
  });
}

export type MemoryFactExtractionRepository = ReturnType<
  typeof createPrismaMemoryFactExtractionRepository
>;

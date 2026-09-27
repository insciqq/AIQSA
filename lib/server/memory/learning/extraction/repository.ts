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
  type MemoryHistoryTaintSource,
  type MemorySafeSourceSnapshot
} from "../../history/sourceProjection";
import {
  MEMORY_HISTORY_UNPROCESSED_TEXT_REASON,
  projectMemoryHistorySafeText
} from "../../history/safety";
import { memoryValueContainsRecognizedSecret } from "../../explicit/safety";
import { enqueueMemoryJob } from "../../persistence/jobs";
import { memorySha256 } from "../../persistence/lexical";
import {
  memoryDestructiveSourceCutoff,
  memorySourceIsInsidePause
} from "../../persistence/pauseIntervals";
import { findMatchingMemorySuppressions } from "../../persistence/suppressions";
import {
  lockMemorySettings,
  type LockedMemorySettings,
  type MemoryTransaction
} from "../../persistence/transaction";
import {
  loadMemorySuppressionKeyring,
  type MemorySuppressionKeyring
} from "../../suppressionKeyring";
import { loadMemorySourceSnapshot } from "../../sourceState";
import {
  MEMORY_FACT_MAX_ACCEPTED_CANDIDATES,
  MEMORY_FACT_MAX_CONTEXT_CHARACTERS,
  MEMORY_FACT_MAX_INPUT_CHARACTERS,
  MEMORY_FACT_MAX_INPUT_MESSAGES,
  MEMORY_FACT_MAX_PRIOR_TURN_GROUPS,
  MEMORY_FACT_MAX_RAW_OBSERVATIONS,
  MEMORY_FACT_MAX_SOURCE_PAGES,
  MEMORY_FACT_MAX_TARGET_CHARACTERS,
  MEMORY_FACT_SOURCE_PROJECTION_VERSION,
  memoryFactExtractionClaimIsValid,
  memoryFactExtractionJobFingerprint,
  memoryFactExtractionJobIdentity,
  memoryFactEvidenceFingerprint,
  memoryFactExtractionInputHash,
  memoryFactExtractionOutputHash,
  memoryFactNextPage,
  memoryFactTargetView,
  type MemoryExtractedCandidate,
  type MemoryFactExtractionInput,
  type MemoryFactExtractionPlan,
  type MemoryFactCandidateRejection,
  type MemoryFactJobPage,
  type MemoryFactSourceIdentity,
  type MemoryFactTargetPage
} from "./contract";
import { commitMemoryVNextExtractionPlan } from "../../vnext/repository";
import { memoryRecordedLegacyIdentityKeys } from "../identity/compatibility";
import { loadMemoryFactContextRefs } from "../dependencies/context";
import { materializeMemoryCandidateEntityIdentity } from "../entities/repository";
import {
  decodeStoredMemorySemanticAdjudication,
  encodeStoredMemorySemanticAdjudication,
  memoryCandidateRequiresSemanticAdjudication,
  memorySemanticAdjudicationPacketIsValid,
  memorySemanticAuthorityAdmitsCandidate,
  type MemorySemanticAdjudicationPacket
} from "./adjudication";

type PrepareResult =
  | Readonly<{ decision: Exclude<MemoryJobGateDecision, { status: "READY" }> }>
  | Readonly<{ input: MemoryFactExtractionInput }>;

export type MemoryFactExecutionBinding = Readonly<{
  acceptedOutputHash: string | null;
  errorCode: string | null;
  id: string;
  inputHash: string;
  ordinal: number;
  pipelineVersion: string;
  policyVersion: string;
  promptVersion: string;
  schemaVersion: string;
  secretFreeExecutionSnapshot: unknown;
  state: MemoryExecutionState;
}>;

export type MemoryFactAuxiliarySemanticCall = Readonly<{
  acceptedOutputHash: string | null;
  completedAt: Date | null;
  executionId: string | null;
  inputHash: string | null;
  ownerJobId: string;
  purpose: string;
  result: unknown;
}>;

const staleDecision = Object.freeze({
  errorCode: "memory_fact_source_stale",
  status: "STALE" as const
});
// Incomplete coverage is a terminal failure of the job that owns the gap, not
// a stale revision: its reason stays visible in Memory processing health.
const oversizedDecision = Object.freeze({
  errorCode: "memory_fact_source_oversized",
  status: "CANCELLED" as const
});
const partiallyProcessedDecision = Object.freeze({
  errorCode: "memory_fact_source_partially_processed",
  status: "CANCELLED" as const
});
const coverageExhaustedDecision = Object.freeze({
  errorCode: "memory_fact_source_coverage_exhausted",
  status: "CANCELLED" as const
});
export const MEMORY_FACT_INCOMPLETE_SOURCE_CODES: ReadonlySet<string> = new Set([
  oversizedDecision.errorCode,
  partiallyProcessedDecision.errorCode,
  coverageExhaustedDecision.errorCode
]);
const disabledDecision = Object.freeze({
  errorCode: "memory_automatic_learning_disabled",
  status: "CANCELLED" as const
});

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
  return values.some((value) => memoryValueContainsRecognizedSecret(value)) ||
    memoryValueContainsRecognizedSecret(candidate.proposedValue) ||
    memoryValueContainsRecognizedSecret(candidate.temporalResolutionEvidence);
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
    return new Intl.DateTimeFormat(undefined, { timeZone: value })
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
  id: string;
  text: string;
}>>(
  messages: readonly T[]
): readonly T[] {
  const targetIndex = messages.findIndex((message) => message.evidenceEligible);
  const target = messages[targetIndex];
  if (!target || targetIndex !== messages.length - 1 ||
    target.text.length > MEMORY_FACT_MAX_TARGET_CHARACTERS ||
    messages.slice(0, targetIndex).reduce((sum, message) => sum + message.text.length, 0) >
      MEMORY_FACT_MAX_CONTEXT_CHARACTERS ||
    messages.length > MEMORY_FACT_MAX_INPUT_MESSAGES ||
    new Set(messages.map(({ id }) => id)).size !== messages.length ||
    messages.reduce((sum, message) => sum + message.text.length, 0) >
      MEMORY_FACT_MAX_INPUT_CHARACTERS ||
    messages.some((message, index) =>
      index !== targetIndex && message.evidenceEligible)) return [];
  return messages;
}

/** Selects a contiguous suffix of at most two complete safe turn groups plus
 * the final direct-user target. Older context is never allowed to jump over
 * an excluded or tainted path message. A target longer than one input is
 * read in pages of at most that size, so it never excludes itself. */
export function boundedMemoryFactContextMessageIds(
  snapshot: MemorySafeSourceSnapshot,
  targetMessageId: string
): readonly string[] {
  const target = snapshot.factEvidenceProjection.messages.find((message) =>
    message.id === targetMessageId && message.role === "user");
  const targetPathIndex = snapshot.activePathMessageIds.indexOf(targetMessageId);
  if (!target || targetPathIndex < 0) return [];
  const targetCharacters = Math.min(
    target.safeText.length,
    MEMORY_FACT_MAX_TARGET_CHARACTERS
  );
  const targetGroupIndex = snapshot.recallChunkProjection.turnGroups.findIndex(
    (group) => group.messages.some(({ id }) => id === targetMessageId)
  );
  if (targetGroupIndex < 0) return [targetMessageId];

  const pathIndexes = new Map(snapshot.activePathMessageIds.map((id, index) =>
    [id, index] as const));
  const selectedGroups: string[][] = [];
  let cursor = targetPathIndex;
  let characters = targetCharacters;
  let messageCount = 1;
  for (
    let groupIndex = targetGroupIndex - 1;
    groupIndex >= 0 && selectedGroups.length < MEMORY_FACT_MAX_PRIOR_TURN_GROUPS;
    groupIndex -= 1
  ) {
    const group = snapshot.recallChunkProjection.turnGroups[groupIndex]!;
    const ids = group.messages.map(({ id }) => id);
    const indexes = ids.map((id) => pathIndexes.get(id) ?? -1);
    const contiguous = indexes.length > 0 &&
      indexes.at(-1) === cursor - 1 &&
      indexes.every((index, offset) => index === indexes[0]! + offset);
    if (!contiguous) break;
    const groupCharacters = group.messages.reduce(
      (sum, message) => sum + message.safeText.length,
      0
    );
    if (messageCount + ids.length > MEMORY_FACT_MAX_INPUT_MESSAGES ||
      characters - targetCharacters + groupCharacters > MEMORY_FACT_MAX_CONTEXT_CHARACTERS ||
      characters + groupCharacters > MEMORY_FACT_MAX_INPUT_CHARACTERS) break;
    selectedGroups.unshift(ids);
    cursor = indexes[0]!;
    messageCount += ids.length;
    characters += groupCharacters;
  }
  return [...selectedGroups.flat(), targetMessageId];
}

const MEMORY_FACT_CONTEXT_LOOKBACK_MESSAGES = MEMORY_FACT_MAX_INPUT_MESSAGES * 2;

export function memoryAssistantContextRunIsEligible(
  run: Readonly<{ status: string; userMessageId: string }> | null,
  parentMessageId: string | null,
  candidateCount: number
): boolean {
  return candidateCount === 1 && run?.status === "complete" &&
    parentMessageId !== null && run.userMessageId === parentMessageId;
}

function contextSourceMessages(
  rows: readonly MemoryFactSourceMessage[],
  orderedIds: readonly string[],
  runs: readonly Readonly<{
    assistantId: string | null;
    assistantMessageId: string | null;
    id: string;
    status: string;
    userMessageId: string;
  }>[],
  ownedAssistantIds: ReadonlySet<string>
): readonly MemoryHistorySourceMessageInput[] {
  const byId = new Map(rows.map((row) => [row.id, row] as const));
  const runsByAssistantMessage = new Map<string, typeof runs>();
  for (const run of runs) {
    if (!run.assistantMessageId) continue;
    runsByAssistantMessage.set(run.assistantMessageId, [
      ...(runsByAssistantMessage.get(run.assistantMessageId) ?? []),
      run
    ]);
  }
  const messages: MemoryHistorySourceMessageInput[] = [];
  for (const [ordinal, id] of orderedIds.entries()) {
    const row = byId.get(id);
    if (!row) continue;
    const parentMessageId = ordinal === 0 ? null : row.parentMessageId;
    if (row.role === "user") {
      messages.push({
        ...row,
        parentMessageId,
        provenance: {
          assistantId: null,
          complete: true,
          influencedByMessageIds: [],
          modelRunId: null,
          origin: "DIRECT_USER" as const,
          taintSources: []
        }
      });
      continue;
    }
    if (row.role !== "assistant") {
      messages.push({
        ...row,
        parentMessageId,
        provenance: {
          assistantId: null,
          complete: true,
          influencedByMessageIds: [],
          modelRunId: null,
          origin: "SYSTEM" as const,
          taintSources: ["SYSTEM"] as readonly MemoryHistoryTaintSource[]
        }
      });
      continue;
    }
    const candidates = runsByAssistantMessage.get(row.id) ?? [];
    const run = candidates.length === 1 ? candidates[0]! : null;
    const runMatchesParent = memoryAssistantContextRunIsEligible(
      run,
      row.parentMessageId,
      candidates.length
    );
    const taintSources: readonly MemoryHistoryTaintSource[] =
      run?.assistantId && !ownedAssistantIds.has(run.assistantId)
        ? ["DEVELOPER"]
        : [];
    messages.push({
      ...row,
      parentMessageId,
      provenance: {
        assistantId: run?.assistantId && ownedAssistantIds.has(run.assistantId)
          ? run.assistantId
          : null,
        complete: runMatchesParent,
        influencedByMessageIds: runMatchesParent && run ? [run.userMessageId] : [],
        modelRunId: run?.id ?? null,
        origin: "VISIBLE_ASSISTANT" as const,
        taintSources
      }
    });
  }
  return messages;
}

function safeMemoryFactContextRefs(
  refs: MemoryFactExtractionInput["contextRefs"]
): MemoryFactExtractionInput["contextRefs"] {
  return refs.flatMap((ref) => {
    const text = projectMemoryHistorySafeText(ref.text);
    if (!text.eligible) return [];
    const displayName = ref.displayName === null
      ? null
      : projectMemoryHistorySafeText(ref.displayName);
    const entityType = ref.entityType === null
      ? null
      : projectMemoryHistorySafeText(ref.entityType);
    const aliases = ref.aliases.flatMap((alias) => {
      const projected = projectMemoryHistorySafeText(alias);
      return projected.eligible ? [projected.safeText] : [];
    });
    return [{
      ...ref,
      aliases,
      displayName: displayName?.eligible ? displayName.safeText : null,
      entityType: entityType?.eligible ? entityType.safeText : null,
      text: text.safeText
    }];
  });
}

function frozenFactVersionIds(value: Prisma.JsonValue): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  const ids: string[] = [];
  for (const binding of value) {
    if (!isRecord(binding) || !isRecord(binding.source) ||
      (binding.kind !== "MESSAGE" && binding.kind !== "FACT_VERSION")) {
      return null;
    }
    const factVersionId = binding.source.factVersionId;
    if (binding.kind === "FACT_VERSION") {
      if (typeof factVersionId !== "string" || !factVersionId) return null;
      ids.push(factVersionId);
    } else if (factVersionId !== null) {
      return null;
    }
  }
  return new Set(ids).size === ids.length ? ids : null;
}

async function stagedFactVersionIds(
  tx: MemoryTransaction,
  job: MemoryJobDescriptor
): Promise<readonly string[] | undefined | null> {
  const staged = await tx.memoryFactExtractionExecution.findFirst({
    select: { contextBindings: true },
    where: { memoryJobId: job.id, userId: job.userId }
  });
  if (!staged) return undefined;
  return frozenFactVersionIds(staged.contextBindings);
}

async function loadBoundContext(
  tx: MemoryTransaction,
  job: MemoryJobDescriptor & MemoryFactSourceIdentity,
  source: MemoryFactBoundSource
): Promise<Readonly<{
  activeLeafMessageId: string;
  messages: readonly MemoryHistorySourceMessageInput[];
  /** The target could not be scanned within the projection budget at all. */
  targetOversized: boolean;
  timeZone: string;
}>> {
  const targetIndex = source.activePathMessageIds.indexOf(source.message.id);
  if (targetIndex < 0) {
    return {
      activeLeafMessageId: source.message.id,
      messages: [],
      targetOversized: false,
      timeZone: "UTC"
    };
  }
  const candidateIds = source.activePathMessageIds.slice(
    Math.max(0, targetIndex - MEMORY_FACT_CONTEXT_LOOKBACK_MESSAGES),
    targetIndex + 1
  );
  const [activeRun, rows] = await Promise.all([
    tx.modelRun.findFirst({
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
    }),
    tx.message.findMany({
      select: sourceMessageSelect,
      where: { chatId: source.chat.id, id: { in: candidateIds } }
    }) as Promise<MemoryFactSourceMessage[]>
  ]);
  const assistantMessageIds = rows
    .filter(({ role }) => role === "assistant")
    .map(({ id }) => id);
  const runs = assistantMessageIds.length === 0
    ? []
    : await tx.modelRun.findMany({
        select: {
          assistantId: true,
          assistantMessageId: true,
          id: true,
          status: true,
          userMessageId: true
        },
        where: {
          assistantMessageId: { in: assistantMessageIds },
          chatId: source.chat.id,
          userId: source.chat.userId
        }
      });
  const runAssistantIds = [...new Set(runs.flatMap(({ assistantId }) =>
    assistantId ? [assistantId] : []))];
  const ownedAssistants = runAssistantIds.length === 0
    ? []
    : await tx.assistantDefinition.findMany({
        select: { id: true },
        where: {
          archivedAt: null,
          id: { in: runAssistantIds },
          ownerUserId: source.chat.userId
        }
      });
  const candidates = contextSourceMessages(
    rows,
    candidateIds,
    runs,
    new Set(ownedAssistants.map(({ id }) => id))
  );
  if (candidates.length !== candidateIds.length) {
    return {
      activeLeafMessageId: source.message.id,
      messages: [],
      targetOversized: false,
      timeZone: "UTC"
    };
  }
  const candidateSnapshot = buildMemorySafeSourceSnapshot({
    activeLeafMessageId: source.message.id,
    branchGeneration: job.branchGeneration,
    chatId: source.chat.id,
    folderId: source.chat.folderId,
    messages: candidates,
    mode: "NORMAL",
    sourceContentHash: memorySha256(candidates.map((message) => ({
      content: message.content,
      createdAt: new Date(message.createdAt).toISOString(),
      id: message.id,
      updatedAt: new Date(message.updatedAt).toISOString()
    }))),
    sourceRevision: job.sourceRevision,
    timeZone: runTimeZone(activeRun?.normalizedRequest ?? null),
    userId: source.chat.userId
  });
  const selectedIds = boundedMemoryFactContextMessageIds(
    candidateSnapshot,
    source.message.id
  );
  const selected = new Set(selectedIds);
  const messages = candidates
    .filter(({ id }) => selected.has(id))
    .map((message, ordinal) => ({
      ...message,
      parentMessageId: ordinal === 0 ? null : message.parentMessageId
    }));
  const targetNode = candidateSnapshot.provenanceGraph.find(({ messageId }) =>
    messageId === source.message.id);
  return {
    activeLeafMessageId: source.message.id,
    messages,
    // Size never reads as sensitivity or staleness: a target whose scanned
    // text retained nothing is reported as oversized, not as a stale source.
    targetOversized: targetNode?.eligibleForFactEvidence === false &&
      !targetNode.transitiveTaint &&
      targetNode.reasonCodes.includes("SOURCE_TEXT_LIMIT"),
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

type MemoryFactAdmittedMessage = MemoryFactExtractionInput["messages"][number];

/** Replaces a long target by this job's page. The page keeps the full-text
 * content hash; its text and redaction spans are page-local. A page past the
 * end of the text, or past the page budget, is the recorded coverage gap. */
function pageMemoryFactTarget(
  messages: readonly MemoryFactAdmittedMessage[],
  targetId: string,
  sourceUnprocessed: boolean,
  page: MemoryFactJobPage
):
  | Readonly<{ decision: Exclude<MemoryJobGateDecision, { status: "READY" }> }>
  | Readonly<{
      messages: readonly MemoryFactAdmittedMessage[];
      targetPage?: MemoryFactTargetPage;
    }> {
  const index = messages.findIndex((message) =>
    message.id === targetId && message.evidenceEligible);
  if (index < 0) return { messages };
  const target = messages[index]!;
  const view = memoryFactTargetView(target.text, page, sourceUnprocessed);
  if (view.kind === "WHOLE") return { messages };
  if (view.kind === "INVALID") return { decision: staleDecision };
  if (view.kind === "COVERED") return { decision: partiallyProcessedDecision };
  if (page.ordinal >= MEMORY_FACT_MAX_SOURCE_PAGES) {
    return { decision: coverageExhaustedDecision };
  }
  const start = view.page.coreStart;
  const end = start + view.text.length;
  const pageTarget: MemoryFactAdmittedMessage = {
    ...target,
    redactionSpans: target.redactionSpans.flatMap((span) =>
      span.endOffset <= start || span.startOffset >= end
        ? []
        : [{
            endOffset: Math.min(span.endOffset, end) - start,
            startOffset: Math.max(span.startOffset, start) - start
          }]),
    text: view.text
  };
  return {
    messages: messages.map((message, position) =>
      position === index ? pageTarget : message),
    targetPage: view.page
  };
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
  const jobIdentity = memoryFactExtractionJobIdentity(job);
  if (jobIdentity === null) {
    return {
      decision: { errorCode: "memory_fact_job_invalid", status: "CANCELLED" }
    };
  }
  const { identityProfile, page } = jobIdentity;
  const source = await loadBoundSource(tx, job);
  if (!source) return { decision: staleDecision };
  const context = await loadBoundContext(tx, job, source);
  if (context.messages.length === 0) {
    return { decision: context.targetOversized ? oversizedDecision : staleDecision };
  }
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
      redactionSpans: message.redactionSourceMap.flatMap((entry) =>
        entry.kind === "REDACTION"
          ? [{ endOffset: entry.outputEnd, startOffset: entry.outputStart }]
          : []),
      role: message.role,
      text: message.safeText,
      updatedAt: message.updatedAt
    }];
  });
  const paged = pageMemoryFactTarget(
    admitted,
    source.message.id,
    projectedById.get(source.message.id)?.redactionReasonCodes
      .includes(MEMORY_HISTORY_UNPROCESSED_TEXT_REASON) === true,
    page
  );
  if ("decision" in paged) return { decision: paged.decision };
  const selected = boundedContextMessages(paged.messages);
  if (!selected.some((message) => message.evidenceEligible)) {
    return { decision: staleDecision };
  }
  const frozenIds = await stagedFactVersionIds(tx, job);
  if (frozenIds === null) return { decision: staleDecision };
  const contextRefs = safeMemoryFactContextRefs(
    await loadMemoryFactContextRefs(tx, {
      ...(frozenIds === undefined ? {} : { factVersionIds: frozenIds }),
      messages: selected,
      userId: source.chat.userId
    })
  );
  const sourceProjectionHash = memorySha256({
    baseProjectionHash: safeSnapshot.snapshotHash,
    contextRefs,
    messages: selected,
    projectionVersion: MEMORY_FACT_SOURCE_PROJECTION_VERSION,
    suppressionIdentitySnapshot: admission.suppressionIdentitySnapshot,
    ...(paged.targetPage ? { targetPage: paged.targetPage } : {})
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
    contextRefs,
    folderId: source.chat.folderId,
    identityProfile,
    messages: selected,
    source: sourceIdentity,
    sourceProjectionHash,
    sourceProjectionVersion: MEMORY_FACT_SOURCE_PROJECTION_VERSION,
    suppressionIdentitySnapshot: admission.suppressionIdentitySnapshot,
    ...(paged.targetPage ? { targetPage: paged.targetPage } : {}),
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
  const scope = await tx.memoryScope.findFirst({
    select: { id: true },
    where: { scopeType: "GLOBAL_USER", userId: input.source.userId }
  });
  const recorded = scope === null ? [] : await memoryRecordedLegacyIdentityKeys(tx, {
    containerId: scope.id, namespace: "FACT",
    unicodeCanonicalKey: candidate.unicodeCanonicalKey, userId: input.source.userId
  });
  const keys = new Set([
    candidate.unicodeCanonicalKey,
    ...(candidate.legacyCanonicalKey === undefined ? [] : [candidate.legacyCanonicalKey]),
    ...recorded.map(({ canonicalKey }) => canonicalKey)
  ]);
  for (const evidence of candidate.evidence) {
    for (const canonicalKey of keys) {
      const matches = await findMatchingMemorySuppressions(
        tx,
        keyring,
        input.source.userId,
        {
          canonicalKey,
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
  }
  return false;
}

type StagedExtractionOutput = Readonly<{
  candidateOrdinals: readonly number[];
  candidates: readonly MemoryExtractedCandidate[];
  coverageEnd?: number;
  rejections: readonly MemoryFactCandidateRejection[];
}>;

const terminalApplyOutcomes = new Set([
  "APPLIED",
  "MERGED",
  "REINFORCED",
  "REPLAY",
  "SUPERSEDED"
]);

const stagedRejectionCodes = new Set<MemoryFactCandidateRejection["reasonCode"]>([
  "REJECT_AMBIGUOUS",
  "REJECT_DUPLICATE",
  "REJECT_LOW_CONFIDENCE",
  "REJECT_OUTSIDE_PAGE",
  "REJECT_PACKET_OVERFLOW",
  "REJECT_SECRET",
  "REJECT_STALE_SOURCE",
  "REJECT_TEMPORARY",
  "REJECT_UNSUPPORTED"
]);

function planOutput(plan: MemoryFactExtractionPlan): StagedExtractionOutput {
  return {
    candidateOrdinals: plan.candidateOrdinals,
    candidates: plan.candidates,
    ...(plan.coverageEnd === undefined ? {} : { coverageEnd: plan.coverageEnd }),
    rejections: plan.rejections
  };
}

function contextBindings(input: MemoryFactExtractionInput) {
  return input.contextRefs.map((context) => ({
    entityId: context.entityId,
    kind: context.kind,
    ref: context.ref,
    source: context.source
  }));
}

function planIsValid(plan: MemoryFactExtractionPlan): boolean {
  const ordinals = [
    ...plan.candidateOrdinals,
    ...plan.rejections.map(({ candidateOrdinal }) => candidateOrdinal)
  ];
  const orderedOrdinals = [...ordinals].sort((left, right) => left - right);
  const pageStart = plan.input.targetPage?.coreStart ?? 0;
  const sourceLength = plan.input.targetPage?.sourceLength ??
    plan.input.messages.find((message) => message.evidenceEligible)?.text.length ?? 0;
  return plan.candidateOrdinals.length === plan.candidates.length &&
    plan.candidates.length <= MEMORY_FACT_MAX_ACCEPTED_CANDIDATES &&
    ordinals.length <= MEMORY_FACT_MAX_RAW_OBSERVATIONS &&
    new Set(ordinals).size === ordinals.length &&
    ordinals.every((ordinal) => Number.isSafeInteger(ordinal) &&
      ordinal >= 0 && ordinal < MEMORY_FACT_MAX_RAW_OBSERVATIONS) &&
    (plan.coverageEnd === undefined || (
      Number.isSafeInteger(plan.coverageEnd) &&
      plan.coverageEnd > pageStart && plan.coverageEnd <= sourceLength
    )) &&
    orderedOrdinals.every((ordinal, index) => ordinal === index) &&
    plan.candidates.every((candidate) =>
      /^[a-f0-9]{64}$/u.test(candidate.id) &&
      candidate.identityProfile === plan.input.identityProfile &&
      candidate.canonicalKey === (
        plan.input.identityProfile === "LEGACY_V1"
          ? candidate.legacyCanonicalKey
          : candidate.unicodeCanonicalKey
      ) && (
        candidate.identityProfile === "LEGACY_V1"
          ? candidate.identityVersion === "proposition-v1" ||
            candidate.identityVersion === "slot-v2"
          : candidate.identityVersion === "proposition-v2" ||
            candidate.identityVersion === "slot-v4"
      )) &&
    plan.rejections.every(({ reasonCode }) => stagedRejectionCodes.has(reasonCode)) &&
    memoryFactExtractionOutputHash(
      plan.input,
      plan.candidates,
      plan.candidateOrdinals,
      plan.rejections,
      plan.coverageEnd
    ) === plan.outputHash;
}

function onlyAddsUnreferencedFactContext(
  plan: MemoryFactExtractionPlan,
  current: MemoryFactExtractionInput,
  adjudication: MemorySemanticAdjudicationPacket | null
): boolean {
  if (
    plan.input.contextRefs.some(({ kind }) => kind === "FACT_VERSION") ||
    !current.contextRefs.some(({ kind }) => kind === "FACT_VERSION") ||
    adjudication?.decisions.some(({ entityRef, targetRef }) =>
      entityRef !== null || targetRef !== null) === true
  ) return false;
  const stableProjection = (input: MemoryFactExtractionInput) => ({
    ...input,
    contextRefs: input.contextRefs.filter(({ kind }) => kind === "MESSAGE"),
    inputHash: null,
    sourceProjectionHash: null
  });
  return memorySha256(stableProjection(plan.input)) ===
    memorySha256(stableProjection(current));
}

function receiptFingerprint(
  plan: MemoryFactExtractionPlan,
  candidateOrdinal: number,
  candidate: MemoryExtractedCandidate | null,
  reasonCode: MemoryFactCandidateRejection["reasonCode"] | null
): string {
  return candidate?.id ?? memorySha256({
    candidateOrdinal,
    domain: "aiqsa.memory.fact-extraction-rejection",
    outputHash: plan.outputHash,
    reasonCode,
    version: 1
  });
}

function receiptId(
  userId: string,
  executionId: string,
  candidateOrdinal: number
): string {
  return memorySha256({
    candidateOrdinal,
    domain: "aiqsa.memory.fact-extraction-candidate-receipt",
    executionId,
    userId,
    version: 1
  });
}

async function stagePlan(
  tx: MemoryTransaction,
  job: MemoryJobDescriptor,
  plan: MemoryFactExtractionPlan,
  bindingId: string,
  recoverableUntil: Date
): Promise<void> {
  if (
    !memoryFactExtractionClaimIsValid(job) ||
    plan.input.source.userId !== job.userId ||
    plan.input.source.sourceMessageId !== job.sourceMessageId ||
    !planIsValid(plan) ||
    !Number.isFinite(recoverableUntil.getTime())
  ) throw new MemoryCoordinatorError("memory_fact_plan_invalid", false);
  const source = plan.input.messages.find((message) =>
    message.evidenceEligible && message.id === plan.input.source.sourceMessageId);
  if (!source) throw new MemoryCoordinatorError("memory_fact_plan_invalid", false);
  const id = memorySha256({
    bindingId,
    domain: "aiqsa.memory.fact-extraction-execution",
    jobId: job.id,
    userId: job.userId,
    version: 1
  });
  const output = planOutput(plan);
  const bindings = contextBindings(plan.input);
  await tx.memoryFactExtractionExecution.createMany({
    data: [{
      acceptedOutput: output as Prisma.InputJsonValue,
      acceptedOutputHash: plan.outputHash,
      contextBindings: bindings as Prisma.InputJsonValue,
      executionBindingId: bindingId,
      id,
      inputHash: plan.input.inputHash,
      memoryJobId: job.id,
      recoverableUntil,
      sourceMessageContentHash: source.contentHash,
      sourceMessageId: source.id,
      userId: job.userId
    }],
    skipDuplicates: true
  });
  const staged = await tx.memoryFactExtractionExecution.findFirst({
    select: {
      acceptedOutput: true,
      acceptedOutputHash: true,
      appliedAt: true,
      contextBindings: true,
      executionBindingId: true,
      id: true,
      inputHash: true,
      recoverableUntil: true,
      sourceMessageContentHash: true,
      sourceMessageId: true
    },
    where: { memoryJobId: job.id, userId: job.userId }
  });
  if (
    !staged || staged.id !== id || staged.appliedAt !== null ||
    staged.executionBindingId !== bindingId ||
    staged.inputHash !== plan.input.inputHash ||
    staged.acceptedOutputHash !== plan.outputHash ||
    staged.sourceMessageId !== source.id ||
    staged.sourceMessageContentHash !== source.contentHash ||
    staged.recoverableUntil.getTime() !== recoverableUntil.getTime() ||
    memorySha256(staged.acceptedOutput) !== memorySha256(output) ||
    memorySha256(staged.contextBindings) !== memorySha256(bindings)
  ) throw new MemoryCoordinatorError("memory_fact_stage_conflict", false);

  const receiptRows = [
    ...plan.candidates.map((candidate, index) => {
      const candidateOrdinal = plan.candidateOrdinals[index]!;
      return {
        candidateFingerprint: receiptFingerprint(
          plan,
          candidateOrdinal,
          candidate,
          null
        ),
        candidateOrdinal,
        extractionExecutionId: id,
        id: receiptId(job.userId, id, candidateOrdinal),
        outcome: "PENDING" as const,
        userId: job.userId
      };
    }),
    ...plan.rejections.map((rejection) => ({
      candidateFingerprint: receiptFingerprint(
        plan,
        rejection.candidateOrdinal,
        null,
        rejection.reasonCode
      ),
      candidateOrdinal: rejection.candidateOrdinal,
      extractionExecutionId: id,
      id: receiptId(job.userId, id, rejection.candidateOrdinal),
      outcome: "REJECTED" as const,
      reasonCode: rejection.reasonCode,
      userId: job.userId
    }))
  ];
  if (receiptRows.length > 0) {
    await tx.memoryFactExtractionCandidateReceipt.createMany({
      data: receiptRows,
      skipDuplicates: true
    });
  }
  const storedReceipts = await tx.memoryFactExtractionCandidateReceipt.findMany({
    orderBy: [{ candidateOrdinal: "asc" }, { id: "asc" }],
    select: {
      candidateFingerprint: true,
      candidateOrdinal: true,
      outcome: true,
      reasonCode: true
    },
    where: { extractionExecutionId: id, userId: job.userId }
  });
  const expectedReceipts = receiptRows.map((receipt) => ({
    candidateFingerprint: receipt.candidateFingerprint,
    candidateOrdinal: receipt.candidateOrdinal,
    outcome: receipt.outcome,
    reasonCode: "reasonCode" in receipt ? receipt.reasonCode : null
  })).sort((left, right) => left.candidateOrdinal - right.candidateOrdinal);
  if (memorySha256(storedReceipts) !== memorySha256(expectedReceipts)) {
    throw new MemoryCoordinatorError("memory_fact_stage_conflict", false);
  }
}

function parseStagedOutput(value: unknown): StagedExtractionOutput | null {
  if (!isRecord(value) ||
    !Array.isArray(value.candidates) ||
    !Array.isArray(value.candidateOrdinals) ||
    !Array.isArray(value.rejections)) return null;
  const candidateOrdinals = value.candidateOrdinals;
  const rejections = value.rejections;
  if ((value.coverageEnd !== undefined && !Number.isSafeInteger(value.coverageEnd)) ||
    !candidateOrdinals.every((ordinal) => Number.isSafeInteger(ordinal)) ||
    !rejections.every((rejection) => isRecord(rejection) &&
      Number.isSafeInteger(rejection.candidateOrdinal) &&
      typeof rejection.reasonCode === "string" &&
      stagedRejectionCodes.has(
        rejection.reasonCode as MemoryFactCandidateRejection["reasonCode"]
      ))) return null;
  return {
    candidateOrdinals: candidateOrdinals as number[],
    candidates: value.candidates as MemoryExtractedCandidate[],
    ...(value.coverageEnd === undefined
      ? {}
      : { coverageEnd: value.coverageEnd as number }),
    rejections: rejections as MemoryFactCandidateRejection[]
  };
}

async function loadStagedPlan(
  client: PrismaClient,
  job: MemoryJobDescriptor,
  bindingId: string,
  input: MemoryFactExtractionInput,
  now: Date
): Promise<MemoryFactExtractionPlan | null> {
  if (!Number.isFinite(now.getTime())) return null;
  const staged = await client.memoryFactExtractionExecution.findFirst({
    select: {
      acceptedOutput: true,
      acceptedOutputHash: true,
      appliedAt: true,
      contextBindings: true,
      inputHash: true,
      recoverableUntil: true,
      sourceMessageContentHash: true,
      sourceMessageId: true
    },
    where: {
      executionBindingId: bindingId,
      memoryJobId: job.id,
      userId: job.userId
    }
  });
  const source = input.messages.find((message) =>
    message.evidenceEligible && message.id === input.source.sourceMessageId);
  const output = parseStagedOutput(staged?.acceptedOutput);
  if (
    !staged || !source || !output || staged.appliedAt !== null ||
    staged.recoverableUntil <= now ||
    staged.inputHash !== input.inputHash ||
    staged.sourceMessageId !== source.id ||
    staged.sourceMessageContentHash !== source.contentHash ||
    memorySha256(staged.contextBindings) !== memorySha256(contextBindings(input))
  ) return null;
  const plan: MemoryFactExtractionPlan = {
    ...output,
    input,
    outputHash: staged.acceptedOutputHash
  };
  return planIsValid(plan) ? plan : null;
}

/** Page 0 shares the one semantic call per source message with relation
 * resolution. A continuation page owns its own call, keyed by its job and
 * recorded without the message key that budget uses. */
function adjudicationSourceMessageId(job: MemoryJobDescriptor): string | null {
  const page = memoryFactExtractionJobIdentity(job)?.page;
  return page && page.ordinal > 0 ? null : job.sourceMessageId;
}

function adjudicationReservationWhere(job: MemoryJobDescriptor) {
  const sourceMessageId = adjudicationSourceMessageId(job);
  return sourceMessageId === null
    ? { ownerJobId: job.id, sourceMessageId: null, userId: job.userId }
    : { sourceMessageId, userId: job.userId };
}

async function reserveSemanticAdjudication(
  client: PrismaClient,
  job: MemoryJobDescriptor
): Promise<"ACQUIRED" | "RECOVERED" | "UNAVAILABLE"> {
  if (!memoryFactExtractionClaimIsValid(job) || job.sourceMessageId === null) {
    return "UNAVAILABLE";
  }
  const sourceMessageId = adjudicationSourceMessageId(job);
  return client.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`
      SELECT pg_advisory_xact_lock(hashtextextended(
        ${`aiqsa:memory:auxiliary:${job.userId}:${sourceMessageId ?? job.id}`}, 0
      ))::text AS "lock"
    `);
    const existing = await tx.memoryAuxiliarySemanticCall.findFirst({
      select: {
        completedAt: true,
        ownerJobId: true,
        purpose: true
      },
      where: adjudicationReservationWhere(job)
    });
    if (existing) {
      return existing.ownerJobId === job.id &&
        existing.purpose === "FACT_EXTRACTION_ADJUDICATION"
        ? existing.completedAt === null ? "ACQUIRED" : "RECOVERED"
        : "UNAVAILABLE";
    }
    await tx.memoryAuxiliarySemanticCall.create({
      data: {
        id: sourceMessageId === null
          ? memorySha256({
              domain: "aiqsa.memory.auxiliary-semantic-call",
              ownerJobId: job.id,
              userId: job.userId,
              version: 2
            })
          : memorySha256({
              domain: "aiqsa.memory.auxiliary-semantic-call",
              sourceMessageId,
              userId: job.userId,
              version: 1
            }),
        ownerJobId: job.id,
        purpose: "FACT_EXTRACTION_ADJUDICATION",
        sourceMessageId,
        userId: job.userId
      }
    });
    return "ACQUIRED";
  });
}

async function completeSemanticAdjudication(
  tx: MemoryTransaction,
  job: MemoryJobDescriptor,
  bindingId: string,
  packet: MemorySemanticAdjudicationPacket,
  now: Date
): Promise<void> {
  if (!memoryFactExtractionClaimIsValid(job) || job.sourceMessageId === null ||
    !Number.isFinite(now.getTime())) {
    throw new MemoryCoordinatorError("memory_semantic_adjudication_invalid", false);
  }
  const row = await tx.memoryAuxiliarySemanticCall.findFirst({
    select: {
      acceptedOutputHash: true,
      completedAt: true,
      createdAt: true,
      executionId: true,
      inputHash: true,
      result: true
    },
    where: {
      ownerJobId: job.id,
      purpose: "FACT_EXTRACTION_ADJUDICATION",
      sourceMessageId: adjudicationSourceMessageId(job),
      userId: job.userId
    }
  });
  if (!row) {
    throw new MemoryCoordinatorError("memory_semantic_adjudication_reservation_missing", true);
  }
  if (row.completedAt !== null) {
    const existing = decodeStoredMemorySemanticAdjudication(row.result);
    if (row.executionId !== bindingId || row.inputHash !== packet.inputHash ||
      row.acceptedOutputHash !== packet.outputHash ||
      memorySha256(existing) !== memorySha256(packet)) {
      throw new MemoryCoordinatorError("memory_semantic_adjudication_conflict", false);
    }
    return;
  }
  const updated = await tx.memoryAuxiliarySemanticCall.updateMany({
    data: {
      acceptedOutputHash: packet.outputHash,
      completedAt: new Date(Math.max(now.getTime(), row.createdAt.getTime())),
      executionId: bindingId,
      inputHash: packet.inputHash,
      result: encodeStoredMemorySemanticAdjudication(packet) as Prisma.InputJsonObject
    },
    where: {
      completedAt: null,
      ownerJobId: job.id,
      purpose: "FACT_EXTRACTION_ADJUDICATION",
      sourceMessageId: adjudicationSourceMessageId(job),
      userId: job.userId
    }
  });
  if (updated.count !== 1) {
    throw new MemoryCoordinatorError("memory_semantic_adjudication_conflict", true);
  }
}

export async function invalidateMemoryFactExtractionStaging(
  tx: MemoryTransaction,
  input: Readonly<{
    chatId?: string;
    memoryJobId?: string;
    reasonCode: string;
    sourceMessageIds?: readonly string[];
    userId: string;
  }>,
  now: Date
): Promise<number> {
  const jobIds = input.chatId
    ? (await tx.memoryJob.findMany({
        select: { id: true },
        where: {
          chatId: input.chatId,
          kind: "EXTRACT_FACTS",
          userId: input.userId
        }
      })).map(({ id }) => id)
    : null;
  const executions = await tx.memoryFactExtractionExecution.findMany({
    select: { id: true },
    where: {
      appliedAt: null,
      ...(input.memoryJobId ? { memoryJobId: input.memoryJobId } : {}),
      ...(jobIds ? { memoryJobId: { in: jobIds } } : {}),
      ...(input.sourceMessageIds
        ? { sourceMessageId: { in: [...input.sourceMessageIds] } }
        : {}),
      userId: input.userId
    }
  });
  if (executions.length === 0) return 0;
  const executionIds = executions.map(({ id }) => id);
  await tx.memoryFactExtractionCandidateReceipt.updateMany({
    data: {
      outcome: "STALE",
      reasonCode: input.reasonCode,
      updatedAt: now
    },
    where: {
      extractionExecutionId: { in: executionIds },
      outcome: "PENDING",
      userId: input.userId
    }
  });
  return tx.$executeRaw(Prisma.sql`
    UPDATE "MemoryFactExtractionExecution"
    SET
      "acceptedOutput" = NULL,
      "contextBindings" = NULL,
      "appliedAt" = GREATEST("createdAt", ${now})
    WHERE "userId" = ${input.userId}
      AND "id" IN (${Prisma.join(executionIds)})
      AND "appliedAt" IS NULL
  `);
}

async function rejectCandidate(
  tx: MemoryTransaction,
  userId: string,
  receiptIdValue: string,
  reasonCode: string,
  now: Date
): Promise<void> {
  const updated = await tx.memoryFactExtractionCandidateReceipt.updateMany({
    data: { outcome: "REJECTED", reasonCode, updatedAt: now },
    where: { id: receiptIdValue, outcome: "PENDING", userId }
  });
  if (updated.count !== 1) {
    throw new MemoryCoordinatorError("memory_fact_candidate_state_conflict", true);
  }
}

function deterministicCandidateFailure(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  return error.message === "memory_dependency_source_invalid" ||
    error.message === "memory_dependency_source_stale" ||
    error.message === "memory_fact_candidate_invalid"
    ? error.message
    : null;
}

async function resultingIds(
  tx: MemoryTransaction,
  userId: string,
  identity: Readonly<{ evidenceFingerprint: string } | { id: string }>
): Promise<Readonly<{
  evidenceId: string;
  factId: string;
  factVersionId: string;
}> | null> {
  const evidence = await tx.memoryEvidence.findFirst({
    select: { factVersionId: true, id: true },
    where: { ...identity, userId }
  });
  if (!evidence) return null;
  const version = await tx.memoryFactVersion.findFirst({
    select: { factId: true },
    where: { id: evidence.factVersionId, userId }
  });
  return version ? {
    evidenceId: evidence.id,
    factId: version.factId,
    factVersionId: evidence.factVersionId
  } : null;
}

/** Enqueues the page that continues coverage of this job's source message.
 * It is written in the transaction that settles this page, so a settled page
 * never loses its tail and a replay of the page enqueues nothing new. Every
 * later page revalidates source, deletion, suppression, pause and generation
 * fences before any provider call, so an edited or forgotten source stops. */
async function continueMemoryFactCoverage(
  tx: MemoryTransaction,
  settings: LockedMemorySettings,
  claim: MemoryJobDescriptor,
  input: MemoryFactExtractionInput,
  coverageEnd?: number
): Promise<void> {
  if (!memoryFactExtractionClaimIsValid(claim) ||
    input.source.userId !== claim.userId ||
    input.source.sourceMessageId !== claim.sourceMessageId) {
    throw new MemoryCoordinatorError("memory_fact_plan_invalid", false);
  }
  const next = memoryFactNextPage(input, coverageEnd);
  const identity = memoryFactExtractionJobIdentity(claim);
  if (!next || !identity || !settings.useMemoryFacts ||
    !settings.learnAutomatically ||
    settings.memoryGeneration !== claim.memoryGenerationSnapshot) return;
  const source = {
    activeLeafMessageId: claim.activeLeafMessageId,
    branchGeneration: claim.branchGeneration,
    chatId: claim.chatId,
    sourceHash: claim.sourceHash,
    sourceMessageId: claim.sourceMessageId,
    sourceRevision: claim.sourceRevision
  };
  await enqueueMemoryJob(tx, settings, {
    idempotencyFingerprint: memoryFactExtractionJobFingerprint(
      {
        ...source,
        memoryGenerationSnapshot: claim.memoryGenerationSnapshot,
        userId: claim.userId
      },
      identity.identityProfile,
      next
    ),
    kind: "EXTRACT_FACTS",
    pipelineVersion: claim.pipelineVersion,
    source
  });
}

async function applyPlan(
  tx: MemoryTransaction,
  settings: LockedMemorySettings,
  claim: MemoryJobClaim,
  plan: MemoryFactExtractionPlan,
  bindingId: string,
  keyring: MemorySuppressionKeyring,
  now: Date,
  adjudication: MemorySemanticAdjudicationPacket | null = null,
  authorityBindingId: string = bindingId
): Promise<"APPLIED" | "EMPTY" | "STALE"> {
  if (
    !memoryFactExtractionClaimIsValid(claim) ||
    plan.input.source.userId !== claim.userId ||
    !planIsValid(plan)
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
  const staged = await tx.memoryFactExtractionExecution.findFirst({
    select: { appliedAt: true, createdAt: true, id: true },
    where: {
      acceptedOutputHash: plan.outputHash,
      executionBindingId: bindingId,
      inputHash: plan.input.inputHash,
      memoryJobId: claim.id,
      userId: claim.userId
    }
  });
  if (!staged || staged.appliedAt !== null) {
    throw new MemoryCoordinatorError("memory_fact_stage_missing", true);
  }
  if (!settings.useMemoryFacts || !settings.learnAutomatically ||
    settings.memoryGeneration !== claim.memoryGenerationSnapshot) {
    await invalidateMemoryFactExtractionStaging(tx, {
      memoryJobId: claim.id,
      reasonCode: "source_stale",
      userId: claim.userId
    }, now);
    return "STALE";
  }
  const current = await prepareWith(tx, claim, now);
  if (
    "decision" in current ||
    (current.input.inputHash !== plan.input.inputHash &&
      !onlyAddsUnreferencedFactContext(plan, current.input, adjudication))
  ) {
    await invalidateMemoryFactExtractionStaging(tx, {
      memoryJobId: claim.id,
      reasonCode: "source_stale",
      userId: claim.userId
    }, now);
    return "STALE";
  }

  const decisions = new Map(
    adjudication?.decisions.map((decision) => [decision.candidateRef, decision]) ?? []
  );
  if (adjudication && (
    decisions.size !== adjudication.decisions.length ||
    !memorySemanticAdjudicationPacketIsValid(plan, adjudication)
  )) {
    throw new MemoryCoordinatorError("memory_semantic_adjudication_invalid", false);
  }

  // A replacement already closes its exact old version through relation
  // resolution. A second observation withdrawing that same version must not
  // destroy the comparison target while the replacement is still pending.
  // Preserve source ordinals, but apply withdrawals after other observations.
  const candidateEntries = [...plan.candidates.entries()].sort((left, right) =>
    Number(decisions.get(left[1].candidateRef)?.operation === "RETRACT_TARGET") -
    Number(decisions.get(right[1].candidateRef)?.operation === "RETRACT_TARGET"));
  const replacementTargets = new Set<string>();
  for (const [index, candidate] of candidateEntries) {
    const candidateOrdinal = plan.candidateOrdinals[index]!;
    const receipt = await tx.memoryFactExtractionCandidateReceipt.findFirst({
      select: { id: true, outcome: true },
      where: {
        candidateOrdinal,
        extractionExecutionId: staged.id,
        userId: claim.userId
      }
    });
    if (!receipt) {
      throw new MemoryCoordinatorError("memory_fact_candidate_receipt_missing", true);
    }
    if (receipt.outcome !== "PENDING") continue;
    const semanticDecision = decisions.get(candidate.candidateRef) ?? null;
    if (!memorySemanticAuthorityAdmitsCandidate(
      candidate,
      semanticDecision,
      plan.input.contextRefs
    ) ||
      (memoryCandidateRequiresSemanticAdjudication(
        candidate,
        plan.input.contextRefs
      ) &&
        semanticDecision === null)) {
      await rejectCandidate(
        tx,
        claim.userId,
        receipt.id,
        "semantic_not_admitted",
        now
      );
      continue;
    }
    if (candidate.scope.type !== "GLOBAL_USER" || candidate.scope.targetId !== null) {
      await rejectCandidate(tx, claim.userId, receipt.id, "scope_not_admitted", now);
      continue;
    }
    if (memoryAutomaticCandidateContainsSecret(candidate)) {
      await rejectCandidate(tx, claim.userId, receipt.id, "secret_fenced", now);
      continue;
    }
    if (semanticDecision?.operation === "RETRACT_TARGET" &&
      semanticDecision.targetRef !== null &&
      replacementTargets.has(semanticDecision.targetRef)) {
      await rejectCandidate(
        tx, claim.userId, receipt.id, "withdrawal_replaced_in_packet", now
      );
      continue;
    }
    await tx.$executeRawUnsafe("SAVEPOINT memory_fact_candidate_apply");
    try {
      const adjudicatedEntityId = semanticDecision?.entityRef === null ||
        semanticDecision?.entityRef === undefined
        ? null
        : plan.input.contextRefs.find(({ ref }) =>
            ref === semanticDecision.entityRef)?.entityId ?? null;
      // A pure withdrawal consumes the exact adjudicated current target. It
      // must not create or merge an entity merely to represent a cancellation.
      const materializedCandidate = candidate.semanticFrame.polarity === "RETRACTION" &&
        candidate.semanticFrame.changeIntent === "RETRACTION"
        ? candidate
        : await materializeMemoryCandidateEntityIdentity(
            tx,
            {
              adjudicatedEntityId,
              candidate,
              userId: claim.userId
            }
          );
      if (await candidateIsSuppressed(
        tx,
        keyring,
        plan.input,
        materializedCandidate
      )) {
        await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT memory_fact_candidate_apply");
        await tx.$executeRawUnsafe("RELEASE SAVEPOINT memory_fact_candidate_apply");
        await rejectCandidate(tx, claim.userId, receipt.id, "suppressed", now);
        continue;
      }
      const evidence = materializedCandidate.evidence[0];
      if (!evidence) {
        throw new Error("memory_fact_candidate_invalid");
      }
      const fingerprint = memoryFactEvidenceFingerprint(
        plan.input,
        materializedCandidate,
        evidence
      );
      const before = await resultingIds(tx, claim.userId, { evidenceFingerprint: fingerprint });
      const committed = await commitMemoryVNextExtractionPlan(
        tx,
        settings,
        claim,
        {
          ...plan,
          candidateOrdinals: [candidateOrdinal],
          candidates: [materializedCandidate],
          rejections: []
        },
        authorityBindingId,
        now,
        semanticDecision
      );
      // This call commits one candidate. A same-message replay may refer to
      // an earlier immutable support with a different quote fingerprint.
      const replayedEvidenceIds = committed.replayedEvidenceIds ?? [];
      if (replayedEvidenceIds.length > 1) throw new Error("memory_fact_replay_result_invalid");
      const resultingEvidenceId = committed.resultingEvidenceId ?? replayedEvidenceIds[0];
      const result = before ?? await resultingIds(tx, claim.userId,
        resultingEvidenceId
          ? { id: resultingEvidenceId }
          : { evidenceFingerprint: fingerprint });
      if (!result) {
        await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT memory_fact_candidate_apply");
        await tx.$executeRawUnsafe("RELEASE SAVEPOINT memory_fact_candidate_apply");
        await rejectCandidate(
          tx,
          claim.userId,
          receipt.id,
          committed.reasonCode ?? "repository_guarded_noop",
          now
        );
        continue;
      }
      const outcome = before
        ? "REPLAY"
        : committed.receiptOutcome ??
        (committed.createdVersions > 0
          ? "APPLIED"
          : committed.attachedEvidence > 0
            ? "REINFORCED"
            : "REPLAY");
      const updated = await tx.memoryFactExtractionCandidateReceipt.updateMany({
        data: {
          outcome,
          // Successful receipts carry the outcome and exact result IDs;
          // the schema reserves reasonCode for rejected/stale work.
          reasonCode: null,
          resultingEvidenceId: result.evidenceId,
          resultingFactId: result.factId,
          resultingFactVersionId: result.factVersionId,
          updatedAt: now
        },
        where: { id: receipt.id, outcome: "PENDING", userId: claim.userId }
      });
      if (updated.count !== 1) {
        throw new MemoryCoordinatorError(
          "memory_fact_candidate_state_conflict",
          true
        );
      }
      await tx.$executeRawUnsafe("RELEASE SAVEPOINT memory_fact_candidate_apply");
      if (committed.createdVersions > 0 && semanticDecision?.targetRef &&
        (semanticDecision.operation === "SUPERSEDE_TARGET" ||
          semanticDecision.operation === "MOVE_TO_DISTINCT_FACT")) {
        replacementTargets.add(semanticDecision.targetRef);
      }
    } catch (error) {
      await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT memory_fact_candidate_apply");
      await tx.$executeRawUnsafe("RELEASE SAVEPOINT memory_fact_candidate_apply");
      const reasonCode = deterministicCandidateFailure(error);
      if (!reasonCode) throw error;
      await rejectCandidate(tx, claim.userId, receipt.id, reasonCode, now);
    }
  }

  const pending = await tx.memoryFactExtractionCandidateReceipt.count({
    where: {
      extractionExecutionId: staged.id,
      outcome: "PENDING",
      userId: claim.userId
    }
  });
  if (pending !== 0) {
    throw new MemoryCoordinatorError("memory_fact_candidate_outcome_incomplete", true);
  }
  const applied = await tx.memoryFactExtractionCandidateReceipt.count({
    where: {
      extractionExecutionId: staged.id,
      outcome: { in: [...terminalApplyOutcomes] as Array<
        "APPLIED" | "MERGED" | "REINFORCED" | "REPLAY" | "SUPERSEDED"
      > },
      userId: claim.userId
    }
  });
  const cleared = await tx.memoryFactExtractionExecution.updateMany({
    data: {
      acceptedOutput: Prisma.DbNull,
      appliedAt: new Date(Math.max(now.getTime(), staged.createdAt.getTime())),
      contextBindings: Prisma.DbNull
    },
    where: { appliedAt: null, id: staged.id, userId: claim.userId }
  });
  if (cleared.count !== 1) {
    throw new MemoryCoordinatorError("memory_fact_stage_state_conflict", true);
  }
  const marked = await tx.memoryJob.updateMany({
    data: {
      stage: applied > 0
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
  if (marked.count !== 1) {
    throw new MemoryCoordinatorError("memory_fact_job_state_conflict", true);
  }
  await continueMemoryFactCoverage(tx, settings, claim, plan.input, plan.coverageEnd);
  return applied > 0 ? "APPLIED" : "EMPTY";
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
    async auxiliary(
      job: MemoryJobDescriptor
    ): Promise<MemoryFactAuxiliarySemanticCall | null> {
      if (job.sourceMessageId === null) return null;
      return client.memoryAuxiliarySemanticCall.findFirst({
        select: {
          acceptedOutputHash: true,
          completedAt: true,
          executionId: true,
          inputHash: true,
          ownerJobId: true,
          purpose: true,
          result: true
        },
        where: adjudicationReservationWhere(job)
      });
    },
    apply(
      tx: MemoryTransaction,
      settings: LockedMemorySettings,
      claim: MemoryJobClaim,
      plan: MemoryFactExtractionPlan,
      bindingId: string,
      now: Date,
      adjudication: MemorySemanticAdjudicationPacket | null = null,
      authorityBindingId: string = bindingId
    ) {
      return applyPlan(
        tx,
        settings,
        claim,
        plan,
        bindingId,
        keyring(),
        now,
        adjudication,
        authorityBindingId
      );
    },
    async applied(
      job: MemoryJobDescriptor,
      bindingId: string
    ): Promise<"APPLIED" | "EMPTY" | null> {
      const marker = await client.memoryJob.findFirst({
        select: { stage: true },
        where: { id: job.id, userId: job.userId }
      });
      if (marker?.stage === "fact_observations_applied") return "APPLIED";
      if (marker?.stage === "fact_observations_empty_applied") return "EMPTY";
      const execution = await client.memoryFactExtractionExecution.findFirst({
        select: { appliedAt: true, id: true },
        where: {
          executionBindingId: bindingId,
          memoryJobId: job.id,
          userId: job.userId
        }
      });
      if (!execution?.appliedAt) return null;
      const receipts = await client.memoryFactExtractionCandidateReceipt.findMany({
        select: { outcome: true },
        where: {
          extractionExecutionId: execution.id,
          userId: job.userId
        }
      });
      if (receipts.some(({ outcome }) =>
        outcome === "PENDING" || outcome === "STALE" ||
        outcome === "RETRYABLE_FAILED")) return null;
      return receipts.some(({ outcome }) => terminalApplyOutcomes.has(outcome))
        ? "APPLIED"
        : "EMPTY";
    },
    bindings(userId: string, memoryJobId: string): Promise<MemoryFactExecutionBinding[]> {
      return client.memoryExecutionBinding.findMany({
        orderBy: [{ ordinal: "asc" }, { id: "asc" }],
        select: {
          acceptedOutputHash: true,
          errorCode: true,
          id: true,
          inputHash: true,
          ordinal: true,
          pipelineVersion: true,
          policyVersion: true,
          promptVersion: true,
          schemaVersion: true,
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
    completeAdjudication(
      tx: MemoryTransaction,
      job: MemoryJobDescriptor,
      bindingId: string,
      packet: MemorySemanticAdjudicationPacket,
      now: Date
    ): Promise<void> {
      return completeSemanticAdjudication(tx, job, bindingId, packet, now);
    },
    /** Continues coverage after a page that settled without applying a
     * plan; runs inside the coordinator's guarded job commit. */
    async continueCoverage(
      tx: MemoryTransaction,
      claim: MemoryJobDescriptor,
      input: MemoryFactExtractionInput
    ): Promise<void> {
      const settings = await lockMemorySettings(tx, claim.userId, false);
      await continueMemoryFactCoverage(tx, settings, claim, input);
    },
    discardStale(job: MemoryJobDescriptor, reasonCode: string): Promise<number> {
      return client.$transaction((tx) => invalidateMemoryFactExtractionStaging(
        tx,
        { memoryJobId: job.id, reasonCode, userId: job.userId },
        new Date()
      ), {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead
      });
    },
    prepare(job: MemoryJobDescriptor): Promise<PrepareResult> {
      return client.$transaction(async (tx) => {
        const now = new Date();
        const prepared = await prepareWith(tx, job, now);
        if ("decision" in prepared) {
          await invalidateMemoryFactExtractionStaging(tx, {
            memoryJobId: job.id,
            reasonCode: "source_stale",
            userId: job.userId
          }, now);
        }
        return prepared;
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead
      });
    },
    preflight(job: MemoryJobDescriptor): Promise<MemoryJobGateDecision> {
      return client.$transaction(async (tx) => {
        const now = new Date();
        const decision = await probeWith(tx, job, now);
        if (decision.status !== "READY") {
          await invalidateMemoryFactExtractionStaging(tx, {
            memoryJobId: job.id,
            reasonCode: "source_stale",
            userId: job.userId
          }, now);
        }
        return decision;
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead
      });
    },
    reserveAdjudication(
      job: MemoryJobDescriptor
    ): Promise<"ACQUIRED" | "RECOVERED" | "UNAVAILABLE"> {
      return reserveSemanticAdjudication(client, job);
    },
    stage(
      tx: MemoryTransaction,
      job: MemoryJobDescriptor,
      plan: MemoryFactExtractionPlan,
      bindingId: string,
      recoverableUntil: Date
    ): Promise<void> {
      return stagePlan(tx, job, plan, bindingId, recoverableUntil);
    },
    staged(
      job: MemoryJobDescriptor,
      bindingId: string,
      input: MemoryFactExtractionInput,
      now: Date
    ): Promise<MemoryFactExtractionPlan | null> {
      return loadStagedPlan(client, job, bindingId, input, now);
    }
  });
}

export type MemoryFactExtractionRepository = ReturnType<
  typeof createPrismaMemoryFactExtractionRepository
>;

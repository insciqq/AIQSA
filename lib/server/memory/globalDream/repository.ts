import { randomUUID } from "node:crypto";
import {
  Prisma,
  type MemoryExecutionState,
  type PrismaClient
} from "@prisma/client";
import { prisma } from "../../prisma";
import type {
  MemoryJobClaim,
  MemoryJobDescriptor,
  MemoryJobGateDecision
} from "../coordinator/types";
import type { MemoryExecutionAuthorityDependencies } from "../execution";
import {
  loadMemoryExecutionBinding,
  parseMemoryExecutionSnapshot,
  reauthorizeStoredMemoryExecution
} from "../execution";
import {
  MEMORY_ITEM_EMBEDDING_PIPELINE_VERSION,
  memoryItemEmbeddingJobFingerprint
} from "../embedding/contract";
import type {
  MemoryFactConsolidationPlan,
  MemoryFactVerificationPlan
} from "../learning/consolidation/contract";
import {
  memoryFactDecisionId,
  memoryFactConsolidationOutputHash,
  memoryFactVerificationInputHash,
  memoryFactVerificationOutputHash,
  type MemoryFactDecisionSnapshot,
  type MemoryFactVerificationInput
} from "../learning/consolidation/contract";
import { evaluateMemoryFactConsolidationPlan } from "../learning/consolidation/policy";
import { enqueueMemoryJob } from "../persistence/jobs";
import {
  memorySha256,
  normalizeMemorySearchText,
  normalizeMemorySearchTextYo
} from "../persistence/lexical";
import {
  advanceMemoryMutation,
  lockMemorySettings,
  requireActiveMemoryIndex,
  withLockedMemoryTransaction,
  type LockedMemorySettings,
  type MemoryTransaction
} from "../persistence/transaction";
import {
  loadMemorySuppressionKeyring,
  type MemorySuppressionKeyring
} from "../suppressionKeyring";
import {
  MEMORY_GLOBAL_DREAM_PIPELINE_VERSION,
  memoryGlobalDreamJobIsValid,
  parseMemoryGlobalDreamJobFingerprint,
  type MemoryGlobalDreamPrepared,
  type MemoryGlobalDreamSemanticSelection,
  type MemoryGlobalDreamSelection
} from "./contract";
import { prepareGlobalDreamDeferredSelection } from "./deferred";
import {
  loadGlobalDreamCurrentFact,
  prepareGlobalDreamLocalSelection,
  prepareGlobalDreamPairSelection
} from "./selection";

const disabledDecision = Object.freeze({
  errorCode: "memory_automatic_learning_disabled",
  status: "CANCELLED" as const
});
const invalidDecision = Object.freeze({
  errorCode: "memory_global_dream_job_invalid",
  status: "CANCELLED" as const
});
const staleDecision = Object.freeze({
  errorCode: "memory_global_dream_snapshot_stale",
  status: "STALE" as const
});

export type MemoryGlobalDreamExecutionBinding = Readonly<{
  acceptedOutputHash: string | null;
  id: string;
  inputHash: string;
  ordinal: number;
  state: MemoryExecutionState;
}>;

function configuredKeyring(): MemorySuppressionKeyring {
  const configured = loadMemorySuppressionKeyring();
  if (configured.status !== "ready") {
    throw new Error("memory_suppression_keyring_unavailable");
  }
  return configured.keyring;
}

async function prepareSelection(
  tx: MemoryTransaction,
  settings: LockedMemorySettings,
  job: MemoryJobDescriptor,
  keyring: MemorySuppressionKeyring,
  now: Date
): Promise<MemoryGlobalDreamPrepared> {
  if (!memoryGlobalDreamJobIsValid(job)) return { decision: invalidDecision };
  if (!settings.learnAutomatically) return { decision: disabledDecision };
  if (settings.memoryGeneration !== job.memoryGenerationSnapshot) {
    return { decision: staleDecision };
  }
  const identity = parseMemoryGlobalDreamJobFingerprint(
    job.idempotencyFingerprint
  );
  if (!identity) return { decision: invalidDecision };
  let selection: MemoryGlobalDreamSelection | null = null;
  if (identity.kind === "RETRACT_INVALID" || identity.kind === "EXPIRE_TEMPORAL") {
    selection = await prepareGlobalDreamLocalSelection(tx, keyring, settings, {
      factId: identity.factId,
      kind: identity.kind,
      now
    });
  } else if (identity.kind === "RECONCILE_PAIR") {
    selection = await prepareGlobalDreamPairSelection(tx, keyring, settings, {
      now,
      sourceFactId: identity.sourceFactId,
      targetFactId: identity.targetFactId
    });
  } else if (identity.kind === "REVISIT_DEFERRED") {
    selection = await prepareGlobalDreamDeferredSelection(tx, keyring, settings, {
      candidateId: identity.candidateId,
      now
    });
  }
  return selection && selection.snapshotHash.startsWith(identity.snapshotPrefix)
    ? { selection }
    : { decision: staleDecision };
}

export async function reconcileGlobalDreamJobs(
  _client: PrismaClient = prisma,
  options: Readonly<{
    keyring?: () => MemorySuppressionKeyring;
    limit?: number;
    now?: Date;
  }> = {}
): Promise<number> {
  const now = options.now ? new Date(options.now) : new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("memory_global_dream_clock_invalid");
  if (
    options.limit !== undefined &&
    (!Number.isSafeInteger(options.limit) || options.limit < 1)
  ) throw new Error("memory_global_dream_limit_invalid");
  // Global Dream discovery was a second semantic reconciliation layer. The
  // normal path now uses only candidate consolidation; existing queued jobs
  // are settled by the coordinator's retired legacy handler.
  return 0;
}

export function createPrismaMemoryGlobalDreamRepository(
  authority: MemoryExecutionAuthorityDependencies,
  client: PrismaClient = prisma,
  options: Readonly<{
    keyring?: () => MemorySuppressionKeyring;
    now?: () => Date;
  }> = {}
) {
  const keyring = options.keyring ?? configuredKeyring;
  const now = options.now ?? (() => new Date());

  function bindings(
    userId: string,
    jobId: string,
    role: "MEMORY_CONSOLIDATE" | "MEMORY_VERIFY"
  ): Promise<MemoryGlobalDreamExecutionBinding[]> {
    return client.memoryExecutionBinding.findMany({
      orderBy: [{ ordinal: "asc" }, { id: "asc" }],
      select: {
        acceptedOutputHash: true,
        id: true,
        inputHash: true,
        ordinal: true,
        state: true
      },
      where: {
        logicalRole: role,
        memoryJobId: jobId,
        ownerType: "JOB",
        userId
      }
    });
  }

  return Object.freeze({
    apply(
      tx: MemoryTransaction,
      claim: MemoryJobClaim,
      expected: MemoryGlobalDreamSelection,
      consolidation: Readonly<{
        bindingId: string;
        plan: MemoryFactConsolidationPlan;
      }> | null,
      verification: Readonly<{
        bindingId: string;
        plan: MemoryFactVerificationPlan;
      }> | null,
      appliedAt: Date
    ): Promise<void> {
      return applyGlobalDreamSelection(
        tx,
        authority,
        keyring(),
        claim,
        expected,
        consolidation,
        verification,
        appliedAt
      );
    },
    consolidationBindings(userId: string, jobId: string) {
      return bindings(userId, jobId, "MEMORY_CONSOLIDATE");
    },
    prepare(job: MemoryJobDescriptor): Promise<MemoryGlobalDreamPrepared> {
      return withLockedMemoryTransaction(client, job.userId, (tx, settings) =>
        prepareSelection(tx, settings, job, keyring(), now()));
    },
    preflight(job: MemoryJobDescriptor): Promise<MemoryJobGateDecision> {
      return withLockedMemoryTransaction(client, job.userId, async (tx, settings) => {
        const prepared = await prepareSelection(tx, settings, job, keyring(), now());
        return "decision" in prepared ? prepared.decision : { status: "READY" };
      });
    },
    verificationBindings(userId: string, jobId: string) {
      return bindings(userId, jobId, "MEMORY_VERIFY");
    }
  });
}

export type MemoryGlobalDreamRepository = ReturnType<
  typeof createPrismaMemoryGlobalDreamRepository
>;

async function applyGlobalDreamSelection(
  tx: MemoryTransaction,
  authority: MemoryExecutionAuthorityDependencies,
  keyring: MemorySuppressionKeyring,
  claim: MemoryJobClaim,
  expected: MemoryGlobalDreamSelection,
  consolidation: Readonly<{
    bindingId: string;
    plan: MemoryFactConsolidationPlan;
  }> | null,
  verification: Readonly<{
    bindingId: string;
    plan: MemoryFactVerificationPlan;
  }> | null,
  appliedAt: Date
): Promise<void> {
  if (!Number.isFinite(appliedAt.getTime())) {
    throw new Error("memory_global_dream_clock_invalid");
  }
  const settings = await lockMemorySettings(tx, claim.userId, true);
  const prepared = await prepareSelection(
    tx,
    settings,
    claim,
    keyring,
    appliedAt
  );
  if (
    "decision" in prepared ||
    prepared.selection.kind !== expected.kind ||
    prepared.selection.snapshotHash !== expected.snapshotHash ||
    prepared.selection.resultHash !== expected.resultHash
  ) return;
  const selection = prepared.selection;
  if (selection.kind === "RETRACT_INVALID" || selection.kind === "EXPIRE_TEMPORAL") {
    if (consolidation || verification) return;
    await applyLocalSelection(tx, settings, claim, selection, appliedAt);
    return;
  }
  if (!consolidation) return;
  const plan = consolidation.plan;
  if (!validConsolidationPlan(selection, plan)) return;
  await requireAuthorizedBinding(tx, settings, authority, {
    acceptedOutputHash: plan.outputHash,
    bindingId: consolidation.bindingId,
    inputHash: selection.input.inputHash,
    jobId: claim.id,
    now: appliedAt,
    role: "MEMORY_CONSOLIDATE"
  });
  const policy = evaluateMemoryFactConsolidationPlan(selection.input, plan);
  if (policy.status === "DEFER") {
    await deferRevisitedCandidate(
      tx,
      settings.userId,
      selection,
      policy.reasonCode
    );
    return;
  }
  const requiresVerification = policy.requiresVerification || selection.scopeChanged;
  if (requiresVerification) {
    if (!verification) return;
    const verificationInput = buildVerificationInput(selection, plan);
    if (!validVerificationPlan(verificationInput, verification.plan)) return;
    await requireAuthorizedBinding(tx, settings, authority, {
      acceptedOutputHash: verification.plan.outputHash,
      bindingId: verification.bindingId,
      inputHash: verificationInput.inputHash,
      jobId: claim.id,
      now: appliedAt,
      role: "MEMORY_VERIFY"
    });
    if (verification.plan.verdict !== "APPROVE") {
      await deferRevisitedCandidate(
        tx,
        settings.userId,
        selection,
        `verification_${verification.plan.verdict.toLowerCase()}`
      );
      return;
    }
  }
  if (plan.operation === "NOOP" || plan.operation === "DEFER") {
    await settleRevisitedCandidateDisposition(
      tx,
      claim,
      selection,
      plan,
      appliedAt
    );
    return;
  }
  if (selection.kind === "RECONCILE_PAIR") {
    await applyAuthorizedGlobalDreamPairSelection(
      tx,
      settings,
      claim,
      selection,
      plan,
      consolidation.bindingId,
      verification?.bindingId ?? null,
      appliedAt
    );
    return;
  }
  if (verification) {
    await applyDeferredSelection(
      tx,
      settings,
      claim,
      selection,
      plan,
      consolidation.bindingId,
      verification.bindingId,
      verification.plan,
      appliedAt
    );
  }
}

type SemanticSelection = Extract<
  MemoryGlobalDreamSelection,
  { kind: "RECONCILE_PAIR" | "REVISIT_DEFERRED" }
>;

const consolidationReason = Object.freeze({
  ADD: "new_supported_fact",
  CONFLICT: "simultaneous_contradiction",
  DEFER: "insufficient_support",
  EXPIRE: "direct_end_evidence",
  NOOP: "duplicate_or_explicit",
  REINFORCE: "same_current_value",
  SUPERSEDE: "direct_newer_evidence"
} as const);

function validConsolidationPlan(
  selection: SemanticSelection,
  plan: MemoryFactConsolidationPlan
): boolean {
  const { outputHash: _outputHash, ...withoutHash } = plan;
  if (
    memoryFactConsolidationOutputHash(selection.input, withoutHash) !==
      plan.outputHash ||
    consolidationReason[plan.operation] !== plan.reasonCode ||
    plan.candidateId !== selection.input.candidate.id ||
    plan.evidenceIds.length !== selection.input.candidate.evidence.length ||
    plan.evidenceIds.some((id, index) =>
      id !== selection.input.candidate.evidence[index]?.messageId) ||
    (plan.operation === "SUPERSEDE"
      ? plan.effectiveFrom !== selection.input.candidate.validFrom
      : plan.effectiveFrom !== null)
  ) return false;
  if (["ADD", "DEFER", "NOOP"].includes(plan.operation)) {
    return plan.targetFactId === null && plan.targetVersionId === null;
  }
  const target = plan.targetFactId
    ? selection.input.relatedFacts.find(({ id }) => id === plan.targetFactId)
    : null;
  return Boolean(
    target && plan.targetVersionId &&
    target.currentVersionId === plan.targetVersionId && target.state === "ACTIVE" &&
    target.versions.some(({ id, state }) =>
      id === plan.targetVersionId && state === "ACTIVE")
  );
}

function buildVerificationInput(
  selection: SemanticSelection,
  plan: MemoryFactConsolidationPlan
): MemoryFactVerificationInput {
  const decision: MemoryFactDecisionSnapshot = {
    consolidationInputHash: selection.input.inputHash,
    consolidationOutputHash: plan.outputHash,
    id: memoryFactDecisionId(selection.input, plan),
    operation: plan.operation,
    reasonCode: plan.reasonCode,
    relatedSnapshotHash: selection.input.relatedSnapshotHash,
    requiresVerification: true,
    targetFactId: plan.targetFactId,
    targetVersionId: plan.targetVersionId
  };
  const target = plan.targetFactId
    ? selection.input.relatedFacts.find(({ id }) => id === plan.targetFactId) ?? null
    : null;
  const withoutHash: Omit<MemoryFactVerificationInput, "inputHash"> = {
    candidate: selection.input.candidate,
    decision,
    target
  };
  return {
    ...withoutHash,
    inputHash: memoryFactVerificationInputHash(withoutHash)
  };
}

function validVerificationPlan(
  input: MemoryFactVerificationInput,
  plan: MemoryFactVerificationPlan
): boolean {
  const { outputHash: _outputHash, ...withoutHash } = plan;
  return plan.candidateId === input.candidate.id &&
    plan.decisionId === input.decision.id &&
    (plan.verdict === "APPROVE") === (plan.reasonCode === "supported_transition") &&
    memoryFactVerificationOutputHash(input, withoutHash) === plan.outputHash;
}

async function requireAuthorizedBinding(
  tx: MemoryTransaction,
  settings: LockedMemorySettings,
  authority: MemoryExecutionAuthorityDependencies,
  input: Readonly<{
    acceptedOutputHash: string;
    bindingId: string;
    inputHash: string;
    jobId: string;
    now: Date;
    role: "MEMORY_CONSOLIDATE" | "MEMORY_VERIFY";
  }>
): Promise<void> {
  const binding = await loadMemoryExecutionBinding(tx, settings.userId, input.bindingId);
  if (
    binding.acceptedOutputHash !== input.acceptedOutputHash ||
    binding.inputHash !== input.inputHash || binding.logicalRole !== input.role ||
    binding.memoryJobId !== input.jobId || binding.ownerType !== "JOB" ||
    binding.state !== "SUCCEEDED" || binding.relationsDetachedAt !== null
  ) throw new Error("memory_global_dream_binding_stale");
  const snapshot = parseMemoryExecutionSnapshot(binding.secretFreeExecutionSnapshot);
  await reauthorizeStoredMemoryExecution(tx, settings, {
    dependencies: authority,
    now: input.now,
    snapshot,
    userId: settings.userId
  });
}

async function deferRevisitedCandidate(
  tx: MemoryTransaction,
  userId: string,
  selection: SemanticSelection,
  reasonCode: string
): Promise<void> {
  if (selection.kind !== "REVISIT_DEFERRED") return;
  await tx.memoryCandidate.updateMany({
    data: {
      reasonCode: `global_dream_${reasonCode}`.slice(0, 64),
      resolvedAt: null,
      state: "DEFERRED"
    },
    where: {
      id: selection.input.candidate.id,
      state: "DEFERRED",
      userId
    }
  });
}

async function settleRevisitedCandidateDisposition(
  tx: MemoryTransaction,
  claim: MemoryJobClaim,
  selection: SemanticSelection,
  plan: MemoryFactConsolidationPlan,
  now: Date
): Promise<void> {
  if (selection.kind !== "REVISIT_DEFERRED") return;
  if (plan.operation === "DEFER") {
    await deferRevisitedCandidate(
      tx,
      claim.userId,
      selection,
      "insufficient_support"
    );
    return;
  }
  if (plan.operation !== "NOOP") return;
  const updated = await tx.memoryCandidate.updateMany({
    data: {
      reasonCode: "global_dream_noop",
      resolvedAt: now,
      state: "REJECTED"
    },
    where: {
      id: selection.input.candidate.id,
      state: "DEFERRED",
      userId: claim.userId
    }
  });
  if (updated.count !== 1) return;
}

function transitionAt(now: Date, ...prior: Array<Date | null>): Date {
  return new Date(Math.max(
    now.getTime(),
    ...prior.map((value) => (value?.getTime() ?? -1) + 1)
  ));
}

async function hasExplicitAuthority(
  tx: MemoryTransaction,
  userId: string,
  factIds: readonly string[]
): Promise<boolean> {
  return (await tx.memoryFactVersion.count({
    where: {
      factId: { in: [...factIds] },
      sourceMode: "EXPLICIT",
      userId
    }
  })) > 0;
}

async function enqueueWorkingSet(
  tx: MemoryTransaction,
  settings: LockedMemorySettings,
  input: Readonly<{
    factId: string;
    jobId: string;
    operation: string;
  }>
): Promise<void> {
  if (!settings.useMemoryFacts) return;
  await enqueueMemoryJob(tx, settings, {
    idempotencyFingerprint: `recalculate-working-set:${memorySha256({
      factId: input.factId,
      globalDreamJobId: input.jobId,
      memoryRevision: settings.memoryRevision,
      operation: input.operation,
      version: 1
    })}`,
    kind: "RECALCULATE_WORKING_SET",
    pipelineVersion: MEMORY_GLOBAL_DREAM_PIPELINE_VERSION
  });
}

async function applyLocalSelection(
  tx: MemoryTransaction,
  settings: LockedMemorySettings,
  claim: MemoryJobClaim,
  selection: Extract<
    MemoryGlobalDreamSelection,
    { kind: "EXPIRE_TEMPORAL" | "RETRACT_INVALID" }
  >,
  now: Date
): Promise<void> {
  const fact = await loadGlobalDreamCurrentFact(
    tx,
    settings.userId,
    selection.factId,
    "UPDATE"
  );
  if (
    !fact || fact.currentVersionId !== selection.versionId || fact.pinned ||
    fact.sourceMode !== "AUTOMATIC" ||
    await hasExplicitAuthority(tx, settings.userId, [fact.factId])
  ) return;
  await advanceMemoryMutation(tx, settings, "AUTOMATIC_VERSION_TRANSITION");
  const index = await requireActiveMemoryIndex(tx, settings);
  if (!index) throw new Error("memory_active_generation_invalid");
  const at = transitionAt(now, fact.systemFrom);
  const eventId = randomUUID();
  await tx.memoryEvent.create({
    data: {
      actorType: "JOB",
      factId: fact.factId,
      factVersionId: fact.currentVersionId,
      id: eventId,
      metadata: {
        globalDreamJobId: claim.id,
        reason: selection.kind === "RETRACT_INVALID"
          ? "all_source_evidence_invalid"
          : "explicit_valid_to_elapsed",
        schemaVersion: "memory-global-dream-event-v1",
        snapshotHash: selection.snapshotHash
      },
      operation: selection.kind === "RETRACT_INVALID" ? "RETRACT" : "EXPIRE",
      userId: settings.userId
    }
  });
  const version = await tx.memoryFactVersion.updateMany({
    data: {
      state: selection.kind === "RETRACT_INVALID" ? "RETRACTED" : "EXPIRED",
      systemTo: at
    },
    where: {
      factId: fact.factId,
      id: fact.currentVersionId,
      sourceMode: "AUTOMATIC",
      state: "ACTIVE",
      systemTo: null,
      userId: settings.userId
    }
  });
  const logical = await tx.memoryFact.updateMany({
    data: {
      currentVersionId: null,
      state: selection.kind === "RETRACT_INVALID" ? "RETRACTED" : "EXPIRED"
    },
    where: {
      currentVersionId: fact.currentVersionId,
      id: fact.factId,
      movedToFactId: null,
      state: "ACTIVE",
      userId: settings.userId
    }
  });
  if (version.count !== 1 || logical.count !== 1) {
    throw new Error("memory_global_dream_local_stale");
  }
  await tx.memorySearchEntry.deleteMany({
    where: {
      factVersionId: fact.currentVersionId,
      indexGenerationId: index.id,
      userId: settings.userId
    }
  });
  await enqueueWorkingSet(tx, settings, {
    factId: fact.factId,
    jobId: claim.id,
    operation: selection.kind
  });
}

type CopiedEvidence = Readonly<{
  branchGeneration: number | null;
  chatId: string | null;
  id: string;
  messageId: string | null;
  observedAt: Date;
  safeExcerpt: string;
  safeSourceHash: string;
  safetyClass: "HIGHLY_SENSITIVE" | "NORMAL" | "SECRET" | "SENSITIVE";
  sourceProjectionVersion: string;
  sourceRole: string | null;
  sourceType: "EPISODE" | "EXPLICIT_ACTION" | "MESSAGE";
}>;

async function loadPairEvidence(
  tx: MemoryTransaction,
  userId: string,
  versionId: string,
  evidenceIds: readonly string[]
): Promise<readonly CopiedEvidence[] | null> {
  const evidence = await tx.memoryEvidence.findMany({
    orderBy: { id: "asc" },
    select: {
      branchGeneration: true,
      chatId: true,
      id: true,
      messageId: true,
      observedAt: true,
      safeExcerpt: true,
      safeSourceHash: true,
      safetyClass: true,
      sourceProjectionVersion: true,
      sourceRole: true,
      sourceType: true
    },
    where: {
      factVersionId: versionId,
      id: { in: [...evidenceIds] },
      sourceType: "MESSAGE",
      stance: "SUPPORTS",
      userId
    }
  });
  if (
    evidence.length !== evidenceIds.length ||
    evidence.some((item) =>
      item.sourceType !== "MESSAGE" || item.sourceRole !== "user" ||
      item.safetyClass !== "NORMAL" || !item.chatId || !item.messageId ||
      item.branchGeneration === null)
  ) return null;
  return evidence;
}

async function copyPairEvidence(
  tx: MemoryTransaction,
  userId: string,
  versionId: string,
  evidence: readonly CopiedEvidence[]
): Promise<void> {
  await tx.memoryEvidence.createMany({
    data: evidence.map((item) => ({
      branchGeneration: item.branchGeneration,
      chatId: item.chatId,
      factVersionId: versionId,
      messageId: item.messageId,
      observedAt: item.observedAt,
      safeExcerpt: item.safeExcerpt,
      safeSourceHash: item.safeSourceHash,
      safetyClass: "NORMAL" as const,
      sourceProjectionVersion: item.sourceProjectionVersion,
      sourceRole: "user",
      sourceType: "MESSAGE" as const,
      stance: "SUPPORTS" as const,
      userId
    })),
    skipDuplicates: true
  });
}

async function createSemanticSearchEntry(
  tx: MemoryTransaction,
  settings: LockedMemorySettings,
  input: Readonly<{
    content?: Readonly<{
      canonicalKey: string;
      category: string;
      displayText: string;
      languageCode: string;
      structuredValue: unknown;
    }>;
    eventId: string;
    retrievable: boolean;
    selection: MemoryGlobalDreamSemanticSelection;
    versionId: string;
  }>
): Promise<void> {
  const index = await requireActiveMemoryIndex(tx, settings);
  if (!index) throw new Error("memory_active_generation_invalid");
  const candidate = input.selection.input.candidate;
  const content = input.content ?? {
    canonicalKey: candidate.canonicalKey,
    category: candidate.category,
    displayText: candidate.displayText,
    languageCode: candidate.languageCode,
    structuredValue: candidate.proposedValue
  };
  const safeSearchText = normalizeMemorySearchText(content.displayText);
  const entry = await tx.memorySearchEntry.create({
    data: {
      embeddingState: input.retrievable && index.indexMode === "HYBRID"
        ? "PENDING"
        : "NOT_APPLICABLE",
      factVersionId: input.versionId,
      indexGenerationId: index.id,
      itemType: "FACT_VERSION",
      languageCode: content.languageCode,
      safeContentHash: memorySha256({
        displayText: content.displayText,
        structuredValue: content.structuredValue
      }),
      safeSearchText,
      safeSearchTextYoNormalized: normalizeMemorySearchTextYo(content.displayText),
      safetyIdentitySnapshot: memorySha256({
        safetyClass: "NORMAL",
        secretTaintedSourceWindow: false
      }),
      sourceIdentitySnapshot: memorySha256({
        globalDreamSnapshotHash: input.selection.snapshotHash,
        sourceEvidenceIds: input.selection.sourceEvidenceIds,
        sourceVersionId: input.selection.sourceVersionId,
        version: 1
      }),
      suppressionIdentitySnapshot: memorySha256({
        canonicalKey: content.canonicalKey,
        category: content.category,
        normalizedValue: safeSearchText
      }),
      userId: settings.userId
    },
    select: { embeddingState: true, id: true }
  });
  if (entry.embeddingState === "PENDING") {
    await enqueueMemoryJob(tx, settings, {
      idempotencyFingerprint: memoryItemEmbeddingJobFingerprint(
        entry.id,
        input.eventId
      ),
      kind: "EMBED_ITEMS",
      pipelineVersion: MEMORY_ITEM_EMBEDDING_PIPELINE_VERSION
    });
  }
}

async function createDeferredEvidence(
  tx: MemoryTransaction,
  userId: string,
  versionId: string,
  selection: Extract<MemoryGlobalDreamSelection, { kind: "REVISIT_DEFERRED" }>,
  stance: "CONTRADICTS" | "SUPPORTS"
): Promise<void> {
  const candidate = selection.input.candidate;
  await tx.memoryEvidence.createMany({
    data: candidate.evidence.map((evidence) => ({
      branchGeneration: candidate.branchGeneration,
      chatId: candidate.chatId,
      factVersionId: versionId,
      messageId: evidence.messageId,
      observedAt: new Date(evidence.observedAt),
      safeExcerpt: evidence.quote,
      safeSourceHash: evidence.sourceTextHash,
      safetyClass: "NORMAL" as const,
      sourceProjectionVersion: candidate.sourceProjectionVersion,
      sourceRole: "user",
      sourceType: "MESSAGE" as const,
      stance,
      userId
    })),
    skipDuplicates: true
  });
}

async function applyDeferredSelection(
  tx: MemoryTransaction,
  settings: LockedMemorySettings,
  claim: MemoryJobClaim,
  selection: Extract<MemoryGlobalDreamSelection, { kind: "REVISIT_DEFERRED" }>,
  plan: MemoryFactConsolidationPlan,
  consolidationExecutionId: string,
  verificationExecutionId: string,
  verificationPlan: MemoryFactVerificationPlan,
  now: Date
): Promise<void> {
  if (
    plan.targetFactId !== selection.targetFactId ||
    plan.targetVersionId !== selection.targetVersionId ||
    (plan.operation !== "CONFLICT" && plan.operation !== "EXPIRE" &&
      plan.operation !== "REINFORCE" && plan.operation !== "SUPERSEDE")
  ) return;
  const target = await loadGlobalDreamCurrentFact(
    tx,
    settings.userId,
    selection.targetFactId,
    "UPDATE"
  );
  if (
    !target || target.pinned || target.sourceMode !== "AUTOMATIC" ||
    target.currentVersionId !== selection.targetVersionId ||
    await hasExplicitAuthority(tx, settings.userId, [target.factId])
  ) return;
  await advanceMemoryMutation(tx, settings, "AUTOMATIC_VERSION_TRANSITION");
  const index = await requireActiveMemoryIndex(tx, settings);
  if (!index) throw new Error("memory_active_generation_invalid");
  const candidate = selection.input.candidate;
  const at = transitionAt(now, target.systemFrom);
  const eventId = randomUUID();
  const newVersionId = plan.operation === "REINFORCE" || plan.operation === "EXPIRE"
    ? target.currentVersionId
    : randomUUID();
  await tx.memoryEvent.create({
    data: {
      actorType: "JOB",
      factId: target.factId,
      factVersionId: newVersionId,
      id: eventId,
      metadata: {
        candidateId: candidate.id,
        consolidationExecutionId,
        globalDreamJobId: claim.id,
        schemaVersion: "memory-global-dream-event-v1",
        snapshotHash: selection.snapshotHash,
        verificationExecutionId,
        verificationOutputHash: verificationPlan.outputHash
      },
      operation: plan.operation,
      sourceChatId: candidate.chatId,
      sourceGeneration: candidate.branchGeneration,
      userId: settings.userId
    }
  });
  if (plan.operation === "REINFORCE") {
    await createDeferredEvidence(
      tx,
      settings.userId,
      target.currentVersionId,
      selection,
      "SUPPORTS"
    );
    const confirmedAt = new Date(Math.max(
      target.lastConfirmedAt?.getTime() ?? -1,
      ...candidate.evidence.map(({ observedAt }) => new Date(observedAt).getTime())
    ));
    const updated = await tx.memoryFact.updateMany({
      data: { lastConfirmedAt: confirmedAt },
      where: {
        currentVersionId: target.currentVersionId,
        id: target.factId,
        state: "ACTIVE",
        userId: settings.userId
      }
    });
    if (updated.count !== 1) throw new Error("memory_global_dream_target_stale");
  } else if (plan.operation === "EXPIRE") {
    const observedEnd = new Date(Math.max(...candidate.evidence.map(({ observedAt }) =>
      new Date(observedAt).getTime())));
    const version = await tx.memoryFactVersion.updateMany({
      data: {
        state: "EXPIRED",
        systemTo: at,
        validTo: !target.validFrom || observedEnd > target.validFrom
          ? observedEnd
          : target.validTo
      },
      where: {
        factId: target.factId,
        id: target.currentVersionId,
        sourceMode: "AUTOMATIC",
        state: "ACTIVE",
        systemTo: null,
        userId: settings.userId
      }
    });
    const fact = await tx.memoryFact.updateMany({
      data: { currentVersionId: null, state: "EXPIRED" },
      where: {
        currentVersionId: target.currentVersionId,
        id: target.factId,
        state: "ACTIVE",
        userId: settings.userId
      }
    });
    if (version.count !== 1 || fact.count !== 1) {
      throw new Error("memory_global_dream_target_stale");
    }
    await createDeferredEvidence(
      tx,
      settings.userId,
      target.currentVersionId,
      selection,
      "CONTRADICTS"
    );
  } else {
    const nextTargetState = plan.operation === "SUPERSEDE"
      ? "SUPERSEDED" as const
      : "CONFLICTING" as const;
    const priorValidTo = plan.operation === "SUPERSEDE" && plan.effectiveFrom &&
        (!target.validFrom || new Date(plan.effectiveFrom) > target.validFrom)
      ? new Date(plan.effectiveFrom)
      : target.validTo;
    const version = await tx.memoryFactVersion.updateMany({
      data: {
        state: nextTargetState,
        ...(plan.operation === "SUPERSEDE"
          ? { systemTo: at, validTo: priorValidTo }
          : {})
      },
      where: {
        factId: target.factId,
        id: target.currentVersionId,
        state: "ACTIVE",
        systemTo: null,
        userId: settings.userId
      }
    });
    if (version.count !== 1) throw new Error("memory_global_dream_target_stale");
    await tx.memoryFactVersion.create({
      data: {
        category: candidate.category,
        confidence: candidate.confidence,
        createdByEventId: eventId,
        directness: "DIRECT",
        displayText: candidate.displayText,
        factId: target.factId,
        id: newVersionId,
        importance: candidate.importance,
        languageCode: candidate.languageCode,
        modality: candidate.modality,
        normalizedSearchText: normalizeMemorySearchText(candidate.displayText),
        pipelineVersion: MEMORY_GLOBAL_DREAM_PIPELINE_VERSION,
        rawTemporalExpression: candidate.rawTemporalExpression,
        sensitivityClass: "NORMAL",
        sourceMode: "AUTOMATIC",
        sourceTimezone: candidate.sourceTimezone,
        state: plan.operation === "SUPERSEDE" ? "ACTIVE" : "CONFLICTING",
        structuredValue: candidate.proposedValue === null
          ? Prisma.JsonNull
          : candidate.proposedValue as Prisma.InputJsonValue,
        supersedesVersionId: plan.operation === "SUPERSEDE"
          ? target.currentVersionId
          : null,
        systemFrom: at,
        temporalResolutionEvidence: candidate.temporalResolutionEvidence === null
          ? Prisma.DbNull
          : candidate.temporalResolutionEvidence as Prisma.InputJsonValue,
        temporalResolverVersion: candidate.temporalResolverVersion,
        userId: settings.userId,
        validFrom: candidate.validFrom ? new Date(candidate.validFrom) : null,
        validTo: candidate.validTo ? new Date(candidate.validTo) : null
      }
    });
    await createDeferredEvidence(
      tx,
      settings.userId,
      newVersionId,
      selection,
      "SUPPORTS"
    );
    const fact = await tx.memoryFact.updateMany({
      data: plan.operation === "SUPERSEDE"
        ? {
            category: candidate.category,
            currentVersionId: newVersionId,
            lastConfirmedAt: new Date(Math.max(...candidate.evidence.map(({ observedAt }) =>
              new Date(observedAt).getTime()))),
            state: "ACTIVE"
          }
        : { currentVersionId: null, state: "CONFLICTED" },
      where: {
        currentVersionId: target.currentVersionId,
        id: target.factId,
        state: "ACTIVE",
        userId: settings.userId
      }
    });
    if (fact.count !== 1) throw new Error("memory_global_dream_target_stale");
  }
  if (plan.operation === "EXPIRE" || plan.operation === "SUPERSEDE") {
    await tx.memorySearchEntry.deleteMany({
      where: {
        factVersionId: target.currentVersionId,
        indexGenerationId: index.id,
        userId: settings.userId
      }
    });
  }
  if (plan.operation === "CONFLICT" || plan.operation === "SUPERSEDE") {
    await createSemanticSearchEntry(tx, settings, {
      eventId,
      retrievable: plan.operation === "SUPERSEDE",
      selection,
      versionId: newVersionId
    });
  } else if (plan.operation === "REINFORCE") {
    const existing = await tx.memorySearchEntry.findFirst({
      select: { id: true },
      where: {
        factVersionId: target.currentVersionId,
        indexGenerationId: index.id,
        userId: settings.userId
      }
    });
    if (!existing) {
      await createSemanticSearchEntry(tx, settings, {
        content: target,
        eventId,
        retrievable: true,
        selection,
        versionId: target.currentVersionId
      });
    }
  }
  const promoted = await tx.memoryCandidate.updateMany({
    data: {
      reasonCode: "global_dream_applied",
      resolvedAt: now,
      resolvedFactId: target.factId,
      state: "PROMOTED"
    },
    where: {
      id: candidate.id,
      state: "DEFERRED",
      userId: settings.userId
    }
  });
  if (promoted.count !== 1) throw new Error("memory_global_dream_candidate_stale");
  await enqueueWorkingSet(tx, settings, {
    factId: target.factId,
    jobId: claim.id,
    operation: `REVISIT_${plan.operation}`
  });
}

/**
 * Applies a pair plan only after the repository validates the exact selection,
 * policy, execution binding, and any required independent verification.
 */
export async function applyAuthorizedGlobalDreamPairSelection(
  tx: MemoryTransaction,
  settings: LockedMemorySettings,
  claim: MemoryJobClaim,
  selection: Extract<MemoryGlobalDreamSelection, { kind: "RECONCILE_PAIR" }>,
  plan: MemoryFactConsolidationPlan,
  consolidationExecutionId: string,
  verificationExecutionId: string | null,
  now: Date
): Promise<void> {
  if (
    !selection.sourceFactId || !selection.sourceVersionId ||
    !selection.targetFactId || !selection.targetVersionId ||
    (plan.operation !== "CONFLICT" && plan.operation !== "REINFORCE" &&
      plan.operation !== "SUPERSEDE") ||
    plan.targetFactId !== selection.targetFactId ||
    plan.targetVersionId !== selection.targetVersionId
  ) return;
  const orderedIds = [selection.sourceFactId, selection.targetFactId].sort();
  const first = await loadGlobalDreamCurrentFact(
    tx,
    settings.userId,
    orderedIds[0]!,
    "UPDATE"
  );
  const second = await loadGlobalDreamCurrentFact(
    tx,
    settings.userId,
    orderedIds[1]!,
    "UPDATE"
  );
  const source = selection.sourceFactId === orderedIds[0] ? first : second;
  const target = selection.targetFactId === orderedIds[0] ? first : second;
  if (
    !source || !target || source.pinned || target.pinned ||
    source.currentVersionId !== selection.sourceVersionId ||
    target.currentVersionId !== selection.targetVersionId ||
    source.sourceMode !== "AUTOMATIC" || target.sourceMode !== "AUTOMATIC" ||
    await hasExplicitAuthority(
      tx,
      settings.userId,
      [source.factId, target.factId]
    )
  ) return;
  const evidence = await loadPairEvidence(
    tx,
    settings.userId,
    source.currentVersionId,
    selection.sourceEvidenceIds
  );
  if (!evidence || evidence.length === 0) return;
  await advanceMemoryMutation(tx, settings, "AUTOMATIC_VERSION_TRANSITION");
  const index = await requireActiveMemoryIndex(tx, settings);
  if (!index) throw new Error("memory_active_generation_invalid");
  const at = transitionAt(now, source.systemFrom, target.systemFrom);
  const eventId = randomUUID();
  const newVersionId = plan.operation === "REINFORCE"
    ? target.currentVersionId
    : randomUUID();
  await tx.memoryEvent.create({
    data: {
      actorType: "JOB",
      factId: target.factId,
      factVersionId: newVersionId,
      id: eventId,
      metadata: {
        consolidationExecutionId,
        globalDreamJobId: claim.id,
        movedFromFactId: source.factId,
        movedFromVersionId: source.currentVersionId,
        schemaVersion: "memory-global-dream-event-v1",
        snapshotHash: selection.snapshotHash,
        verificationExecutionId
      },
      operation: plan.operation,
      sourceChatId: selection.input.candidate.chatId,
      sourceGeneration: selection.input.candidate.branchGeneration,
      userId: settings.userId
    }
  });
  if (plan.operation === "REINFORCE") {
    await copyPairEvidence(
      tx,
      settings.userId,
      target.currentVersionId,
      evidence
    );
    const confirmedAt = new Date(Math.max(
      target.lastConfirmedAt?.getTime() ?? -1,
      ...evidence.map(({ observedAt }) => observedAt.getTime())
    ));
    const updated = await tx.memoryFact.updateMany({
      data: { lastConfirmedAt: confirmedAt },
      where: {
        currentVersionId: target.currentVersionId,
        id: target.factId,
        state: "ACTIVE",
        userId: settings.userId
      }
    });
    if (updated.count !== 1) throw new Error("memory_global_dream_target_stale");
  } else {
    const nextTargetState = plan.operation === "SUPERSEDE"
      ? "SUPERSEDED" as const
      : "CONFLICTING" as const;
    const priorValidTo = plan.operation === "SUPERSEDE" && plan.effectiveFrom &&
        (!target.validFrom || new Date(plan.effectiveFrom) > target.validFrom)
      ? new Date(plan.effectiveFrom)
      : target.validTo;
    const transitioned = await tx.memoryFactVersion.updateMany({
      data: {
        state: nextTargetState,
        ...(plan.operation === "SUPERSEDE"
          ? { systemTo: at, validTo: priorValidTo }
          : {})
      },
      where: {
        factId: target.factId,
        id: target.currentVersionId,
        state: "ACTIVE",
        systemTo: null,
        userId: settings.userId
      }
    });
    if (transitioned.count !== 1) {
      throw new Error("memory_global_dream_target_stale");
    }
    await tx.memoryFactVersion.create({
      data: {
        category: source.category,
        confidence: source.confidence,
        createdByEventId: eventId,
        directness: source.directness,
        displayText: source.displayText,
        factId: target.factId,
        id: newVersionId,
        importance: source.importance,
        languageCode: source.languageCode,
        modality: source.modality,
        movedFromVersionId: source.currentVersionId,
        normalizedSearchText: normalizeMemorySearchText(source.displayText),
        pipelineVersion: MEMORY_GLOBAL_DREAM_PIPELINE_VERSION,
        rawTemporalExpression: source.rawTemporalExpression,
        sensitivityClass: "NORMAL",
        sourceMode: "AUTOMATIC",
        sourceTimezone: source.sourceTimezone,
        state: plan.operation === "SUPERSEDE" ? "ACTIVE" : "CONFLICTING",
        structuredValue: source.structuredValue as Prisma.InputJsonValue,
        supersedesVersionId: plan.operation === "SUPERSEDE"
          ? target.currentVersionId
          : null,
        systemFrom: at,
        temporalResolutionEvidence: source.temporalResolutionEvidence === null
          ? Prisma.DbNull
          : source.temporalResolutionEvidence as Prisma.InputJsonValue,
        temporalResolverVersion: source.temporalResolverVersion,
        userId: settings.userId,
        validFrom: source.validFrom,
        validTo: source.validTo
      }
    });
    await copyPairEvidence(tx, settings.userId, newVersionId, evidence);
    const targetUpdated = await tx.memoryFact.updateMany({
      data: plan.operation === "SUPERSEDE"
        ? {
            category: source.category,
            currentVersionId: newVersionId,
            lastConfirmedAt: new Date(Math.max(...evidence.map(({ observedAt }) =>
              observedAt.getTime()))),
            state: "ACTIVE"
          }
        : { currentVersionId: null, state: "CONFLICTED" },
      where: {
        currentVersionId: target.currentVersionId,
        id: target.factId,
        state: "ACTIVE",
        userId: settings.userId
      }
    });
    if (targetUpdated.count !== 1) {
      throw new Error("memory_global_dream_target_stale");
    }
  }
  const sourceVersion = await tx.memoryFactVersion.updateMany({
    data: { state: "RETRACTED", systemTo: at },
    where: {
      factId: source.factId,
      id: source.currentVersionId,
      sourceMode: "AUTOMATIC",
      state: "ACTIVE",
      systemTo: null,
      userId: settings.userId
    }
  });
  const sourceFact = await tx.memoryFact.updateMany({
    data: {
      currentVersionId: null,
      movedToFactId: target.factId,
      state: "RETRACTED"
    },
    where: {
      currentVersionId: source.currentVersionId,
      id: source.factId,
      movedToFactId: null,
      state: "ACTIVE",
      userId: settings.userId
    }
  });
  if (sourceVersion.count !== 1 || sourceFact.count !== 1) {
    throw new Error("memory_global_dream_source_stale");
  }
  await tx.memorySearchEntry.deleteMany({
    where: {
      factVersionId: {
        in: [
          source.currentVersionId,
          ...(plan.operation === "SUPERSEDE" ? [target.currentVersionId] : [])
        ]
      },
      indexGenerationId: index.id,
      userId: settings.userId
    }
  });
  if (plan.operation === "REINFORCE") {
    const existing = await tx.memorySearchEntry.findFirst({
      select: { id: true },
      where: {
        factVersionId: target.currentVersionId,
        indexGenerationId: index.id,
        userId: settings.userId
      }
    });
    if (!existing) {
      await createSemanticSearchEntry(tx, settings, {
        content: target,
        eventId,
        retrievable: true,
        selection,
        versionId: target.currentVersionId
      });
    }
  } else {
    await createSemanticSearchEntry(tx, settings, {
      eventId,
      retrievable: plan.operation === "SUPERSEDE",
      selection,
      versionId: newVersionId
    });
  }
  await enqueueWorkingSet(tx, settings, {
    factId: target.factId,
    jobId: claim.id,
    operation: plan.operation
  });
}

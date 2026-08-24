import { Prisma, type PrismaClient } from "@prisma/client";
import { detectMemoryTextLanguage } from "../history/language";
import type {
  MemoryJobClaim,
  MemoryJobDescriptor,
  MemoryJobGateDecision
} from "../coordinator/types";
import { ensureGlobalMemoryScope } from "../persistence/scopes";
import { memorySha256, normalizeMemorySearchText } from "../persistence/lexical";
import {
  advanceMemoryMutation,
  lockMemorySettings,
  type LockedMemorySettings,
  type MemoryTransaction
} from "../persistence/transaction";
import {
  decodeMemorySynthesisOutput,
  type MemorySynthesisOutput
} from "./contract";
import {
  memorySynthesisPatternAuthorityPredicate,
  memorySynthesisSourceAuthorityPredicate
} from "./eligibility";
import {
  buildMemorySynthesisPlan,
  memorySynthesisJobFingerprint,
  memorySynthesisPatternFingerprint,
  memorySynthesisSourceEligibilityHash,
  MEMORY_SYNTHESIS_MAX_SOURCES,
  MEMORY_SYNTHESIS_PIPELINE_VERSION,
  MEMORY_SYNTHESIS_POLICY_VERSION,
  type MemorySynthesisBoundSource,
  type MemorySynthesisPlan,
  type MemorySynthesisSource
} from "./policy";
import { memorySynthesisAcceptedOutputHash } from "./provider";

type SynthesisQueryClient = Pick<
  PrismaClient,
  "$queryRaw" | "userMemorySettings"
> | MemoryTransaction;

type SynthesisSourceRow = Readonly<{
  canonicalKey: string;
  category: string;
  directness: MemorySynthesisSource["directness"];
  displayText: string;
  entityIds: string[];
  factId: string;
  ingestionFingerprint: string | null;
  memoryGeneration: number;
  modality: MemorySynthesisSource["modality"];
  observedAt: Date;
  pipelineVersion: string;
  predicateKey: string | null;
  sourceChatIds: string[];
  sourceMessageIds: string[];
  sourceMode: MemorySynthesisSource["sourceMode"];
  structuredValue: Prisma.JsonValue;
  subjectKey: string | null;
  versionId: string;
}>;

export type MemorySynthesisSnapshot = Readonly<{
  plan: MemorySynthesisPlan | null;
  settings: Readonly<{
    memoryGeneration: number;
    memoryRevision: number;
    synthesisEnabled: boolean;
    synthesisEnabledAt: Date | null;
    synthesisPolicyVersion: string | null;
    useMemoryFacts: boolean;
  }>;
}>;

export type MemorySynthesisExecutionResult = Readonly<{
  acceptedOutputHash: string;
  executionId: string;
  inputHash: string;
  modelId: string;
  output: MemorySynthesisOutput;
  policyVersion: string;
  providerId: string;
}>;

type StagedExecution = MemorySynthesisExecutionResult & Readonly<{
  sourceSetFingerprint: string;
  sourceSnapshotHash: string;
}>;

function source(row: SynthesisSourceRow): MemorySynthesisSource {
  return Object.freeze({
    canonicalKey: row.canonicalKey,
    category: row.category,
    directness: row.directness,
    displayText: row.displayText,
    eligibilityHash: memorySynthesisSourceEligibilityHash({
      canonicalKey: row.canonicalKey,
      directness: row.directness,
      factId: row.factId,
      ingestionFingerprint: row.ingestionFingerprint,
      memoryGeneration: row.memoryGeneration,
      modality: row.modality,
      observedAt: row.observedAt,
      pipelineVersion: row.pipelineVersion,
      sourceMode: row.sourceMode,
      versionId: row.versionId
    }),
    entityIds: Object.freeze(row.entityIds),
    factId: row.factId,
    ingestionFingerprint: row.ingestionFingerprint,
    memoryGeneration: row.memoryGeneration,
    modality: row.modality,
    observedAt: row.observedAt,
    predicateKey: row.predicateKey,
    sourceChatIds: Object.freeze(row.sourceChatIds),
    sourceMessageIds: Object.freeze(row.sourceMessageIds),
    sourceMode: row.sourceMode,
    structuredValue: row.structuredValue,
    subjectKey: row.subjectKey,
    versionId: row.versionId
  });
}

async function loadSources(
  client: SynthesisQueryClient,
  userId: string
): Promise<readonly MemorySynthesisSource[]> {
  const rows = await client.$queryRaw<SynthesisSourceRow[]>(Prisma.sql`
    SELECT
      source_version."id" AS "versionId", source_version."factId",
      source_version."displayText", source_version."structuredValue",
      source_version."modality"::text AS "modality",
      source_version."sourceMode"::text AS "sourceMode",
      source_version."directness"::text AS "directness",
      source_version."observedAt", source_version."ingestionFingerprint",
      source_version."pipelineVersion", source_fact."canonicalKey",
      source_fact."category", source_fact."subjectKey", source_fact."predicateKey",
      settings."memoryGeneration",
      ARRAY(
        SELECT entity_link."entityId"
        FROM "MemoryFactVersionEntity" AS entity_link
        WHERE entity_link."userId" = source_version."userId"
          AND entity_link."factVersionId" = source_version."id"
        ORDER BY entity_link."entityId"
        LIMIT 16
      )::text[] AS "entityIds",
      ARRAY(
        SELECT DISTINCT evidence."chatId"
        FROM "MemoryEvidence" AS evidence
        WHERE evidence."userId" = source_version."userId"
          AND evidence."factVersionId" = source_version."id"
          AND evidence."stance" = 'SUPPORTS'::"MemoryEvidenceStance"
          AND evidence."chatId" IS NOT NULL
        ORDER BY evidence."chatId"
        LIMIT 16
      )::text[] AS "sourceChatIds",
      ARRAY(
        SELECT DISTINCT evidence."messageId"
        FROM "MemoryEvidence" AS evidence
        WHERE evidence."userId" = source_version."userId"
          AND evidence."factVersionId" = source_version."id"
          AND evidence."stance" = 'SUPPORTS'::"MemoryEvidenceStance"
          AND evidence."messageId" IS NOT NULL
        ORDER BY evidence."messageId"
        LIMIT 16
      )::text[] AS "sourceMessageIds"
    FROM "MemoryFactVersion" AS source_version
    INNER JOIN "MemoryFact" AS source_fact
      ON source_fact."userId" = source_version."userId"
     AND source_fact."id" = source_version."factId"
    INNER JOIN "MemoryScope" AS source_scope
      ON source_scope."userId" = source_fact."userId"
     AND source_scope."id" = source_fact."scopeId"
    INNER JOIN "UserMemorySettings" AS settings
      ON settings."userId" = source_version."userId"
    WHERE source_version."userId" = ${userId}
      AND settings."useMemoryFacts" = TRUE
      AND settings."synthesisEnabled" = TRUE
      AND ${memorySynthesisSourceAuthorityPredicate(userId)}
    ORDER BY source_version."observedAt" DESC, source_version."id"
    LIMIT ${MEMORY_SYNTHESIS_MAX_SOURCES * 2}
  `);
  return Object.freeze(rows.map(source));
}

export async function loadMemorySynthesisSnapshot(
  client: SynthesisQueryClient,
  userId: string
): Promise<MemorySynthesisSnapshot | null> {
  const settings = await client.userMemorySettings.findUnique({
    select: {
      memoryGeneration: true,
      memoryRevision: true,
      synthesisEnabled: true,
      synthesisEnabledAt: true,
      synthesisPolicyVersion: true,
      useMemoryFacts: true
    },
    where: { userId }
  });
  if (!settings) return null;
  if (!settings.useMemoryFacts || !settings.synthesisEnabled ||
    !settings.synthesisEnabledAt ||
    settings.synthesisPolicyVersion !== MEMORY_SYNTHESIS_POLICY_VERSION) {
    return { plan: null, settings };
  }
  const sources = await loadSources(client, userId);
  return {
    plan: buildMemorySynthesisPlan({
      boundary: settings.synthesisEnabledAt,
      generation: settings.memoryGeneration,
      sources
    }),
    settings
  };
}

function expectedJobFingerprint(userId: string, plan: MemorySynthesisPlan): string {
  return memorySynthesisJobFingerprint({
    sourceSetFingerprint: plan.sourceSetFingerprint,
    userId
  });
}

function validJob(job: MemoryJobDescriptor): boolean {
  return job.kind === "SYNTHESIZE_MEMORIES" &&
    job.pipelineVersion === MEMORY_SYNTHESIS_PIPELINE_VERSION &&
    job.chatId === null && job.sourceMessageId === null &&
    job.targetFactVersionId === null && job.activeLeafMessageId === null &&
    job.branchGeneration === null && job.sourceRevision === null &&
    job.sourceHash === null;
}

function gate(
  job: MemoryJobDescriptor,
  snapshot: MemorySynthesisSnapshot | null
): MemoryJobGateDecision {
  if (!validJob(job)) {
    return { errorCode: "memory_synthesis_job_invalid", status: "CANCELLED" };
  }
  if (!snapshot || !snapshot.settings.useMemoryFacts ||
    !snapshot.settings.synthesisEnabled || !snapshot.settings.synthesisEnabledAt) {
    return { errorCode: "memory_synthesis_disabled", status: "CANCELLED" };
  }
  if (snapshot.settings.memoryGeneration !== job.memoryGenerationSnapshot ||
    snapshot.settings.memoryRevision !== job.memoryRevisionSnapshot ||
    !snapshot.plan || expectedJobFingerprint(job.userId, snapshot.plan) !==
      job.idempotencyFingerprint) {
    return { errorCode: "memory_synthesis_snapshot_stale", status: "STALE" };
  }
  return { status: "READY" };
}

function sourceBindings(plan: MemorySynthesisPlan): Prisma.InputJsonValue {
  return plan.sources.map((entry) => ({
    eligibilityHash: entry.eligibilityHash,
    factId: entry.factId,
    ref: entry.ref,
    versionId: entry.versionId
  }));
}

function persistedOutput(output: MemorySynthesisOutput): Prisma.InputJsonValue {
  return {
    patterns: output.patterns.map((pattern) => ({
      confidence_band: pattern.confidenceBand,
      entity_refs: [...pattern.entityRefs],
      reason_code: pattern.reasonCode,
      source_refs: [...pattern.sourceRefs],
      statement: pattern.statement
    }))
  };
}

function stagedOutput(
  value: Prisma.JsonValue | null,
  plan: MemorySynthesisPlan
): MemorySynthesisOutput | null {
  if (!value) return null;
  try {
    return decodeMemorySynthesisOutput(value, plan);
  } catch {
    return null;
  }
}

function stagingMatches(
  staged: Readonly<{
    acceptedOutputHash: string;
    executionBindingId: string;
    inputHash: string;
    sourceSetFingerprint: string;
    sourceSnapshotHash: string;
  }>,
  plan: MemorySynthesisPlan,
  inputHash: string
): boolean {
  return staged.inputHash === inputHash &&
    staged.sourceSetFingerprint === plan.sourceSetFingerprint &&
    staged.sourceSnapshotHash === plan.sourceSnapshotHash &&
    /^[a-f0-9]{64}$/u.test(staged.acceptedOutputHash) &&
    Boolean(staged.executionBindingId);
}

async function loadStagedExecution(
  client: PrismaClient,
  job: MemoryJobDescriptor,
  plan: MemorySynthesisPlan,
  inputHash: string
): Promise<StagedExecution | null> {
  const row = await client.memorySynthesisExecution.findUnique({
    select: {
      acceptedOutput: true,
      acceptedOutputHash: true,
      executionBindingId: true,
      inputHash: true,
      sourceSetFingerprint: true,
      sourceSnapshotHash: true
    },
    where: { userId_memoryJobId: { memoryJobId: job.id, userId: job.userId } }
  });
  if (!row || !stagingMatches(row, plan, inputHash)) return null;
  const output = stagedOutput(row.acceptedOutput, plan);
  if (!output || row.acceptedOutputHash !==
    memorySynthesisAcceptedOutputHash(inputHash, output)) return null;
  const binding = await client.memoryExecutionBinding.findFirst({
    select: {
      policyVersion: true,
      providerId: true,
      providerModelId: true,
      state: true
    },
    where: {
      acceptedOutputHash: row.acceptedOutputHash,
      id: row.executionBindingId,
      inputHash,
      logicalRole: "MEMORY_SYNTHESIZE",
      memoryJobId: job.id,
      ownerType: "JOB",
      userId: job.userId
    }
  });
  if (!binding || binding.state !== "SUCCEEDED" || !binding.providerId ||
    !binding.providerModelId) return null;
  return {
    acceptedOutputHash: row.acceptedOutputHash,
    executionId: row.executionBindingId,
    inputHash,
    modelId: binding.providerModelId,
    output,
    policyVersion: binding.policyVersion,
    providerId: binding.providerId,
    sourceSetFingerprint: row.sourceSetFingerprint,
    sourceSnapshotHash: row.sourceSnapshotHash
  };
}

function patternIdentityKey(
  clusterKey: string,
  reasonCode: string,
  entityIds: readonly string[]
): string {
  return `prop:v1:${memorySha256({
    clusterKey,
    domain: "aiqsa.memory.pattern-identity",
    entityIds: [...entityIds].sort(),
    reasonCode,
    version: 1
  })}`;
}

function deterministicId(domain: string, fingerprint: string): string {
  return memorySha256({ domain, fingerprint, version: 1 });
}

function clusterFor(
  plan: MemorySynthesisPlan,
  sourceRefs: readonly string[]
) {
  return plan.clusters.find((cluster) => sourceRefs.every((ref) =>
    cluster.sources.some((source) => source.ref === ref))) ?? null;
}

async function retractCurrentPattern(
  tx: MemoryTransaction,
  userId: string,
  factId: string,
  versionId: string,
  now: Date
): Promise<void> {
  await tx.memorySearchEntry.deleteMany({ where: { factVersionId: versionId, userId } });
  await tx.memoryFactVersion.updateMany({
    data: {
      state: "RETRACTED",
      systemTo: now
    },
    where: { factId, id: versionId, state: "ACTIVE", userId }
  });
  await tx.memoryFact.updateMany({
    data: { currentVersionId: null, state: "RETRACTED" },
    where: { currentVersionId: versionId, id: factId, userId }
  });
  await tx.memoryEvent.create({
    data: {
      actorType: "JOB",
      factId,
      factVersionId: versionId,
      metadata: { reasonCode: "synthesis_source_set_replaced" },
      operation: "SOURCE_INVALIDATE",
      userId
    }
  });
}

export async function retractInvalidMemorySynthesisPatterns(
  tx: MemoryTransaction,
  settings: LockedMemorySettings,
  now: Date,
  limit = 32
): Promise<number> {
  if (!Number.isFinite(now.getTime()) || !Number.isSafeInteger(limit) ||
    limit < 1 || limit > 128) return 0;
  const rows = await tx.$queryRaw<Array<{ factId: string; versionId: string }>>(
    Prisma.sql`
      SELECT fact."id" AS "factId", version."id" AS "versionId"
      FROM "MemoryFactVersion" AS version
      INNER JOIN "MemoryFact" AS fact
        ON fact."userId" = version."userId"
       AND fact."id" = version."factId"
       AND fact."state" = 'ACTIVE'::"MemoryFactState"
       AND fact."currentVersionId" = version."id"
      INNER JOIN "MemoryScope" AS scope
        ON scope."userId" = fact."userId"
       AND scope."id" = fact."scopeId"
       AND scope."state" = 'ACTIVE'::"MemoryScopeState"
      INNER JOIN "UserMemorySettings" AS settings
        ON settings."userId" = version."userId"
      WHERE version."userId" = ${settings.userId}
        AND version."state" = 'ACTIVE'::"MemoryFactVersionState"
        AND version."systemTo" IS NULL
        AND version."modality" = 'PATTERN'::"MemoryFactModality"
        AND NOT (${memorySynthesisPatternAuthorityPredicate(settings.userId)})
      ORDER BY version."createdAt", version."id"
      LIMIT ${limit}
      FOR UPDATE OF fact, version SKIP LOCKED
    `
  );
  for (const row of rows) {
    await retractCurrentPattern(tx, settings.userId, row.factId, row.versionId, now);
  }
  if (rows.length > 0) {
    await advanceMemoryMutation(tx, settings, "SYNTHESIS_PATTERN_CHANGE");
  }
  return rows.length;
}

export function createPrismaMemorySynthesisRepository(
  client: PrismaClient
) {
  return Object.freeze({
    async snapshot(job: MemoryJobDescriptor): Promise<MemorySynthesisSnapshot | null> {
      return loadMemorySynthesisSnapshot(client, job.userId);
    },

    async preflight(job: MemoryJobDescriptor): Promise<MemoryJobGateDecision> {
      const decision = gate(job, await loadMemorySynthesisSnapshot(client, job.userId));
      if (decision.status !== "READY") {
        await client.$executeRaw(Prisma.sql`
          UPDATE "MemorySynthesisExecution"
          SET
            "acceptedOutput" = NULL,
            "sourceBindings" = NULL,
            "appliedAt" = GREATEST("createdAt", CURRENT_TIMESTAMP)
          WHERE "userId" = ${job.userId}
            AND "memoryJobId" = ${job.id}
            AND "appliedAt" IS NULL
        `);
      }
      return decision;
    },

    async staged(
      job: MemoryJobDescriptor,
      plan: MemorySynthesisPlan,
      inputHash: string
    ): Promise<StagedExecution | null> {
      return loadStagedExecution(client, job, plan, inputHash);
    },

    async stage(
      job: MemoryJobDescriptor,
      plan: MemorySynthesisPlan,
      result: MemorySynthesisExecutionResult
    ): Promise<void> {
      await client.memorySynthesisExecution.create({
        data: {
          acceptedOutput: persistedOutput(result.output),
          acceptedOutputHash: result.acceptedOutputHash,
          executionBindingId: result.executionId,
          inputHash: result.inputHash,
          memoryJobId: job.id,
          sourceBindings: sourceBindings(plan),
          sourceSetFingerprint: plan.sourceSetFingerprint,
          sourceSnapshotHash: plan.sourceSnapshotHash,
          userId: job.userId
        }
      }).catch(async (error) => {
        const replay = await loadStagedExecution(client, job, plan, result.inputHash);
        if (!replay || replay.acceptedOutputHash !== result.acceptedOutputHash ||
          replay.executionId !== result.executionId) throw error;
      });
    },

    async apply(
      tx: MemoryTransaction,
      claim: MemoryJobClaim,
      expectedPlan: MemorySynthesisPlan,
      result: MemorySynthesisExecutionResult,
      now: Date
    ): Promise<number> {
      const settings = await lockMemorySettings(tx, claim.userId, true);
      const snapshot = await loadMemorySynthesisSnapshot(tx, claim.userId);
      const plan = snapshot?.plan;
      if (!settings.useMemoryFacts || !settings.synthesisEnabled || !plan ||
        settings.memoryGeneration !== claim.memoryGenerationSnapshot ||
        settings.memoryRevision !== claim.memoryRevisionSnapshot ||
        plan.sourceSetFingerprint !== expectedPlan.sourceSetFingerprint ||
        plan.sourceSnapshotHash !== expectedPlan.sourceSnapshotHash ||
        expectedJobFingerprint(claim.userId, plan) !== claim.idempotencyFingerprint) {
        throw new Error("memory_synthesis_source_stale");
      }
      const scope = await ensureGlobalMemoryScope(tx, settings);
      const sourceByRef = new Map(plan.sources.map((entry) => [entry.ref, entry]));
      let applied = 0;
      for (const pattern of result.output.patterns) {
        const cluster = clusterFor(plan, pattern.sourceRefs);
        const sources = pattern.sourceRefs.map((ref) => sourceByRef.get(ref)).filter(
          (entry): entry is MemorySynthesisBoundSource => Boolean(entry)
        );
        if (!cluster || sources.length !== pattern.sourceRefs.length ||
          new Set(sources.map(({ factId }) => factId)).size < 3) {
          throw new Error("memory_synthesis_source_stale");
        }
        const normalized = normalizeMemorySearchText(pattern.statement);
        if (!normalized) continue;
        const proposedCanonicalKey = patternIdentityKey(
          cluster.key,
          pattern.reasonCode,
          pattern.entityRefs
        );
        let fact: Readonly<{
          canonicalKey: string;
          currentVersionId: string | null;
          id: string;
        }> | null = await tx.memoryFact.findFirst({
          select: { canonicalKey: true, currentVersionId: true, id: true },
          where: {
            canonicalKey: proposedCanonicalKey,
            scopeId: scope.id,
            userId: claim.userId
          }
        });
        if (!fact) {
          const duplicate = await tx.$queryRaw<Array<{
            canonicalKey: string;
            currentVersionId: string | null;
            id: string;
          }>>(Prisma.sql`
            SELECT fact."id", fact."canonicalKey", fact."currentVersionId"
            FROM "MemoryFact" AS fact
            INNER JOIN "MemoryFactVersion" AS version
              ON version."userId" = fact."userId"
             AND version."factId" = fact."id"
            WHERE fact."userId" = ${claim.userId}
              AND fact."scopeId" = ${scope.id}
              AND version."modality" = 'PATTERN'::"MemoryFactModality"
              AND version."normalizedSearchText" = ${normalized}
            ORDER BY
              (fact."currentVersionId" = version."id") DESC,
              version."createdAt" DESC,
              fact."id"
            LIMIT 1
            FOR UPDATE OF fact
          `);
          fact = duplicate[0] ?? null;
        }
        const canonicalPatternIdentity = fact?.canonicalKey ?? proposedCanonicalKey;
        const patternFingerprint = memorySynthesisPatternFingerprint({
          canonicalPatternIdentity,
          sourceSetFingerprint: plan.sourceSetFingerprint
        });
        const eventId = deterministicId(
          "aiqsa.memory.pattern-event",
          patternFingerprint
        );
        const versionId = deterministicId(
          "aiqsa.memory.pattern-version",
          patternFingerprint
        );
        const replay = await tx.memoryFactVersion.findFirst({
          select: { id: true },
          where: { id: versionId, userId: claim.userId }
        });
        if (replay) continue;
        const factId = fact?.id ?? deterministicId(
          "aiqsa.memory.pattern-fact",
          canonicalPatternIdentity
        );
        if (!fact) {
          fact = await tx.memoryFact.create({
            data: {
              canonicalKey: canonicalPatternIdentity,
              category: "patterns",
              id: factId,
              identityKind: "PROPOSITION",
              identityVersion: "proposition-v1",
              scopeId: scope.id,
              state: "ORPHANED",
              userId: claim.userId
            },
            select: { canonicalKey: true, currentVersionId: true, id: true }
          });
        } else if (fact.currentVersionId) {
          await retractCurrentPattern(
            tx,
            claim.userId,
            fact.id,
            fact.currentVersionId,
            now
          );
        }
        if (!fact) throw new Error("memory_synthesis_pattern_identity_unavailable");
        await tx.memoryEvent.create({
          data: {
            actorType: "JOB",
            factId: fact.id,
            factVersionId: versionId,
            id: eventId,
            metadata: {
              reasonCode: pattern.reasonCode,
              sourceCount: sources.length,
              sourceSetFingerprint: plan.sourceSetFingerprint
            },
            operation: "SYNTHESIZE",
            sourceGeneration: settings.memoryGeneration,
            userId: claim.userId
          }
        });
        await tx.memoryFactVersion.create({
          data: {
            category: "patterns",
            confidence: 0.8,
            coreEligible: false,
            coreSalience: "NONE",
            createdByEventId: eventId,
            directness: "INFERRED",
            displayText: pattern.statement,
            factId: fact.id,
            id: versionId,
            importance: 0.35,
            ingestionFingerprint: patternFingerprint,
            languageCode: detectMemoryTextLanguage(pattern.statement),
            modality: "PATTERN",
            normalizedSearchText: normalized,
            observedAt: now,
            pipelineVersion: MEMORY_SYNTHESIS_PIPELINE_VERSION,
            safetyClassificationState: "PENDING",
            sensitivityClass: "NORMAL",
            sourceMode: "AUTOMATIC",
            state: "ACTIVE",
            structuredValue: {
              kind: "pattern",
              reasonCode: pattern.reasonCode
            },
            synthesisDepth: 1,
            synthesisGeneration: settings.memoryGeneration,
            synthesisSourceSetFingerprint: plan.sourceSetFingerprint,
            userId: claim.userId
          }
        });
        await tx.memoryFactVersionRelation.createMany({
          data: sources.map((sourceEntry) => ({
            confidence: 1,
            executionId: result.executionId,
            id: deterministicId(
              "aiqsa.memory.pattern-source-relation",
              `${versionId}\u0000${sourceEntry.versionId}`
            ),
            kind: "SYNTHESIZED_FROM" as const,
            pipelineVersion: MEMORY_SYNTHESIS_PIPELINE_VERSION,
            reasonCode: pattern.reasonCode,
            sourceEligibilityHash: sourceEntry.eligibilityHash,
            sourceVersionId: versionId,
            targetVersionId: sourceEntry.versionId,
            userId: claim.userId
          })),
          skipDuplicates: true
        });
        await tx.memoryFact.update({
          data: {
            category: "patterns",
            currentVersionId: versionId,
            identityKind: "PROPOSITION",
            state: "ACTIVE"
          },
          where: { id: fact.id }
        });
        applied += 1;
      }
      await tx.userMemorySettings.update({
        data: {
          lastSynthesisAt: now,
          synthesisPolicyVersion: MEMORY_SYNTHESIS_POLICY_VERSION
        },
        where: { userId: claim.userId }
      });
      await tx.$executeRaw(Prisma.sql`
        UPDATE "MemorySynthesisExecution"
        SET
          "acceptedOutput" = NULL,
          "sourceBindings" = NULL,
          "appliedAt" = GREATEST("createdAt", ${now})
        WHERE "userId" = ${claim.userId}
          AND "memoryJobId" = ${claim.id}
          AND "executionBindingId" = ${result.executionId}
          AND "appliedAt" IS NULL
      `);
      if (applied > 0) {
        await advanceMemoryMutation(tx, settings, "SYNTHESIS_PATTERN_CHANGE");
      }
      return applied;
    }
  });
}

export type MemorySynthesisRepository = ReturnType<
  typeof createPrismaMemorySynthesisRepository
>;

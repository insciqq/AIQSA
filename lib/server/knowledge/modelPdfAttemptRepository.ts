import { decodeTokenUsage, normalizeTokenUsage, TOKEN_USAGE_FIELDS, type NormalizedTokenUsage } from "../../domain/usage";
import { loadProviderModelCostBasis, providerModelUsageCostMicros, storedTokenUsage } from "../usage";
import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { ModelRunUsage } from "../../domain/modelRunEvents";
import type { PdfModelProcessingMode } from "../parsing/pdfPreparation";
import type { ProviderExecutionSnapshot } from "../providers/runtimeFactory";

export class KnowledgeModelPdfAttemptError extends Error {
  constructor(readonly code: "pdf_processing_ambiguous" | "pdf_processing_state_invalid") {
    super(code);
    this.name = "KnowledgeModelPdfAttemptError";
  }
}

export type KnowledgeModelPdfAttemptIdentity = Readonly<{
  artifactId: string;
  batchIndex: number;
  mode: PdfModelProcessingMode;
  pageEnd: number;
  pageStart: number;
  processingGeneration: number;
  requestDigest: string;
  sourceVersionId: string;
}>;

export type SettledKnowledgeModelPdfBatch = KnowledgeModelPdfAttemptIdentity & Readonly<{
  attemptId: string;
  resultText: string;
  usage: ModelRunUsage;
}>;

function checksum(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function exactAttempt(
  attempt: Readonly<{
    batchIndex: number;
    mode: string;
    pageEnd: number;
    pageStart: number;
    processingGeneration: number;
    requestDigest: string;
    sourceArtifactId: string;
    sourceVersionId: string;
  }>,
  input: KnowledgeModelPdfAttemptIdentity
): boolean {
  return attempt.sourceArtifactId === input.artifactId &&
    attempt.sourceVersionId === input.sourceVersionId &&
    attempt.batchIndex === input.batchIndex && attempt.mode === input.mode &&
    attempt.pageStart === input.pageStart && attempt.pageEnd === input.pageEnd &&
    attempt.processingGeneration === input.processingGeneration &&
    attempt.requestDigest.trim() === input.requestDigest;
}

function decodedUsage(value: unknown): ModelRunUsage | null {
  const decoded = decodeTokenUsage(value);
  if (!decoded || typeof value !== "object" || value === null) return null;
  const data = value as Record<string, unknown>;
  const allowed = new Set<string>([...TOKEN_USAGE_FIELDS, "estimatedCostMicros", "completeness"]);
  if (Object.keys(data).some((key) => !allowed.has(key)) || (data.estimatedCostMicros != null &&
    (!Number.isSafeInteger(data.estimatedCostMicros) || Number(data.estimatedCostMicros) < 0))) return null;
  return { ...decoded, ...(data.estimatedCostMicros !== undefined
    ? { estimatedCostMicros: data.estimatedCostMicros as number | null } : {}) };
}

function settledBatch(
  attempt: Readonly<{
    batchIndex: number;
    id: string;
    mode: string;
    pageEnd: number;
    pageStart: number;
    processingGeneration: number;
    requestDigest: string;
    resultChecksum: string | null;
    resultText: string | null;
    sourceArtifactId: string;
    sourceVersionId: string;
    usage: unknown;
  }>
): SettledKnowledgeModelPdfBatch {
  const usage = decodedUsage(attempt.usage);
  if (!attempt.resultText || attempt.resultText.length > 500_000 ||
    attempt.resultChecksum?.trim() !== checksum(attempt.resultText) || !usage) {
    throw new KnowledgeModelPdfAttemptError("pdf_processing_state_invalid");
  }
  return {
    artifactId: attempt.sourceArtifactId,
    attemptId: attempt.id,
    batchIndex: attempt.batchIndex,
    mode: attempt.mode as PdfModelProcessingMode,
    pageEnd: attempt.pageEnd,
    pageStart: attempt.pageStart,
    processingGeneration: attempt.processingGeneration,
    requestDigest: attempt.requestDigest.trim(),
    resultText: attempt.resultText,
    sourceVersionId: attempt.sourceVersionId,
    usage
  };
}

type AttemptUsageInput = Readonly<{
  attemptId: string;
  ownerUserId: string;
  snapshot: ProviderExecutionSnapshot;
}>;

/** The attempt's one Knowledge indexing row: the provider-reported tokens,
 * priced at the deployment's stored prices (answer models report no cost). */
async function attemptUsageRow(
  tx: Pick<Prisma.TransactionClient, "providerModel">,
  input: AttemptUsageInput,
  usage: NormalizedTokenUsage
) {
  const estimatedCostMicros = providerModelUsageCostMicros({
    basis: await loadProviderModelCostBasis(tx, input.snapshot.providerModelId),
    reportedCostUsd: null,
    usage
  });
  return {
    ...storedTokenUsage(usage),
    estimatedCostMicros,
    knowledgePdfProcessingAttemptId: input.attemptId,
    modelId: input.snapshot.model.upstreamModelId,
    provider: input.snapshot.providerFamily,
    providerModelId: input.snapshot.providerModelId,
    purpose: "knowledge_indexing" as const,
    userId: input.ownerUserId
  };
}

export function createKnowledgeModelPdfAttemptRepository(prisma: PrismaClient) {
  /**
   * Usage of provider responses that never settle the attempt (rejected
   * output, a lost settle race): written at most once per attempt through the
   * same unique link a settled attempt's row uses, and never for a settled
   * attempt. Nothing reported means nothing is written.
   */
  async function recordUnsettledUsage(
    input: KnowledgeModelPdfAttemptIdentity & AttemptUsageInput & Readonly<{ usage: ModelRunUsage }>
  ): Promise<void> {
    const usage = normalizeTokenUsage(input.usage);
    if (usage.completeness === "unavailable") return;
    await prisma.$transaction(async (tx) => {
      const attempt = await tx.knowledgePdfProcessingAttempt.findUnique({ where: { id: input.attemptId } });
      if (!attempt || attempt.state === "settled" || !exactAttempt(attempt, input)) return;
      await tx.usageEvent.createMany({ data: [await attemptUsageRow(tx, input, usage)], skipDuplicates: true });
    });
  }

  return {
    recordUnsettledUsage,

    async markAmbiguous(attemptId: string, now: Date): Promise<void> {
      await prisma.knowledgePdfProcessingAttempt.updateMany({
        data: { state: "ambiguous", updatedAt: now },
        where: { id: attemptId, state: "dispatched" }
      });
    },

    async markDispatched(
      input: KnowledgeModelPdfAttemptIdentity & { attemptId: string; now: Date }
    ): Promise<boolean> {
      const updated = await prisma.knowledgePdfProcessingAttempt.updateMany({
        data: { dispatchedAt: input.now, state: "dispatched", updatedAt: input.now },
        where: {
          batchIndex: input.batchIndex,
          id: input.attemptId,
          mode: input.mode,
          pageEnd: input.pageEnd,
          pageStart: input.pageStart,
          processingGeneration: input.processingGeneration,
          requestDigest: input.requestDigest,
          sourceArtifactId: input.artifactId,
          sourceVersionId: input.sourceVersionId,
          state: "reserved"
        }
      });
      return updated.count === 1;
    },

    async reserve(
      input: KnowledgeModelPdfAttemptIdentity & { now: Date }
    ): Promise<Readonly<
      | { attemptId: string; kind: "dispatch" }
      | { batch: SettledKnowledgeModelPdfBatch; kind: "settled" }
    >> {
      const reservation = await prisma.$transaction(async (tx) => {
        const settled = await tx.knowledgePdfProcessingAttempt.findFirst({
          orderBy: { processingGeneration: "desc" },
          where: {
            batchIndex: input.batchIndex,
            mode: input.mode,
            pageEnd: input.pageEnd,
            pageStart: input.pageStart,
            requestDigest: input.requestDigest,
            sourceArtifactId: input.artifactId,
            sourceVersionId: input.sourceVersionId,
            state: "settled"
          }
        });
        if (settled) return { batch: settledBatch(settled), kind: "settled" as const };
        let attempt = await tx.knowledgePdfProcessingAttempt.findUnique({
          where: {
            sourceArtifactId_processingGeneration_batchIndex: {
              batchIndex: input.batchIndex,
              processingGeneration: input.processingGeneration,
              sourceArtifactId: input.artifactId
            }
          }
        });
        attempt ??= await tx.knowledgePdfProcessingAttempt.create({
          data: {
            batchIndex: input.batchIndex,
            mode: input.mode,
            pageEnd: input.pageEnd,
            pageStart: input.pageStart,
            processingGeneration: input.processingGeneration,
            requestDigest: input.requestDigest,
            sourceArtifactId: input.artifactId,
            sourceVersionId: input.sourceVersionId,
            state: "reserved",
            updatedAt: input.now
          }
        });
        if (!exactAttempt(attempt, input)) {
          throw new KnowledgeModelPdfAttemptError("pdf_processing_state_invalid");
        }
        if (attempt.state === "settled") {
          return { batch: settledBatch(attempt), kind: "settled" as const };
        }
        if (attempt.state !== "reserved") {
          if (attempt.state === "dispatched") {
            await tx.knowledgePdfProcessingAttempt.update({
              data: { state: "ambiguous", updatedAt: input.now },
              where: { id: attempt.id }
            });
          }
          return { kind: "ambiguous" as const };
        }
        return { attemptId: attempt.id, kind: "dispatch" as const };
      });
      if (reservation.kind === "ambiguous") {
        throw new KnowledgeModelPdfAttemptError("pdf_processing_ambiguous");
      }
      return reservation;
    },

    async settle(input: KnowledgeModelPdfAttemptIdentity & Readonly<{
      attemptId: string;
      now: Date;
      ownerUserId: string;
      resultText: string;
      snapshot: ProviderExecutionSnapshot;
      usage: ModelRunUsage;
    }>): Promise<SettledKnowledgeModelPdfBatch> {
      if (!input.resultText.trim() || input.resultText.length > 500_000) {
        // A rejected result was still a paid response.
        await recordUnsettledUsage(input).catch(() => undefined);
        throw new KnowledgeModelPdfAttemptError("pdf_processing_state_invalid");
      }
      const resultChecksum = checksum(input.resultText);
      try {
        return await prisma.$transaction(async (tx) => {
          const normalized = normalizeTokenUsage(input.usage);
          const row = await attemptUsageRow(tx, input, normalized);
          const usage: ModelRunUsage = { ...normalized, estimatedCostMicros: row.estimatedCostMicros };
          const updated = await tx.knowledgePdfProcessingAttempt.updateMany({
            data: {
              resultChecksum,
              resultText: input.resultText,
              settledAt: input.now,
              state: "settled",
              updatedAt: input.now,
              usage: usage as unknown as Prisma.InputJsonValue
            },
            where: {
              batchIndex: input.batchIndex,
              id: input.attemptId,
              mode: input.mode,
              pageEnd: input.pageEnd,
              pageStart: input.pageStart,
              processingGeneration: input.processingGeneration,
              requestDigest: input.requestDigest,
              sourceArtifactId: input.artifactId,
              sourceVersionId: input.sourceVersionId,
              state: "dispatched"
            }
          });
          if (updated.count !== 1) {
            const prior = await tx.knowledgePdfProcessingAttempt.findUnique({
              where: { id: input.attemptId }
            });
            if (prior?.state === "settled" && exactAttempt(prior, input) &&
              prior.resultChecksum?.trim() === resultChecksum) return settledBatch(prior);
            throw new KnowledgeModelPdfAttemptError("pdf_processing_state_invalid");
          }
          await tx.usageEvent.create({ data: row });
          const settled = await tx.knowledgePdfProcessingAttempt.findUniqueOrThrow({
            where: { id: input.attemptId }
          });
          return settledBatch(settled);
        });
      } catch (error) {
        const prior = await prisma.knowledgePdfProcessingAttempt.findUnique({
          where: { id: input.attemptId }
        });
        if (prior?.state === "settled" && exactAttempt(prior, input) &&
          prior.resultChecksum?.trim() === resultChecksum) return settledBatch(prior);
        await prisma.knowledgePdfProcessingAttempt.updateMany({
          data: { state: "ambiguous", updatedAt: input.now },
          where: { id: input.attemptId, state: "dispatched" }
        }).catch(() => undefined);
        // The response arrived but did not settle this attempt.
        await recordUnsettledUsage(input).catch(() => undefined);
        throw error;
      }
    }
  };
}

import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  decodeKnowledgeCitationHandle,
  KNOWLEDGE_CITATION_V2_MAX
} from "../../contracts/knowledge";
import {
  createAcceptedEmbeddingRuntime,
  type AcceptedEmbeddingRuntimeStore
} from "../providerRuntime/embeddingRuntime";
import type { ProviderConnectionConfiguration } from "../providers/providerConfiguration";
import type { StorageAdapter } from "../uploads/storage";
import type {
  KnowledgeAcceptedEmbeddingRuntime,
  KnowledgeBudgetState,
  KnowledgeEmbeddingRuntimeResolver,
  KnowledgeRetrievalStore,
  KnowledgeScopeAlias
} from "./toolExecutor";
import type {
  KnowledgeAcceptedBinding,
  KnowledgeHybridPassage,
  KnowledgeHybridSearchResult,
  KnowledgeRetrievalEvidence
} from "./retrievalTypes";
import { getKnowledgeExtractionConfig, type KnowledgeExtractionConfig } from "./knowledgeExtractionConfig";
import { analyzeStructuredKnowledgeSources } from "./structuredRetrieval";
import {
  analyzeVisualKnowledgeSources,
  type KnowledgeVisualAnalysisRuntime
} from "./visualEvidence";
import {
  knowledgeVisionEgressApproved,
  knowledgeVisionProfileFromConfiguration
} from "./knowledgeProfile";
import {
  KNOWLEDGE_EVIDENCE_CITATION_CONTRACT,
  KNOWLEDGE_EVIDENCE_PROVENANCE_VERSION,
  knowledgeEvidenceConfidenceBucket,
  knowledgeEvidenceKey
} from "./evidencePackage";
import { decodeKnowledgePlannerPlan } from "./planner";
import { knowledgeToolResultText } from "./toolResult";
import {
  executeKnowledgeRetrievalCore
} from "./prismaRetrievalCore";
import type { KnowledgeCandidateReranker } from "./retrievalRanking";
import {
  decodeKnowledgeBudgetPolicy,
  estimatedKnowledgeEmbeddingCostMicros,
  knowledgeBudgetStopReason,
  type KnowledgeBudgetUsage,
  type KnowledgeOperationKind
} from "./knowledgeBudget";
import {
  KNOWLEDGE_DISCOVER_SOURCES_TOOL_NAME,
  KNOWLEDGE_EXACT_TOOL_NAME,
  KNOWLEDGE_EXECUTION_TOOL_NAMES,
  KNOWLEDGE_READ_SOURCE_TOOL_NAME,
  KNOWLEDGE_SCOPE_MAX_BINDINGS,
  KNOWLEDGE_SEARCH_TOOL_NAME,
  KNOWLEDGE_TOOL_NAME
} from "./retrievalTypes";

type RetrievalPrisma = Pick<
  PrismaClient,
  | "$queryRaw"
  | "$transaction"
  | "knowledgeEvidenceItem"
  | "knowledgeRun"
  | "knowledgeRunBinding"
  | "knowledgeRetrievalSession"
  | "knowledgeRunScope"
  | "knowledgeArtifactPassageIndex"
  | "knowledgeSourceIndexArtifact"
  | "modelRun"
  | "modelRunToolCall"
> & AcceptedEmbeddingRuntimeStore;

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function nonNegativeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function evidenceRank(
  order: null | readonly string[],
  chunkId: string,
  resultOrdinal: number
): number {
  if (order === null) return resultOrdinal + 1;
  const rank = order.indexOf(chunkId);
  if (rank < 0) throw new Error("knowledge_evidence_ranking_provenance_invalid");
  return rank + 1;
}

const operationToolNames: Record<KnowledgeOperationKind, string> = {
  automatic_search: KNOWLEDGE_TOOL_NAME,
  discover_sources: KNOWLEDGE_DISCOVER_SOURCES_TOOL_NAME,
  find_exact: KNOWLEDGE_EXACT_TOOL_NAME,
  read_source: KNOWLEDGE_READ_SOURCE_TOOL_NAME,
  search_knowledge: KNOWLEDGE_SEARCH_TOOL_NAME
};

function embeddingTokens(value: unknown): number {
  if (!Array.isArray(value)) return 0;
  return value.reduce((total, entry) => {
    if (!record(entry) || entry.status !== "complete") return total;
    const tokens = nonNegativeInteger(entry.totalTokens);
    return total + (tokens ?? 0);
  }, 0);
}

function resultMetrics(value: unknown): Readonly<{
  contentHashes: readonly string[];
  retrievedTokens: number;
}> {
  if (!Array.isArray(value)) return { contentHashes: [], retrievedTokens: 0 };
  const contentHashes: string[] = [];
  let bytes = 0;
  for (const entry of value) {
    if (!record(entry)) continue;
    if (typeof entry.contentHash === "string" && /^[0-9a-f]{64}$/u.test(entry.contentHash)) {
      contentHashes.push(entry.contentHash);
    }
    const includedTextBytes = nonNegativeInteger(entry.includedTextBytes);
    bytes += includedTextBytes ?? 0;
  }
  return { contentHashes, retrievedTokens: Math.ceil(bytes / 4) };
}

function noveltyRatio(value: unknown): number | null {
  if (!record(value) || value.noveltyRatio === null) return null;
  return typeof value.noveltyRatio === "number" && Number.isFinite(value.noveltyRatio) &&
    value.noveltyRatio >= 0 && value.noveltyRatio <= 1
    ? value.noveltyRatio
    : null;
}

function sourceReadPage(locator: string): number | null {
  const match = /^(?:page|p\.?|страниц(?:а|е|у|ы)?|стр\.?)\s*#?\s*(\d{1,6})$/iu
    .exec(locator.trim());
  const page = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(page) && page >= 1 ? page : null;
}

function sourceReadHeading(locator: string): string {
  return locator
    .replace(/^(?:heading|section|раздел|заголовок)\s*[:—-]\s*/iu, "")
    .replace(/\s*[›>]\s*/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function passageLayoutKind(contextPrefix: string): "body" | "table_ambiguous" | "table_row" {
  const marker = contextPrefix.split("\n", 1)[0];
  if (marker === "Evidence layout: table_ambiguous_v1") return "table_ambiguous";
  if (marker === "Evidence layout: table_row_v1") return "table_row";
  return "body";
}

export function createPrismaKnowledgeRetrievalStore(
  client: RetrievalPrisma,
  options: Readonly<{
    extractionConfig?: KnowledgeExtractionConfig;
    reranker?: KnowledgeCandidateReranker;
    storage?: Pick<StorageAdapter, "getObject">;
    visualRuntime?: KnowledgeVisualAnalysisRuntime;
  }> = {}
): KnowledgeRetrievalStore {
  const structuredStorage = options.storage;
  return {
    async budgetState(input): Promise<KnowledgeBudgetState | null> {
      const expectedToolName = operationToolNames[input.operation];
      const toolNames = Prisma.sql`ARRAY[${Prisma.join(
        [...KNOWLEDGE_EXECUTION_TOOL_NAMES]
      )}]::text[]`;
      const [summaryRows, scope, receipts] = await Promise.all([
        client.$queryRaw<Array<{
          followUpOperations: number;
          invocationOrdinal: number;
          operations: number;
          searchPhases: number;
          subqueriesInCurrentPhase: number;
        }>>(Prisma.sql`
          SELECT
            count(preceding."id")::integer AS "invocationOrdinal",
            count(preceding."id")::integer AS operations,
            count(preceding."id") FILTER (WHERE preceding."roundIndex" > 0)::integer
              AS "followUpOperations",
            count(DISTINCT preceding."roundIndex")::integer AS "searchPhases",
            count(preceding."id") FILTER (
              WHERE preceding."roundIndex" = target."roundIndex"
            )::integer AS "subqueriesInCurrentPhase"
          FROM "ModelRunToolCall" AS target
          INNER JOIN "ModelRun" AS run ON run."id" = target."modelRunId"
          INNER JOIN "ModelRunToolCall" AS preceding
            ON preceding."modelRunId" = target."modelRunId"
           AND preceding."toolName" = ANY(${toolNames})
           AND (
             preceding."roundIndex" < target."roundIndex"
             OR (preceding."roundIndex" = target."roundIndex"
               AND preceding."ordinal" <= target."ordinal")
           )
          WHERE target."id" = ${input.modelRunToolCallId}
            AND target."modelRunId" = ${input.runId}
            AND target."toolName" = ${expectedToolName}
            AND run."userId" = ${input.userId}
          GROUP BY target."id", target."roundIndex"
        `),
        client.knowledgeRunScope.findFirst({
          select: { budgetPolicy: true },
          where: { modelRun: { id: input.runId, userId: input.userId }, modelRunId: input.runId }
        }),
        client.knowledgeRun.findMany({
          orderBy: { invocationOrdinal: "asc" },
          select: {
            budgetEvidence: true,
            candidateCount: true,
            durationMs: true,
            embeddingUsage: true,
            invocationOrdinal: true,
            rerankerBinding: true,
            results: true
          },
          where: { modelRun: { id: input.runId, userId: input.userId }, modelRunId: input.runId }
        })
      ]);
      const summary = summaryRows[0];
      const policy = decodeKnowledgeBudgetPolicy(scope?.budgetPolicy);
      if (!summary || !policy || summary.invocationOrdinal < 1 ||
        summary.invocationOrdinal > 256) return null;

      let cumulativeCandidates = 0;
      let evidenceCount = 0;
      let latencyMs = 0;
      let queryEmbeddingCalls = 0;
      let rerankerCalls = 0;
      let retrievedTokens = 0;
      let totalEmbeddingTokens = 0;
      const priorContentHashes: string[] = [];
      for (const receipt of receipts) {
        cumulativeCandidates += receipt.candidateCount;
        latencyMs += receipt.durationMs;
        const usage = Array.isArray(receipt.embeddingUsage) ? receipt.embeddingUsage : [];
        queryEmbeddingCalls += usage.length;
        totalEmbeddingTokens += embeddingTokens(usage);
        rerankerCalls += receipt.rerankerBinding === null ? 0 : 1;
        const result = resultMetrics(receipt.results);
        evidenceCount += Array.isArray(receipt.results) ? receipt.results.length : 0;
        retrievedTokens += result.retrievedTokens;
        priorContentHashes.push(...result.contentHashes);
      }
      let lowNoveltyStreak = 0;
      for (const receipt of [...receipts].reverse()) {
        const ratio = noveltyRatio(receipt.budgetEvidence);
        if (ratio === null || ratio >= policy.minNoveltyRatio) break;
        lowNoveltyStreak += 1;
      }
      const usage: KnowledgeBudgetUsage = {
        cumulativeCandidates,
        estimatedCostMicros: estimatedKnowledgeEmbeddingCostMicros(
          policy,
          totalEmbeddingTokens
        ),
        followUpOperations: summary.followUpOperations,
        latencyMs,
        lowNoveltyStreak,
        operations: summary.operations,
        queryEmbeddingCalls,
        rerankerCalls,
        retrievedTokens,
        searchPhases: summary.searchPhases,
        subqueriesInCurrentPhase: summary.subqueriesInCurrentPhase
      };
      return {
        evidenceCount,
        invocationOrdinal: summary.invocationOrdinal,
        policy,
        priorContentHashes: [...new Set(priorContentHashes)],
        stopReason: knowledgeBudgetStopReason(policy, usage),
        usage
      };
    },
    async hybridSearch(input): Promise<KnowledgeHybridSearchResult> {
      if (
        input.vectors.length > KNOWLEDGE_SCOPE_MAX_BINDINGS ||
        input.vectors.some((entry) =>
          entry.bindingOrdinal < 0 || entry.bindingOrdinal >= KNOWLEDGE_SCOPE_MAX_BINDINGS ||
          !entry.knowledgeBaseId || !entry.indexGenerationId ||
          entry.vector.length !== entry.targetDimension ||
          entry.vector.some((value) => !Number.isFinite(value))) ||
        new Set(input.vectors.map((entry) => entry.bindingOrdinal)).size !== input.vectors.length
      ) throw new Error("knowledge_query_vector_invalid");
      const result = await executeKnowledgeRetrievalCore(client, {
        ...(input.bindingOrdinals ? { bindingOrdinals: input.bindingOrdinals } : {}),
        candidateLimit: input.candidateLimit,
        query: input.query,
        ...(options.reranker ? { reranker: options.reranker } : {}),
        resultLimit: input.resultLimit,
        runId: input.runId,
        scoreThreshold: input.threshold,
        ...(input.sourceIds ? { sourceIds: input.sourceIds } : {}),
        userId: input.userId,
        vectors: input.vectors
      });
      return {
        bindingCount: result.bindingCount,
        candidateCount: result.candidateCount,
        candidateCounts: result.candidateCounts,
        passages: result.passages.map((passage): KnowledgeHybridPassage => ({
          annRank: passage.annRank,
          baseName: passage.baseName,
          bindingOrdinal: passage.bindingOrdinal,
          chunkId: passage.chunkId,
          chunkIndex: passage.chunkIndex,
          confidence: passage.confidence,
          contentHash: passage.contentHash,
          documentId: passage.documentId,
          documentVersionId: passage.documentVersionId,
          documentVersionNumber: passage.documentVersionNumber,
          fileName: passage.fileName,
          ftsRank: passage.ftsRank,
          ftsScore: passage.ftsScore,
          fusedScore: passage.fusedScore,
          headingPath: passage.headingPath,
          knowledgeBaseId: passage.knowledgeBaseId,
          layoutKind: passage.layoutKind,
          page: passage.page,
          rerankScore: passage.rerankScore,
          sectionId: passage.sectionId,
          signalProvenance: passage.signals,
          sourceArtifactId: passage.sourceArtifactId,
          sourceName: passage.sourceName,
          text: passage.text,
          vectorDistance: passage.vectorDistance,
          vectorScore: passage.vectorScore
        })),
        rankingEvidence: result.rankingEvidence,
        vectorSearchEvidence: result.vectorSearchEvidence
      };
    },
    async readSource(input): Promise<KnowledgeHybridSearchResult> {
      const empty = (): KnowledgeHybridSearchResult => ({
        bindingCount: 1,
        candidateCount: 0,
        candidateCounts: { [input.binding.ordinal]: 0 },
        passages: []
      });
      if (!input.binding.includeWholeBase &&
        !input.binding.selectedSourceIds.includes(input.sourceId)) return empty();
      const artifact = await client.knowledgeSourceIndexArtifact.findFirst({
        select: {
          hierarchicalIndexes: {
            orderBy: { schemaVersion: "desc" },
            select: { id: true },
            take: 1,
            where: { state: "ready" }
          },
          sourceVersion: {
            select: {
              fileName: true,
              id: true,
              versionNumber: true,
              source: { select: { name: true } }
            }
          }
        },
        where: {
          id: input.sourceArtifactId,
          sourceVersion: { sourceId: input.sourceId },
          state: "ready",
          snapshotSources: {
            some: {
              artifactId: input.sourceArtifactId,
              knowledgeBaseId: input.binding.knowledgeBaseId,
              snapshotId: input.binding.knowledgeBaseSnapshotId,
              sourceId: input.sourceId
            }
          }
        }
      });
      const indexArtifactId = artifact?.hierarchicalIndexes[0]?.id;
      if (!artifact || !indexArtifactId) return empty();

      const locator = input.locator.trim();
      const handle = decodeKnowledgeCitationHandle(locator)?.handle ?? null;
      const requestedPage = sourceReadPage(input.locator);
      let anchor: Readonly<{ ordinal: number; page: number }> | null = null;
      if (handle) {
        const item = await client.knowledgeEvidenceItem.findFirst({
          select: { page: true, passageId: true },
          where: {
            handle,
            retrievalSession: { modelRun: { id: input.runId, userId: input.userId } },
            sourceArtifactId: input.sourceArtifactId,
            state: "available"
          }
        });
        if (item?.passageId) {
          anchor = await client.knowledgeArtifactPassageIndex.findFirst({
            select: { ordinal: true, page: true },
            where: { id: item.passageId, indexArtifactId }
          });
        }
        if (!anchor && item?.page) {
          anchor = await client.knowledgeArtifactPassageIndex.findFirst({
            orderBy: { ordinal: "asc" },
            select: { ordinal: true, page: true },
            where: { indexArtifactId, page: { lte: item.page }, pageEnd: { gte: item.page } }
          });
        }
      } else if (requestedPage !== null) {
        anchor = await client.knowledgeArtifactPassageIndex.findFirst({
          orderBy: { ordinal: "asc" },
          select: { ordinal: true, page: true },
          where: { indexArtifactId, page: { lte: requestedPage }, pageEnd: { gte: requestedPage } }
        });
      } else {
        const heading = sourceReadHeading(input.locator);
        if (heading) {
          anchor = await client.knowledgeArtifactPassageIndex.findFirst({
            orderBy: { ordinal: "asc" },
            select: { ordinal: true, page: true },
            where: {
              headingText: { equals: heading, mode: "insensitive" },
              indexArtifactId
            }
          });
        }
      }
      if (!anchor) return empty();

      const before = input.direction === "after"
        ? 0
        : input.direction === "before"
          ? input.window - 1
          : Math.floor((input.window - 1) / 2);
      const after = input.direction === "before" ? 0 : input.window - before - 1;
      const rows = await client.knowledgeArtifactPassageIndex.findMany({
        orderBy: { ordinal: "asc" },
        select: {
          contentHash: true,
          contextPrefix: true,
          headingPath: true,
          id: true,
          ordinal: true,
          page: true,
          sectionId: true,
          sourceName: true,
          text: true
        },
        take: input.window,
        where: {
          indexArtifactId,
          ordinal: {
            gte: Math.max(0, anchor.ordinal - before),
            lte: anchor.ordinal + after
          }
        }
      });
      const passages = rows.map((row, index): KnowledgeHybridPassage => {
        const rank = index + 1;
        return {
          annRank: null,
          baseName: input.binding.baseName,
          bindingOrdinal: input.binding.ordinal,
          chunkId: row.id,
          chunkIndex: row.ordinal,
          contentHash: row.contentHash.trim(),
          documentId: input.sourceId,
          documentVersionId: artifact.sourceVersion.id,
          documentVersionNumber: artifact.sourceVersion.versionNumber,
          fileName: artifact.sourceVersion.fileName,
          ftsRank: rank,
          ftsScore: 1,
          fusedScore: 1 / (60 + rank),
          headingPath: row.headingPath,
          knowledgeBaseId: input.binding.knowledgeBaseId,
          layoutKind: passageLayoutKind(row.contextPrefix),
          page: row.page,
          sectionId: row.sectionId,
          sourceArtifactId: input.sourceArtifactId,
          sourceName: row.sourceName || artifact.sourceVersion.source.name,
          text: row.text,
          vectorDistance: null,
          vectorScore: null
        };
      });
      return {
        bindingCount: 1,
        candidateCount: passages.length,
        candidateCounts: { [input.binding.ordinal]: passages.length },
        passages
      };
    },
    ...(structuredStorage ? {
      async structuredSearch(input) {
        const requestedArtifactIds = [...new Set(input.sourceArtifactIds)].slice(0, 1_000);
        if (requestedArtifactIds.length === 0) return { kind: "not_applicable" as const };
        const bindingBySnapshot = new Map(input.bindings.map((binding) => [
          `${binding.knowledgeBaseId}:${binding.knowledgeBaseSnapshotId}`,
          binding
        ]));
        const snapshotWhere: Prisma.KnowledgeBaseSnapshotSourceWhereInput = {
          OR: input.bindings.map((binding) => ({
            knowledgeBaseId: binding.knowledgeBaseId,
            snapshotId: binding.knowledgeBaseSnapshotId,
            ...(!binding.includeWholeBase
              ? { sourceId: { in: [...binding.selectedSourceIds] } }
              : {})
          }))
        };
        const artifacts = await client.knowledgeSourceIndexArtifact.findMany({
          orderBy: { id: "asc" },
          select: {
            hierarchicalIndexes: {
              orderBy: { schemaVersion: "desc" },
              select: { id: true },
              take: 1,
              where: { state: "ready" }
            },
            id: true,
            normalizedTextByteSize: true,
            normalizedTextChecksum: true,
            normalizedTextStorageKey: true,
            sourceVersion: {
              select: {
                fileName: true,
                id: true,
                versionNumber: true,
                source: { select: { name: true } }
              }
            },
            snapshotSources: {
              select: {
                knowledgeBaseId: true,
                snapshotId: true,
                sourceId: true,
                sourceVersionId: true
              },
              where: snapshotWhere
            }
          },
          where: {
            id: { in: requestedArtifactIds },
            normalizedTextByteSize: { not: null },
            normalizedTextChecksum: { not: null },
            normalizedTextStorageKey: { not: null },
            state: "ready",
            snapshotSources: { some: snapshotWhere }
          }
        });
        const hierarchyByArtifact = new Map(artifacts.flatMap((artifact) =>
          artifact.hierarchicalIndexes[0]
            ? [[artifact.id, artifact.hierarchicalIndexes[0].id] as const]
            : []));
        const candidates = artifacts.flatMap((artifact) => artifact.snapshotSources.flatMap((snapshot) => {
          const binding = bindingBySnapshot.get(
            `${snapshot.knowledgeBaseId}:${snapshot.snapshotId}`
          );
          if (!binding || !artifact.normalizedTextStorageKey ||
            artifact.normalizedTextByteSize === null || !artifact.normalizedTextChecksum ||
            !/^[0-9a-f]{64}$/u.test(artifact.normalizedTextChecksum.trim()) ||
            !hierarchyByArtifact.has(artifact.id)) return [];
          return [{
            artifactId: artifact.id,
            baseName: binding.baseName,
            bindingOrdinal: binding.ordinal,
            documentId: snapshot.sourceId,
            documentVersionId: snapshot.sourceVersionId,
            documentVersionNumber: artifact.sourceVersion.versionNumber,
            fileName: artifact.sourceVersion.fileName,
            knowledgeBaseId: snapshot.knowledgeBaseId,
            normalizedTextByteSize: artifact.normalizedTextByteSize,
            normalizedTextChecksum: artifact.normalizedTextChecksum.trim(),
            normalizedTextStorageKey: artifact.normalizedTextStorageKey,
            sourceName: artifact.sourceVersion.source.name
          }];
        }));
        return analyzeStructuredKnowledgeSources({
          candidates,
          config: options.extractionConfig ?? getKnowledgeExtractionConfig(),
          async loadAnchor(candidate, page) {
            const indexArtifactId = hierarchyByArtifact.get(candidate.artifactId);
            if (!indexArtifactId) return null;
            return client.knowledgeArtifactPassageIndex.findFirst({
              orderBy: { ordinal: "asc" },
              select: {
                contentHash: true,
                headingPath: true,
                id: true,
                ordinal: true,
                sectionId: true
              },
              where: { indexArtifactId, page }
            });
          },
          query: input.query,
          ...(input.signal ? { signal: input.signal } : {}),
          storage: structuredStorage
        });
      }
    } : {}),
    ...(structuredStorage ? {
      async visualSearch(input) {
        const requestedArtifactIds = [...new Set(input.sourceArtifactIds)].slice(0, 1_000);
        if (requestedArtifactIds.length === 0) return { kind: "not_applicable" as const };
        const bindingBySnapshot = new Map(input.bindings.map((binding) => [
          `${binding.knowledgeBaseId}:${binding.knowledgeBaseSnapshotId}`,
          binding
        ]));
        const snapshotWhere: Prisma.KnowledgeBaseSnapshotSourceWhereInput = {
          OR: input.bindings.map((binding) => ({
            knowledgeBaseId: binding.knowledgeBaseId,
            snapshotId: binding.knowledgeBaseSnapshotId,
            ...(!binding.includeWholeBase
              ? { sourceId: { in: [...binding.selectedSourceIds] } }
              : {})
          }))
        };
        const artifacts = await client.knowledgeSourceIndexArtifact.findMany({
          orderBy: { id: "asc" },
          select: {
            id: true,
            normalizedTextByteSize: true,
            normalizedTextChecksum: true,
            normalizedTextStorageKey: true,
            profileRevision: {
              select: { egressPolicy: true, profileConfiguration: true }
            },
            profileRevisionId: true,
            sourceVersion: {
              select: {
                byteSize: true,
                checksum: true,
                fileName: true,
                id: true,
                mimeType: true,
                originalStorageKey: true,
                versionNumber: true,
                source: { select: { name: true } }
              }
            },
            snapshotSources: {
              select: {
                knowledgeBaseId: true,
                snapshotId: true,
                sourceId: true,
                sourceVersionId: true
              },
              where: snapshotWhere
            }
          },
          where: {
            id: { in: requestedArtifactIds },
            normalizedTextByteSize: { not: null },
            normalizedTextChecksum: { not: null },
            normalizedTextStorageKey: { not: null },
            state: "ready",
            snapshotSources: { some: snapshotWhere }
          }
        });
        const candidates = artifacts.flatMap((artifact) => {
          const profile = knowledgeVisionProfileFromConfiguration(
            artifact.profileRevision.profileConfiguration
          );
          if (profile.kind === "invalid") return [];
          const destination = profile.kind === "configured" ? profile.destination : null;
          const egressApproved = Boolean(destination && knowledgeVisionEgressApproved(
            artifact.profileRevision.egressPolicy,
            destination.providerModelId
          ));
          return artifact.snapshotSources.flatMap((snapshot) => {
            const binding = bindingBySnapshot.get(
              `${snapshot.knowledgeBaseId}:${snapshot.snapshotId}`
            );
            const sourceVersion = artifact.sourceVersion;
            if (!binding || !artifact.normalizedTextStorageKey ||
              artifact.normalizedTextByteSize === null || !artifact.normalizedTextChecksum ||
              !/^[0-9a-f]{64}$/u.test(artifact.normalizedTextChecksum.trim()) ||
              !/^[0-9a-f]{64}$/u.test(sourceVersion.checksum.trim()) ||
              sourceVersion.byteSize < 1) return [];
            const visionProviderModelId = destination && egressApproved &&
              (sourceVersion.mimeType !== "application/pdf" || destination.supportsNativePdf)
              ? destination.providerModelId
              : null;
            return [{
              artifactId: artifact.id,
              baseName: binding.baseName,
              bindingOrdinal: binding.ordinal,
              documentId: snapshot.sourceId,
              documentVersionId: snapshot.sourceVersionId,
              documentVersionNumber: sourceVersion.versionNumber,
              fileName: sourceVersion.fileName,
              knowledgeBaseId: snapshot.knowledgeBaseId,
              mimeType: sourceVersion.mimeType,
              normalizedTextByteSize: artifact.normalizedTextByteSize,
              normalizedTextChecksum: artifact.normalizedTextChecksum.trim(),
              normalizedTextStorageKey: artifact.normalizedTextStorageKey,
              originalByteSize: sourceVersion.byteSize,
              originalChecksum: sourceVersion.checksum.trim(),
              originalStorageKey: sourceVersion.originalStorageKey,
              profileRevisionId: artifact.profileRevisionId,
              sourceName: sourceVersion.source.name,
              visionEgressApproved: Boolean(visionProviderModelId),
              visionProviderModelId
            }];
          });
        });
        return analyzeVisualKnowledgeSources({
          candidates,
          config: options.extractionConfig ?? getKnowledgeExtractionConfig(),
          query: input.query,
          ...(options.visualRuntime ? { runtime: options.visualRuntime } : {}),
          ...(input.signal ? { signal: input.signal } : {}),
          storage: structuredStorage
        });
      }
    } : {}),
    async invocationOrdinal(input) {
      const toolNames = Prisma.sql`ARRAY[${Prisma.join(
        [...KNOWLEDGE_EXECUTION_TOOL_NAMES]
      )}]::text[]`;
      const rows = await client.$queryRaw<Array<{ ordinal: number }>>(Prisma.sql`
        SELECT count(preceding."id")::integer AS ordinal
        FROM "ModelRunToolCall" AS target
        INNER JOIN "ModelRun" AS run ON run."id" = target."modelRunId"
        INNER JOIN "ModelRunToolCall" AS preceding
          ON preceding."modelRunId" = target."modelRunId"
         AND preceding."toolName" = ANY(${toolNames})
         AND (
           preceding."roundIndex" < target."roundIndex"
           OR (preceding."roundIndex" = target."roundIndex"
             AND preceding."ordinal" <= target."ordinal")
         )
        WHERE target."id" = ${input.modelRunToolCallId}
          AND target."modelRunId" = ${input.runId}
          AND target."toolName" = ${input.toolName}
          AND run."userId" = ${input.userId}
        GROUP BY target."id"
      `);
      const ordinal = nonNegativeInteger(rows[0]?.ordinal);
      return ordinal !== null && ordinal >= 1 ? ordinal : null;
    },
    async loadBindings(input) {
      const rows = await client.knowledgeRunBinding.findMany({
        orderBy: { ordinal: "asc" },
        select: {
          baseContentRevision: true,
          embeddingConnectionId: true,
          embeddingCredentialId: true,
          embeddingCredentialSource: true,
          embeddingCredentialVersionId: true,
          embeddingExecutionSnapshot: true,
          embeddingProviderModelId: true,
          indexedContentRevision: true,
          indexGenerationId: true,
          includeWholeBase: true,
          knowledgeBase: { select: { name: true } },
          knowledgeBaseId: true,
          knowledgeBaseSnapshotId: true,
          ordinal: true,
          selectedSourceIds: true,
          targetDimension: true,
          vectorSpaceFingerprint: true
        },
        where: {
          modelRun: { id: input.runId, userId: input.userId }
        }
      });
      return rows.map((row): KnowledgeAcceptedBinding => {
        if (!row.knowledgeBaseSnapshotId) {
          throw new Error("knowledge_run_snapshot_unavailable");
        }
        return {
        baseContentRevision: row.baseContentRevision,
        baseName: row.knowledgeBase.name,
        embeddingConnectionId: row.embeddingConnectionId,
        embeddingCredentialId: row.embeddingCredentialId,
        embeddingCredentialSource: row.embeddingCredentialSource,
        embeddingCredentialVersionId: row.embeddingCredentialVersionId,
        embeddingExecutionSnapshot: row.embeddingExecutionSnapshot,
        embeddingProviderModelId: row.embeddingProviderModelId,
        indexedContentRevision: row.indexedContentRevision,
        indexGenerationId: row.indexGenerationId,
        includeWholeBase: row.includeWholeBase,
        knowledgeBaseId: row.knowledgeBaseId,
        knowledgeBaseSnapshotId: row.knowledgeBaseSnapshotId,
        ordinal: row.ordinal,
        selectedSourceIds: [...row.selectedSourceIds],
        targetDimension: row.targetDimension as 1024 | 1536,
        vectorSpaceFingerprint: row.vectorSpaceFingerprint.trim()
        };
      });
    },
    async loadScopeAliases(input): Promise<readonly KnowledgeScopeAlias[]> {
      const rows = await client.$queryRaw<Array<{
        alias: string;
        bindingOrdinal: number;
        kind: string;
        label: string;
        sourceArtifactId: string | null;
        sourceId: string | null;
      }>>(Prisma.sql`
        WITH admitted_bindings AS MATERIALIZED (
          SELECT
            binding."ordinal",
            binding."knowledgeBaseId",
            binding."knowledgeBaseSnapshotId",
            binding."includeWholeBase",
            binding."selectedSourceIds",
            base."name" AS "baseName"
          FROM "ModelRun" AS run
          INNER JOIN "KnowledgeRunBinding" AS binding ON binding."modelRunId" = run."id"
          INNER JOIN "KnowledgeBase" AS base ON base."id" = binding."knowledgeBaseId"
          WHERE run."id" = ${input.runId}
            AND run."userId" = ${input.userId}
        ),
        admitted_sources AS MATERIALIZED (
          SELECT
            binding."ordinal" AS "bindingOrdinal",
            snapshot_source."artifactId" AS "sourceArtifactId",
            snapshot_source."sourceId",
            source."name" AS label,
            row_number() OVER (
              ORDER BY binding."ordinal", snapshot_source."ordinal", snapshot_source."sourceId"
            )::integer AS "sourceOrdinal"
          FROM admitted_bindings AS binding
          INNER JOIN "KnowledgeBaseSnapshotSource" AS snapshot_source
            ON snapshot_source."snapshotId" = binding."knowledgeBaseSnapshotId"
           AND (
             binding."includeWholeBase" = true
             OR snapshot_source."sourceId" = ANY(binding."selectedSourceIds")
           )
          INNER JOIN "KnowledgeSource" AS source ON source."id" = snapshot_source."sourceId"
        )
        SELECT
          ('B' || (binding."ordinal" + 1)::text) AS alias,
          binding."ordinal" AS "bindingOrdinal",
          'base'::text AS kind,
          binding."baseName" AS label,
          NULL::text AS "sourceArtifactId",
          NULL::text AS "sourceId"
        FROM admitted_bindings AS binding
        UNION ALL
        SELECT
          ('S' || source."sourceOrdinal"::text) AS alias,
          source."bindingOrdinal",
          'source'::text AS kind,
          source.label,
          source."sourceArtifactId",
          source."sourceId"
        FROM admitted_sources AS source
        WHERE source."sourceOrdinal" <= 999
        ORDER BY "bindingOrdinal", kind, alias
      `);
      const aliases: KnowledgeScopeAlias[] = [];
      for (const row of rows) {
        if (!/^[BS][1-9]\d{0,2}$/u.test(row.alias) ||
          !Number.isSafeInteger(row.bindingOrdinal) || row.bindingOrdinal < 0 ||
          row.bindingOrdinal >= KNOWLEDGE_SCOPE_MAX_BINDINGS ||
          row.kind !== "base" && row.kind !== "source" || !row.label ||
          (row.kind === "source" && (!row.sourceArtifactId || !row.sourceId))) {
          throw new Error("knowledge_scope_alias_invalid");
        }
        aliases.push({
          alias: row.alias,
          bindingOrdinal: row.bindingOrdinal,
          kind: row.kind,
          label: row.label,
          ...(row.sourceArtifactId ? { sourceArtifactId: row.sourceArtifactId } : {}),
          ...(row.sourceId ? { sourceId: row.sourceId } : {})
        });
      }
      if (new Set(aliases.map((alias) => alias.alias)).size !== aliases.length) {
        throw new Error("knowledge_scope_alias_invalid");
      }
      return aliases;
    },
    async persistReceipt(input) {
      return client.$transaction(async (tx) => {
        const lockedRun = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT run."id"
          FROM "ModelRun" AS run
          WHERE run."id" = ${input.runId}
            AND run."userId" = ${input.userId}
          FOR UPDATE
        `);
        if (lockedRun.length !== 1) throw new Error("knowledge_run_context_unavailable");
        const call = await tx.modelRunToolCall.findFirst({
          select: { id: true },
          where: {
            id: input.modelRunToolCallId,
            modelRun: { id: input.runId, userId: input.userId },
            modelRunId: input.runId,
            toolName: { in: [...KNOWLEDGE_EXECUTION_TOOL_NAMES] }
          }
        });
        if (!call) throw new Error("knowledge_run_context_unavailable");
        const existing = await tx.knowledgeRun.findUnique({
          select: { id: true },
          where: { modelRunToolCallId: input.modelRunToolCallId }
        });
        if (existing) throw new Error("knowledge_receipt_already_exists");
        const context = await tx.modelRun.findUnique({
          select: {
            knowledgeRunScope: {
              select: {
                budgetPolicy: true,
                exclusions: true,
                resolvedBaseCount: true,
                resolvedSourceCount: true,
                selection: true
              }
            },
            normalizedRequest: true
          },
          where: { id: input.runId }
        });
        const normalizedRequest = record(context?.normalizedRequest)
          ? context.normalizedRequest
          : null;
        const planner = normalizedRequest
          ? decodeKnowledgePlannerPlan(normalizedRequest.knowledgePlanner)
          : null;
        const scope = context?.knowledgeRunScope;
        if (!scope) throw new Error("knowledge_evidence_context_invalid");
        const plannerPlan = planner?.ok ? planner.plan : {
          automaticRetrieval: true,
          coverage: {
            expectedPassageCount: null,
            mode: "partial" as const,
            namedTargets: [] as string[]
          },
          evidenceMode: "compact" as const,
          failureCode: "classifier_unavailable" as const,
          intent: "fact_lookup" as const,
          originalQuery: input.evidence.query,
          status: "degraded" as const,
          strategy: "focused" as const
        };
        const structuredClarification = input.evidence.structured?.status === "needs_clarification"
          ? input.evidence.structured.question
          : null;

        const exclusions = Array.isArray(scope.exclusions) ? scope.exclusions : [];
        const excludedResources = exclusions.reduce<number>((total, value) => {
          if (!record(value)) return total;
          const count = nonNegativeInteger(value.count);
          return total + (count ?? 0);
        }, 0);
        let session = await tx.knowledgeRetrievalSession.findUnique({
          where: { modelRunId: input.runId }
        });
        if (!session) {
          const degradedFlags = [
            ...(plannerPlan.status === "degraded" ? ["planner_degraded"] : []),
            ...(plannerPlan.failureCode ? [plannerPlan.failureCode] : []),
            ...(excludedResources > 0 ? ["partial_readiness"] : [])
          ];
          session = await tx.knowledgeRetrievalSession.create({
            data: {
              citationContract: json(KNOWLEDGE_EVIDENCE_CITATION_CONTRACT),
              coverageRequirements: json({ ...plannerPlan.coverage, verified: false }),
              degradedFlags,
              id: randomUUID(),
              modelRunId: input.runId,
              originalIntent: json({
                intent: plannerPlan.intent,
                query: plannerPlan.originalQuery
              }),
              readinessSummary: json({
                excludedResources,
                readyBases: scope.resolvedBaseCount,
                readySources: scope.resolvedSourceCount
              }),
              scopeSnapshot: json({
                budgetPolicy: scope.budgetPolicy,
                exclusions: scope.exclusions,
                resolvedBaseCount: scope.resolvedBaseCount,
                resolvedSourceCount: scope.resolvedSourceCount,
                selection: scope.selection
              }),
              strategySnapshot: json({
                automaticRetrieval: plannerPlan.automaticRetrieval,
                evidenceMode: plannerPlan.evidenceMode,
                failureCode: plannerPlan.failureCode ?? null,
                status: plannerPlan.status,
                strategy: plannerPlan.strategy,
                ...(structuredClarification
                  ? { structuredClarifications: [structuredClarification] }
                  : {})
              }),
              version: 2
            }
          });
        }
        if (session.acceptedAt || session.receiptHash) {
          throw new Error("knowledge_evidence_already_accepted");
        }

        const artifactIds = [...new Set(input.evidence.results.flatMap((result) =>
          result.sourceArtifactId ? [result.sourceArtifactId] : []))];
        const artifacts = artifactIds.length > 0
          ? await tx.knowledgeSourceIndexArtifact.findMany({
              select: {
                id: true,
                sourceVersion: {
                  select: { id: true, sourceId: true, versionNumber: true }
                }
              },
              where: { id: { in: artifactIds } }
            })
          : [];
        const sourceByArtifact = new Map(artifacts.map((artifact) => [artifact.id, {
          sourceId: artifact.sourceVersion.sourceId,
          sourceVersionId: artifact.sourceVersion.id,
          sourceVersionNumber: artifact.sourceVersion.versionNumber
        }]));
        const keyedResults = input.evidence.results.map((result) => {
          const source = result.sourceArtifactId
            ? sourceByArtifact.get(result.sourceArtifactId)
            : null;
          if (!source) throw new Error("knowledge_evidence_source_identity_unavailable");
          return {
            evidenceKey: knowledgeEvidenceKey({
              documentVersionId: result.documentVersionId,
              excerpt: result.includedText,
              knowledgeBaseId: result.knowledgeBaseId,
              passageId: result.chunkId,
              sourceVersionId: source.sourceVersionId
            }),
            result,
            source
          };
        });
        const existingItems = keyedResults.length > 0
          ? await tx.knowledgeEvidenceItem.findMany({
              where: {
                evidenceKey: { in: keyedResults.map((entry) => entry.evidenceKey) },
                retrievalSessionId: session.id,
                state: "available"
              }
            })
          : [];
        const byEvidenceKey = new Map(existingItems.flatMap((item) =>
          item.evidenceKey ? [[item.evidenceKey, item] as const] : []));
        let nextEvidenceOrdinal = session.nextEvidenceOrdinal;
        const acceptedResults: Array<KnowledgeRetrievalEvidence["results"][number]> = [];
        const evidenceItems: Array<Readonly<{
          id: string;
          result: KnowledgeRetrievalEvidence["results"][number];
          resultOrdinal: number;
        }>> = [];
        for (const [resultOrdinal, entry] of keyedResults.entries()) {
          let item = byEvidenceKey.get(entry.evidenceKey);
          if (!item) {
            if (nextEvidenceOrdinal > KNOWLEDGE_CITATION_V2_MAX) {
              throw new Error("knowledge_evidence_budget_exceeded");
            }
            const id = randomUUID();
            const handle = `K${nextEvidenceOrdinal}`;
            item = await tx.knowledgeEvidenceItem.create({
              data: {
                baseName: entry.result.baseName,
                contentHash: entry.result.contentHash ?? null,
                contextBoundaries: json({
                  expanded: entry.result.textTruncated,
                  excerptBytes: entry.result.includedTextBytes,
                  ...(entry.result.layoutKind
                    ? { layoutKind: entry.result.layoutKind }
                    : {}),
                  sourceTextBytes: entry.result.sourceTextBytes,
                  ...(entry.result.structuredAnalysis
                    ? { structuredAnalysis: entry.result.structuredAnalysis }
                    : {}),
                  ...(entry.result.visualAnalysis
                    ? { visualAnalysis: entry.result.visualAnalysis }
                    : {})
                }),
                documentId: entry.result.documentId,
                documentVersionId: entry.result.documentVersionId,
                evidenceKey: entry.evidenceKey,
                excerpt: entry.result.includedText,
                excerptBytes: entry.result.includedTextBytes,
                fileName: entry.result.fileName,
                handle,
                headingPath: [...(entry.result.headingPath ?? [])],
                id,
                knowledgeBaseId: entry.result.knowledgeBaseId,
                locator: json({
                  page: entry.result.page,
                  ...(entry.result.structuredAnalysis
                    ? { ranges: entry.result.structuredAnalysis.receipt.inputRanges }
                    : {})
                }),
                ordinal: nextEvidenceOrdinal,
                page: entry.result.page,
                passageId: entry.result.chunkId,
                retrievalSessionId: session.id,
                sectionId: entry.result.sectionId ?? null,
                sourceArtifactId: entry.result.sourceArtifactId ?? null,
                sourceId: entry.source.sourceId,
                sourceName: entry.result.sourceName ?? entry.result.fileName,
                sourceTextBytes: entry.result.sourceTextBytes,
                sourceVersionId: entry.source.sourceVersionId,
                sourceVersionNumber: entry.source.sourceVersionNumber,
                state: "available",
                textTruncated: entry.result.textTruncated
              }
            });
            byEvidenceKey.set(entry.evidenceKey, item);
            nextEvidenceOrdinal += 1;
          }
          acceptedResults.push({ ...entry.result, handle: item.handle });
          evidenceItems.push({ id: item.id, result: entry.result, resultOrdinal });
        }
        const degradedFlags = new Set(session.degradedFlags);
        if (input.evidence.failureCode) degradedFlags.add(input.evidence.failureCode);
        if (input.evidence.outcome !== "complete") {
          degradedFlags.add(`retrieval_${input.evidence.outcome}`);
        }
        if (input.evidence.budget?.stopReason) degradedFlags.add("budget_exhausted");
        if (input.evidence.visual?.status === "unavailable") {
          degradedFlags.add("visual_analysis_unavailable");
        }
        const strategySnapshot = record(session.strategySnapshot)
          ? session.strategySnapshot
          : null;
        const rawStructuredClarifications = strategySnapshot?.structuredClarifications;
        const storedStructuredClarifications = rawStructuredClarifications === undefined
          ? []
          : Array.isArray(rawStructuredClarifications) &&
              rawStructuredClarifications.length <= 16 &&
              rawStructuredClarifications.every((question) =>
                typeof question === "string" && question.length > 0 && question.length <= 2_000 &&
                !/\u0000/u.test(question))
            ? rawStructuredClarifications as string[]
            : null;
        if (!strategySnapshot || !storedStructuredClarifications) {
          throw new Error("knowledge_evidence_context_invalid");
        }
        const structuredClarifications = [...new Set([
          ...storedStructuredClarifications,
          ...(structuredClarification ? [structuredClarification] : [])
        ])];
        if (structuredClarifications.length > 16) {
          throw new Error("knowledge_evidence_context_invalid");
        }
        const nextStrategySnapshot = { ...strategySnapshot };
        delete nextStrategySnapshot.structuredClarifications;
        if (structuredClarifications.length > 0) {
          nextStrategySnapshot.structuredClarifications = structuredClarifications;
        }
        await tx.knowledgeRetrievalSession.update({
          data: {
            degradedFlags: [...degradedFlags].sort(),
            nextEvidenceOrdinal,
            strategySnapshot: json(nextStrategySnapshot)
          },
          where: { id: session.id }
        });

        const draftEvidence: KnowledgeRetrievalEvidence = {
          ...input.evidence,
          providerText: "pending",
          results: acceptedResults
        };
        const evidence: KnowledgeRetrievalEvidence = {
          ...draftEvidence,
          providerText: knowledgeToolResultText(draftEvidence)
        };
        const knowledgeRunId = randomUUID();
        await tx.knowledgeRun.create({
          data: {
            baseEvidence: json(evidence.bases),
            budgetEvidence: json(evidence.budget ?? {}),
            candidateCount: evidence.candidateCount,
            candidateLimit: evidence.candidateLimit,
            durationMs: evidence.durationMs,
            embeddingUsage: json(evidence.embeddingExecutions),
            failureCode: evidence.failureCode,
            fusion: evidence.fusion,
            id: knowledgeRunId,
            invocationOrdinal: evidence.invocationOrdinal,
            modelRunId: input.runId,
            modelRunToolCallId: input.modelRunToolCallId,
            retrievalSessionId: session.id,
            operation: evidence.operation ?? "automatic_search",
            outcome: evidence.outcome,
            providerText: evidence.providerText,
            query: evidence.query,
            rerankerBinding: evidence.rerankerBinding === null
              ? Prisma.JsonNull
              : json(evidence.rerankerBinding),
            resultLimit: evidence.resultLimit,
            results: json(evidence.results),
            postRerankOrder: evidence.postRerankOrder === null
              ? Prisma.JsonNull
              : json(evidence.postRerankOrder),
            preRerankOrder: evidence.preRerankOrder === null
              ? Prisma.JsonNull
              : json(evidence.preRerankOrder),
            stopReason: evidence.budget?.stopReason ?? null,
            threshold: evidence.threshold
          }
        });
        if (evidenceItems.length > 0) {
          await tx.knowledgeRunEvidence.createMany({
            data: evidenceItems.map((item) => ({
              evidenceItemId: item.id,
              knowledgeRunId,
              resultOrdinal: item.resultOrdinal,
              retrievalProvenance: json({
                confidence: item.result.confidence ?? null,
                confidenceBucket: knowledgeEvidenceConfidenceBucket(item.result.confidence),
                fusion: evidence.fusion,
                invocationOrdinal: evidence.invocationOrdinal,
                operation: evidence.operation ?? "automatic_search",
                postRerankRank: evidenceRank(
                  evidence.postRerankOrder,
                  item.result.chunkId,
                  item.resultOrdinal
                ),
                preRerankRank: evidenceRank(
                  evidence.preRerankOrder,
                  item.result.chunkId,
                  item.resultOrdinal
                ),
                rerankScore: item.result.rerankScore ?? null,
                signals: [...(item.result.signalProvenance ?? [])],
                version: KNOWLEDGE_EVIDENCE_PROVENANCE_VERSION
              })
            }))
          });
        }
        return evidence;
      });
    }
  };
}

export function createPrismaKnowledgeEmbeddingRuntime(
  client: RetrievalPrisma,
  options: Readonly<{
    createFetch?: (configuration: ProviderConnectionConfiguration) => typeof fetch;
    encryptionKey?: () => Buffer;
  }> = {}
): KnowledgeEmbeddingRuntimeResolver {
  const runtime = createAcceptedEmbeddingRuntime(client, options);
  return {
    async resolve(binding): Promise<KnowledgeAcceptedEmbeddingRuntime> {
      return runtime.resolve({
        connectionId: binding.embeddingConnectionId,
        credentialId: binding.embeddingCredentialId,
        credentialVersionId: binding.embeddingCredentialVersionId,
        executionSnapshot: binding.embeddingExecutionSnapshot,
        providerModelId: binding.embeddingProviderModelId
      });
    }
  };
}

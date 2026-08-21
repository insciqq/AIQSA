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
import { SPREADSHEET_MAX_REGIONS_PER_SHEET } from "../parsing/spreadsheetLimits";
import { memorySha256 } from "../memory/persistence/lexical";
import type {
  KnowledgeAcceptedEmbeddingRuntime,
  KnowledgeBudgetState,
  KnowledgeEmbeddingRuntimeResolver,
  KnowledgeRetrievalStore,
  KnowledgeScopeAlias
} from "./toolExecutor";
import type {
  KnowledgeAcceptedBinding,
  KnowledgeDiscoveredSourceEvidence,
  KnowledgeExactSearchResult,
  KnowledgeHybridPassage,
  KnowledgeHybridSearchResult,
  KnowledgeRetrievalEvidence,
  KnowledgeSourceDiscoveryResult
} from "./retrievalTypes";
import { createPrismaKnowledgeHierarchicalRetrievalRepository } from
  "./prismaHierarchicalRetrievalRepository";
import {
  decodeKnowledgeDocumentContext,
  isCompleteKnowledgeTableRowProjectionSequence,
  type KnowledgeDocumentContextV1
} from "./documentContext";
import {
  READ_SOURCE_MAX_WINDOW,
  readSourceA1RangeContains
} from "./readSourceLocator";
import {
  KNOWLEDGE_EVIDENCE_CITATION_CONTRACT,
  KNOWLEDGE_STORED_EVIDENCE_PROVENANCE_VERSION,
  knowledgeSourceEvidenceKey
} from "./evidencePackage";
import { decodeKnowledgeFocusedRequest } from "./focusedRequest";
import {
  decodeKnowledgeRetrievalEvidence,
  knowledgeToolResultText
} from "./toolResult";
import {
  executeKnowledgeRetrievalCore
} from "./prismaRetrievalCore";
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
  KNOWLEDGE_RESULT_VERSION,
  KNOWLEDGE_SCOPE_MAX_BINDINGS,
  KNOWLEDGE_FOCUSED_OPERATION_NAME
} from "./retrievalTypes";
import { settleKnowledgeBudgetReservationReceipt } from "./knowledgeBudgetReservationRepository";

type RetrievalPrisma = Pick<
  PrismaClient,
  | "$queryRaw"
  | "$transaction"
  | "knowledgeEvidenceItem"
  | "knowledgeRun"
  | "knowledgeRunBinding"
  | "knowledgeRunProfileBinding"
  | "knowledgeRunSourceBinding"
  | "knowledgeRetrievalSession"
  | "knowledgeRunScope"
  | "knowledgeArtifactSectionIndex"
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

const operationToolNames: Record<KnowledgeOperationKind, string> = {
  automatic_search: KNOWLEDGE_FOCUSED_OPERATION_NAME,
  discover_sources: KNOWLEDGE_DISCOVER_SOURCES_TOOL_NAME,
  find_exact: KNOWLEDGE_EXACT_TOOL_NAME,
  read_source: KNOWLEDGE_READ_SOURCE_TOOL_NAME
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

function passageDocumentContext(
  value: Prisma.JsonValue | null
): KnowledgeDocumentContextV1 | null {
  if (value === null) return null;
  const decoded = decodeKnowledgeDocumentContext(value);
  if (!decoded) throw new Error("knowledge_document_context_invalid");
  return decoded;
}

function passageLayoutKind(
  contextPrefix: string,
  documentContext: KnowledgeDocumentContextV1 | null
): KnowledgeHybridPassage["layoutKind"] {
  if (documentContext) return documentContext.locator.kind;
  const marker = contextPrefix.split("\n", 1)[0];
  if (marker === "Evidence layout: table_ambiguous_v1") return "table_ambiguous";
  if (marker === "Evidence layout: table_row_v1") return "table_row";
  return "body";
}

const SOURCE_READ_ANCHOR_SELECT = {
  documentContext: true,
  headingPath: true,
  ordinal: true,
  page: true,
  sectionId: true,
  sourceBlockIds: true
} as const;

const SOURCE_READ_PASSAGE_SELECT = {
  contentHash: true,
  contextPrefix: true,
  documentContext: true,
  headingPath: true,
  id: true,
  ordinal: true,
  page: true,
  sectionId: true,
  sourceBlockIds: true,
  sourceName: true,
  text: true
} as const;

type SourceReadAnchor = Readonly<{
  documentContext: Prisma.JsonValue | null;
  headingPath: readonly string[];
  ordinal: number;
  page: number;
  sectionId: string;
  sourceBlockIds: readonly string[];
}>;

type SourceReadPassageRow = SourceReadAnchor & Readonly<{
  contentHash: string;
  contextPrefix: string;
  id: string;
  sourceName: string;
  text: string;
}>;

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sourceReadStructureId(context: KnowledgeDocumentContextV1 | null): string | null {
  if (!context) return null;
  const locator = context.locator;
  return locator.kind === "table_row" || locator.kind === "table_row_projection"
    ? locator.blockId
    : locator.fieldGroupId;
}

function coherentSourceReadTableRow<T extends SourceReadPassageRow>(
  rows: readonly T[],
  rowId: string
): readonly T[] | null {
  if (rows.length < 1 || rows.length > READ_SOURCE_MAX_WINDOW) return null;
  const decoded = rows.map((row) => ({
    context: passageDocumentContext(row.documentContext),
    row
  }));
  const firstContext = decoded[0]?.context;
  if (!firstContext || (firstContext.locator.kind !== "table_row" &&
    firstContext.locator.kind !== "table_row_projection")) return null;
  const first = firstContext.locator;
  if (first.rowId !== rowId) return null;
  const headerRows = new Set<number>();
  for (const entry of decoded) {
    const context = entry.context;
    if (!context || (context.locator.kind !== "table_row" &&
      context.locator.kind !== "table_row_projection")) return null;
    const locator = context.locator;
    if (locator.rowId !== rowId || locator.blockId !== first.blockId ||
      locator.rowIndex !== first.rowIndex || locator.rowKind !== first.rowKind ||
      locator.kind === "table_row_projection" && locator.headerLineage.some((header) =>
        header.columnStart < locator.columnStart || header.columnEnd > locator.columnEnd) ||
      !entry.row.sourceBlockIds.includes(locator.blockId) ||
      entry.row.sectionId !== decoded[0]!.row.sectionId ||
      !sameStrings(entry.row.headingPath, decoded[0]!.row.headingPath)) return null;
    locator.headerLineage.forEach((header) => headerRows.add(header.rowIndex));
  }
  if (headerRows.size > 1) return null;
  if (first.kind === "table_row") {
    return rows.length === 1 && decoded.every(({ context }) =>
      context?.locator.kind === "table_row")
      ? Object.freeze([...rows])
      : null;
  }
  if (decoded.some(({ context }) => context?.locator.kind !== "table_row_projection")) return null;
  const projected = decoded as Array<Readonly<{
    context: KnowledgeDocumentContextV1 & Readonly<{
      locator: Extract<KnowledgeDocumentContextV1["locator"], {
        kind: "table_row_projection";
      }>;
    }>;
    row: T;
  }>>;
  projected.sort((left, right) =>
    left.context.locator.projectionIndex - right.context.locator.projectionIndex);
  if (!isCompleteKnowledgeTableRowProjectionSequence(
    projected.map(({ context }) => context.locator)
  )) return null;
  return Object.freeze(projected.map(({ row }) => row));
}

export function createPrismaKnowledgeRetrievalStore(
  client: RetrievalPrisma
): KnowledgeRetrievalStore {
  const hierarchical = createPrismaKnowledgeHierarchicalRetrievalRepository(client);
  return {
    async budgetState(input): Promise<KnowledgeBudgetState | null> {
      const expectedToolName = operationToolNames[input.operation];
      const toolNames = Prisma.sql`ARRAY[${Prisma.join(
        [...KNOWLEDGE_EXECUTION_TOOL_NAMES]
      )}]::text[]`;
      const [summaryRows, scope, receipts] = await Promise.all([
        client.$queryRaw<Array<{
          invocationOrdinal: number;
          operations: number;
        }>>(Prisma.sql`
          SELECT
            count(preceding."id")::integer AS "invocationOrdinal",
            count(preceding."id")::integer AS operations
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
            candidateCount: true,
            durationMs: true,
            embeddingUsage: true,
            invocationOrdinal: true,
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
      let retrievedTokens = 0;
      let totalEmbeddingTokens = 0;
      const priorContentHashes: string[] = [];
      for (const receipt of receipts) {
        cumulativeCandidates += receipt.candidateCount;
        latencyMs += receipt.durationMs;
        const usage = Array.isArray(receipt.embeddingUsage) ? receipt.embeddingUsage : [];
        queryEmbeddingCalls += usage.length;
        totalEmbeddingTokens += embeddingTokens(usage);
        const result = resultMetrics(receipt.results);
        evidenceCount += Array.isArray(receipt.results) ? receipt.results.length : 0;
        retrievedTokens += result.retrievedTokens;
        priorContentHashes.push(...result.contentHashes);
      }
      const usage: KnowledgeBudgetUsage = {
        cumulativeCandidates,
        estimatedCostMicros: estimatedKnowledgeEmbeddingCostMicros(
          policy,
          totalEmbeddingTokens
        ),
        latencyMs,
        operations: summary.operations,
        queryEmbeddingCalls,
        retrievedTokens
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
        resultLimit: input.resultLimit,
        runId: input.runId,
        ...(input.sourceIds ? { sourceIds: input.sourceIds } : {}),
        userId: input.userId,
        vectors: input.vectors
      });
      return {
        bindingCount: result.bindingCount,
        candidateCount: result.candidateCount,
        candidateCounts: result.candidateCounts,
        canonicalSourceProvenance: result.canonicalSourceProvenance,
        passages: result.passages.map((passage): KnowledgeHybridPassage => ({
          annRank: passage.annRank,
          baseName: passage.baseName,
          bindingOrdinal: passage.bindingOrdinal,
          chunkId: passage.chunkId,
          chunkIndex: passage.chunkIndex,
          contentHash: passage.contentHash,
          documentId: passage.documentId,
          ...(passage.documentContext ? { documentContext: passage.documentContext } : {}),
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
          sectionId: passage.sectionId,
          signalProvenance: passage.signals,
          sourceArtifactId: passage.sourceArtifactId,
          sourceName: passage.sourceName,
          text: passage.text,
          vectorDistance: passage.vectorDistance,
          vectorScore: passage.vectorScore
        })),
        rankingEvidence: result.rankingEvidence,
        vectorSearchEvidence:
          input.operation === "find_exact" || input.operation === "discover_sources"
            ? []
            : result.vectorSearchEvidence
      };
    },
    async findExact(input): Promise<KnowledgeExactSearchResult> {
      const sourceBindings = await client.knowledgeRunSourceBinding.findMany({
        orderBy: { ordinal: "asc" },
        select: {
          fileNameSnapshot: true,
          profileBinding: { select: { id: true, ordinal: true } },
          sourceAlias: true,
          sourceArtifactId: true,
          sourceId: true,
          sourceNameSnapshot: true,
          sourceVersionId: true,
          sourceVersionNumber: true
        },
        where: {
          modelRun: { id: input.runId, userId: input.userId },
          readinessState: "ready",
          sourceArtifactId: { in: [...input.sourceArtifactIds], not: null },
          sourceId: { not: null },
          sourceVersionId: { not: null },
          tombstonedAt: null
        }
      });
      const byArtifact = new Map(sourceBindings.flatMap((binding) =>
        binding.sourceArtifactId ? [[binding.sourceArtifactId, binding] as const] : []));
      if (byArtifact.size !== input.sourceArtifactIds.length ||
        input.sourceArtifactIds.some((artifactId) => !byArtifact.has(artifactId))) {
        throw new Error("knowledge_exact_scope_invalid");
      }
      const page = await hierarchical.findExact({
        caseSensitive: input.request.caseMode === "sensitive",
        ...(input.request.cursor ? { cursor: input.request.cursor } : {}),
        field: input.request.field,
        limit: input.request.limit,
        operation: input.request.match === "pattern" ? "regex" : input.request.match,
        query: input.request.value,
        runId: input.runId,
        scopeKind: "admitted_run",
        sourceArtifactIds: input.sourceArtifactIds,
        userId: input.userId
      });
      const directPassageIds = [...new Set(page.results.flatMap((hit) =>
        hit.passageId ? [hit.passageId] : []))];
      const fallbackIndexIds = [...new Set(page.results.flatMap((hit) =>
        hit.passageId ? [] : [hit.indexArtifactId]))];
      const passageSelect = {
        contentHash: true,
        contextPrefix: true,
        documentContext: true,
        fileName: true,
        headingPath: true,
        id: true,
        indexArtifactId: true,
        ordinal: true,
        page: true,
        sectionId: true,
        sourceName: true,
        text: true
      } satisfies Prisma.KnowledgeArtifactPassageIndexSelect;
      const [directPassages, fallbackPassages] = await Promise.all([
        directPassageIds.length > 0
          ? client.knowledgeArtifactPassageIndex.findMany({
              select: passageSelect,
              where: { id: { in: directPassageIds } }
            })
          : [],
        fallbackIndexIds.length > 0
          ? client.knowledgeArtifactPassageIndex.findMany({
              distinct: ["indexArtifactId"],
              orderBy: [{ indexArtifactId: "asc" }, { ordinal: "asc" }],
              select: passageSelect,
              where: { indexArtifactId: { in: fallbackIndexIds } }
            })
          : []
      ]);
      const directById = new Map(directPassages.map((passage) => [passage.id, passage]));
      const fallbackByIndex = new Map(fallbackPassages.map((passage) => [
        passage.indexArtifactId,
        passage
      ]));
      const passages: KnowledgeHybridPassage[] = [];
      const fields: Array<KnowledgeExactSearchResult["fields"][number]> = [];
      const seen = new Set<string>();
      for (const hit of page.results) {
        const binding = byArtifact.get(hit.sourceArtifactId);
        const anchor = hit.passageId
          ? directById.get(hit.passageId)
          : fallbackByIndex.get(hit.indexArtifactId);
        if (!binding || !binding.sourceArtifactId || !binding.sourceId ||
          !binding.sourceVersionId || !binding.sourceNameSnapshot ||
          !binding.fileNameSnapshot || !anchor) continue;
        const identity = `${binding.sourceArtifactId}\u0000${anchor.id}`;
        if (seen.has(identity)) continue;
        seen.add(identity);
        // Metadata exact hits borrow the first passage only as a stable Source
        // anchor. Its row/form context is unrelated to the matched metadata and
        // must not become grounding evidence for that hit.
        const documentContext = hit.field === "body"
          ? passageDocumentContext(anchor.documentContext)
          : null;
        passages.push(Object.freeze({
          annRank: null,
          baseName: "Pinned Knowledge Profile",
          bindingOrdinal: binding.profileBinding.ordinal,
          chunkId: anchor.id,
          chunkIndex: anchor.ordinal,
          contentHash: anchor.contentHash.trim(),
          documentId: binding.sourceId,
          documentVersionId: binding.sourceVersionId,
          documentVersionNumber: binding.sourceVersionNumber,
          ...(documentContext ? { documentContext } : {}),
          fileName: binding.fileNameSnapshot,
          ftsRank: null,
          ftsScore: null,
          fusedScore: 0,
          headingPath: anchor.headingPath,
          knowledgeBaseId: binding.profileBinding.id,
          layoutKind: hit.field === "body"
            ? passageLayoutKind(anchor.contextPrefix, documentContext)
            : "body",
          page: hit.page ?? anchor.page,
          sectionId: hit.sectionId ?? anchor.sectionId,
          sourceArtifactId: binding.sourceArtifactId,
          sourceName: binding.sourceNameSnapshot,
          text: hit.field === "body" ? anchor.text : hit.value,
          vectorDistance: null,
          vectorScore: null
        }));
        fields.push(hit.field);
      }
      const bindingOrdinals = [...new Set(sourceBindings.map((binding) =>
        binding.profileBinding.ordinal))];
      const candidateCounts = Object.fromEntries(bindingOrdinals.map((ordinal) => [
        ordinal,
        passages.filter((passage) => passage.bindingOrdinal === ordinal).length
      ]));
      return Object.freeze({
        bindingCount: bindingOrdinals.length,
        candidateCount: passages.length,
        candidateCounts,
        fields: Object.freeze(fields),
        nextCursor: page.nextCursor,
        passages: Object.freeze(passages),
        scannedBytes: page.scannedBytes,
        scanTruncated: page.scanTruncated
      });
    },
    async discoverSources(input): Promise<KnowledgeSourceDiscoveryResult> {
      const sourceBindings = await client.knowledgeRunSourceBinding.findMany({
        orderBy: { ordinal: "asc" },
        select: {
          fileNameSnapshot: true,
          profileBinding: { select: { ordinal: true } },
          sourceAlias: true,
          sourceArtifactId: true,
          sourceNameSnapshot: true,
          sourceVersionNumber: true
        },
        where: {
          modelRun: { id: input.runId, userId: input.userId },
          readinessState: "ready",
          sourceArtifactId: { in: [...input.sourceArtifactIds], not: null },
          sourceId: { not: null },
          sourceVersionId: { not: null },
          tombstonedAt: null
        }
      });
      const byArtifact = new Map(sourceBindings.flatMap((binding) =>
        binding.sourceArtifactId ? [[binding.sourceArtifactId, binding] as const] : []));
      if (byArtifact.size !== input.sourceArtifactIds.length ||
        input.sourceArtifactIds.some((artifactId) => !byArtifact.has(artifactId))) {
        throw new Error("knowledge_discovery_scope_invalid");
      }
      const metadataPage = await hierarchical.discoverSourceMetadata({
        ...(input.request.cursor ? { cursor: input.request.cursor } : {}),
        fields: input.request.fields,
        limit: input.request.limit,
        query: input.request.query,
        runId: input.runId,
        scopeKind: "admitted_run",
        sourceArtifactIds: input.sourceArtifactIds,
        userId: input.userId
      });
      const ambiguous = input.request.cursor !== null || metadataPage.nextCursor !== null ||
        metadataPage.results.length > 1;
      const sources: KnowledgeDiscoveredSourceEvidence[] = [];
      for (const hit of metadataPage.results) {
        const binding = byArtifact.get(hit.sourceArtifactId);
        if (!binding || !binding.fileNameSnapshot || !binding.sourceNameSnapshot) continue;
        sources.push(Object.freeze({
          ambiguous,
          fileName: binding.fileNameSnapshot,
          matchedFields: hit.matchedFields,
          readiness: "ready",
          sourceAlias: binding.sourceAlias,
          sourceName: binding.sourceNameSnapshot,
          sourceVersionNumber: binding.sourceVersionNumber
        }));
      }
      const bindingOrdinals = [...new Set(sourceBindings.map((binding) =>
        binding.profileBinding.ordinal))];
      const candidateCounts = Object.fromEntries(bindingOrdinals.map((ordinal) => [
        ordinal,
        sources.filter((source) => {
          const artifact = [...byArtifact.entries()].find(([, binding]) =>
            binding.sourceAlias === source.sourceAlias);
          return artifact?.[1].profileBinding.ordinal === ordinal;
        }).length
      ]));
      return Object.freeze({
        bindingCount: bindingOrdinals.length,
        candidateCount: sources.length,
        candidateCounts,
        nextCursor: metadataPage.nextCursor,
        sources: Object.freeze(sources)
      });
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
      const target = input.read.target;
      const evidencePassageId = target.kind === "evidence_handle"
        ? await (async () => {
            const handle = decodeKnowledgeCitationHandle(target.handle)?.handle ?? null;
            if (!handle) return null;
            const item = await client.knowledgeEvidenceItem.findFirst({
              select: { passageId: true },
              where: {
                handle,
                retrievalSession: { modelRun: { id: input.runId, userId: input.userId } },
                sourceArtifactId: input.sourceArtifactId,
                state: "available"
              }
            });
            return item?.passageId ?? null;
          })()
        : target.kind === "passage" ? target.passageId : null;
      if (target.kind === "evidence_handle" && !evidencePassageId) return empty();
      const canonicalProfile = input.binding.executionScope === "profile";
      const artifact = await client.knowledgeSourceIndexArtifact.findFirst({
        select: {
          hierarchicalIndexes: {
            orderBy: { schemaVersion: "desc" },
            select: { id: true },
            take: 1,
            where: {
              state: "ready",
              ...(evidencePassageId
                ? { passageIndexes: { some: { id: evidencePassageId } } }
                : {})
            }
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
          ...(canonicalProfile
            ? {
                runSourceBindings: {
                  some: {
                    modelRun: { id: input.runId, userId: input.userId },
                    profileBindingId: input.binding.knowledgeBaseId,
                    readinessState: "ready",
                    sourceArtifactId: input.sourceArtifactId,
                    sourceId: input.sourceId,
                    tombstonedAt: null
                  }
                }
              }
            : {
                snapshotSources: {
                  some: {
                    artifactId: input.sourceArtifactId,
                    knowledgeBaseId: input.binding.knowledgeBaseId,
                    snapshotId: input.binding.knowledgeBaseSnapshotId,
                    sourceId: input.sourceId
                  }
                }
              })
        }
      });
      const indexArtifactId = artifact?.hierarchicalIndexes[0]?.id;
      if (!artifact || !indexArtifactId) return empty();

      let anchor: SourceReadAnchor | null = null;
      let exactRows: readonly SourceReadPassageRow[] | null = null;
      let containingHeadingPath: readonly string[] | null = null;
      const findExactTableRow = async (rowId: string) => {
        const rows = await client.knowledgeArtifactPassageIndex.findMany({
          orderBy: { ordinal: "asc" },
          select: SOURCE_READ_PASSAGE_SELECT,
          take: READ_SOURCE_MAX_WINDOW + 1,
          where: {
            documentContext: {
              equals: rowId,
              path: ["locator", "rowId"]
            },
            indexArtifactId
          }
        });
        return coherentSourceReadTableRow(rows, rowId);
      };
      if (target.kind === "evidence_handle") {
        if (evidencePassageId) {
          anchor = await client.knowledgeArtifactPassageIndex.findFirst({
            select: SOURCE_READ_ANCHOR_SELECT,
            where: { id: evidencePassageId, indexArtifactId }
          });
          const anchorContext = anchor
            ? passageDocumentContext(anchor.documentContext)
            : null;
          const anchorLocator = anchorContext?.locator;
          if (anchorLocator?.kind === "table_row" ||
            anchorLocator?.kind === "table_row_projection") {
            exactRows = await findExactTableRow(anchorLocator.rowId);
            if (!exactRows) return empty();
          }
        }
      } else if (target.kind === "page") {
        anchor = await client.knowledgeArtifactPassageIndex.findFirst({
          orderBy: { ordinal: "asc" },
          select: SOURCE_READ_ANCHOR_SELECT,
          where: { indexArtifactId, page: { lte: target.page }, pageEnd: { gte: target.page } }
        });
      } else if (target.kind === "heading") {
        const sections = await client.knowledgeArtifactSectionIndex.findMany({
          orderBy: { ordinal: "asc" },
          select: { id: true, passageStart: true },
          take: 2,
          where: {
            headingPath: { equals: [...target.headingPath] },
            indexArtifactId
          }
        });
        if (sections.length === 1) {
          anchor = await client.knowledgeArtifactPassageIndex.findFirst({
            select: SOURCE_READ_ANCHOR_SELECT,
            where: {
              indexArtifactId,
              ordinal: sections[0]!.passageStart,
              sectionId: sections[0]!.id
            }
          });
        }
      } else if (target.kind === "section") {
        const section = await client.knowledgeArtifactSectionIndex.findFirst({
          select: { id: true, passageStart: true },
          where: { id: target.sectionId, indexArtifactId }
        });
        if (section) {
          anchor = await client.knowledgeArtifactPassageIndex.findFirst({
            select: SOURCE_READ_ANCHOR_SELECT,
            where: {
              indexArtifactId,
              ordinal: section.passageStart,
              sectionId: section.id
            }
          });
        }
      } else if (target.kind === "passage") {
        anchor = await client.knowledgeArtifactPassageIndex.findFirst({
          select: SOURCE_READ_ANCHOR_SELECT,
          where: { id: target.passageId, indexArtifactId }
        });
      } else if (target.kind === "block") {
        const blocks = await client.knowledgeArtifactPassageIndex.findMany({
          orderBy: { ordinal: "asc" },
          select: SOURCE_READ_ANCHOR_SELECT,
          take: 2,
          where: { indexArtifactId, sourceBlockIds: { has: target.blockId } }
        });
        anchor = blocks.length === 1 ? blocks[0]! : null;
      } else if (target.kind === "row") {
        exactRows = await findExactTableRow(target.rowId);
      } else if (target.kind === "structured_range") {
        const ranges = await client.knowledgeArtifactSectionIndex.findMany({
          orderBy: { ordinal: "asc" },
          select: { headingPath: true, id: true, passageStart: true },
          take: SPREADSHEET_MAX_REGIONS_PER_SHEET + 1,
          where: {
            headingPath: { has: target.sheet },
            indexArtifactId
          }
        });
        if (ranges.length > SPREADSHEET_MAX_REGIONS_PER_SHEET) return empty();
        const containers = ranges.filter((range) =>
          range.headingPath.length === 2 && range.headingPath[0] === target.sheet &&
          readSourceA1RangeContains(range.headingPath[1]!, target.range));
        if (containers.length === 1) {
          const container = containers[0]!;
          anchor = await client.knowledgeArtifactPassageIndex.findFirst({
            select: SOURCE_READ_ANCHOR_SELECT,
            where: {
              indexArtifactId,
              ordinal: container.passageStart,
              sectionId: container.id
            }
          });
          containingHeadingPath = container.headingPath;
        }
      }
      if (exactRows) {
        const passages = exactRows.map((row, index): KnowledgeHybridPassage => {
          const rank = index + 1;
          const documentContext = passageDocumentContext(row.documentContext);
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
            ...(documentContext ? { documentContext } : {}),
            fileName: artifact.sourceVersion.fileName,
            ftsRank: rank,
            ftsScore: 1,
            fusedScore: 1 / (60 + rank),
            headingPath: row.headingPath,
            knowledgeBaseId: input.binding.knowledgeBaseId,
            layoutKind: passageLayoutKind(row.contextPrefix, documentContext),
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
      }
      if (!anchor) return empty();

      const before = input.read.direction === "after"
        ? 0
        : input.read.direction === "before"
          ? input.read.window - 1
          : Math.floor((input.read.window - 1) / 2);
      const after = input.read.direction === "before" ? 0 : input.read.window - before - 1;
      const anchorContext = passageDocumentContext(anchor.documentContext);
      const structureId = sourceReadStructureId(anchorContext);
      const rows = await client.knowledgeArtifactPassageIndex.findMany({
        orderBy: { ordinal: "asc" },
        select: SOURCE_READ_PASSAGE_SELECT,
        take: input.read.window,
        where: {
          indexArtifactId,
          sectionId: anchor.sectionId,
          ...(structureId ? { sourceBlockIds: { has: structureId } } : {}),
          ...(containingHeadingPath
            ? { headingPath: { equals: [...containingHeadingPath] } }
            : {}),
          ordinal: {
            gte: Math.max(0, anchor.ordinal - before),
            lte: anchor.ordinal + after
          }
        }
      });
      const passages = rows.map((row, index): KnowledgeHybridPassage => {
        const rank = index + 1;
        const documentContext = passageDocumentContext(row.documentContext);
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
          ...(documentContext ? { documentContext } : {}),
          fileName: artifact.sourceVersion.fileName,
          ftsRank: rank,
          ftsScore: 1,
          fusedScore: 1 / (60 + rank),
          headingPath: row.headingPath,
          knowledgeBaseId: input.binding.knowledgeBaseId,
          layoutKind: passageLayoutKind(row.contextPrefix, documentContext),
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
    async loadReceipt(input) {
      const receipt = await client.knowledgeRun.findFirst({
        select: {
          baseEvidence: true,
          budgetEvidence: true,
          candidateCount: true,
          candidateLimit: true,
          durationMs: true,
          embeddingUsage: true,
          failureCode: true,
          fusion: true,
          invocationOrdinal: true,
          operation: true,
          outcome: true,
          providerText: true,
          query: true,
          readReceipt: true,
          resultLimit: true,
          results: true,
        },
        where: {
          modelRun: { id: input.runId, userId: input.userId },
          modelRunId: input.runId,
          modelRunToolCallId: input.modelRunToolCallId
        }
      });
      if (!receipt || !Array.isArray(receipt.baseEvidence) ||
        !Array.isArray(receipt.results) || !Array.isArray(receipt.embeddingUsage)) return null;
      const baseAliases = receipt.baseEvidence.flatMap((value) => {
        if (!record(value) || !Number.isSafeInteger(value.ordinal) ||
          typeof value.baseName !== "string") return [];
        return [{
          alias: `B${Number(value.ordinal) + 1}`,
          kind: "base" as const,
          label: value.baseName
        }];
      });
      const sourceAliases = receipt.results.flatMap((value) => {
        if (!record(value) || typeof value.sourceAlias !== "string" ||
          typeof value.sourceName !== "string") return [];
        return [{
          alias: value.sourceAlias,
          kind: "source" as const,
          label: value.sourceName
        }];
      });
      const readResolvedSource = record(receipt.readReceipt) &&
        record(receipt.readReceipt.resolvedSource)
        ? receipt.readReceipt.resolvedSource
        : null;
      if (readResolvedSource && typeof readResolvedSource.sourceAlias === "string" &&
        typeof readResolvedSource.sourceName === "string") {
        sourceAliases.push({
          alias: readResolvedSource.sourceAlias,
          kind: "source",
          label: readResolvedSource.sourceName
        });
      }
      if (receipt.operation === "discover_sources" && record(receipt.readReceipt) &&
        Array.isArray(receipt.readReceipt.sources)) {
        for (const source of receipt.readReceipt.sources) {
          if (!record(source) || typeof source.sourceAlias !== "string" ||
            typeof source.sourceName !== "string") continue;
          sourceAliases.push({
            alias: source.sourceAlias,
            kind: "source",
            label: source.sourceName
          });
        }
      }
      const scopeAliases = [...new Map([...baseAliases, ...sourceAliases].map((alias) => [
        alias.alias,
        alias
      ])).values()];
      const budgetEvidence = record(receipt.budgetEvidence) &&
        Object.keys(receipt.budgetEvidence).length === 0
        ? undefined
        : receipt.budgetEvidence;
      const common = {
        bases: receipt.baseEvidence,
        budget: budgetEvidence,
        candidateCount: receipt.candidateCount,
        candidateLimit: receipt.candidateLimit,
        durationMs: receipt.durationMs,
        embeddingExecutions: receipt.embeddingUsage,
        ...(receipt.failureCode ? { failureCode: receipt.failureCode } : {}),
        fusion: receipt.fusion,
        invocationOrdinal: receipt.invocationOrdinal,
        operation: receipt.operation,
        outcome: receipt.outcome,
        providerText: receipt.providerText,
        query: receipt.query,
        resultLimit: receipt.resultLimit,
        results: receipt.results,
        scopeAliases
      };
      const operationReceipt = receipt.readReceipt === null
        ? {}
        : receipt.operation === "read_source"
          ? { read: receipt.readReceipt }
          : receipt.operation === "find_exact"
            ? { exact: receipt.readReceipt }
            : receipt.operation === "discover_sources"
              ? { discovery: receipt.readReceipt }
              : {};
      return decodeKnowledgeRetrievalEvidence({
        ...common,
        ...operationReceipt,
        version: KNOWLEDGE_RESULT_VERSION
      });
    },
    async loadBindings(input) {
      const profiles = await client.knowledgeRunProfileBinding.findMany({
        orderBy: { ordinal: "asc" },
        select: {
          embeddingConnectionId: true,
          embeddingCredentialId: true,
          embeddingCredentialSource: true,
          embeddingCredentialVersionId: true,
          embeddingExecutionSnapshot: true,
          embeddingProviderModelId: true,
          id: true,
          ordinal: true,
          profileRevisionId: true,
          sourceBindings: {
            orderBy: { ordinal: "asc" },
            select: { sourceId: true },
            where: {
              readinessState: "ready",
              sourceId: { not: null },
              tombstonedAt: null
            }
          },
          targetDimension: true,
          vectorSpaceFingerprint: true
        },
        where: {
          modelRun: { id: input.runId, userId: input.userId }
        }
      });
      if (profiles.length > 0) {
        return profiles.map((profile): KnowledgeAcceptedBinding => {
          const selectedSourceIds = profile.sourceBindings.flatMap((source) =>
            source.sourceId ? [source.sourceId] : []);
          if (selectedSourceIds.length === 0) {
            throw new Error("knowledge_run_source_binding_unavailable");
          }
          return {
            baseContentRevision: 0,
            baseName: "Pinned Knowledge Profile",
            embeddingConnectionId: profile.embeddingConnectionId,
            embeddingCredentialId: profile.embeddingCredentialId,
            embeddingCredentialSource: profile.embeddingCredentialSource,
            embeddingCredentialVersionId: profile.embeddingCredentialVersionId,
            embeddingExecutionSnapshot: profile.embeddingExecutionSnapshot,
            embeddingProviderModelId: profile.embeddingProviderModelId,
            executionScope: "profile",
            indexedContentRevision: 0,
            indexGenerationId: profile.profileRevisionId,
            includeWholeBase: false,
            knowledgeBaseId: profile.id,
            knowledgeBaseSnapshotId: profile.id,
            ordinal: profile.ordinal,
            profileRevisionId: profile.profileRevisionId,
            selectedSourceIds,
            targetDimension: profile.targetDimension as 1024 | 1536,
            vectorSpaceFingerprint: profile.vectorSpaceFingerprint.trim()
          };
        });
      }
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
        executionScope: "base",
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
      const canonicalSources = await client.knowledgeRunSourceBinding.findMany({
        orderBy: { ordinal: "asc" },
        select: {
          profileBinding: { select: { ordinal: true } },
          sourceAlias: true,
          sourceArtifactId: true,
          sourceId: true,
          sourceNameSnapshot: true,
          sourceVersionId: true
        },
        where: {
          modelRun: { id: input.runId, userId: input.userId },
          readinessState: "ready",
          sourceArtifactId: { not: null },
          sourceId: { not: null },
          sourceVersionId: { not: null },
          tombstonedAt: null
        }
      });
      if (canonicalSources.length > 0) {
        const acceptedSourceIds = new Set(canonicalSources.flatMap((source) =>
          source.sourceId ? [source.sourceId] : []));
        const baseRows = await client.knowledgeRunBinding.findMany({
          orderBy: { ordinal: "asc" },
          select: {
            includeWholeBase: true,
            knowledgeBase: { select: { name: true } },
            knowledgeBaseSnapshot: {
              select: { sources: { orderBy: { ordinal: "asc" }, select: { sourceId: true } } }
            },
            ordinal: true,
            profileBinding: { select: { ordinal: true } },
            selectedSourceIds: true
          },
          where: {
            modelRun: { id: input.runId, userId: input.userId },
            profileBindingId: { not: null }
          }
        });
        const baseAliases: KnowledgeScopeAlias[] = baseRows.flatMap((base) => {
          const profileOrdinal = base.profileBinding?.ordinal;
          if (!Number.isSafeInteger(profileOrdinal) || profileOrdinal === undefined ||
            profileOrdinal < 0 || profileOrdinal >= KNOWLEDGE_SCOPE_MAX_BINDINGS) return [];
          const selected = base.includeWholeBase
            ? base.knowledgeBaseSnapshot?.sources.map((source) => source.sourceId) ?? []
            : base.selectedSourceIds;
          const sourceIds = [...new Set(selected.filter((sourceId) =>
            acceptedSourceIds.has(sourceId)))].sort();
          if (sourceIds.length === 0) return [];
          return [{
            alias: `B${base.ordinal + 1}`,
            bindingOrdinal: profileOrdinal,
            bindingOrdinals: [profileOrdinal],
            kind: "base" as const,
            label: base.knowledgeBase.name,
            sourceIds
          }];
        });
        const sourceAliases: KnowledgeScopeAlias[] = canonicalSources.map((source) => {
          if (!source.sourceArtifactId || !source.sourceId || !source.sourceVersionId ||
            !source.sourceNameSnapshot) throw new Error("knowledge_scope_alias_invalid");
          return {
            alias: source.sourceAlias,
            bindingOrdinal: source.profileBinding.ordinal,
            bindingOrdinals: [source.profileBinding.ordinal],
            kind: "source",
            label: source.sourceNameSnapshot,
            sourceArtifactId: source.sourceArtifactId,
            sourceId: source.sourceId,
            sourceVersionId: source.sourceVersionId
          };
        });
        const aliases = [...baseAliases, ...sourceAliases];
        if (new Set(aliases.map((alias) => alias.alias)).size !== aliases.length) {
          throw new Error("knowledge_scope_alias_invalid");
        }
        return aliases;
      }
      const rows = await client.$queryRaw<Array<{
        alias: string;
        bindingOrdinal: number;
        bindingOrdinals: number[];
        kind: string;
        label: string;
        sourceArtifactId: string | null;
        sourceId: string | null;
        sourceVersionId: string | null;
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
        admitted_source_bindings AS MATERIALIZED (
          SELECT
            binding."ordinal" AS "bindingOrdinal",
            snapshot_source."ordinal" AS "sourceOrdinalInBase",
            snapshot_source."artifactId" AS "sourceArtifactId",
            snapshot_source."sourceId",
            snapshot_source."sourceVersionId",
            source."name" AS label
          FROM admitted_bindings AS binding
          INNER JOIN "KnowledgeBaseSnapshotSource" AS snapshot_source
            ON snapshot_source."snapshotId" = binding."knowledgeBaseSnapshotId"
           AND (
             binding."includeWholeBase" = true
             OR snapshot_source."sourceId" = ANY(binding."selectedSourceIds")
           )
          INNER JOIN "KnowledgeSource" AS source ON source."id" = snapshot_source."sourceId"
        ),
        admitted_sources AS MATERIALIZED (
          SELECT
            array_agg(source."bindingOrdinal" ORDER BY source."bindingOrdinal")::integer[]
              AS "bindingOrdinals",
            min(source."bindingOrdinal")::integer AS "bindingOrdinal",
            source."sourceArtifactId",
            source."sourceId",
            source."sourceVersionId",
            min(source.label) AS label,
            row_number() OVER (
              ORDER BY
                min(source."bindingOrdinal"),
                min(source."sourceOrdinalInBase"),
                source."sourceId",
                source."sourceVersionId",
                source."sourceArtifactId"
            )::integer AS "sourceOrdinal"
          FROM admitted_source_bindings AS source
          GROUP BY
            source."sourceArtifactId",
            source."sourceId",
            source."sourceVersionId"
        )
        SELECT
          ('B' || (binding."ordinal" + 1)::text) AS alias,
          binding."ordinal" AS "bindingOrdinal",
          ARRAY[binding."ordinal"]::integer[] AS "bindingOrdinals",
          'base'::text AS kind,
          binding."baseName" AS label,
          NULL::text AS "sourceArtifactId",
          NULL::text AS "sourceId",
          NULL::text AS "sourceVersionId"
        FROM admitted_bindings AS binding
        UNION ALL
        SELECT
          ('S' || source."sourceOrdinal"::text) AS alias,
          source."bindingOrdinal",
          source."bindingOrdinals",
          'source'::text AS kind,
          source.label,
          source."sourceArtifactId",
          source."sourceId",
          source."sourceVersionId"
        FROM admitted_sources AS source
        WHERE source."sourceOrdinal" <= 999
        ORDER BY "bindingOrdinal", kind, alias
      `);
      const aliases: KnowledgeScopeAlias[] = [];
      for (const row of rows) {
        const bindingOrdinalsValid = Array.isArray(row.bindingOrdinals) &&
          row.bindingOrdinals.length >= 1 &&
          row.bindingOrdinals.length <= KNOWLEDGE_SCOPE_MAX_BINDINGS &&
          row.bindingOrdinals.every((ordinal, index) =>
            Number.isSafeInteger(ordinal) && ordinal >= 0 &&
            ordinal < KNOWLEDGE_SCOPE_MAX_BINDINGS &&
            (index === 0 || ordinal > row.bindingOrdinals[index - 1]!));
        if (!/^[BS][1-9]\d{0,2}$/u.test(row.alias) ||
          !Number.isSafeInteger(row.bindingOrdinal) || row.bindingOrdinal < 0 ||
          row.bindingOrdinal >= KNOWLEDGE_SCOPE_MAX_BINDINGS ||
          !bindingOrdinalsValid || row.bindingOrdinals[0] !== row.bindingOrdinal ||
          row.kind !== "base" && row.kind !== "source" || !row.label ||
          (row.kind === "source" && (
            !row.sourceArtifactId || !row.sourceId || !row.sourceVersionId
          ))) {
          throw new Error("knowledge_scope_alias_invalid");
        }
        aliases.push({
          alias: row.alias,
          bindingOrdinal: row.bindingOrdinal,
          ...(row.kind === "source" ? { bindingOrdinals: row.bindingOrdinals } : {}),
          kind: row.kind,
          label: row.label,
          ...(row.sourceArtifactId ? { sourceArtifactId: row.sourceArtifactId } : {}),
          ...(row.sourceId ? { sourceId: row.sourceId } : {}),
          ...(row.sourceVersionId ? { sourceVersionId: row.sourceVersionId } : {})
        });
      }
      if (new Set(aliases.map((alias) => alias.alias)).size !== aliases.length) {
        throw new Error("knowledge_scope_alias_invalid");
      }
      return aliases;
    },
    async persistReceipt(input) {
      if (input.evidence.version !== KNOWLEDGE_RESULT_VERSION) {
        throw new Error("knowledge_legacy_receipt_write_forbidden");
      }
      if (input.evidence.outcome === "zero_above_threshold") {
        throw new Error("knowledge_legacy_outcome_write_forbidden");
      }
      const receiptCount = [
        input.evidence.read,
        input.evidence.exact,
        input.evidence.discovery
      ].filter((receipt) => receipt !== undefined).length;
      if ((input.evidence.operation === "read_source") !== Boolean(input.evidence.read) ||
        (input.evidence.operation === "find_exact") !== Boolean(input.evidence.exact) ||
        (input.evidence.operation === "discover_sources") !== Boolean(input.evidence.discovery) ||
        receiptCount > 1) {
        throw new Error("knowledge_operation_receipt_invalid");
      }
      if (input.evidence.postRerankOrder !== undefined ||
        input.evidence.preRerankOrder !== undefined ||
        input.evidence.rerankerBinding !== undefined || input.evidence.threshold !== undefined ||
        input.evidence.budget && (
          "noveltyRatio" in input.evidence.budget ||
          "lowNoveltyStreak" in input.evidence.budget.usage
        ) ||
        input.evidence.results.some((result) =>
          result.confidence !== undefined || result.rerankScore !== undefined)) {
        throw new Error("knowledge_legacy_ranking_write_forbidden");
      }
      if (input.evidence.results.some((result) =>
        result.structuredAnalysis !== undefined || result.visualAnalysis !== undefined)) {
        throw new Error("knowledge_historical_analysis_write_forbidden");
      }
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
        const focusedRequest = normalizedRequest
          ? decodeKnowledgeFocusedRequest(normalizedRequest.knowledgeFocusedRequest)
          : null;
        const scope = context?.knowledgeRunScope;
        if (!scope || !focusedRequest) throw new Error("knowledge_evidence_context_invalid");

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
            ...(excludedResources > 0 ? ["partial_readiness"] : [])
          ];
          session = await tx.knowledgeRetrievalSession.create({
            data: {
              citationContract: json(KNOWLEDGE_EVIDENCE_CITATION_CONTRACT),
              degradedFlags,
              id: randomUUID(),
              modelRunId: input.runId,
              originalIntent: json({ kind: "focused_v1", request: focusedRequest }),
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
        const basesByOrdinal = new Map(input.evidence.bases.map((base) => [base.ordinal, base]));
        const canonicalByIdentity = new Map(
          (input.canonicalSourceProvenance ?? []).map((entry) => [
            JSON.stringify([entry.sourceId, entry.sourceVersionId, entry.artifactId]),
            entry
          ])
        );
        if (canonicalByIdentity.size !== (input.canonicalSourceProvenance?.length ?? 0)) {
          throw new Error("knowledge_canonical_source_provenance_invalid");
        }
        const keyedResults = input.evidence.results.map((result) => {
          const source = result.sourceArtifactId
            ? sourceByArtifact.get(result.sourceArtifactId)
            : null;
          if (!source || result.documentId !== source.sourceId ||
            result.documentVersionId !== source.sourceVersionId || !result.sourceArtifactId) {
            throw new Error("knowledge_evidence_source_identity_unavailable");
          }
          const identityKey = JSON.stringify([
            source.sourceId,
            source.sourceVersionId,
            result.sourceArtifactId
          ]);
          const suppliedProvenance = canonicalByIdentity.get(identityKey);
          if (canonicalByIdentity.size > 0 && !suppliedProvenance) {
            throw new Error("knowledge_canonical_source_provenance_invalid");
          }
          const sourceProvenance = suppliedProvenance ?? {
            artifactId: result.sourceArtifactId,
            bindings: [{
              baseName: result.baseName,
              bindingOrdinal: result.bindingOrdinal,
              knowledgeBaseId: result.knowledgeBaseId
            }],
            primaryBindingOrdinal: result.bindingOrdinal,
            sourceId: source.sourceId,
            sourceVersionId: source.sourceVersionId
          };
          if (sourceProvenance.primaryBindingOrdinal !== result.bindingOrdinal ||
            sourceProvenance.bindings.length < 1 ||
            sourceProvenance.bindings.some((binding, index) => {
              const base = basesByOrdinal.get(binding.bindingOrdinal);
              return !base || base.knowledgeBaseId !== binding.knowledgeBaseId ||
                base.baseName !== binding.baseName || index > 0 &&
                  sourceProvenance.bindings[index - 1]!.bindingOrdinal >= binding.bindingOrdinal;
            })) {
            throw new Error("knowledge_canonical_source_provenance_invalid");
          }
          return {
            evidenceKey: knowledgeSourceEvidenceKey({
              documentVersionId: result.documentVersionId,
              excerpt: result.includedText,
              passageId: result.chunkId,
              sourceArtifactId: result.sourceArtifactId,
              sourceId: source.sourceId,
              sourceVersionId: source.sourceVersionId
            }),
            result,
            source,
            sourceProvenance
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
          sourceProvenance: (typeof keyedResults)[number]["sourceProvenance"];
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
                  ...(entry.result.documentContext
                    ? { documentContext: entry.result.documentContext }
                    : {}),
                  expanded: entry.result.textTruncated,
                  excerptBytes: entry.result.includedTextBytes,
                  ...(entry.result.layoutKind
                    ? { layoutKind: entry.result.layoutKind }
                    : {}),
                  sourceTextBytes: entry.result.sourceTextBytes
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
                locator: json({ page: entry.result.page }),
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
          evidenceItems.push({
            id: item.id,
            result: entry.result,
            resultOrdinal,
            sourceProvenance: entry.sourceProvenance
          });
        }
        const degradedFlags = new Set(session.degradedFlags);
        if (input.evidence.failureCode) degradedFlags.add(input.evidence.failureCode);
        if (input.evidence.outcome !== "complete") {
          degradedFlags.add(`retrieval_${input.evidence.outcome}`);
        }
        if (input.evidence.budget?.stopReason) degradedFlags.add("budget_exhausted");
        await tx.knowledgeRetrievalSession.update({
          data: {
            degradedFlags: [...degradedFlags].sort(),
            nextEvidenceOrdinal
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
            ...(input.budgetReservation
              ? {
                  budgetReservationId: input.budgetReservation.reservationId,
                  receiptVersion: 2
                }
              : {}),
            retrievalSessionId: session.id,
            operation: evidence.operation ?? "automatic_search",
            outcome: evidence.outcome,
            providerText: evidence.providerText,
            query: evidence.query,
            resultLimit: evidence.resultLimit,
            results: json(evidence.results),
            ...(evidence.read || evidence.exact || evidence.discovery
              ? {
                  readReceipt: json(evidence.read ?? evidence.exact ?? evidence.discovery)
                }
              : {}),
          }
        });
        if (evidenceItems.length > 0) {
          await tx.knowledgeRunEvidence.createMany({
            data: evidenceItems.map((item) => ({
              evidenceItemId: item.id,
              knowledgeRunId,
              resultOrdinal: item.resultOrdinal,
              retrievalProvenance: json({
                fusion: evidence.fusion,
                invocationOrdinal: evidence.invocationOrdinal,
                operation: evidence.operation ?? "automatic_search",
                signals: [...(item.result.signalProvenance ?? [])],
                source: {
                  artifactId: item.sourceProvenance.artifactId,
                  bindings: item.sourceProvenance.bindings.map((binding) => ({
                    baseName: binding.baseName,
                    bindingOrdinal: binding.bindingOrdinal,
                    knowledgeBaseId: binding.knowledgeBaseId
                  })),
                  primaryBindingOrdinal: item.sourceProvenance.primaryBindingOrdinal,
                  sourceId: item.sourceProvenance.sourceId,
                  sourceVersionId: item.sourceProvenance.sourceVersionId
                },
                version: KNOWLEDGE_STORED_EVIDENCE_PROVENANCE_VERSION
              })
            }))
          });
        }
        if (input.budgetReservation) {
          await settleKnowledgeBudgetReservationReceipt(tx, {
            actual: input.budgetReservation.actual,
            leaseToken: input.budgetReservation.leaseToken,
            modelRunToolCallId: input.modelRunToolCallId,
            operation: evidence.operation ?? "automatic_search",
            operationOrdinal: evidence.invocationOrdinal,
            receiptHash: memorySha256({
              evidence,
              modelRunToolCallId: input.modelRunToolCallId,
              reservationId: input.budgetReservation.reservationId,
              version: 2
            }),
            reservationId: input.budgetReservation.reservationId,
            runId: input.runId
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

import { Prisma, type PrismaClient } from "@prisma/client";
import {
  createAcceptedEmbeddingRuntime,
  type AcceptedEmbeddingRuntimeStore
} from "../providerRuntime/embeddingRuntime";
import type { ProviderConnectionConfiguration } from "../providers/providerConfiguration";
import type {
  KnowledgeAcceptedEmbeddingRuntime,
  KnowledgeEmbeddingRuntimeResolver,
  KnowledgeRetrievalStore
} from "./toolExecutor";
import type {
  KnowledgeAcceptedBinding,
  KnowledgeHybridPassage,
  KnowledgeHybridSearchResult,
  KnowledgeRetrievalEvidence
} from "./retrievalTypes";

type RetrievalPrisma = Pick<
  PrismaClient,
  | "$queryRaw"
  | "$transaction"
  | "knowledgeRun"
  | "knowledgeRunBinding"
  | "modelRunToolCall"
> & AcceptedEmbeddingRuntimeStore;

type BoundQueryVector = Readonly<{
  bindingOrdinal: number;
  indexGenerationId: string;
  knowledgeBaseId: string;
  targetDimension: 1024 | 1536;
  vector: readonly number[];
}>;

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function nullableFiniteNumber(value: unknown): number | null | undefined {
  return value === null ? null : finiteNumber(value) ?? undefined;
}

function nullableRank(value: unknown): number | null | undefined {
  if (value === null) return null;
  const rank = nonNegativeInteger(value);
  return rank !== null && rank >= 1 ? rank : undefined;
}

function decodedPassage(value: unknown): KnowledgeHybridPassage | null {
  if (!isRecord(value)) return null;
  const annRank = nullableRank(value.annRank);
  const bindingOrdinal = nonNegativeInteger(value.bindingOrdinal);
  const chunkIndex = nonNegativeInteger(value.chunkIndex);
  const documentVersionNumber = nonNegativeInteger(value.documentVersionNumber);
  const ftsRank = nullableRank(value.ftsRank);
  const ftsScore = nullableFiniteNumber(value.ftsScore);
  const fusedScore = finiteNumber(value.fusedScore);
  const page = nonNegativeInteger(value.page);
  const vectorDistance = nullableFiniteNumber(value.vectorDistance);
  const vectorScore = nullableFiniteNumber(value.vectorScore);
  const expectedFusedScore = (annRank === null || annRank === undefined ? 0 : 1 / (60 + annRank)) +
    (ftsRank === null || ftsRank === undefined ? 0 : 1 / (60 + ftsRank));
  if (
    annRank === undefined || bindingOrdinal === null || bindingOrdinal > 2 ||
    chunkIndex === null || documentVersionNumber === null || documentVersionNumber < 1 ||
    ftsRank === undefined || ftsScore === undefined ||
    fusedScore === null || fusedScore < 0 || page === null || page < 1 ||
    vectorDistance === undefined || vectorScore === undefined ||
    typeof value.baseName !== "string" || !value.baseName ||
    typeof value.chunkId !== "string" || !value.chunkId ||
    typeof value.documentId !== "string" || !value.documentId ||
    typeof value.documentVersionId !== "string" || !value.documentVersionId ||
    typeof value.fileName !== "string" || !value.fileName ||
    typeof value.knowledgeBaseId !== "string" || !value.knowledgeBaseId ||
    typeof value.text !== "string" || !value.text ||
    (annRank === null) !== (vectorDistance === null) ||
    (annRank === null) !== (vectorScore === null) ||
    (ftsRank === null) !== (ftsScore === null) ||
    vectorDistance !== null && (vectorDistance < 0 || vectorDistance > 2) ||
    vectorScore !== null && (vectorScore < -1 || vectorScore > 1 ||
      Math.abs(vectorScore - (1 - vectorDistance!)) > 1e-12) ||
    ftsScore !== null && ftsScore < 0 ||
    Math.abs(fusedScore - expectedFusedScore) > 1e-12
  ) return null;
  return {
    annRank,
    baseName: value.baseName,
    bindingOrdinal,
    chunkId: value.chunkId,
    chunkIndex,
    documentId: value.documentId,
    documentVersionId: value.documentVersionId,
    documentVersionNumber,
    fileName: value.fileName,
    ftsRank,
    ftsScore,
    fusedScore,
    knowledgeBaseId: value.knowledgeBaseId,
    page,
    text: value.text,
    vectorDistance,
    vectorScore
  };
}

function vectorValues(
  vectors: readonly BoundQueryVector[],
  dimension: 1024 | 1536
): Prisma.Sql {
  const selected = vectors.filter((entry) => entry.targetDimension === dimension);
  if (selected.length === 0) {
    return dimension === 1024
      ? Prisma.sql`SELECT NULL::integer, NULL::text, NULL::text, NULL::vector(1024) WHERE FALSE`
      : Prisma.sql`SELECT NULL::integer, NULL::text, NULL::text, NULL::vector(1536) WHERE FALSE`;
  }
  return Prisma.sql`VALUES ${Prisma.join(selected.map((entry) => {
    const serialized = `[${entry.vector.join(",")}]`;
    return dimension === 1024
      ? Prisma.sql`(${entry.bindingOrdinal}, ${entry.knowledgeBaseId}, ${entry.indexGenerationId}, ${serialized}::vector(1024))`
      : Prisma.sql`(${entry.bindingOrdinal}, ${entry.knowledgeBaseId}, ${entry.indexGenerationId}, ${serialized}::vector(1536))`;
  }))}`;
}

function scopedFtsBranches(vectors: readonly BoundQueryVector[]): Prisma.Sql {
  if (vectors.length === 0) throw new Error("knowledge_query_vector_invalid");
  return Prisma.join(vectors.map((entry) => Prisma.sql`
    SELECT
      ${entry.bindingOrdinal}::integer AS "ordinal",
      chunk."id" AS "chunkId",
      chunk."chunkIndex",
      chunk."page",
      chunk."text",
      chunk."knowledgeBaseId",
      chunk."documentVersionId",
      ts_rank_cd(chunk."searchVector", query_terms.query) AS "ftsScore"
    FROM "KnowledgeChunk" AS chunk
    CROSS JOIN query_terms
    WHERE chunk."knowledgeBaseId" = ${entry.knowledgeBaseId}
      AND chunk."indexGenerationId" = ${entry.indexGenerationId}
      AND chunk."searchVector" @@ query_terms.query
  `), " UNION ALL ");
}

/** One parameterized statement owns ACL binding, temporal revision fencing,
 * dimension-specific ANN, FTS, and reciprocal-rank fusion. Tool arguments can
 * supply only the query/vector for an accepted ordinal, never a base id. */
export function knowledgeHybridRetrievalSql(input: Readonly<{
  candidateLimit: number;
  query: string;
  resultLimit: number;
  runId: string;
  threshold: number;
  userId: string;
  vectors: readonly BoundQueryVector[];
}>): Prisma.Sql {
  const values1024 = vectorValues(input.vectors, 1024);
  const values1536 = vectorValues(input.vectors, 1536);
  const ftsBranches = scopedFtsBranches(input.vectors);
  return Prisma.sql`
    WITH
    input_1024("ordinal", "knowledgeBaseId", "indexGenerationId", "queryVector") AS (${values1024}),
    input_1536("ordinal", "knowledgeBaseId", "indexGenerationId", "queryVector") AS (${values1536}),
    bindings AS MATERIALIZED (
      SELECT
        binding."ordinal",
        binding."knowledgeBaseId",
        binding."indexGenerationId",
        binding."baseContentRevision",
        binding."targetDimension",
        base."name" AS "baseName"
      FROM "ModelRun" AS run
      INNER JOIN "KnowledgeRunBinding" AS binding
        ON binding."modelRunId" = run."id"
      INNER JOIN "KnowledgeBase" AS base
        ON base."id" = binding."knowledgeBaseId"
      WHERE run."id" = ${input.runId}
        AND run."userId" = ${input.userId}
        AND (
          EXISTS (SELECT 1 FROM input_1024 AS supplied
            WHERE supplied."ordinal" = binding."ordinal"
              AND supplied."knowledgeBaseId" = binding."knowledgeBaseId"
              AND supplied."indexGenerationId" = binding."indexGenerationId"
              AND binding."targetDimension" = 1024)
          OR EXISTS (SELECT 1 FROM input_1536 AS supplied
            WHERE supplied."ordinal" = binding."ordinal"
              AND supplied."knowledgeBaseId" = binding."knowledgeBaseId"
              AND supplied."indexGenerationId" = binding."indexGenerationId"
              AND binding."targetDimension" = 1536)
        )
    ),
    query_terms AS (
      SELECT websearch_to_tsquery('simple'::regconfig, ${input.query}) AS query
    ),
    ann_1024_raw AS (
      SELECT binding."ordinal", hit.*
      FROM bindings AS binding
      INNER JOIN input_1024 AS supplied ON supplied."ordinal" = binding."ordinal"
      CROSS JOIN LATERAL (
        SELECT
          chunk."id" AS "chunkId",
          chunk."chunkIndex",
          chunk."page",
          chunk."text",
          version."documentId",
          version."id" AS "documentVersionId",
          version."versionNumber" AS "documentVersionNumber",
          version."fileName",
          (chunk."embedding"::vector(1024) <=> supplied."queryVector") AS "vectorDistance"
        FROM "KnowledgeChunk" AS chunk
        INNER JOIN "KnowledgeDocumentVersion" AS version
          ON version."knowledgeBaseId" = chunk."knowledgeBaseId"
         AND version."id" = chunk."documentVersionId"
        WHERE chunk."knowledgeBaseId" = binding."knowledgeBaseId"
          AND chunk."indexGenerationId" = binding."indexGenerationId"
          AND chunk."embeddingDimension" = 1024
          AND version."visibleFromRevision" IS NOT NULL
          AND version."visibleFromRevision" <= binding."baseContentRevision"
        ORDER BY chunk."embedding"::vector(1024) <=> supplied."queryVector"
        LIMIT ${input.candidateLimit}
      ) AS hit
    ),
    ann_1536_raw AS (
      SELECT binding."ordinal", hit.*
      FROM bindings AS binding
      INNER JOIN input_1536 AS supplied ON supplied."ordinal" = binding."ordinal"
      CROSS JOIN LATERAL (
        SELECT
          chunk."id" AS "chunkId",
          chunk."chunkIndex",
          chunk."page",
          chunk."text",
          version."documentId",
          version."id" AS "documentVersionId",
          version."versionNumber" AS "documentVersionNumber",
          version."fileName",
          (chunk."embedding"::vector(1536) <=> supplied."queryVector") AS "vectorDistance"
        FROM "KnowledgeChunk" AS chunk
        INNER JOIN "KnowledgeDocumentVersion" AS version
          ON version."knowledgeBaseId" = chunk."knowledgeBaseId"
         AND version."id" = chunk."documentVersionId"
        WHERE chunk."knowledgeBaseId" = binding."knowledgeBaseId"
          AND chunk."indexGenerationId" = binding."indexGenerationId"
          AND chunk."embeddingDimension" = 1536
          AND version."visibleFromRevision" IS NOT NULL
          AND version."visibleFromRevision" <= binding."baseContentRevision"
        ORDER BY chunk."embedding"::vector(1536) <=> supplied."queryVector"
        LIMIT ${input.candidateLimit}
      ) AS hit
    ),
    ann_ranked AS (
      SELECT ann.*,
        row_number() OVER (
          PARTITION BY ann."ordinal"
          ORDER BY ann."vectorDistance", ann."chunkId"
        )::integer AS "annRank"
      FROM (
        SELECT * FROM ann_1024_raw
        UNION ALL
        SELECT * FROM ann_1536_raw
      ) AS ann
    ),
    fts_indexed AS MATERIALIZED (${ftsBranches}),
    fts_raw AS (
      SELECT
        indexed."ordinal",
        indexed."chunkId",
        indexed."chunkIndex",
        indexed."page",
        indexed."text",
        version."documentId",
        version."id" AS "documentVersionId",
        version."versionNumber" AS "documentVersionNumber",
        version."fileName",
        indexed."ftsScore"
      FROM fts_indexed AS indexed
      INNER JOIN bindings AS binding
        ON binding."ordinal" = indexed."ordinal"
       AND binding."knowledgeBaseId" = indexed."knowledgeBaseId"
      INNER JOIN "KnowledgeDocumentVersion" AS version
        ON version."knowledgeBaseId" = indexed."knowledgeBaseId"
       AND version."id" = indexed."documentVersionId"
      WHERE version."visibleFromRevision" IS NOT NULL
        AND version."visibleFromRevision" <= binding."baseContentRevision"
    ),
    fts_ranked_all AS (
      SELECT fts.*,
        row_number() OVER (
          PARTITION BY fts."ordinal"
          ORDER BY fts."ftsScore" DESC, fts."chunkId"
        )::integer AS "ftsRank"
      FROM fts_raw AS fts
    ),
    fts_ranked AS (
      SELECT *
      FROM fts_ranked_all
      WHERE "ftsRank" <= ${input.candidateLimit}
    ),
    scored AS MATERIALIZED (
      SELECT
        COALESCE(ann."ordinal", fts."ordinal") AS "bindingOrdinal",
        COALESCE(ann."chunkId", fts."chunkId") AS "chunkId",
        COALESCE(ann."chunkIndex", fts."chunkIndex") AS "chunkIndex",
        COALESCE(ann."page", fts."page") AS "page",
        COALESCE(ann."text", fts."text") AS "text",
        COALESCE(ann."documentId", fts."documentId") AS "documentId",
        COALESCE(ann."documentVersionId", fts."documentVersionId") AS "documentVersionId",
        COALESCE(ann."documentVersionNumber", fts."documentVersionNumber") AS "documentVersionNumber",
        COALESCE(ann."fileName", fts."fileName") AS "fileName",
        ann."vectorDistance",
        CASE WHEN ann."vectorDistance" IS NULL THEN NULL
          ELSE 1.0 - ann."vectorDistance" END AS "vectorScore",
        fts."ftsScore",
        ann."annRank",
        fts."ftsRank",
        COALESCE(1.0 / (60.0 + ann."annRank"), 0.0) +
          COALESCE(1.0 / (60.0 + fts."ftsRank"), 0.0) AS "fusedScore"
      FROM ann_ranked AS ann
      FULL OUTER JOIN fts_ranked AS fts
        ON fts."ordinal" = ann."ordinal" AND fts."chunkId" = ann."chunkId"
    ),
    selected AS MATERIALIZED (
      SELECT scored.*, binding."knowledgeBaseId", binding."baseName"
      FROM scored
      INNER JOIN bindings AS binding ON binding."ordinal" = scored."bindingOrdinal"
      WHERE scored."fusedScore" >= ${input.threshold}
      ORDER BY scored."fusedScore" DESC, scored."bindingOrdinal", scored."chunkId"
      LIMIT ${input.resultLimit}
    ),
    base_candidate_counts AS (
      SELECT binding."ordinal", count(scored."chunkId")::integer AS count
      FROM bindings AS binding
      LEFT JOIN scored ON scored."bindingOrdinal" = binding."ordinal"
      GROUP BY binding."ordinal"
    ),
    candidate_stats AS (
      SELECT
        COALESCE(sum(count), 0)::integer AS "candidateCount",
        COALESCE(jsonb_object_agg("ordinal"::text, count), '{}'::jsonb) AS "candidateCounts"
      FROM base_candidate_counts
    )
    SELECT
      (SELECT count(*)::integer FROM bindings) AS "bindingCount",
      candidate_stats."candidateCount",
      candidate_stats."candidateCounts",
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'annRank', selected."annRank",
          'baseName', selected."baseName",
          'bindingOrdinal', selected."bindingOrdinal",
          'chunkId', selected."chunkId",
          'chunkIndex', selected."chunkIndex",
          'documentId', selected."documentId",
          'documentVersionId', selected."documentVersionId",
          'documentVersionNumber', selected."documentVersionNumber",
          'fileName', selected."fileName",
          'ftsRank', selected."ftsRank",
          'ftsScore', selected."ftsScore",
          'fusedScore', selected."fusedScore",
          'knowledgeBaseId', selected."knowledgeBaseId",
          'page', selected."page",
          'text', selected."text",
          'vectorDistance', selected."vectorDistance",
          'vectorScore', selected."vectorScore"
        ) ORDER BY selected."fusedScore" DESC, selected."bindingOrdinal", selected."chunkId")
        FROM selected
      ), '[]'::jsonb) AS passages
    FROM candidate_stats
  `;
}

export function createPrismaKnowledgeRetrievalStore(
  client: RetrievalPrisma
): KnowledgeRetrievalStore {
  return {
    async hybridSearch(input): Promise<KnowledgeHybridSearchResult> {
      if (
        input.vectors.length < 1 || input.vectors.length > 3 ||
        input.vectors.some((entry) =>
          entry.bindingOrdinal < 0 || entry.bindingOrdinal > 2 ||
          !entry.knowledgeBaseId || !entry.indexGenerationId ||
          entry.vector.length !== entry.targetDimension ||
          entry.vector.some((value) => !Number.isFinite(value))) ||
        new Set(input.vectors.map((entry) => entry.bindingOrdinal)).size !== input.vectors.length
      ) throw new Error("knowledge_query_vector_invalid");
      const rows = await client.$queryRaw<Array<{
        bindingCount: number;
        candidateCount: number;
        candidateCounts: unknown;
        passages: unknown;
      }>>(knowledgeHybridRetrievalSql(input));
      const row = rows[0];
      if (!row || !isRecord(row.candidateCounts) || !Array.isArray(row.passages)) {
        throw new Error("knowledge_hybrid_result_invalid");
      }
      const bindingCount = nonNegativeInteger(row.bindingCount);
      const candidateCount = nonNegativeInteger(row.candidateCount);
      const candidateCounts: Record<number, number> = {};
      for (const [key, value] of Object.entries(row.candidateCounts)) {
        const ordinal = Number(key);
        const count = nonNegativeInteger(value);
        if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal > 2 || count === null) {
          throw new Error("knowledge_hybrid_result_invalid");
        }
        candidateCounts[ordinal] = count;
      }
      const passages = row.passages.map(decodedPassage);
      if (
        bindingCount === null || candidateCount === null ||
        passages.some((passage) => passage === null)
      ) throw new Error("knowledge_hybrid_result_invalid");
      return {
        bindingCount,
        candidateCount,
        candidateCounts,
        passages: passages as KnowledgeHybridPassage[]
      };
    },
    async invocationOrdinal(input) {
      const rows = await client.$queryRaw<Array<{ ordinal: number }>>(Prisma.sql`
        SELECT count(preceding."id")::integer AS ordinal
        FROM "ModelRunToolCall" AS target
        INNER JOIN "ModelRun" AS run ON run."id" = target."modelRunId"
        INNER JOIN "ModelRunToolCall" AS preceding
          ON preceding."modelRunId" = target."modelRunId"
         AND preceding."toolName" = ${input.toolName}
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
          knowledgeBase: { select: { name: true } },
          knowledgeBaseId: true,
          ordinal: true,
          targetDimension: true,
          vectorSpaceFingerprint: true
        },
        where: {
          modelRun: { id: input.runId, userId: input.userId }
        }
      });
      return rows.map((row): KnowledgeAcceptedBinding => ({
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
        knowledgeBaseId: row.knowledgeBaseId,
        ordinal: row.ordinal,
        targetDimension: row.targetDimension as 1024 | 1536,
        vectorSpaceFingerprint: row.vectorSpaceFingerprint.trim()
      }));
    },
    async persistReceipt(input) {
      await client.$transaction(async (tx) => {
        const call = await tx.modelRunToolCall.findFirst({
          select: { id: true },
          where: {
            id: input.modelRunToolCallId,
            modelRun: { id: input.runId, userId: input.userId },
            modelRunId: input.runId,
            toolName: "retrieve_knowledge"
          }
        });
        if (!call) throw new Error("knowledge_run_context_unavailable");
        const existing = await tx.knowledgeRun.findUnique({
          select: { id: true },
          where: { modelRunToolCallId: input.modelRunToolCallId }
        });
        if (existing) throw new Error("knowledge_receipt_already_exists");
        const evidence: KnowledgeRetrievalEvidence = input.evidence;
        await tx.knowledgeRun.create({
          data: {
            baseEvidence: json(evidence.bases),
            candidateCount: evidence.candidateCount,
            candidateLimit: evidence.candidateLimit,
            durationMs: evidence.durationMs,
            embeddingUsage: json(evidence.embeddingExecutions),
            failureCode: evidence.failureCode,
            fusion: evidence.fusion,
            invocationOrdinal: evidence.invocationOrdinal,
            modelRunId: input.runId,
            modelRunToolCallId: input.modelRunToolCallId,
            outcome: evidence.outcome,
            providerText: evidence.providerText,
            query: evidence.query,
            resultLimit: evidence.resultLimit,
            results: json(evidence.results),
            threshold: evidence.threshold
          }
        });
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

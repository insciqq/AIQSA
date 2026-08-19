import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { KNOWLEDGE_HIERARCHICAL_INDEX_VERSION, knowledgeExactNormalizedValue } from "./hierarchicalIndex";
import { KNOWLEDGE_SCOPE_MAX_BINDINGS } from "./retrievalTypes";
import {
  boundKnowledgeCandidates,
  fuseKnowledgeCandidates,
  rankKnowledgeCandidates,
  type KnowledgeCandidateReranker,
  type KnowledgeCandidateSignal,
  type KnowledgeRankingEvidence,
  type KnowledgeRetrievalCandidate,
  type KnowledgeRetrievalLane,
  type KnowledgeVectorSearchMode
} from "./retrievalRanking";

export const KNOWLEDGE_VECTOR_EXACT_MAX_ROWS = 512;
export const KNOWLEDGE_VECTOR_ANN_EF_SEARCH = 400;
export const KNOWLEDGE_VECTOR_ANN_MAX_SCAN_TUPLES = 100_000;
export const KNOWLEDGE_RETRIEVAL_POOL_MIN = 80;
export const KNOWLEDGE_RETRIEVAL_POOL_MAX = 100;
export const KNOWLEDGE_VECTOR_BUCKET_COUNT = 16;

type RetrievalCoreClient = Pick<PrismaClient, "$queryRaw" | "$transaction">;

type QueryVector = Readonly<{
  bindingOrdinal: number;
  indexGenerationId: string;
  knowledgeBaseId: string;
  targetDimension: 1_024 | 1_536;
  vector: readonly number[];
}>;

export type KnowledgeRetrievalScopeFilter = Readonly<{
  bindingOrdinals?: readonly number[];
  sourceIds?: readonly string[];
}>;

type ScopeRow = Readonly<{
  baseName: string;
  bindingOrdinal: number;
  eligibleRows: number;
  indexGenerationId: string;
  knowledgeBaseId: string;
  targetDimension: number;
}>;

type CandidateRow = Omit<KnowledgeRetrievalCandidate, "signals"> & Readonly<{
  exactKind: string | null;
  lane: KnowledgeRetrievalLane;
  laneRank: number;
  rawScore: number;
  vectorDistance: number | null;
  vectorMode: KnowledgeVectorSearchMode | null;
}>;

export type KnowledgeVectorSearchEvidence = Readonly<{
  bindingOrdinal: number;
  candidateCount: number;
  eligibleRows: number;
  mode: KnowledgeVectorSearchMode | "unavailable";
  scan: Readonly<{
    efSearch: number | null;
    iterativeScan: "strict_order" | null;
    maxScanTuples: number | null;
    retrievalBucket: number;
  }>;
  targetDimension: 1_024 | 1_536;
}>;

export type KnowledgeRetrievalCorePassage = KnowledgeRetrievalCandidate & Readonly<{
  annRank: number | null;
  confidence: number;
  ftsRank: number | null;
  ftsScore: number | null;
  fusedScore: number;
  rerankScore: number | null;
  vectorDistance: number | null;
  vectorScore: number | null;
}>;

export type KnowledgeRetrievalCoreResult = Readonly<{
  bindingCount: number;
  candidateCount: number;
  candidateCounts: Readonly<Record<number, number>>;
  passages: readonly KnowledgeRetrievalCorePassage[];
  rankingEvidence: KnowledgeRankingEvidence;
  vectorSearchEvidence: readonly KnowledgeVectorSearchEvidence[];
}>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function integer(value: unknown): number | null {
  return Number.isSafeInteger(value) ? Number(value) : null;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function retrievalBindingsSql(input: Readonly<{
  bindingOrdinals?: readonly number[];
  runId: string;
  sourceIds?: readonly string[];
  userId: string;
}>): Prisma.Sql {
  const bindingOrdinals = input.bindingOrdinals ?? [];
  const sourceIds = input.sourceIds ?? [];
  const bindingOrdinalArray = bindingOrdinals.length > 0
    ? Prisma.sql`ARRAY[${Prisma.join(bindingOrdinals)}]::integer[]`
    : Prisma.empty;
  const sourceIdArray = sourceIds.length > 0
    ? Prisma.sql`ARRAY[${Prisma.join(sourceIds)}]::text[]`
    : Prisma.empty;
  return Prisma.sql`
    SELECT
      binding."ordinal",
      binding."knowledgeBaseId",
      binding."knowledgeBaseSnapshotId",
      ${sourceIds.length > 0 ? Prisma.sql`false` : Prisma.sql`binding."includeWholeBase"`}
        AS "includeWholeBase",
      ${sourceIds.length > 0 ? sourceIdArray : Prisma.sql`binding."selectedSourceIds"`}
        AS "selectedSourceIds",
      binding."baseContentRevision",
      binding."indexGenerationId",
      binding."targetDimension",
      base."name" AS "baseName"
    FROM "ModelRun" AS run
    INNER JOIN "KnowledgeRunBinding" AS binding ON binding."modelRunId" = run."id"
    INNER JOIN "KnowledgeBase" AS base ON base."id" = binding."knowledgeBaseId"
    WHERE run."id" = ${input.runId}
      AND run."userId" = ${input.userId}
      ${bindingOrdinals.length > 0
        ? Prisma.sql`AND binding."ordinal" = ANY(${bindingOrdinalArray})`
        : Prisma.empty}
      ${sourceIds.length > 0 ? Prisma.sql`
        AND binding."knowledgeBaseSnapshotId" IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM "KnowledgeBaseSnapshotSource" AS requested_source
          WHERE requested_source."snapshotId" = binding."knowledgeBaseSnapshotId"
            AND requested_source."sourceId" = ANY(${sourceIdArray})
            AND (
              binding."includeWholeBase" = true
              OR requested_source."sourceId" = ANY(binding."selectedSourceIds")
            )
        )
      ` : Prisma.empty}
  `;
}

function scopedPassagesSql(): Prisma.Sql {
  return Prisma.sql`
    SELECT
      binding."baseName",
      binding."ordinal" AS "bindingOrdinal",
      binding."knowledgeBaseId",
      binding."indexGenerationId",
      binding."targetDimension",
      snapshot_source."sourceId" AS "documentId",
      snapshot_source."sourceVersionId" AS "documentVersionId",
      version."versionNumber" AS "documentVersionNumber",
      version."fileName",
      snapshot_source."artifactId" AS "sourceArtifactId",
      hierarchy."id" AS "indexArtifactId",
      passage."id" AS "chunkId",
      passage."ordinal" AS "chunkIndex",
      passage."sectionId",
      passage."page",
      passage."headingPath",
      CASE split_part(passage."contextPrefix", E'\n', 1)
        WHEN 'Evidence layout: table_ambiguous_v1' THEN 'table_ambiguous'::text
        WHEN 'Evidence layout: table_row_v1' THEN 'table_row'::text
        ELSE 'body'::text
      END AS "layoutKind",
      passage."contentHash",
      passage."sourceName",
      passage."text",
      passage."simpleSearchVector",
      passage."englishSearchVector",
      passage."russianSearchVector",
      embedding."embeddingDimension",
      embedding."embedding"
    FROM bindings AS binding
    INNER JOIN "KnowledgeBaseSnapshotSource" AS snapshot_source
      ON snapshot_source."snapshotId" = binding."knowledgeBaseSnapshotId"
     AND snapshot_source."knowledgeBaseId" = binding."knowledgeBaseId"
    INNER JOIN "KnowledgeSourceVersion" AS version
      ON version."id" = snapshot_source."sourceVersionId"
     AND version."sourceId" = snapshot_source."sourceId"
     AND version."ownerUserId" = snapshot_source."ownerUserId"
    INNER JOIN "KnowledgeSourceIndexArtifact" AS source_artifact
      ON source_artifact."id" = snapshot_source."artifactId"
     AND source_artifact."sourceVersionId" = snapshot_source."sourceVersionId"
     AND source_artifact."state" = 'ready'::"KnowledgeSourceArtifactState"
    INNER JOIN "KnowledgeHierarchicalIndexArtifact" AS hierarchy
      ON hierarchy."sourceArtifactId" = source_artifact."id"
     AND hierarchy."sourceVersionId" = source_artifact."sourceVersionId"
     AND hierarchy."state" = 'ready'::"KnowledgeHierarchicalIndexState"
     AND hierarchy."schemaVersion" = ${KNOWLEDGE_HIERARCHICAL_INDEX_VERSION}
    INNER JOIN "KnowledgeArtifactPassageIndex" AS passage
      ON passage."indexArtifactId" = hierarchy."id"
    LEFT JOIN "KnowledgeArtifactPassageEmbedding" AS embedding
      ON embedding."indexArtifactId" = passage."indexArtifactId"
     AND embedding."passageId" = passage."id"
    WHERE binding."knowledgeBaseSnapshotId" IS NOT NULL
      AND (
        binding."includeWholeBase" = true
        OR snapshot_source."sourceId" = ANY(binding."selectedSourceIds")
      )
  `;
}

export function knowledgeRetrievalScopeSql(input: Readonly<{
  bindingOrdinals?: readonly number[];
  runId: string;
  sourceIds?: readonly string[];
  userId: string;
}>): Prisma.Sql {
  const bindings = retrievalBindingsSql(input);
  const scopedPassages = scopedPassagesSql();
  return Prisma.sql`
    WITH
    bindings AS MATERIALIZED (${bindings}),
    scoped_passages AS MATERIALIZED (${scopedPassages})
    SELECT
      binding."ordinal" AS "bindingOrdinal",
      binding."knowledgeBaseId",
      binding."indexGenerationId",
      binding."targetDimension",
      binding."baseName",
      count(passage."chunkId") FILTER (
        WHERE passage."embedding" IS NOT NULL
          AND passage."embeddingDimension" = binding."targetDimension"
      )::integer AS "eligibleRows"
    FROM bindings AS binding
    LEFT JOIN scoped_passages AS passage
      ON passage."bindingOrdinal" = binding."ordinal"
    GROUP BY
      binding."ordinal",
      binding."knowledgeBaseId",
      binding."indexGenerationId",
      binding."targetDimension",
      binding."baseName"
    ORDER BY binding."ordinal"
  `;
}

function decodeScope(value: unknown): ScopeRow | null {
  if (!record(value)) return null;
  const bindingOrdinal = integer(value.bindingOrdinal);
  const eligibleRows = integer(value.eligibleRows);
  const targetDimension = integer(value.targetDimension);
  if (
    bindingOrdinal === null || bindingOrdinal < 0 ||
    bindingOrdinal >= KNOWLEDGE_SCOPE_MAX_BINDINGS ||
    eligibleRows === null || eligibleRows < 0 ||
    targetDimension !== 1_024 && targetDimension !== 1_536 ||
    typeof value.baseName !== "string" || !value.baseName ||
    typeof value.indexGenerationId !== "string" || !value.indexGenerationId ||
    typeof value.knowledgeBaseId !== "string" || !value.knowledgeBaseId
  ) return null;
  return {
    baseName: value.baseName,
    bindingOrdinal,
    eligibleRows,
    indexGenerationId: value.indexGenerationId,
    knowledgeBaseId: value.knowledgeBaseId,
    targetDimension
  };
}

function vectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(",")}]`;
}

export function knowledgeVectorRetrievalBucket(knowledgeBaseId: string): number {
  return createHash("md5").update(knowledgeBaseId).digest()[0]! % KNOWLEDGE_VECTOR_BUCKET_COUNT;
}

function vectorExpression(vector: QueryVector): Prisma.Sql {
  const literal = vectorLiteral(vector.vector);
  return vector.targetDimension === 1_024
    ? Prisma.sql`${literal}::vector(1024)`
    : Prisma.sql`${literal}::vector(1536)`;
}

function vectorDistanceExpression(vector: QueryVector, alias: string): Prisma.Sql {
  const queryVector = vectorExpression(vector);
  const row = Prisma.raw(alias);
  return vector.targetDimension === 1_024
    ? Prisma.sql`${row}."embedding"::vector(1024) <=> ${queryVector}`
    : Prisma.sql`${row}."embedding"::vector(1536) <=> ${queryVector}`;
}

export function knowledgeAdaptiveVectorSearchSql(input: Readonly<{
  bindingOrdinals?: readonly number[];
  candidateLimit: number;
  mode: KnowledgeVectorSearchMode;
  runId: string;
  sourceIds?: readonly string[];
  userId: string;
  vector: QueryVector;
}>): Prisma.Sql {
  const bindings = retrievalBindingsSql(input);
  const scopedPassages = scopedPassagesSql();
  const scopedDistance = vectorDistanceExpression(input.vector, "passage");
  const globalDistance = vectorDistanceExpression(input.vector, "embedding");
  const vectorHits = input.mode === "exact"
    ? Prisma.sql`
      scoped AS MATERIALIZED (
        SELECT passage."chunkId", ${scopedDistance} AS "vectorDistance"
        FROM scoped_passages AS passage
        WHERE passage."bindingOrdinal" = ${input.vector.bindingOrdinal}
          AND passage."knowledgeBaseId" = ${input.vector.knowledgeBaseId}
          AND passage."indexGenerationId" = ${input.vector.indexGenerationId}
          AND passage."targetDimension" = ${input.vector.targetDimension}
          AND passage."embeddingDimension" = ${input.vector.targetDimension}
          AND passage."embedding" IS NOT NULL
      ),
      vector_hits AS (
        SELECT * FROM scoped
        ORDER BY "vectorDistance", "chunkId"
        LIMIT ${input.candidateLimit}
      )
    `
    : Prisma.sql`
      vector_hits AS (
        SELECT embedding."passageId" AS "chunkId", ${globalDistance} AS "vectorDistance"
        FROM "KnowledgeArtifactPassageEmbedding" AS embedding
        INNER JOIN "KnowledgeArtifactPassageIndex" AS passage
          ON passage."indexArtifactId" = embedding."indexArtifactId"
         AND passage."id" = embedding."passageId"
        INNER JOIN "KnowledgeHierarchicalIndexArtifact" AS hierarchy
          ON hierarchy."id" = passage."indexArtifactId"
         AND hierarchy."state" = 'ready'::"KnowledgeHierarchicalIndexState"
         AND hierarchy."schemaVersion" = ${KNOWLEDGE_HIERARCHICAL_INDEX_VERSION}
        WHERE embedding."embeddingDimension" = ${input.vector.targetDimension}
          AND EXISTS (
            SELECT 1
            FROM bindings AS binding
            INNER JOIN "KnowledgeBaseSnapshotSource" AS snapshot_source
              ON snapshot_source."snapshotId" = binding."knowledgeBaseSnapshotId"
             AND snapshot_source."knowledgeBaseId" = binding."knowledgeBaseId"
            WHERE binding."ordinal" = ${input.vector.bindingOrdinal}
              AND binding."knowledgeBaseId" = ${input.vector.knowledgeBaseId}
              AND binding."indexGenerationId" = ${input.vector.indexGenerationId}
              AND binding."targetDimension" = ${input.vector.targetDimension}
              AND snapshot_source."artifactId" = hierarchy."sourceArtifactId"
              AND (
                binding."includeWholeBase" = true
                OR snapshot_source."sourceId" = ANY(binding."selectedSourceIds")
              )
          )
        ORDER BY ${globalDistance}
        LIMIT ${input.candidateLimit}
      )
    `;
  return Prisma.sql`
    WITH
    bindings AS MATERIALIZED (${bindings}),
    scoped_passages AS MATERIALIZED (${scopedPassages}),
    ${vectorHits},
    ranked AS (
      SELECT hit.*,
        row_number() OVER (ORDER BY hit."vectorDistance")::integer AS "laneRank"
      FROM vector_hits AS hit
    )
    SELECT
      binding."baseName",
      binding."ordinal" AS "bindingOrdinal",
      passage."chunkId",
      passage."chunkIndex",
      passage."contentHash",
      passage."documentId",
      passage."documentVersionId",
      passage."documentVersionNumber",
      passage."fileName",
      passage."headingPath",
      passage."layoutKind",
      binding."knowledgeBaseId",
      passage."page",
      passage."sectionId",
      passage."sourceArtifactId",
      passage."sourceName",
      passage."text",
      'passage_semantic'::text AS lane,
      ranked."laneRank",
      (1.0 - ranked."vectorDistance")::double precision AS "rawScore",
      NULL::text AS "exactKind",
      ranked."vectorDistance"::double precision AS "vectorDistance",
      ${input.mode}::text AS "vectorMode"
    FROM ranked
    INNER JOIN bindings AS binding
      ON binding."ordinal" = ${input.vector.bindingOrdinal}
    INNER JOIN scoped_passages AS passage
      ON passage."bindingOrdinal" = binding."ordinal"
     AND passage."chunkId" = ranked."chunkId"
    ORDER BY ranked."laneRank"
  `;
}

function lexicalRank(
  alias: string,
  strict = true
): Prisma.Sql {
  const row = Prisma.raw(alias);
  return Prisma.sql`GREATEST(
    ts_rank_cd(${row}."simpleSearchVector", query_terms."simpleQuery") +
      ${strict ? Prisma.sql`CASE WHEN ${row}."simpleSearchVector" @@ query_terms."simpleStrictQuery" THEN 1 ELSE 0 END` : Prisma.sql`0`},
    ts_rank_cd(${row}."englishSearchVector", query_terms."englishQuery") +
      ${strict ? Prisma.sql`CASE WHEN ${row}."englishSearchVector" @@ query_terms."englishStrictQuery" THEN 1 ELSE 0 END` : Prisma.sql`0`},
    ts_rank_cd(${row}."russianSearchVector", query_terms."russianQuery") +
      ${strict ? Prisma.sql`CASE WHEN ${row}."russianSearchVector" @@ query_terms."russianStrictQuery" THEN 1 ELSE 0 END` : Prisma.sql`0`}
  )`;
}

function lexicalMatch(alias: string): Prisma.Sql {
  const row = Prisma.raw(alias);
  return Prisma.sql`(
    ${row}."simpleSearchVector" @@ query_terms."simpleQuery"
    OR ${row}."englishSearchVector" @@ query_terms."englishQuery"
    OR ${row}."russianSearchVector" @@ query_terms."russianQuery"
  )`;
}

export function knowledgeMultiLaneLexicalSearchSql(input: Readonly<{
  bindingOrdinals?: readonly number[];
  candidateLimit: number;
  query: string;
  runId: string;
  sourceIds?: readonly string[];
  userId: string;
}>): Prisma.Sql {
  const bindings = retrievalBindingsSql(input);
  const scopedPassages = scopedPassagesSql();
  const normalizedQuery = knowledgeExactNormalizedValue(input.query);
  const passageRank = lexicalRank("chunk");
  const passageMatch = lexicalMatch("chunk");
  const sectionRank = lexicalRank("section");
  const sectionMatch = lexicalMatch("section");
  const documentRank = lexicalRank("document_index");
  const documentMatch = lexicalMatch("document_index");
  return Prisma.sql`
    WITH
    bindings AS MATERIALIZED (${bindings}),
    scoped_chunks AS MATERIALIZED (${scopedPassages}),
    query_terms AS (
      SELECT
        websearch_to_tsquery('simple'::regconfig, ${input.query}) AS "simpleStrictQuery",
        websearch_to_tsquery('english'::regconfig, ${input.query}) AS "englishStrictQuery",
        websearch_to_tsquery('russian'::regconfig, ${input.query}) AS "russianStrictQuery",
        to_tsquery('simple'::regconfig,
          replace(plainto_tsquery('simple'::regconfig, ${input.query})::text, ' & ', ' | ')
        ) AS "simpleQuery",
        to_tsquery('english'::regconfig,
          replace(plainto_tsquery('english'::regconfig, ${input.query})::text, ' & ', ' | ')
        ) AS "englishQuery",
        to_tsquery('russian'::regconfig,
          replace(plainto_tsquery('russian'::regconfig, ${input.query})::text, ' & ', ' | ')
        ) AS "russianQuery"
    ),
    passage_raw AS (
      SELECT chunk.*, 'passage_lexical'::text AS lane,
        ${passageRank}::double precision AS "rawScore",
        NULL::text AS "exactKind"
      FROM scoped_chunks AS chunk
      CROSS JOIN query_terms
      WHERE ${passageMatch}
    ),
    section_raw AS (
      SELECT chunk.*, 'section_lexical'::text AS lane,
        ${sectionRank}::double precision AS "rawScore",
        NULL::text AS "exactKind"
      FROM scoped_chunks AS chunk
      INNER JOIN "KnowledgeArtifactSectionIndex" AS section
        ON section."indexArtifactId" = chunk."indexArtifactId"
       AND section."id" = chunk."sectionId"
       AND section."passageStart" = chunk."chunkIndex"
      CROSS JOIN query_terms
      WHERE ${sectionMatch}
    ),
    document_raw AS (
      SELECT chunk.*, 'document_lexical'::text AS lane,
        ${documentRank}::double precision AS "rawScore",
        NULL::text AS "exactKind"
      FROM scoped_chunks AS chunk
      INNER JOIN "KnowledgeArtifactDocumentIndex" AS document_index
        ON document_index."indexArtifactId" = chunk."indexArtifactId"
       AND chunk."chunkIndex" = 0
      CROSS JOIN query_terms
      WHERE ${documentMatch}
    ),
    exact_raw AS (
      SELECT chunk.*, 'exact'::text AS lane,
        1.0::double precision AS "rawScore",
        entry."kind"::text AS "exactKind"
      FROM scoped_chunks AS chunk
      INNER JOIN "KnowledgeArtifactExactEntry" AS entry
        ON entry."indexArtifactId" = chunk."indexArtifactId"
       AND (
         entry."passageId" = chunk."chunkId"
         OR (entry."passageId" IS NULL AND entry."sectionId" = chunk."sectionId"
           AND chunk."chunkIndex" = (
             SELECT min(section_passage."ordinal")
             FROM "KnowledgeArtifactPassageIndex" AS section_passage
             WHERE section_passage."indexArtifactId" = entry."indexArtifactId"
               AND section_passage."sectionId" = entry."sectionId"
           ))
         OR (entry."passageId" IS NULL AND entry."sectionId" IS NULL
           AND chunk."chunkIndex" = 0)
       )
      WHERE char_length(entry."normalizedValue") >= 3
        AND strpos(${normalizedQuery}, entry."normalizedValue") > 0
    ),
    metadata_raw AS (
      SELECT chunk.*, 'metadata'::text AS lane,
        word_similarity(entry."normalizedValue", ${normalizedQuery})::double precision AS "rawScore",
        entry."kind"::text AS "exactKind"
      FROM scoped_chunks AS chunk
      INNER JOIN "KnowledgeArtifactExactEntry" AS entry
        ON entry."indexArtifactId" = chunk."indexArtifactId"
       AND entry."passageId" IS NULL
       AND chunk."chunkIndex" = 0
      WHERE entry."kind" IN (
        'filename'::"KnowledgeExactEntryKind",
        'heading'::"KnowledgeExactEntryKind",
        'tag'::"KnowledgeExactEntryKind",
        'title'::"KnowledgeExactEntryKind"
      )
        AND word_similarity(entry."normalizedValue", ${normalizedQuery}) >= 0.45
    ),
    lane_rows AS (
      SELECT * FROM passage_raw
      UNION ALL SELECT * FROM section_raw
      UNION ALL SELECT * FROM document_raw
      UNION ALL SELECT * FROM exact_raw
      UNION ALL SELECT * FROM metadata_raw
    ),
    ranked AS (
      SELECT lane_rows.*,
        row_number() OVER (
          PARTITION BY "bindingOrdinal", lane
          ORDER BY "rawScore" DESC, "chunkId", COALESCE("exactKind", '')
        )::integer AS "laneRank"
      FROM lane_rows
    )
    SELECT
      ranked."baseName",
      ranked."bindingOrdinal",
      ranked."chunkId",
      ranked."chunkIndex",
      ranked."contentHash",
      ranked."documentId",
      ranked."documentVersionId",
      ranked."documentVersionNumber",
      ranked."fileName",
      ranked."headingPath",
      ranked."layoutKind",
      ranked."knowledgeBaseId",
      ranked."page",
      ranked."sectionId",
      ranked."sourceArtifactId",
      ranked."sourceName",
      ranked."text",
      ranked.lane,
      ranked."laneRank",
      ranked."rawScore",
      ranked."exactKind",
      NULL::double precision AS "vectorDistance",
      NULL::text AS "vectorMode"
    FROM ranked
    WHERE ranked."laneRank" <= ${input.candidateLimit}
    ORDER BY ranked."bindingOrdinal", ranked.lane, ranked."laneRank"
  `;
}

function knowledgeNeighborExpansionSql(input: Readonly<{
  anchors: readonly Readonly<{ bindingOrdinal: number; chunkId: string; rank: number }>[];
  bindingOrdinals?: readonly number[];
  runId: string;
  sourceIds?: readonly string[];
  userId: string;
}>): Prisma.Sql {
  const bindings = retrievalBindingsSql(input);
  const scopedPassages = scopedPassagesSql();
  const anchors = Prisma.join(input.anchors.map((anchor) => Prisma.sql`(
    ${anchor.bindingOrdinal}::integer,
    ${anchor.chunkId}::text,
    ${anchor.rank}::integer
  )`));
  return Prisma.sql`
    WITH
    bindings AS MATERIALIZED (${bindings}),
    scoped_passages AS MATERIALIZED (${scopedPassages}),
    anchors("bindingOrdinal", "chunkId", "anchorRank") AS (VALUES ${anchors}),
    expanded AS (
      SELECT
        neighbor."baseName",
        neighbor."bindingOrdinal",
        neighbor."chunkId",
        neighbor."chunkIndex",
        neighbor."contentHash",
        neighbor."documentId",
        neighbor."documentVersionId",
        neighbor."documentVersionNumber",
        neighbor."fileName",
        neighbor."headingPath",
        neighbor."layoutKind",
        neighbor."knowledgeBaseId",
        neighbor."page",
        neighbor."sectionId",
        neighbor."sourceArtifactId",
        neighbor."sourceName",
        neighbor."text",
        'neighbor'::text AS lane,
        row_number() OVER (
          ORDER BY anchor."anchorRank", abs(neighbor."chunkIndex" - source."chunkIndex"), neighbor."chunkId"
        )::integer AS "laneRank",
        (1.0 / (1 + anchor."anchorRank" + abs(neighbor."chunkIndex" - source."chunkIndex")))::double precision AS "rawScore",
        NULL::text AS "exactKind",
        NULL::double precision AS "vectorDistance",
        NULL::text AS "vectorMode"
      FROM anchors AS anchor
      INNER JOIN scoped_passages AS source
        ON source."bindingOrdinal" = anchor."bindingOrdinal"
       AND source."chunkId" = anchor."chunkId"
      INNER JOIN scoped_passages AS neighbor
        ON neighbor."bindingOrdinal" = source."bindingOrdinal"
       AND neighbor."indexArtifactId" = source."indexArtifactId"
       AND abs(neighbor."chunkIndex" - source."chunkIndex") = 1
    )
    SELECT * FROM expanded
    ORDER BY "laneRank"
    LIMIT 16
  `;
}

const lanes = new Set<KnowledgeRetrievalLane>([
  "document_lexical",
  "exact",
  "metadata",
  "neighbor",
  "passage_lexical",
  "passage_semantic",
  "section_lexical"
]);

function decodeCandidateRow(value: unknown): CandidateRow | null {
  if (!record(value)) return null;
  const bindingOrdinal = integer(value.bindingOrdinal);
  const chunkIndex = integer(value.chunkIndex);
  const documentVersionNumber = integer(value.documentVersionNumber);
  const laneRank = integer(value.laneRank);
  const page = integer(value.page);
  const rawScore = finite(value.rawScore);
  const vectorDistance = value.vectorDistance === null ? null : finite(value.vectorDistance);
  if (
    bindingOrdinal === null || bindingOrdinal < 0 ||
    bindingOrdinal >= KNOWLEDGE_SCOPE_MAX_BINDINGS ||
    chunkIndex === null || chunkIndex < 0 || documentVersionNumber === null ||
    documentVersionNumber < 1 || laneRank === null || laneRank < 1 ||
    page === null || page < 1 || rawScore === null ||
    typeof value.lane !== "string" || !lanes.has(value.lane as KnowledgeRetrievalLane) ||
    !Array.isArray(value.headingPath) || value.headingPath.some((entry) => typeof entry !== "string") ||
    typeof value.baseName !== "string" || !value.baseName ||
    typeof value.chunkId !== "string" || !value.chunkId ||
    typeof value.contentHash !== "string" || !/^[0-9a-f]{64}$/u.test(value.contentHash) ||
    typeof value.documentId !== "string" || !value.documentId ||
    typeof value.documentVersionId !== "string" || !value.documentVersionId ||
    typeof value.fileName !== "string" || !value.fileName ||
    value.layoutKind !== "body" && value.layoutKind !== "table_ambiguous" &&
      value.layoutKind !== "table_row" ||
    typeof value.knowledgeBaseId !== "string" || !value.knowledgeBaseId ||
    typeof value.sourceName !== "string" || !value.sourceName ||
    typeof value.text !== "string" || !value.text ||
    (value.exactKind !== null && typeof value.exactKind !== "string") ||
    (value.sectionId !== null && typeof value.sectionId !== "string") ||
    (value.sourceArtifactId !== null && typeof value.sourceArtifactId !== "string") ||
    (value.vectorMode !== null && value.vectorMode !== "ann" && value.vectorMode !== "exact") ||
    (value.vectorMode === null) !== (vectorDistance === null) ||
    vectorDistance !== null && (vectorDistance < 0 || vectorDistance > 2)
  ) return null;
  return {
    baseName: value.baseName,
    bindingOrdinal,
    chunkId: value.chunkId,
    chunkIndex,
    contentHash: value.contentHash,
    documentId: value.documentId,
    documentVersionId: value.documentVersionId,
    documentVersionNumber,
    exactKind: value.exactKind as string | null,
    fileName: value.fileName,
    headingPath: value.headingPath as string[],
    knowledgeBaseId: value.knowledgeBaseId,
    layoutKind: value.layoutKind,
    lane: value.lane as KnowledgeRetrievalLane,
    laneRank,
    page,
    rawScore,
    sectionId: value.sectionId as string | null,
    sourceArtifactId: value.sourceArtifactId as string | null,
    sourceName: value.sourceName,
    text: value.text,
    vectorDistance,
    vectorMode: value.vectorMode as KnowledgeVectorSearchMode | null
  };
}

function mergedCandidates(rows: readonly CandidateRow[]): KnowledgeRetrievalCandidate[] {
  const candidates = new Map<string, {
    candidate: Omit<KnowledgeRetrievalCandidate, "signals">;
    signals: KnowledgeCandidateSignal[];
  }>();
  for (const row of rows) {
    const signal: KnowledgeCandidateSignal = Object.freeze({
      exactKind: row.exactKind,
      lane: row.lane,
      rank: row.laneRank,
      rawScore: row.rawScore,
      vectorDistance: row.vectorDistance,
      vectorMode: row.vectorMode
    });
    const existing = candidates.get(row.chunkId);
    if (existing) {
      if (
        existing.candidate.bindingOrdinal !== row.bindingOrdinal ||
        existing.candidate.documentVersionId !== row.documentVersionId ||
        existing.candidate.contentHash !== row.contentHash
      ) throw new Error("knowledge_retrieval_candidate_conflict");
      existing.signals.push(signal);
      continue;
    }
    const {
      exactKind: _exactKind,
      lane: _lane,
      laneRank: _laneRank,
      rawScore: _rawScore,
      vectorDistance: _vectorDistance,
      vectorMode: _vectorMode,
      ...candidate
    } = row;
    candidates.set(row.chunkId, { candidate, signals: [signal] });
  }
  return [...candidates.values()].map(({ candidate, signals }) => Object.freeze({
    ...candidate,
    signals: Object.freeze(signals)
  }));
}

function decodeRows(rows: readonly unknown[]): CandidateRow[] {
  const decoded = rows.map(decodeCandidateRow);
  if (decoded.some((row) => row === null)) throw new Error("knowledge_retrieval_candidate_invalid");
  return decoded as CandidateRow[];
}

function poolLimit(candidateLimit: number, resultLimit: number): number {
  return Math.min(
    KNOWLEDGE_RETRIEVAL_POOL_MAX,
    Math.max(KNOWLEDGE_RETRIEVAL_POOL_MIN, candidateLimit, resultLimit * 10)
  );
}

async function vectorRows(
  client: RetrievalCoreClient,
  input: Readonly<{
    candidateLimit: number;
    bindingOrdinals?: readonly number[];
    mode: KnowledgeVectorSearchMode;
    runId: string;
    sourceIds?: readonly string[];
    userId: string;
    vector: QueryVector;
  }>
): Promise<CandidateRow[]> {
  const rows = await client.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL statement_timeout = '1000ms'`;
    await tx.$executeRaw`SET LOCAL plan_cache_mode = force_custom_plan`;
    if (input.mode === "ann") {
      await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
      await tx.$executeRaw`SET LOCAL enable_bitmapscan = off`;
      await tx.$executeRaw`SET LOCAL enable_sort = off`;
      await tx.$executeRaw`SET LOCAL jit = off`;
      await tx.$executeRaw`SET LOCAL hnsw.iterative_scan = 'strict_order'`;
      await tx.$executeRaw`SELECT set_config('hnsw.ef_search', ${String(KNOWLEDGE_VECTOR_ANN_EF_SEARCH)}, true)`;
      await tx.$executeRaw`SELECT set_config('hnsw.max_scan_tuples', ${String(KNOWLEDGE_VECTOR_ANN_MAX_SCAN_TUPLES)}, true)`;
    }
    return tx.$queryRaw<unknown[]>(knowledgeAdaptiveVectorSearchSql(input));
  });
  return decodeRows(rows);
}

export async function executeKnowledgeRetrievalCore(
  client: RetrievalCoreClient,
  input: Readonly<{
    candidateLimit: number;
    bindingOrdinals?: readonly number[];
    query: string;
    reranker?: KnowledgeCandidateReranker;
    resultLimit: number;
    runId: string;
    scoreThreshold: number;
    sourceIds?: readonly string[];
    userId: string;
    vectors: readonly QueryVector[];
  }>
): Promise<KnowledgeRetrievalCoreResult> {
  const requestedBindingOrdinals = input.bindingOrdinals ?? [];
  const requestedSourceIds = input.sourceIds ?? [];
  if (
    requestedBindingOrdinals.length > KNOWLEDGE_SCOPE_MAX_BINDINGS ||
    requestedBindingOrdinals.some((ordinal) =>
      !Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= KNOWLEDGE_SCOPE_MAX_BINDINGS) ||
    new Set(requestedBindingOrdinals).size !== requestedBindingOrdinals.length ||
    requestedSourceIds.length > KNOWLEDGE_SCOPE_MAX_BINDINGS * 1_024 ||
    requestedSourceIds.some((sourceId) =>
      typeof sourceId !== "string" || !sourceId || sourceId.length > 512) ||
    new Set(requestedSourceIds).size !== requestedSourceIds.length
  ) throw new Error("knowledge_retrieval_scope_filter_invalid");
  const scopesRaw = await client.$queryRaw<unknown[]>(knowledgeRetrievalScopeSql(input));
  const scopes = scopesRaw.map(decodeScope);
  if (scopes.some((scope) => scope === null)) {
    throw new Error("knowledge_retrieval_scope_invalid");
  }
  const acceptedScopes = scopes as ScopeRow[];
  if (
    acceptedScopes.length < 1 || acceptedScopes.length > KNOWLEDGE_SCOPE_MAX_BINDINGS ||
    new Set(acceptedScopes.map((scope) => scope.bindingOrdinal)).size !== acceptedScopes.length ||
    acceptedScopes.some((scope, index) => index > 0 &&
      scope.bindingOrdinal <= acceptedScopes[index - 1]!.bindingOrdinal)
  ) throw new Error("knowledge_retrieval_scope_invalid");

  const byOrdinal = new Map(acceptedScopes.map((scope) => [scope.bindingOrdinal, scope]));
  for (const vector of input.vectors) {
    const scope = byOrdinal.get(vector.bindingOrdinal);
    if (
      !scope || scope.knowledgeBaseId !== vector.knowledgeBaseId ||
      scope.indexGenerationId !== vector.indexGenerationId ||
      scope.targetDimension !== vector.targetDimension ||
      vector.vector.length !== vector.targetDimension ||
      vector.vector.some((value) => !Number.isFinite(value))
    ) throw new Error("knowledge_query_vector_invalid");
  }
  if (new Set(input.vectors.map((vector) => vector.bindingOrdinal)).size !== input.vectors.length) {
    throw new Error("knowledge_query_vector_invalid");
  }

  const candidatePoolLimit = poolLimit(input.candidateLimit, input.resultLimit);
  const vectorEvidence: KnowledgeVectorSearchEvidence[] = [];
  const vectorPromises: Promise<CandidateRow[]>[] = [];
  for (const scope of acceptedScopes) {
    const vector = input.vectors.find((entry) => entry.bindingOrdinal === scope.bindingOrdinal);
    if (!vector || scope.eligibleRows === 0) {
      vectorEvidence.push(Object.freeze({
        bindingOrdinal: scope.bindingOrdinal,
        candidateCount: 0,
        eligibleRows: scope.eligibleRows,
        mode: "unavailable",
        scan: Object.freeze({
          efSearch: null,
          iterativeScan: null,
          maxScanTuples: null,
          retrievalBucket: knowledgeVectorRetrievalBucket(scope.knowledgeBaseId)
        }),
        targetDimension: scope.targetDimension as 1_024 | 1_536
      }));
      continue;
    }
    const mode: KnowledgeVectorSearchMode = scope.eligibleRows <= KNOWLEDGE_VECTOR_EXACT_MAX_ROWS
      ? "exact"
      : "ann";
    const evidenceIndex = vectorEvidence.length;
    vectorEvidence.push(Object.freeze({
      bindingOrdinal: scope.bindingOrdinal,
      candidateCount: -1,
      eligibleRows: scope.eligibleRows,
      mode,
      scan: Object.freeze({
        efSearch: mode === "ann" ? KNOWLEDGE_VECTOR_ANN_EF_SEARCH : null,
        iterativeScan: mode === "ann" ? "strict_order" : null,
        maxScanTuples: mode === "ann" ? KNOWLEDGE_VECTOR_ANN_MAX_SCAN_TUPLES : null,
        retrievalBucket: knowledgeVectorRetrievalBucket(scope.knowledgeBaseId)
      }),
      targetDimension: scope.targetDimension as 1_024 | 1_536
    }));
    vectorPromises.push(vectorRows(client, {
      ...(input.bindingOrdinals ? { bindingOrdinals: input.bindingOrdinals } : {}),
      candidateLimit: candidatePoolLimit,
      mode,
      runId: input.runId,
      ...(input.sourceIds ? { sourceIds: input.sourceIds } : {}),
      userId: input.userId,
      vector
    }).then((rows) => {
      vectorEvidence[evidenceIndex] = Object.freeze({
        ...vectorEvidence[evidenceIndex]!,
        candidateCount: rows.length
      });
      return rows;
    }));
  }

  const [lexicalRows, vectors] = await Promise.all([
    client.$queryRaw<unknown[]>(knowledgeMultiLaneLexicalSearchSql({
      ...(input.bindingOrdinals ? { bindingOrdinals: input.bindingOrdinals } : {}),
      candidateLimit: candidatePoolLimit,
      query: input.query,
      runId: input.runId,
      ...(input.sourceIds ? { sourceIds: input.sourceIds } : {}),
      userId: input.userId
    })).then(decodeRows),
    Promise.all(vectorPromises)
  ]);
  let candidates = mergedCandidates([...lexicalRows, ...vectors.flat()]);
  if (candidates.length > 0) {
    const anchors = fuseKnowledgeCandidates(candidates)
      .slice(0, Math.min(8, input.resultLimit * 2))
      .map((candidate, index) => ({
        bindingOrdinal: candidate.bindingOrdinal,
        chunkId: candidate.chunkId,
        rank: index + 1
      }));
    if (anchors.length > 0) {
      const neighborRows = decodeRows(await client.$queryRaw<unknown[]>(
        knowledgeNeighborExpansionSql({
          anchors,
          ...(input.bindingOrdinals ? { bindingOrdinals: input.bindingOrdinals } : {}),
          runId: input.runId,
          ...(input.sourceIds ? { sourceIds: input.sourceIds } : {}),
          userId: input.userId
        })
      ));
      candidates = mergedCandidates([...lexicalRows, ...vectors.flat(), ...neighborRows]);
    }
  }
  candidates = boundKnowledgeCandidates(
    candidates,
    acceptedScopes.map((scope) => scope.bindingOrdinal)
  );
  const ranking = await rankKnowledgeCandidates({
    candidates,
    query: input.query,
    ...(input.reranker ? { reranker: input.reranker } : {}),
    resultLimit: input.resultLimit,
    scoreThreshold: input.scoreThreshold
  });

  const candidateCounts: Record<number, number> = Object.fromEntries(
    acceptedScopes.map((scope) => [
      scope.bindingOrdinal,
      candidates.filter((candidate) => candidate.bindingOrdinal === scope.bindingOrdinal).length
    ])
  );
  const passages = ranking.selected.map((candidate): KnowledgeRetrievalCorePassage => {
    const semantic = candidate.signals
      .filter((signal) => signal.lane === "passage_semantic")
      .sort((left, right) => left.rank - right.rank)[0] ?? null;
    const lexical = candidate.signals
      .filter((signal) => signal.lane.endsWith("_lexical"))
      .sort((left, right) => left.rank - right.rank)[0] ?? null;
    return Object.freeze({
      ...candidate,
      annRank: semantic?.rank ?? null,
      ftsRank: lexical?.rank ?? null,
      ftsScore: lexical?.rawScore ?? null,
      vectorDistance: semantic?.vectorDistance ?? null,
      vectorScore: semantic?.vectorDistance === null || semantic === null
        ? null
        : 1 - semantic.vectorDistance
    });
  });
  return Object.freeze({
    bindingCount: acceptedScopes.length,
    candidateCount: candidates.length,
    candidateCounts: Object.freeze(candidateCounts),
    passages: Object.freeze(passages),
    rankingEvidence: ranking.evidence,
    vectorSearchEvidence: Object.freeze(vectorEvidence.sort((left, right) =>
      left.bindingOrdinal - right.bindingOrdinal))
  });
}

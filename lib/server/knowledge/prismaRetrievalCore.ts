import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  canonicalizeKnowledgeSourceCandidates,
  type KnowledgeCanonicalSourceBinding,
  type KnowledgeCanonicalSourceProvenance
} from "./canonicalSourceCandidates";
import { decodeKnowledgeDocumentContext } from "./documentContext";
import {
  KNOWLEDGE_HIERARCHICAL_COMPATIBLE_INDEX_VERSIONS,
  knowledgeExactNormalizedValue,
  knowledgeExactQueryValues
} from "./hierarchicalIndex";
import {
  KNOWLEDGE_PRIOR_CONTENT_HASH_MAX,
  KNOWLEDGE_RESULT_LIMIT,
  KNOWLEDGE_SCOPED_RESULT_LIMIT,
  KNOWLEDGE_SCOPE_MAX_BINDINGS
} from "./retrievalTypes";
import {
  eligibleKnowledgeCandidates,
  fuseKnowledgeCandidates,
  knowledgeCandidateSignalEligible,
  KNOWLEDGE_BROAD_RERANK_INPUT_MAX,
  KNOWLEDGE_LANE_CANDIDATE_LIMIT,
  KNOWLEDGE_LEXICAL_RELEVANCE_FLOOR,
  KNOWLEDGE_METADATA_RELEVANCE_FLOOR,
  KNOWLEDGE_RETRIEVAL_FUSION,
  KNOWLEDGE_RETRIEVAL_LANE_WEIGHTS,
  KNOWLEDGE_SCOPED_RERANK_INPUT_MAX,
  KNOWLEDGE_SEMANTIC_RELEVANCE_FLOOR,
  orderRerankedKnowledgeCandidates,
  rankKnowledgeCandidates,
  selectKnowledgePreRerankPool,
  selectRerankedKnowledgeCandidates,
  type KnowledgeCandidateSignal,
  type KnowledgeRankedCandidate,
  type KnowledgeRankingEvidence,
  type KnowledgeRetrievalCandidate,
  type KnowledgeRetrievalLane,
  type KnowledgeVectorSearchMode
} from "./retrievalRanking";
import type { KnowledgeRerankerBindingEvidenceV2 } from "./rerankEvidence";
import type { KnowledgeRerankExecutor } from "./rerankExecution";

const KNOWLEDGE_VECTOR_ANN_EF_SEARCH = 400;
const KNOWLEDGE_VECTOR_ANN_MAX_SCAN_TUPLES = 100_000;
const KNOWLEDGE_VECTOR_BUCKET_COUNT = 16;
const KNOWLEDGE_LINEAR_CONTEXT_RADIUS = 1;
const KNOWLEDGE_TABLE_CONTEXT_ROW_RADIUS = 4;
const KNOWLEDGE_LINEAR_CONTEXT_MAX = 2;
const KNOWLEDGE_TABLE_CONTEXT_MAX = 8;

type RetrievalCoreClient = Pick<PrismaClient, "$queryRaw">;

/** Ready compatible hierarchical index versions for retrieval reads. Each
 * artifact contributes exactly one index (highest ready compatible version)
 * so pre-cutover version-3 rows stay retrievable until superseded through the
 * safe profile reindex, without double-counting any artifact. */
const compatibleIndexVersionsSql = Prisma.sql`ANY(ARRAY[${Prisma.join([
  ...KNOWLEDGE_HIERARCHICAL_COMPATIBLE_INDEX_VERSIONS
])}]::integer[])`;

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

type CandidateRow = Omit<KnowledgeRetrievalCandidate, "signals" | "sourceArtifactId"> & Readonly<{
  contributingBindingOrdinals: readonly number[];
  exactKind: string | null;
  lane: KnowledgeRetrievalLane;
  laneRank: number;
  rawScore: number;
  sourceArtifactId: string;
  vectorDistance: number | null;
  vectorMode: KnowledgeVectorSearchMode | null;
}>;

type HybridQueryEnvelopeRow = Readonly<{
  candidates: unknown;
  scopes: unknown;
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
  expandedContext?: string;
  ftsRank: number | null;
  ftsScore: number | null;
  fusedScore: number;
  rerankScore?: number | null;
  vectorDistance: number | null;
  vectorScore: number | null;
}>;

/** Hosted rerank stage wiring for one retrieval operation. */
export type KnowledgeRetrievalRerank = Readonly<{
  executor: KnowledgeRerankExecutor;
  signal?: AbortSignal;
}>;

export type KnowledgeRetrievalCoreResult = Readonly<{
  bindingCount: number;
  candidateCount: number;
  candidateCounts: Readonly<Record<number, number>>;
  canonicalSourceProvenance: readonly KnowledgeCanonicalSourceProvenance[];
  passages: readonly KnowledgeRetrievalCorePassage[];
  rankingEvidence: KnowledgeRankingEvidence;
  rerankerBinding?: KnowledgeRerankerBindingEvidenceV2;
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
    WITH canonical_profile_bindings AS MATERIALIZED (
      SELECT
        profile."modelRunId",
        profile."id" AS "knowledgeBaseId",
        profile."id" AS "knowledgeBaseSnapshotId",
        profile."ordinal",
        false AS "includeWholeBase",
        array_agg(source_binding."sourceId" ORDER BY source_binding."sourceId")::text[]
          AS "selectedSourceIds",
        0::integer AS "baseContentRevision",
        profile."profileRevisionId" AS "indexGenerationId",
        profile."targetDimension",
        'Pinned Knowledge Profile'::text AS "baseName",
        'profile'::text AS "scopeKind"
      FROM "ModelRun" AS run
      INNER JOIN "KnowledgeRunProfileBinding" AS profile
        ON profile."modelRunId" = run."id"
      INNER JOIN "KnowledgeRunSourceBinding" AS source_binding
        ON source_binding."modelRunId" = profile."modelRunId"
       AND source_binding."profileBindingId" = profile."id"
       AND source_binding."readinessState" = 'ready'
       AND source_binding."tombstonedAt" IS NULL
       AND source_binding."sourceId" IS NOT NULL
       AND source_binding."sourceVersionId" IS NOT NULL
       AND source_binding."sourceArtifactId" IS NOT NULL
      WHERE run."id" = ${input.runId}
        AND run."userId" = ${input.userId}
        ${bindingOrdinals.length > 0
          ? Prisma.sql`AND profile."ordinal" = ANY(${bindingOrdinalArray})`
          : Prisma.empty}
        ${sourceIds.length > 0
          ? Prisma.sql`AND source_binding."sourceId" = ANY(${sourceIdArray})`
          : Prisma.empty}
      GROUP BY
        profile."modelRunId",
        profile."id",
        profile."ordinal",
        profile."profileRevisionId",
        profile."targetDimension"
    )
    SELECT
      run."id" AS "modelRunId",
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
      base."name" AS "baseName",
      'base'::text AS "scopeKind"
    FROM "ModelRun" AS run
    INNER JOIN "KnowledgeRunBinding" AS binding ON binding."modelRunId" = run."id"
    INNER JOIN "KnowledgeBase" AS base ON base."id" = binding."knowledgeBaseId"
    WHERE run."id" = ${input.runId}
      AND run."userId" = ${input.userId}
      AND NOT EXISTS (SELECT 1 FROM canonical_profile_bindings)
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
    UNION ALL
    SELECT
      canonical."modelRunId",
      canonical."ordinal",
      canonical."knowledgeBaseId",
      canonical."knowledgeBaseSnapshotId",
      canonical."includeWholeBase",
      canonical."selectedSourceIds",
      canonical."baseContentRevision",
      canonical."indexGenerationId",
      canonical."targetDimension",
      canonical."baseName",
      canonical."scopeKind"
    FROM canonical_profile_bindings AS canonical
  `;
}

function scopedPassagesSql(): Prisma.Sql {
  return Prisma.sql`
    WITH binding_sources AS MATERIALIZED (
      SELECT
        binding."baseName",
        binding."ordinal" AS "bindingOrdinal",
        binding."knowledgeBaseId",
        binding."indexGenerationId",
        binding."targetDimension",
        snapshot_source."ownerUserId",
        snapshot_source."sourceId",
        snapshot_source."sourceVersionId",
        snapshot_source."artifactId"
      FROM bindings AS binding
      INNER JOIN "KnowledgeBaseSnapshotSource" AS snapshot_source
        ON snapshot_source."snapshotId" = binding."knowledgeBaseSnapshotId"
       AND snapshot_source."knowledgeBaseId" = binding."knowledgeBaseId"
      WHERE binding."scopeKind" = 'base'
        AND binding."knowledgeBaseSnapshotId" IS NOT NULL
        AND (
          binding."includeWholeBase" = true
          OR snapshot_source."sourceId" = ANY(binding."selectedSourceIds")
        )
      UNION ALL
      SELECT
        binding."baseName",
        binding."ordinal" AS "bindingOrdinal",
        binding."knowledgeBaseId",
        binding."indexGenerationId",
        binding."targetDimension",
        source."ownerUserId",
        source_binding."sourceId",
        source_binding."sourceVersionId",
        source_binding."sourceArtifactId" AS "artifactId"
      FROM bindings AS binding
      INNER JOIN "KnowledgeRunSourceBinding" AS source_binding
        ON source_binding."modelRunId" = binding."modelRunId"
       AND source_binding."profileBindingId" = binding."knowledgeBaseId"
       AND source_binding."readinessState" = 'ready'
       AND source_binding."tombstonedAt" IS NULL
      INNER JOIN "KnowledgeSource" AS source
        ON source."id" = source_binding."sourceId"
      WHERE binding."scopeKind" = 'profile'
        AND source_binding."sourceId" IS NOT NULL
        AND source_binding."sourceVersionId" IS NOT NULL
        AND source_binding."sourceArtifactId" IS NOT NULL
        AND source_binding."sourceId" = ANY(binding."selectedSourceIds")
    ),
    source_provenance AS MATERIALIZED (
      SELECT
        source_binding."sourceId",
        source_binding."sourceVersionId",
        source_binding."artifactId",
        array_agg(source_binding."bindingOrdinal" ORDER BY source_binding."bindingOrdinal")
          AS "contributingBindingOrdinals"
      FROM binding_sources AS source_binding
      GROUP BY
        source_binding."sourceId",
        source_binding."sourceVersionId",
        source_binding."artifactId"
    ),
    canonical_binding_sources AS MATERIALIZED (
      SELECT DISTINCT ON (
        source_binding."sourceId",
        source_binding."sourceVersionId",
        source_binding."artifactId"
      ) source_binding.*
      FROM binding_sources AS source_binding
      ORDER BY
        source_binding."sourceId",
        source_binding."sourceVersionId",
        source_binding."artifactId",
        source_binding."bindingOrdinal",
        source_binding."knowledgeBaseId"
    )
    SELECT
      source_binding."baseName",
      source_binding."bindingOrdinal",
      source_binding."knowledgeBaseId",
      source_binding."indexGenerationId",
      source_binding."targetDimension",
      provenance."contributingBindingOrdinals",
      source_binding."sourceId" AS "documentId",
      source_binding."sourceVersionId" AS "documentVersionId",
      version."versionNumber" AS "documentVersionNumber",
      version."fileName",
      source_binding."artifactId" AS "sourceArtifactId",
      hierarchy."id" AS "indexArtifactId",
      passage."id" AS "chunkId",
      passage."ordinal" AS "chunkIndex",
      passage."sectionId",
      passage."page",
      passage."headingPath",
      passage."documentContext",
      CASE
        -- Structured layout identity for current builds; the marker branches
        -- below are decode-only compatibility for legacy rows whose layout
        -- was encoded in the retired English contextPrefix markers.
        WHEN passage."layoutKind" IS NOT NULL THEN passage."layoutKind"
        WHEN passage."documentContext"->'locator'->>'kind' = 'field_ambiguous'
          THEN 'field_ambiguous'::text
        WHEN passage."documentContext"->'locator'->>'kind' = 'field_pair'
          THEN 'field_pair'::text
        WHEN passage."documentContext"->'locator'->>'kind' = 'table_row_projection'
          THEN 'table_row_projection'::text
        WHEN passage."documentContext"->'locator'->>'kind' = 'table_row'
          THEN 'table_row'::text
        WHEN split_part(passage."contextPrefix", E'\n', 1) =
          'Evidence layout: table_ambiguous_v1' THEN 'table_ambiguous'::text
        WHEN split_part(passage."contextPrefix", E'\n', 1) =
          'Evidence layout: table_row_v1' THEN 'table_row'::text
        ELSE 'body'::text
      END AS "layoutKind",
      passage."contentHash",
      passage."sourceName",
      passage."text",
      passage."simpleSearchVector",
      embedding."embeddingDimension",
      embedding."embedding"
    FROM canonical_binding_sources AS source_binding
    INNER JOIN source_provenance AS provenance
      ON provenance."sourceId" = source_binding."sourceId"
     AND provenance."sourceVersionId" = source_binding."sourceVersionId"
     AND provenance."artifactId" = source_binding."artifactId"
    INNER JOIN "KnowledgeSourceVersion" AS version
      ON version."id" = source_binding."sourceVersionId"
     AND version."sourceId" = source_binding."sourceId"
     AND version."ownerUserId" = source_binding."ownerUserId"
    INNER JOIN "KnowledgeSourceIndexArtifact" AS source_artifact
      ON source_artifact."id" = source_binding."artifactId"
     AND source_artifact."sourceVersionId" = source_binding."sourceVersionId"
     AND source_artifact."state" = 'ready'::"KnowledgeSourceArtifactState"
    INNER JOIN LATERAL (
      SELECT candidate_hierarchy."id"
      FROM "KnowledgeHierarchicalIndexArtifact" AS candidate_hierarchy
      WHERE candidate_hierarchy."sourceArtifactId" = source_artifact."id"
        AND candidate_hierarchy."sourceVersionId" = source_artifact."sourceVersionId"
        AND candidate_hierarchy."state" = 'ready'::"KnowledgeHierarchicalIndexState"
        AND candidate_hierarchy."schemaVersion" = ${compatibleIndexVersionsSql}
      ORDER BY candidate_hierarchy."schemaVersion" DESC
      LIMIT 1
    ) AS hierarchy ON TRUE
    INNER JOIN "KnowledgeArtifactPassageIndex" AS passage
      ON passage."indexArtifactId" = hierarchy."id"
    LEFT JOIN "KnowledgeArtifactPassageEmbedding" AS embedding
      ON embedding."indexArtifactId" = passage."indexArtifactId"
     AND embedding."passageId" = passage."id"
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

function knowledgeVectorRetrievalBucket(knowledgeBaseId: string): number {
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

function knowledgeVectorLaneSql(input: Readonly<{
  bindingOrdinals?: readonly number[];
  candidateLimit: number;
  relaxRelevanceFloors?: boolean;
  runId: string;
  sourceIds?: readonly string[];
  userId: string;
  vector: QueryVector;
}>): Prisma.Sql {
  const bindings = retrievalBindingsSql(input);
  const scopedPassages = scopedPassagesSql();
  const globalDistance = vectorDistanceExpression(input.vector, "embedding");
  // When a hosted reranker is configured, the global absolute dense floor
  // must not drop candidates before reranking; the per-lane limit still
  // bounds the scan.
  const denseFloor = input.relaxRelevanceFloors
    ? Prisma.empty
    : Prisma.sql`AND ${globalDistance} <= ${1 - KNOWLEDGE_SEMANTIC_RELEVANCE_FLOOR}`;
  return Prisma.sql`
    WITH
    bindings AS MATERIALIZED (${bindings}),
    scoped_passages AS MATERIALIZED (${scopedPassages}),
    vector_hits AS (
      SELECT embedding."passageId" AS "chunkId", ${globalDistance} AS "vectorDistance"
      FROM "KnowledgeArtifactPassageEmbedding" AS embedding
      INNER JOIN "KnowledgeArtifactPassageIndex" AS indexed_passage
        ON indexed_passage."indexArtifactId" = embedding."indexArtifactId"
       AND indexed_passage."id" = embedding."passageId"
      INNER JOIN "KnowledgeHierarchicalIndexArtifact" AS hierarchy
        ON hierarchy."id" = indexed_passage."indexArtifactId"
       AND hierarchy."state" = 'ready'::"KnowledgeHierarchicalIndexState"
       AND hierarchy."schemaVersion" = ${compatibleIndexVersionsSql}
      WHERE embedding."embeddingDimension" = ${input.vector.targetDimension}
        ${denseFloor}
        AND EXISTS (
          SELECT 1
          FROM scoped_passages AS scoped
          WHERE scoped."bindingOrdinal" = ${input.vector.bindingOrdinal}
            AND scoped."knowledgeBaseId" = ${input.vector.knowledgeBaseId}
            AND scoped."indexGenerationId" = ${input.vector.indexGenerationId}
            AND scoped."targetDimension" = ${input.vector.targetDimension}
            AND scoped."indexArtifactId" = hierarchy."id"
            AND scoped."chunkId" = embedding."passageId"
        )
      ORDER BY ${globalDistance}
      LIMIT ${input.candidateLimit}
    ),
    ranked AS (
      SELECT hit.*,
        row_number() OVER (ORDER BY hit."vectorDistance")::integer AS "laneRank"
      FROM vector_hits AS hit
    )
    SELECT
      binding."baseName",
      binding."ordinal" AS "bindingOrdinal",
      passage."contributingBindingOrdinals",
      passage."chunkId",
      passage."chunkIndex",
      passage."contentHash",
      passage."documentId",
      passage."documentVersionId",
      passage."documentVersionNumber",
      passage."documentContext",
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
      'ann'::text AS "vectorMode"
    FROM ranked
    INNER JOIN bindings AS binding
      ON binding."ordinal" = ${input.vector.bindingOrdinal}
    INNER JOIN scoped_passages AS passage
      ON passage."bindingOrdinal" = binding."ordinal"
     AND passage."chunkId" = ranked."chunkId"
    ORDER BY ranked."laneRank"
  `;
}

/**
 * One generic language-neutral lexical lane: Unicode-normalized queries
 * against the PostgreSQL `simple` configuration only. No script detection,
 * no per-language algorithm selection, no per-language rank summing.
 */
type LexicalQueryColumns = Readonly<{
  simple: Prisma.Sql;
  simpleStrict: Prisma.Sql;
}>;

const MODEL_LEXICAL_QUERY_COLUMNS: LexicalQueryColumns = Object.freeze({
  simple: Prisma.sql`query_terms."modelSimpleQuery"`,
  simpleStrict: Prisma.sql`query_terms."modelSimpleStrictQuery"`
});

const ANCHOR_LEXICAL_QUERY_COLUMNS: LexicalQueryColumns = Object.freeze({
  simple: Prisma.sql`query_terms."anchorSimpleQuery"`,
  simpleStrict: Prisma.sql`query_terms."anchorSimpleStrictQuery"`
});

function lexicalRank(
  alias: string,
  queries: LexicalQueryColumns,
  strict = true
): Prisma.Sql {
  const row = Prisma.raw(alias);
  return Prisma.sql`(
    ts_rank_cd(${row}."simpleSearchVector", ${queries.simple}) +
      ${strict ? Prisma.sql`CASE WHEN ${row}."simpleSearchVector" @@ ${queries.simpleStrict} THEN 1 ELSE 0 END` : Prisma.sql`0`}
  )`;
}

function lexicalMatch(alias: string, queries: LexicalQueryColumns): Prisma.Sql {
  const row = Prisma.raw(alias);
  return Prisma.sql`${row}."simpleSearchVector" @@ ${queries.simple}`;
}

function combinedLexicalRank(alias: string, hasDistinctAnchor: boolean): Prisma.Sql {
  const modelRank = lexicalRank(alias, MODEL_LEXICAL_QUERY_COLUMNS);
  return hasDistinctAnchor
    ? Prisma.sql`GREATEST(${modelRank}, ${lexicalRank(alias, ANCHOR_LEXICAL_QUERY_COLUMNS)})`
    : modelRank;
}

function combinedLexicalMatch(alias: string, hasDistinctAnchor: boolean): Prisma.Sql {
  const modelMatch = lexicalMatch(alias, MODEL_LEXICAL_QUERY_COLUMNS);
  return hasDistinctAnchor
    ? Prisma.sql`(${modelMatch} OR ${lexicalMatch(alias, ANCHOR_LEXICAL_QUERY_COLUMNS)})`
    : modelMatch;
}

function knowledgeMultiLaneLexicalSearchSql(input: Readonly<{
  anchorQuery?: string;
  bindingOrdinals?: readonly number[];
  candidateLimit: number;
  query: string;
  relaxRelevanceFloors?: boolean;
  runId: string;
  sourceIds?: readonly string[];
  userId: string;
}>): Prisma.Sql {
  const bindings = retrievalBindingsSql(input);
  const scopedPassages = scopedPassagesSql();
  const literalQuery = input.anchorQuery ?? input.query;
  const hasDistinctAnchor = literalQuery !== input.query;
  const normalizedQuery = knowledgeExactNormalizedValue(input.query);
  const exactValues = knowledgeExactQueryValues(literalQuery);
  const exactValuesSql = exactValues.length > 0
    ? Prisma.sql`ARRAY[${Prisma.join(exactValues)}]::text[]`
    : Prisma.sql`ARRAY[]::text[]`;
  const passageRank = combinedLexicalRank("chunk", hasDistinctAnchor);
  const passageMatch = combinedLexicalMatch("chunk", hasDistinctAnchor);
  const sectionRank = combinedLexicalRank("section", hasDistinctAnchor);
  const sectionMatch = combinedLexicalMatch("section", hasDistinctAnchor);
  const documentRank = combinedLexicalRank("document_index", hasDistinctAnchor);
  const documentMatch = combinedLexicalMatch("document_index", hasDistinctAnchor);
  return Prisma.sql`
    WITH
    bindings AS MATERIALIZED (${bindings}),
    scoped_chunks AS MATERIALIZED (${scopedPassages}),
    query_terms AS (
      SELECT
        websearch_to_tsquery('simple'::regconfig, ${input.query}) AS "modelSimpleStrictQuery",
        to_tsquery('simple'::regconfig,
          replace(plainto_tsquery('simple'::regconfig, ${input.query})::text, ' & ', ' | ')
        ) AS "modelSimpleQuery",
        websearch_to_tsquery('simple'::regconfig, ${literalQuery}) AS "anchorSimpleStrictQuery",
        to_tsquery('simple'::regconfig,
          replace(plainto_tsquery('simple'::regconfig, ${literalQuery})::text, ' & ', ' | ')
        ) AS "anchorSimpleQuery"
    ),
    exact_query_values AS MATERIALIZED (
      SELECT query_value."normalizedValue", query_value."queryOrdinal"::integer
      FROM unnest(${exactValuesSql}) WITH ORDINALITY
        AS query_value("normalizedValue", "queryOrdinal")
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
    metadata_raw AS (
      SELECT chunk.*, 'metadata'::text AS lane,
        word_similarity(${normalizedQuery}, entry."normalizedValue")::double precision AS "rawScore",
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
        AND word_similarity(${normalizedQuery}, entry."normalizedValue") >=
          ${KNOWLEDGE_METADATA_RELEVANCE_FLOOR}
    ),
    exact_matches AS MATERIALIZED (
      SELECT DISTINCT ON (
        chunk."bindingOrdinal",
        chunk."chunkId",
        query_value."normalizedValue"
      )
        chunk."bindingOrdinal",
        chunk."chunkId",
        query_value."normalizedValue",
        query_value."queryOrdinal",
        entry."kind"::text AS "exactKind",
        entry."ordinal" AS "entryOrdinal",
        CASE entry."kind"
          WHEN 'filename'::"KnowledgeExactEntryKind" THEN 0
          WHEN 'title'::"KnowledgeExactEntryKind" THEN 1
          WHEN 'heading'::"KnowledgeExactEntryKind" THEN 2
          WHEN 'tag'::"KnowledgeExactEntryKind" THEN 3
          WHEN 'identifier'::"KnowledgeExactEntryKind" THEN 4
          WHEN 'date'::"KnowledgeExactEntryKind" THEN 5
          WHEN 'number'::"KnowledgeExactEntryKind" THEN 6
          ELSE 7
        END AS "kindPriority"
      FROM scoped_chunks AS chunk
      INNER JOIN "KnowledgeArtifactExactEntry" AS entry
        ON entry."indexArtifactId" = chunk."indexArtifactId"
      LEFT JOIN "KnowledgeArtifactSectionIndex" AS exact_section
        ON exact_section."indexArtifactId" = entry."indexArtifactId"
       AND exact_section."id" = entry."sectionId"
      INNER JOIN exact_query_values AS query_value
        ON query_value."normalizedValue" = entry."normalizedValue"
      WHERE
        entry."passageId" = chunk."chunkId"
        OR entry."passageId" IS NULL
          AND entry."sectionId" IS NOT NULL
          AND exact_section."passageStart" = chunk."chunkIndex"
        OR entry."passageId" IS NULL
          AND entry."sectionId" IS NULL
          AND chunk."chunkIndex" = 0
      ORDER BY
        chunk."bindingOrdinal",
        chunk."chunkId",
        query_value."normalizedValue",
        "kindPriority",
        query_value."queryOrdinal",
        entry."ordinal"
    ),
    exact_match_frequencies AS MATERIALIZED (
      SELECT exact_match.*,
        count(*) OVER (
          PARTITION BY exact_match."bindingOrdinal", exact_match."normalizedValue"
        )::double precision AS "matchFrequency"
      FROM exact_matches AS exact_match
    ),
    exact_scores AS (
      SELECT
        exact_match."bindingOrdinal",
        exact_match."chunkId",
        (
          sum(1.0 / exact_match."matchFrequency") + count(*) * 0.001
        )::double precision AS "rawScore",
        (array_agg(
          exact_match."exactKind"
          ORDER BY
            exact_match."kindPriority",
            exact_match."queryOrdinal",
            exact_match."entryOrdinal"
        ))[1] AS "exactKind"
      FROM exact_match_frequencies AS exact_match
      GROUP BY exact_match."bindingOrdinal", exact_match."chunkId"
    ),
    exact_raw AS (
      SELECT chunk.*, 'exact'::text AS lane,
        exact_score."rawScore",
        exact_score."exactKind"
      FROM scoped_chunks AS chunk
      INNER JOIN exact_scores AS exact_score
        ON exact_score."bindingOrdinal" = chunk."bindingOrdinal"
       AND exact_score."chunkId" = chunk."chunkId"
    ),
    lane_rows AS (
      SELECT * FROM passage_raw
      UNION ALL SELECT * FROM section_raw
      UNION ALL SELECT * FROM document_raw
      UNION ALL SELECT * FROM metadata_raw
      UNION ALL SELECT * FROM exact_raw
    ),
    eligible_lane_rows AS (
      SELECT *
      FROM lane_rows
      WHERE lane = 'exact'
        OR lane = 'metadata' AND "rawScore" >= ${KNOWLEDGE_METADATA_RELEVANCE_FLOOR}
        OR lane IN ('document_lexical', 'passage_lexical', 'section_lexical')
          ${input.relaxRelevanceFloors
            ? Prisma.empty
            : Prisma.sql`AND "rawScore" >= ${KNOWLEDGE_LEXICAL_RELEVANCE_FLOOR}`}
    ),
    ranked AS (
      SELECT eligible_lane_rows.*,
        row_number() OVER (
          PARTITION BY "bindingOrdinal", lane
          ORDER BY "rawScore" DESC, "chunkId", COALESCE("exactKind", '')
        )::integer AS "laneRank"
      FROM eligible_lane_rows
    )
    SELECT
      ranked."baseName",
      ranked."bindingOrdinal",
      ranked."contributingBindingOrdinals",
      ranked."chunkId",
      ranked."chunkIndex",
      ranked."contentHash",
      ranked."documentId",
      ranked."documentVersionId",
      ranked."documentVersionNumber",
      ranked."documentContext",
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

/**
 * Builds the complete focused hybrid retrieval as one PostgreSQL statement.
 * The nested lane statements remain private implementation details of this
 * single operation; callers receive one envelope from one `$queryRaw` call.
 */
function knowledgeFocusedHybridSearchSql(input: Readonly<{
  anchorQuery?: string;
  bindingOrdinals?: readonly number[];
  candidateLimit: number;
  query: string;
  relaxRelevanceFloors?: boolean;
  resultLimit: number;
  runId: string;
  sourceIds?: readonly string[];
  userId: string;
  vectors: readonly QueryVector[];
}>): Prisma.Sql {
  const scopeQuery = knowledgeRetrievalScopeSql(input);
  const bindings = retrievalBindingsSql(input);
  const scopedPassages = scopedPassagesSql();
  const lexicalQuery = knowledgeMultiLaneLexicalSearchSql(input);
  const vectorQueryUnion = input.vectors.length === 0
    ? Prisma.sql`SELECT candidate.* FROM lexical_candidates AS candidate WHERE false`
    : Prisma.join(input.vectors.map((vector) => {
      const query = knowledgeVectorLaneSql({
        ...(input.bindingOrdinals ? { bindingOrdinals: input.bindingOrdinals } : {}),
        candidateLimit: input.candidateLimit,
        ...(input.relaxRelevanceFloors ? { relaxRelevanceFloors: true } : {}),
        runId: input.runId,
        ...(input.sourceIds ? { sourceIds: input.sourceIds } : {}),
        userId: input.userId,
        vector
      });
      return Prisma.sql`
        SELECT vector_candidate.*
        FROM runtime_settings
        CROSS JOIN LATERAL (${query}) AS vector_candidate
      `;
    }), " UNION ALL ");
  return Prisma.sql`
    WITH
    runtime_settings AS MATERIALIZED (
      SELECT
        set_config('statement_timeout', '30000', true),
        set_config('hnsw.iterative_scan', 'strict_order', true),
        set_config('hnsw.ef_search', ${String(KNOWLEDGE_VECTOR_ANN_EF_SEARCH)}, true),
        set_config(
          'hnsw.max_scan_tuples',
          ${String(KNOWLEDGE_VECTOR_ANN_MAX_SCAN_TUPLES)},
          true
        )
    ),
    scopes AS MATERIALIZED (${scopeQuery}),
    bindings AS MATERIALIZED (${bindings}),
    scoped_passages AS MATERIALIZED (${scopedPassages}),
    lexical_candidates AS MATERIALIZED (${lexicalQuery}),
    vector_candidate_union AS MATERIALIZED (${vectorQueryUnion}),
    vector_candidates AS MATERIALIZED (
      SELECT DISTINCT ON (candidate."bindingOrdinal", candidate."chunkId") candidate.*
      FROM vector_candidate_union AS candidate
      ORDER BY candidate."bindingOrdinal", candidate."chunkId", candidate."laneRank",
        candidate."vectorDistance"
    ),
    primary_candidates AS MATERIALIZED (
      SELECT * FROM lexical_candidates
      UNION ALL
      SELECT * FROM vector_candidates
    ),
    anchor_scores AS (
      SELECT
        candidate."bindingOrdinal",
        candidate."chunkId",
        sum(
          CASE candidate.lane
            WHEN 'document_lexical' THEN ${KNOWLEDGE_RETRIEVAL_LANE_WEIGHTS.document_lexical}
            WHEN 'exact' THEN ${KNOWLEDGE_RETRIEVAL_LANE_WEIGHTS.exact}
            WHEN 'metadata' THEN ${KNOWLEDGE_RETRIEVAL_LANE_WEIGHTS.metadata}
            WHEN 'passage_lexical' THEN ${KNOWLEDGE_RETRIEVAL_LANE_WEIGHTS.passage_lexical}
            WHEN 'passage_semantic' THEN ${KNOWLEDGE_RETRIEVAL_LANE_WEIGHTS.passage_semantic}
            WHEN 'section_lexical' THEN ${KNOWLEDGE_RETRIEVAL_LANE_WEIGHTS.section_lexical}
            ELSE 0.0
          END / (60.0 + candidate."laneRank")
        )::double precision AS "fusedScore"
      FROM primary_candidates AS candidate
      GROUP BY candidate."bindingOrdinal", candidate."chunkId"
    ),
    anchors AS MATERIALIZED (
      SELECT
        score."bindingOrdinal",
        score."chunkId",
        row_number() OVER (
          ORDER BY score."fusedScore" DESC, score."bindingOrdinal", score."chunkId"
        )::integer AS "anchorRank"
      FROM anchor_scores AS score
      ORDER BY score."fusedScore" DESC, score."bindingOrdinal", score."chunkId"
      LIMIT ${input.candidateLimit}
    ),
    neighbor_candidates AS (
      SELECT
        neighbor."baseName",
        neighbor."bindingOrdinal",
        neighbor."contributingBindingOrdinals",
        neighbor."chunkId",
        neighbor."chunkIndex",
        neighbor."contentHash",
        neighbor."documentId",
        neighbor."documentVersionId",
        neighbor."documentVersionNumber",
        neighbor."documentContext",
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
          ORDER BY
            anchor."anchorRank",
            abs(neighbor."chunkIndex" - source."chunkIndex"),
            neighbor."chunkId"
        )::integer AS "laneRank",
        (1.0 / (
          1 + anchor."anchorRank" + abs(neighbor."chunkIndex" - source."chunkIndex")
        ))::double precision AS "rawScore",
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
       AND neighbor."documentId" = source."documentId"
       AND neighbor."documentVersionId" = source."documentVersionId"
       AND neighbor."sourceArtifactId" = source."sourceArtifactId"
       AND (
         source."documentContext" IS NULL AND neighbor."documentContext" IS NULL
           AND abs(neighbor."chunkIndex" - source."chunkIndex") =
             ${KNOWLEDGE_LINEAR_CONTEXT_RADIUS}
         OR source."documentContext"->'locator'->>'kind' = 'table_row'
           AND neighbor."documentContext"->'locator'->>'kind' = 'table_row'
           AND neighbor."documentContext"->'locator'->>'blockId' =
             source."documentContext"->'locator'->>'blockId'
           AND abs(
             (neighbor."documentContext"->'locator'->>'rowIndex')::integer -
             (source."documentContext"->'locator'->>'rowIndex')::integer
           ) BETWEEN 1 AND ${KNOWLEDGE_TABLE_CONTEXT_ROW_RADIUS}
         OR source."documentContext"->'locator'->>'rowId' IS NOT NULL
           AND neighbor."documentContext"->'locator'->>'rowId' =
             source."documentContext"->'locator'->>'rowId'
           AND abs(neighbor."chunkIndex" - source."chunkIndex") =
             ${KNOWLEDGE_LINEAR_CONTEXT_RADIUS}
         OR source."documentContext"->'locator'->>'fieldGroupId' IS NOT NULL
           AND neighbor."documentContext"->'locator'->>'fieldGroupId' =
             source."documentContext"->'locator'->>'fieldGroupId'
           AND abs(neighbor."chunkIndex" - source."chunkIndex") =
             ${KNOWLEDGE_LINEAR_CONTEXT_RADIUS}
       )
    ),
    all_candidates AS (
      SELECT * FROM primary_candidates
      UNION ALL
      SELECT * FROM neighbor_candidates
    )
    SELECT
      COALESCE((
        SELECT jsonb_agg(
          to_jsonb(candidate)
          ORDER BY candidate."bindingOrdinal", candidate.lane, candidate."laneRank",
            candidate."chunkId"
        )
        FROM all_candidates AS candidate
      ), '[]'::jsonb) AS candidates,
      COALESCE((
        SELECT jsonb_agg(to_jsonb(scope) ORDER BY scope."bindingOrdinal")
        FROM scopes AS scope
      ), '[]'::jsonb) AS scopes
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

function decodeContributingBindingOrdinals(
  value: unknown
): readonly number[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > KNOWLEDGE_SCOPE_MAX_BINDINGS) {
    return null;
  }
  const decoded = value.map(integer);
  if (decoded.some((entry) =>
    entry === null || entry < 0 || entry >= KNOWLEDGE_SCOPE_MAX_BINDINGS)) return null;
  const bindingOrdinals = (decoded as number[]).sort((left, right) => left - right);
  if (new Set(bindingOrdinals).size !== bindingOrdinals.length) return null;
  return Object.freeze(bindingOrdinals);
}

function decodeCandidateRow(value: unknown): CandidateRow | null {
  if (!record(value)) return null;
  const bindingOrdinal = integer(value.bindingOrdinal);
  const chunkIndex = integer(value.chunkIndex);
  const documentContext = value.documentContext === undefined || value.documentContext === null
    ? null
    : decodeKnowledgeDocumentContext(value.documentContext);
  const documentVersionNumber = integer(value.documentVersionNumber);
  const laneRank = integer(value.laneRank);
  const page = integer(value.page);
  const rawScore = finite(value.rawScore);
  const vectorDistance = value.vectorDistance === null ? null : finite(value.vectorDistance);
  const contributingBindingOrdinals = decodeContributingBindingOrdinals(
    value.contributingBindingOrdinals
  );
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
    (value.documentContext !== undefined && value.documentContext !== null && !documentContext) ||
    typeof value.fileName !== "string" || !value.fileName ||
    value.layoutKind !== "body" && value.layoutKind !== "field_ambiguous" &&
      value.layoutKind !== "field_pair" && value.layoutKind !== "table_ambiguous" &&
      value.layoutKind !== "table_row" && value.layoutKind !== "table_row_projection" ||
    typeof value.knowledgeBaseId !== "string" || !value.knowledgeBaseId ||
    typeof value.sourceName !== "string" || !value.sourceName ||
    typeof value.text !== "string" || !value.text ||
    contributingBindingOrdinals === null ||
    !contributingBindingOrdinals.includes(bindingOrdinal) ||
    (value.exactKind !== null && typeof value.exactKind !== "string") ||
    (value.sectionId !== null && typeof value.sectionId !== "string") ||
    typeof value.sourceArtifactId !== "string" || !value.sourceArtifactId ||
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
    contributingBindingOrdinals,
    documentId: value.documentId,
    ...(documentContext ? { documentContext } : {}),
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
    sourceArtifactId: value.sourceArtifactId,
    sourceName: value.sourceName,
    text: value.text,
    vectorDistance,
    vectorMode: value.vectorMode as KnowledgeVectorSearchMode | null
  };
}

function mergedCandidates(
  rows: readonly CandidateRow[],
  scopesByOrdinal: ReadonlyMap<number, ScopeRow>
): Readonly<{
  candidates: readonly KnowledgeRetrievalCandidate[];
  sourceBindings: readonly KnowledgeCanonicalSourceBinding[];
}> {
  const candidates = new Map<string, {
    candidate: Omit<KnowledgeRetrievalCandidate, "signals">;
    signals: KnowledgeCandidateSignal[];
  }>();
  const sourceBindings = new Map<string, KnowledgeCanonicalSourceBinding>();
  for (const row of rows) {
    for (const bindingOrdinal of row.contributingBindingOrdinals) {
      const contributingScope = scopesByOrdinal.get(bindingOrdinal);
      if (!contributingScope) throw new Error("knowledge_retrieval_source_binding_invalid");
      const sourceBinding = Object.freeze({
        artifactId: row.sourceArtifactId,
        baseName: contributingScope.baseName,
        bindingOrdinal,
        knowledgeBaseId: contributingScope.knowledgeBaseId,
        sourceId: row.documentId,
        sourceVersionId: row.documentVersionId
      });
      const sourceBindingKey = JSON.stringify([
        sourceBinding.sourceId,
        sourceBinding.sourceVersionId,
        sourceBinding.artifactId,
        sourceBinding.bindingOrdinal
      ]);
      const existingSourceBinding = sourceBindings.get(sourceBindingKey);
      if (existingSourceBinding && (
        existingSourceBinding.baseName !== sourceBinding.baseName ||
        existingSourceBinding.knowledgeBaseId !== sourceBinding.knowledgeBaseId
      )) throw new Error("knowledge_retrieval_source_binding_conflict");
      sourceBindings.set(sourceBindingKey, sourceBinding);
    }
    const signal: KnowledgeCandidateSignal = Object.freeze({
      exactKind: row.exactKind,
      lane: row.lane,
      rank: row.laneRank,
      rawScore: row.rawScore,
      vectorDistance: row.vectorDistance,
      vectorMode: row.vectorMode
    });
    const candidateKey = JSON.stringify([row.bindingOrdinal, row.chunkId]);
    const existing = candidates.get(candidateKey);
    if (existing) {
      if (
        existing.candidate.bindingOrdinal !== row.bindingOrdinal ||
        existing.candidate.documentId !== row.documentId ||
        existing.candidate.documentVersionId !== row.documentVersionId ||
        existing.candidate.contentHash !== row.contentHash ||
        existing.candidate.knowledgeBaseId !== row.knowledgeBaseId ||
        existing.candidate.sourceArtifactId !== row.sourceArtifactId
      ) throw new Error("knowledge_retrieval_candidate_conflict");
      existing.signals.push(signal);
      continue;
    }
    const {
      contributingBindingOrdinals: _contributingBindingOrdinals,
      exactKind: _exactKind,
      lane: _lane,
      laneRank: _laneRank,
      rawScore: _rawScore,
      vectorDistance: _vectorDistance,
      vectorMode: _vectorMode,
      ...candidate
    } = row;
    candidates.set(candidateKey, { candidate, signals: [signal] });
  }
  return Object.freeze({
    candidates: Object.freeze([...candidates.values()].map(({ candidate, signals }) =>
      Object.freeze({
        ...candidate,
        signals: Object.freeze(signals)
      }))),
    sourceBindings: Object.freeze([...sourceBindings.values()])
  });
}

function decodeRows(rows: readonly unknown[]): CandidateRow[] {
  const decoded = rows.map(decodeCandidateRow);
  if (decoded.some((row) => row === null)) throw new Error("knowledge_retrieval_candidate_invalid");
  return decoded as CandidateRow[];
}

function decodeHybridQueryEnvelope(rows: readonly unknown[]): Readonly<{
  candidates: CandidateRow[];
  scopes: ScopeRow[];
}> {
  if (rows.length !== 1 || !record(rows[0])) {
    throw new Error("knowledge_retrieval_envelope_invalid");
  }
  const envelope = rows[0] as HybridQueryEnvelopeRow;
  if (!Array.isArray(envelope.candidates) || !Array.isArray(envelope.scopes)) {
    throw new Error("knowledge_retrieval_envelope_invalid");
  }
  const scopes = envelope.scopes.map(decodeScope);
  if (scopes.some((scope) => scope === null)) {
    throw new Error("knowledge_retrieval_scope_invalid");
  }
  return Object.freeze({
    candidates: decodeRows(envelope.candidates),
    scopes: scopes as ScopeRow[]
  });
}

function hasPrimarySignal(candidate: KnowledgeRetrievalCandidate): boolean {
  return candidate.signals.some((signal) => signal.lane !== "neighbor");
}

function relatedKnowledgeContext(
  source: KnowledgeRetrievalCandidate,
  candidate: KnowledgeRetrievalCandidate
): boolean {
  const distance = Math.abs(candidate.chunkIndex - source.chunkIndex);
  const sourceLocator = source.documentContext?.locator;
  const candidateLocator = candidate.documentContext?.locator;
  if (!sourceLocator || !candidateLocator) {
    return !sourceLocator && !candidateLocator && distance === KNOWLEDGE_LINEAR_CONTEXT_RADIUS;
  }
  if (sourceLocator.kind === "table_row" && candidateLocator.kind === "table_row" &&
    sourceLocator.blockId === candidateLocator.blockId) {
    const rowDistance = Math.abs(candidateLocator.rowIndex - sourceLocator.rowIndex);
    return rowDistance >= 1 && rowDistance <= KNOWLEDGE_TABLE_CONTEXT_ROW_RADIUS;
  }
  if ((sourceLocator.kind === "table_row" ||
      sourceLocator.kind === "table_row_projection") &&
    (candidateLocator.kind === "table_row" ||
      candidateLocator.kind === "table_row_projection")) {
    return sourceLocator.rowId === candidateLocator.rowId &&
      distance === KNOWLEDGE_LINEAR_CONTEXT_RADIUS;
  }
  if ((sourceLocator.kind === "field_pair" ||
      sourceLocator.kind === "field_ambiguous") &&
    (candidateLocator.kind === "field_pair" ||
      candidateLocator.kind === "field_ambiguous")) {
    return sourceLocator.fieldGroupId === candidateLocator.fieldGroupId &&
      distance === KNOWLEDGE_LINEAR_CONTEXT_RADIUS;
  }
  return false;
}

function knowledgeContextMaximum(candidate: KnowledgeRetrievalCandidate): number {
  return candidate.documentContext?.locator.kind === "table_row"
    ? KNOWLEDGE_TABLE_CONTEXT_MAX
    : KNOWLEDGE_LINEAR_CONTEXT_MAX;
}

function sameKnowledgeSource(
  source: KnowledgeRetrievalCandidate,
  candidate: KnowledgeRetrievalCandidate
): boolean {
  return candidate.documentId === source.documentId &&
    candidate.documentVersionId === source.documentVersionId &&
    candidate.sourceArtifactId === source.sourceArtifactId;
}

function independentlyMatchedTableContext(
  source: KnowledgeRetrievalCandidate,
  candidate: KnowledgeRetrievalCandidate
): boolean {
  const sourceLocator = source.documentContext?.locator;
  const candidateLocator = candidate.documentContext?.locator;
  if (sourceLocator?.kind !== "table_row" || !hasPrimarySignal(candidate)) return false;
  if (!candidateLocator) return candidate.layoutKind === "body";
  return candidateLocator.kind === "table_row" && candidateLocator.rowKind === "data" &&
    candidateLocator.rowId !== sourceLocator.rowId;
}

function selectKnowledgeContext(input: Readonly<{
  assignedContentHashes: ReadonlySet<string>;
  candidates: readonly KnowledgeRetrievalCandidate[];
  excludedContentHashes: ReadonlySet<string>;
  selectedContentHashes: ReadonlySet<string>;
  source: KnowledgeRetrievalCandidate;
}>): KnowledgeRetrievalCandidate[] {
  const available = input.candidates.filter((candidate) =>
    candidate.chunkId !== input.source.chunkId &&
    sameKnowledgeSource(input.source, candidate) &&
    !input.excludedContentHashes.has(candidate.contentHash) &&
    !input.assignedContentHashes.has(candidate.contentHash));
  const sourceIsTableRow = input.source.documentContext?.locator.kind === "table_row";
  const local = available.filter((candidate) =>
    (sourceIsTableRow || !input.selectedContentHashes.has(candidate.contentHash)) &&
    relatedKnowledgeContext(input.source, candidate))
    .sort((left, right) =>
      Math.abs(left.chunkIndex - input.source.chunkIndex) -
        Math.abs(right.chunkIndex - input.source.chunkIndex) ||
      left.chunkIndex - right.chunkIndex ||
      left.chunkId.localeCompare(right.chunkId));
  const independentlyMatched = fuseKnowledgeCandidates(available.filter((candidate) =>
    !input.selectedContentHashes.has(candidate.contentHash) &&
    independentlyMatchedTableContext(input.source, candidate)));
  const selected: KnowledgeRetrievalCandidate[] = [];
  const chunks = new Set<string>();
  const content = new Set<string>();
  for (const candidate of [...local, ...independentlyMatched]) {
    if (chunks.has(candidate.chunkId) || content.has(candidate.contentHash)) continue;
    chunks.add(candidate.chunkId);
    content.add(candidate.contentHash);
    selected.push(candidate);
    if (selected.length >= knowledgeContextMaximum(input.source)) break;
  }
  return selected.sort((left, right) => left.chunkIndex - right.chunkIndex ||
    left.chunkId.localeCompare(right.chunkId));
}

function knowledgeContextLabel(
  source: KnowledgeRetrievalCandidate,
  candidate: KnowledgeRetrievalCandidate
): string {
  const sourceLocator = source.documentContext?.locator;
  const candidateLocator = candidate.documentContext?.locator;
  if (sourceLocator?.kind === "table_row" && candidateLocator?.kind === "table_row" &&
    sourceLocator.rowId !== candidateLocator.rowId) {
    if (sourceLocator.blockId === candidateLocator.blockId) {
      return candidateLocator.rowIndex < sourceLocator.rowIndex
        ? "Previous complete row in the same table"
        : "Next complete row in the same table";
    }
    return "Additional independently matched complete row from the same Source";
  }
  if (sourceLocator?.kind === "table_row" && !candidateLocator &&
    candidate.layoutKind === "body" && hasPrimarySignal(candidate)) {
    return "Additional independently matched passage from the same Source";
  }
  return candidate.chunkIndex < source.chunkIndex
    ? "Previous same-Source context"
    : "Next same-Source context";
}

export async function executeKnowledgeRetrievalCore(
  client: RetrievalCoreClient,
  input: Readonly<{
    anchorQuery?: string;
    candidateLimit: number;
    bindingOrdinals?: readonly number[];
    excludedContentHashes: readonly string[];
    query: string;
    rerank?: KnowledgeRetrievalRerank;
    resultLimit: number;
    runId: string;
    sourceIds?: readonly string[];
    userId: string;
    vectors: readonly QueryVector[];
  }>
): Promise<KnowledgeRetrievalCoreResult> {
  const requestedBindingOrdinals = input.bindingOrdinals ?? [];
  const requestedSourceIds = input.sourceIds ?? [];
  const excludedContentHashes = new Set(input.excludedContentHashes);
  if (
    input.candidateLimit !== KNOWLEDGE_LANE_CANDIDATE_LIMIT ||
    (input.resultLimit !== KNOWLEDGE_RESULT_LIMIT &&
      input.resultLimit !== KNOWLEDGE_SCOPED_RESULT_LIMIT) ||
    typeof input.query !== "string" || !input.query.trim() ||
    [...input.query].length > 3_000 ||
    (input.anchorQuery !== undefined && (
      typeof input.anchorQuery !== "string" || !input.anchorQuery.trim() ||
      [...input.anchorQuery].length > 3_000
    ))
  ) throw new Error("knowledge_retrieval_request_invalid");
  if (
    input.excludedContentHashes.length > KNOWLEDGE_PRIOR_CONTENT_HASH_MAX ||
    excludedContentHashes.size !== input.excludedContentHashes.length ||
    input.excludedContentHashes.some((hash) => !/^[0-9a-f]{64}$/u.test(hash))
  ) throw new Error("knowledge_retrieval_exclusion_invalid");
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
  if (
    input.vectors.length > KNOWLEDGE_SCOPE_MAX_BINDINGS * 2 ||
    [...input.vectors.reduce((counts, vector) => counts.set(
      vector.bindingOrdinal,
      (counts.get(vector.bindingOrdinal) ?? 0) + 1
    ), new Map<number, number>()).values()].some((count) => count > 2) ||
    input.vectors.some((vector) =>
      !Number.isSafeInteger(vector.bindingOrdinal) || vector.bindingOrdinal < 0 ||
      vector.bindingOrdinal >= KNOWLEDGE_SCOPE_MAX_BINDINGS ||
      !vector.knowledgeBaseId || !vector.indexGenerationId ||
      vector.vector.length !== vector.targetDimension ||
      vector.vector.some((value) => !Number.isFinite(value)))
  ) throw new Error("knowledge_query_vector_invalid");

  const rerankConfigured = Boolean(input.rerank);
  const envelope = decodeHybridQueryEnvelope(await client.$queryRaw<unknown[]>(
    knowledgeFocusedHybridSearchSql({
      ...(input.anchorQuery ? { anchorQuery: input.anchorQuery } : {}),
      ...(input.bindingOrdinals ? { bindingOrdinals: input.bindingOrdinals } : {}),
      candidateLimit: input.candidateLimit,
      query: input.query,
      ...(rerankConfigured ? { relaxRelevanceFloors: true } : {}),
      resultLimit: input.resultLimit,
      runId: input.runId,
      ...(input.sourceIds ? { sourceIds: input.sourceIds } : {}),
      userId: input.userId,
      vectors: input.vectors
    })
  ));
  const acceptedScopes = envelope.scopes;
  if (
    acceptedScopes.length < 1 || acceptedScopes.length > KNOWLEDGE_SCOPE_MAX_BINDINGS ||
    new Set(acceptedScopes.map((scope) => scope.bindingOrdinal)).size !== acceptedScopes.length ||
    acceptedScopes.some((scope, index) => index > 0 &&
      scope.bindingOrdinal <= acceptedScopes[index - 1]!.bindingOrdinal)
  ) throw new Error("knowledge_retrieval_scope_invalid");

  const byOrdinal = new Map(acceptedScopes.map((scope) => [scope.bindingOrdinal, scope]));
  const vectorByOrdinal = new Map(input.vectors.map((vector) => [vector.bindingOrdinal, vector]));
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
  const vectorEvidence = acceptedScopes.map((scope): KnowledgeVectorSearchEvidence => {
    const candidateCount = envelope.candidates.filter((candidate) =>
      candidate.bindingOrdinal === scope.bindingOrdinal &&
      candidate.lane === "passage_semantic").length;
    const available = scope.eligibleRows > 0 && vectorByOrdinal.has(scope.bindingOrdinal);
    return Object.freeze({
      bindingOrdinal: scope.bindingOrdinal,
      candidateCount,
      eligibleRows: scope.eligibleRows,
      mode: available ? "ann" : "unavailable",
      scan: Object.freeze({
        efSearch: available ? KNOWLEDGE_VECTOR_ANN_EF_SEARCH : null,
        iterativeScan: available ? "strict_order" : null,
        maxScanTuples: available ? KNOWLEDGE_VECTOR_ANN_MAX_SCAN_TUPLES : null,
        retrievalBucket: knowledgeVectorRetrievalBucket(scope.knowledgeBaseId)
      }),
      targetDimension: scope.targetDimension as 1_024 | 1_536
    });
  });
  // Row-level relevance eligibility. When a hosted reranker is configured,
  // global absolute dense/lexical floors must not drop candidates before
  // reranking; the deterministic path keeps today's floors exactly.
  const eligibleRows = rerankConfigured
    ? envelope.candidates
    : envelope.candidates.filter((candidate) =>
      candidate.lane === "neighbor" || knowledgeCandidateSignalEligible({
        exactKind: candidate.exactKind,
        lane: candidate.lane,
        rank: candidate.laneRank,
        rawScore: candidate.rawScore,
        vectorDistance: candidate.vectorDistance,
        vectorMode: candidate.vectorMode
      }));
  const merged = mergedCandidates(eligibleRows, byOrdinal);
  const canonical = canonicalizeKnowledgeSourceCandidates(
    merged.candidates,
    merged.sourceBindings
  );
  const primaryPool = canonical.candidates.filter(hasPrimarySignal).filter((candidate) =>
    !excludedContentHashes.has(candidate.contentHash));

  let candidates: readonly KnowledgeRankedCandidate[];
  let rankingEvidence: KnowledgeRankingEvidence;
  let selected: readonly (KnowledgeRankedCandidate & Readonly<{
    rerankScore?: number | null;
  }>)[];
  let rerankerBinding: KnowledgeRerankerBindingEvidenceV2 | undefined;
  if (!input.rerank) {
    const deterministic = Object.freeze(
      fuseKnowledgeCandidates(primaryPool).slice(0, input.candidateLimit)
    );
    const ranking = await rankKnowledgeCandidates({
      candidates: deterministic,
      resultLimit: input.resultLimit
    });
    candidates = deterministic;
    rankingEvidence = ranking.evidence;
    selected = ranking.selected;
  } else {
    // Merged pre-rerank pool: candidates are already tenant/Base/Source/
    // Version/authority scoped by the repository query above; the provider
    // request never sees anything outside this pool.
    const poolMaximum = input.resultLimit === KNOWLEDGE_SCOPED_RESULT_LIMIT
      ? KNOWLEDGE_SCOPED_RERANK_INPUT_MAX
      : KNOWLEDGE_BROAD_RERANK_INPUT_MAX;
    const pool = Object.freeze(selectKnowledgePreRerankPool({
      bindingOrdinals: acceptedScopes.map((scope) => scope.bindingOrdinal),
      candidates: primaryPool,
      maximum: poolMaximum
    }));
    const stage = await input.rerank.executor({
      candidates: pool.map((candidate) => ({
        chunkId: candidate.chunkId,
        headingPath: candidate.headingPath,
        sourceName: candidate.sourceName,
        text: candidate.text
      })),
      ...(input.rerank.signal ? { signal: input.rerank.signal } : {})
    });
    rerankerBinding = stage.evidence;
    if (stage.status === "degraded") {
      // Deterministic weighted RRF fallback: no retrieval or embedding is
      // repeated, today's named relevance floors apply, and exact candidates
      // stay eligible by definition.
      const fallback = Object.freeze(
        fuseKnowledgeCandidates(eligibleKnowledgeCandidates(pool))
          .slice(0, input.candidateLimit)
      );
      const ranking = await rankKnowledgeCandidates({
        candidates: fallback,
        resultLimit: input.resultLimit
      });
      candidates = fallback;
      rankingEvidence = ranking.evidence;
      selected = ranking.selected;
    } else {
      const ordered = Object.freeze(orderRerankedKnowledgeCandidates({
        pool,
        rerankScores: stage.scores
      }));
      candidates = ordered;
      rankingEvidence = Object.freeze({
        candidateOrder: Object.freeze(ordered.map((candidate) => candidate.chunkId)),
        fusion: KNOWLEDGE_RETRIEVAL_FUSION
      });
      selected = Object.freeze(selectRerankedKnowledgeCandidates({
        candidates: ordered,
        resultLimit: input.resultLimit
      }));
    }
  }
  const retainedChunkIds = new Set(candidates.map((candidate) => candidate.chunkId));
  const retainedCandidateProvenance = canonical.candidateProvenance.filter((entry) =>
    retainedChunkIds.has(entry.chunkId));
  const provenanceByChunk = new Map(retainedCandidateProvenance.map((entry) => [
    entry.chunkId,
    entry
  ]));
  if (provenanceByChunk.size !== candidates.length) {
    throw new Error("knowledge_canonical_source_provenance_invalid");
  }
  const retainedSourceKeys = new Set(retainedCandidateProvenance.map((entry) =>
    JSON.stringify([entry.sourceId, entry.sourceVersionId, entry.artifactId])));
  const canonicalSourceProvenance = canonical.sourceProvenance.filter((entry) =>
    retainedSourceKeys.has(JSON.stringify([entry.sourceId, entry.sourceVersionId, entry.artifactId])));

  const candidateCounts: Record<number, number> = Object.fromEntries(
    acceptedScopes.map((scope) => [
      scope.bindingOrdinal,
      candidates.filter((candidate) => candidate.bindingOrdinal === scope.bindingOrdinal).length
    ])
  );
  const selectedContentHashes = new Set(selected.map((candidate) => candidate.contentHash));
  const assignedContextHashes = new Set<string>();
  const passages = selected.map((candidate): KnowledgeRetrievalCorePassage => {
    const semantic = candidate.signals
      .filter((signal) => signal.lane === "passage_semantic")
      .sort((left, right) => left.rank - right.rank)[0] ?? null;
    const lexical = candidate.signals
      .filter((signal) => signal.lane.endsWith("_lexical"))
      .sort((left, right) => left.rank - right.rank)[0] ?? null;
    const context = selectKnowledgeContext({
      assignedContentHashes: assignedContextHashes,
      candidates: canonical.candidates,
      excludedContentHashes,
      selectedContentHashes,
      source: candidate
    });
    for (const neighbor of context) assignedContextHashes.add(neighbor.contentHash);
    const expandedContext = context.map((neighbor) =>
      `${knowledgeContextLabel(candidate, neighbor)}:\n${neighbor.text}`
    ).join("\n\n");
    return Object.freeze({
      ...candidate,
      annRank: semantic?.rank ?? null,
      ftsRank: lexical?.rank ?? null,
      ftsScore: lexical?.rawScore ?? null,
      ...(expandedContext ? { expandedContext } : {}),
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
    canonicalSourceProvenance: Object.freeze(canonicalSourceProvenance),
    passages: Object.freeze(passages),
    rankingEvidence,
    ...(rerankerBinding ? { rerankerBinding } : {}),
    vectorSearchEvidence: Object.freeze(vectorEvidence.sort((left, right) =>
      left.bindingOrdinal - right.bindingOrdinal))
  });
}

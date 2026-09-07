import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { knowledgeEvidenceOccurrenceKeyV1, isKnowledgeEvidenceOccurrenceKeyV1 } from "./evidenceOccurrence";
import { KnowledgeSearchFailure, knowledgeSearchFailureCode } from "./searchFailure";
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
  KNOWLEDGE_PRIOR_OCCURRENCE_MAX,
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
  KNOWLEDGE_METADATA_RELEVANCE_FLOOR,
  KNOWLEDGE_RERANK_OMITTED_ADMISSION_VERSION,
  KNOWLEDGE_RETRIEVAL_FUSION,
  KNOWLEDGE_RETRIEVAL_LANE_WEIGHTS,
  KNOWLEDGE_SCOPED_RERANK_INPUT_MAX,
  KNOWLEDGE_SEMANTIC_RELEVANCE_FLOOR,
  KNOWLEDGE_SIGNAL_RANK_MAX,
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
import {
  assembleKnowledgeParentExpansions,
  KNOWLEDGE_PARENT_CONTEXT_WINDOW_RADIUS,
  KNOWLEDGE_TABLE_CONTEXT_MAX,
  KNOWLEDGE_TABLE_CONTEXT_ROW_RADIUS,
  KnowledgeParentContextError,
  knowledgeParentContextTokenCounter,
  renderKnowledgeParentExpansionUnits,
  usableKnowledgeParentContextWindow,
  type KnowledgeParentContextFailureCode,
  type KnowledgeParentContextLoader,
  type KnowledgeParentContextRow,
  type KnowledgeParentExpansionPrimary,
  type KnowledgeParentSectionWindowRequest
} from "./parentContextExpansion";
import type {
  KnowledgeParentExpansion,
  KnowledgeParentExpansionUnit
} from "./retrievalTypes";
import {
  KNOWLEDGE_SEARCH_BACKEND_KIND,
  KNOWLEDGE_SEARCH_MAPPING_VERSION,
  KNOWLEDGE_SEARCH_MAX_MERGED_HITS,
  KNOWLEDGE_SEARCH_PHYSICAL_INDEX_VERSION,
  type KnowledgeBm25Hit
} from "../search/opensearch/contract";
import {
  createKnowledgePassageBm25Search,
  KnowledgeLexicalBackendEvidenceV1,
  KnowledgePassageBm25Search
} from "./searchRetrieval";
import {
  decodeKnowledgeSemanticHits,
  knowledgeSemanticCandidateLookupSql,
  knowledgeSemanticCandidateRevalidationSql,
  type KnowledgeSemanticHit,
  type KnowledgeSemanticQueryVector as QueryVector
} from "./semanticCandidates";

const KNOWLEDGE_VECTOR_ANN_EF_SEARCH = 400;
const KNOWLEDGE_VECTOR_ANN_MAX_SCAN_TUPLES = 100_000;
const KNOWLEDGE_VECTOR_BUCKET_COUNT = 16;
const KNOWLEDGE_LINEAR_CONTEXT_RADIUS = 1;
const KNOWLEDGE_LINEAR_CONTEXT_MAX = 2;

export type KnowledgeRetrievalCoreClient = Readonly<{
  $queryRaw<T = unknown>(query: Prisma.Sql): Promise<T>;
  /** Dedicated transaction with vector-index planning preferences. */
  $querySemantic?<T = unknown>(query: Prisma.Sql): Promise<T>;
  transactionLocalRetrievalSettings?: true;
}>;

/** Install before planning: set_config CTEs make otherwise parallel-safe
 * lexical ranking serial. Settings still expire with the bounded transaction. */
export function knowledgeRetrievalRuntimeSettingsSql(): Prisma.Sql {
  return Prisma.sql`SELECT
    -- Ranking runs in PostgreSQL's native text/vector functions. Avoid LLVM
    -- compilation of the surrounding short-lived scope/union expression tree.
    set_config('jit', 'off', true),
    set_config('hnsw.iterative_scan', 'strict_order', true),
    set_config('hnsw.ef_search', ${String(KNOWLEDGE_VECTOR_ANN_EF_SEARCH)}, true),
    set_config('hnsw.max_scan_tuples', ${String(KNOWLEDGE_VECTOR_ANN_MAX_SCAN_TUPLES)}, true),
    set_config('pg_trgm.word_similarity_threshold',
      ${String(Math.max(0, KNOWLEDGE_METADATA_RELEVANCE_FLOOR - 0.000_001))}, true)
  `;
}

/** Ready compatible hierarchical index versions for retrieval reads. Each
 * artifact contributes exactly one index (highest ready compatible version)
 * so pre-cutover version-3 rows stay retrievable until superseded through the
 * safe profile reindex, without double-counting any artifact. */
const compatibleIndexVersionsSql = Prisma.sql`ANY(ARRAY[${Prisma.join([
  ...KNOWLEDGE_HIERARCHICAL_COMPATIBLE_INDEX_VERSIONS
])}]::integer[])`;

export type KnowledgeRetrievalScopeFilter = Readonly<{
  bindingOrdinals?: readonly number[];
  sourceIds?: readonly string[];
}>;

export type KnowledgeSearchScope = Readonly<{
  acceptedIndexArtifactIds: readonly string[];
  baseName: string;
  bindingOrdinal: number;
  eligibleRows: number;
  indexGenerationId: string;
  knowledgeBaseId: string;
  projectionComplete: boolean;
  targetDimension: number;
}>;

type ScopeRow = KnowledgeSearchScope;

type CandidateRow = Omit<KnowledgeRetrievalCandidate, "signals" | "sourceArtifactId"> & Readonly<{
  contributingBindingOrdinals: readonly number[];
  exactKind: string | null;
  lane: KnowledgeRetrievalLane;
  laneRank: number;
  rawScore: number;
  /** Present only on rows returned by canonical OpenSearch revalidation. */
  searchIndexArtifactId: string | null;
  sourceArtifactId: string;
  vectorDistance: number | null;
  vectorMode: KnowledgeVectorSearchMode | null;
}>;

type HybridQueryEnvelopeRow = Readonly<{
  candidates: unknown;
  scopeVerified: unknown;
  semanticRevalidatedCount: unknown;
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
  /** In-memory FR-14 expansion units backing `expandedContext`; present
   * exactly when a parent-context loader ran for this operation. */
  expansion?: KnowledgeParentExpansion;
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
  lexicalBackendEvidence: KnowledgeLexicalBackendEvidenceV1;
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
      INNER JOIN "KnowledgeRunScope" AS run_scope
        ON run_scope."modelRunId" = run."id"
       AND run_scope."sourceBindingStrategy" = 'eager_v1'
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

/**
 * Narrow scope projection used before retrieval. Scope attestation does not
 * need passage text or layout metadata, and routing it through
 * passage hydration forces the database to assemble every retrieval row
 * before it can return the accepted hierarchy ids. Keep the same canonical
 * Source selection and ready/version checks while stopping at the immutable
 * hierarchy artifact boundary.
 */
function scopedIndexArtifactsSql(candidateIndexArtifactIds?: readonly string[]): Prisma.Sql {
  // Candidate identities only narrow the work before canonicalization; they
  // never grant scope. Every retained Source still passes the same immutable
  // binding, owner, version, readiness and latest-compatible-index checks.
  const candidateSourceArtifacts = candidateIndexArtifactIds === undefined
    ? null
    : Prisma.sql`
        SELECT candidate."sourceArtifactId"
        FROM "KnowledgeHierarchicalIndexArtifact" AS candidate
        WHERE candidate."id" = ANY(${candidateIndexArtifactIds}::text[])
      `;
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
        ${candidateSourceArtifacts ? Prisma.sql`
          AND snapshot_source."artifactId" IN (${candidateSourceArtifacts})
        ` : Prisma.empty}
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
        ${candidateSourceArtifacts ? Prisma.sql`
          AND source_binding."sourceArtifactId" IN (${candidateSourceArtifacts})
        ` : Prisma.empty}
        AND source_binding."sourceId" IS NOT NULL
        AND source_binding."sourceVersionId" IS NOT NULL
        AND source_binding."sourceArtifactId" IS NOT NULL
        AND source_binding."sourceId" = ANY(binding."selectedSourceIds")
    ),
    canonical_binding_sources AS MATERIALIZED (
      SELECT DISTINCT ON (
        source_binding."sourceId",
        source_binding."sourceVersionId",
        source_binding."artifactId"
      ) source_binding.*,
        array_agg(source_binding."bindingOrdinal") OVER (
          PARTITION BY source_binding."sourceId", source_binding."sourceVersionId",
            source_binding."artifactId"
          ORDER BY source_binding."bindingOrdinal"
          ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
        ) AS "contributingBindingOrdinals"
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
      source_binding."contributingBindingOrdinals",
      source_binding."knowledgeBaseId",
      source_binding."indexGenerationId",
      source_binding."targetDimension",
      source_binding."sourceId" AS "documentId",
      source_binding."sourceVersionId" AS "documentVersionId",
      source_detail."versionNumber" AS "documentVersionNumber",
      source_detail."fileName",
      source_binding."artifactId" AS "sourceArtifactId",
      hierarchy."id" AS "indexArtifactId",
      hierarchy."checksum" AS "hierarchicalChecksum",
      hierarchy."passageCount" AS "hierarchicalPassageCount"
    FROM canonical_binding_sources AS source_binding
    INNER JOIN LATERAL (
      SELECT version."versionNumber", version."fileName"
      FROM "KnowledgeSourceVersion" AS version
      INNER JOIN "KnowledgeSourceIndexArtifact" AS source_artifact
        ON source_artifact."id" = source_binding."artifactId"
       AND source_artifact."sourceVersionId" = source_binding."sourceVersionId"
       AND source_artifact."state" = 'ready'::"KnowledgeSourceArtifactState"
      WHERE version."id" = source_binding."sourceVersionId"
        AND version."sourceId" = source_binding."sourceId"
        AND version."ownerUserId" = source_binding."ownerUserId"
      LIMIT 1
    ) AS source_detail ON TRUE
    INNER JOIN LATERAL (
      SELECT candidate_hierarchy."id", candidate_hierarchy."checksum", candidate_hierarchy."passageCount"
      FROM "KnowledgeHierarchicalIndexArtifact" AS candidate_hierarchy
      WHERE candidate_hierarchy."sourceArtifactId" = source_binding."artifactId"
        AND candidate_hierarchy."sourceVersionId" = source_binding."sourceVersionId"
        AND candidate_hierarchy."state" = 'ready'::"KnowledgeHierarchicalIndexState"
        AND candidate_hierarchy."schemaVersion" = ${compatibleIndexVersionsSql}
      ORDER BY candidate_hierarchy."schemaVersion" DESC
      LIMIT 1
    ) AS hierarchy ON TRUE
  `;
}

/** Hydrate passage payloads from the one shared canonical artifact map. */
function sharedScopedPassagesSql(scopeName = "scoped_index_artifacts"): Prisma.Sql {
  return Prisma.sql`
    SELECT
      artifact."baseName",
      artifact."bindingOrdinal",
      artifact."knowledgeBaseId",
      artifact."indexGenerationId",
      artifact."targetDimension",
      artifact."contributingBindingOrdinals",
      artifact."documentId",
      artifact."documentVersionId",
      artifact."documentVersionNumber",
      artifact."fileName",
      artifact."sourceArtifactId",
      artifact."indexArtifactId",
      passage."id" AS "chunkId",
      passage."ordinal" AS "chunkIndex",
      passage."sectionId",
      passage."page",
      passage."headingPath",
      passage."documentContext",
      CASE
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
      embedding."embeddingDimension"
    FROM ${Prisma.raw(scopeName)} AS artifact
    INNER JOIN "KnowledgeArtifactPassageIndex" AS passage
      ON passage."indexArtifactId" = artifact."indexArtifactId"
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
  const scopedIndexArtifacts = scopedIndexArtifactsSql();
  return Prisma.sql`
    WITH
    bindings AS MATERIALIZED (${bindings}),
    scoped_index_artifacts AS NOT MATERIALIZED (${scopedIndexArtifacts})
    SELECT * FROM (${knowledgeRetrievalScopeRowsSql()}) AS scope
  `;
}

/** Use the same current ready-artifact/projection census at admission and
 * before external search, sharing the hybrid query's canonical artifact map. */
function knowledgeRetrievalScopeRowsSql(): Prisma.Sql {
  return Prisma.sql`
    WITH
    embedding_counts AS MATERIALIZED (
      SELECT
        embedding."indexArtifactId",
        embedding."embeddingDimension",
        count(*)::integer AS "eligibleRows"
      FROM "KnowledgeArtifactPassageEmbedding" AS embedding
      GROUP BY embedding."indexArtifactId", embedding."embeddingDimension"
    )
    SELECT
      binding."ordinal" AS "bindingOrdinal",
      binding."knowledgeBaseId",
      binding."indexGenerationId",
      binding."targetDimension",
      binding."baseName",
      COALESCE(
        array_agg(DISTINCT artifact."indexArtifactId" ORDER BY artifact."indexArtifactId")
          FILTER (WHERE artifact."indexArtifactId" IS NOT NULL),
        ARRAY[]::text[]
      ) AS "acceptedIndexArtifactIds",
      COALESCE(
        bool_and(
          COALESCE(
            projection."backendKind" = ${KNOWLEDGE_SEARCH_BACKEND_KIND}
            AND projection."mappingVersion" = ${KNOWLEDGE_SEARCH_MAPPING_VERSION}
            AND projection."state" = 'READY'::"KnowledgeSearchProjectionState"
            AND projection."expectedPassageCount" = artifact."hierarchicalPassageCount"
            AND projection."indexedPassageCount" = artifact."hierarchicalPassageCount"
            AND artifact."hierarchicalPassageCount" > 0
            AND projection."projectionFingerprint" = encode(sha256(convert_to(concat(
              '{"backend":"', ${KNOWLEDGE_SEARCH_BACKEND_KIND},
              '","hierarchicalChecksum":"', artifact."hierarchicalChecksum",
              '","indexArtifactId":"', artifact."indexArtifactId",
              '","mappingVersion":', ${KNOWLEDGE_SEARCH_MAPPING_VERSION},
              ',"passageCount":', artifact."hierarchicalPassageCount",
              ',"physicalIndexVersion":', ${KNOWLEDGE_SEARCH_PHYSICAL_INDEX_VERSION},
              ',"version":1}'
            ), 'UTF8')), 'hex'),
            false
          )
        ) FILTER (WHERE artifact."indexArtifactId" IS NOT NULL),
        true
      ) AS "projectionComplete",
      COALESCE(sum(embedding_count."eligibleRows") FILTER (
        WHERE embedding_count."embeddingDimension" = binding."targetDimension"
      ), 0)::integer AS "eligibleRows"
    FROM bindings AS binding
    LEFT JOIN scoped_index_artifacts AS artifact
      ON artifact."bindingOrdinal" = binding."ordinal"
    LEFT JOIN embedding_counts AS embedding_count
      ON embedding_count."indexArtifactId" = artifact."indexArtifactId"
    LEFT JOIN "KnowledgeSearchProjection" AS projection
      ON projection."indexArtifactId" = artifact."indexArtifactId"
    GROUP BY
      binding."ordinal",
      binding."knowledgeBaseId",
      binding."indexGenerationId",
      binding."targetDimension",
      binding."baseName"
    ORDER BY binding."ordinal"
  `;
}

/** Compare native scope values inside PostgreSQL. Returning the whole corpus
 * map again adds large JSON conversion and transfer costs; echoing the input
 * cannot detect a readiness or scope change between retrieval statements. */
function knowledgeRetrievalScopeVerificationSql(scopes: readonly ScopeRow[]): Prisma.Sql {
  const rows = Prisma.join(scopes.map((scope) => Prisma.sql`(
    ${scope.bindingOrdinal}::integer,
    ${scope.knowledgeBaseId}::text,
    ${scope.indexGenerationId}::text,
    ${scope.targetDimension}::integer,
    ${scope.baseName}::text,
    ${scope.acceptedIndexArtifactIds}::text[],
    ${scope.projectionComplete}::boolean,
    ${scope.eligibleRows}::integer
  )`));
  return Prisma.sql`
    WITH
    actual_scopes AS MATERIALIZED (${knowledgeRetrievalScopeRowsSql()}),
    expected_scopes(
      "bindingOrdinal", "knowledgeBaseId", "indexGenerationId", "targetDimension",
      "baseName", "acceptedIndexArtifactIds", "projectionComplete", "eligibleRows"
    ) AS MATERIALIZED (VALUES ${rows})
    SELECT NOT EXISTS (
      SELECT 1
      FROM actual_scopes AS actual
      FULL OUTER JOIN expected_scopes AS expected
        ON actual."bindingOrdinal" = expected."bindingOrdinal"
      WHERE actual."bindingOrdinal" IS NULL OR expected."bindingOrdinal" IS NULL
        OR actual."knowledgeBaseId" IS DISTINCT FROM expected."knowledgeBaseId"
        OR actual."indexGenerationId" IS DISTINCT FROM expected."indexGenerationId"
        OR actual."targetDimension" IS DISTINCT FROM expected."targetDimension"
        OR actual."baseName" IS DISTINCT FROM expected."baseName"
        OR actual."acceptedIndexArtifactIds" IS DISTINCT FROM expected."acceptedIndexArtifactIds"
        OR actual."projectionComplete" IS DISTINCT FROM expected."projectionComplete"
        OR actual."eligibleRows" IS DISTINCT FROM expected."eligibleRows"
    ) AS verified
  `;
}

function decodeScope(value: unknown): ScopeRow | null {
  if (!record(value)) return null;
  const bindingOrdinal = integer(value.bindingOrdinal);
  const eligibleRows = integer(value.eligibleRows);
  const targetDimension = integer(value.targetDimension);
  const acceptedIndexArtifactIds = Array.isArray(value.acceptedIndexArtifactIds) &&
    value.acceptedIndexArtifactIds.every((entry) => typeof entry === "string" && entry.length > 0)
    ? [...new Set(value.acceptedIndexArtifactIds as string[])].sort()
    : null;
  if (
    bindingOrdinal === null || bindingOrdinal < 0 ||
    bindingOrdinal >= KNOWLEDGE_SCOPE_MAX_BINDINGS ||
    eligibleRows === null || eligibleRows < 0 ||
    targetDimension !== 1_024 && targetDimension !== 1_536 ||
    acceptedIndexArtifactIds === null ||
    typeof value.projectionComplete !== "boolean" ||
    typeof value.baseName !== "string" || !value.baseName ||
    typeof value.indexGenerationId !== "string" || !value.indexGenerationId ||
    typeof value.knowledgeBaseId !== "string" || !value.knowledgeBaseId
  ) return null;
  return {
    acceptedIndexArtifactIds,
    baseName: value.baseName,
    bindingOrdinal,
    eligibleRows,
    indexGenerationId: value.indexGenerationId,
    knowledgeBaseId: value.knowledgeBaseId,
    projectionComplete: value.projectionComplete,
    targetDimension
  };
}

function validKnowledgeRetrievalScopeFilter(input: Readonly<{
  bindingOrdinals: readonly number[];
  sourceIds: readonly string[];
}>): boolean {
  return input.bindingOrdinals.length <= KNOWLEDGE_SCOPE_MAX_BINDINGS &&
    input.bindingOrdinals.every((ordinal) =>
      Number.isSafeInteger(ordinal) && ordinal >= 0 && ordinal < KNOWLEDGE_SCOPE_MAX_BINDINGS) &&
    new Set(input.bindingOrdinals).size === input.bindingOrdinals.length &&
    input.sourceIds.length <= KNOWLEDGE_SCOPE_MAX_BINDINGS * 1_024 &&
    input.sourceIds.every((sourceId) =>
      typeof sourceId === "string" && sourceId.length > 0 && sourceId.length <= 512) &&
    new Set(input.sourceIds).size === input.sourceIds.length;
}

/**
 * Re-resolves the immutable accepted run scope and proves that every required
 * lexical projection is ready. The tool executor calls this before query
 * embedding; the retrieval core calls it again immediately before search so a
 * projection that changes between stages still fails closed.
 */
export async function assertKnowledgeSearchScopeReady(
  client: KnowledgeRetrievalCoreClient,
  input: Readonly<{
    bindingOrdinals?: readonly number[];
    runId: string;
    sourceIds?: readonly string[];
    userId: string;
  }>
): Promise<readonly KnowledgeSearchScope[]> {
  const bindingOrdinals = input.bindingOrdinals ?? [];
  const sourceIds = input.sourceIds ?? [];
  if (!input.runId || !input.userId || !validKnowledgeRetrievalScopeFilter({
    bindingOrdinals,
    sourceIds
  })) {
    throw new Error("knowledge_retrieval_scope_filter_invalid");
  }
  const scopeRows = await client.$queryRaw<unknown[]>(knowledgeRetrievalScopeSql({
    ...(input.bindingOrdinals ? { bindingOrdinals: input.bindingOrdinals } : {}),
    runId: input.runId,
    ...(input.sourceIds ? { sourceIds: input.sourceIds } : {}),
    userId: input.userId
  }));
  const decodedScopes = scopeRows.map(decodeScope);
  if (decodedScopes.some((scope) => scope === null)) {
    throw new Error("knowledge_retrieval_scope_invalid");
  }
  const acceptedScopes = decodedScopes as ScopeRow[];
  if (
    acceptedScopes.length < 1 || acceptedScopes.length > KNOWLEDGE_SCOPE_MAX_BINDINGS ||
    new Set(acceptedScopes.map((scope) => scope.bindingOrdinal)).size !== acceptedScopes.length ||
    acceptedScopes.some((scope, index) => index > 0 &&
      scope.bindingOrdinal <= acceptedScopes[index - 1]!.bindingOrdinal)
  ) throw new Error("knowledge_retrieval_scope_invalid");

  const acceptedIndexArtifactIds = [...new Set(acceptedScopes.flatMap((scope) =>
    scope.acceptedIndexArtifactIds))].sort();
  if (acceptedIndexArtifactIds.length > 0 &&
    acceptedScopes.some((scope) => !scope.projectionComplete)) {
    throw new KnowledgeSearchFailure("knowledge_search_projection_incomplete",
      createHash("sha256").update(JSON.stringify(acceptedScopes)).digest("hex"));
  }
  return Object.freeze(acceptedScopes.map((scope) => Object.freeze(scope)));
}

function knowledgeVectorRetrievalBucket(knowledgeBaseId: string): number {
  return createHash("md5").update(knowledgeBaseId).digest()[0]! % KNOWLEDGE_VECTOR_BUCKET_COUNT;
}

/** BM25 owns global full-text candidate generation. PostgreSQL adds exact
 * identifiers and metadata, then revalidates canonical passage authority.
 * Section/document context is expanded around selected passages; globally
 * ranking those duplicate text representations scales with corpus matches. */
function knowledgeExactAndMetadataSearchSql(input: Readonly<{
  anchorQuery?: string;
  bindingOrdinals?: readonly number[];
  candidateLimit: number;
  query: string;
  runId: string;
  sharedScope?: boolean;
  sourceIds?: readonly string[];
  transactionLocalRetrievalSettings?: true;
  userId: string;
}>): Prisma.Sql {
  const bindings = retrievalBindingsSql(input);
  const scopedIndexArtifacts = scopedIndexArtifactsSql();
  const scopedPassages = sharedScopedPassagesSql();
  const scopeCtes = input.sharedScope
    ? Prisma.sql`
      scoped_chunks AS NOT MATERIALIZED (SELECT * FROM scoped_passages),
    `
    : Prisma.sql`
      bindings AS MATERIALIZED (${bindings}),
      scoped_index_artifacts AS MATERIALIZED (${scopedIndexArtifacts}),
      scoped_passages AS NOT MATERIALIZED (${scopedPassages}),
      scoped_chunks AS NOT MATERIALIZED (SELECT * FROM scoped_passages),
    `;
  const literalQuery = input.anchorQuery ?? input.query;
  const normalizedQuery = knowledgeExactNormalizedValue(input.query);
  const exactValues = knowledgeExactQueryValues(literalQuery);
  const exactValuesSql = exactValues.length > 0
    ? Prisma.sql`ARRAY[${Prisma.join(exactValues)}]::text[]`
    : Prisma.sql`ARRAY[]::text[]`;
  const laneRows = Prisma.sql`
      SELECT * FROM metadata_matches
      UNION ALL SELECT * FROM exact_raw
    `;
  // `%>` uses pg_trgm's GIN operator class whereas a bare
  // `word_similarity(...) >= floor` predicate scans every scoped metadata
  // entry. Keep the exact floor below as the authority and make this indexed
  // prefilter a strict superset so boundary-equal rows remain eligible.
  const metadataIndexThreshold = Math.max(0, KNOWLEDGE_METADATA_RELEVANCE_FLOOR - 0.000_001);
  return Prisma.sql`
    WITH
    ${scopeCtes}
    metadata_runtime_settings AS MATERIALIZED (
      ${input.transactionLocalRetrievalSettings ? Prisma.sql`SELECT 1` : Prisma.sql`SELECT set_config(
        'pg_trgm.word_similarity_threshold',
        ${String(metadataIndexThreshold)},
        true
      )`}
    ),
    exact_query_values AS MATERIALIZED (
      SELECT query_value."normalizedValue", query_value."queryOrdinal"::integer
      FROM unnest(${exactValuesSql}) WITH ORDINALITY
        AS query_value("normalizedValue", "queryOrdinal")
    ),
    accepted_scope_maps AS MATERIALIZED (
      SELECT
        artifact."bindingOrdinal",
        jsonb_object_agg(artifact."indexArtifactId", true) AS "indexArtifactMap"
      FROM scoped_index_artifacts AS artifact
      GROUP BY artifact."bindingOrdinal"
    ),
    metadata_matches AS MATERIALIZED (
      SELECT hit.*
      FROM accepted_scope_maps AS scope
      CROSS JOIN LATERAL (
        SELECT
          scope."bindingOrdinal",
          passage."id" AS "chunkId",
          'metadata'::text AS lane,
          word_similarity(
            ${normalizedQuery},
            entry."normalizedValue"
          )::double precision AS "rawScore",
          entry."kind"::text AS "exactKind"
        FROM "KnowledgeArtifactExactEntry" AS entry
        INNER JOIN "KnowledgeArtifactPassageIndex" AS passage
          ON passage."indexArtifactId" = entry."indexArtifactId"
         AND passage."ordinal" = 0
        CROSS JOIN metadata_runtime_settings
        WHERE scope."indexArtifactMap" ? entry."indexArtifactId"
          AND entry."passageId" IS NULL
          AND entry."kind" IN (
            'filename'::"KnowledgeExactEntryKind",
            'heading'::"KnowledgeExactEntryKind",
            'tag'::"KnowledgeExactEntryKind",
            'title'::"KnowledgeExactEntryKind"
          )
          AND entry."normalizedValue" %> ${normalizedQuery}
          AND word_similarity(${normalizedQuery}, entry."normalizedValue") >=
            ${KNOWLEDGE_METADATA_RELEVANCE_FLOOR}
        ORDER BY "rawScore" DESC, passage."id", entry."kind"::text
        LIMIT ${input.candidateLimit}
      ) AS hit
    ),
    exact_entry_matches AS MATERIALIZED (
      SELECT
        entry."indexArtifactId",
        entry."passageId",
        entry."sectionId",
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
      FROM "KnowledgeArtifactExactEntry" AS entry
      INNER JOIN exact_query_values AS query_value
        ON query_value."normalizedValue" = entry."normalizedValue"
    ),
    exact_matches AS MATERIALIZED (
      SELECT DISTINCT ON (
        scope."bindingOrdinal",
        passage."id",
        entry."normalizedValue"
      )
        scope."bindingOrdinal",
        passage."id" AS "chunkId",
        entry."normalizedValue",
        entry."queryOrdinal",
        entry."exactKind",
        entry."entryOrdinal",
        entry."kindPriority"
      FROM accepted_scope_maps AS scope
      INNER JOIN exact_entry_matches AS entry
        ON scope."indexArtifactMap" ? entry."indexArtifactId"
      LEFT JOIN "KnowledgeArtifactSectionIndex" AS exact_section
        ON exact_section."indexArtifactId" = entry."indexArtifactId"
       -- A passage-bound entry needs no section fallback. A separate join
       -- filter still reads the section index before discarding that row.
       AND exact_section."id" = CASE
         WHEN entry."passageId" IS NULL THEN entry."sectionId"
       END
      INNER JOIN "KnowledgeArtifactPassageIndex" AS passage
        ON passage."indexArtifactId" = entry."indexArtifactId"
       AND (
         entry."passageId" = passage."id"
         OR entry."passageId" IS NULL
           AND entry."sectionId" IS NOT NULL
           AND passage."sectionId" = entry."sectionId"
           AND passage."ordinal" = exact_section."passageStart"
         OR entry."passageId" IS NULL
           AND entry."sectionId" IS NULL
           AND passage."ordinal" = 0
       )
      ORDER BY
        scope."bindingOrdinal",
        passage."id",
        entry."normalizedValue",
        entry."kindPriority",
        entry."queryOrdinal",
        entry."entryOrdinal"
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
      SELECT
        exact_score."bindingOrdinal",
        exact_score."chunkId",
        'exact'::text AS lane,
        exact_score."rawScore",
        exact_score."exactKind"
      FROM exact_scores AS exact_score
    ),
    lane_rows AS (
      ${laneRows}
    ),
    eligible_lane_rows AS (
      SELECT *
      FROM lane_rows
      WHERE lane = 'exact'
        OR lane = 'metadata' AND "rawScore" >= ${KNOWLEDGE_METADATA_RELEVANCE_FLOOR}
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
      chunk."baseName",
      ranked."bindingOrdinal",
      chunk."contributingBindingOrdinals",
      ranked."chunkId",
      chunk."chunkIndex",
      chunk."contentHash",
      chunk."documentId",
      chunk."documentVersionId",
      chunk."documentVersionNumber",
      chunk."documentContext",
      chunk."fileName",
      chunk."headingPath",
      chunk."layoutKind",
      chunk."knowledgeBaseId",
      chunk."page",
      chunk."sectionId",
      chunk."sourceArtifactId",
      chunk."sourceName",
      chunk."text",
      ranked.lane,
      ranked."laneRank",
      ranked."rawScore",
      ranked."exactKind",
      NULL::double precision AS "vectorDistance",
      NULL::text AS "vectorMode"
    FROM ranked
    INNER JOIN scoped_chunks AS chunk
      ON chunk."bindingOrdinal" = ranked."bindingOrdinal"
     AND chunk."chunkId" = ranked."chunkId"
    WHERE ranked."laneRank" <= ${input.candidateLimit}
    ORDER BY ranked."bindingOrdinal", ranked.lane, ranked."laneRank"
  `;
}

/**
 * Revalidate semantic identities and combine them with exact/metadata hits
 * and bounded neighbors. Nearest-neighbor planning belongs to the preceding
 * semantic statement; this statement retains the current canonical scope proof.
 */
function knowledgeFocusedHybridSearchSql(input: Readonly<{
  acceptedScopes: readonly ScopeRow[];
  anchorQuery?: string;
  bindingOrdinals?: readonly number[];
  candidateLimit: number;
  query: string;
  resultLimit: number;
  runId: string;
  semanticHits: readonly KnowledgeSemanticHit[];
  sourceIds?: readonly string[];
  transactionLocalRetrievalSettings?: true;
  userId: string;
  vectors: readonly QueryVector[];
}>): Prisma.Sql {
  const bindings = retrievalBindingsSql(input);
  const scopedIndexArtifacts = scopedIndexArtifactsSql();
  const scopedPassages = sharedScopedPassagesSql();
  const lexicalQuery = knowledgeExactAndMetadataSearchSql({
    ...input,
    sharedScope: true
  });
  const vectorQueryUnion = Prisma.sql`SELECT
      "baseName", "bindingOrdinal", "contributingBindingOrdinals", "chunkId",
      "chunkIndex", "contentHash", "documentId", "documentVersionId", "documentVersionNumber",
      "documentContext", "fileName", "headingPath", "layoutKind", "knowledgeBaseId", "page", "sectionId",
      "sourceArtifactId", "sourceName", "text", "lane", "laneRank", "rawScore", "exactKind", "vectorDistance", "vectorMode"
      FROM revalidated_semantic_hits`;
  // Global semantic positions apply only after multiple distinct query
  // vectors have been combined within the same authorized binding.
  const vectorQueriesByBinding = new Map<number, Set<string>>();
  for (const vector of input.vectors) {
    const identities = vectorQueriesByBinding.get(vector.bindingOrdinal) ?? new Set<string>();
    identities.add(JSON.stringify([vector.targetDimension, vector.vector]));
    vectorQueriesByBinding.set(vector.bindingOrdinal, identities);
  }
  const globalSemanticBindings = [...vectorQueriesByBinding]
    .filter(([, identities]) => identities.size > 1)
    .map(([bindingOrdinal]) => bindingOrdinal)
    .sort((left, right) => left - right);
  const vectorCandidateCtes = globalSemanticBindings.length === 0
    ? Prisma.sql`vector_candidates AS MATERIALIZED (
      SELECT DISTINCT ON (candidate."bindingOrdinal", candidate."chunkId") candidate.*
      FROM vector_candidate_union AS candidate
      ORDER BY candidate."bindingOrdinal", candidate."chunkId", candidate."laneRank",
        candidate."vectorDistance"
    )`
    : Prisma.sql`vector_candidate_best AS MATERIALIZED (
      SELECT DISTINCT ON (candidate."bindingOrdinal", candidate."chunkId") candidate.*
      FROM vector_candidate_union AS candidate
      ORDER BY candidate."bindingOrdinal", candidate."chunkId", candidate."laneRank",
        candidate."vectorDistance"
    ),
    vector_candidates AS MATERIALIZED (
      SELECT
        candidate."baseName",
        candidate."bindingOrdinal",
        candidate."contributingBindingOrdinals",
        candidate."chunkId",
        candidate."chunkIndex",
        candidate."contentHash",
        candidate."documentId",
        candidate."documentVersionId",
        candidate."documentVersionNumber",
        candidate."documentContext",
        candidate."fileName",
        candidate."headingPath",
        candidate."layoutKind",
        candidate."knowledgeBaseId",
        candidate."page",
        candidate."sectionId",
        candidate."sourceArtifactId",
        candidate."sourceName",
        candidate."text",
        candidate.lane,
        CASE WHEN candidate."bindingOrdinal" = ANY(${globalSemanticBindings}::integer[])
          THEN row_number() OVER (
            PARTITION BY candidate."bindingOrdinal"
            ORDER BY candidate."laneRank", candidate."vectorDistance", candidate."chunkId"
          )::integer
          ELSE candidate."laneRank"
        END AS "laneRank",
        candidate."rawScore", candidate."exactKind", candidate."vectorDistance", candidate."vectorMode"
      FROM vector_candidate_best AS candidate
    )`;
  const neighborCandidates = Prisma.sql`
      SELECT neighbor.*
      FROM ranked_neighbor_candidates AS neighbor
      WHERE neighbor."laneRank" <= ${KNOWLEDGE_SIGNAL_RANK_MAX}
    `;
  return Prisma.sql`
    WITH
    bindings AS MATERIALIZED (${bindings}),
    scoped_index_artifacts AS MATERIALIZED (${scopedIndexArtifacts}),
    scoped_passages AS NOT MATERIALIZED (${scopedPassages}),
    lexical_candidates AS MATERIALIZED (${lexicalQuery}),
    revalidated_semantic_hits AS MATERIALIZED (${knowledgeSemanticCandidateRevalidationSql(input.semanticHits)}),
    vector_candidate_union AS MATERIALIZED (${vectorQueryUnion}),
    ${vectorCandidateCtes},
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
            WHEN 'exact' THEN ${KNOWLEDGE_RETRIEVAL_LANE_WEIGHTS.exact} *
              LEAST(1.0, GREATEST(0.0, candidate."rawScore"))
            WHEN 'metadata' THEN ${KNOWLEDGE_RETRIEVAL_LANE_WEIGHTS.metadata}
            WHEN 'passage_bm25' THEN ${KNOWLEDGE_RETRIEVAL_LANE_WEIGHTS.passage_bm25}
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
    neighbor_artifacts AS MATERIALIZED (
      SELECT artifact.*
      FROM scoped_index_artifacts AS artifact
      WHERE artifact."indexArtifactId" IN (
        SELECT passage."indexArtifactId"
        FROM anchors AS anchor
        INNER JOIN "KnowledgeArtifactPassageIndex" AS passage
          ON passage."id" = anchor."chunkId"
      )
    ),
    neighbor_passages AS MATERIALIZED (${sharedScopedPassagesSql("neighbor_artifacts")}),
    ranked_neighbor_candidates AS (
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
      INNER JOIN neighbor_passages AS source
        ON source."bindingOrdinal" = anchor."bindingOrdinal"
       AND source."chunkId" = anchor."chunkId"
      INNER JOIN neighbor_passages AS neighbor
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
    neighbor_candidates AS MATERIALIZED (
      ${neighborCandidates}
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
      (${knowledgeRetrievalScopeVerificationSql(input.acceptedScopes)}) AS "scopeVerified",
      (SELECT count(*)::integer FROM revalidated_semantic_hits) AS "semanticRevalidatedCount"
  `;
}

function knowledgeBm25RevalidationSql(input: Readonly<{
  bindingOrdinals?: readonly number[];
  hits: readonly KnowledgeBm25Hit[];
  runId: string;
  sourceIds?: readonly string[];
  userId: string;
}>): Prisma.Sql {
  if (input.hits.length < 1 || input.hits.length > KNOWLEDGE_SEARCH_MAX_MERGED_HITS) {
    throw new Error("knowledge_bm25_hits_invalid");
  }
  const bindings = retrievalBindingsSql(input);
  const scopedIndexArtifacts = scopedIndexArtifactsSql(
    [...new Set(input.hits.map((hit) => hit.indexArtifactId))]
  );
  const hits = Prisma.join(input.hits.map((hit) => Prisma.sql`(
    ${hit.indexArtifactId},
    ${hit.passageId},
    ${hit.sourceVersionId},
    ${hit.contentHash},
    ${hit.rank},
    ${hit.score}
  )`));
  // Keep hit and neighbor predicates eligible for passage-index pushdown.
  // Materializing every passage of each hit artifact can make the planner
  // combine broad neighbor rows before restricting them to matched anchors.
  return Prisma.sql`
    WITH
    bindings AS MATERIALIZED (${bindings}),
    scoped_index_artifacts AS MATERIALIZED (${scopedIndexArtifacts}),
    bm25_hits(
      "indexArtifactId",
      "chunkId",
      "sourceVersionId",
      "contentHash",
      "laneRank",
      "rawScore"
    ) AS MATERIALIZED (VALUES ${hits}),
    hit_artifacts AS MATERIALIZED (
      SELECT artifact.*
      FROM scoped_index_artifacts AS artifact
      WHERE artifact."indexArtifactId" IN (
        SELECT hit."indexArtifactId" FROM bm25_hits AS hit
      )
    ),
    scoped_passages AS NOT MATERIALIZED (${sharedScopedPassagesSql("hit_artifacts")}),
    matched AS MATERIALIZED (
      SELECT
        chunk."baseName",
        chunk."bindingOrdinal",
        chunk."contributingBindingOrdinals",
        chunk."chunkId",
        chunk."chunkIndex",
        chunk."contentHash",
        chunk."documentId",
        chunk."documentVersionId",
        chunk."documentVersionNumber",
        chunk."documentContext",
        chunk."fileName",
        chunk."headingPath",
        chunk."layoutKind",
        chunk."knowledgeBaseId",
        chunk."page",
        chunk."sectionId",
        chunk."sourceArtifactId",
        hit."indexArtifactId" AS "searchIndexArtifactId",
        chunk."sourceName",
        chunk."text",
        'passage_bm25'::text AS lane,
        hit."laneRank"::integer AS "laneRank",
        hit."rawScore"::double precision AS "rawScore",
        NULL::text AS "exactKind",
        NULL::double precision AS "vectorDistance",
        NULL::text AS "vectorMode"
      FROM bm25_hits AS hit
      INNER JOIN scoped_passages AS chunk
        ON chunk."indexArtifactId" = hit."indexArtifactId"
       AND chunk."chunkId" = hit."chunkId"
       AND chunk."documentVersionId" = hit."sourceVersionId"
       AND chunk."contentHash" = hit."contentHash"
    ),
    ranked_neighbor_candidates AS (
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
        NULL::text AS "searchIndexArtifactId",
        neighbor."sourceName",
        neighbor."text",
        'neighbor'::text AS lane,
        row_number() OVER (
          ORDER BY
            anchor."laneRank",
            abs(neighbor."chunkIndex" - source."chunkIndex"),
            neighbor."chunkId"
        )::integer AS "laneRank",
        (1.0 / (
          1 + anchor."laneRank" + abs(neighbor."chunkIndex" - source."chunkIndex")
        ))::double precision AS "rawScore",
        NULL::text AS "exactKind",
        NULL::double precision AS "vectorDistance",
        NULL::text AS "vectorMode"
      FROM matched AS anchor
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
    )
    SELECT * FROM matched
    UNION ALL
    SELECT neighbor.*
    FROM ranked_neighbor_candidates AS neighbor
    WHERE neighbor."laneRank" <= ${KNOWLEDGE_SIGNAL_RANK_MAX}
    ORDER BY "bindingOrdinal", lane, "laneRank", "chunkId"
  `;
}

const lanes = new Set<KnowledgeRetrievalLane>([
  "document_lexical",
  "exact",
  "metadata",
  "neighbor",
  "passage_bm25",
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
  const searchIndexArtifactId = value.searchIndexArtifactId === undefined ||
    value.searchIndexArtifactId === null
    ? null
    : typeof value.searchIndexArtifactId === "string" && value.searchIndexArtifactId.length > 0
      ? value.searchIndexArtifactId
      : undefined;
  const vectorDistance = value.vectorDistance === null ? null : finite(value.vectorDistance);
  const contributingBindingOrdinals = decodeContributingBindingOrdinals(
    value.contributingBindingOrdinals
  );
  if (
    bindingOrdinal === null || bindingOrdinal < 0 ||
    bindingOrdinal >= KNOWLEDGE_SCOPE_MAX_BINDINGS ||
    chunkIndex === null || chunkIndex < 0 || documentVersionNumber === null ||
    documentVersionNumber < 1 || laneRank === null || laneRank < 1 ||
    laneRank > KNOWLEDGE_SIGNAL_RANK_MAX ||
    page === null || page < 1 || rawScore === null ||
    searchIndexArtifactId === undefined ||
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
    searchIndexArtifactId,
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
      searchIndexArtifactId: _searchIndexArtifactId,
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
  scopeVerified: boolean;
  semanticRevalidatedCount: number;
}> {
  if (rows.length !== 1 || !record(rows[0])) {
    throw new Error("knowledge_retrieval_envelope_invalid");
  }
  const envelope = rows[0] as HybridQueryEnvelopeRow;
  const semanticRevalidatedCount = integer(envelope.semanticRevalidatedCount);
  if (!Array.isArray(envelope.candidates) || typeof envelope.scopeVerified !== "boolean" ||
    semanticRevalidatedCount === null || semanticRevalidatedCount < 0) {
    throw new Error("knowledge_retrieval_envelope_invalid");
  }
  return Object.freeze({
    candidates: decodeRows(envelope.candidates),
    scopeVerified: envelope.scopeVerified,
    semanticRevalidatedCount
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
  assignedOccurrenceKeys: ReadonlySet<string>;
  candidates: readonly KnowledgeRetrievalCandidate[];
  excludedOccurrenceKeys: ReadonlySet<string>;
  selectedOccurrenceKeys: ReadonlySet<string>;
  source: KnowledgeRetrievalCandidate;
}>): KnowledgeRetrievalCandidate[] {
  const available = input.candidates.filter((candidate) =>
    candidate.chunkId !== input.source.chunkId &&
    sameKnowledgeSource(input.source, candidate) &&
    !input.excludedOccurrenceKeys.has(knowledgeEvidenceOccurrenceKeyV1(candidate)) &&
    !input.assignedOccurrenceKeys.has(knowledgeEvidenceOccurrenceKeyV1(candidate)));
  const local = available.filter((candidate) =>
    !input.selectedOccurrenceKeys.has(knowledgeEvidenceOccurrenceKeyV1(candidate)) &&
    relatedKnowledgeContext(input.source, candidate))
    .sort((left, right) =>
      Math.abs(left.chunkIndex - input.source.chunkIndex) -
        Math.abs(right.chunkIndex - input.source.chunkIndex) ||
      left.chunkIndex - right.chunkIndex ||
      left.chunkId.localeCompare(right.chunkId));
  const independentlyMatched = fuseKnowledgeCandidates(available.filter((candidate) =>
    !input.selectedOccurrenceKeys.has(knowledgeEvidenceOccurrenceKeyV1(candidate)) &&
    independentlyMatchedTableContext(input.source, candidate)));
  const selected: KnowledgeRetrievalCandidate[] = [];
  const occurrences = new Set<string>();
  for (const candidate of [...local, ...independentlyMatched]) {
    const key = knowledgeEvidenceOccurrenceKeyV1(candidate);
    if (occurrences.has(key)) continue;
    occurrences.add(key);
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

/** Mirrors the `knowledgeContextLabel` branches: units that render with the
 * shared previous/next same-Source label are mergeable "section" units, so
 * one primary never ships more than one previous and one next block. */
function legacyExpansionOrigin(
  source: KnowledgeRetrievalCandidate,
  candidate: KnowledgeRetrievalCandidate
): "independent" | "section" | "table" {
  const sourceLocator = source.documentContext?.locator;
  const candidateLocator = candidate.documentContext?.locator;
  if (sourceLocator?.kind === "table_row" && candidateLocator?.kind === "table_row" &&
    sourceLocator.rowId !== candidateLocator.rowId) {
    return sourceLocator.blockId === candidateLocator.blockId ? "table" : "independent";
  }
  if (sourceLocator?.kind === "table_row" && !candidateLocator &&
    candidate.layoutKind === "body" && hasPrimarySignal(candidate)) {
    return "independent";
  }
  return "section";
}

function legacyExpansionUnit(
  source: KnowledgeRetrievalCandidate,
  candidate: KnowledgeRetrievalCandidate,
  rank: number,
  countTokens: (text: string) => number
): KnowledgeParentExpansionUnit {
  return Object.freeze({
    chunkId: candidate.chunkId,
    chunkIndex: candidate.chunkIndex,
    contentHash: candidate.contentHash,
    label: knowledgeContextLabel(source, candidate),
    origin: legacyExpansionOrigin(source, candidate),
    position: candidate.chunkIndex < source.chunkIndex
      ? "previous" as const
      : "next" as const,
    rank,
    text: candidate.text,
    tokens: countTokens(candidate.text)
  });
}

export async function executeKnowledgeRetrievalCore(
  client: KnowledgeRetrievalCoreClient,
  input: Readonly<{
    anchorQuery?: string;
    candidateLimit: number;
    bindingOrdinals?: readonly number[];
    excludedOccurrenceKeys: readonly string[];
    lexicalSearch?: KnowledgePassageBm25Search;
    /** FR-14 canonical-section window loader; present only for automatic
     * search operations, so exact/metadata/read operations never expand. */
    parentContextLoader?: KnowledgeParentContextLoader;
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
  const excludedOccurrenceKeys = new Set(input.excludedOccurrenceKeys);
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
    input.excludedOccurrenceKeys.length > KNOWLEDGE_PRIOR_OCCURRENCE_MAX ||
    excludedOccurrenceKeys.size !== input.excludedOccurrenceKeys.length ||
    input.excludedOccurrenceKeys.some((key) => !isKnowledgeEvidenceOccurrenceKeyV1(key))
  ) throw new Error("knowledge_retrieval_exclusion_invalid");
  if (!validKnowledgeRetrievalScopeFilter({
    bindingOrdinals: requestedBindingOrdinals,
    sourceIds: requestedSourceIds
  })) throw new Error("knowledge_retrieval_scope_filter_invalid");
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

  const queryRows = async <T>(query: Prisma.Sql, semantic = false): Promise<T> => {
    input.rerank?.signal?.throwIfAborted();
    // Raw-core callers do not own the repository's transaction wrapper.
    // Retain their runtime settings dependency inside the semantic statement.
    const statement = semantic && !client.transactionLocalRetrievalSettings
      ? Prisma.sql`WITH runtime_settings AS MATERIALIZED (${knowledgeRetrievalRuntimeSettingsSql()})
          SELECT candidate.* FROM runtime_settings
          CROSS JOIN LATERAL (${query}) AS candidate`
      : query;
    const rows = semantic && client.$querySemantic
      ? await client.$querySemantic<T>(statement)
      : await client.$queryRaw<T>(statement);
    input.rerank?.signal?.throwIfAborted();
    return rows;
  };
  const acceptedScopes = await assertKnowledgeSearchScopeReady({ $queryRaw: queryRows }, {
    ...(input.bindingOrdinals ? { bindingOrdinals: input.bindingOrdinals } : {}),
    runId: input.runId,
    ...(input.sourceIds ? { sourceIds: input.sourceIds } : {}),
    userId: input.userId
  });

  const scopeFingerprint = createHash("sha256").update(JSON.stringify(acceptedScopes)).digest("hex");
  const rerankConfigured = Boolean(input.rerank);
  const semanticInput = {
    candidateLimit: input.candidateLimit,
    ...(rerankConfigured ? { relaxRelevanceFloors: true } : {}),
    vectors: input.vectors
  };
  const semanticHits = input.vectors.length === 0 ? [] : decodeKnowledgeSemanticHits(
    await queryRows<unknown[]>(knowledgeSemanticCandidateLookupSql(semanticInput, acceptedScopes), true),
    semanticInput,
    acceptedScopes
  );
  const envelope = decodeHybridQueryEnvelope(await queryRows<unknown[]>(
    knowledgeFocusedHybridSearchSql({
      acceptedScopes,
      ...(input.anchorQuery ? { anchorQuery: input.anchorQuery } : {}),
      ...(input.bindingOrdinals ? { bindingOrdinals: input.bindingOrdinals } : {}),
      candidateLimit: input.candidateLimit,
      query: input.query,
      resultLimit: input.resultLimit,
      runId: input.runId,
      semanticHits,
      ...(input.sourceIds ? { sourceIds: input.sourceIds } : {}),
      ...(client.transactionLocalRetrievalSettings
        ? { transactionLocalRetrievalSettings: true as const } : {}),
      userId: input.userId,
      vectors: input.vectors
    })
  ));
  if (!envelope.scopeVerified) {
    throw new KnowledgeSearchFailure("knowledge_retrieval_scope_changed", scopeFingerprint);
  }

  if (envelope.semanticRevalidatedCount !== semanticHits.length) {
    throw new KnowledgeSearchFailure("knowledge_search_candidate_revalidation_failed", scopeFingerprint);
  }

  const acceptedIndexArtifactIds = [...new Set(acceptedScopes.flatMap((scope) =>
    scope.acceptedIndexArtifactIds))].sort();
  const bm25 = await (input.lexicalSearch ?? createKnowledgePassageBm25Search())({
    indexArtifactIds: acceptedIndexArtifactIds,
    ownerUserId: input.userId,
    queryVariants: [input.anchorQuery ?? input.query, input.query],
    ...(input.rerank?.signal ? { signal: input.rerank.signal } : {})
  }).catch((error: unknown) => {
    const code = knowledgeSearchFailureCode(error);
    if (code) throw new KnowledgeSearchFailure(code, scopeFingerprint);
    throw error;
  });
  input.rerank?.signal?.throwIfAborted();
  const bm25Rows = bm25.hits.length === 0
    ? []
    : decodeRows(await queryRows<unknown[]>(knowledgeBm25RevalidationSql({
        ...(input.bindingOrdinals ? { bindingOrdinals: input.bindingOrdinals } : {}),
        hits: bm25.hits,
        runId: input.runId,
        ...(input.sourceIds ? { sourceIds: input.sourceIds } : {}),
        userId: input.userId
      })));
  const revalidatedBm25Hits = new Set(bm25Rows
    .filter((row) => row.lane === "passage_bm25")
    .map((row) => JSON.stringify([
      row.searchIndexArtifactId,
      row.chunkId,
      row.documentVersionId,
      row.contentHash
    ])));
  if (revalidatedBm25Hits.size !== bm25.hits.length) {
    throw new KnowledgeSearchFailure("knowledge_search_candidate_revalidation_failed", scopeFingerprint);
  }

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
  const retrievedRows = Object.freeze([...envelope.candidates, ...bm25Rows]);
  const eligibleRows = rerankConfigured
    ? retrievedRows
    : retrievedRows.filter((candidate) =>
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
    !excludedOccurrenceKeys.has(knowledgeEvidenceOccurrenceKeyV1(candidate)));

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
    // With zero or one unique passage there is nothing to rank. Because no
    // learned relevance signal will be produced, keep today's deterministic
    // relevance floors instead of letting a weak singleton bypass the
    // existing no-relevant-evidence behavior merely because a role exists.
    const executionPool = pool.length <= 1
      ? Object.freeze(fuseKnowledgeCandidates(eligibleKnowledgeCandidates(pool)))
      : pool;
    const stage = await input.rerank.executor({
      candidates: executionPool.map((candidate) => ({
        chunkId: candidate.chunkId,
        headingPath: candidate.headingPath,
        sourceName: candidate.sourceName,
        text: candidate.text
      })),
      ...(input.rerank.signal ? { signal: input.rerank.signal } : {})
    });
    rerankerBinding = stage.evidence;
    if (executionPool.length <= 1) {
      const ranking = await rankKnowledgeCandidates({
        candidates: executionPool,
        resultLimit: input.resultLimit
      });
      candidates = executionPool;
      rankingEvidence = ranking.evidence;
      // A configured stage skipped for a singleton still has a rerank receipt.
      // Preserve its explicit unscored value for result persistence/replay;
      // absence of this field means that no reranker was configured.
      selected = ranking.selected.map(candidate => Object.freeze({ ...candidate, rerankScore: null }));
    } else if (stage.status === "degraded") {
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
        query: input.query,
        rerankScores: stage.scores
      }));
      const omittedCandidateCount = pool.filter((candidate) =>
        !stage.scores.has(candidate.chunkId)).length;
      const omittedRejectedCandidateCount = pool.length - ordered.length;
      candidates = ordered;
      rankingEvidence = Object.freeze({
        candidateOrder: Object.freeze(ordered.map((candidate) => candidate.chunkId)),
        fusion: KNOWLEDGE_RETRIEVAL_FUSION,
        ...(stage.status === "partial"
          ? {
              rerankOmittedAdmission: Object.freeze({
                omittedCandidateCount,
                omittedRejectedCandidateCount,
                version: KNOWLEDGE_RERANK_OMITTED_ADMISSION_VERSION
              })
            }
          : {})
      });
      selected = Object.freeze(selectRerankedKnowledgeCandidates({
        candidates: ordered,
        query: input.query,
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
  const selectedChunkIds = new Set(selected.map((candidate) => candidate.chunkId));
  const selectedSourceKeys = new Set(retainedCandidateProvenance
    .filter((entry) => selectedChunkIds.has(entry.chunkId))
    .map((entry) => JSON.stringify([entry.sourceId, entry.sourceVersionId, entry.artifactId])));
  const canonicalSourceProvenance = canonical.sourceProvenance.filter((entry) =>
    selectedSourceKeys.has(JSON.stringify([entry.sourceId, entry.sourceVersionId, entry.artifactId])));

  const candidateCounts: Record<number, number> = Object.fromEntries(
    acceptedScopes.map((scope) => [
      scope.bindingOrdinal,
      candidates.filter((candidate) => candidate.bindingOrdinal === scope.bindingOrdinal).length
    ])
  );
  const selectedOccurrenceKeys = new Set(selected.map(knowledgeEvidenceOccurrenceKeyV1));
  const assignedContextOccurrenceKeys = new Set<string>();
  // FR-14 child-to-parent expansion: load bounded canonical-section windows
  // for the final selection before provider delivery. A classified load
  // failure degrades to the candidate-pool mechanics below (PRD §18: parent
  // expansion failure never loses the answer); database, authority, and
  // invariant failures outside the classified stage propagate unchanged.
  const countTokens = input.parentContextLoader ? knowledgeParentContextTokenCounter() : null;
  let parentWindows: ReadonlyMap<string, readonly KnowledgeParentContextRow[]> = new Map();
  let parentLoadFailure: KnowledgeParentContextFailureCode | undefined;
  if (input.parentContextLoader) {
    const requests = selected.flatMap((candidate): KnowledgeParentSectionWindowRequest[] =>
      candidate.sectionId === null || candidate.sourceArtifactId === null ? [] : [{
        chunkId: candidate.chunkId,
        chunkIndex: candidate.chunkIndex,
        documentVersionId: candidate.documentVersionId,
        fromOrdinal: Math.max(0, candidate.chunkIndex - KNOWLEDGE_PARENT_CONTEXT_WINDOW_RADIUS),
        sectionId: candidate.sectionId,
        sourceArtifactId: candidate.sourceArtifactId,
        toOrdinal: candidate.chunkIndex + KNOWLEDGE_PARENT_CONTEXT_WINDOW_RADIUS
      }]);
    if (requests.length > 0) {
      try {
        parentWindows = await input.parentContextLoader(requests);
      } catch (error) {
        if (!(error instanceof KnowledgeParentContextError)) throw error;
        parentLoadFailure = error.code;
      }
    }
  }
  // Candidate-pool neighbor mechanics stay the owner for table and form
  // primaries; a body primary whose usable section window subsumes the linear
  // previous/next attachment skips the legacy selection so both mechanisms
  // never double-ship the same text (the assembly claim set also dedupes the
  // remaining overlap in either direction).
  const legacyContextByChunk = new Map<string, readonly KnowledgeRetrievalCandidate[]>();
  const expansionPrimaries: KnowledgeParentExpansionPrimary[] = [];
  for (const candidate of selected) {
    const sectionWindowUsable = countTokens !== null && parentLoadFailure === undefined &&
      candidate.layoutKind === "body" && candidate.sectionId !== null &&
      usableKnowledgeParentContextWindow(
        parentWindows.get(candidate.chunkId),
        candidate
      ) !== null;
    const context = sectionWindowUsable ? [] : selectKnowledgeContext({
      assignedOccurrenceKeys: assignedContextOccurrenceKeys,
      candidates: canonical.candidates,
      excludedOccurrenceKeys,
      selectedOccurrenceKeys,
      source: candidate
    });
    for (const neighbor of context) assignedContextOccurrenceKeys.add(knowledgeEvidenceOccurrenceKeyV1(neighbor));
    legacyContextByChunk.set(candidate.chunkId, context);
    if (countTokens !== null) {
      expansionPrimaries.push({
        chunkId: candidate.chunkId,
        chunkIndex: candidate.chunkIndex,
        contentHash: candidate.contentHash,
        ...(candidate.documentContext !== undefined
          ? { documentContext: candidate.documentContext }
          : {}),
        documentId: candidate.documentId,
        documentVersionId: candidate.documentVersionId,
        layoutKind: candidate.layoutKind,
        legacyUnits: Object.freeze(context.map((neighbor, index) =>
          legacyExpansionUnit(candidate, neighbor, index, countTokens))),
        page: candidate.page,
        sectionId: candidate.sectionId,
        sourceArtifactId: candidate.sourceArtifactId,
        text: candidate.text
      });
    }
  }
  let expansions: ReadonlyMap<string, KnowledgeParentExpansion> | null = null;
  if (countTokens !== null) {
    try {
      expansions = assembleKnowledgeParentExpansions({
        countTokens,
        excludedOccurrenceKeys,
        ...(parentLoadFailure ? { loadFailureCode: parentLoadFailure } : {}),
        primaries: expansionPrimaries,
        windows: parentWindows
      });
    } catch {
      // PRD §18: an expansion assembly defect keeps the atomic evidence and
      // the candidate-pool fallback with a content-free degradation reason.
      expansions = new Map(expansionPrimaries.map((primary) => [primary.chunkId, Object.freeze({
        reason: "parent_context_assembly_failed",
        state: "degraded" as const,
        units: primary.legacyUnits
      })]));
    }
  }
  const passages = selected.map((candidate): KnowledgeRetrievalCorePassage => {
    const semantic = candidate.signals
      .filter((signal) => signal.lane === "passage_semantic")
      .sort((left, right) => left.rank - right.rank)[0] ?? null;
    const lexical = candidate.signals
      .filter((signal) => signal.lane.endsWith("_lexical") || signal.lane === "passage_bm25")
      .sort((left, right) => left.rank - right.rank)[0] ?? null;
    const expansion = expansions?.get(candidate.chunkId);
    const expandedContext = expansion
      ? renderKnowledgeParentExpansionUnits(expansion.units)
      : (legacyContextByChunk.get(candidate.chunkId) ?? []).map((neighbor) =>
        `${knowledgeContextLabel(candidate, neighbor)}:\n${neighbor.text}`
      ).join("\n\n");
    return Object.freeze({
      ...candidate,
      annRank: semantic?.rank ?? null,
      ftsRank: lexical?.rank ?? null,
      ftsScore: lexical?.rawScore ?? null,
      ...(expandedContext ? { expandedContext } : {}),
      ...(expansion ? { expansion } : {}),
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
    lexicalBackendEvidence: bm25.evidence,
    passages: Object.freeze(passages),
    rankingEvidence,
    ...(rerankerBinding ? { rerankerBinding } : {}),
    vectorSearchEvidence: Object.freeze(vectorEvidence.sort((left, right) =>
      left.bindingOrdinal - right.bindingOrdinal))
  });
}

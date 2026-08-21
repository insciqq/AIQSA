import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  canonicalizeKnowledgeSourceCandidates,
  type KnowledgeCanonicalSourceBinding,
  type KnowledgeCanonicalSourceProvenance
} from "./canonicalSourceCandidates";
import { decodeKnowledgeDocumentContext } from "./documentContext";
import { KNOWLEDGE_HIERARCHICAL_INDEX_VERSION, knowledgeExactNormalizedValue } from "./hierarchicalIndex";
import {
  KNOWLEDGE_CANDIDATE_LIMIT,
  KNOWLEDGE_SCOPE_MAX_BINDINGS
} from "./retrievalTypes";
import {
  fuseKnowledgeCandidates,
  rankKnowledgeCandidates,
  type KnowledgeCandidateSignal,
  type KnowledgeRankingEvidence,
  type KnowledgeRetrievalCandidate,
  type KnowledgeRetrievalLane,
  type KnowledgeVectorSearchMode
} from "./retrievalRanking";

const KNOWLEDGE_VECTOR_ANN_EF_SEARCH = 400;
const KNOWLEDGE_VECTOR_ANN_MAX_SCAN_TUPLES = 100_000;
const KNOWLEDGE_VECTOR_BUCKET_COUNT = 16;

type RetrievalCoreClient = Pick<PrismaClient, "$queryRaw">;

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
  vectorDistance: number | null;
  vectorScore: number | null;
}>;

export type KnowledgeRetrievalCoreResult = Readonly<{
  bindingCount: number;
  candidateCount: number;
  candidateCounts: Readonly<Record<number, number>>;
  canonicalSourceProvenance: readonly KnowledgeCanonicalSourceProvenance[];
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
      passage."englishSearchVector",
      passage."russianSearchVector",
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
  runId: string;
  sourceIds?: readonly string[];
  userId: string;
  vector: QueryVector;
}>): Prisma.Sql {
  const bindings = retrievalBindingsSql(input);
  const scopedPassages = scopedPassagesSql();
  const globalDistance = vectorDistanceExpression(input.vector, "embedding");
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
       AND hierarchy."schemaVersion" = ${KNOWLEDGE_HIERARCHICAL_INDEX_VERSION}
      WHERE embedding."embeddingDimension" = ${input.vector.targetDimension}
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

function knowledgeMultiLaneLexicalSearchSql(input: Readonly<{
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
  bindingOrdinals?: readonly number[];
  candidateLimit: number;
  query: string;
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
  const vectorQueries = Prisma.join(input.vectors.map((vector) => {
    const query = knowledgeVectorLaneSql({
      ...(input.bindingOrdinals ? { bindingOrdinals: input.bindingOrdinals } : {}),
      candidateLimit: input.candidateLimit,
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
    vector_candidates AS MATERIALIZED (${vectorQueries}),
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
            WHEN 'document_lexical' THEN 0.7
            WHEN 'metadata' THEN 1.2
            WHEN 'passage_lexical' THEN 1.3
            WHEN 'passage_semantic' THEN 1.15
            WHEN 'section_lexical' THEN 0.9
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
       AND abs(neighbor."chunkIndex" - source."chunkIndex") = 1
       AND (
         source."documentContext" IS NULL AND neighbor."documentContext" IS NULL
         OR source."documentContext"->'locator'->>'rowId' IS NOT NULL
           AND neighbor."documentContext"->'locator'->>'rowId' =
             source."documentContext"->'locator'->>'rowId'
         OR source."documentContext"->'locator'->>'fieldGroupId' IS NOT NULL
           AND neighbor."documentContext"->'locator'->>'fieldGroupId' =
             source."documentContext"->'locator'->>'fieldGroupId'
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

export async function executeKnowledgeRetrievalCore(
  client: RetrievalCoreClient,
  input: Readonly<{
    candidateLimit: number;
    bindingOrdinals?: readonly number[];
    query: string;
    resultLimit: number;
    runId: string;
    sourceIds?: readonly string[];
    userId: string;
    vectors: readonly QueryVector[];
  }>
): Promise<KnowledgeRetrievalCoreResult> {
  const requestedBindingOrdinals = input.bindingOrdinals ?? [];
  const requestedSourceIds = input.sourceIds ?? [];
  if (
    input.candidateLimit !== KNOWLEDGE_CANDIDATE_LIMIT ||
    input.resultLimit !== 8 ||
    typeof input.query !== "string" || !input.query.trim() ||
    [...input.query].length > 3_000
  ) throw new Error("knowledge_retrieval_request_invalid");
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
    input.vectors.length < 1 || input.vectors.length > KNOWLEDGE_SCOPE_MAX_BINDINGS ||
    new Set(input.vectors.map((vector) => vector.bindingOrdinal)).size !== input.vectors.length ||
    input.vectors.some((vector) =>
      !Number.isSafeInteger(vector.bindingOrdinal) || vector.bindingOrdinal < 0 ||
      vector.bindingOrdinal >= KNOWLEDGE_SCOPE_MAX_BINDINGS ||
      !vector.knowledgeBaseId || !vector.indexGenerationId ||
      vector.vector.length !== vector.targetDimension ||
      vector.vector.some((value) => !Number.isFinite(value)))
  ) throw new Error("knowledge_query_vector_invalid");

  const envelope = decodeHybridQueryEnvelope(await client.$queryRaw<unknown[]>(
    knowledgeFocusedHybridSearchSql({
      ...(input.bindingOrdinals ? { bindingOrdinals: input.bindingOrdinals } : {}),
      candidateLimit: input.candidateLimit,
      query: input.query,
      resultLimit: input.resultLimit,
      runId: input.runId,
      ...(input.sourceIds ? { sourceIds: input.sourceIds } : {}),
      userId: input.userId,
      vectors: input.vectors
    })
  ));
  const acceptedScopes = envelope.scopes;
  const vectorUnavailable = acceptedScopes.some((scope) => scope.eligibleRows < 1);
  if (
    acceptedScopes.length < 1 || acceptedScopes.length > KNOWLEDGE_SCOPE_MAX_BINDINGS ||
    new Set(acceptedScopes.map((scope) => scope.bindingOrdinal)).size !== acceptedScopes.length ||
    vectorUnavailable ||
    acceptedScopes.some((scope, index) => index > 0 &&
      scope.bindingOrdinal <= acceptedScopes[index - 1]!.bindingOrdinal)
  ) throw new Error(vectorUnavailable
    ? "knowledge_retrieval_vector_unavailable"
    : "knowledge_retrieval_scope_invalid");

  const byOrdinal = new Map(acceptedScopes.map((scope) => [scope.bindingOrdinal, scope]));
  if (input.vectors.length !== acceptedScopes.length) {
    throw new Error("knowledge_query_vector_invalid");
  }
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
    const available = scope.eligibleRows > 0;
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
  const merged = mergedCandidates(envelope.candidates, byOrdinal);
  const canonical = canonicalizeKnowledgeSourceCandidates(
    merged.candidates,
    merged.sourceBindings
  );
  const candidates = fuseKnowledgeCandidates(
    canonical.candidates.filter(hasPrimarySignal)
  ).slice(0, input.candidateLimit);
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
  const ranking = await rankKnowledgeCandidates({
    candidates,
    resultLimit: input.resultLimit
  });

  const candidateCounts: Record<number, number> = Object.fromEntries(
    acceptedScopes.map((scope) => [
      scope.bindingOrdinal,
      candidates.filter((candidate) => candidate.bindingOrdinal === scope.bindingOrdinal).length
    ])
  );
  const selectedContentHashes = new Set(ranking.selected.map((candidate) => candidate.contentHash));
  const assignedContextHashes = new Set<string>();
  const passages = ranking.selected.map((candidate): KnowledgeRetrievalCorePassage => {
    const semantic = candidate.signals
      .filter((signal) => signal.lane === "passage_semantic")
      .sort((left, right) => left.rank - right.rank)[0] ?? null;
    const lexical = candidate.signals
      .filter((signal) => signal.lane.endsWith("_lexical"))
      .sort((left, right) => left.rank - right.rank)[0] ?? null;
    const context = canonical.candidates
      .filter((neighbor) =>
        neighbor.chunkId !== candidate.chunkId &&
        neighbor.documentId === candidate.documentId &&
        neighbor.documentVersionId === candidate.documentVersionId &&
        neighbor.sourceArtifactId === candidate.sourceArtifactId &&
        Math.abs(neighbor.chunkIndex - candidate.chunkIndex) === 1 &&
        !selectedContentHashes.has(neighbor.contentHash) &&
        !assignedContextHashes.has(neighbor.contentHash))
      .sort((left, right) => left.chunkIndex - right.chunkIndex ||
        left.chunkId.localeCompare(right.chunkId))
      .slice(0, 2);
    for (const neighbor of context) assignedContextHashes.add(neighbor.contentHash);
    const expandedContext = context.map((neighbor) =>
      `${neighbor.chunkIndex < candidate.chunkIndex ? "Previous" : "Next"} same-Source context:\n${neighbor.text}`
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
    rankingEvidence: ranking.evidence,
    vectorSearchEvidence: Object.freeze(vectorEvidence.sort((left, right) =>
      left.bindingOrdinal - right.bindingOrdinal))
  });
}

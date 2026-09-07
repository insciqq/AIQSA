import { Prisma } from "@prisma/client";
import { KNOWLEDGE_LANE_CANDIDATE_LIMIT, KNOWLEDGE_SEMANTIC_RELEVANCE_FLOOR } from "./retrievalRanking";

export type KnowledgeSemanticQueryVector = Readonly<{
  bindingOrdinal: number;
  indexGenerationId: string;
  knowledgeBaseId: string;
  targetDimension: 1_024 | 1_536;
  vector: readonly number[];
}>;

type SemanticScope = Readonly<{
  acceptedIndexArtifactIds: readonly string[];
  bindingOrdinal: number;
  indexGenerationId: string;
  knowledgeBaseId: string;
  targetDimension: number;
}>;

type SemanticLookupInput = Readonly<{
  candidateLimit: number;
  relaxRelevanceFloors?: boolean;
  vectors: readonly KnowledgeSemanticQueryVector[];
}>;

/** Candidate identity only; text is loaded after canonical scope revalidation. */
export type KnowledgeSemanticHit = Readonly<{
  queryOrdinal: number;
  bindingOrdinal: number;
  indexArtifactId: string;
  chunkId: string;
  documentId: string;
  documentVersionId: string;
  sourceArtifactId: string;
  contentHash: string;
  laneRank: number;
  vectorDistance: number;
}>;

export function validateKnowledgeSemanticVectorScopes(
  input: SemanticLookupInput,
  scopes: readonly SemanticScope[]
): void {
  for (const vector of input.vectors) {
    const scope = scopes.find(row => row.bindingOrdinal === vector.bindingOrdinal);
    if (!scope || scope.knowledgeBaseId !== vector.knowledgeBaseId ||
      scope.indexGenerationId !== vector.indexGenerationId ||
      scope.targetDimension !== vector.targetDimension ||
      vector.vector.length !== vector.targetDimension ||
      vector.vector.some(value => !Number.isFinite(value))) {
      throw new Error("knowledge_query_vector_invalid");
    }
  }
}

function vectorDistanceExpression(vector: KnowledgeSemanticQueryVector): Prisma.Sql {
  const literal = `[${vector.vector.join(",")}]`;
  return vector.targetDimension === 1_024
    ? Prisma.sql`embedding."embedding"::vector(1024) <=> ${literal}::vector(1024)`
    : Prisma.sql`embedding."embedding"::vector(1536) <=> ${literal}::vector(1536)`;
}

/** Keep nearest-neighbor planning independent of payload, exact and metadata
 * joins. The admitted immutable artifact map filters before the top-K limit;
 * canonical identity joins happen only after that bounded vector selection. */
export function knowledgeSemanticCandidateLookupSql(
  input: SemanticLookupInput,
  scopes: readonly SemanticScope[]
): Prisma.Sql {
  validateKnowledgeSemanticVectorScopes(input, scopes);
  if (input.candidateLimit !== KNOWLEDGE_LANE_CANDIDATE_LIMIT || input.vectors.length === 0) {
    throw new Error("knowledge_semantic_request_invalid");
  }
  const queries = input.vectors.map((vector, queryOrdinal) => {
    const scope = scopes.find(row => row.bindingOrdinal === vector.bindingOrdinal)!;
    const distance = vectorDistanceExpression(vector);
    // A monotone distance ceiling retains the eligible prefix. Applying it
    // inside iterative ANN could scan the entire index trying to fill K.
    const floor = input.relaxRelevanceFloors ? Prisma.empty :
      Prisma.sql`WHERE hit."vectorDistance" <= ${1 - KNOWLEDGE_SEMANTIC_RELEVANCE_FLOOR}`;
    return Prisma.sql`SELECT * FROM (
      WITH accepted_scope AS MATERIALIZED (
        SELECT COALESCE(jsonb_object_agg(accepted."indexArtifactId", true), '{}'::jsonb)
          AS "indexArtifactMap"
        FROM unnest(${scope.acceptedIndexArtifactIds}::text[]) AS accepted("indexArtifactId")
      ), vector_hits AS MATERIALIZED (
        SELECT embedding."indexArtifactId", embedding."passageId" AS "chunkId",
          ${distance} AS "vectorDistance"
        FROM "KnowledgeArtifactPassageEmbedding" AS embedding
        WHERE embedding."embeddingDimension" = ${vector.targetDimension}
          AND COALESCE((SELECT scope."indexArtifactMap" FROM accepted_scope AS scope)
            ? embedding."indexArtifactId", false)
        ORDER BY ${distance}
        LIMIT ${input.candidateLimit}
      ), ranked AS (
        SELECT hit.*, row_number() OVER (
          ORDER BY hit."vectorDistance", hit."chunkId"
        )::integer AS "laneRank"
        FROM vector_hits AS hit ${floor}
      )
      SELECT ${queryOrdinal}::integer AS "queryOrdinal",
        ${vector.bindingOrdinal}::integer AS "bindingOrdinal",
        hit."indexArtifactId", hit."chunkId", version."sourceId" AS "documentId",
        hierarchy."sourceVersionId" AS "documentVersionId", hierarchy."sourceArtifactId",
        passage."contentHash", hit."laneRank", hit."vectorDistance"::double precision
      FROM ranked AS hit
      INNER JOIN "KnowledgeArtifactPassageIndex" AS passage
        ON passage."id" = hit."chunkId" AND passage."indexArtifactId" = hit."indexArtifactId"
      INNER JOIN "KnowledgeHierarchicalIndexArtifact" AS hierarchy
        ON hierarchy."id" = hit."indexArtifactId"
      INNER JOIN "KnowledgeSourceVersion" AS version
        ON version."id" = hierarchy."sourceVersionId"
    ) AS semantic_query`;
  });
  return Prisma.sql`${Prisma.join(queries, " UNION ALL ")}
    ORDER BY "queryOrdinal", "laneRank", "chunkId"`;
}

export function decodeKnowledgeSemanticHits(
  rows: unknown,
  input: SemanticLookupInput,
  scopes: readonly SemanticScope[]
): readonly KnowledgeSemanticHit[] {
  if (!Array.isArray(rows) || rows.length > input.vectors.length * input.candidateLimit) {
    throw new Error("knowledge_semantic_candidates_invalid");
  }
  const keys = new Set<string>(), lastRanks = new Map<number, number>();
  const lastDistances = new Map<number, number>();
  let previousQuery = -1;
  return rows.map((value: unknown) => {
    const fail = (): never => { throw new Error("knowledge_semantic_candidates_invalid"); };
    if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
    const row = value as Record<string, unknown>;
    const { queryOrdinal, bindingOrdinal, laneRank, vectorDistance } = row;
    if (typeof queryOrdinal !== "number" || !Number.isInteger(queryOrdinal) || queryOrdinal < 0 ||
      queryOrdinal >= input.vectors.length || queryOrdinal < previousQuery) return fail();
    const vector = input.vectors[queryOrdinal]!;
    const scope = scopes.find(item => item.bindingOrdinal === vector.bindingOrdinal);
    if (!scope || bindingOrdinal !== vector.bindingOrdinal || typeof laneRank !== "number" ||
      !Number.isInteger(laneRank) || laneRank !== (lastRanks.get(queryOrdinal) ?? 0) + 1 ||
      laneRank > input.candidateLimit || typeof vectorDistance !== "number" ||
      !Number.isFinite(vectorDistance) || vectorDistance < 0 || vectorDistance > 2 ||
      vectorDistance < (lastDistances.get(queryOrdinal) ?? 0)) return fail();
    const identity = [row.indexArtifactId, row.chunkId, row.documentId, row.documentVersionId, row.sourceArtifactId];
    if (!identity.every(field => typeof field === "string" && field.length > 0 && field.length <= 512)) return fail();
    if (typeof row.contentHash !== "string" || !/^[0-9a-f]{64}$/u.test(row.contentHash) ||
      !scope.acceptedIndexArtifactIds.includes(row.indexArtifactId as string)) return fail();
    const key = JSON.stringify([queryOrdinal, row.indexArtifactId, row.chunkId]);
    if (keys.has(key)) return fail();
    keys.add(key); lastRanks.set(queryOrdinal, laneRank); previousQuery = queryOrdinal;
    lastDistances.set(queryOrdinal, vectorDistance);
    return Object.freeze({ queryOrdinal, bindingOrdinal: vector.bindingOrdinal,
      indexArtifactId: row.indexArtifactId as string, chunkId: row.chunkId as string,
      documentId: row.documentId as string, documentVersionId: row.documentVersionId as string,
      sourceArtifactId: row.sourceArtifactId as string, contentHash: row.contentHash, laneRank, vectorDistance });
  });
}

/** The caller supplies the current canonical scoped_passages CTE. Matching
 * the complete tuple prevents stale candidate evidence from authorizing text. */
export function knowledgeSemanticCandidateRevalidationSql(hits: readonly KnowledgeSemanticHit[]): Prisma.Sql {
  return Prisma.sql`SELECT
    passage."baseName", passage."bindingOrdinal", passage."contributingBindingOrdinals",
    passage."chunkId", passage."chunkIndex", passage."contentHash", passage."documentId",
    passage."documentVersionId", passage."documentVersionNumber", passage."documentContext",
    passage."fileName", passage."headingPath", passage."layoutKind", passage."knowledgeBaseId",
    passage."page", passage."sectionId", passage."sourceArtifactId", passage."sourceName", passage."text",
    'passage_semantic'::text AS lane, hit."laneRank",
    (1.0 - hit."vectorDistance")::double precision AS "rawScore", NULL::text AS "exactKind",
    hit."vectorDistance", 'ann'::text AS "vectorMode", hit."queryOrdinal"
  FROM jsonb_to_recordset(${JSON.stringify(hits)}::jsonb) AS hit(
    "queryOrdinal" integer, "bindingOrdinal" integer, "indexArtifactId" text, "chunkId" text,
    "documentId" text, "documentVersionId" text, "sourceArtifactId" text, "contentHash" text,
    "laneRank" integer, "vectorDistance" double precision)
  INNER JOIN scoped_passages AS passage
    ON passage."bindingOrdinal" = hit."bindingOrdinal" AND passage."indexArtifactId" = hit."indexArtifactId"
    AND passage."chunkId" = hit."chunkId" AND passage."documentId" = hit."documentId"
    AND passage."documentVersionId" = hit."documentVersionId"
    AND passage."sourceArtifactId" = hit."sourceArtifactId" AND passage."contentHash" = hit."contentHash"`;
}

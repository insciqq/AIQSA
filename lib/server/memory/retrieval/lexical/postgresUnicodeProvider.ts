import { Prisma, type PrismaClient } from "@prisma/client";
import type { MemoryRetrievalLane } from "../../../../domain/memory/retrieval";
import {
  MEMORY_LEXICAL_CANDIDATE_PROVIDER_LANES,
  isMemoryLexicalCandidateProviderLane,
  type MemoryLexicalCandidateProviderLane,
  type MemoryLexicalCandidateProvider,
  type MemoryLexicalSearchRequest,
  type MemoryLexicalSearchResult
} from "./contract";
import {
  assertPostgresMemoryLexicalRequest,
  executePostgresMemoryLexicalQuery,
  postgresMemoryLexicalItemTypePredicate,
  postgresMemoryLexicalRequestedTerms,
  postgresMemoryLexicalSourcePredicate
} from "./postgresShared";

export const POSTGRES_UNICODE_MEMORY_LEXICAL_LANES =
  MEMORY_LEXICAL_CANDIDATE_PROVIDER_LANES;

export type PostgresUnicodeMemoryLexicalLane =
  MemoryLexicalCandidateProviderLane;

export function isPostgresUnicodeMemoryLexicalLane(
  lane: MemoryRetrievalLane
): lane is PostgresUnicodeMemoryLexicalLane {
  return isMemoryLexicalCandidateProviderLane(lane);
}

function postgresUnicodeFtsSql(request: MemoryLexicalSearchRequest): Prisma.Sql {
  const { terms, variantOrdinals } = postgresMemoryLexicalRequestedTerms(request);
  return Prisma.sql`
    WITH query_terms AS MATERIALIZED (
      SELECT DISTINCT term, "variantOrdinal",
        char_length(term)::integer AS "termLength",
        plainto_tsquery('simple', term) AS query
      FROM unnest(${terms}::text[], ${variantOrdinals}::integer[])
        AS terms(term, "variantOrdinal")
      WHERE plainto_tsquery('simple', term) <> ''::tsquery
    ),
    candidate_matches AS MATERIALIZED (
      SELECT entry."id" AS "searchEntryId", entry."safeContentHash",
        query_terms."variantOrdinal",
        COUNT(*)::integer AS "matchedTermCount",
        COALESCE(MAX(query_terms."termLength"), 0)::integer AS
          "maximumMatchedTermLength",
        COALESCE(SUM(ts_rank_cd(entry."searchVectorSimple", query_terms.query)),
          0.0)::double precision AS "backendScore"
      FROM "MemorySearchEntry" AS entry
      INNER JOIN query_terms
        ON entry."searchVectorSimple" @@ query_terms.query
      WHERE entry."userId" = ${request.userId}
        AND entry."indexGenerationId" = ${request.activeGenerationId}
        AND ${postgresMemoryLexicalItemTypePredicate(request)}
        AND ${postgresMemoryLexicalSourcePredicate(request)}
      GROUP BY entry."id", entry."safeContentHash", query_terms."variantOrdinal"
    ),
    ranked_entry_matches AS MATERIALIZED (
      SELECT candidate_matches.*,
        ROW_NUMBER() OVER (
          PARTITION BY candidate_matches."variantOrdinal"
          ORDER BY candidate_matches."maximumMatchedTermLength" DESC,
            candidate_matches."matchedTermCount" DESC,
            candidate_matches."backendScore" DESC,
            candidate_matches."searchEntryId"
        )::integer AS "rankWithinVariant"
      FROM candidate_matches
    )
    SELECT "searchEntryId", "safeContentHash", "variantOrdinal",
      "rankWithinVariant", "matchedTermCount", "maximumMatchedTermLength",
      "backendScore"
    FROM ranked_entry_matches
    WHERE "rankWithinVariant" <= ${request.candidateLimitPerVariant}
    ORDER BY "rankWithinVariant", "variantOrdinal",
      "maximumMatchedTermLength" DESC, "matchedTermCount" DESC,
      "backendScore" DESC, "searchEntryId"
  `;
}

function postgresUnicodeNgramSql(request: MemoryLexicalSearchRequest): Prisma.Sql {
  const { terms, variantOrdinals } = postgresMemoryLexicalRequestedTerms(request);
  if (request.variants.some((variant) => variant.logicalTerms.some((term) =>
    term.characterLength < 2))) {
    throw new Error("memory_lexical_search_request_invalid");
  }
  const indexedMatches = terms.map((term) =>
    Prisma.sql`${term} <% entry."normalizedSearchText"`);
  return Prisma.sql`
    WITH candidate_entries AS MATERIALIZED (
      SELECT entry."id", entry."safeContentHash", entry."normalizedSearchText"
      FROM "MemorySearchEntry" AS entry
      WHERE entry."userId" = ${request.userId}
        AND entry."indexGenerationId" = ${request.activeGenerationId}
        AND ${postgresMemoryLexicalItemTypePredicate(request)}
        AND ${postgresMemoryLexicalSourcePredicate(request)}
        AND (${Prisma.join(indexedMatches, " OR ")})
    ),
    query_terms AS MATERIALIZED (
      SELECT DISTINCT term, "variantOrdinal",
        char_length(term)::integer AS "termLength"
      FROM unnest(${terms}::text[], ${variantOrdinals}::integer[])
        AS terms(term, "variantOrdinal")
      WHERE char_length(term) >= 2
    ),
    candidate_matches AS MATERIALIZED (
      SELECT entry."id" AS "searchEntryId", entry."safeContentHash",
        term_match."variantOrdinal", term_match."matchedTermCount",
        term_match."maximumMatchedTermLength", term_match."backendScore"
      FROM candidate_entries AS entry
      CROSS JOIN LATERAL (
        SELECT query_terms."variantOrdinal",
          COUNT(*)::integer AS "matchedTermCount",
          COALESCE(MAX(query_terms."termLength"), 0)::integer AS
            "maximumMatchedTermLength",
          COALESCE(SUM(word_similarity(
            query_terms.term,
            entry."normalizedSearchText"
          )), 0.0)::double precision AS "backendScore"
        FROM query_terms
        WHERE query_terms.term <% entry."normalizedSearchText"
        GROUP BY query_terms."variantOrdinal"
      ) AS term_match
    ),
    ranked_entry_matches AS MATERIALIZED (
      SELECT candidate_matches.*,
        ROW_NUMBER() OVER (
          PARTITION BY candidate_matches."variantOrdinal"
          ORDER BY candidate_matches."maximumMatchedTermLength" DESC,
            candidate_matches."matchedTermCount" DESC,
            candidate_matches."backendScore" DESC,
            candidate_matches."searchEntryId"
        )::integer AS "rankWithinVariant"
      FROM candidate_matches
    )
    SELECT "searchEntryId", "safeContentHash", "variantOrdinal",
      "rankWithinVariant", "matchedTermCount", "maximumMatchedTermLength",
      "backendScore"
    FROM ranked_entry_matches
    WHERE "rankWithinVariant" <= ${request.candidateLimitPerVariant}
    ORDER BY "rankWithinVariant", "variantOrdinal",
      "maximumMatchedTermLength" DESC, "matchedTermCount" DESC,
      "backendScore" DESC, "searchEntryId"
  `;
}

export class PostgresUnicodeMemoryLexicalCandidateProvider implements
MemoryLexicalCandidateProvider {
  readonly backend = "POSTGRES" as const;

  constructor(
    private readonly client: PrismaClient,
    readonly lane: PostgresUnicodeMemoryLexicalLane
  ) {}

  async search(request: MemoryLexicalSearchRequest): Promise<MemoryLexicalSearchResult> {
    assertPostgresMemoryLexicalRequest(
      request,
      this.lane.startsWith("FACT_") ? "FACT" : "HISTORY"
    );
    const ngram = this.lane.endsWith("_NGRAM");
    return executePostgresMemoryLexicalQuery({
      client: this.client,
      evidenceLane: this.lane,
      fallbackUsed: ngram,
      matchMode: ngram ? "NGRAM" : "UNICODE",
      queryTag: this.lane,
      request,
      sql: ngram ? postgresUnicodeNgramSql(request) : postgresUnicodeFtsSql(request)
    });
  }
}

export function createPostgresUnicodeMemoryLexicalCandidateProvider(
  client: PrismaClient,
  lane: PostgresUnicodeMemoryLexicalLane
): MemoryLexicalCandidateProvider {
  return new PostgresUnicodeMemoryLexicalCandidateProvider(client, lane);
}

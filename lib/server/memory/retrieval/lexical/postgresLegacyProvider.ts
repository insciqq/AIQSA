import { Prisma, type PrismaClient } from "@prisma/client";
import type { MemoryRetrievalLane } from "../../../../domain/memory/retrieval";
import { MEMORY_LEXICAL_ANALYSIS_PROFILE } from "../../persistence/lexical";
import {
  MEMORY_READ_BUDGET_MS,
  MemoryReadBudgetError,
  withMemoryReadBudget
} from "../readBudget";
import {
  assertMemoryLexicalSearchRequest,
  assertMemoryLexicalSearchResult,
  type MemoryLexicalCandidateProvider,
  type MemoryLexicalMatchMode,
  type MemoryLexicalRawCandidate,
  type MemoryLexicalSearchRequest,
  type MemoryLexicalSearchResult
} from "./contract";

export const POSTGRES_LEGACY_MEMORY_LEXICAL_LANES = Object.freeze([
  "FACT_FTS_SIMPLE",
  "FACT_FTS_ENGLISH",
  "FACT_FTS_RUSSIAN",
  "FACT_TRIGRAM",
  "HISTORY_RECALL_FTS_SIMPLE",
  "HISTORY_RECALL_FTS_ENGLISH",
  "HISTORY_RECALL_FTS_RUSSIAN",
  "HISTORY_RECALL_TRIGRAM"
] as const);

export type PostgresLegacyMemoryLexicalLane =
  (typeof POSTGRES_LEGACY_MEMORY_LEXICAL_LANES)[number];

type PostgresLegacyRawCandidateRow = Readonly<{
  backendScore: number;
  matchedTermCount: number;
  maximumMatchedTermLength: number;
  rankWithinVariant: number;
  safeContentHash: string;
  searchEntryId: string;
  variantOrdinal: number;
}>;

const cyrillicTerm = /\p{Script=Cyrillic}/u;

export function isPostgresLegacyMemoryLexicalLane(
  lane: string
): lane is PostgresLegacyMemoryLexicalLane {
  return POSTGRES_LEGACY_MEMORY_LEXICAL_LANES.includes(
    lane as PostgresLegacyMemoryLexicalLane
  );
}

export function postgresLegacyMemoryLexicalEvidenceLane(
  lane: PostgresLegacyMemoryLexicalLane
): MemoryRetrievalLane {
  const fact = lane.startsWith("FACT_");
  const ngram = lane === "FACT_TRIGRAM" || lane === "HISTORY_RECALL_TRIGRAM";
  if (fact) return ngram ? "FACT_LEXICAL_NGRAM" : "FACT_LEXICAL_UNICODE";
  return ngram
    ? "HISTORY_RECALL_LEXICAL_NGRAM"
    : "HISTORY_RECALL_LEXICAL_UNICODE";
}

function valuesSql(values: readonly string[]): Prisma.Sql {
  return Prisma.join(values.map((value) => Prisma.sql`${value}`));
}

function requestedTerms(request: MemoryLexicalSearchRequest): Readonly<{
  terms: readonly string[];
  variantOrdinals: readonly number[];
}> {
  const requested = request.variants.flatMap((variant) =>
    variant.logicalTerms.map((term) => ({
      term: term.value,
      variantOrdinal: variant.ordinal
    })));
  return Object.freeze({
    terms: Object.freeze(requested.map(({ term }) => term)),
    variantOrdinals: Object.freeze(requested.map(({ variantOrdinal }) =>
      variantOrdinal))
  });
}

function itemTypePredicate(request: MemoryLexicalSearchRequest): Prisma.Sql {
  return request.itemFamily === "FACT"
    ? Prisma.sql`entry."itemType" = 'FACT_VERSION'::"MemorySearchItemType"`
    : Prisma.sql`entry."itemType" IN (
        'RECALL_CHUNK'::"MemorySearchItemType",
        'RECALL_ROUND'::"MemorySearchItemType",
        'RECALL_ROUND_SEGMENT'::"MemorySearchItemType",
        'TOOL_EVENT'::"MemorySearchItemType"
      )`;
}

function sourcePredicate(request: MemoryLexicalSearchRequest): Prisma.Sql {
  if (!request.sourceChatIds) return Prisma.sql`TRUE`;
  return Prisma.sql`(
    (entry."itemType" = 'RECALL_CHUNK'::"MemorySearchItemType" AND EXISTS (
      SELECT 1 FROM "MemoryRecallChunk" AS candidate_chunk
      WHERE candidate_chunk."userId" = entry."userId"
        AND candidate_chunk."id" = entry."recallChunkId"
        AND candidate_chunk."chatId" IN (${valuesSql(request.sourceChatIds)})
    )) OR
    (entry."itemType" IN (
      'RECALL_ROUND'::"MemorySearchItemType",
      'RECALL_ROUND_SEGMENT'::"MemorySearchItemType"
    ) AND EXISTS (
      SELECT 1 FROM "MemoryRecallRound" AS candidate_round
      WHERE candidate_round."userId" = entry."userId"
        AND candidate_round."id" = entry."recallRoundId"
        AND candidate_round."chatId" IN (${valuesSql(request.sourceChatIds)})
    )) OR
    (entry."itemType" = 'TOOL_EVENT'::"MemorySearchItemType" AND EXISTS (
      SELECT 1 FROM "MemoryToolEvent" AS candidate_tool_event
      WHERE candidate_tool_event."userId" = entry."userId"
        AND candidate_tool_event."id" = entry."toolEventId"
        AND candidate_tool_event."chatId" IN (${valuesSql(request.sourceChatIds)})
    ))
  )`;
}

function ftsSettings(lane: PostgresLegacyMemoryLexicalLane): Readonly<{
  configuration: Prisma.Sql;
  entryVector: Prisma.Sql;
  matchMode: MemoryLexicalMatchMode;
}> {
  if (lane === "FACT_FTS_SIMPLE" || lane === "HISTORY_RECALL_FTS_SIMPLE") {
    return {
      configuration: Prisma.sql`'simple'::regconfig`,
      entryVector: Prisma.sql`entry."searchVectorSimple"`,
      matchMode: "UNICODE"
    };
  }
  if (lane === "FACT_FTS_ENGLISH" || lane === "HISTORY_RECALL_FTS_ENGLISH") {
    return {
      configuration: Prisma.sql`'english'::regconfig`,
      entryVector: Prisma.sql`entry."searchVectorEnglish"`,
      matchMode: "FOLDED"
    };
  }
  if (lane === "FACT_FTS_RUSSIAN" || lane === "HISTORY_RECALL_FTS_RUSSIAN") {
    return {
      configuration: Prisma.sql`'russian'::regconfig`,
      entryVector: Prisma.sql`entry."searchVectorRussian"`,
      matchMode: "FOLDED"
    };
  }
  throw new Error("memory_lexical_legacy_lane_invalid");
}

function postgresLegacyFtsSql(
  request: MemoryLexicalSearchRequest,
  lane: PostgresLegacyMemoryLexicalLane
): Prisma.Sql {
  const settings = ftsSettings(lane);
  const { terms, variantOrdinals } = requestedTerms(request);
  return Prisma.sql`
    WITH query_terms AS MATERIALIZED (
      SELECT DISTINCT term, "variantOrdinal",
        char_length(term)::integer AS "termLength",
        plainto_tsquery(${settings.configuration}, term) AS query
      FROM unnest(${terms}::text[], ${variantOrdinals}::integer[])
        AS terms(term, "variantOrdinal")
      WHERE plainto_tsquery(${settings.configuration}, term) <> ''::tsquery
    ),
    candidate_matches AS MATERIALIZED (
      SELECT entry."id" AS "searchEntryId", entry."safeContentHash",
        query_terms."variantOrdinal",
        COUNT(*)::integer AS "matchedTermCount",
        COALESCE(MAX(query_terms."termLength"), 0)::integer AS
          "maximumMatchedTermLength",
        COALESCE(SUM(ts_rank_cd(${settings.entryVector}, query_terms.query)),
          0.0)::double precision AS "backendScore"
      FROM "MemorySearchEntry" AS entry
      INNER JOIN query_terms
        ON ${settings.entryVector} @@ query_terms.query
      WHERE entry."userId" = ${request.userId}
        AND entry."indexGenerationId" = ${request.activeGenerationId}
        AND ${itemTypePredicate(request)}
        AND ${sourcePredicate(request)}
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

function postgresLegacyTrigramSql(
  request: MemoryLexicalSearchRequest
): Prisma.Sql {
  const { terms, variantOrdinals } = requestedTerms(request);
  const indexedMatches = terms.flatMap((term) => [
    Prisma.sql`${term} <% entry."trigramSearchText"`,
    ...(cyrillicTerm.test(term)
      ? [Prisma.sql`aiqsa_memory_transliterate_ru(${term}) <%
          entry."trigramSearchText"`]
      : [])
  ]);
  return Prisma.sql`
    WITH candidate_entries AS MATERIALIZED (
      SELECT entry."id", entry."safeContentHash", entry."trigramSearchText"
      FROM "MemorySearchEntry" AS entry
      WHERE entry."userId" = ${request.userId}
        AND entry."indexGenerationId" = ${request.activeGenerationId}
        AND ${itemTypePredicate(request)}
        AND ${sourcePredicate(request)}
        AND (${Prisma.join(indexedMatches, " OR ")})
    ),
    query_terms AS MATERIALIZED (
      SELECT DISTINCT variant.term, requested."variantOrdinal",
        char_length(variant.term)::integer AS "termLength"
      FROM unnest(${terms}::text[], ${variantOrdinals}::integer[])
        AS requested(term, "variantOrdinal")
      CROSS JOIN LATERAL (
        VALUES (requested.term), (aiqsa_memory_transliterate_ru(requested.term))
      ) AS variant(term)
      WHERE char_length(variant.term) >= 3
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
            entry."trigramSearchText"
          )), 0.0)::double precision AS "backendScore"
        FROM query_terms
        WHERE query_terms.term <% entry."trigramSearchText"
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

function decodeRows(
  rows: readonly PostgresLegacyRawCandidateRow[],
  matchMode: MemoryLexicalMatchMode
): readonly MemoryLexicalRawCandidate[] {
  return Object.freeze(rows.map((row) => Object.freeze({
    backendScore: row.backendScore,
    matchedTermCount: row.matchedTermCount,
    matchMode,
    maximumMatchedTermLength: row.maximumMatchedTermLength,
    rankWithinVariant: row.rankWithinVariant,
    safeContentHash: row.safeContentHash,
    searchEntryId: row.searchEntryId,
    variantOrdinal: row.variantOrdinal
  })));
}

export class PostgresLegacyMemoryLexicalCandidateProvider implements
MemoryLexicalCandidateProvider {
  readonly backend = "POSTGRES" as const;

  constructor(
    private readonly client: PrismaClient,
    readonly lane: PostgresLegacyMemoryLexicalLane,
    private readonly evidenceLane: MemoryRetrievalLane =
      postgresLegacyMemoryLexicalEvidenceLane(lane)
  ) {}

  async search(
    request: MemoryLexicalSearchRequest
  ): Promise<MemoryLexicalSearchResult> {
    assertMemoryLexicalSearchRequest(request);
    const expectedFamily = this.lane.startsWith("FACT_") ? "FACT" : "HISTORY";
    if (request.itemFamily !== expectedFamily ||
      request.analysisProfileVersion !== MEMORY_LEXICAL_ANALYSIS_PROFILE) {
      throw new Error("memory_lexical_search_request_invalid");
    }
    const remainingMs = Math.min(
      MEMORY_READ_BUDGET_MS.LEXICAL_CANDIDATE,
      request.deadlineAtMs - Date.now()
    );
    if (!Number.isSafeInteger(remainingMs) || remainingMs < 1) {
      throw new MemoryReadBudgetError("memory_read_statement_timeout");
    }
    const trigram = this.lane === "FACT_TRIGRAM" ||
      this.lane === "HISTORY_RECALL_TRIGRAM";
    const matchMode = trigram ? "NGRAM" : ftsSettings(this.lane).matchMode;
    const sql = trigram
      ? postgresLegacyTrigramSql(request)
      : postgresLegacyFtsSql(request, this.lane);
    const startedAt = Date.now();
    const rows = await withMemoryReadBudget(
      this.client,
      remainingMs,
      (tx) => tx.$queryRaw<PostgresLegacyRawCandidateRow[]>(Prisma.sql`
        /* aiqsa_memory_retrieval_lane:${Prisma.raw(this.lane)} */
        ${sql}
      `)
    );
    const candidates = decodeRows(rows, matchMode);
    const result = Object.freeze({
      candidates,
      evidence: Object.freeze({
        backend: this.backend,
        durationMs: Math.min(60_000, Math.max(0, Date.now() - startedAt)),
        failureCode: null,
        fallbackUsed: trigram,
        lane: this.evidenceLane,
        matchMode,
        opaqueId: null,
        projectionCaughtUp: true,
        projectionEventLag: null,
        projectionRevisionLag: null,
        projectionVisibleAgeMs: null,
        rawCandidateCount: candidates.length,
        requestedLimit: request.finalLimit,
        timedOut: false
      })
    });
    assertMemoryLexicalSearchResult(request, result, this.backend);
    return result;
  }
}

export function createPostgresLegacyMemoryLexicalCandidateProvider(
  client: PrismaClient,
  lane: PostgresLegacyMemoryLexicalLane,
  evidenceLane: MemoryRetrievalLane = postgresLegacyMemoryLexicalEvidenceLane(lane)
): MemoryLexicalCandidateProvider {
  return new PostgresLegacyMemoryLexicalCandidateProvider(client, lane, evidenceLane);
}

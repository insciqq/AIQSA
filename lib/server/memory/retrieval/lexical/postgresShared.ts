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

export type PostgresMemoryLexicalRawCandidateRow = Readonly<{
  backendScore: number;
  matchedTermCount: number;
  maximumMatchedTermLength: number;
  rankWithinVariant: number;
  safeContentHash: string;
  searchEntryId: string;
  variantOrdinal: number;
}>;

export function postgresMemoryLexicalValuesSql(
  values: readonly string[]
): Prisma.Sql {
  return Prisma.join(values.map((value) => Prisma.sql`${value}`));
}

export function postgresMemoryLexicalRequestedTerms(
  request: MemoryLexicalSearchRequest
): Readonly<{ terms: readonly string[]; variantOrdinals: readonly number[] }> {
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

export function postgresMemoryLexicalItemTypePredicate(
  request: MemoryLexicalSearchRequest
): Prisma.Sql {
  return request.itemFamily === "FACT"
    ? Prisma.sql`entry."itemType" = 'FACT_VERSION'::"MemorySearchItemType"`
    : Prisma.sql`entry."itemType" IN (
        'RECALL_CHUNK'::"MemorySearchItemType",
        'RECALL_ROUND'::"MemorySearchItemType",
        'RECALL_ROUND_SEGMENT'::"MemorySearchItemType",
        'TOOL_EVENT'::"MemorySearchItemType"
      )`;
}

/** Applies source-chat scope before the provider candidate cap. */
export function postgresMemoryLexicalSourcePredicate(
  request: MemoryLexicalSearchRequest
): Prisma.Sql {
  if (!request.sourceChatIds) return Prisma.sql`TRUE`;
  return Prisma.sql`(
    (entry."itemType" = 'RECALL_CHUNK'::"MemorySearchItemType" AND EXISTS (
      SELECT 1 FROM "MemoryRecallChunk" AS candidate_chunk
      WHERE candidate_chunk."userId" = entry."userId"
        AND candidate_chunk."id" = entry."recallChunkId"
        AND candidate_chunk."chatId" IN (
          ${postgresMemoryLexicalValuesSql(request.sourceChatIds)}
        )
    )) OR
    (entry."itemType" IN (
      'RECALL_ROUND'::"MemorySearchItemType",
      'RECALL_ROUND_SEGMENT'::"MemorySearchItemType"
    ) AND EXISTS (
      SELECT 1 FROM "MemoryRecallRound" AS candidate_round
      WHERE candidate_round."userId" = entry."userId"
        AND candidate_round."id" = entry."recallRoundId"
        AND candidate_round."chatId" IN (
          ${postgresMemoryLexicalValuesSql(request.sourceChatIds)}
        )
    )) OR
    (entry."itemType" = 'TOOL_EVENT'::"MemorySearchItemType" AND EXISTS (
      SELECT 1 FROM "MemoryToolEvent" AS candidate_tool_event
      WHERE candidate_tool_event."userId" = entry."userId"
        AND candidate_tool_event."id" = entry."toolEventId"
        AND candidate_tool_event."chatId" IN (
          ${postgresMemoryLexicalValuesSql(request.sourceChatIds)}
        )
    ))
  )`;
}

export function assertPostgresMemoryLexicalRequest(
  request: MemoryLexicalSearchRequest,
  expectedFamily: MemoryLexicalSearchRequest["itemFamily"]
): void {
  assertMemoryLexicalSearchRequest(request);
  if (request.itemFamily !== expectedFamily ||
    request.analysisProfileVersion !== MEMORY_LEXICAL_ANALYSIS_PROFILE) {
    throw new Error("memory_lexical_search_request_invalid");
  }
}

function decodePostgresMemoryLexicalRows(
  rows: readonly PostgresMemoryLexicalRawCandidateRow[],
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

export async function executePostgresMemoryLexicalQuery(input: Readonly<{
  client: PrismaClient;
  evidenceLane: MemoryRetrievalLane;
  fallbackUsed: boolean;
  matchMode: MemoryLexicalMatchMode;
  queryTag: string;
  request: MemoryLexicalSearchRequest;
  sql: Prisma.Sql;
}>): Promise<MemoryLexicalSearchResult> {
  if (!/^[A-Z0-9_]{1,64}$/u.test(input.queryTag)) {
    throw new Error("memory_lexical_provider_contract_invalid");
  }
  const remainingMs = Math.min(
    MEMORY_READ_BUDGET_MS.LEXICAL_CANDIDATE,
    input.request.deadlineAtMs - Date.now()
  );
  if (!Number.isSafeInteger(remainingMs) || remainingMs < 1) {
    throw new MemoryReadBudgetError("memory_read_statement_timeout");
  }
  const startedAt = Date.now();
  const rows = await withMemoryReadBudget(
    input.client,
    remainingMs,
    (tx) => tx.$queryRaw<PostgresMemoryLexicalRawCandidateRow[]>(Prisma.sql`
      /* aiqsa_memory_retrieval_lane:${Prisma.raw(input.queryTag)} */
      ${input.sql}
    `)
  );
  const candidates = decodePostgresMemoryLexicalRows(rows, input.matchMode);
  const result = Object.freeze({
    candidates,
    evidence: Object.freeze({
      backend: "POSTGRES" as const,
      durationMs: Math.min(60_000, Math.max(0, Date.now() - startedAt)),
      failureCode: null,
      fallbackUsed: input.fallbackUsed,
      lane: input.evidenceLane,
      matchMode: input.matchMode,
      opaqueId: null,
      projectionCaughtUp: true,
      projectionEventLag: null,
      projectionRevisionLag: null,
      projectionVisibleAgeMs: null,
      rawCandidateCount: candidates.length,
      requestedLimit: input.request.finalLimit,
      timedOut: false
    })
  });
  assertMemoryLexicalSearchResult(input.request, result, "POSTGRES");
  return result;
}

export type PostgresMemoryLexicalProvider = MemoryLexicalCandidateProvider;

import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { MemoryLexicalSearchRequest } from "./contract";
import {
  PostgresLegacyMemoryLexicalCandidateProvider,
  type PostgresLegacyMemoryLexicalLane
} from "./postgresLegacyProvider";

function request(
  itemFamily: "FACT" | "HISTORY" = "FACT",
  overrides: Partial<MemoryLexicalSearchRequest> = {}
): MemoryLexicalSearchRequest {
  return {
    activeGenerationId: "generation-1",
    analysisProfileVersion: "UNICODE_ICU_NGRAM_V1",
    candidateLimitPerVariant: 24,
    deadlineAtMs: Date.now() + 1_000,
    finalLimit: 12,
    itemFamily,
    memoryRevisionSnapshot: 7,
    userId: "user-1",
    variants: [{
      logicalTerms: [{ characterLength: 5, ordinal: 0, value: "cedar" }],
      normalizedText: "cedar project",
      ordinal: 0
    }],
    ...overrides
  };
}

function mockClient(rows: readonly Record<string, unknown>[] = []) {
  const queries: string[] = [];
  const $queryRaw = vi.fn(async (query: { strings?: readonly string[] }) => {
    const sql = query.strings?.join("?") ?? "";
    if (sql.includes("set_config('lock_timeout'")) return [];
    queries.push(sql);
    return rows;
  });
  const $transaction = vi.fn(async (
    callback: (tx: Readonly<{ $queryRaw: typeof $queryRaw }>) => Promise<unknown>
  ) => callback({ $queryRaw }));
  return {
    client: { $transaction } as unknown as PrismaClient,
    queries,
    transaction: $transaction
  };
}

describe("legacy PostgreSQL Memory lexical candidate provider", () => {
  it.each([
    ["FACT_FTS_SIMPLE", "simple", "searchVectorSimple", "UNICODE"],
    ["FACT_FTS_ENGLISH", "english", "searchVectorEnglish", "FOLDED"],
    ["FACT_FTS_RUSSIAN", "russian", "searchVectorRussian", "FOLDED"]
  ] as const)("preserves %s candidate rank evidence", async (
    lane,
    configuration,
    vector,
    matchMode
  ) => {
    const mocked = mockClient([{
      backendScore: 0.75,
      matchedTermCount: 1,
      maximumMatchedTermLength: 5,
      rankWithinVariant: 1,
      safeContentHash: "a".repeat(64),
      searchEntryId: "entry-1",
      variantOrdinal: 0
    }]);
    const provider = new PostgresLegacyMemoryLexicalCandidateProvider(
      mocked.client,
      lane
    );

    const result = await provider.search(request());

    expect(result.candidates).toEqual([{
      backendScore: 0.75,
      matchedTermCount: 1,
      matchMode,
      maximumMatchedTermLength: 5,
      rankWithinVariant: 1,
      safeContentHash: "a".repeat(64),
      searchEntryId: "entry-1",
      variantOrdinal: 0
    }]);
    expect(Object.isFrozen(result.candidates)).toBe(true);
    expect(result.evidence).toMatchObject({
      backend: "POSTGRES",
      lane: "FACT_LEXICAL_UNICODE",
      matchMode,
      rawCandidateCount: 1,
      requestedLimit: 12
    });
    expect(result.evidence).not.toHaveProperty("canonicalAcceptedCount");
    const sql = mocked.queries.join("\n");
    expect(sql).toContain(`plainto_tsquery('${configuration}'::regconfig`);
    expect(sql).toContain(`entry.\"${vector}\"`);
    expect(sql).toContain('entry."userId" =');
    expect(sql).toContain('entry."indexGenerationId" =');
    expect(sql).toContain('PARTITION BY candidate_matches."variantOrdinal"');
    expect(sql.indexOf('entry."userId" =')).toBeLessThan(
      sql.indexOf("ranked_entry_matches AS MATERIALIZED")
    );
  });

  it("filters selected history chats before the bounded trigram rank", async () => {
    const mocked = mockClient();
    const lane: PostgresLegacyMemoryLexicalLane = "HISTORY_RECALL_TRIGRAM";
    const provider = new PostgresLegacyMemoryLexicalCandidateProvider(
      mocked.client,
      lane
    );

    await provider.search(request("HISTORY", {
      sourceChatIds: ["chat-a", "chat-b"]
    }));

    const sql = mocked.queries.join("\n");
    expect(sql).toContain("candidate_entries AS MATERIALIZED");
    expect(sql).toContain('FROM "MemoryRecallChunk" AS candidate_chunk');
    expect(sql).toContain('FROM "MemoryRecallRound" AS candidate_round');
    expect(sql).toContain('FROM "MemoryToolEvent" AS candidate_tool_event');
    expect(sql).toContain('<% entry."trigramSearchText"');
    expect(sql.indexOf('candidate_chunk."chatId" IN')).toBeLessThan(
      sql.indexOf("ranked_entry_matches AS MATERIALIZED")
    );
  });

  it("fails an expired provider deadline before opening a transaction", async () => {
    const mocked = mockClient();
    const provider = new PostgresLegacyMemoryLexicalCandidateProvider(
      mocked.client,
      "FACT_FTS_SIMPLE"
    );

    await expect(provider.search(request("FACT", { deadlineAtMs: Date.now() - 1 })))
      .rejects.toMatchObject({ code: "memory_read_statement_timeout" });
    await expect(provider.search(request("FACT", {
      analysisProfileVersion: "unexpected-profile"
    }))).rejects.toThrow("memory_lexical_search_request_invalid");
    expect(mocked.transaction).not.toHaveBeenCalled();
  });
});

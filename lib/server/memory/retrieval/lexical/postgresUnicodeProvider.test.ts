import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { MemoryLexicalSearchRequest } from "./contract";
import {
  PostgresUnicodeMemoryLexicalCandidateProvider,
  type PostgresUnicodeMemoryLexicalLane
} from "./postgresUnicodeProvider";

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
      logicalTerms: [{ characterLength: 4, ordinal: 0, value: "東京計画" }],
      normalizedText: "東京計画 mixed-42",
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

describe("Unicode PostgreSQL Memory lexical candidate provider", () => {
  it.each([
    ["FACT_LEXICAL_UNICODE", "UNICODE", "searchVectorSimple"],
    ["FACT_LEXICAL_NGRAM", "NGRAM", "normalizedSearchText"]
  ] as const)("uses the generic %s projection", async (lane, matchMode, field) => {
    const mocked = mockClient([{
      backendScore: 0.75,
      matchedTermCount: 1,
      maximumMatchedTermLength: 4,
      rankWithinVariant: 1,
      safeContentHash: "a".repeat(64),
      searchEntryId: "entry-1",
      variantOrdinal: 0
    }]);
    const provider = new PostgresUnicodeMemoryLexicalCandidateProvider(
      mocked.client,
      lane
    );

    const result = await provider.search(request());

    expect(result.candidates[0]).toMatchObject({ matchMode, searchEntryId: "entry-1" });
    expect(result.evidence).toMatchObject({
      backend: "POSTGRES",
      fallbackUsed: lane.endsWith("_NGRAM"),
      lane,
      matchMode,
      rawCandidateCount: 1
    });
    const sql = mocked.queries.join("\n");
    expect(sql).toContain(`entry.\"${field}\"`);
    expect(sql).not.toMatch(/searchVectorEnglish|searchVectorRussian/u);
    expect(sql).not.toMatch(/trigramSearchText|transliterate_ru/u);
  });

  it("applies selected history chats before bounded n-gram ranking", async () => {
    const mocked = mockClient();
    const lane: PostgresUnicodeMemoryLexicalLane =
      "HISTORY_RECALL_LEXICAL_NGRAM";
    const provider = new PostgresUnicodeMemoryLexicalCandidateProvider(
      mocked.client,
      lane
    );

    await provider.search(request("HISTORY", {
      sourceChatIds: ["chat-a", "chat-b"]
    }));

    const sql = mocked.queries.join("\n");
    expect(sql).toContain("candidate_entries AS MATERIALIZED");
    expect(sql).toContain('FROM "MemoryRecallChunk" AS candidate_chunk');
    expect(sql).toContain('<% entry."normalizedSearchText"');
    expect(sql.indexOf('candidate_chunk."chatId" IN')).toBeLessThan(
      sql.indexOf("ranked_entry_matches AS MATERIALIZED")
    );
  });

  it("rejects one-character n-gram requests and expired deadlines", async () => {
    const mocked = mockClient();
    const provider = new PostgresUnicodeMemoryLexicalCandidateProvider(
      mocked.client,
      "FACT_LEXICAL_NGRAM"
    );
    await expect(provider.search(request("FACT", {
      variants: [{
        logicalTerms: [{ characterLength: 1, ordinal: 0, value: "東" }],
        normalizedText: "東",
        ordinal: 0
      }]
    }))).rejects.toThrow("memory_lexical_search_request_invalid");
    await expect(provider.search(request("FACT", { deadlineAtMs: Date.now() - 1 })))
      .rejects.toMatchObject({ code: "memory_read_statement_timeout" });
    expect(mocked.transaction).not.toHaveBeenCalled();
  });
});
